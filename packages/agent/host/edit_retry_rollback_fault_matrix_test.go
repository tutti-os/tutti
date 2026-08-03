package agenthost_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// TestEditRetryRollbackFaultMatrix is the executable rollback half of the
// Stage 6 matrix. Every row starts from a real SQLite file, includes a healthy
// same-DB operation, and discards the Host before two cold reopen checks.
func TestEditRetryRollbackFaultMatrix(t *testing.T) {
	for _, test := range []struct {
		name string
		run  func(*testing.T, *rollbackFaultFixture)
	}{
		{"intent before commit has no effect", rollbackIntentBeforeCommit},
		{"intent after commit before provider call reconciles only", rollbackIntentAfterCommit},
		{"provider not dispatched aborts terminally", rollbackNotDispatched},
		{"provider applied confirms rollback once", rollbackApplied},
		{"provider response lost retains reconcile fence", rollbackUnknown},
		{"provider effect before result commit stays dispatched", rollbackEffectBeforeResultCommit},
		{"rollback result before commit failure stays dispatched", rollbackResultBeforeCommit},
		{"rollback result after commit caller loss stays confirmed", rollbackResultAfterCommit},
		{"rollback aborted terminal before and after commit", rollbackAbortBoundaries},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newRollbackFaultFixture(t)
			test.run(t, fixture)
			if fixture.operationID != "" {
				assertRollbackFaultProjection(t, fixture)
			}
		})
	}
}

type rollbackFaultFixture struct {
	dbPath      string
	host        *agenthost.Host
	store       *storesqlite.Store
	db          interface{ Close() error }
	runtime     *hostEditRetryRuntime
	ledger      *rollbackMutationLedger
	healthyID   string
	operationID string
}

func newRollbackFaultFixture(t *testing.T) *rollbackFaultFixture {
	t.Helper()
	path := filepath.Join(t.TempDir(), "rollback-fault.db")
	runtime := &hostEditRetryRuntime{}
	host, store, db := openEditRetryRestartFixture(t, path, runtime, true)
	ledger := newRollbackMutationLedger(t, filepath.Join(filepath.Dir(path), "provider-ledger"))
	runtime.rollbackLedger = ledger
	seedBatchRunningSession(t, store, "session-b", "turn-b")
	healthy := prepareBatchCancel(t, store, "operation-b-healthy", "session-b", "turn-b", 10)
	return &rollbackFaultFixture{dbPath: path, host: host, store: store, db: db, runtime: runtime, ledger: ledger, healthyID: healthy.OperationID}
}

func (f *rollbackFaultFixture) prepare(t *testing.T, id string) string {
	f.operationID = id
	return prepareFaultHarnessOperation(t, f.store, id)
}
func (f *rollbackFaultFixture) step(t *testing.T) {
	if err := f.host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	assertBatchOperationStatus(t, f.store, f.healthyID, storesqlite.RuntimeOperationStatusCompleted)
}
func (f *rollbackFaultFixture) reopenTwice(t *testing.T) {
	t.Helper()
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		host, store, db := openEditRetryRestartFixture(t, f.dbPath, f.runtime, false)
		f.host, f.store, f.db = host, store, db
		if err := host.RecoverCore(t.Context()); err != nil {
			t.Fatalf("reopen %d: %v", i+1, err)
		}
		if i == 0 {
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func (f *rollbackFaultFixture) reconcileAfterReopen(t *testing.T) {
	t.Helper()
	if err := f.host.StepRuntimeOperationWorker(t.Context(), true); err != nil {
		t.Fatal(err)
	}
	assertBatchOperationStatus(t, f.store, f.healthyID, storesqlite.RuntimeOperationStatusCompleted)
}

func assertRollbackFaultProjection(t *testing.T, f *rollbackFaultFixture) {
	t.Helper()
	op, found, err := f.store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, f.operationID)
	if err != nil || !found || op.Version < 1 {
		t.Fatalf("operation=%#v found=%v error=%v, want durable version", op, found, err)
	}
	history, found, err := f.store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID)
	if err != nil || !found {
		t.Fatalf("history=%#v found=%v error=%v", history, found, err)
	}
	availability, err := f.host.GetEditRetryAvailability(t.Context(), editRetryRestartRef)
	if err != nil {
		t.Fatalf("GetEditRetryAvailability()=%v", err)
	}
	if history.OperationID != "" && (availability.OperationID != history.OperationID || availability.OperationVersion != op.Version || len(availability.AvailableActions) == 0) {
		t.Fatalf("availability=%#v operation=%#v history=%#v", availability, op, history)
	}
	assertBatchOperationStatus(t, f.store, f.healthyID, storesqlite.RuntimeOperationStatusCompleted)
}

