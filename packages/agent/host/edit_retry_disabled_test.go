package agenthost_test

import (
	"context"
	"errors"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type failingRuntimeOperationPublisher struct{}

func (failingRuntimeOperationPublisher) PublishRuntimeOperationEvent(context.Context, storesqlite.RuntimeOperationEvent) error {
	return errors.New("outbox unavailable")
}

// newDisabledEditRetryHost builds a second Host over an existing fixture
// store+runtime with the edit-and-retry feature neutralized, exercising the
// explicit rollback policy independently from production's enabled admission.
func newDisabledEditRetryHost(store *storesqlite.Store, runtime *hostEditRetryRuntime) *agenthost.Host {
	return agenthost.New(agenthost.Config{
		CanonicalStore:  sqliteCanonicalStore{Store: store},
		TurnSubmissions: store, EffectiveHistory: store, RuntimeOperations: store,
		Runtime: runtime, HistoryRuntime: runtime, GoalRuntime: runtime,
		OperationOwner:     "worker-disabled",
		EditRetryAdmission: agenthost.EditRetryAdmissionDenyNew,
		EditRetryRecovery:  agenthost.EditRetryRecoveryReconcileOnly,
	})
}

func newDenyNewDrainEditRetryHost(store *storesqlite.Store, runtime *hostEditRetryRuntime) *agenthost.Host {
	return agenthost.New(agenthost.Config{
		CanonicalStore:  sqliteCanonicalStore{Store: store},
		TurnSubmissions: store, EffectiveHistory: store, RuntimeOperations: store,
		Runtime: runtime, HistoryRuntime: runtime, GoalRuntime: runtime,
		OperationOwner:     "worker-deny-new-drain",
		EditRetryAdmission: agenthost.EditRetryAdmissionDenyNew,
		EditRetryRecovery:  agenthost.EditRetryRecoveryDrain,
	})
}

// TestEditRetryAdmissionDenyNewRefusesNewOperations verifies rollout policy
// rejects only new work and projects a reason distinct from provider support.
func TestEditRetryAdmissionDenyNewRefusesNewOperations(t *testing.T) {
	_, store, runtime := newHostEditRetryFixture(t)
	host := newDisabledEditRetryHost(store, runtime)
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}

	availability, err := host.GetEditRetryAvailability(t.Context(), ref)
	if err != nil {
		t.Fatalf("GetEditRetryAvailability() error = %v", err)
	}
	if availability.Supported || availability.Eligible || availability.ReasonCode != agenthost.EditRetryReasonCodeRolloutDisabled {
		t.Fatalf("availability = %#v, want rollout-disabled unsupported projection", availability)
	}

	_, err = host.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-1", ExpectedHistoryRevision: 0,
	})
	if !errors.Is(err, agenthost.ErrRuntimeHistoryUnsupported) {
		t.Fatalf("EditRetry() error = %v, want ErrRuntimeHistoryUnsupported", err)
	}

	claimable, err := store.ListClaimableRuntimeOperations(t.Context(), storesqlite.ListClaimableRuntimeOperationsInput{
		NowUnixMS: 1 << 62, Limit: 100,
	})
	if err != nil {
		t.Fatalf("ListClaimableRuntimeOperations() error = %v", err)
	}
	if len(claimable) != 0 {
		t.Fatalf("EditRetry(disabled) created %d runtime operation(s), want 0", len(claimable))
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.rollbackCalls != 0 || runtime.execCalls != 0 {
		t.Fatalf("provider was touched: rollback=%d exec=%d, want 0,0", runtime.rollbackCalls, runtime.execCalls)
	}
}

