package agenthost_test

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// TestEditRetryLeaseFaultMatrix uses a real SQLite file for every row. Claim
// intentionally remains the production single-row CAS: a BEFORE UPDATE
// trigger models failure before autocommit, while a test-only Store decorator
// models loss after SQLite committed but before the caller observed success.
func TestEditRetryLeaseFaultMatrix(t *testing.T) {
	t.Run("claim before commit rolls back without provider work", func(t *testing.T) {
		f := newLeaseFaultFixture(t, "lease-before")
		before := f.operation(t)
		db := f.db.(*sql.DB)
		if _, err := db.ExecContext(t.Context(), `
CREATE TRIGGER fail_edit_retry_lease_claim
BEFORE UPDATE OF status ON workspace_agent_runtime_operations
WHEN OLD.operation_id = 'lease-before' AND NEW.status = 'leased'
BEGIN SELECT RAISE(ABORT, 'injected edit retry lease claim failure'); END;
`); err != nil {
			t.Fatal(err)
		}
		_, claimed, err := f.claim(t, "before-owner", before.NextAttemptAtMS)
		if err == nil || claimed || !strings.Contains(err.Error(), "injected edit retry lease claim failure") {
			t.Fatalf("claim=%v error=%v, want trigger failure", claimed, err)
		}
		after := f.operation(t)
		assertLeaseUnchanged(t, before, after)
		f.assertNoProviderMutation(t)
		if _, err := db.ExecContext(t.Context(), `DROP TRIGGER fail_edit_retry_lease_claim`); err != nil {
			t.Fatal(err)
		}
		if _, claimed, err = f.claim(t, "retry-owner", before.NextAttemptAtMS); err != nil || !claimed {
			t.Fatalf("claim after trigger removal=%v error=%v", claimed, err)
		}
		f.step(t) // session B remains independently processable while A is leased.
		f.reopenTwice(t)
		f.assertNoProviderMutation(t)
	})

	t.Run("post commit caller loss requeues safely", func(t *testing.T) {
		f := newLeaseFaultFixture(t, "lease-after")
		faults := &postCommitClaimStore{RuntimeOperationStore: f.store}
		if _, claimed, err := faults.ClaimRuntimeOperationLease(t.Context(), f.claimInput("after-owner", time.Now().UnixMilli())); !errors.Is(err, errInjectedPostCommit) || !claimed || !faults.fired {
			t.Fatalf("claim=%v error=%v fired=%v", claimed, err, faults.fired)
		}
		leased := f.operation(t)
		if leased.Status != storesqlite.RuntimeOperationStatusLeased || leased.LeaseOwner != "after-owner" || leased.Attempt != 1 {
			t.Fatalf("committed lease=%#v", leased)
		}
		f.assertNoProviderMutation(t)
		f.step(t) // B completes; A is not eligible while its lease is durable.
		f.reopenTwice(t)
		requeued := f.operation(t)
		if requeued.Status != storesqlite.RuntimeOperationStatusPrepared || requeued.LeaseOwner != "" || requeued.Attempt != 1 {
			t.Fatalf("requeued lease=%#v", requeued)
		}
		// Production stays fail-closed while new edit-retry admission is denied: the
		// recovered A work can be dispositioned without a provider call.
		disabled := newBatchRuntimeOperationHost(f.store, f.runtime, f.store, &recordingRuntimeOperationPublisher{}, true)
		if err := disabled.StepRuntimeOperationWorker(t.Context(), true); err != nil {
			t.Fatalf("safe post-requeue processing=%v", err)
		}
		f.assertNoProviderMutation(t)
		assertBatchOperationStatus(t, f.store, f.healthyID, storesqlite.RuntimeOperationStatusCompleted)
	})

	t.Run("expiry permits one explicit-clock takeover", func(t *testing.T) {
		f := newLeaseFaultFixture(t, "lease-expiry")
		now := time.Now().UnixMilli()
		first, claimed, err := f.claim(t, "worker-a", now)
		if err != nil || !claimed || first.Attempt != 1 {
			t.Fatalf("first claim=%#v claimed=%v error=%v", first, claimed, err)
		}
		if _, claimed, err = f.claim(t, "worker-b", now+99); err != nil || claimed {
			t.Fatalf("early takeover claimed=%v error=%v", claimed, err)
		}
		taken, claimed, err := f.claim(t, "worker-b", now+100)
		if err != nil || !claimed || taken.LeaseOwner != "worker-b" || taken.Attempt != 2 {
			t.Fatalf("expired takeover=%#v claimed=%v error=%v", taken, claimed, err)
		}
		f.step(t)
		f.reopenTwice(t)
		f.assertNoProviderMutation(t)
	})

	t.Run("startup requeue failure retains leased fence until a later reopen", func(t *testing.T) {
		f := newLeaseFaultFixture(t, "lease-requeue-failure")
		now := time.Now().UnixMilli()
		if _, claimed, err := f.claim(t, "previous-process", now); err != nil || !claimed {
			t.Fatalf("lease before recovery claimed=%v error=%v", claimed, err)
		}
		db := f.db.(*sql.DB)
		if _, err := db.ExecContext(t.Context(), `
CREATE TRIGGER fail_edit_retry_startup_requeue
BEFORE UPDATE OF status ON workspace_agent_runtime_operations
WHEN OLD.operation_id = 'lease-requeue-failure' AND OLD.status = 'leased' AND NEW.status = 'prepared'
BEGIN SELECT RAISE(ABORT, 'injected edit retry startup requeue failure'); END;
`); err != nil {
			t.Fatal(err)
		}
		operations := &startupRequeueFaultStore{RuntimeOperationStore: f.store}
		retryHost := agenthost.New(agenthost.Config{
			CanonicalStore: sqliteCanonicalStore{Store: f.store}, TurnSubmissions: f.store,
			EffectiveHistory: f.store, RuntimeOperations: operations, Runtime: f.runtime,
			HistoryRuntime: f.runtime, GoalRuntime: f.runtime, OperationOwner: "post-listener-requeue",
			EditRetryRecovery: agenthost.EditRetryRecoveryReconcileOnly,
		})
		if err := retryHost.RecoverCore(t.Context()); err != nil {
			t.Fatalf("RecoverCore()=%v, want listener-safe deferred repair", err)
		}
		if summary := retryHost.RuntimeOperationWorkerSummary(); summary.StoreFailures == 0 {
			t.Fatalf("startup requeue summary=%#v, want scoped store degradation", summary)
		}
		leased := f.operation(t)
		if leased.Status != storesqlite.RuntimeOperationStatusLeased || leased.LeaseOwner != "previous-process" {
			t.Fatalf("failed requeue operation=%#v", leased)
		}
		assertFaultHarnessFence(t, f.store)
		f.assertNoProviderMutation(t)
		if _, err := db.ExecContext(t.Context(), `DROP TRIGGER fail_edit_retry_startup_requeue`); err != nil {
			t.Fatal(err)
		}
		// Retry the deferred local repair through the post-listener worker lane.
		if err := retryHost.StepRuntimeOperationWorker(t.Context(), false); err != nil {
			t.Fatalf("post-listener requeue retry=%v", err)
		}
		f.assertNoProviderMutation(t)
		requeued := f.operation(t)
		if requeued.Status != storesqlite.RuntimeOperationStatusPrepared || requeued.LeaseOwner != "" {
			t.Fatalf("post-listener requeue operation=%#v, want fenced prepared operation", requeued)
		}
		operations.mu.Lock()
		requeueCalls := operations.calls
		operations.mu.Unlock()
		if requeueCalls != 2 {
			t.Fatalf("startup requeue calls=%d, want initial defer plus post-listener retry", requeueCalls)
		}
		f.reopenTwice(t)
		requeued = f.operation(t)
		if requeued.Status != storesqlite.RuntimeOperationStatusPrepared || requeued.LeaseOwner != "" {
			t.Fatalf("recovered deferred operation=%#v", requeued)
		}
		// The production-disabled disposition is provider-free; it lets the
		// same test prove session B remains processable after the later reopen.
		disabled := newBatchRuntimeOperationHost(f.store, f.runtime, f.store, &recordingRuntimeOperationPublisher{}, true)
		if err := disabled.StepRuntimeOperationWorker(t.Context(), true); err != nil {
			t.Fatal(err)
		}
		assertBatchOperationStatus(t, f.store, f.healthyID, storesqlite.RuntimeOperationStatusCompleted)
		f.assertNoProviderMutation(t)
	})

	t.Run("dispatched checkpoints requeue to reconciliation only", func(t *testing.T) {
		for _, checkpoint := range []storesqlite.EditRetryCheckpoint{
			storesqlite.EditRetryCheckpointRollbackDispatched,
			storesqlite.EditRetryCheckpointReplacementDispatched,
		} {
			t.Run(string(checkpoint), func(t *testing.T) {
				f := newLeaseDispatchedFixture(t, checkpoint)
				f.step(t) // A is leased; session B still completes.
				f.reopenTwice(t)
				if err := f.host.StepRuntimeOperationWorker(t.Context(), true); err != nil {
					t.Fatalf("reconcile worker=%v", err)
				}
				f.assertProviderWasReadForReconcile(t)
				f.assertNoProviderMutation(t)
				assertBatchOperationStatus(t, f.store, f.healthyID, storesqlite.RuntimeOperationStatusCompleted)
			})
		}
	})

	t.Run("two Hosts have one lease owner", func(t *testing.T) {
		f := newLeaseFaultFixture(t, "lease-concurrent")
		// First run B while A is durably leased, then make A due for the two
		// independently constructed Hosts to contend through the real Store CAS.
		now := time.Now().UnixMilli()
		if _, claimed, err := f.claim(t, "setup", now); err != nil || !claimed {
			t.Fatalf("setup claim=%v error=%v", claimed, err)
		}
		f.step(t)
		if _, changed, err := f.store.ReleaseOrFailRuntimeOperation(t.Context(), storesqlite.ReleaseOrFailRuntimeOperationInput{
			WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: f.operationID, LeaseOwner: "setup", NowUnixMS: now + 1, NextAttemptAtMS: now + 1,
		}); err != nil || !changed {
			t.Fatalf("release=%v error=%v", changed, err)
		}
		stores := []*recordingClaimStore{
			{RuntimeOperationStore: f.store}, {RuntimeOperationStore: f.store},
		}
		hosts := []*agenthost.Host{
			newBatchRuntimeOperationHost(f.store, f.runtime, stores[0], &recordingRuntimeOperationPublisher{}, true),
			newBatchRuntimeOperationHost(f.store, f.runtime, stores[1], &recordingRuntimeOperationPublisher{}, true),
		}
		start := make(chan struct{})
		var group sync.WaitGroup
		for _, host := range hosts {
			group.Add(1)
			go func(host *agenthost.Host) {
				defer group.Done()
				<-start
				if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
					t.Errorf("concurrent worker=%v", err)
				}
			}(host)
		}
		close(start)
		group.Wait()
		wins := 0
		owners := map[string]struct{}{}
		for _, store := range stores {
			for _, result := range store.resultsSnapshot() {
				if result.operationID == f.operationID && result.claimed {
					wins++
					owners[result.owner] = struct{}{}
				}
			}
		}
		if wins != 1 || len(owners) != 1 {
			t.Fatalf("lease winners=%d owners=%#v", wins, owners)
		}
		f.assertNoProviderMutation(t)
		f.reopenTwice(t)
	})
}