func rollbackIntentBeforeCommit(t *testing.T, f *rollbackFaultFixture) {
	participant := &armedRollbackCommitParticipant{operation: "checkpoint", armed: true}
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	f.host, f.store, f.db = openEditRetryRestartFixtureWithOptions(t, f.dbPath, f.runtime, false, storesqlite.Options{TransactionParticipant: participant})
	f.prepare(t, "rollback-before-commit")
	f.step(t)
	assertFaultHarnessCheckpoint(t, f.store, "rollback-before-commit", storesqlite.EditRetryCheckpointPrepared, false)
	assertFaultHarnessFence(t, f.store)
	f.ledger.Assert(t, 0)
	f.reopenTwice(t)
	f.ledger.Assert(t, 0)
}

func rollbackIntentAfterCommit(t *testing.T, f *rollbackFaultFixture) {
	f.prepare(t, "rollback-after-commit")
	f.host = newEditRetryFaultHarnessHost(f.store, f.runtime, &postCommitEditRetryFaultStore{EffectiveHistoryStore: f.store, point: "rollback_intent"})
	f.step(t)
	assertFaultHarnessCheckpoint(t, f.store, "rollback-after-commit", storesqlite.EditRetryCheckpointRollbackDispatched, false)
	assertFaultHarnessFence(t, f.store)
	f.ledger.Assert(t, 0)
	f.reopenTwice(t)
	f.reconcileAfterReopen(t)
	assertFaultHarnessCheckpoint(t, f.store, "rollback-after-commit", storesqlite.EditRetryCheckpointRollbackDispatched, false)
	f.ledger.Assert(t, 0)
}

func rollbackNotDispatched(t *testing.T, f *rollbackFaultFixture) {
	f.prepare(t, "rollback-not-dispatched")
	f.runtime.rollbackNotDispatched = true
	f.step(t)
	assertFaultHarnessCheckpoint(t, f.store, "rollback-not-dispatched", storesqlite.EditRetryCheckpointRollbackAborted, false)
	assertBatchHistoryReady(t, f.store, editRetryRestartRef.AgentSessionID)
	assertFaultHarnessTerminal(t, f.store)
	f.ledger.Assert(t, 0)
	f.reopenTwice(t)
	f.ledger.Assert(t, 0)
}

func rollbackApplied(t *testing.T, f *rollbackFaultFixture) {
	f.prepare(t, "rollback-applied")
	f.host = newRollbackFaultHost(f.store, f.runtime, f.store, &failCheckpointRuntimeOperationStore{RuntimeOperationStore: f.store})
	f.step(t)
	assertFaultHarnessCheckpoint(t, f.store, "rollback-applied", storesqlite.EditRetryCheckpointRollbackConfirmed, false)
	assertFaultHarnessFence(t, f.store)
	f.ledger.Assert(t, 1)
	f.reopenTwice(t)
	f.reconcileAfterReopen(t)
	f.ledger.Assert(t, 1)
}

func rollbackUnknown(t *testing.T, f *rollbackFaultFixture) {
	f.prepare(t, "rollback-unknown")
	f.runtime.rollbackUnknown = true
	f.step(t)
	assertFaultHarnessCheckpoint(t, f.store, "rollback-unknown", storesqlite.EditRetryCheckpointRollbackDispatched, false)
	assertFaultHarnessFence(t, f.store)
	f.ledger.Assert(t, 0)
	f.reopenTwice(t)
	f.reconcileAfterReopen(t)
	f.ledger.Assert(t, 0)
}

