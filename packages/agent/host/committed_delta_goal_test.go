package agenthost

import (
	"context"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

type terminalIdentityReadCountingStore struct {
	CanonicalStore
	getSessionCalls int
}

func (s *terminalIdentityReadCountingStore) GetSession(
	context.Context,
	string,
	string,
) (storesqlite.Session, bool, error) {
	s.getSessionCalls++
	return storesqlite.Session{Provider: "codex"}, true, nil
}

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

func TestActivityStateDeltaCarriesCanonicalProviderIntoRootSettlement(t *testing.T) {
	t.Parallel()

	delta := ActivityStateDelta(
		canonical.ReportSessionStateInput{
			WorkspaceID: "ws-1", AgentSessionID: "session-1",
			Source: canonical.EventSource{Provider: "source-provider"},
			State:  canonical.WorkspaceAgentSessionStateUpdate{Provider: "reported-provider"},
		},
		canonical.ReportSessionStateReply{Accepted: true, StateApplied: true},
		storesqlite.ActivityStateReportResult{
			State:            storesqlite.StateReportResult{Session: storesqlite.Session{Provider: "canonical-provider"}},
			RootTurnAccepted: true,
			RootTurn: storesqlite.Turn{
				WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
				Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeFailed,
			},
		},
	)
	if len(delta.RootTurnsSettled) != 1 || delta.RootTurnsSettled[0].Provider != "canonical-provider" {
		t.Fatalf("root settlements = %#v, want canonical provider", delta.RootTurnsSettled)
	}
}

func TestActivityStateDeltaClassifiesSettledRootByOwnerWhenChildReportsTerminal(t *testing.T) {
	t.Parallel()

	delta := ActivityStateDelta(
		canonical.ReportSessionStateInput{
			WorkspaceID: "ws-1", AgentSessionID: "child-1",
			State: canonical.WorkspaceAgentSessionStateUpdate{
				Kind:             storesqlite.SessionKindChild,
				ParentToolCallID: "call-1",
			},
		},
		canonical.ReportSessionStateReply{Accepted: true, StateApplied: true},
		storesqlite.ActivityStateReportResult{
			State: storesqlite.StateReportResult{Session: storesqlite.Session{
				ID: "child-1", WorkspaceID: "ws-1", Kind: storesqlite.SessionKindChild,
				ParentToolCallID: "call-1", Provider: "codex",
			}},
			RootTurnAccepted: true,
			RootTurn: storesqlite.Turn{
				WorkspaceID: "ws-1", AgentSessionID: "root-1", TurnID: "root-turn",
				Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeCompleted,
			},
		},
	)
	if len(delta.RootTurnsSettled) != 1 {
		t.Fatalf("root settlements = %#v, want one", delta.RootTurnsSettled)
	}
	if settled := delta.RootTurnsSettled[0]; settled.AgentSessionID != "root-1" || settled.IsChildSession {
		t.Fatalf("root settlement identity = %#v, want canonical root owner", settled)
	}
}

func TestTerminalFailureIdentityEnrichmentSkipsSuccessfulCommits(t *testing.T) {
	t.Parallel()

	store := &terminalIdentityReadCountingStore{}
	host := &Host{store: store}
	delta := CommittedDelta{
		RuntimeOperation: &RuntimeOperationCommitted{
			Stage: RuntimeOperationCompleted,
			Operation: storesqlite.RuntimeOperation{
				WorkspaceID: "ws-1", AgentSessionID: "session-1",
			},
		},
		GoalOperation: &GoalOperationCommitted{
			Stage: GoalOperationCompleted,
			Operation: storesqlite.GoalControlOperation{
				WorkspaceID: "ws-1", AgentSessionID: "session-1",
			},
		},
		RootTurnsSettled: []RootTurnSettled{{
			WorkspaceID: "ws-1", AgentSessionID: "session-1",
			Turn: storesqlite.Turn{Outcome: storesqlite.TurnOutcomeCompleted},
		}},
		SessionMessages: &SessionMessagesCommitted{
			Input: canonical.ReportSessionMessagesInput{
				WorkspaceID: "ws-1", AgentSessionID: "session-1",
			},
			Result: storesqlite.MessageReportResult{Messages: []storesqlite.Message{{
				AgentSessionID: "session-1", MessageID: "message-1", Status: "completed",
			}}},
		},
	}

	host.enrichCommittedDeltaTerminalIdentity(context.Background(), &delta)

	if store.getSessionCalls != 0 {
		t.Fatalf("GetSession calls = %d, want none for successful commits", store.getSessionCalls)
	}
}
