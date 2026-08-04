package agenthost_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// TestEditRetryCrashFaultHarnessDistinguishesCommittedFromUncommitted models a
// process cut after a successful compound SQLite commit but before the caller
// sees its reply. It intentionally differs from TransactionParticipant tests:
// the row/fence must exist after this injected error.
func TestEditRetryCrashFaultHarnessDistinguishesCommittedFromUncommitted(t *testing.T) {
	for _, point := range []string{"prepare", "rollback_intent", "completion"} {
		t.Run(point+"_after_commit_before_observe", func(t *testing.T) {
			dbPath := filepath.Join(t.TempDir(), point+".db")
			runtime := &hostEditRetryRuntime{}
			_, store, db := openEditRetryRestartFixture(t, dbPath, runtime, true)
			seedBatchRunningSession(t, store, "session-healthy", "turn-healthy")
			healthyOperation := prepareBatchCancel(t, store, "operation-healthy", "session-healthy", "turn-healthy", 10)
			faults := &postCommitEditRetryFaultStore{EffectiveHistoryStore: store, point: point}
			host := newEditRetryFaultHarnessHost(store, runtime, faults)

			switch point {
			case "prepare":
				_, err := host.EditRetry(t.Context(), editRetryRestartRef, "turn-original", agenthost.EditRetryInput{
					EditedText: "edited", ClientOperationID: "fault-prepare", ExpectedHistoryRevision: 0,
				})
				if !errors.Is(err, errInjectedPostCommit) {
					t.Fatalf("EditRetry() error=%v, want post-commit interruption", err)
				}
				assertNoEditRetryProviderWork(t, runtime)
			case "rollback_intent":
				operationID := prepareFaultHarnessOperation(t, store, "fault-rollback-intent")
				if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
					t.Fatalf("StepRuntimeOperationWorker()=%v", err)
				}
				assertEditRetryProviderCalls(t, runtime, 0, 0)
				assertFaultHarnessCheckpoint(t, store, operationID, storesqlite.EditRetryCheckpointRollbackDispatched, false)
			case "completion":
				_, err := host.EditRetry(t.Context(), editRetryRestartRef, "turn-original", agenthost.EditRetryInput{
					EditedText: "edited", ClientOperationID: "fault-completion", ExpectedHistoryRevision: 0,
				})
				if !errors.Is(err, errInjectedPostCommit) {
					t.Fatalf("EditRetry() error=%v, want post-commit interruption", err)
				}
				assertEditRetryProviderCalls(t, runtime, 1, 1)
			}

			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			for restart := 0; restart < 2; restart++ {
				host, store, db = openEditRetryRestartFixture(t, dbPath, runtime, false)
				if err := host.RecoverCore(t.Context()); err != nil {
					t.Fatalf("restart %d RecoverCore()=%v", restart+1, err)
				}
				if restart == 0 && point != "completion" {
					assertFaultHarnessFence(t, store)
				}
				if restart == 0 {
					if err := host.StepRuntimeOperationWorker(t.Context(), true); err != nil {
						t.Fatalf("restart %d StepRuntimeOperationWorker()=%v", restart+1, err)
					}
					assertBatchOperationStatus(t, store, healthyOperation.OperationID, storesqlite.RuntimeOperationStatusCompleted)
				}
				if point == "completion" || point == "prepare" {
					assertFaultHarnessTerminal(t, store)
					assertEditRetryProviderCalls(t, runtime, 1, 1)
				} else {
					assertFaultHarnessFence(t, store)
				}
				if err := db.Close(); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

var errInjectedPostCommit = errors.New("injected post-commit caller interruption")

func captureEditRetrySnapshotForHarness(t *testing.T, store *storesqlite.Store, operationID, owner string, now int64) storesqlite.RuntimeOperation {
	t.Helper()
	op, changed, err := store.CaptureEditRetryPreEffectSnapshot(t.Context(), storesqlite.CaptureEditRetryPreEffectSnapshotInput{
		WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: operationID, LeaseOwner: owner,
		ProviderSessionID: "thread-1", ProviderTurnIDs: []string{"provider-original"}, NowUnixMS: now,
	})
	if err != nil || !changed {
		t.Fatalf("CaptureEditRetryPreEffectSnapshot() operation=%#v changed=%v error=%v", op, changed, err)
	}
	return op
}

type postCommitEditRetryFaultStore struct {
	agenthost.EffectiveHistoryStore
	point string
	fired bool
}

func (s *postCommitEditRetryFaultStore) after(point string, changed bool, err error) error {
	if err == nil && changed && !s.fired && s.point == point {
		s.fired = true
		return errInjectedPostCommit
	}
	return err
}

func (s *postCommitEditRetryFaultStore) PrepareEditRetry(ctx context.Context, input storesqlite.RuntimeOperationPrepare) (storesqlite.RuntimeOperation, bool, error) {
	op, changed, err := s.EffectiveHistoryStore.PrepareEditRetry(ctx, input)
	return op, changed, s.after("prepare", changed, err)
}

func (s *postCommitEditRetryFaultStore) MarkEditRetryRollbackDispatched(ctx context.Context, input storesqlite.MarkEditRetryRollbackDispatchedInput) (storesqlite.RuntimeOperation, bool, error) {
	op, changed, err := s.EffectiveHistoryStore.MarkEditRetryRollbackDispatched(ctx, input)
	return op, changed, s.after("rollback_intent", changed, err)
}

func (s *postCommitEditRetryFaultStore) CaptureEditRetryPreEffectSnapshot(ctx context.Context, input storesqlite.CaptureEditRetryPreEffectSnapshotInput) (storesqlite.RuntimeOperation, bool, error) {
	op, changed, err := s.EffectiveHistoryStore.CaptureEditRetryPreEffectSnapshot(ctx, input)
	return op, changed, s.after("pre_effect_snapshot", changed, err)
}

func (s *postCommitEditRetryFaultStore) ConfirmEditRetryRollback(ctx context.Context, input storesqlite.ConfirmEditRetryRollbackInput) (storesqlite.RuntimeOperation, bool, error) {
	op, changed, err := s.EffectiveHistoryStore.ConfirmEditRetryRollback(ctx, input)
	return op, changed, s.after("rollback_result", changed, err)
}

func (s *postCommitEditRetryFaultStore) AbortEditRetryRollback(ctx context.Context, input storesqlite.AbortEditRetryRollbackInput) (storesqlite.RuntimeOperation, bool, error) {
	op, changed, err := s.EffectiveHistoryStore.AbortEditRetryRollback(ctx, input)
	return op, changed, s.after("rollback_abort", changed, err)
}

func (s *postCommitEditRetryFaultStore) AuthorizeEditRetryReplacementRetry(ctx context.Context, input storesqlite.AuthorizeEditRetryReplacementRetryInput) (storesqlite.RuntimeOperation, bool, error) {
	op, changed, err := s.EffectiveHistoryStore.AuthorizeEditRetryReplacementRetry(ctx, input)
	return op, changed, s.after("absence_proof", changed, err)
}

func (s *postCommitEditRetryFaultStore) ReconcileBlockedEditRetry(ctx context.Context, input storesqlite.ReconcileBlockedEditRetryInput) (storesqlite.RuntimeOperation, bool, error) {
	op, changed, err := s.EffectiveHistoryStore.ReconcileBlockedEditRetry(ctx, input)
	return op, changed, s.after("blocked_reconcile", changed, err)
}

func (s *postCommitEditRetryFaultStore) WakeDeferredEditRetry(ctx context.Context, input storesqlite.WakeDeferredEditRetryInput) (storesqlite.RuntimeOperation, bool, error) {
	op, changed, err := s.EffectiveHistoryStore.WakeDeferredEditRetry(ctx, input)
	return op, changed, s.after("wake", changed, err)
}

func (s *postCommitEditRetryFaultStore) AbandonEditRetry(ctx context.Context, input storesqlite.AbandonEditRetryInput) (storesqlite.RuntimeOperation, bool, error) {
	op, changed, err := s.EffectiveHistoryStore.AbandonEditRetry(ctx, input)
	return op, changed, s.after("abandon", changed, err)
}

func (s *postCommitEditRetryFaultStore) CompleteEditRetryRuntimeOperation(ctx context.Context, input storesqlite.CompleteEditRetryRuntimeOperationInput) (storesqlite.RuntimeOperationCompletion, bool, error) {
	completion, changed, err := s.EffectiveHistoryStore.CompleteEditRetryRuntimeOperation(ctx, input)
	if afterErr := s.after("completion", changed, err); afterErr != nil {
		return completion, changed, afterErr
	}
	return completion, changed, nil
}

func newEditRetryFaultHarnessHost(store *storesqlite.Store, runtime *hostEditRetryRuntime, history agenthost.EffectiveHistoryStore) *agenthost.Host {
	return agenthost.New(agenthost.Config{
		CanonicalStore: sqliteCanonicalStore{Store: store}, TurnSubmissions: store,
		EffectiveHistory: history, RuntimeOperations: store, Runtime: runtime,
		HistoryRuntime: runtime, GoalRuntime: runtime, OperationOwner: "fault-harness",
	})
}

func prepareFaultHarnessOperation(t *testing.T, store *storesqlite.Store, operationID string) string {
	t.Helper()
	payload, err := storesqlite.EncodeEditRetryOperationPayload(storesqlite.EditRetryOperationPayload{
		ClientOperationID: operationID, EditedText: "edited", ReplacementTurnID: "replacement-" + operationID,
		ClientSubmitID: "edit-retry:" + operationID, ExpectedRevision: 0, Checkpoint: storesqlite.EditRetryCheckpointPrepared,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, changed, err := store.PrepareEditRetry(t.Context(), storesqlite.RuntimeOperationPrepare{
		WorkspaceID: editRetryRestartRef.WorkspaceID, AgentSessionID: editRetryRestartRef.AgentSessionID,
		OperationID: operationID, Kind: storesqlite.RuntimeOperationKindEditRetry, TurnID: "turn-original",
		RequestID: operationID, Payload: payload, OccurredAtMS: time.Now().UnixMilli(),
	}); err != nil || !changed {
		t.Fatalf("PrepareEditRetry() changed=%v error=%v", changed, err)
	}
	return operationID
}

func assertFaultHarnessCheckpoint(t *testing.T, store *storesqlite.Store, operationID string, checkpoint storesqlite.EditRetryCheckpoint, terminal bool) {
	t.Helper()
	op, found, err := store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, operationID)
	if err != nil || !found {
		t.Fatalf("operation found=%v error=%v", found, err)
	}
	payload, err := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
	if err != nil || payload.Checkpoint != checkpoint || (terminal && op.Status != storesqlite.RuntimeOperationStatusCompleted) {
		t.Fatalf("operation=%#v payload=%#v error=%v", op, payload, err)
	}
}

func assertFaultHarnessFence(t *testing.T, store *storesqlite.Store) {
	t.Helper()
	history, found, err := store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID)
	if err != nil || !found || history.OperationID == "" || history.RecoveryState == storesqlite.SessionHistoryRecoveryReady {
		t.Fatalf("history=%#v found=%v error=%v, want retained fence", history, found, err)
	}
}

func assertFaultHarnessTerminal(t *testing.T, store *storesqlite.Store) {
	t.Helper()
	operations, err := store.ListClaimableRuntimeOperations(t.Context(), storesqlite.ListClaimableRuntimeOperationsInput{NowUnixMS: 9_999_999_999_999, Limit: 10})
	if err != nil || len(operations) != 0 {
		t.Fatalf("claimable terminal operations=%#v error=%v", operations, err)
	}
}
