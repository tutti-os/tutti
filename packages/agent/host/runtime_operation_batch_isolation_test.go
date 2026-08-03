package agenthost_test

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestRuntimeOperationWorkerBatchIsolatesSessionsAndSkipsBlockedDeferredAfterReopen(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "batch-isolation.db")
	runtime := &hostEditRetryRuntime{cancelErrors: map[string]error{"session-a": errors.New("poison cancel")}}
	_, store, db := openEditRetryRestartFixture(t, dbPath, runtime, true)

	seedBatchRunningSession(t, store, "session-a", "turn-a")
	seedBatchRunningSession(t, store, "session-b", "turn-b")
	seedBatchEditRetrySession(t, store, "session-c", "turn-c")
	seedBatchRunningSession(t, store, "session-d", "turn-d")
	now := time.Now().UnixMilli()
	operationA := prepareBatchCancel(t, store, "operation-a-poison", "session-a", "turn-a", now)
	operationB := prepareBatchCancel(t, store, "operation-b-healthy", "session-b", "turn-b", now)
	operationC := prepareBatchEditRetry(t, store, "operation-c-blocked", "session-c", "turn-c", now)
	operationD := prepareBatchCancel(t, store, "operation-d-deferred", "session-d", "turn-d", now)

	claimed, claimedOK, err := store.ClaimRuntimeOperationLease(t.Context(), storesqlite.ClaimRuntimeOperationLeaseInput{
		WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: operationC.OperationID,
		LeaseOwner: "fixture", NowUnixMS: now, LeaseExpiresAtMS: now + 60_000,
	})
	if err != nil || !claimedOK {
		t.Fatalf("claim blocked operation=%#v claimed=%v error=%v", claimed, claimedOK, err)
	}
	if _, changed, err := store.BlockEditRetry(t.Context(), storesqlite.BlockEditRetryInput{
		WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: operationC.OperationID,
		LeaseOwner: "fixture", ReasonCode: storesqlite.EditRetryReasonProviderOutcomeUnknown, NowUnixMS: now,
	}); err != nil || !changed {
		t.Fatalf("BlockEditRetry() changed=%v error=%v", changed, err)
	}
	claimed, claimedOK, err = store.ClaimRuntimeOperationLease(t.Context(), storesqlite.ClaimRuntimeOperationLeaseInput{
		WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: operationD.OperationID,
		LeaseOwner: "fixture", NowUnixMS: now, LeaseExpiresAtMS: now + 60_000,
	})
	if err != nil || !claimedOK {
		t.Fatalf("claim deferred operation=%#v claimed=%v error=%v", claimed, claimedOK, err)
	}
	if _, changed, err := store.ReleaseOrFailRuntimeOperation(t.Context(), storesqlite.ReleaseOrFailRuntimeOperationInput{
		WorkspaceID: editRetryRestartRef.WorkspaceID, OperationID: operationD.OperationID,
		LeaseOwner: "fixture", LastError: "deferred fixture", NowUnixMS: now,
		NextAttemptAtMS: now + time.Hour.Milliseconds(),
	}); err != nil || !changed {
		t.Fatalf("defer operation changed=%v error=%v", changed, err)
	}

	host := newBatchRuntimeOperationHost(store, runtime, store, &recordingRuntimeOperationPublisher{}, true)
	// The ordinary queue deliberately preserves upstream's synchronous worker
	// contract: it returns the poisoned item's error after attempting the whole
	// batch. The long-running worker records that error and keeps ticking; the
	// isolation guarantee is that B still reaches its terminal state below.
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err == nil {
		t.Fatal("StepRuntimeOperationWorker() = nil, want poison item error after isolated batch")
	}
	assertBatchOperationStatus(t, store, operationA.OperationID, storesqlite.RuntimeOperationStatusFailed)
	assertBatchOperationStatus(t, store, operationB.OperationID, storesqlite.RuntimeOperationStatusCompleted)
	assertBatchOperationStatus(t, store, operationC.OperationID, storesqlite.RuntimeOperationStatusBlocked)
	assertBatchOperationStatus(t, store, operationD.OperationID, storesqlite.RuntimeOperationStatusPrepared)
	assertBatchHistoryReady(t, store, "session-a")
	assertBatchHistoryOwner(t, store, "session-c", operationC.OperationID, storesqlite.SessionHistoryRecoveryRequired)
	assertBatchCancelCalls(t, runtime, map[string]int{"session-a": 1, "session-b": 1, "session-c": 0, "session-d": 0})
	claimable, err := store.ListClaimableRuntimeOperations(t.Context(), storesqlite.ListClaimableRuntimeOperationsInput{NowUnixMS: now, Limit: 10})
	if err != nil || len(claimable) != 0 {
		t.Fatalf("claimable after batch=%#v error=%v, want no terminal/blocked/future work", claimable, err)
	}

	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	_, reopened, reopenedDB := openEditRetryRestartFixture(t, dbPath, runtime, false)
	defer reopenedDB.Close()
	assertBatchOperationStatus(t, reopened, operationA.OperationID, storesqlite.RuntimeOperationStatusFailed)
	assertBatchOperationStatus(t, reopened, operationB.OperationID, storesqlite.RuntimeOperationStatusCompleted)
	assertBatchOperationStatus(t, reopened, operationC.OperationID, storesqlite.RuntimeOperationStatusBlocked)
	assertBatchOperationStatus(t, reopened, operationD.OperationID, storesqlite.RuntimeOperationStatusPrepared)
	assertBatchHistoryReady(t, reopened, "session-a")
	assertBatchHistoryOwner(t, reopened, "session-c", operationC.OperationID, storesqlite.SessionHistoryRecoveryRequired)
}

