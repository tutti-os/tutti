package agenthost

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

type goalCommitStageStore struct {
	GoalStateStore
	releaseOperation storesqlite.GoalControlOperation
	repairOperation  storesqlite.GoalControlOperation
	repairState      storesqlite.SessionGoalState
}

func (s goalCommitStageStore) ReleaseGoalControlOperation(context.Context, storesqlite.ReleaseGoalControlOperationInput) (storesqlite.GoalControlOperation, bool, error) {
	return s.releaseOperation, true, nil
}

func (s goalCommitStageStore) EnsureOrWakeGoalRepairOperation(context.Context, storesqlite.EnsureGoalRepairOperationInput) (storesqlite.GoalControlOperation, storesqlite.SessionGoalState, bool, error) {
	return s.repairOperation, s.repairState, false, nil
}

type committedDeltaRecorder struct {
	deltas []CommittedDelta
}

type runtimeCompletionStore struct {
	RuntimeOperationStore
	completion storesqlite.RuntimeOperationCompletion
}

func (s runtimeCompletionStore) CompleteCancelRuntimeOperation(context.Context, storesqlite.CompleteCancelRuntimeOperationInput) (storesqlite.RuntimeOperationCompletion, bool, error) {
	return s.completion, true, nil
}

type canonicalTurnReadStore struct {
	CanonicalStore
	turn    storesqlite.Turn
	session storesqlite.Session
}

func (s canonicalTurnReadStore) GetTurn(context.Context, string, string, string) (storesqlite.Turn, bool, error) {
	return s.turn, true, nil
}

func (s canonicalTurnReadStore) GetSession(context.Context, string, string) (storesqlite.Session, bool, error) {
	return s.session, true, nil
}

func (r *committedDeltaRecorder) ObserveCommitted(_ context.Context, delta CommittedDelta) error {
	r.deltas = append(r.deltas, delta)
	return nil
}

func TestObservedGoalReleaseReportsFailedStage(t *testing.T) {
	recorder := &committedDeltaRecorder{}
	host := &Host{commitObserver: recorder}
	store := &observedGoalStateStore{GoalStateStore: goalCommitStageStore{
		releaseOperation: storesqlite.GoalControlOperation{
			OperationID: "goal-1", WorkspaceID: "ws-1", AgentSessionID: "session-1",
			CommitTransactionID: "tx-failed",
		},
	}, host: host}

	if _, _, err := store.ReleaseGoalControlOperation(context.Background(), storesqlite.ReleaseGoalControlOperationInput{Fail: true}); err != nil {
		t.Fatal(err)
	}
	if len(recorder.deltas) != 1 || recorder.deltas[0].GoalOperation == nil || recorder.deltas[0].GoalOperation.Stage != GoalOperationFailed {
		t.Fatalf("committed deltas=%#v", recorder.deltas)
	}
}

func TestObservedGoalRepairReportsTerminalCommit(t *testing.T) {
	recorder := &committedDeltaRecorder{}
	host := &Host{commitObserver: recorder}
	terminalDelta := storesqlite.TransactionDelta{
		TransactionID: "tx-terminal",
		Mutations:     []storesqlite.TransactionMutation{{EntityKind: storesqlite.MutationEntityGoalState, Operation: "terminal"}},
	}
	store := &observedGoalStateStore{GoalStateStore: goalCommitStageStore{
		repairState: storesqlite.SessionGoalState{
			WorkspaceID: "ws-1", AgentSessionID: "session-1",
			CommitTransactionID: terminalDelta.TransactionID, CommitDelta: terminalDelta,
		},
	}, host: host}

	if _, _, _, err := store.EnsureOrWakeGoalRepairOperation(context.Background(), storesqlite.EnsureGoalRepairOperationInput{}); err != nil {
		t.Fatal(err)
	}
	if len(recorder.deltas) != 1 || recorder.deltas[0].GoalOperation == nil || recorder.deltas[0].GoalOperation.Stage != GoalOperationTerminal {
		t.Fatalf("committed deltas=%#v", recorder.deltas)
	}
}

