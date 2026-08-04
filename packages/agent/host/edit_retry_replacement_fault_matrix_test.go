package agenthost_test

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// TestEditRetryReplacementFaultMatrixFirstSix binds the first six replacement
// rows to a real SQLite DB. Each row starts after a durable rollback-confirmed
// transition and carries a healthy same-database cancel operation.
func TestEditRetryReplacementFaultMatrixFirstSix(t *testing.T) {
	for _, test := range []struct {
		name string
		run  func(*testing.T, *replacementFaultFixture)
	}{
		{"intent before commit has zero replacement effect", replacementIntentBeforeCommit},
		{"intent after commit before provider call reconciles only", replacementIntentAfterCommit},
		{"provider not dispatched projects retry only", replacementNotDispatchedProjection},
		{"absence proof before commit stays unconsumed", replacementProofBeforeCommit},
		{"absence proof after commit caller loss is idempotent", replacementProofAfterCommit},
		{"concurrent retry replacement has one winner", replacementProofConcurrent},
	} {
		t.Run(test.name, func(t *testing.T) { test.run(t, newReplacementFaultFixture(t)) })
	}
}

func TestEditRetryReplacementFaultMatrixProviderFinality(t *testing.T) {
	t.Run("authorized applied replacement completes once", func(t *testing.T) {
		replacementAppliedCompletes(t, newReplacementFaultFixture(t))
	})
	t.Run("authorized unknown replacement reconciles only", func(t *testing.T) {
		replacementUnknownReconcilesOnly(t, newReplacementFaultFixture(t))
	})
}

func TestEditRetryReplacementFaultMatrixCompletionBeforeCommit(t *testing.T) {
	replacementResultBeforeCommit(t, newReplacementFaultFixture(t))
}

func TestEditRetryReplacementFaultMatrixCompletionLockedAfterProviderEffect(t *testing.T) {
	f := newReplacementFaultFixture(t)
	replacementNotDispatchedProjection(t, f)
	var lockDB *sql.DB
	locked := false
	f.runtime.mu.Lock()
	f.runtime.afterExec = func() error {
		var err error
		lockDB, err = sql.Open("sqlite", f.dbPath)
		if err != nil {
			return err
		}
		_, err = lockDB.Exec("BEGIN IMMEDIATE")
		locked = err == nil
		return err
	}
	f.runtime.mu.Unlock()
	if _, _, err := replacementAuthorize(t, f, "completion-lock"); err == nil {
		t.Fatal("completion under write lock unexpectedly succeeded")
	}
	if !locked {
		t.Fatal("post-Exec SQLite lock was not acquired")
	}
	assertFaultHarnessCheckpoint(t, f.store, f.operationID, storesqlite.EditRetryCheckpointReplacementDispatched, false)
	assertFaultHarnessFence(t, f.store)
	f.ledger.Assert(t, 1)
	availability, err := f.host.GetEditRetryAvailability(t.Context(), editRetryRestartRef)
	if err != nil || containsRecoveryAction(availability.AvailableActions, agenthost.EditRetryRecoveryActionRetryReplacement) || containsRecoveryAction(availability.AvailableActions, agenthost.EditRetryRecoveryActionAbandon) {
		t.Fatalf("availability=%#v err=%v", availability, err)
	}
	_, _ = lockDB.Exec("ROLLBACK")
	_ = lockDB.Close()
	lockDB = nil
	f.reopenTwice(t)
	if err := f.host.StepRuntimeOperationWorker(t.Context(), true); err != nil {
		t.Fatal(err)
	}
	f.ledger.Assert(t, 1)
}

func TestEditRetryReplacementFaultMatrixCompletionAfterCommit(t *testing.T) {
	replacementCompletionAfterCommit(t, newReplacementFaultFixture(t))
}

func TestEditRetryReplacementFaultMatrixProofGeneration(t *testing.T) {
	replacementNewProofRejectsOld(t, newReplacementFaultFixture(t))
}