func TestEditRetryWorkerHungProviderDoesNotBlockHealthyProviderOrControlOperation(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "edit-retry-hung-provider.db")
	runtime := newEditRetryIsolationRuntime("session-hung")
	_, store, db := openEditRetryRestartFixture(t, dbPath, runtime.hostEditRetryRuntime, true)
	defer db.Close()

	seedBatchEditRetrySessionWithProvider(t, store, "session-hung", "turn-hung", "provider-hung")
	seedBatchEditRetrySessionWithProvider(t, store, "session-healthy", "turn-healthy", "provider-healthy")
	seedBatchRunningSession(t, store, "session-control", "turn-control")
	now := time.Now().UnixMilli()
	hung := prepareBatchEditRetry(t, store, "operation-hung", "session-hung", "turn-hung", now)
	healthy := prepareBatchEditRetry(t, store, "operation-healthy", "session-healthy", "turn-healthy", now)
	control := prepareBatchCancel(t, store, "operation-control", "session-control", "turn-control", now)
	host := agenthost.New(agenthost.Config{
		CanonicalStore: sqliteCanonicalStore{Store: store}, TurnSubmissions: store, EffectiveHistory: store, RuntimeOperations: store,
		Runtime: runtime, HistoryRuntime: runtime, GoalRuntime: runtime, OperationOwner: "isolation-worker",
		EditRetryAdmission: agenthost.EditRetryAdmissionAllowNew, EditRetryRecovery: agenthost.EditRetryRecoveryDrain,
		EditRetryAttemptTimeout: 250 * time.Millisecond, EditRetryMaxConcurrent: 4,
	})

	done := make(chan error, 1)
	go func() { done <- host.StepRuntimeOperationWorker(context.Background(), false) }()
	select {
	case <-runtime.hungReadStarted:
	case <-time.After(time.Second):
		t.Fatal("hung edit-retry provider read did not start")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("StepRuntimeOperationWorker() = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("worker waited for a context-ignoring edit-retry provider")
	}
	healthyAfter, found, err := store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, healthy.OperationID)
	if err != nil || !found || healthyAfter.Status == storesqlite.RuntimeOperationStatusLeased || healthyAfter.Attempt != 1 || runtime.execCount("session-healthy") != 1 {
		t.Fatalf("healthy edit-retry did not reach exactly one provider attempt: operation=%#v found=%v error=%v exec=%d", healthyAfter, found, err, runtime.execCount("session-healthy"))
	}
	assertBatchOperationStatus(t, store, control.OperationID, storesqlite.RuntimeOperationStatusCompleted)
	assertBatchOperationStatus(t, store, hung.OperationID, storesqlite.RuntimeOperationStatusLeased)
	if runtime.readCount("session-hung") != 1 {
		t.Fatalf("hung provider reads=%d, want 1", runtime.readCount("session-hung"))
	}
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatalf("repeat StepRuntimeOperationWorker() = %v", err)
	}
	if runtime.readCount("session-hung") != 1 {
		t.Fatalf("repeat tick replayed hung operation: reads=%d", runtime.readCount("session-hung"))
	}
	close(runtime.hungReadRelease)
	select {
	case <-runtime.hungReadReturned:
	case <-time.After(time.Second):
		t.Fatal("hung edit-retry provider did not release after returning")
	}
	// The provider-return barrier is deliberately inside ReadEffectiveHistory.
	// A deadline may leave the durable lease for ordinary expiry/recovery, but
	// the executor must finish its goroutine (and release its in-process
	// reservation) before this fixture closes SQLite below.
	deadline := time.After(time.Second)
	for host.RuntimeOperationWorkerSummary().ItemFailures == 0 {
		select {
		case <-deadline:
			t.Fatal("hung edit-retry attempt did not settle after provider returned")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

type editRetryIsolationRuntime struct {
	*hostEditRetryRuntime
	hungSession      string
	hungReadStarted  chan struct{}
	hungReadRelease  chan struct{}
	hungReadReturned chan struct{}
	reads            map[string]int
	execs            map[string]int
	turns            map[string][]agenthost.RuntimeHistoryTurn
}

func newEditRetryIsolationRuntime(hungSession string) *editRetryIsolationRuntime {
	return &editRetryIsolationRuntime{
		hostEditRetryRuntime: &hostEditRetryRuntime{}, hungSession: hungSession,
		hungReadStarted: make(chan struct{}, 1), hungReadRelease: make(chan struct{}),
		hungReadReturned: make(chan struct{}, 1), reads: make(map[string]int), execs: make(map[string]int), turns: make(map[string][]agenthost.RuntimeHistoryTurn),
	}
}

func (*editRetryIsolationRuntime) Session(_ string, agentSessionID string) (agenthost.ProviderRuntimeSession, bool) {
	return agenthost.ProviderRuntimeSession{ID: agentSessionID, WorkspaceID: editRetryRestartRef.WorkspaceID, Provider: "provider-" + agentSessionID, ProviderSessionID: "thread-" + agentSessionID, InitialTitleEstablished: true}, true
}

func (r *editRetryIsolationRuntime) ReadEffectiveHistory(_ context.Context, input agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistorySnapshot, error) {
	r.mu.Lock()
	r.reads[input.AgentSessionID]++
	turns, found := r.turns[input.AgentSessionID]
	if !found {
		turns = []agenthost.RuntimeHistoryTurn{{ID: "provider-" + input.AgentSessionID}}
		r.turns[input.AgentSessionID] = turns
	}
	r.mu.Unlock()
	if input.AgentSessionID == r.hungSession {
		select {
		case r.hungReadStarted <- struct{}{}:
		default:
		}
		<-r.hungReadRelease // Intentionally ignores cancellation like a misbehaving provider.
		select {
		case r.hungReadReturned <- struct{}{}:
		default:
		}
	}
	return agenthost.RuntimeHistorySnapshot{ProviderSessionID: "thread-" + input.AgentSessionID, Turns: append([]agenthost.RuntimeHistoryTurn(nil), turns...)}, nil
}

func (r *editRetryIsolationRuntime) RollbackLatestTurn(_ context.Context, input agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistoryMutationResult, error) {
	r.mu.Lock()
	r.rollbackCalls++
	r.turns[input.AgentSessionID] = nil
	r.mu.Unlock()
	snapshot := agenthost.RuntimeHistorySnapshot{ProviderSessionID: "thread-" + input.AgentSessionID}
	return agenthost.RuntimeHistoryMutationResult{Disposition: agenthost.RuntimeDispatchDispositionApplied, Snapshot: &snapshot}, nil
}

func (r *editRetryIsolationRuntime) Exec(_ context.Context, input agenthost.RuntimeExecInput) (agenthost.RuntimeExecResult, error) {
	r.mu.Lock()
	r.execCalls++
	r.execs[input.AgentSessionID]++
	r.turns[input.AgentSessionID] = append(r.turns[input.AgentSessionID], agenthost.RuntimeHistoryTurn{ID: "replacement-" + input.AgentSessionID, ClientUserMessageID: input.ClientSubmitID})
	r.mu.Unlock()
	providerTurnID := "replacement-" + input.AgentSessionID
	if _, err := r.store.ReportActivityState(context.Background(), storesqlite.ActivityStateReport{
		Session:          storesqlite.SessionStateReport{WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, Kind: storesqlite.SessionKindRoot, Provider: "provider-" + input.AgentSessionID, ProviderSessionID: "thread-" + input.AgentSessionID, OccurredAtUnixMS: time.Now().UnixMilli()},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{WorkspaceID: input.WorkspaceID, RootAgentSessionID: input.AgentSessionID, RootTurnID: input.TurnID, ProviderTurnID: providerTurnID, Phase: storesqlite.RootProviderTurnPhaseRunning, OccurredAtUnixMS: time.Now().UnixMilli()},
	}); err != nil {
		return agenthost.RuntimeExecResult{}, err
	}
	return agenthost.RuntimeExecResult{TurnID: input.TurnID, ProviderDispatch: agenthost.RuntimeProviderDispatchResult{Disposition: agenthost.RuntimeDispatchDispositionApplied, Acceptance: &agenthost.RuntimeProviderAcceptanceReceipt{ProviderSessionID: "thread-" + input.AgentSessionID, ProviderTurnID: providerTurnID, Source: agenthost.RuntimeAcceptanceSourceTurnStartResponse}}}, nil
}

func (r *editRetryIsolationRuntime) readCount(sessionID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.reads[sessionID]
}

func (r *editRetryIsolationRuntime) execCount(sessionID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.execs[sessionID]
}

func TestRuntimeOperationOutboxFailurePreservesTerminalBatchAndReplaysAfterReopen(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "outbox-retry.db")
	runtime := &hostEditRetryRuntime{}
	_, store, db := openEditRetryRestartFixture(t, dbPath, runtime, true)
	seedBatchRunningSession(t, store, "session-one", "turn-one")
	seedBatchRunningSession(t, store, "session-two", "turn-two")
	now := time.Now().UnixMilli()
	clock := &batchClock{at: time.UnixMilli(now)}
	operationOne := prepareBatchCancel(t, store, "operation-one", "session-one", "turn-one", now)
	operationTwo := prepareBatchCancel(t, store, "operation-two", "session-two", "turn-two", now)
	publisher := &recordingRuntimeOperationPublisher{fail: true}
	host := newBatchRuntimeOperationHost(store, runtime, store, publisher, false, clock)

	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatalf("StepRuntimeOperationWorker() = %v, want outbox failure isolation", err)
	}
	assertBatchOperationStatus(t, store, operationOne.OperationID, storesqlite.RuntimeOperationStatusCompleted)
	assertBatchOperationStatus(t, store, operationTwo.OperationID, storesqlite.RuntimeOperationStatusCompleted)
	assertBatchCancelCalls(t, runtime, map[string]int{"session-one": 1, "session-two": 1})
	pending, err := store.ListReadyRuntimeOperationEvents(t.Context(), editRetryRestartRef.WorkspaceID, clock.Now().Add(2*time.Second).UnixMilli(), 10)
	if err != nil || len(pending) != 2 {
		t.Fatalf("pending outbox=%#v error=%v, want both terminal events", pending, err)
	}
	claimable, err := store.ListClaimableRuntimeOperations(t.Context(), storesqlite.ListClaimableRuntimeOperationsInput{NowUnixMS: now, Limit: 10})
	if err != nil || len(claimable) != 0 {
		t.Fatalf("terminal operations claimable=%#v error=%v, want none", claimable, err)
	}
	if summary := host.RuntimeOperationWorkerSummary(); summary.OutboxFailures == 0 {
		t.Fatalf("worker summary=%#v, want outbox degradation", summary)
	}

	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	publisher.fail = false
	clock.at = clock.at.Add(2 * time.Second)
	_, reopened, reopenedDB := openEditRetryRestartFixture(t, dbPath, runtime, false)
	defer reopenedDB.Close()
	host = newBatchRuntimeOperationHost(reopened, runtime, reopened, publisher, false, clock)
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatalf("reopened StepRuntimeOperationWorker() = %v", err)
	}
	if pending, err = reopened.ListReadyRuntimeOperationEvents(t.Context(), editRetryRestartRef.WorkspaceID, clock.Now().UnixMilli(), 10); err != nil || len(pending) != 0 {
		t.Fatalf("pending after retry=%#v error=%v, want empty", pending, err)
	}
	publisher.assertDeliveredExactlyOnce(t, operationOne.OperationID, operationTwo.OperationID)
	assertBatchCancelCalls(t, runtime, map[string]int{"session-one": 1, "session-two": 1})
}