// TestEditRetryAdmissionDenyNewDrainsExistingV2 proves a rollout rollback
// never turns into a recovery kill switch. The existing V2 operation is still
// stepped from its durable checkpoint; its response-loss path only reads
// provider history and retains the exact fence.
func TestEditRetryAdmissionDenyNewDrainsExistingV2(t *testing.T) {
	enabled, store, runtime := newHostEditRetryFixture(t)
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	runtime.mu.Lock()
	runtime.execNotDispatchedBeforeTurn = true
	runtime.mu.Unlock()
	created, err := enabled.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "deny-new-drain", ExpectedHistoryRevision: 0,
	})
	if !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("initial EditRetry() result=%#v error=%v", created, err)
	}
	operation, found, err := store.GetRuntimeOperation(t.Context(), ref.WorkspaceID, created.OperationID)
	if err != nil || !found {
		t.Fatalf("existing operation found=%v error=%v", found, err)
	}
	history, found, err := store.GetSessionHistory(t.Context(), ref.WorkspaceID, ref.AgentSessionID)
	if err != nil || !found {
		t.Fatalf("existing history found=%v error=%v", found, err)
	}
	if operation.Status != storesqlite.RuntimeOperationStatusBlocked ||
		history.RecoveryState != storesqlite.SessionHistoryRecoveryResendPending {
		t.Fatalf("existing operation=%#v history=%#v, want blocked resend-pending state", operation, history)
	}
	runtime.mu.Lock()
	rollbackBefore, execBefore, readsBefore := runtime.rollbackCalls, runtime.execCalls, runtime.historyReads
	runtime.mu.Unlock()
	denied := newDenyNewDrainEditRetryHost(store, runtime)
	if err := denied.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatalf("StepRuntimeOperationWorker() error=%v", err)
	}
	runtime.mu.Lock()
	rollbackAfter, execAfter, readsAfter := runtime.rollbackCalls, runtime.execCalls, runtime.historyReads
	runtime.mu.Unlock()
	if rollbackAfter != rollbackBefore || execAfter != execBefore || readsAfter != readsBefore {
		t.Fatalf("blocked operation touched provider: rollback %d->%d replacement %d->%d reads %d->%d", rollbackBefore, rollbackAfter, execBefore, execAfter, readsBefore, readsAfter)
	}
	availability, err := denied.GetEditRetryAvailability(t.Context(), ref)
	if err != nil || availability.OperationID != created.OperationID || availability.RecoveryState != agenthost.EditRetryStateResendPending {
		t.Fatalf("existing availability=%#v error=%v", availability, err)
	}
	runtime.mu.Lock()
	readsAfterAvailability := runtime.historyReads
	runtime.mu.Unlock()
	if readsAfterAvailability != readsAfter {
		t.Fatalf("existing durable availability called provider: reads %d->%d", readsAfter, readsAfterAvailability)
	}
	if availability.ReasonCode == agenthost.EditRetryReasonCodeRolloutDisabled {
		t.Fatalf("existing operation was hidden behind rollout policy: %#v", availability)
	}
}

// TestRecoverCoreLeavesDurableEditRetryForThePostListenerWorker proves the
// startup boundary: even a real parked edit-retry operation cannot cause a
// cold start to read, roll back, or resend through its provider. The daemon
// publishes its listener after this local pass and only then starts workers.
func TestRecoverCoreDoesNotDrainOrMutateDurableEditRetry(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}

	runtime.mu.Lock()
	runtime.execNotDispatchedBeforeTurn = true
	runtime.mu.Unlock()
	result, err := host.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-cold-start", ExpectedHistoryRevision: 0,
	})
	if !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("EditRetry() error = %v, want resend pending", err)
	}
	runtime.mu.Lock()
	rollbackBefore, execBefore, readsBefore := runtime.rollbackCalls, runtime.execCalls, runtime.historyReads
	runtime.mu.Unlock()

	if err := host.RecoverCore(t.Context()); err != nil {
		t.Fatalf("RecoverCore() error = %v", err)
	}
	operation, found, err := store.GetRuntimeOperation(t.Context(), ref.WorkspaceID, result.OperationID)
	if err != nil || !found {
		t.Fatalf("GetRuntimeOperation() found=%v error=%v", found, err)
	}
	if operation.Status != storesqlite.RuntimeOperationStatusBlocked {
		t.Fatalf("operation status = %q, want blocked", operation.Status)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.rollbackCalls != rollbackBefore || runtime.execCalls != execBefore || runtime.historyReads != readsBefore {
		t.Fatalf(
			"RecoverCore() touched provider: rollback %d->%d exec %d->%d reads %d->%d",
			rollbackBefore, runtime.rollbackCalls, execBefore, runtime.execCalls, readsBefore, runtime.historyReads,
		)
	}
}

