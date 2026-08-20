package liveprotocol

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestMessageDeltaContractRejectsSchemaDrift(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"missing turn identity": `{
			"workspaceId":"workspace-1","agentSessionId":"session-1","eventType":"message_delta",
			"data":{"workspaceId":"workspace-1","agentSessionId":"session-1","messageId":"message-1",
				"role":"assistant","kind":"text","occurredAtUnixMs":1,
				"content":{"operation":"set","value":"hello"}}
		}`,
		"append without text": `{
			"workspaceId":"workspace-1","agentSessionId":"session-1","eventType":"message_delta",
			"data":{"workspaceId":"workspace-1","agentSessionId":"session-1","messageId":"message-1",
				"turnId":"turn-1","role":"assistant","kind":"text","occurredAtUnixMs":1,
				"content":{"operation":"append_text"}}
		}`,
		"scalar semantics": `{
			"workspaceId":"workspace-1","agentSessionId":"session-1","eventType":"message_delta",
			"data":{"workspaceId":"workspace-1","agentSessionId":"session-1","messageId":"message-1",
				"turnId":"turn-1","role":"assistant","kind":"text","occurredAtUnixMs":1,
				"semantics":"not-an-object"}
		}`,
		"duplicate payload unset": `{
			"workspaceId":"workspace-1","agentSessionId":"session-1","eventType":"message_delta",
			"data":{"workspaceId":"workspace-1","agentSessionId":"session-1","messageId":"message-1",
				"turnId":"turn-1","role":"assistant","kind":"text","occurredAtUnixMs":1,
				"payloadUnset":["text","text"]}
		}`,
		"negative lifecycle timestamp": `{
			"workspaceId":"workspace-1","agentSessionId":"session-1","eventType":"message_delta",
			"data":{"workspaceId":"workspace-1","agentSessionId":"session-1","messageId":"message-1",
				"turnId":"turn-1","role":"assistant","kind":"text","occurredAtUnixMs":1,
				"completedAtUnixMs":-1}
		}`,
	}

	for name, raw := range tests {
		name, raw := name, raw
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := DecodeEvent([]byte(raw)); !errors.Is(err, ErrInvalidLiveEvent) {
				t.Fatalf("DecodeEvent error = %v, want ErrInvalidLiveEvent", err)
			}
		})
	}
}

func TestRuntimeActivityUpdateContract(t *testing.T) {
	t.Parallel()

	event, err := NewRuntimeActivityUpdateEvent(RuntimeActivityUpdateData{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		EventType: EventTypeRuntimeActivityUpdate, State: "running", OccurredAtUnixMS: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := MarshalEvent(event)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeEvent(raw); err != nil {
		t.Fatal(err)
	}

	event.Data = []byte(`{"workspaceId":"workspace-1","agentSessionId":"session-1","eventType":"runtime_activity_update","state":"busy","occurredAtUnixMs":10}`)
	if _, err := MarshalEvent(event); !errors.Is(err, ErrInvalidLiveEvent) {
		t.Fatalf("invalid runtime activity error = %v, want ErrInvalidLiveEvent", err)
	}
}

func TestTurnUpdateContractClosesTerminalAndActiveStates(t *testing.T) {
	t.Parallel()

	terminal := mustTerminalTurnUpdate(t)
	var terminalData TurnUpdateData
	if err := json.Unmarshal(terminal.Data, &terminalData); err != nil {
		t.Fatal(err)
	}

	activeTurnID := terminalData.Turn.TurnID
	terminalData.ActiveTurnID = &activeTurnID
	if _, err := NewTurnUpdateEvent(terminalData); !errors.Is(err, ErrInvalidLiveEvent) {
		t.Fatalf("settled turn with activeTurnId error = %v, want ErrInvalidLiveEvent", err)
	}

	terminalData.ActiveTurnID = nil
	terminalData.Turn.Outcome = nil
	if _, err := NewTurnUpdateEvent(terminalData); !errors.Is(err, ErrInvalidLiveEvent) {
		t.Fatalf("settled turn without outcome error = %v, want ErrInvalidLiveEvent", err)
	}

	terminalData.Turn.Phase = "running"
	terminalData.Turn.SettledAtUnixMS = nil
	terminalData.ActiveTurnID = &activeTurnID
	if _, err := NewTurnUpdateEvent(terminalData); err != nil {
		t.Fatalf("valid active turn error = %v", err)
	}

	outcome := "completed"
	terminalData.Turn.Outcome = &outcome
	if _, err := NewTurnUpdateEvent(terminalData); !errors.Is(err, ErrInvalidLiveEvent) {
		t.Fatalf("active turn with outcome error = %v, want ErrInvalidLiveEvent", err)
	}
}

func TestCanonicalVariantsRejectNonObjectPayloads(t *testing.T) {
	t.Parallel()

	auditRaw := []byte(`{
		"workspaceId":"workspace-1","agentSessionId":"session-1","eventType":"session_audit",
		"data":{"workspaceId":"workspace-1","agentSessionId":"session-1","eventType":"session_audit",
			"audit":{"auditId":"audit-1","role":"system","payload":"bad",
				"occurredAtUnixMs":1,"version":1}}
	}`)
	if _, err := DecodeEvent(auditRaw); !errors.Is(err, ErrInvalidLiveEvent) {
		t.Fatalf("audit payload error = %v, want ErrInvalidLiveEvent", err)
	}

	interactionRaw := []byte(`{
		"workspaceId":"workspace-1","agentSessionId":"session-1","eventType":"interaction_update",
		"data":{"workspaceId":"workspace-1","agentSessionId":"session-1","eventType":"interaction_update",
			"occurredAtUnixMs":1,
			"interaction":{"requestId":"request-1","agentSessionId":"session-1","turnId":"turn-1",
				"kind":"approval","status":"pending","toolName":null,"input":[],
				"output":null,"metadata":null,"createdAtUnixMs":1,"updatedAtUnixMs":1}}
	}`)
	if _, err := DecodeEvent(interactionRaw); !errors.Is(err, ErrInvalidLiveEvent) {
		t.Fatalf("interaction input error = %v, want ErrInvalidLiveEvent", err)
	}
}

func TestInteractionSnapshotContractTreatsEmptyArrayAsExplicitClear(t *testing.T) {
	t.Parallel()
	event, err := NewInteractionSnapshotEvent(InteractionSnapshotData{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		EventType: EventTypeInteractionSnapshot, OccurredAtUnixMS: 0, RootTurnID: "turn-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	var data InteractionSnapshotData
	if err := json.Unmarshal(event.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.Interactions == nil || len(data.Interactions) != 0 {
		t.Fatalf("interactions = %#v, want explicit empty array", data.Interactions)
	}
	if data.RootTurnID != "turn-1" {
		t.Fatalf("root turn = %q, want turn-1", data.RootTurnID)
	}
}

func TestInteractionSnapshotContractRequiresRootForEmptyCollection(t *testing.T) {
	t.Parallel()
	_, err := NewInteractionSnapshotEvent(InteractionSnapshotData{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		EventType: EventTypeInteractionSnapshot, OccurredAtUnixMS: 0,
	})
	if !errors.Is(err, ErrInvalidLiveEvent) {
		t.Fatalf("missing root error = %v, want ErrInvalidLiveEvent", err)
	}
}