type leaseFaultFixture struct {
	*rollbackFaultFixture
	operationID       string
	replacementLedger *replacementMutationLedger
}

func newLeaseFaultFixture(t *testing.T, operationID string) *leaseFaultFixture {
	t.Helper()
	f := newRollbackFaultFixture(t)
	f.prepare(t, operationID)
	return &leaseFaultFixture{rollbackFaultFixture: f, operationID: operationID}
}

func newLeaseDispatchedFixture(t *testing.T, checkpoint storesqlite.EditRetryCheckpoint) *leaseFaultFixture {
	t.Helper()
	if checkpoint == storesqlite.EditRetryCheckpointReplacementDispatched {
		f := newReplacementFaultFixture(t)
		f.host = newRollbackFaultHost(f.store, f.runtime, f.store, &postCommitCheckpointRuntimeOperationStore{RuntimeOperationStore: f.store})
		f.step(t)
		assertFaultHarnessCheckpoint(t, f.store, f.operationID, checkpoint, false)
		op, found, err := f.store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, f.operationID)
		if err != nil || !found {
			t.Fatalf("replacement dispatched operation found=%v error=%v", found, err)
		}
		if op.Status != storesqlite.RuntimeOperationStatusLeased {
			t.Fatalf("replacement dispatched lease=%#v", op)
		}
		return &leaseFaultFixture{rollbackFaultFixture: f.rollbackFaultFixture, operationID: f.operationID, replacementLedger: f.ledger}
	}
	f := newLeaseFaultFixture(t, "lease-rollback-dispatched")
	now := time.Now().UnixMilli()
	op, claimed, err := f.claim(t, "seed", now)
	if err != nil || !claimed {
		t.Fatalf("seed claim=%v error=%v", claimed, err)
	}
	op = captureEditRetrySnapshotForHarness(t, f.store, f.operationID, "seed", now)
	payload, err := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
	if err != nil {
		t.Fatal(err)
	}
	payload.Checkpoint, payload.BeforeProviderIDs, payload.ProviderSessionID = checkpoint, []string{"provider-original"}, "thread-1"
	if _, changed, err := f.store.MarkEditRetryRollbackDispatched(t.Context(), storesqlite.MarkEditRetryRollbackDispatchedInput{
		WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: f.operationID, LeaseOwner: "seed", Payload: payload, NowUnixMS: now,
	}); err != nil || !changed {
		t.Fatalf("mark dispatched=%v error=%v", changed, err)
	}
	return f
}