// TestRealHostRuntimeOperationFailureIsIsolated exercises the non-scripted
// Host + SQLite fixture used by the daemon composition. A provider-unknown
// poisoned item is deferred, Step returns successfully, and the degradation is
// visible through the process-local Host summary rather than becoming a daemon
// startup/worker failure.
func TestRealHostRuntimeOperationFailureIsIsolated(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	runtime.mu.Lock()
	runtime.rollbackUnknown = true
	runtime.mu.Unlock()
	result, err := host.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-poison", ExpectedHistoryRevision: 0,
	})
	if !errors.Is(err, agenthost.ErrEditRetryInProgress) {
		t.Fatalf("EditRetry() error = %v, want ErrEditRetryInProgress", err)
	}
	beforeWake, found, err := store.GetRuntimeOperation(t.Context(), ref.WorkspaceID, result.OperationID)
	if err != nil || !found {
		t.Fatalf("GetRuntimeOperation() found=%v error=%v", found, err)
	}
	if _, changed, err := store.WakeDeferredEditRetry(t.Context(), storesqlite.WakeDeferredEditRetryInput{
		WorkspaceID: ref.WorkspaceID, OperationID: result.OperationID, ExpectedOperationVersion: beforeWake.Version,
		ExpectedHistoryRevision: int64(result.HistoryRevision), ClientActionID: "test-poison-wake", NowUnixMS: time.Now().UnixMilli(),
	}); err != nil || !changed {
		t.Fatalf("WakeDeferredEditRetry() changed=%v error=%v", changed, err)
	}
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatalf("StepRuntimeOperationWorker() error = %v, want isolated item failure", err)
	}
	summary := host.RuntimeOperationWorkerSummary()
	if summary.ItemFailures == 0 || summary.LastFailureAtMS == 0 {
		t.Fatalf("worker summary = %#v, want observable item degradation", summary)
	}
	operation, found, err := store.GetRuntimeOperation(t.Context(), ref.WorkspaceID, result.OperationID)
	if err != nil || !found || operation.Status != storesqlite.RuntimeOperationStatusPrepared || operation.NextAttemptAtMS <= time.Now().UnixMilli() {
		t.Fatalf("poison operation = %#v found=%v error=%v, want deferred prepared operation", operation, found, err)
	}
}

// TestRealHostOutboxFailureDoesNotUndoCanonicalCompletion proves with the
// actual Host and SQLite adapter that publication is a retryable after-commit
// concern. The canonical operation remains completed and its event remains
// pending for a later publisher step.
func TestRealHostOutboxFailureDoesNotUndoCanonicalCompletion(t *testing.T) {
	_, store, runtime := newHostEditRetryFixture(t)
	host := agenthost.New(agenthost.Config{
		CanonicalStore:  sqliteCanonicalStore{Store: store},
		TurnSubmissions: store, EffectiveHistory: store, RuntimeOperations: store,
		Runtime: runtime, HistoryRuntime: runtime, GoalRuntime: runtime,
		OperationOwner: "worker-outbox", OperationEvents: failingRuntimeOperationPublisher{},
	})
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	result, err := host.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-outbox", ExpectedHistoryRevision: 0,
	})
	if err != nil {
		t.Fatalf("EditRetry() error = %v", err)
	}
	op, found, err := store.GetRuntimeOperation(t.Context(), ref.WorkspaceID, result.OperationID)
	if err != nil || !found || op.Status != storesqlite.RuntimeOperationStatusCompleted {
		t.Fatalf("canonical operation = %#v found=%v error=%v, want completed", op, found, err)
	}
	events, err := store.ListPendingRuntimeOperationEvents(t.Context(), ref.WorkspaceID, 10)
	if err != nil || len(events) == 0 {
		t.Fatalf("ListPendingRuntimeOperationEvents() events=%#v error=%v, want retryable event", events, err)
	}
}