func rollbackEffectBeforeResultCommit(t *testing.T, f *rollbackFaultFixture) {
	f.prepare(t, "rollback-effect-before-result")
	f.runtime.rollbackUnknown, f.runtime.rollbackUnknownApplied = true, true
	var release func()
	f.runtime.afterRollback = func() error { release = acquireEditRetrySQLiteWriteLock(t, f.dbPath); return nil }
	f.step(t)
	if release == nil {
		t.Fatal("rollback barrier did not acquire write lock")
	}
	assertFaultHarnessCheckpoint(t, f.store, "rollback-effect-before-result", storesqlite.EditRetryCheckpointRollbackDispatched, false)
	f.ledger.Assert(t, 1)
	release()
	f.reopenTwice(t)
	f.reconcileAfterReopen(t)
	f.ledger.Assert(t, 1)
}

func rollbackResultBeforeCommit(t *testing.T, f *rollbackFaultFixture) {
	participant := &armedRollbackCommitParticipant{operation: "checkpoint"}
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	f.host, f.store, f.db = openEditRetryRestartFixtureWithOptions(t, f.dbPath, f.runtime, false, storesqlite.Options{TransactionParticipant: participant})
	f.prepare(t, "rollback-result-before-commit")
	f.runtime.afterRollback = func() error { participant.Arm(); return nil }
	f.step(t)
	assertFaultHarnessCheckpoint(t, f.store, "rollback-result-before-commit", storesqlite.EditRetryCheckpointRollbackDispatched, false)
	f.ledger.Assert(t, 1)
	f.reopenTwice(t)
	f.reconcileAfterReopen(t)
	f.ledger.Assert(t, 1)
}

func rollbackResultAfterCommit(t *testing.T, f *rollbackFaultFixture) {
	f.prepare(t, "rollback-result-after-commit")
	history := &postCommitEditRetryFaultStore{EffectiveHistoryStore: f.store, point: "rollback_result"}
	f.host = newRollbackFaultHost(f.store, f.runtime, history, &failCheckpointRuntimeOperationStore{RuntimeOperationStore: f.store})
	f.step(t)
	assertFaultHarnessCheckpoint(t, f.store, "rollback-result-after-commit", storesqlite.EditRetryCheckpointRollbackConfirmed, false)
	assertFaultHarnessFence(t, f.store)
	f.ledger.Assert(t, 1)
	f.reopenTwice(t)
	f.reconcileAfterReopen(t)
	f.ledger.Assert(t, 1)
}

func rollbackAbortBoundaries(t *testing.T, _ *rollbackFaultFixture) {
	for _, boundary := range []string{"before", "after"} {
		t.Run(boundary, func(t *testing.T) {
			f := newRollbackFaultFixture(t)
			var participant *armedRollbackCommitParticipant
			if boundary == "before" {
				participant = &armedRollbackCommitParticipant{operation: "fail"}
				if err := f.db.Close(); err != nil {
					t.Fatal(err)
				}
				f.host, f.store, f.db = openEditRetryRestartFixtureWithOptions(t, f.dbPath, f.runtime, false, storesqlite.Options{TransactionParticipant: participant})
			}
			f.prepare(t, "rollback-abort-"+boundary)
			f.runtime.rollbackNotDispatched = true
			if participant != nil {
				f.runtime.afterRollback = func() error { participant.Arm(); return nil }
			}
			if boundary == "after" {
				f.host = newEditRetryFaultHarnessHost(f.store, f.runtime, &postCommitEditRetryFaultStore{EffectiveHistoryStore: f.store, point: "rollback_abort"})
			}
			f.step(t)
			if boundary == "before" {
				assertFaultHarnessCheckpoint(t, f.store, "rollback-abort-"+boundary, storesqlite.EditRetryCheckpointRollbackDispatched, false)
				assertFaultHarnessFence(t, f.store)
			} else {
				assertFaultHarnessCheckpoint(t, f.store, "rollback-abort-"+boundary, storesqlite.EditRetryCheckpointRollbackAborted, false)
				assertBatchHistoryReady(t, f.store, editRetryRestartRef.AgentSessionID)
			}
			f.reopenTwice(t)
			f.ledger.Assert(t, 0)
			assertRollbackFaultProjection(t, f)
		})
	}
}

