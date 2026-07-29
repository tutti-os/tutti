package agentruntime

import (
	"context"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
)

// A failed daemon root settlement must carry the durable failure reason into
// the live event stream: mid-turn provider failures (for example Codex quota
// exhaustion) settle through this path, and without the detail the
// visible-error projection can only render a generic card.
func TestReconcileRootTurnSettlementPublishesFailureDetail(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	controller := NewDefaultControllerWithProcessTransport(reporter, newScriptedACPTransport())
	ctx := context.Background()

	started, err := controller.Start(ctx, StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()

	execResult, err := controller.Exec(ctx, ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("hello"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !execResult.Accepted || execResult.TurnID == "" {
		t.Fatalf("Exec result = %#v, want accepted result with turn id", execResult)
	}

	const failureDetail = "You've hit your usage limit. Upgrade to Pro or try again later."
	controller.ReconcileRootTurnSettlement(RootTurnSettlement{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		TurnID:         execResult.TurnID,
		Outcome:        "failed",
		ErrorMessage:   failureDetail,
	})

	deadline := time.After(5 * time.Second)
	for {
		select {
		case event := <-events:
			if event.EventType != StreamEventMessageUpdate {
				continue
			}
			update, ok := event.Data.(agentsessionstore.WorkspaceAgentMessageUpdate)
			if !ok || update.Payload["kind"] != visibleErrorKind {
				continue
			}
			if update.Payload["phase"] != "turn" {
				t.Fatalf("visible failure phase = %#v, want turn", update.Payload["phase"])
			}
			if update.Payload["code"] != "quota_or_rate_limit" {
				t.Fatalf("visible failure code = %#v, want quota_or_rate_limit", update.Payload["code"])
			}
			if update.Payload["detail"] != failureDetail {
				t.Fatalf("visible failure detail = %#v, want %q", update.Payload["detail"], failureDetail)
			}
			return
		case <-deadline:
			t.Fatal("expected visible failure message for failed root turn settlement")
		}
	}
}
