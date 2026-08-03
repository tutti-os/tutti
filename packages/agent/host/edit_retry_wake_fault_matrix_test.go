package agenthost_test

import (
	"errors"
	"sync"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestEditRetryWakeFaultMatrix(t *testing.T) {
	t.Run("before commit rolls back and retries", func(t *testing.T) {
		f := newWakeFaultFixture(t)
		f.step(t)
		op, history := f.state(t)
		participant := &armedRollbackCommitParticipant{operation: "wake", armed: true}
		_ = f.db.Close()
		f.host, f.store, f.db = openEditRetryRestartFixtureWithOptions(t, f.dbPath, f.runtime, false, storesqlite.Options{TransactionParticipant: participant})
		if _, err := f.command(t, "wake-before", op, history); err == nil {
			t.Fatal("wake failure=nil")
		}
		if !participant.fired {
			t.Fatal("wake participant did not fire")
		}
		after, _ := f.state(t)
		if after.Version != op.Version || after.NextAttemptAtMS != op.NextAttemptAtMS {
			t.Fatalf("wake half-committed: %#v", after)
		}
		if _, found, err := f.store.GetRuntimeOperationRecoveryAction(t.Context(), editRetryRestartRef.WorkspaceID, f.operationID, "wake-before"); err != nil || found {
			t.Fatalf("ledger found=%v err=%v", found, err)
		}
		_ = f.db.Close()
		f.host, f.store, f.db = openEditRetryRestartFixture(t, f.dbPath, f.runtime, false)
		f.host = newRollbackFaultHost(f.store, f.runtime, &postCommitEditRetryFaultStore{EffectiveHistoryStore: f.store, point: "wake"}, f.store)
		if _, err := f.command(t, "wake-before", op, history); !errors.Is(err, errInjectedPostCommit) {
			t.Fatalf("retry=%v", err)
		}
		f.reopenTwice(t)
		f.assertWakeDurable(t, "wake-before", op.Version)
	})
	t.Run("post commit replay and concurrent CAS", func(t *testing.T) {
		f := newWakeFaultFixture(t)
		f.step(t)
		op, history := f.state(t)
		faults := &postCommitEditRetryFaultStore{EffectiveHistoryStore: f.store, point: "wake"}
		f.host = newRollbackFaultHost(f.store, f.runtime, faults, f.store)
		if _, err := f.command(t, "wake-after", op, history); !errors.Is(err, errInjectedPostCommit) || !faults.fired {
			t.Fatalf("wake=%v fired=%v", err, faults.fired)
		}
		f.reopenTwice(t)
		f.assertWakeDurable(t, "wake-after", op.Version)
		if _, err := f.command(t, "wake-after", op, history); err != nil {
			t.Fatalf("replay=%v", err)
		}
		if _, err := f.command(t, "wake-after", op, storesqlite.SessionHistory{Revision: history.Revision + 1}); !errors.Is(err, storesqlite.ErrRuntimeOperationActionConflict) {
			t.Fatalf("identity=%v", err)
		}
		// New fixture: two independent Hosts contend on the same CAS; wrappers
		// stop both before provider work and leave one durable action ledger row.
		g := newWakeFaultFixture(t)
		g.step(t)
		cop, ch := g.state(t)
		start := make(chan struct{})
		var wg sync.WaitGroup
		errs := make(chan error, 2)
		for i := 0; i < 2; i++ {
			h := newRollbackFaultHost(g.store, g.runtime, &postCommitEditRetryFaultStore{EffectiveHistoryStore: g.store, point: "wake"}, g.store)
			wg.Add(1)
			go func(id string) { defer wg.Done(); <-start; _, e := g.commandWith(t, h, id, cop, ch); errs <- e }([]string{"wake-a", "wake-b"}[i])
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
			t.Fatalf("wake winners=%d", wins)
		}
		g.assertNoProviderMutation(t)
	})
}

type wakeFaultFixture struct {
	*rollbackFaultFixture
	operationID string
}

func newWakeFaultFixture(t *testing.T) *wakeFaultFixture {
	f := newRollbackFaultFixture(t)
	id := "wake-fault"
	prepareFaultHarnessOperation(t, f.store, id)
	now := time.Now().UnixMilli()
	_, _, _ = f.store.ClaimRuntimeOperationLease(t.Context(), storesqlite.ClaimRuntimeOperationLeaseInput{WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: id, LeaseOwner: "seed", NowUnixMS: now, LeaseExpiresAtMS: now + 60000})
	op := captureEditRetrySnapshotForHarness(t, f.store, id, "seed", now)
	p, _ := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
	p.Checkpoint = storesqlite.EditRetryCheckpointRollbackDispatched
	p.BeforeProviderIDs = []string{"provider-original"}
	_, _, _ = f.store.MarkEditRetryRollbackDispatched(t.Context(), storesqlite.MarkEditRetryRollbackDispatchedInput{WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: id, LeaseOwner: "seed", Payload: p, NowUnixMS: now})
	_, _, _ = f.store.ReleaseOrFailRuntimeOperation(t.Context(), storesqlite.ReleaseOrFailRuntimeOperationInput{WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: id, LeaseOwner: "seed", NowUnixMS: now + 1, NextAttemptAtMS: now + 600000})
	return &wakeFaultFixture{f, id}
}
func (f *wakeFaultFixture) state(t *testing.T) (storesqlite.RuntimeOperation, storesqlite.SessionHistory) {
	op, _, _ := f.store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, f.operationID)
	h, _, _ := f.store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID)
	return op, h
}
func (f *wakeFaultFixture) command(t *testing.T, id string, op storesqlite.RuntimeOperation, h storesqlite.SessionHistory) (agenthost.EditRetryResult, error) {
	return f.commandWith(t, f.host, id, op, h)
}
func (f *wakeFaultFixture) commandWith(t *testing.T, host *agenthost.Host, id string, op storesqlite.RuntimeOperation, h storesqlite.SessionHistory) (agenthost.EditRetryResult, error) {
	return host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionReconcile, ClientActionID: id, ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: h.Revision})
}
func (f *wakeFaultFixture) assertWakeDurable(t *testing.T, id string, old int64) {
	op, _ := f.state(t)
	if op.Version <= old || op.NextAttemptAtMS > time.Now().UnixMilli() {
		t.Fatalf("wake=%#v", op)
	}
	if _, found, err := f.store.GetRuntimeOperationRecoveryAction(t.Context(), editRetryRestartRef.WorkspaceID, f.operationID, id); err != nil || !found {
		t.Fatalf("ledger found=%v err=%v", found, err)
	}
}
func (f *wakeFaultFixture) assertNoProviderMutation(t *testing.T) {
	f.runtime.mu.Lock()
	defer f.runtime.mu.Unlock()
	if f.runtime.rollbackCalls != 0 || f.runtime.execCalls != 0 {
		t.Fatalf("provider rollback=%d exec=%d", f.runtime.rollbackCalls, f.runtime.execCalls)
	}
}
