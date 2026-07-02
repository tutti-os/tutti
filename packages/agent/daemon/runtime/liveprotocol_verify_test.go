package agentruntime

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// Live protocol verification for the two ADR-flagged questions that only a
// real codex app-server can answer. Guarded behind an env var: these tests
// spawn the installed codex binary, run a real (tiny) model turn, and need
// the user's codex auth.
//
//	TUTTI_LIVE_PROTOCOL_VERIFY=1 go test ./runtime/ -run TestLiveProtocol -v -count=1
//
// ADR 0006 question: does codex re-issue a pending server-request
// (item/commandExecution/requestApproval) after the client dies and a new
// process does thread/resume? The reconnect policy (interrupted/re-offer vs
// seamless approval revival) depends on the answer.
func TestLiveProtocolResumeServerRequestReissue(t *testing.T) {
	if os.Getenv("TUTTI_LIVE_PROTOCOL_VERIFY") == "" {
		t.Skip("set TUTTI_LIVE_PROTOCOL_VERIFY=1 to run live protocol verification")
	}

	workDir := t.TempDir()

	// --- Process 1: start a thread, provoke an approval, leave it pending.
	proc1 := startLiveAppServer(t)
	defer proc1.kill()

	proc1.initialize(t)
	threadID := proc1.threadStart(t, workDir)
	t.Logf("thread started: %s", threadID)

	turnResult := proc1.call(t, "turn/start", map[string]any{
		"threadId":       threadID,
		"approvalPolicy": "untrusted",
		"input": []any{map[string]any{
			"type": "text",
			"text": "Create a file named tutti-live-verify.txt containing the word ok, using a shell command (for example `bash -lc \\\"echo ok > tutti-live-verify.txt\\\"`). Do it immediately without asking questions.",
		}},
	})
	t.Logf("turn/start result: %s", compactJSON(turnResult))

	pending := proc1.waitForServerRequest(t, "requestApproval", 120*time.Second)
	if pending == nil {
		t.Logf("notifications so far:\n%s", proc1.notificationDigest())
		t.Fatalf("no approval server-request arrived; cannot verify re-issue behavior")
	}
	t.Logf("pending approval request: id=%v method=%s params=%s",
		pending.ID, pending.Method, compactJSON(pending.Params))

	// Leave the request unanswered and kill the process (simulates the
	// daemon releasing/crashing while an approval is pending).
	proc1.kill()
	time.Sleep(1 * time.Second)

	// --- Process 2: resume the same thread and observe.
	proc2 := startLiveAppServer(t)
	defer proc2.kill()
	proc2.initialize(t)

	resumeResult := proc2.call(t, "thread/resume", map[string]any{
		"threadId": threadID,
		"cwd":      workDir,
	})
	t.Logf("thread/resume result: %s", compactJSON(resumeResult))

	// Observe the wire for a while: does the approval request re-issue?
	reissued := proc2.waitForServerRequest(t, "requestApproval", 30*time.Second)
	if reissued != nil {
		t.Logf("VERDICT: codex RE-ISSUES the pending server-request on resume: id=%v method=%s params=%s",
			reissued.ID, reissued.Method, compactJSON(reissued.Params))
	} else {
		t.Logf("VERDICT: codex does NOT re-issue the pending server-request within 30s of thread/resume")
	}

	// Also read the thread state for the turn's fate.
	threadRead := proc2.call(t, "thread/read", map[string]any{
		"threadId": threadID,
	})
	t.Logf("thread/read after resume: %s", truncateForLog(compactJSON(threadRead), 2000))

	t.Logf("notifications observed after resume:\n%s", proc2.notificationDigest())
}

// --- minimal NDJSON JSON-RPC driver over the codex app-server binary ---

type liveServerRequest struct {
	ID     any
	Method string
	Params map[string]any
}

type liveAppServer struct {
	t      *testing.T
	cmd    *exec.Cmd
	stdin  *json.Encoder
	mu     sync.Mutex
	nextID int
	// responses by request id (client->server calls)
	responses map[string]chan map[string]any
	// server->client requests (messages with both id and method)
	serverRequests chan liveServerRequest
	notifications  []string
	done           chan struct{}
}

func startLiveAppServer(t *testing.T) *liveAppServer {
	t.Helper()
	cmd := exec.Command("codex", "app-server")
	cmd.Env = os.Environ()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("stdin pipe: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start codex app-server: %v", err)
	}
	server := &liveAppServer{
		t:              t,
		cmd:            cmd,
		stdin:          json.NewEncoder(stdin),
		responses:      map[string]chan map[string]any{},
		serverRequests: make(chan liveServerRequest, 16),
		done:           make(chan struct{}),
	}
	go server.readLoop(stdout)
	return server
}