// TestRealHostSafeAbandonRefusesUnknownReplacement proves the Host-facing
// consequence of the SQLite evidence matrix: a lost replacement response is
// still session-fenced and ordinary sends cannot turn it into an implicit
// abandon. Authoritative reconciliation must happen first.
func TestRealHostSafeAbandonRefusesUnknownReplacement(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	runtime.mu.Lock()
	runtime.execOutcomeUnknown = true
	runtime.mu.Unlock()
	result, err := host.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-abandon-unknown", ExpectedHistoryRevision: 0,
	})
	if !errors.Is(err, agenthost.ErrEditRetryRecoveryRequired) {
		t.Fatalf("EditRetry() error = %v, want session-local recovery", err)
	}
	op, found, err := store.GetRuntimeOperation(t.Context(), ref.WorkspaceID, result.OperationID)
	if err != nil || !found {
		t.Fatalf("GetRuntimeOperation() found=%v error=%v", found, err)
	}
	now := time.Now().Add(2 * time.Second).UnixMilli()
	if _, changed, err := store.AbandonEditRetry(t.Context(), storesqlite.AbandonEditRetryInput{WorkspaceID: ref.WorkspaceID, OperationID: op.OperationID, LeaseOwner: "safe-abandon-test", ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: 1, ClientActionID: "host-unknown-abandon", NowUnixMS: now}); !errors.Is(err, storesqlite.ErrRuntimeOperationLeaseLost) || changed {
		t.Fatalf("AbandonEditRetry() changed=%v error=%v, want unknown replacement rejection", changed, err)
	}
	if _, err := host.SendInput(t.Context(), ref, agenthost.SendInput{Content: []agenthost.PromptContentBlock{{Type: "text", Text: "must remain fenced"}}}); !errors.Is(err, agenthost.ErrEditRetryRecoveryRequired) {
		t.Fatalf("SendInput() error = %v, want recovery-required fence", err)
	}
	availability, err := host.GetEditRetryAvailability(t.Context(), ref)
	if err != nil {
		t.Fatalf("GetEditRetryAvailability() error = %v", err)
	}
	for _, action := range availability.AvailableActions {
		if string(action) == "abandon" {
			t.Fatalf("unknown provider result exposed unsafe abandon action: %#v", availability)
		}
	}
}

// TestRecoverEditRetryCommandExposesAndExecutesOnlySafeAbandon proves the
// Host action contract: a confirmed rollback plus an authoritative provider
// non-dispatch receipt may be abandoned, while the neighboring
// unknown-replacement fixture above may not. The command has no provider side
// effect.
func TestRecoverEditRetryCommandExposesAndExecutesOnlySafeAbandon(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	runtime.mu.Lock()
	runtime.execNotDispatchedBeforeTurn = true
	runtime.mu.Unlock()
	result, err := host.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-safe-abandon", ExpectedHistoryRevision: 0,
	})
	if !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("EditRetry() error = %v, want ErrEditRetryResendPending", err)
	}
	availability, err := host.GetEditRetryAvailability(t.Context(), ref)
	if err != nil {
		t.Fatalf("GetEditRetryAvailability() error = %v", err)
	}
	if !editRetryActionPresent(availability.AvailableActions, agenthost.EditRetryRecoveryActionAbandon) {
		t.Fatalf("availability actions=%v, want safe abandon", availability.AvailableActions)
	}
	runtime.mu.Lock()
	rollbackBefore, execBefore := runtime.rollbackCalls, runtime.execCalls
	runtime.mu.Unlock()
	abandoned, err := host.RecoverEditRetryCommand(t.Context(), ref, result.OperationID, agenthost.RecoverEditRetryInput{
		Action: agenthost.EditRetryRecoveryActionAbandon, ClientActionID: "safe-abandon-action",
		ExpectedOperationVersion: availability.OperationVersion, ExpectedHistoryRevision: availability.HistoryRevision,
	})
	if err != nil || abandoned.State != agenthost.EditRetryStateCompleted {
		t.Fatalf("RecoverEditRetryCommand(abandon) result=%#v error=%v", abandoned, err)
	}
	op, found, err := store.GetRuntimeOperation(t.Context(), ref.WorkspaceID, result.OperationID)
	if err != nil || !found || op.Result != storesqlite.RuntimeOperationResultAbandoned {
		t.Fatalf("abandoned operation=%#v found=%v error=%v", op, found, err)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.rollbackCalls != rollbackBefore || runtime.execCalls != execBefore {
		t.Fatalf("safe abandon touched provider: rollback %d->%d exec %d->%d", rollbackBefore, runtime.rollbackCalls, execBefore, runtime.execCalls)
	}
}

func editRetryActionPresent(actions []agenthost.EditRetryRecoveryAction, wanted agenthost.EditRetryRecoveryAction) bool {
	for _, action := range actions {
		if action == wanted {
			return true
		}
	}
	return false
}

