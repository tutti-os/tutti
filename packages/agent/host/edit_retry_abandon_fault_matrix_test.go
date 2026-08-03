package agenthost_test

import (
	"errors"
	"sync"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// TestEditRetryAbandonOutboxFailurePreservesCanonicalTerminalState binds the
// generic publisher boundary to an actual edit-retry compound event. Provider
// mutation has already been ruled out by Safe Abandon; an outbox failure may
// replay the stable event identity, never the terminal transition.
func TestEditRetryAbandonOutboxFailurePreservesCanonicalTerminalState(t *testing.T) {
	f := newAbandonFaultFixture(t, false)
	op, history := f.state(t)
	if _, err := f.command(t, f.host, "abandon-outbox", op, history); err != nil {
		t.Fatal(err)
	}
	f.assertAbandoned(t)
	pending, err := f.store.ListPendingRuntimeOperationEvents(t.Context(), editRetryRestartRef.WorkspaceID, 10)
	if err != nil || len(pending) == 0 {
		t.Fatalf("pending abandon events=%#v error=%v", pending, err)
	}
	eventID := pending[len(pending)-1].ID
	publisher := &recordingRuntimeOperationPublisher{fail: true}
	clock := &batchClock{at: time.Now()}
	host := newBatchRuntimeOperationHost(f.store, f.runtime, f.store, publisher, true, clock)
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	f.assertAbandoned(t)
	assertBatchOperationStatus(t, f.store, f.healthyID, storesqlite.RuntimeOperationStatusCompleted)
	if summary := host.RuntimeOperationWorkerSummary(); summary.OutboxFailures == 0 {
		t.Fatalf("worker summary=%#v", summary)
	}
	f.assertNoProvider(t)
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	publisher.fail = false
	clock.at = clock.at.Add(2 * time.Second)
	for reopen := 0; reopen < 2; reopen++ {
		_, store, db := openEditRetryRestartFixture(t, f.dbPath, f.runtime, false)
		host = newBatchRuntimeOperationHost(store, f.runtime, store, publisher, true, clock)
		if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
			db.Close()
			t.Fatal(err)
		}
		terminal, found, getErr := store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, f.operationID)
		if getErr != nil || !found || terminal.Status != storesqlite.RuntimeOperationStatusCompleted || terminal.Result != storesqlite.RuntimeOperationResultAbandoned {
			db.Close()
			t.Fatalf("reopen %d terminal=%#v found=%v error=%v", reopen+1, terminal, found, getErr)
		}
		if reopen == 0 {
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
		} else {
			defer db.Close()
		}
	}
	publisher.assertDeliveredExactlyOnce(t, f.operationID)
	publisher.mu.Lock()
	var abandonDeliveries int
	for _, delivered := range publisher.deliveries {
		if delivered.OperationID == f.operationID && delivered.ID == eventID {
			abandonDeliveries++
		}
	}
	publisher.mu.Unlock()
	if abandonDeliveries != 1 {
		t.Fatalf("stable abandon event deliveries=%d, want 1", abandonDeliveries)
	}
}

func TestEditRetryAbandonFaultMatrix(t *testing.T) {
	for _, branch := range []struct {
		name      string
		confirmed bool
	}{{"prepared rollback never dispatched", false}, {"rollback confirmed replacement not dispatched", true}} {
		t.Run(branch.name+" before commit", func(t *testing.T) {
			f := newAbandonFaultFixture(t, branch.confirmed)
			op, h := f.state(t)
			p := &armedRollbackCommitParticipant{operation: "abandon", armed: true}
			_ = f.db.Close()
			f.host, f.store, f.db = openEditRetryRestartFixtureWithOptions(t, f.dbPath, f.runtime, false, storesqlite.Options{TransactionParticipant: p})
			if _, e := f.command(t, f.host, "before", op, h); e == nil {
				t.Fatal("abandon failure=nil")
			}
			if !p.fired {
				t.Fatal("abandon failpoint missed")
			}
			after, ah := f.state(t)
			if after.Status == storesqlite.RuntimeOperationStatusCompleted || ah.RecoveryState == storesqlite.SessionHistoryRecoveryReady {
				t.Fatalf("half abandon op=%#v history=%#v", after, ah)
			}
		})
		t.Run(branch.name+" after commit replay and concurrency", func(t *testing.T) {
			f := newAbandonFaultFixture(t, branch.confirmed)
			op, h := f.state(t)
			fault := &postCommitEditRetryFaultStore{EffectiveHistoryStore: f.store, point: "abandon"}
			f.host = newRollbackFaultHost(f.store, f.runtime, fault, f.store)
			_, _ = f.command(t, f.host, "after", op, h)
			if !fault.fired {
				t.Fatal("abandon post commit missed")
			}
			f.assertAbandoned(t)
			f.reopenTwice(t)
			f.assertAbandoned(t)
			if _, e := f.command(t, f.host, "after", op, h); e != nil {
				t.Fatalf("replay=%v", e)
			}
			if _, e := f.command(t, f.host, "after", storesqlite.RuntimeOperation{Version: op.Version + 1}, h); !errors.Is(e, storesqlite.ErrRuntimeOperationActionConflict) {
				t.Fatalf("identity=%v", e)
			}
			g := newAbandonFaultFixture(t, branch.confirmed)
			cop, ch := g.state(t)
			start := make(chan struct{})
			var wg sync.WaitGroup
			errs := make(chan error, 2)
			for i := 0; i < 2; i++ {
				host := newRollbackFaultHost(g.store, g.runtime, &postCommitEditRetryFaultStore{EffectiveHistoryStore: g.store, point: "abandon"}, g.store)
				wg.Add(1)
				go func(id string) { defer wg.Done(); <-start; _, e := g.command(t, host, id, cop, ch); errs <- e }([]string{"a", "b"}[i])
			}
			close(start)
			wg.Wait()
			close(errs)
			wins := 0
			for e := range errs {
				if errors.Is(e, errInjectedPostCommit) {
					wins++
				}
			}
			if wins != 1 {
				t.Fatalf("winners=%d", wins)
			}
			g.assertNoProvider(t)
		})
	}
}

