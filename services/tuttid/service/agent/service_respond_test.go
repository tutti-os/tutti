package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestRespondRejectsInvalidSemanticSelectionsBeforeHostSubmission(t *testing.T) {
	base := agentactivitybiz.Interaction{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", RequestID: "request-1", TurnID: "turn-1",
		Kind: agentactivitybiz.InteractionKindApproval, Status: agentactivitybiz.InteractionStatusPending,
		Metadata: map[string]any{"actions": []any{
			map[string]any{"id": "approve-once", "label": "Approve", "semantic": "approve"},
		}},
	}
	for _, test := range []struct {
		name         string
		requestID    string
		semantic     string
		interactions []agentactivitybiz.Interaction
		want         error
	}{
		{name: "request missing", requestID: "missing", semantic: "approve", interactions: []agentactivitybiz.Interaction{base}, want: ErrInteractionRequestNotFound},
		{name: "semantic missing", requestID: "request-1", semantic: "deny", interactions: []agentactivitybiz.Interaction{base}, want: ErrInteractionSemanticNotFound},
		{name: "semantic ambiguous", requestID: "request-1", semantic: "approve", interactions: []agentactivitybiz.Interaction{func() agentactivitybiz.Interaction {
			value := base
			value.Metadata = map[string]any{"actions": []any{
				map[string]any{"id": "approve-once", "label": "Approve", "semantic": "approve"},
				map[string]any{"id": "approve-always", "label": "Always", "semantic": "approve"},
			}}
			return value
		}()}, want: ErrInteractionSemanticAmbiguous},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := newIsolatedAgentService(newFakeRuntime())
			service.TurnStore = failingTurnStore{interactions: test.interactions}
			_, err := service.Respond(context.Background(), RespondInput{
				WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1", RequestID: test.requestID, Semantic: test.semantic,
			})
			if !errors.Is(err, test.want) {
				t.Fatalf("Respond() error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestRespondSelectsExactTurnWhenProviderRequestIDIsReused(t *testing.T) {
	runtime := newFakeRuntime()
	activeTurnID := "turn-current"
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "working",
		TurnLifecycle: &TurnLifecycle{ActiveTurnID: &activeTurnID, Phase: agentactivitybiz.TurnPhaseWaiting},
	}
	service := newIsolatedAgentService(runtime)
	service.RuntimeOperationStore = &runtimeOperationMemoryStore{}
	service.RuntimeOperationOwner = "worker-a"
	service.RuntimeOperationClock = func() time.Time { return time.UnixMilli(1_000) }
	service.TurnStore = failingTurnStore{
		listInteractionsErr: errors.New("explicit response must not query interactions in the adapter"),
		session:             agentactivitybiz.Session{WorkspaceID: "ws-1", ID: "session-1", ActiveTurnID: activeTurnID},
		turn: agentactivitybiz.Turn{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: activeTurnID,
			Phase: agentactivitybiz.TurnPhaseWaiting,
		},
		interactions: []agentactivitybiz.Interaction{
			{WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-previous", RequestID: "request-reused", Status: agentactivitybiz.InteractionStatusAnswered},
			{WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: activeTurnID, RequestID: "request-reused", Status: agentactivitybiz.InteractionStatusPending},
		},
	}

	result, err := service.Respond(context.Background(), RespondInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: activeTurnID,
		RequestID: "request-reused", Action: stringRef("approve"),
	})
	if err != nil {
		t.Fatalf("Respond() error = %v", err)
	}
	if result.TurnID != activeTurnID || result.Disposition != RuntimeInteractiveDispositionAnswered {
		t.Fatalf("Respond() result = %#v", result)
	}
	if len(runtime.submitInteractiveCalls) != 1 || runtime.submitInteractiveCalls[0].TurnID != activeTurnID || runtime.submitInteractiveCalls[0].RequestID != "request-reused" {
		t.Fatalf("runtime interactive calls = %#v", runtime.submitInteractiveCalls)
	}
}

func TestRespondMapsHostOwnedMissingInteractionWithoutAdapterPrevalidation(t *testing.T) {
	runtime := newFakeRuntime()
	activeTurnID := "turn-current"
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "working",
		TurnLifecycle: &TurnLifecycle{ActiveTurnID: &activeTurnID, Phase: agentactivitybiz.TurnPhaseWaiting},
	}
	service := newIsolatedAgentService(runtime)
	service.RuntimeOperationStore = &runtimeOperationMemoryStore{interactionStore: &legacyHostConformanceTurnStore{
		interactions: map[string][]agentactivitybiz.Interaction{},
	}}
	service.RuntimeOperationOwner = "worker-a"
	service.RuntimeOperationClock = func() time.Time { return time.UnixMilli(1_000) }
	service.TurnStore = failingTurnStore{
		listInteractionsErr: errors.New("explicit response must not query interactions in the adapter"),
		session:             agentactivitybiz.Session{WorkspaceID: "ws-1", ID: "session-1", ActiveTurnID: activeTurnID},
		turn: agentactivitybiz.Turn{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: activeTurnID,
			Phase: agentactivitybiz.TurnPhaseWaiting,
		},
	}

	_, err := service.Respond(context.Background(), RespondInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: activeTurnID,
		RequestID: "missing", Action: stringRef("approve"),
	})
	if !errors.Is(err, ErrInteractionRequestNotFound) {
		t.Fatalf("Respond() error = %v, want Host-owned missing interaction", err)
	}
	if len(runtime.submitInteractiveCalls) != 0 {
		t.Fatalf("runtime interactive calls = %#v, want none", runtime.submitInteractiveCalls)
	}
}