// TestRecoverEditRetryCommandRejectsStaleCASWithoutProviderAction exercises
// the public Host command with the real SQLite fixture. Stale values must be
// rejected at the durable boundary before reconciliation, rollback, or a
// replacement dispatch can touch the provider.
func TestRecoverEditRetryCommandRejectsStaleCASWithoutProviderAction(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	runtime.mu.Lock()
	runtime.execOutcomeUnknown = true
	runtime.mu.Unlock()
	result, err := host.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-command-stale", ExpectedHistoryRevision: 0,
	})
	if !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("EditRetry() error = %v, want ErrEditRetryResendPending", err)
	}
	op, found, err := store.GetRuntimeOperation(t.Context(), ref.WorkspaceID, result.OperationID)
	if err != nil || !found {
		t.Fatalf("GetRuntimeOperation() found=%v error=%v", found, err)
	}
	history, found, err := store.GetSessionHistory(t.Context(), ref.WorkspaceID, ref.AgentSessionID)
	if err != nil || !found {
		t.Fatalf("GetSessionHistory() found=%v error=%v", found, err)
	}
	runtime.mu.Lock()
	rollbackBefore, execBefore, readsBefore := runtime.rollbackCalls, runtime.execCalls, runtime.historyReads
	runtime.mu.Unlock()
	_, err = host.RecoverEditRetryCommand(t.Context(), ref, result.OperationID, agenthost.RecoverEditRetryInput{
		Action: agenthost.EditRetryRecoveryActionReconcile, ClientActionID: "stale-command",
		ExpectedOperationVersion: op.Version + 1, ExpectedHistoryRevision: history.Revision + 1,
	})
	if !errors.Is(err, agenthost.ErrEditRetryHistoryConflict) {
		t.Fatalf("RecoverEditRetryCommand() error = %v, want ErrEditRetryHistoryConflict", err)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.rollbackCalls != rollbackBefore || runtime.execCalls != execBefore || runtime.historyReads != readsBefore {
		t.Fatalf("stale command touched provider: rollback %d->%d exec %d->%d reads %d->%d", rollbackBefore, runtime.rollbackCalls, execBefore, runtime.execCalls, readsBefore, runtime.historyReads)
	}
}

// TestRecoverEditRetryCommandUsesDurableActionLedger verifies the Host-facing
// action ledger behavior, including idempotent replay after its CAS values are
// stale and conflict detection when the same client action ID names another
// recovery command.
func TestRecoverEditRetryCommandUsesDurableActionLedger(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	runtime.mu.Lock()
	runtime.execOutcomeUnknown = true
	runtime.mu.Unlock()
	result, err := host.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-command-idempotent", ExpectedHistoryRevision: 0,
	})
	if !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("EditRetry() error = %v, want ErrEditRetryResendPending", err)
	}
	op, found, err := store.GetRuntimeOperation(t.Context(), ref.WorkspaceID, result.OperationID)
	if err != nil || !found {
		t.Fatalf("GetRuntimeOperation() found=%v error=%v", found, err)
	}
	history, found, err := store.GetSessionHistory(t.Context(), ref.WorkspaceID, ref.AgentSessionID)
	if err != nil || !found {
		t.Fatalf("GetSessionHistory() found=%v error=%v", found, err)
	}
	input := agenthost.RecoverEditRetryInput{
		Action: agenthost.EditRetryRecoveryActionReconcile, ClientActionID: "same-client-action",
		ExpectedOperationVersion: op.Version, ExpectedHistoryRevision: history.Revision,
	}
	first, firstErr := host.RecoverEditRetryCommand(t.Context(), ref, result.OperationID, input)
	if firstErr != nil || first.State != agenthost.EditRetryStateResendPending {
		t.Fatalf("first RecoverEditRetryCommand() result=%#v error=%v, want explicit resend-pending state", first, firstErr)
	}
	runtime.mu.Lock()
	rollbackBefore, execBefore, readsBefore := runtime.rollbackCalls, runtime.execCalls, runtime.historyReads
	runtime.mu.Unlock()
	second, secondErr := host.RecoverEditRetryCommand(t.Context(), ref, result.OperationID, input)
	if secondErr != nil || second.OperationID != result.OperationID || second.State != agenthost.EditRetryStateResendPending {
		t.Fatalf("duplicate RecoverEditRetryCommand() result=%#v error=%v", second, secondErr)
	}
	runtime.mu.Lock()
	if runtime.rollbackCalls != rollbackBefore || runtime.execCalls != execBefore || runtime.historyReads != readsBefore {
		runtime.mu.Unlock()
		t.Fatalf("idempotent replay touched provider: rollback %d->%d exec %d->%d reads %d->%d", rollbackBefore, runtime.rollbackCalls, execBefore, runtime.execCalls, readsBefore, runtime.historyReads)
	}
	runtime.mu.Unlock()
	_, conflictErr := host.RecoverEditRetryCommand(t.Context(), ref, result.OperationID, agenthost.RecoverEditRetryInput{
		Action: agenthost.EditRetryRecoveryActionRetryReplacement, ClientActionID: input.ClientActionID,
		ExpectedOperationVersion: input.ExpectedOperationVersion, ExpectedHistoryRevision: input.ExpectedHistoryRevision,
	})
	if !errors.Is(conflictErr, storesqlite.ErrRuntimeOperationActionConflict) {
		t.Fatalf("same client action with another identity error = %v, want ErrRuntimeOperationActionConflict", conflictErr)
	}
}