func (f *leaseFaultFixture) operation(t *testing.T) storesqlite.RuntimeOperation {
	t.Helper()
	op, found, err := f.store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, f.operationID)
	if err != nil || !found {
		t.Fatalf("operation found=%v error=%v", found, err)
	}
	return op
}

func (f *leaseFaultFixture) claimInput(owner string, now int64) storesqlite.ClaimRuntimeOperationLeaseInput {
	return storesqlite.ClaimRuntimeOperationLeaseInput{
		WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: f.operationID, LeaseOwner: owner,
		NowUnixMS: now, LeaseExpiresAtMS: now + 100,
	}
}

func (f *leaseFaultFixture) claim(t *testing.T, owner string, now int64) (storesqlite.RuntimeOperation, bool, error) {
	t.Helper()
	return f.store.ClaimRuntimeOperationLease(t.Context(), f.claimInput(owner, now))
}

func (f *leaseFaultFixture) assertNoProviderMutation(t *testing.T) {
	t.Helper()
	f.runtime.mu.Lock()
	defer f.runtime.mu.Unlock()
	if f.runtime.rollbackCalls != 0 || f.runtime.execCalls != 0 {
		t.Fatalf("provider mutation rollback=%d replacement=%d", f.runtime.rollbackCalls, f.runtime.execCalls)
	}
	if f.ledger != nil {
		f.ledger.Assert(t, 0)
	}
	if f.replacementLedger != nil {
		f.replacementLedger.Assert(t, 0)
	}
}

