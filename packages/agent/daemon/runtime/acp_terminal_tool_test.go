package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
)

func TestStandardACPTerminalExecuteStreamsOutputAndPreservesCommandAcrossTerminalStates(t *testing.T) {
	t.Parallel()

	t.Run("completed execute tool with search-like command streams terminal output", func(t *testing.T) {
		t.Parallel()

		session := standardTestSession("acp:pi")
		normalizer := newACPTurnNormalizer()
		config := standardACPConfig{provider: "acp:pi"}

		started := standardACPUpdateEvents(config, session, "turn-1", json.RawMessage(`{
			"update": {
				"sessionUpdate": "tool_call",
				"toolCallId": "bash-1",
				"title": "rg needle packages/",
				"kind": "execute",
				"status": "in_progress",
				"content": [{"type": "terminal", "terminalId": "bash-1"}],
				"_meta": {
					"terminal_info": {"terminal_id": "bash-1", "cwd": "/workspace/project"}
				}
			}
		}`), normalizer)
		if len(started) != 1 || started[0].Type != activityshared.EventCallStarted {
			t.Fatalf("started events = %#v, want single call.started", started)
		}
		if got := asString(started[0].Payload.Metadata["toolName"]); got != "Bash" {
			t.Fatalf("started toolName = %q, want Bash (metadata=%#v)", got, started[0].Payload.Metadata)
		}
		startedInput := payloadMap(started[0].Payload.Metadata, "input")
		if got := asString(startedInput["command"]); got != "rg needle packages/" {
			t.Fatalf("started input.command = %q, want rg needle packages/ (input=%#v)", got, startedInput)
		}
		if got := asString(startedInput["cwd"]); got != "/workspace/project" {
			t.Fatalf("started input.cwd = %q, want /workspace/project (input=%#v)", got, startedInput)
		}

		chunk1 := standardACPUpdateEvents(config, session, "turn-1", json.RawMessage(`{
			"update": {
				"sessionUpdate": "tool_call_update",
				"toolCallId": "bash-1",
				"status": "in_progress",
				"_meta": {
					"terminal_output": {"terminal_id": "bash-1", "data": "packages/a.go:1:needle\n"}
				}
			}
		}`), normalizer)
		chunk2 := standardACPUpdateEvents(config, session, "turn-1", json.RawMessage(`{
			"update": {
				"sessionUpdate": "tool_call_update",
				"toolCallId": "bash-1",
				"status": "in_progress",
				"_meta": {
					"terminal_output": {"terminal_id": "bash-1", "data": "packages/b.go:2:needle\n"}
				}
			}
		}`), normalizer)
		stream := ProjectActivityEventsToStreamEvents(session, append(chunk1, chunk2...))
		if len(stream) != 2 {
			t.Fatalf("stream = %#v, want two tool output deltas", stream)
		}
		var firstDelta, secondDelta liveprotocol.MessageDeltaData
		for index, target := range []*liveprotocol.MessageDeltaData{&firstDelta, &secondDelta} {
			event, ok := stream[index].Data.(liveprotocol.Event)
			if !ok {
				t.Fatalf("stream[%d] data = %T", index, stream[index].Data)
			}
			if err := json.Unmarshal(event.Data, target); err != nil {
				t.Fatal(err)
			}
		}
		if firstDelta.ToolOutput == nil || firstDelta.ToolOutput.Operation != "set" || firstDelta.ToolOutput.Text != "packages/a.go:1:needle\n" {
			t.Fatalf("first tool output = %#v", firstDelta.ToolOutput)
		}
		if secondDelta.ToolOutput == nil || secondDelta.ToolOutput.Operation != "append_text" || secondDelta.ToolOutput.Text != "packages/b.go:2:needle\n" {
			t.Fatalf("second tool output = %#v", secondDelta.ToolOutput)
		}

		completed := standardACPUpdateEvents(config, session, "turn-1", json.RawMessage(`{
			"update": {
				"sessionUpdate": "tool_call_update",
				"toolCallId": "bash-1",
				"status": "completed",
				"_meta": {
					"terminal_output": {"terminal_id": "bash-1", "data": "done\n"},
					"terminal_exit": {"terminal_id": "bash-1", "exit_code": 0, "signal": null}
				}
			}
		}`), normalizer)
		if len(completed) != 1 || completed[0].Type != activityshared.EventCallCompleted {
			t.Fatalf("completed events = %#v, want single call.completed", completed)
		}
		if got := asString(completed[0].Payload.Metadata["toolName"]); got != "Bash" {
			t.Fatalf("completed toolName = %q, want Bash", got)
		}
		completedInput := payloadMap(completed[0].Payload.Metadata, "input")
		if got := asString(completedInput["command"]); got != "rg needle packages/" {
			t.Fatalf("completed input = %#v, want command preserved", completedInput)
		}
		wantStdout := "packages/a.go:1:needle\npackages/b.go:2:needle\ndone\n"
		if got, _ := completed[0].Payload.Output["stdout"].(string); got != wantStdout {
			t.Fatalf("completed output.stdout = %q, want %q (output=%#v)", got, wantStdout, completed[0].Payload.Output)
		}
		if exitCode, ok := acpIntFromValue(completed[0].Payload.Output["exitCode"]); !ok || exitCode != 0 {
			t.Fatalf("completed output.exitCode = %#v, want 0", completed[0].Payload.Output["exitCode"])
		}
	})

	t.Run("failed execute tool preserves command output and nonzero exit code", func(t *testing.T) {
		t.Parallel()

		session := standardTestSession("acp:pi")
		normalizer := newACPTurnNormalizer()
		config := standardACPConfig{provider: "acp:pi"}

		_ = standardACPUpdateEvents(config, session, "turn-2", json.RawMessage(`{
			"update": {
				"sessionUpdate": "tool_call",
				"toolCallId": "bash-fail",
				"title": "find /nonexistent -maxdepth 1",
				"kind": "execute",
				"status": "in_progress",
				"content": [{"type": "terminal", "terminalId": "bash-fail"}],
				"_meta": {
					"terminal_info": {"terminal_id": "bash-fail", "cwd": "/workspace/project"}
				}
			}
		}`), normalizer)

		_ = standardACPUpdateEvents(config, session, "turn-2", json.RawMessage(`{
			"update": {
				"sessionUpdate": "tool_call_update",
				"toolCallId": "bash-fail",
				"status": "in_progress",
				"_meta": {
					"terminal_output": {"terminal_id": "bash-fail", "data": "find: /nonexistent: No such file or directory\n"}
				}
			}
		}`), normalizer)

		failed := standardACPUpdateEvents(config, session, "turn-2", json.RawMessage(`{
			"update": {
				"sessionUpdate": "tool_call_update",
				"toolCallId": "bash-fail",
				"status": "failed",
				"_meta": {
					"terminal_exit": {"terminal_id": "bash-fail", "exit_code": 1, "signal": null}
				}
			}
		}`), normalizer)
		if len(failed) != 1 || failed[0].Type != activityshared.EventCallFailed {
			t.Fatalf("failed events = %#v, want single call.failed", failed)
		}
		if got := asString(failed[0].Payload.Metadata["toolName"]); got != "Bash" {
			t.Fatalf("failed toolName = %q, want Bash (metadata=%#v)", got, failed[0].Payload.Metadata)
		}
		failedInput := payloadMap(failed[0].Payload.Metadata, "input")
		if got := asString(failedInput["command"]); got != "find /nonexistent -maxdepth 1" {
			t.Fatalf("failed input = %#v, want command preserved", failedInput)
		}
		wantErrText := "find: /nonexistent: No such file or directory\n"
		if got, _ := failed[0].Payload.Output["stdout"].(string); got != wantErrText {
			t.Fatalf("failed mirrored output.stdout = %q, want %q (output=%#v)", got, wantErrText, failed[0].Payload.Output)
		}
		if exitCode, ok := acpIntFromValue(failed[0].Payload.Error["exitCode"]); !ok || exitCode != 1 {
			t.Fatalf("failed error.exitCode = %#v, want 1 (error=%#v)", failed[0].Payload.Error["exitCode"], failed[0].Payload.Error)
		}
	})
}