type replacementFaultFixture struct {
	*rollbackFaultFixture
	operationID string
	ledger      *replacementMutationLedger
}

func newReplacementFaultFixture(t *testing.T) *replacementFaultFixture {
	t.Helper()
	base := newRollbackFaultFixture(t)
	ledger := &replacementMutationLedger{path: filepath.Join(filepath.Dir(base.dbPath), "replacement-ledger")}
	base.runtime.replacementLedger = ledger
	id := "replacement-fault"
	prepareFaultHarnessOperation(t, base.store, id)
	now := time.Now().UnixMilli()
	op, claimed, err := base.store.ClaimRuntimeOperationLease(t.Context(), storesqlite.ClaimRuntimeOperationLeaseInput{WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: id, LeaseOwner: "seed", NowUnixMS: now, LeaseExpiresAtMS: now + 60_000})
	if err != nil || !claimed {
		t.Fatalf("claim=%v err=%v", claimed, err)
	}
	op = captureEditRetrySnapshotForHarness(t, base.store, id, "seed", now)
	payload, _ := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
	payload.Checkpoint, payload.BeforeProviderIDs, payload.ProviderSessionID = storesqlite.EditRetryCheckpointRollbackDispatched, []string{"provider-original"}, "thread-1"
	op, _, err = base.store.MarkEditRetryRollbackDispatched(t.Context(), storesqlite.MarkEditRetryRollbackDispatchedInput{WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: id, LeaseOwner: "seed", Payload: payload, NowUnixMS: now})
	if err != nil {
		t.Fatal(err)
	}
	payload.Checkpoint = storesqlite.EditRetryCheckpointRollbackConfirmed
	op, _, err = base.store.ConfirmEditRetryRollback(t.Context(), storesqlite.ConfirmEditRetryRollbackInput{WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: id, LeaseOwner: "seed", Payload: payload, ProviderTurnIDs: nil, NowUnixMS: now + 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = base.store.ReleaseOrFailRuntimeOperation(t.Context(), storesqlite.ReleaseOrFailRuntimeOperationInput{WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: id, LeaseOwner: "seed", NowUnixMS: now + 2, NextAttemptAtMS: now + 2}); err != nil {
		t.Fatal(err)
	}
	return &replacementFaultFixture{rollbackFaultFixture: base, operationID: id, ledger: ledger}
}

func (f *replacementFaultFixture) assertNoEffect(t *testing.T) {
	t.Helper()
	b, err := os.ReadFile(f.ledger.path)
	if err == nil && len(b) != 0 {
		t.Fatalf("replacement ledger=%q", b)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
}

func replacementIntentBeforeCommit(t *testing.T, f *replacementFaultFixture) {
	f.host = newRollbackFaultHost(f.store, f.runtime, f.store, &failCheckpointRuntimeOperationStore{RuntimeOperationStore: f.store})
	f.step(t)
	f.assertNoEffect(t)
	assertFaultHarnessCheckpoint(t, f.store, f.operationID, storesqlite.EditRetryCheckpointRollbackConfirmed, false)
	f.reopenTwice(t)
	f.assertNoEffect(t)
}
func replacementIntentAfterCommit(t *testing.T, f *replacementFaultFixture) {
	f.host = newRollbackFaultHost(f.store, f.runtime, f.store, &postCommitCheckpointRuntimeOperationStore{RuntimeOperationStore: f.store})
	f.step(t)
	f.assertNoEffect(t)
	assertFaultHarnessCheckpoint(t, f.store, f.operationID, storesqlite.EditRetryCheckpointReplacementDispatched, false)
	f.reopenTwice(t)
	f.assertNoEffect(t)
}
func replacementNotDispatchedProjection(t *testing.T, f *replacementFaultFixture) {
	f.runtime.execNotDispatchedBeforeTurn = true
	f.step(t)
	f.assertNoEffect(t)
	a, err := f.host.GetEditRetryAvailability(t.Context(), editRetryRestartRef)
	if err != nil {
		t.Fatal(err)
	}
	if !containsRecoveryAction(a.AvailableActions, agenthost.EditRetryRecoveryActionRetryReplacement) {
		t.Fatalf("availability=%#v", a)
	}
	f.reopenTwice(t)
	f.assertNoEffect(t)
}
func replacementProofBeforeCommit(t *testing.T, f *replacementFaultFixture) {
	replacementNotDispatchedProjection(t, f)
	f.resetProviderAbsenceProof()
	op, history := replacementCommandState(t, f)
	participant := &armedRollbackCommitParticipant{operation: "retry_replacement", armed: true}
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	f.host, f.store, f.db = openEditRetryRestartFixtureWithOptions(t, f.dbPath, f.runtime, false, storesqlite.Options{TransactionParticipant: participant})
	_, err := f.host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionRetryReplacement, ClientActionID: "proof-before", ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: uint64(history.Revision)})
	if err == nil {
		t.Fatal("RecoverEditRetryCommand() error=nil, want transaction failure")
	}
	after, afterHistory := replacementCommandState(t, f)
	if after.Version != op.Version || afterHistory.Revision != history.Revision {
		t.Fatalf("before=%d/%d after=%d/%d", op.Version, history.Revision, after.Version, afterHistory.Revision)
	}
	if _, found, err := f.store.GetRuntimeOperationRecoveryAction(t.Context(), editRetryRestartRef.WorkspaceID, f.operationID, "proof-before"); err != nil || found {
		t.Fatalf("action found=%v err=%v", found, err)
	}
	f.assertNoEffect(t)
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	f.host, f.store, f.db = openEditRetryRestartFixture(t, f.dbPath, f.runtime, false)
	f.runtime.mu.Lock()
	f.runtime.execNotDispatchedBeforeTurn = true
	f.runtime.mu.Unlock()
	if _, err := f.host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionRetryReplacement, ClientActionID: "proof-before", ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: uint64(history.Revision)}); errors.Is(err, storesqlite.ErrRuntimeOperationActionConflict) {
		t.Fatalf("same action retry conflicted: %v", err)
	}
	f.reopenTwice(t)
	f.assertNoEffect(t)
}
func replacementProofAfterCommit(t *testing.T, f *replacementFaultFixture) {
	replacementNotDispatchedProjection(t, f)
	f.resetProviderAbsenceProof()
	op, history := replacementCommandState(t, f)
	f.host = newRollbackFaultHost(f.store, f.runtime, &postCommitEditRetryFaultStore{EffectiveHistoryStore: f.store, point: "absence_proof"}, f.store)
	_, err := f.host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionRetryReplacement, ClientActionID: "proof-after", ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: uint64(history.Revision)})
	if !errors.Is(err, errInjectedPostCommit) {
		t.Fatalf("error=%v", err)
	}
	f.reopenTwice(t)
	if action, found, actionErr := f.store.GetRuntimeOperationRecoveryAction(t.Context(), editRetryRestartRef.WorkspaceID, f.operationID, "proof-after"); actionErr != nil || !found {
		t.Fatalf("durable action found=%v err=%v", found, actionErr)
	} else {
		t.Logf("durable action identity=%q", action.ActionIdentity)
	}
	result, err := f.host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionRetryReplacement, ClientActionID: "proof-after", ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: uint64(history.Revision)})
	if err != nil || result.OperationID != f.operationID {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	if _, err := f.host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionRetryReplacement, ClientActionID: "proof-after", ExpectedOperationVersion: op.Version + 1, ExpectedHistoryRevision: uint64(history.Revision)}); !errors.Is(err, storesqlite.ErrRuntimeOperationActionConflict) {
		t.Fatalf("different identity error=%v", err)
	}
	f.assertNoEffect(t)
}
func replacementProofConcurrent(t *testing.T, f *replacementFaultFixture) {
	replacementNotDispatchedProjection(t, f)
	f.resetProviderAbsenceProof()
	op, history := replacementCommandState(t, f)
	hostA := newRollbackFaultHost(f.store, f.runtime, &postCommitEditRetryFaultStore{EffectiveHistoryStore: f.store, point: "absence_proof"}, f.store)
	hostB := newRollbackFaultHost(f.store, f.runtime, &postCommitEditRetryFaultStore{EffectiveHistoryStore: f.store, point: "absence_proof"}, f.store)
	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i, host := range []*agenthost.Host{hostA, hostB} {
		wg.Add(1)
		go func(host *agenthost.Host, id string) {
			defer wg.Done()
			<-start
			_, err := host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionRetryReplacement, ClientActionID: id, ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: uint64(history.Revision)})
			errs <- err
		}(host, []string{"proof-a", "proof-b"}[i])
	}
	close(start)
	wg.Wait()
	close(errs)
	winners, conflicts := 0, 0
	for err := range errs {
		if errors.Is(err, errInjectedPostCommit) {
			winners++
		} else if errors.Is(err, agenthost.ErrEditRetryHistoryConflict) || errors.Is(err, agenthost.ErrEditRetryNotEligible) || errors.Is(err, storesqlite.ErrRuntimeOperationSubjectState) {
			conflicts++
		} else {
			t.Fatalf("unexpected concurrent error=%v", err)
		}
	}
	if winners != 1 || conflicts != 1 {
		t.Fatalf("winners=%d conflicts=%d", winners, conflicts)
	}
	f.assertNoEffect(t)
	f.reopenTwice(t)
	f.assertNoEffect(t)
}

