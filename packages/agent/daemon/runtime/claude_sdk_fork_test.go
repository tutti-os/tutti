package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestClaudeSDKForkCapabilitiesAreStructuralAndDoNotReadTranscript(t *testing.T) {
	conn := &claudeSDKForkTestConnection{
		responseType: "ok",
		responsePayload: map[string]any{
			"providerTurnIds": []string{"prompt-1", "prompt-2"},
		},
	}
	adapter := NewClaudeCodeSDKAdapter(claudeSDKForkTestTransport{conn: conn})
	source := standardTestSession(ProviderClaudeCode)
	source.ProviderSessionID = "claude-source"

	capabilities, err := adapter.ForkCapabilities(t.Context(), source)
	if err != nil {
		t.Fatal(err)
	}
	if capabilities.DriverKind != claudeSDKForkDriverKind ||
		capabilities.DriverVersion != claudeSDKForkDriverVersion ||
		!capabilities.ThroughTurn {
		t.Fatalf("capabilities=%#v", capabilities)
	}
	requests := conn.requests()
	if len(requests) != 0 {
		t.Fatalf("requests=%#v", requests)
	}
}

func TestClaudeSDKForkReturnsProviderOwnedIdentityEvidence(t *testing.T) {
	conn := &claudeSDKForkTestConnection{
		responseType: "ok",
		responsePayload: map[string]any{
			"providerSessionId": "claude-child",
			"targetProviderTurnBindings": []any{
				map[string]any{
					"providerTurnId":      "child-prompt-1",
					"checkpointMessageId": "child-answer-1",
				},
				map[string]any{
					"providerTurnId":      "child-prompt-2",
					"checkpointMessageId": "child-answer-2",
				},
			},
			"stateBindingMode":    "provider_owned",
			"stateBindingReceipt": "claude-sdk-fork-v3:receipt",
			"deliveryDisposition": "accepted",
		},
	}
	adapter := NewClaudeCodeSDKAdapter(claudeSDKForkTestTransport{conn: conn})
	source := standardTestSession(ProviderClaudeCode)
	source.ProviderSessionID = "claude-source"

	result, err := adapter.Fork(t.Context(), SessionForkInput{
		Source: source, ProviderTurnID: "prompt-2",
		ProviderTurnBindingJSON: json.RawMessage(
			`{"schemaVersion":1,"checkpointMessageId":"answer-2"}`,
		),
		TargetTitle: "Claude session (2)",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ProviderSessionID != "claude-child" ||
		result.DeliveryDisposition != SessionForkDeliveryAccepted ||
		result.StateBindingMode != "provider_owned" ||
		result.StateBindingReceipt == "" ||
		!reflect.DeepEqual(
			result.TargetProviderTurnBindings,
			[]SessionForkProviderTurnBinding{
				{
					ProviderTurnID: "child-prompt-1",
					ProviderTurnBindingJSON: json.RawMessage(
						`{"schemaVersion":1,"checkpointMessageId":"child-answer-1"}`,
					),
				},
				{
					ProviderTurnID: "child-prompt-2",
					ProviderTurnBindingJSON: json.RawMessage(
						`{"schemaVersion":1,"checkpointMessageId":"child-answer-2"}`,
					),
				},
			},
		) {
		t.Fatalf("result=%#v", result)
	}
	requests := conn.requests()
	if len(requests) != 1 || requests[0].Type != "fork_session" ||
		payloadString(requests[0].Payload, "title") != "Claude session (2)" ||
		payloadString(
			requests[0].Payload,
			"providerCheckpointMessageId",
		) != "answer-2" ||
		payloadString(requests[0].Payload, "targetProviderSessionId") != "" {
		t.Fatalf("requests=%#v", requests)
	}
}

func TestClaudeSDKForkPreservesUnknownDispositionAfterDispatch(t *testing.T) {
	conn := &claudeSDKForkTestConnection{
		responseType: "error",
		responsePayload: map[string]any{
			"error":               "Claude SDK session fork failed at provider_fork: connection lost",
			"stage":               "provider_fork",
			"deliveryDisposition": "unknown",
		},
	}
	adapter := NewClaudeCodeSDKAdapter(claudeSDKForkTestTransport{conn: conn})
	source := standardTestSession(ProviderClaudeCode)
	source.ProviderSessionID = "claude-source"
	result, err := adapter.Fork(t.Context(), SessionForkInput{
		Source: source, ProviderTurnID: "prompt-1",
		ProviderTurnBindingJSON: json.RawMessage(
			`{"schemaVersion":1,"checkpointMessageId":"answer-1"}`,
		),
		TargetTitle: "Child",
	})
	if err == nil || result.DeliveryDisposition != SessionForkDeliveryUnknown {
		t.Fatalf("result=%#v error=%v", result, err)
	}
	if !strings.Contains(err.Error(), "provider_fork: connection lost") {
		t.Fatalf("error=%q, want original provider stage and cause", err)
	}
}

func TestClaudeSDKForkedChildCanResumeAndStartTurn(t *testing.T) {
	forkConn := &claudeSDKForkTestConnection{
		responseType: "ok",
		responsePayload: map[string]any{
			"providerSessionId": "claude-child",
			"targetProviderTurnBindings": []any{
				map[string]any{
					"providerTurnId":      "child-prompt-1",
					"checkpointMessageId": "child-answer-1",
				},
			},
			"stateBindingMode":    "provider_owned",
			"stateBindingReceipt": "claude-sdk-fork-v3:receipt",
			"deliveryDisposition": "accepted",
		},
	}
	childConn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{
			{
				Stdout: []byte(
					`{"type":"session_started","payload":{"providerSessionId":"claude-child"}}` + "\n",
				),
			},
			{
				Stdout: []byte(
					`{"type":"provider_turn_identity_resolved","payload":{"turnId":"canonical-child-turn","providerTurnId":"child-provider-turn"}}` + "\n" +
						`{"type":"turn_completed","payload":{"turnId":"canonical-child-turn","providerTurnId":"child-provider-turn","stopReason":"end_turn"}}` + "\n",
				),
			},
		},
	}
	transport := &claudeSDKForkSequenceTransport{
		connections: []ProcessConnection{forkConn, childConn},
	}
	adapter := NewClaudeCodeSDKAdapter(transport)
	source := standardTestSession(ProviderClaudeCode)
	source.ProviderSessionID = "claude-source"

	result, err := adapter.Fork(t.Context(), SessionForkInput{
		Source: source, ProviderTurnID: "prompt-1",
		ProviderTurnBindingJSON: json.RawMessage(
			`{"schemaVersion":1,"checkpointMessageId":"answer-1"}`,
		),
		TargetTitle: "Child",
	})
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	target := source
	target.AgentSessionID = "agent-session-child"
	target.ProviderSessionID = result.ProviderSessionID
	target.RuntimeContext = map[string]any{
		"resumeCursor": map[string]any{
			"kind":            "claude-agent-sdk",
			"version":         int64(1),
			"resume":          "claude-source",
			"resumeSessionAt": "source-answer-1",
			"turnCount":       int64(1),
		},
	}
	if err := adapter.Resume(t.Context(), target); err != nil {
		t.Fatalf("Resume forked child: %v", err)
	}
	if !adapter.HasLiveSession(target) {
		t.Fatal("forked child did not retain a live resumed session")
	}

	if _, err := adapter.Exec(
		t.Context(),
		target,
		[]PromptContentBlock{{Type: "text", Text: "continue from fork"}},
		"",
		"canonical-child-turn",
		nil,
		nil,
	); err != nil {
		t.Fatalf("Exec forked child: %v", err)
	}
	requests := childConn.sentRequests()
	if len(requests) != 2 ||
		requests[0].Type != "start" ||
		requests[1].Type != "exec" {
		t.Fatalf("child requests=%#v, want start then exec", requests)
	}
	if requests[0].Payload["providerSessionId"] != "claude-child" {
		t.Fatalf(
			"child start providerSessionId=%#v",
			requests[0].Payload["providerSessionId"],
		)
	}
	if cursor := payloadMap(requests[0].Payload, "resumeCursor"); len(cursor) != 0 {
		t.Fatalf("child start reused source resume cursor: %#v", cursor)
	}
	if requests[1].Payload["agentSessionId"] != "agent-session-child" {
		t.Fatalf("child exec payload=%#v", requests[1].Payload)
	}
	if transport.starts() != 2 {
		t.Fatalf("process starts=%d, want fork sidecar and child runtime", transport.starts())
	}
}

type claudeSDKForkTestTransport struct {
	conn ProcessConnection
}

func (t claudeSDKForkTestTransport) Start(
	context.Context,
	ProcessSpec,
) (ProcessConnection, error) {
	if t.conn == nil {
		return nil, errors.New("test connection is unavailable")
	}
	return t.conn, nil
}

type claudeSDKForkTestConnection struct {
	mu              sync.Mutex
	sent            []claudeSDKSidecarRequest
	frames          []ProcessFrame
	responseType    string
	responsePayload map[string]any
}

func (c *claudeSDKForkTestConnection) Send(data []byte) error {
	var request claudeSDKSidecarRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return err
	}
	response, err := json.Marshal(claudeSDKSidecarEvent{
		Version: claudeSDKSidecarProtocolVersion,
		ID:      request.ID,
		Type:    c.responseType,
		Payload: clonePayload(c.responsePayload),
	})
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.sent = append(c.sent, request)
	c.frames = append(c.frames, ProcessFrame{Stdout: append(response, '\n')})
	c.mu.Unlock()
	return nil
}

func (c *claudeSDKForkTestConnection) Recv() (ProcessFrame, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.frames) == 0 {
		return ProcessFrame{}, io.EOF
	}
	frame := c.frames[0]
	c.frames = c.frames[1:]
	return frame, nil
}

func (*claudeSDKForkTestConnection) Close() error { return nil }

func (c *claudeSDKForkTestConnection) requests() []claudeSDKSidecarRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]claudeSDKSidecarRequest(nil), c.sent...)
}

type claudeSDKForkSequenceTransport struct {
	mu          sync.Mutex
	connections []ProcessConnection
	startCount  int
}

func (t *claudeSDKForkSequenceTransport) Start(
	_ context.Context,
	_ ProcessSpec,
) (ProcessConnection, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.startCount++
	if len(t.connections) == 0 {
		return nil, errors.New("test connection sequence is exhausted")
	}
	conn := t.connections[0]
	t.connections = t.connections[1:]
	return conn, nil
}

func (t *claudeSDKForkSequenceTransport) starts() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.startCount
}