type initializeVersionProbeTransport struct {
	mu      sync.Mutex
	methods []string
	closed  bool
	reply   string
}

func (t *initializeVersionProbeTransport) Start(_ context.Context, spec ProcessSpec) (ProcessConnection, error) {
	if len(spec.Command) == 0 {
		return nil, errors.New("command is required")
	}
	conn := &initializeVersionProbeConnection{
		parent: t,
		frames: make(chan ProcessFrame, 4),
		done:   make(chan struct{}),
	}
	return conn, nil
}

type initializeVersionProbeConnection struct {
	parent    *initializeVersionProbeTransport
	frames    chan ProcessFrame
	done      chan struct{}
	closeOnce sync.Once
}

func (c *initializeVersionProbeConnection) Send(payload []byte) error {
	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return err
	}
	c.parent.mu.Lock()
	c.parent.methods = append(c.parent.methods, msg.Method)
	reply := c.parent.reply
	c.parent.mu.Unlock()
	if msg.Method == acpMethodInitialize && reply != "" {
		c.frames <- ProcessFrame{Stdout: []byte(`{"jsonrpc":"2.0","id":` + string(msg.ID) + `,"result":` + reply + `}` + "\n")}
	}
	return nil
}

func (c *initializeVersionProbeConnection) Recv() (ProcessFrame, error) {
	return c.RecvContext(context.Background())
}