func newRollbackFaultHost(store *storesqlite.Store, runtime *hostEditRetryRuntime, history agenthost.EffectiveHistoryStore, operations agenthost.RuntimeOperationStore) *agenthost.Host {
	return agenthost.New(agenthost.Config{CanonicalStore: sqliteCanonicalStore{Store: store}, TurnSubmissions: store, EffectiveHistory: history, RuntimeOperations: operations, Runtime: runtime, HistoryRuntime: runtime, GoalRuntime: runtime, OperationOwner: "rollback-fault"})
}

type failCheckpointRuntimeOperationStore struct {
	agenthost.RuntimeOperationStore
}

func (*failCheckpointRuntimeOperationStore) CheckpointRuntimeOperation(context.Context, storesqlite.CheckpointRuntimeOperationInput) (storesqlite.RuntimeOperation, bool, error) {
	return storesqlite.RuntimeOperation{}, false, errors.New("injected replacement-intent checkpoint failure")
}

type postCommitCheckpointRuntimeOperationStore struct {
	agenthost.RuntimeOperationStore
	fired bool
}

func (s *postCommitCheckpointRuntimeOperationStore) CheckpointRuntimeOperation(ctx context.Context, input storesqlite.CheckpointRuntimeOperationInput) (storesqlite.RuntimeOperation, bool, error) {
	op, changed, err := s.RuntimeOperationStore.CheckpointRuntimeOperation(ctx, input)
	if err == nil && changed && !s.fired {
		s.fired = true
		return op, changed, errInjectedPostCommit
	}
	return op, changed, err
}

type armedRollbackCommitParticipant struct {
	mu        sync.Mutex
	operation string
	armed     bool
	fired     bool
}

func (p *armedRollbackCommitParticipant) Arm() { p.mu.Lock(); p.armed = true; p.mu.Unlock() }
func (p *armedRollbackCommitParticipant) Participate(_ context.Context, _ storesqlite.TransactionWriter, delta storesqlite.TransactionDelta) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.armed || p.fired {
		return nil
	}
	for _, m := range delta.Mutations {
		if m.Operation == p.operation {
			p.fired = true
			return errors.New("injected rollback transaction failure")
		}
	}
	return nil
}

type rollbackMutationLedger struct {
	mu   sync.Mutex
	path string
}

func newRollbackMutationLedger(t *testing.T, path string) *rollbackMutationLedger {
	t.Helper()
	return &rollbackMutationLedger{path: path}
}
func (l *rollbackMutationLedger) Record() {
	l.mu.Lock()
	defer l.mu.Unlock()
	f, _ := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if f != nil {
		_, _ = f.WriteString("rollback\n")
		_ = f.Close()
	}
}
func (l *rollbackMutationLedger) Assert(t *testing.T, want int) {
	t.Helper()
	l.mu.Lock()
	defer l.mu.Unlock()
	b, err := os.ReadFile(l.path)
	if errors.Is(err, os.ErrNotExist) {
		b = nil
		err = nil
	}
	if err != nil {
		t.Fatal(err)
	}
	got := 0
	for _, c := range b {
		if c == '\n' {
			got++
		}
	}
	if got != want {
		t.Fatalf("persistent rollback mutation ledger=%d, want %d", got, want)
	}
}

// replacementMutationLedger is an external, file-backed provider-effect log.
// It intentionally survives reconstruction of Host and its in-memory runtime.
type replacementMutationLedger struct {
	mu   sync.Mutex
	path string
}

func (l *replacementMutationLedger) Record(identity string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	f, _ := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if f != nil {
		_, _ = f.WriteString(identity + "\n")
		_ = f.Close()
	}
}

func (l *replacementMutationLedger) Assert(t *testing.T, want int) {
	t.Helper()
	l.mu.Lock()
	defer l.mu.Unlock()
	b, err := os.ReadFile(l.path)
	if errors.Is(err, os.ErrNotExist) {
		if want == 0 {
			return
		}
		t.Fatalf("replacement ledger missing, want %d", want)
	}
	if err != nil {
		t.Fatal(err)
	}
	got := 0
	for _, c := range b {
		if c == '\n' {
			got++
		}
	}
	if got != want {
		t.Fatalf("replacement mutation ledger=%d, want %d", got, want)
	}
}