func (f *leaseFaultFixture) assertProviderWasReadForReconcile(t *testing.T) {
	t.Helper()
	f.runtime.mu.Lock()
	defer f.runtime.mu.Unlock()
	if f.runtime.historyReads == 0 {
		t.Fatal("recovery did not perform an authoritative provider read")
	}
}

func assertLeaseUnchanged(t *testing.T, before, after storesqlite.RuntimeOperation) {
	t.Helper()
	if before.Status != after.Status || before.LeaseOwner != after.LeaseOwner || before.LeaseExpiresAtMS != after.LeaseExpiresAtMS || before.Version != after.Version || before.Attempt != after.Attempt {
		t.Fatalf("lease changed before=%#v after=%#v", before, after)
	}
}

type postCommitClaimStore struct {
	agenthost.RuntimeOperationStore
	mu    sync.Mutex
	fired bool
}

type startupRequeueFaultStore struct {
	agenthost.RuntimeOperationStore
	mu    sync.Mutex
	calls int
}

func (s *startupRequeueFaultStore) RequeueLeasedRuntimeOperationsOnStartup(ctx context.Context, now int64) (int64, error) {
	s.mu.Lock()
	s.calls++
	s.mu.Unlock()
	return s.RuntimeOperationStore.RequeueLeasedRuntimeOperationsOnStartup(ctx, now)
}

func (s *postCommitClaimStore) ClaimRuntimeOperationLease(ctx context.Context, input storesqlite.ClaimRuntimeOperationLeaseInput) (storesqlite.RuntimeOperation, bool, error) {
	op, claimed, err := s.RuntimeOperationStore.ClaimRuntimeOperationLease(ctx, input)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err == nil && claimed && !s.fired {
		s.fired = true
		return op, claimed, errInjectedPostCommit
	}
	return op, claimed, err
}

type leaseClaimResult struct {
	operationID string
	owner       string
	claimed     bool
}

type recordingClaimStore struct {
	agenthost.RuntimeOperationStore
	mu      sync.Mutex
	results []leaseClaimResult
}

func (s *recordingClaimStore) ClaimRuntimeOperationLease(ctx context.Context, input storesqlite.ClaimRuntimeOperationLeaseInput) (storesqlite.RuntimeOperation, bool, error) {
	op, claimed, err := s.RuntimeOperationStore.ClaimRuntimeOperationLease(ctx, input)
	s.mu.Lock()
	s.results = append(s.results, leaseClaimResult{operationID: input.OperationID, owner: input.LeaseOwner, claimed: claimed})
	s.mu.Unlock()
	return op, claimed, err
}

func (s *recordingClaimStore) resultsSnapshot() []leaseClaimResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]leaseClaimResult(nil), s.results...)
}
