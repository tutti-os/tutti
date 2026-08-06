package agenthost

import (
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func TestActivityStateDeltaAttachesGoalOperationForObservedComplete(t *testing.T) {
	t.Parallel()
	delta := ActivityStateDelta(
		canonical.ReportSessionStateInput{
			WorkspaceID:    "ws-1",
			AgentSessionID: "session-1",
			State: canonical.WorkspaceAgentSessionStateUpdate{
				RuntimeContext: map[string]any{
					"goal": map[string]any{
						"objective": "count",
						"status":    "complete",
					},
				},
			},
		},
		canonical.ReportSessionStateReply{Accepted: true, StateApplied: true},
		storesqlite.ActivityStateReportResult{
			TransactionID: "tx-1",
			CommitDelta: storesqlite.TransactionDelta{
				TransactionID: "tx-1",
				Mutations: []storesqlite.TransactionMutation{{
					WorkspaceID:    "ws-1",
					AgentSessionID: "session-1",
					EntityKind:     storesqlite.MutationEntityGoalState,
					EntityID:       "session-1",
					Operation:      "upsert",
				}},
			},
		},
	)
	if delta.GoalOperation == nil {
		t.Fatal("expected GoalOperation on ActivityStateDelta")
	}
	if delta.GoalOperation.Stage != GoalOperationReconciled {
		t.Fatalf("stage=%q", delta.GoalOperation.Stage)
	}
	if status, _ := delta.GoalOperation.State.Observed["status"].(string); status != "complete" {
		t.Fatalf("observed=%#v", delta.GoalOperation.State.Observed)
	}
}

func TestActivityStateDeltaSkipsGoalOperationWithoutGoalMutation(t *testing.T) {
	t.Parallel()
	delta := ActivityStateDelta(
		canonical.ReportSessionStateInput{
			WorkspaceID:    "ws-1",
			AgentSessionID: "session-1",
			State: canonical.WorkspaceAgentSessionStateUpdate{
				RuntimeContext: map[string]any{
					"goal": map[string]any{"status": "complete"},
				},
			},
		},
		canonical.ReportSessionStateReply{},
		storesqlite.ActivityStateReportResult{
			TransactionID: "tx-1",
			CommitDelta: storesqlite.TransactionDelta{
				TransactionID: "tx-1",
				Mutations: []storesqlite.TransactionMutation{{
					WorkspaceID:    "ws-1",
					AgentSessionID: "session-1",
					EntityKind:     storesqlite.MutationEntitySession,
					EntityID:       "session-1",
					Operation:      "upsert",
				}},
			},
		},
	)
	if delta.GoalOperation != nil {
		t.Fatalf("unexpected GoalOperation=%#v", delta.GoalOperation)
	}
}