func TestRuntimeOperationOutboxMarkFailureReplaysStableEventIdentity(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "outbox-mark-failure.db")
	runtime := &hostEditRetryRuntime{}
	_, store, db := openEditRetryRestartFixture(t, dbPath, runtime, true)
	seedBatchRunningSession(t, store, "session-mark", "turn-mark")
	operation := prepareBatchCancel(t, store, "operation-mark", "session-mark", "turn-mark", time.Now().UnixMilli())
	clock := &batchClock{at: time.Now()}
	publisher := &recordingRuntimeOperationPublisher{}
	if _, err := db.ExecContext(t.Context(), `
CREATE TRIGGER fail_runtime_operation_event_mark
BEFORE UPDATE OF published_at_unix_ms ON workspace_agent_runtime_operation_events
WHEN NEW.published_at_unix_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'injected outbox mark failure'); END;
`); err != nil {
		t.Fatal(err)
	}
	host := newBatchRuntimeOperationHost(store, runtime, store, publisher, false, clock)

	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatalf("StepRuntimeOperationWorker() = %v, want mark failure isolation", err)
	}
	assertBatchOperationStatus(t, store, operation.OperationID, storesqlite.RuntimeOperationStatusCompleted)
	pending, err := store.ListReadyRuntimeOperationEvents(t.Context(), editRetryRestartRef.WorkspaceID, clock.Now().Add(2*time.Second).UnixMilli(), 10)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending after mark failure=%#v error=%v, want stable event", pending, err)
	}
	eventID := pending[0].ID
	publisher.assertAllDeliveriesUseEventID(t, eventID)
	assertBatchCancelCalls(t, runtime, map[string]int{"session-mark": 1})
	if _, err := db.ExecContext(t.Context(), `DROP TRIGGER fail_runtime_operation_event_mark`); err != nil {
		t.Fatal(err)
	}

	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	clock.at = clock.at.Add(2 * time.Second)
	_, reopened, reopenedDB := openEditRetryRestartFixture(t, dbPath, runtime, false)
	defer reopenedDB.Close()
	host = newBatchRuntimeOperationHost(reopened, runtime, reopened, publisher, false, clock)
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatalf("reopened StepRuntimeOperationWorker() = %v", err)
	}
	if pending, err = reopened.ListReadyRuntimeOperationEvents(t.Context(), editRetryRestartRef.WorkspaceID, clock.Now().UnixMilli(), 10); err != nil || len(pending) != 0 {
		t.Fatalf("pending after mark recovery=%#v error=%v, want empty", pending, err)
	}
	publisher.assertAllDeliveriesUseEventID(t, eventID)
	if publisher.uniqueConsumerEvents() != 1 {
		t.Fatalf("consumer idempotency keys=%d, want 1 for replayed event %d", publisher.uniqueConsumerEvents(), eventID)
	}
	assertBatchCancelCalls(t, runtime, map[string]int{"session-mark": 1})
}