type abandonFaultFixture struct {
	*rollbackFaultFixture
	operationID string
}

func newAbandonFaultFixture(t *testing.T, confirmed bool) *abandonFaultFixture {
	f := newRollbackFaultFixture(t)
	id := "abandon-fault"
	prepareFaultHarnessOperation(t, f.store, id)
	if !confirmed {
		return &abandonFaultFixture{f, id}
	}
	now := time.Now().UnixMilli()
	_, _, _ = f.store.ClaimRuntimeOperationLease(t.Context(), storesqlite.ClaimRuntimeOperationLeaseInput{WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: id, LeaseOwner: "seed", NowUnixMS: now, LeaseExpiresAtMS: now + 60000})
	op := captureEditRetrySnapshotForHarness(t, f.store, id, "seed", now)
	p, _ := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
	p.Checkpoint = storesqlite.EditRetryCheckpointRollbackDispatched
	p.BeforeProviderIDs = []string{"provider-original"}
	op, _, _ = f.store.MarkEditRetryRollbackDispatched(t.Context(), storesqlite.MarkEditRetryRollbackDispatchedInput{WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: id, LeaseOwner: "seed", Payload: p, NowUnixMS: now})
	p.Checkpoint = storesqlite.EditRetryCheckpointRollbackConfirmed
	_, _, _ = f.store.ConfirmEditRetryRollback(t.Context(), storesqlite.ConfirmEditRetryRollbackInput{WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: id, LeaseOwner: "seed", Payload: p, ProviderTurnIDs: nil, NowUnixMS: now + 1})
	_, _, _ = f.store.ReleaseOrFailRuntimeOperation(t.Context(), storesqlite.ReleaseOrFailRuntimeOperationInput{WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: id, LeaseOwner: "seed", NowUnixMS: now + 2, NextAttemptAtMS: now + 2})
	return &abandonFaultFixture{f, id}
}
func (f *abandonFaultFixture) state(t *testing.T) (storesqlite.RuntimeOperation, storesqlite.SessionHistory) {
	op, _, _ := f.store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, f.operationID)
	h, _, _ := f.store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID)
	return op, h
}
func (f *abandonFaultFixture) command(t *testing.T, h *agenthost.Host, id string, op storesqlite.RuntimeOperation, history storesqlite.SessionHistory) (agenthost.EditRetryResult, error) {
	return h.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionAbandon, ClientActionID: id, ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: history.Revision})
}
func (f *abandonFaultFixture) assertAbandoned(t *testing.T) {
	op, h := f.state(t)
	if op.Status != storesqlite.RuntimeOperationStatusCompleted || op.Result != storesqlite.RuntimeOperationResultAbandoned || h.RecoveryState != storesqlite.SessionHistoryRecoveryReady || h.OperationID != "" {
		t.Fatalf("op=%#v history=%#v", op, h)
	}
}
func (f *abandonFaultFixture) assertNoProvider(t *testing.T) {
	f.runtime.mu.Lock()
	defer f.runtime.mu.Unlock()
	if f.runtime.rollbackCalls != 0 || f.runtime.execCalls != 0 || f.runtime.historyReads != 0 {
		t.Fatalf("provider rollback=%d exec=%d reads=%d", f.runtime.rollbackCalls, f.runtime.execCalls, f.runtime.historyReads)
	}
}