func (s *liveAppServer) readLoop(stdout interface{ Read([]byte) (int, error) }) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		var message struct {
			ID     any             `json:"id"`
			Method string          `json:"method"`
			Params map[string]any  `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if err := json.Unmarshal(line, &message); err != nil {
			continue
		}
		switch {
		case message.ID != nil && message.Method != "":
			// server -> client request
			select {
			case s.serverRequests <- liveServerRequest{ID: message.ID, Method: message.Method, Params: message.Params}:
			default:
			}
		case message.ID != nil:
			// response to one of our calls
			s.mu.Lock()
			key := fmt.Sprintf("%v", message.ID)
			ch := s.responses[key]
			delete(s.responses, key)
			s.mu.Unlock()
			if ch != nil {
				payload := map[string]any{}
				if len(message.Result) > 0 {
					payload["result"] = json.RawMessage(message.Result)
				}
				if len(message.Error) > 0 {
					payload["error"] = json.RawMessage(message.Error)
				}
				ch <- payload
			}
		default:
			// notification
			s.mu.Lock()
			s.notifications = append(s.notifications,
				fmt.Sprintf("%s %s", message.Method, truncateForLog(compactJSON(message.Params), 220)))
			s.mu.Unlock()
		}
	}
	close(s.done)
}

func (s *liveAppServer) call(t *testing.T, method string, params map[string]any) map[string]any {
	t.Helper()
	s.mu.Lock()
	s.nextID++
	id := s.nextID
	ch := make(chan map[string]any, 1)
	s.responses[fmt.Sprintf("%d", id)] = ch
	s.mu.Unlock()
	if err := s.stdin.Encode(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": method, "params": params,
	}); err != nil {
		t.Fatalf("send %s: %v", method, err)
	}
	select {
	case response := <-ch:
		return response
	case <-time.After(120 * time.Second):
		t.Fatalf("timeout waiting for %s response", method)
		return nil
	case <-s.done:
		t.Fatalf("app-server exited while waiting for %s", method)
		return nil
	}
}

func (s *liveAppServer) notify(t *testing.T, method string, params map[string]any) {
	t.Helper()
	if err := s.stdin.Encode(map[string]any{
		"jsonrpc": "2.0", "method": method, "params": params,
	}); err != nil {
		t.Fatalf("notify %s: %v", method, err)
	}
}

func (s *liveAppServer) initialize(t *testing.T) {
	t.Helper()
	result := s.call(t, "initialize", map[string]any{
		"clientInfo": codexClientInfoParamsForVersion(HostMetadata{}, "0.142.5"),
	})
	if _, hasError := result["error"]; hasError {
		t.Fatalf("initialize failed: %s", compactJSON(result))
	}
	s.notify(t, "initialized", map[string]any{})
}

func (s *liveAppServer) threadStart(t *testing.T, cwd string) string {
	t.Helper()
	result := s.call(t, "thread/start", map[string]any{
		"cwd":            cwd,
		"approvalPolicy": "untrusted",
		"sandbox":        "read-only",
	})
	raw, _ := result["result"].(json.RawMessage)
	var parsed struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
		ThreadID string `json:"threadId"`
	}
	_ = json.Unmarshal(raw, &parsed)
	threadID := parsed.Thread.ID
	if threadID == "" {
		threadID = parsed.ThreadID
	}
	if threadID == "" {
		t.Fatalf("thread/start returned no thread id: %s", compactJSON(result))
	}
	return threadID
}

func (s *liveAppServer) waitForServerRequest(t *testing.T, methodSubstring string, timeout time.Duration) *liveServerRequest {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case request := <-s.serverRequests:
			t.Logf("server request observed: %s", request.Method)
			if strings.Contains(request.Method, methodSubstring) {
				return &request
			}
		case <-deadline:
			return nil
		case <-s.done:
			return nil
		}
	}
}

func (s *liveAppServer) notificationDigest() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.notifications) == 0 {
		return "(none)"
	}
	limit := len(s.notifications)
	if limit > 80 {
		limit = 80
	}
	return strings.Join(s.notifications[:limit], "\n")
}

func (s *liveAppServer) kill() {
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
		_, _ = s.cmd.Process.Wait()
	}
}

func compactJSON(value any) string {
	if typed, ok := value.(json.RawMessage); ok {
		return string(typed)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	return string(encoded)
}

func truncateForLog(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}