func TestRuntimeOperationOutboxDefersOnePoisonEventAndContinuesLaterEvents(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "outbox-single-event-isolation.db")
	runtime := &hostEditRetryRuntime{}
	_, store, db := openEditRetryRestartFixture(t, dbPath, runtime, true)
	seedBatchRunningSession(t, store, "session-a", "turn-a")
	seedBatchRunningSession(t, store, "session-b", "turn-b")
	now := time.Now().UnixMilli()
	clock := &batchClock{at: time.UnixMilli(now)}
	opA := prepareBatchCancel(t, store, "operation-outbox-a", "session-a", "turn-a", now)
	opB := prepareBatchCancel(t, store, "operation-outbox-b", "session-b", "turn-b", now)
	publisher := &recordingRuntimeOperationPublisher{failOperations: map[string]error{opA.OperationID: errors.New("permanent A publish failure")}}
	host := newBatchRuntimeOperationHost(store, runtime, store, publisher, false, clock)
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatalf("StepRuntimeOperationWorker()=%v", err)
	}
	assertBatchOperationStatus(t, store, opA.OperationID, storesqlite.RuntimeOperationStatusCompleted)
	assertBatchOperationStatus(t, store, opB.OperationID, storesqlite.RuntimeOperationStatusCompleted)
	ready, err := store.ListReadyRuntimeOperationEvents(t.Context(), editRetryRestartRef.WorkspaceID, clock.Now().UnixMilli(), 10)
	if err != nil || len(ready) != 0 {
		t.Fatalf("ready events while A backs off=%#v error=%v", ready, err)
	}
	publisher.assertDeliveredExactlyOnce(t, opB.OperationID)
	future, err := store.ListReadyRuntimeOperationEvents(t.Context(), editRetryRestartRef.WorkspaceID, clock.Now().Add(2*time.Second).UnixMilli(), 10)
	if err != nil || len(future) != 1 || future[0].OperationID != opA.OperationID || future[0].PublishAttempt != 1 {
		t.Fatalf("deferred A event=%#v error=%v", future, err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	clock.at = clock.at.Add(2 * time.Second)
	delete(publisher.failOperations, opA.OperationID)
	_, reopened, reopenedDB := openEditRetryRestartFixture(t, dbPath, runtime, false)
	defer reopenedDB.Close()
	host = newBatchRuntimeOperationHost(reopened, runtime, reopened, publisher, false, clock)
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	publisher.assertDeliveredExactlyOnce(t, opA.OperationID, opB.OperationID)
}

func TestRuntimeOperationOutboxPoisonEventDoesNotBlockAnotherWorkspace(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "outbox-workspace-isolation.db")
	runtime := &hostEditRetryRuntime{}
	_, store, db := openEditRetryRestartFixture(t, dbPath, runtime, true)
	defer db.Close()
	const otherWorkspace = "workspace-2"
	seedBatchRunningSessionInWorkspace(t, store, editRetryRestartRef.WorkspaceID, "session-outbox-a", "turn-outbox-a")
	seedBatchRunningSessionInWorkspace(t, store, otherWorkspace, "session-outbox-b", "turn-outbox-b")
	now := time.Now().UnixMilli()
	clock := &batchClock{at: time.UnixMilli(now)}
	opA := prepareBatchCancelInWorkspace(t, store, editRetryRestartRef.WorkspaceID, "operation-outbox-workspace-a", "session-outbox-a", "turn-outbox-a", now)
	opB := prepareBatchCancelInWorkspace(t, store, otherWorkspace, "operation-outbox-workspace-b", "session-outbox-b", "turn-outbox-b", now)
	publisher := &recordingRuntimeOperationPublisher{failOperations: map[string]error{opA.OperationID: errors.New("workspace A publish failure")}}
	host := newBatchRuntimeOperationHost(store, runtime, store, publisher, false, clock)
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatalf("StepRuntimeOperationWorker()=%v", err)
	}
	assertBatchOperationStatusInWorkspace(t, store, editRetryRestartRef.WorkspaceID, opA.OperationID, storesqlite.RuntimeOperationStatusCompleted)
	assertBatchOperationStatusInWorkspace(t, store, otherWorkspace, opB.OperationID, storesqlite.RuntimeOperationStatusCompleted)
	publisher.assertDeliveredExactlyOnce(t, opB.OperationID)
	readyA, err := store.ListReadyRuntimeOperationEvents(t.Context(), editRetryRestartRef.WorkspaceID, clock.Now().UnixMilli(), 10)
	if err != nil || len(readyA) != 0 {
		t.Fatalf("workspace A ready events=%#v error=%v, want deferred poison only", readyA, err)
	}
	readyB, err := store.ListReadyRuntimeOperationEvents(t.Context(), otherWorkspace, clock.Now().UnixMilli(), 10)
	if err != nil || len(readyB) != 0 {
		t.Fatalf("workspace B ready events=%#v error=%v, want published", readyB, err)
	}
}