func replacementAuthorize(t *testing.T, f *replacementFaultFixture, id string) (storesqlite.RuntimeOperation, storesqlite.SessionHistory, error) {
	t.Helper()
	f.resetProviderAbsenceProof()
	op, history := replacementCommandState(t, f)
	_, err := f.host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionRetryReplacement, ClientActionID: id, ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: uint64(history.Revision)})
	return op, history, err
}
func replacementAppliedCompletes(t *testing.T, f *replacementFaultFixture) {
	replacementNotDispatchedProjection(t, f)
	_, _, _ = replacementAuthorize(t, f, "applied")
	assertFaultHarnessCheckpoint(t, f.store, f.operationID, storesqlite.EditRetryCheckpointReplacementDispatched, true)
	assertFaultHarnessTerminal(t, f.store)
	f.ledger.Assert(t, 1)
	f.reopenTwice(t)
	if err := f.host.StepRuntimeOperationWorker(t.Context(), true); err != nil {
		t.Fatal(err)
	}
	f.ledger.Assert(t, 1)
}
func replacementUnknownReconcilesOnly(t *testing.T, f *replacementFaultFixture) {
	replacementNotDispatchedProjection(t, f)
	f.runtime.mu.Lock()
	f.runtime.execOutcomeUnknown = true
	f.runtime.execOutcomeUnknownAccepted = true
	f.runtime.mu.Unlock()
	if _, _, err := replacementAuthorize(t, f, "unknown"); !errors.Is(err, agenthost.ErrEditRetryRecoveryRequired) {
		t.Fatalf("error=%v", err)
	}
	assertFaultHarnessCheckpoint(t, f.store, f.operationID, storesqlite.EditRetryCheckpointReplacementDispatched, false)
	assertFaultHarnessFence(t, f.store)
	f.ledger.Assert(t, 1)
	f.reopenTwice(t)
	f.ledger.Assert(t, 1)
}
func replacementResultBeforeCommit(t *testing.T, f *replacementFaultFixture) {
	replacementNotDispatchedProjection(t, f)
	participant := &armedRollbackCommitParticipant{operation: "complete", armed: true}
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	f.host, f.store, f.db = openEditRetryRestartFixtureWithOptions(t, f.dbPath, f.runtime, false, storesqlite.Options{TransactionParticipant: participant})
	if _, _, err := replacementAuthorize(t, f, "complete-before"); err == nil {
		t.Fatal("completion commit error=nil")
	}
	if !participant.fired {
		t.Fatal("completion transaction participant did not fire")
	}
	assertFaultHarnessCheckpoint(t, f.store, f.operationID, storesqlite.EditRetryCheckpointReplacementDispatched, false)
	assertFaultHarnessFence(t, f.store)
	availability, availabilityErr := f.host.GetEditRetryAvailability(t.Context(), editRetryRestartRef)
	if availabilityErr != nil || containsRecoveryAction(availability.AvailableActions, agenthost.EditRetryRecoveryActionRetryReplacement) || containsRecoveryAction(availability.AvailableActions, agenthost.EditRetryRecoveryActionAbandon) {
		t.Fatalf("availability=%#v error=%v", availability, availabilityErr)
	}
	f.ledger.Assert(t, 1)
	f.reopenTwice(t)
	f.ledger.Assert(t, 1)
}
func replacementCompletionAfterCommit(t *testing.T, f *replacementFaultFixture) {
	replacementNotDispatchedProjection(t, f)
	faults := &postCommitEditRetryFaultStore{EffectiveHistoryStore: f.store, point: "completion"}
	f.host = newRollbackFaultHost(f.store, f.runtime, faults, f.store)
	_, _, _ = replacementAuthorize(t, f, "complete-after")
	if !faults.fired {
		t.Fatal("completion post-commit wrapper did not fire")
	}
	assertFaultHarnessCheckpoint(t, f.store, f.operationID, storesqlite.EditRetryCheckpointReplacementDispatched, true)
	assertFaultHarnessTerminal(t, f.store)
	history, found, historyErr := f.store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID)
	if historyErr != nil || !found || history.RecoveryState != storesqlite.SessionHistoryRecoveryReady || history.OperationID != "" {
		t.Fatalf("history=%#v found=%v err=%v", history, found, historyErr)
	}
	f.ledger.Assert(t, 1)
	f.reopenTwice(t)
	assertFaultHarnessTerminal(t, f.store)
	f.ledger.Assert(t, 1)
}
func replacementNewProofRejectsOld(t *testing.T, f *replacementFaultFixture) {
	replacementNotDispatchedProjection(t, f)
	f.runtime.mu.Lock()
	f.runtime.execNotDispatchedBeforeTurn = true
	f.runtime.mu.Unlock()
	op, history, err := replacementAuthorize(t, f, "first-proof")
	if err != nil && !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatal(err)
	}
	if _, err := f.host.RecoverEditRetryCommand(t.Context(), editRetryRestartRef, f.operationID, agenthost.RecoverEditRetryInput{Action: agenthost.EditRetryRecoveryActionRetryReplacement, ClientActionID: "old-proof", ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: uint64(history.Revision)}); err == nil {
		t.Fatal("old proof/version accepted")
	}
	f.runtime.mu.Lock()
	f.runtime.execNotDispatchedBeforeTurn = true
	f.runtime.mu.Unlock()
	_, _, _ = replacementAuthorize(t, f, "new-proof")
}

func (f *replacementFaultFixture) resetProviderAbsenceProof() {
	f.runtime.mu.Lock()
	f.runtime.providerTurns = []agenthost.RuntimeHistoryTurn{}
	f.runtime.mu.Unlock()
}

func replacementCommandState(t *testing.T, f *replacementFaultFixture) (storesqlite.RuntimeOperation, storesqlite.SessionHistory) {
	t.Helper()
	op, found, err := f.store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, f.operationID)
	if err != nil || !found {
		t.Fatalf("operation found=%v err=%v", found, err)
	}
	history, found, err := f.store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID)
	if err != nil || !found {
		t.Fatalf("history found=%v err=%v", found, err)
	}
	return op, history
}
func containsRecoveryAction(actions []agenthost.EditRetryRecoveryAction, want agenthost.EditRetryRecoveryAction) bool {
	for _, action := range actions {
		if action == want {
			return true
		}
	}
	return false
}