func (c *initializeVersionProbeConnection) RecvContext(ctx context.Context) (ProcessFrame, error) {
	select {
	case frame := <-c.frames:
		return frame, nil
	case <-c.done:
		code := 0
		return ProcessFrame{ExitCode: &code}, nil
	case <-ctx.Done():
		return ProcessFrame{}, ctx.Err()
	}
}

func (c *initializeVersionProbeConnection) Close() error {
	c.closeOnce.Do(func() {
		c.parent.mu.Lock()
		c.parent.closed = true
		c.parent.mu.Unlock()
		close(c.done)
	})
	return nil
}

func TestProbeStandardACPInitializeVersionExtractsAgentInfoVersionWithoutOpeningSession(t *testing.T) {
	t.Parallel()

	transport := &initializeVersionProbeTransport{
		reply: `{"protocolVersion":1,"agentInfo":{"name":"pi-acp","version":"0.0.35"}}`,
	}
	version, err := ProbeStandardACPInitializeVersion(
		context.Background(),
		[]string{"pi-acp"},
		nil,
		t.TempDir(),
		nil,
		5*time.Second,
		transport,
		LegacyHostMetadata(),
	)
	if err != nil {
		t.Fatalf("ProbeStandardACPInitializeVersion() error = %v", err)
	}
	if version != "0.0.35" {
		t.Fatalf("version = %q, want 0.0.35", version)
	}
	transport.mu.Lock()
	methods := append([]string(nil), transport.methods...)
	closed := transport.closed
	transport.mu.Unlock()
	if len(methods) != 1 || methods[0] != acpMethodInitialize {
		t.Fatalf("methods = %#v, want [initialize] without session/new", methods)
	}
	if !closed {
		t.Fatal("probe connection remained open after initialize handshake")
	}

	missingTransport := &initializeVersionProbeTransport{
		reply: `{"protocolVersion":1,"agentInfo":{"name":"pi-acp"}}`,
	}
	if got, err := ProbeStandardACPInitializeVersion(
		context.Background(),
		[]string{"pi-acp"},
		nil,
		t.TempDir(),
		nil,
		5*time.Second,
		missingTransport,
		LegacyHostMetadata(),
	); err == nil || !strings.Contains(err.Error(), "version") {
		t.Fatalf("missing version result = (%q, %v), want missing version error", got, err)
	}
}