func TestRuntimeOperationOutboxMarkFailureDoesNotBlockLaterEvent(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "outbox-mark-single-event-isolation.db")
	runtime := &hostEditRetryRuntime{}
	_, store, db := openEditRetryRestartFixture(t, dbPath, runtime, true)
	seedBatchRunningSession(t, store, "session-mark-a", "turn-mark-a")
	seedBatchRunningSession(t, store, "session-mark-b", "turn-mark-b")
	now := time.Now().UnixMilli()
	clock := &batchClock{at: time.UnixMilli(now)}
	opA := prepareBatchCancel(t, store, "operation-mark-a", "session-mark-a", "turn-mark-a", now)
	opB := prepareBatchCancel(t, store, "operation-mark-b", "session-mark-b", "turn-mark-b", now)
	if _, err := db.ExecContext(t.Context(), `
CREATE TRIGGER fail_one_runtime_operation_event_mark
BEFORE UPDATE OF published_at_unix_ms ON workspace_agent_runtime_operation_events
WHEN NEW.operation_id='operation-mark-a' AND NEW.published_at_unix_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'injected A mark failure'); END;
`); err != nil {
		t.Fatal(err)
	}
	publisher := &recordingRuntimeOperationPublisher{}
	host := newBatchRuntimeOperationHost(store, runtime, store, publisher, false, clock)
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	ready, err := store.ListReadyRuntimeOperationEvents(t.Context(), editRetryRestartRef.WorkspaceID, clock.Now().Add(2*time.Second).UnixMilli(), 10)
	if err != nil || len(ready) != 1 || ready[0].OperationID != opA.OperationID || ready[0].PublishAttempt != 1 {
		t.Fatalf("deferred unmarked A=%#v error=%v", ready, err)
	}
	publisher.assertDeliveredExactlyOnce(t, opA.OperationID, opB.OperationID)
	if _, err := db.ExecContext(t.Context(), `DROP TRIGGER fail_one_runtime_operation_event_mark`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	clock.at = clock.at.Add(2 * time.Second)
	_, reopened, reopenedDB := openEditRetryRestartFixture(t, dbPath, runtime, false)
	defer reopenedDB.Close()
	host = newBatchRuntimeOperationHost(reopened, runtime, reopened, publisher, false, clock)
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	publisher.assertOperationUsesStableEventID(t, opA.OperationID, ready[0].ID)
	if publisher.uniqueConsumerEvents() != 2 {
		t.Fatalf("consumer idempotency keys=%d, want 2", publisher.uniqueConsumerEvents())
	}
}