func TestObservedCancelCompletionReportsRootSettlementOnce(t *testing.T) {
	recorder := &committedDeltaRecorder{}
	root := storesqlite.Turn{
		WorkspaceID: "ws-1", AgentSessionID: "root-session", TurnID: "root-turn",
		Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeCanceled,
	}
	host := &Host{commitObserver: recorder, store: canonicalTurnReadStore{
		turn: root,
		session: storesqlite.Session{
			ID: "root-session", WorkspaceID: "ws-1", Provider: "codex",
			Kind: storesqlite.SessionKindChild, ParentToolCallID: "tool-1",
		},
	}}
	completion := storesqlite.RuntimeOperationCompletion{
		Operation: storesqlite.RuntimeOperation{
			OperationID: "cancel-1", WorkspaceID: "ws-1", AgentSessionID: "root-session",
			CommitTransactionID: "tx-cancel",
		},
		Event: storesqlite.RuntimeOperationEvent{
			Kind: storesqlite.RuntimeOperationEventTurnCanceled,
			Payload: map[string]any{
				"rootAgentSessionId": "root-session",
				"settledTargets": []any{map[string]any{
					"agentSessionId": "root-session", "turnId": "root-turn",
				}},
				"reconciledRoot": map[string]any{
					"agentSessionId": "root-session", "turnId": "root-turn",
				},
			},
		},
	}
	store := &observedRuntimeOperationStore{
		RuntimeOperationStore: runtimeCompletionStore{completion: completion}, host: host,
	}

	if _, _, err := store.CompleteCancelRuntimeOperation(context.Background(), storesqlite.CompleteCancelRuntimeOperationInput{}); err != nil {
		t.Fatal(err)
	}
	if len(recorder.deltas) != 1 || len(recorder.deltas[0].RootTurnsSettled) != 1 || recorder.deltas[0].RootTurnsSettled[0].Turn.TurnID != "root-turn" {
		t.Fatalf("committed deltas=%#v", recorder.deltas)
	}
	settled := recorder.deltas[0].RootTurnsSettled[0]
	if settled.Provider != "codex" || !settled.IsChildSession {
		t.Fatalf("root settlement identity=%#v, want canonical provider and child marker", settled)
	}
}

func TestObservedCancelCompletionDoesNotRepeatAlreadySettledRoot(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "cancel-already-settled.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(t.Context(), storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "root-session", Kind: storesqlite.SessionKindRoot,
			Provider: "codex", OccurredAtUnixMS: 10,
		},
		Turn: &storesqlite.TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "root-session", TurnID: "root-turn",
			Phase: storesqlite.TurnPhaseRunning, Origin: storesqlite.TurnOriginUserPrompt,
			OccurredAtUnixMS: 10,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, created, err := store.PrepareRuntimeOperation(t.Context(), storesqlite.RuntimeOperationPrepare{
		OperationID: "cancel-1", WorkspaceID: "ws-1", AgentSessionID: "root-session",
		Kind: storesqlite.RuntimeOperationKindCancelTurn, TurnID: "root-turn", OccurredAtMS: 20,
		Payload: map[string]any{
			"rootAgentSessionId": "root-session",
			"targets": []any{map[string]any{
				"agentSessionId": "root-session", "turnId": "root-turn",
			}},
		},
	}); err != nil || !created {
		t.Fatalf("prepare cancel created=%v err=%v", created, err)
	}
	if _, claimed, err := store.ClaimRuntimeOperationLease(t.Context(), storesqlite.ClaimRuntimeOperationLeaseInput{
		WorkspaceID: "ws-1", OperationID: "cancel-1", LeaseOwner: "worker-a",
		NowUnixMS: 21, LeaseExpiresAtMS: 100,
	}); err != nil || !claimed {
		t.Fatalf("claim cancel claimed=%v err=%v", claimed, err)
	}
	if _, err := store.ReportActivityState(t.Context(), storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "root-session", Kind: storesqlite.SessionKindRoot,
			Provider: "codex", OccurredAtUnixMS: 25,
		},
		Turn: &storesqlite.TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "root-session", TurnID: "root-turn",
			Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeCanceled,
			Origin: storesqlite.TurnOriginUserPrompt, OccurredAtUnixMS: 25,
		},
	}); err != nil {
		t.Fatal(err)
	}

	recorder := &committedDeltaRecorder{}
	canonicalStore := &SQLiteWorkspaceStore{StoreForWorkspace: func(workspaceID string) *storesqlite.Store {
		if workspaceID != "ws-1" {
			return nil
		}
		return store
	}}
	host := New(Config{CanonicalStore: canonicalStore, RuntimeOperations: store, CommitObserver: recorder})
	if _, changed, err := host.operations.CompleteCancelRuntimeOperation(t.Context(), storesqlite.CompleteCancelRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "cancel-1", LeaseOwner: "worker-a",
		TargetOutcomes: []storesqlite.CancelRuntimeOperationTargetOutcome{{
			AgentSessionID: "root-session", TurnID: "root-turn", Outcome: storesqlite.TurnOutcomeCanceled,
		}},
		NowUnixMS: 30,
	}); err != nil || !changed {
		t.Fatalf("complete cancel changed=%v err=%v", changed, err)
	}
	if len(recorder.deltas) != 1 {
		t.Fatalf("committed deltas=%#v, want the runtime-operation completion", recorder.deltas)
	}
	if settlements := recorder.deltas[0].RootTurnsSettled; len(settlements) != 0 {
		t.Fatalf("root settlements=%#v, want no repeat for the already-settled root", settlements)
	}
}
