package agent

import (
	"context"
	"errors"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestRespondRejectsInvalidInteractionSelectionsBeforeHostSubmission(t *testing.T) {
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
				WorkspaceID: "ws-1", AgentSessionID: "session-1", RequestID: test.requestID, Semantic: test.semantic,
			})
			if !errors.Is(err, test.want) {
				t.Fatalf("Respond() error = %v, want %v", err, test.want)
			}
		})
	}
}