func newBatchRuntimeOperationHost(store *storesqlite.Store, runtime *hostEditRetryRuntime, operations agenthost.RuntimeOperationStore, publisher agenthost.RuntimeOperationEventPublisher, denyNewEditRetry bool, clocks ...agenthost.Clock) *agenthost.Host {
	var clock agenthost.Clock
	if len(clocks) != 0 {
		clock = clocks[0]
	}
	return agenthost.New(agenthost.Config{
		CanonicalStore: sqliteCanonicalStore{Store: store}, TurnSubmissions: store,
		EffectiveHistory: store, RuntimeOperations: editRetryClaimForwardingStore{RuntimeOperationStore: operations, store: store}, Runtime: runtime,
		HistoryRuntime: runtime, GoalRuntime: runtime, OperationOwner: "batch-worker",
		OperationEvents: publisher, EditRetryAdmission: editRetryAdmissionForTest(denyNewEditRetry), EditRetryRecovery: editRetryRecoveryForTest(denyNewEditRetry), Clock: clock,
	})
}

func editRetryAdmissionForTest(denyNew bool) agenthost.EditRetryAdmissionPolicy {
	if denyNew {
		return agenthost.EditRetryAdmissionDenyNew
	}
	return agenthost.EditRetryAdmissionAllowNew
}

func editRetryRecoveryForTest(readOnly bool) agenthost.EditRetryRecoveryPolicy {
	if readOnly {
		return agenthost.EditRetryRecoveryReconcileOnly
	}
	return agenthost.EditRetryRecoveryDrain
}

type batchClock struct{ at time.Time }

func (c *batchClock) Now() time.Time { return c.at }

func seedBatchRunningSession(t *testing.T, store *storesqlite.Store, sessionID, turnID string) {
	seedBatchRunningSessionInWorkspace(t, store, editRetryRestartRef.WorkspaceID, sessionID, turnID)
}