// TestEditRetryReconcileOnlyBlocksUnknownOperationWithoutMutation is the
// emergency-mode guard. The policy changes automatic handling but never clears
// an unknown fence or calls a provider mutation.
func TestEditRetryReconcileOnlyBlocksUnknownOperationWithoutMutation(t *testing.T) {
	enabled, store, runtime := newHostEditRetryFixture(t)
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}

	// Drive a real edit-retry whose replacement dispatch never lands, leaving a
	// claimable operation parked at the resend-pending checkpoint.
	runtime.mu.Lock()
	runtime.execNotDispatchedBeforeTurn = true
	runtime.mu.Unlock()
	result, err := enabled.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-stuck", ExpectedHistoryRevision: 0,
	})
	if !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("EditRetry() error = %v, want ErrEditRetryResendPending", err)
	}
	operationID := result.OperationID
	if operationID == "" {
		t.Fatal("EditRetry() returned empty operation id")
	}

	// The stuck operation fences the session's effective history, which blocks
	// every subsequent send until the fence returns to ready.
	if history, found, herr := store.GetSessionHistory(t.Context(), "workspace-1", "session-1"); herr != nil || !found ||
		history.RecoveryState != storesqlite.SessionHistoryRecoveryResendPending {
		t.Fatalf("pre-quarantine recovery_state = %q found=%v error=%v, want %q",
			history.RecoveryState, found, herr, storesqlite.SessionHistoryRecoveryResendPending)
	}

	// Cold recovery no longer drains the operation at daemon startup.
	if recErr := enabled.RecoverCore(t.Context()); recErr != nil {
		t.Fatalf("RecoverCore(enabled) = %v, want nil", recErr)
	}

	runtime.mu.Lock()
	rollbackBefore, execBefore, readsBefore := runtime.rollbackCalls, runtime.execCalls, runtime.historyReads
	runtime.mu.Unlock()

	// Deny-new plus reconcile-only still permits listener-first recovery. Its
	// worker turns the automatic item into a blocked, fenced incident without
	// re-engaging provider mutation.
	disabled := newDisabledEditRetryHost(store, runtime)
	if recErr := disabled.RecoverCore(t.Context()); recErr != nil {
		t.Fatalf("RecoverCore(disabled) = %v, want nil (must not abort boot)", recErr)
	}

	operation, found, err := store.GetRuntimeOperation(t.Context(), "workspace-1", operationID)
	if err != nil {
		t.Fatalf("GetRuntimeOperation() error = %v", err)
	}
	if !found || operation.Status != storesqlite.RuntimeOperationStatusBlocked {
		t.Fatalf("operation status = %q found=%v, want blocked", operation.Status, found)
	}

	// The operation keeps its session fence while deferred.
	history, found, err := store.GetSessionHistory(t.Context(), "workspace-1", "session-1")
	if err != nil || !found {
		t.Fatalf("GetSessionHistory() found=%v error=%v", found, err)
	}
	if history.RecoveryState != storesqlite.SessionHistoryRecoveryResendPending {
		t.Fatalf("post-core recovery_state = %q, want fenced %q", history.RecoveryState, storesqlite.SessionHistoryRecoveryResendPending)
	}
	if err := disabled.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatalf("reconcile-only StepRuntimeOperationWorker() = %v", err)
	}
	operation, found, err = store.GetRuntimeOperation(t.Context(), "workspace-1", operationID)
	if err != nil || !found || operation.Status != storesqlite.RuntimeOperationStatusBlocked {
		t.Fatalf("disabled unknown operation=%#v found=%v error=%v, want blocked", operation, found, err)
	}
	history, found, err = store.GetSessionHistory(t.Context(), "workspace-1", "session-1")
	if err != nil || !found || history.OperationID != operationID || history.RecoveryState != storesqlite.SessionHistoryRecoveryResendPending {
		t.Fatalf("reconcile-only fence=%#v found=%v error=%v, want retained resend-pending fence", history, found, err)
	}

	// Cold recovery is local-only: it must not re-engage the provider.
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.rollbackCalls != rollbackBefore || runtime.execCalls != execBefore || runtime.historyReads != readsBefore {
		t.Fatalf(
			"reconcile-only recovery touched provider: rollback %d->%d exec %d->%d reads %d->%d",
			rollbackBefore, runtime.rollbackCalls, execBefore, runtime.execCalls, readsBefore, runtime.historyReads,
		)
	}
}

