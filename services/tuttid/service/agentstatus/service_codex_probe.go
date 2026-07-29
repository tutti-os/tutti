package agentstatus

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"os/exec"
	"strconv"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtime/codexproto"
)

// codexHandshakeClientInfoName identifies probe-originated `initialize` calls
// in codex app-server logs, distinct from the real session client name (which
// lives in the runtime/session layer this detection package does not depend
// on).
const codexHandshakeClientInfoName = "tutti-agent-status-probe"

// newCodexHandshakeRequestID picks a fresh id in [2, 1000001] for each probe
// run, deliberately never 1. A binary that fakes ACP by always answering a
// canned, hardcoded response line (without actually reading and parsing our
// request from stdin) can otherwise "guess" a fixed id like 1 for free;
// requiring the id to match a value generated at probe time forces it to
// genuinely round-trip the request. See Agent 可用性需求摘要 issue #1.
func newCodexHandshakeRequestID() int {
	return rand.IntN(1_000_000) + 2
}

// codexHandshakeResponse is the minimal shape this probe cares about from a
// codex app-server JSON-RPC line: enough to tell a real `initialize`
// response apart from a notification, a server-initiated request, or a
// reply to a different call.
//
// It deliberately does not require a "jsonrpc" field: the codex app-server
// wire format omits the JSON-RPC version header entirely (see
// newAppServerJSONRPCClient's omitWireVersion in
// packages/agent/daemon/runtime/acp_client.go, and
// TestCodexAppServerAdapterWireFormatOmitsJSONRPCVersion), so requiring it
// here would reject genuine codex responses. This is why the probe cannot
// reuse the Standard ACP probe's stricter `jsonrpc == "2.0"` check.
type codexHandshakeResponse struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// probeCodexAppServerHandshake replaces the generic "process stayed alive"
// liveness probe with a real ACP `initialize` JSON-RPC round trip. A codex
// binary that starts but cannot actually serve ACP (incomplete install, an
// App-bundled launcher shim, a corrupted binary, ...) fails here instead of
// being reported as available. See Agent 可用性需求摘要 issue #1.
//
// This intentionally does not reuse the session-oriented ACP client in
// packages/agent/daemon/runtime: that client is built for long-lived,
// stateful sessions (message routing, handlers, notification dispatch) which
// this one-shot detection probe does not need. It does reuse the generated
// codexproto request/response types so the request shape tracks the real
// codex protocol without duplicating protocol knowledge.
func (s Service) probeCodexAppServerHandshake(
	ctx context.Context,
	result ProbeResult,
	command []string,
	env []string,
) ProbeResult {
	if ctx == nil {
		ctx = context.Background()
	}
	probeCtx, cancel := context.WithTimeout(ctx, s.probeTimeout())
	defer cancel()

	cmd := exec.CommandContext(probeCtx, command[0], command[1:]...)
	cmd.Env = env
	cmd.WaitDelay = defaultProbeWaitDelay

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return codexHandshakeFailure(result, err.Error())
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return codexHandshakeFailure(result, err.Error())
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return codexHandshakeFailure(result, err.Error())
	}

	requestID := newCodexHandshakeRequestID()

	responseCh := make(chan codexHandshakeResponse, 1)
	readDoneCh := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := bytes.TrimSpace(scanner.Bytes())
			if len(line) == 0 {
				continue
			}
			var response codexHandshakeResponse
			if err := json.Unmarshal(line, &response); err != nil {
				continue // stray non-JSON-RPC output; keep reading
			}
			if !isCodexHandshakeResponse(response, requestID) {
				continue // a notification (no id) or an empty frame, not our reply
			}
			responseCh <- response
			return
		}
		readDoneCh <- scanner.Err()
	}()

	// No "jsonrpc" field: the codex app-server wire format omits the
	// JSON-RPC version header (see codexHandshakeResponse's doc comment),
	// and the real codex client sends requests the same way.
	requestPayload, marshalErr := json.Marshal(struct {
		ID     int                         `json:"id"`
		Method string                      `json:"method"`
		Params codexproto.InitializeParams `json:"params"`
	}{
		ID:     requestID,
		Method: "initialize",
		Params: codexproto.InitializeParams{
			Capabilities: codexproto.InitializeCapabilities{ExperimentalApi: true},
			ClientInfo:   codexproto.ClientInfo{Name: codexHandshakeClientInfoName, Version: "0.0.0"},
		},
	})

	var handshakeErr error
	if marshalErr != nil {
		handshakeErr = marshalErr
	} else if _, writeErr := stdin.Write(append(requestPayload, '\n')); writeErr != nil {
		handshakeErr = fmt.Errorf("write initialize request to codex app-server: %w", writeErr)
	} else {
		select {
		case response := <-responseCh:
			if response.Error != nil {
				handshakeErr = fmt.Errorf("codex app-server rejected initialize: %s", response.Error.Message)
			}
		case readErr := <-readDoneCh:
			if readErr != nil {
				handshakeErr = readErr
			} else {
				handshakeErr = errors.New("codex app-server exited before responding to initialize")
			}
		case <-probeCtx.Done():
			handshakeErr = errors.New("codex app-server did not respond to initialize before the probe timed out")
		}
	}

	_ = stdin.Close()
	cancel()
	_ = cmd.Wait()

	if handshakeErr != nil {
		return codexHandshakeFailure(result, firstNonBlank(trimProbeOutput(stderr.String()), handshakeErr.Error()))
	}
	result.Status = ProbeReady
	return result
}

func codexHandshakeFailure(result ProbeResult, message string) ProbeResult {
	result.Status = ProbeFailed
	result.ReasonCode = "acp_adapter_launch_failed"
	result.Message = message
	return result
}

// isCodexHandshakeResponse reports whether response is a genuine reply to
// this probe's own `initialize` call, as opposed to a notification, a
// server-initiated request, or a reply to some other (unmatched) call. A
// binary that fakes ACP by echoing an unrelated or malformed line (wrong
// id, or a bare {"method":...} request) must not be able to satisfy this
// check. It intentionally does not require a "jsonrpc" field; see
// codexHandshakeResponse's doc comment for why. wantID is the id this probe
// run generated for its own request (see newCodexHandshakeRequestID); a
// hardcoded/canned response that never reads stdin cannot know it in
// advance.
func isCodexHandshakeResponse(response codexHandshakeResponse, wantID int) bool {
	if response.Method != "" {
		return false // a server-initiated request, not a reply to our call
	}
	id, ok := codexHandshakeResponseID(response.ID)
	if !ok || id != wantID {
		return false
	}
	if response.Error != nil {
		return true
	}
	trimmedResult := bytes.TrimSpace(response.Result)
	return len(trimmedResult) > 0 && !bytes.Equal(trimmedResult, []byte("null"))
}

// codexHandshakeResponseID parses a JSON-RPC id, accepting both the number
// and string encodings the spec allows.
func codexHandshakeResponseID(raw json.RawMessage) (int, bool) {
	var number int
	if err := json.Unmarshal(raw, &number); err == nil {
		return number, true
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		if parsed, err := strconv.Atoi(strings.TrimSpace(text)); err == nil {
			return parsed, true
		}
	}
	return 0, false
}