func seedBatchRunningSessionInWorkspace(t *testing.T, store *storesqlite.Store, workspaceID, sessionID, turnID string) {
	t.Helper()
	ctx := t.Context()
	if _, err := store.ReportSessionState(ctx, storesqlite.SessionStateReport{WorkspaceID: workspaceID, AgentSessionID: sessionID, Kind: storesqlite.SessionKindRoot, Provider: "codex", ProviderSessionID: "thread-" + sessionID, OccurredAtUnixMS: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(ctx, storesqlite.ActivityStateReport{
		Session:          storesqlite.SessionStateReport{WorkspaceID: workspaceID, AgentSessionID: sessionID, Kind: storesqlite.SessionKindRoot, Provider: "codex", ProviderSessionID: "thread-" + sessionID, OccurredAtUnixMS: 2},
		Turn:             &storesqlite.TurnTransition{WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID, Phase: storesqlite.TurnPhaseRunning, Origin: storesqlite.TurnOriginUserPrompt, StartedAtUnixMS: 2, OccurredAtUnixMS: 2},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{WorkspaceID: workspaceID, RootAgentSessionID: sessionID, RootTurnID: turnID, ProviderTurnID: "provider-" + sessionID, Phase: storesqlite.RootProviderTurnPhaseRunning, OccurredAtUnixMS: 2},
	}); err != nil {
		t.Fatal(err)
	}
}

func seedBatchEditRetrySession(t *testing.T, store *storesqlite.Store, sessionID, turnID string) {
	t.Helper()
	seedBatchRunningSession(t, store, sessionID, turnID)
	if _, err := store.ReportActivityState(t.Context(), storesqlite.ActivityStateReport{
		Session:          storesqlite.SessionStateReport{WorkspaceID: editRetryRestartRef.WorkspaceID, AgentSessionID: sessionID, Kind: storesqlite.SessionKindRoot, Provider: "codex", ProviderSessionID: "thread-" + sessionID, OccurredAtUnixMS: 3},
		Turn:             &storesqlite.TurnTransition{WorkspaceID: editRetryRestartRef.WorkspaceID, AgentSessionID: sessionID, TurnID: turnID, Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeCompleted, Origin: storesqlite.TurnOriginUserPrompt, SettledAtUnixMS: 3, OccurredAtUnixMS: 3},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{WorkspaceID: editRetryRestartRef.WorkspaceID, RootAgentSessionID: sessionID, RootTurnID: turnID, ProviderTurnID: "provider-" + sessionID, Phase: storesqlite.RootProviderTurnPhaseCompleted, Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 3},
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RecordTurnSubmission(t.Context(), storesqlite.TurnSubmission{WorkspaceID: editRetryRestartRef.WorkspaceID, AgentSessionID: sessionID, TurnID: turnID, ContentJSON: `[{"type":"text","text":"original"}]`, DisplayPrompt: "original", CapabilityRefsJSON: `[]`, TuttiModeSnapshotJSON: `null`, ClientSubmitID: "submit-" + sessionID, CreatedAtUnixMS: 3, UpdatedAtUnixMS: 3}); err != nil {
		t.Fatal(err)
	}
}

func seedBatchEditRetrySessionWithProvider(t *testing.T, store *storesqlite.Store, sessionID, turnID, provider string) {
	t.Helper()
	ctx := t.Context()
	if _, err := store.ReportSessionState(ctx, storesqlite.SessionStateReport{
		WorkspaceID: editRetryRestartRef.WorkspaceID, AgentSessionID: sessionID,
		Kind: storesqlite.SessionKindRoot, Provider: provider, ProviderSessionID: "thread-" + sessionID, OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(ctx, storesqlite.ActivityStateReport{
		Session:          storesqlite.SessionStateReport{WorkspaceID: editRetryRestartRef.WorkspaceID, AgentSessionID: sessionID, Kind: storesqlite.SessionKindRoot, Provider: provider, ProviderSessionID: "thread-" + sessionID, OccurredAtUnixMS: 3},
		Turn:             &storesqlite.TurnTransition{WorkspaceID: editRetryRestartRef.WorkspaceID, AgentSessionID: sessionID, TurnID: turnID, Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeCompleted, Origin: storesqlite.TurnOriginUserPrompt, SettledAtUnixMS: 3, OccurredAtUnixMS: 3},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{WorkspaceID: editRetryRestartRef.WorkspaceID, RootAgentSessionID: sessionID, RootTurnID: turnID, ProviderTurnID: "provider-" + sessionID, Phase: storesqlite.RootProviderTurnPhaseCompleted, Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 3},
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RecordTurnSubmission(ctx, storesqlite.TurnSubmission{WorkspaceID: editRetryRestartRef.WorkspaceID, AgentSessionID: sessionID, TurnID: turnID, ContentJSON: `[{"type":"text","text":"original"}]`, DisplayPrompt: "original", CapabilityRefsJSON: `[]`, TuttiModeSnapshotJSON: `null`, ClientSubmitID: "submit-" + sessionID, CreatedAtUnixMS: 3, UpdatedAtUnixMS: 3}); err != nil {
		t.Fatal(err)
	}
}

func prepareBatchEditRetry(t *testing.T, store *storesqlite.Store, operationID, sessionID, turnID string, now int64) storesqlite.RuntimeOperation {
	t.Helper()
	payload, err := storesqlite.EncodeEditRetryOperationPayload(storesqlite.EditRetryOperationPayload{ClientOperationID: operationID, EditedText: "edited", ReplacementTurnID: "replacement-" + operationID, ClientSubmitID: "edit-retry:" + operationID, ExpectedRevision: 0, Checkpoint: storesqlite.EditRetryCheckpointPrepared})
	if err != nil {
		t.Fatal(err)
	}
	op, changed, err := store.PrepareEditRetry(t.Context(), storesqlite.RuntimeOperationPrepare{WorkspaceID: editRetryRestartRef.WorkspaceID, AgentSessionID: sessionID, OperationID: operationID, Kind: storesqlite.RuntimeOperationKindEditRetry, TurnID: turnID, RequestID: operationID, Payload: payload, OccurredAtMS: now})
	if err != nil || !changed {
		t.Fatalf("PrepareEditRetry(%s) operation=%#v changed=%v error=%v", operationID, op, changed, err)
	}
	return op
}

func prepareBatchCancel(t *testing.T, store *storesqlite.Store, operationID, sessionID, turnID string, now int64) storesqlite.RuntimeOperation {
	return prepareBatchCancelInWorkspace(t, store, editRetryRestartRef.WorkspaceID, operationID, sessionID, turnID, now)
}

func prepareBatchCancelInWorkspace(t *testing.T, store *storesqlite.Store, workspaceID, operationID, sessionID, turnID string, now int64) storesqlite.RuntimeOperation {
	t.Helper()
	payload := map[string]any{"reason": "test", "rootAgentSessionId": sessionID, "targets": []any{map[string]any{"agentSessionId": sessionID, "turnId": turnID}}}
	op, changed, err := store.PrepareRuntimeOperation(t.Context(), storesqlite.RuntimeOperationPrepare{WorkspaceID: workspaceID, AgentSessionID: sessionID, OperationID: operationID, Kind: storesqlite.RuntimeOperationKindCancelTurn, TurnID: turnID, Payload: payload, OccurredAtMS: now})
	if err != nil || !changed {
		t.Fatalf("PrepareRuntimeOperation(%s) operation=%#v changed=%v error=%v", operationID, op, changed, err)
	}
	return op
}

func assertBatchOperationStatus(t *testing.T, store *storesqlite.Store, operationID, wantStatus string) {
	assertBatchOperationStatusInWorkspace(t, store, editRetryRestartRef.WorkspaceID, operationID, wantStatus)
}

func assertBatchOperationStatusInWorkspace(t *testing.T, store *storesqlite.Store, workspaceID, operationID, wantStatus string) {
	t.Helper()
	op, found, err := store.GetRuntimeOperation(t.Context(), workspaceID, operationID)
	if err != nil || !found || op.Status != wantStatus {
		t.Fatalf("operation %s=%#v found=%v error=%v, want status %q", operationID, op, found, err, wantStatus)
	}
}

func assertBatchHistoryOwner(t *testing.T, store *storesqlite.Store, sessionID, operationID, wantState string) {
	t.Helper()
	history, found, err := store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, sessionID)
	if err != nil || !found || history.OperationID != operationID || history.RecoveryState != wantState {
		t.Fatalf("session %s history=%#v found=%v error=%v, want owner=%q state=%q", sessionID, history, found, err, operationID, wantState)
	}
}

func assertBatchHistoryReady(t *testing.T, store *storesqlite.Store, sessionID string) {
	t.Helper()
	history, found, err := store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, sessionID)
	if err != nil || !found || history.OperationID != "" || history.RecoveryState != storesqlite.SessionHistoryRecoveryReady {
		t.Fatalf("session %s history=%#v found=%v error=%v, want unfenced ready", sessionID, history, found, err)
	}
}

func assertBatchCancelCalls(t *testing.T, runtime *hostEditRetryRuntime, want map[string]int) {
	t.Helper()
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	for sessionID, count := range want {
		if runtime.cancelCalls[sessionID] != count {
			t.Fatalf("cancel calls for %s=%d, want %d", sessionID, runtime.cancelCalls[sessionID], count)
		}
	}
}

type recordingRuntimeOperationPublisher struct {
	mu             sync.Mutex
	fail           bool
	failOperations map[string]error
	deliveries     []storesqlite.RuntimeOperationEvent
	consumer       map[int64]struct{}
}

func (p *recordingRuntimeOperationPublisher) PublishRuntimeOperationEvent(_ context.Context, event storesqlite.RuntimeOperationEvent) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.failOperations[event.OperationID]; err != nil {
		return err
	}
	if p.fail {
		return errors.New("injected outbox publisher failure")
	}
	p.deliveries = append(p.deliveries, event)
	if p.consumer == nil {
		p.consumer = make(map[int64]struct{})
	}
	p.consumer[event.ID] = struct{}{}
	return nil
}

func (p *recordingRuntimeOperationPublisher) assertDeliveredExactlyOnce(t *testing.T, operationIDs ...string) {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	counts := make(map[string]int)
	for _, event := range p.deliveries {
		counts[event.OperationID]++
	}
	for _, operationID := range operationIDs {
		if counts[operationID] != 1 {
			t.Fatalf("outbox deliveries for %s=%d, want 1 (%#v)", operationID, counts[operationID], p.deliveries)
		}
	}
}

func (p *recordingRuntimeOperationPublisher) assertAllDeliveriesUseEventID(t *testing.T, eventID int64) {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.deliveries) == 0 {
		t.Fatal("outbox publisher had no successful delivery")
	}
	for _, event := range p.deliveries {
		if event.ID != eventID {
			t.Fatalf("event delivery id=%d, want stable id %d", event.ID, eventID)
		}
	}
}

func (p *recordingRuntimeOperationPublisher) assertOperationUsesStableEventID(t *testing.T, operationID string, eventID int64) {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, event := range p.deliveries {
		if event.OperationID == operationID && event.ID != eventID {
			t.Fatalf("operation %s replayed as event %d, want stable %d", operationID, event.ID, eventID)
		}
	}
}

func (p *recordingRuntimeOperationPublisher) uniqueConsumerEvents() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.consumer)
}