// TestEditRetryAdmissionDenyNewPreservesBlockedFenceOnSend verifies the replacement
// safety rule: an operation with unknown provider evidence remains fenced and
// cannot be abandoned implicitly by a normal send, even while the feature is
// denied. Legacy terminal failed rows are still handled by the rescue path.
func TestEditRetryAdmissionDenyNewPreservesBlockedFenceOnSend(t *testing.T) {
	enabled, store, runtime := newHostEditRetryFixture(t)
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}

	// Strand an edit-retry at resend_pending, then block it with unknown provider
	// evidence. The compound transition fences the session in the same commit.
	runtime.mu.Lock()
	runtime.execNotDispatchedBeforeTurn = true
	runtime.mu.Unlock()
	result, err := enabled.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-legacy", ExpectedHistoryRevision: 0,
	})
	if !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("EditRetry() error = %v, want ErrEditRetryResendPending", err)
	}
	operation, found, operationErr := store.GetRuntimeOperation(t.Context(), "workspace-1", result.OperationID)
	if operationErr != nil || !found || operation.Status != storesqlite.RuntimeOperationStatusBlocked {
		t.Fatalf("blocked operation=%#v found=%v error=%v", operation, found, operationErr)
	}
	if history, _, _ := store.GetSessionHistory(t.Context(), "workspace-1", "session-1"); history.RecoveryState != storesqlite.SessionHistoryRecoveryResendPending {
		t.Fatalf("recovery_state = %q, want %q", history.RecoveryState, storesqlite.SessionHistoryRecoveryResendPending)
	}

	// Guard: the enabled host's send gate rejects this state, proving SendInput
	// reaches the effective-history fence in this fixture.
	prompt := agenthost.SendInput{Content: []agenthost.PromptContentBlock{{Type: "text", Text: "hello again"}}}
	if _, sendErr := enabled.SendInput(t.Context(), ref, prompt); !errors.Is(sendErr, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("SendInput(enabled) error = %v, want ErrEditRetryResendPending", sendErr)
	}

	// Core recovery is non-fatal and cannot see the blocked operation, so the
	// fence survives until an explicit safe disposition exists.
	disabled := newDisabledEditRetryHost(store, runtime)
	if recErr := disabled.RecoverCore(t.Context()); recErr != nil {
		t.Fatalf("RecoverCore(disabled) = %v, want nil", recErr)
	}
	if history, _, _ := store.GetSessionHistory(t.Context(), "workspace-1", "session-1"); history.RecoveryState != storesqlite.SessionHistoryRecoveryResendPending {
		t.Fatalf("post-recovery recovery_state = %q, want it untouched (%q)", history.RecoveryState, storesqlite.SessionHistoryRecoveryResendPending)
	}

	if _, sendErr := disabled.SendInput(t.Context(), ref, prompt); !errors.Is(sendErr, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("SendInput(disabled) error = %v, want blocked fence preserved", sendErr)
	}
	history, found, err := store.GetSessionHistory(t.Context(), "workspace-1", "session-1")
	if err != nil || !found {
		t.Fatalf("GetSessionHistory() found=%v error=%v", found, err)
	}
	if history.RecoveryState != storesqlite.SessionHistoryRecoveryResendPending {
		t.Fatalf("post-send recovery_state = %q, want %q", history.RecoveryState, storesqlite.SessionHistoryRecoveryResendPending)
	}
}
