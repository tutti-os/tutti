package agenthost_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

func recoverEditRetryCommand(
	host *agenthost.Host,
	ctx context.Context,
	ref agenthost.SessionRef,
	operationID string,
	action agenthost.EditRetryRecoveryAction,
) (agenthost.EditRetryResult, error) {
	availability, err := host.GetEditRetryAvailability(ctx, ref)
	if err != nil {
		return agenthost.EditRetryResult{}, err
	}
	return host.RecoverEditRetryCommand(ctx, ref, operationID, agenthost.RecoverEditRetryInput{
		Action:                   action,
		ClientActionID:           fmt.Sprintf("test:%s:%s:%d:%d", operationID, action, availability.OperationVersion, availability.HistoryRevision),
		ExpectedOperationVersion: availability.OperationVersion,
		ExpectedHistoryRevision:  availability.HistoryRevision,
	})
}

func TestEditRetrySagaPreservesNonTextAndUsesDirectReceipt(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	result, err := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original",
		agenthost.EditRetryInput{
			EditedText: "edited prompt", ClientOperationID: "edit-1",
			ExpectedHistoryRevision: 0,
		},
	)
	if err != nil {
		t.Fatalf("EditRetry() error = %v", err)
	}
	if result.State != agenthost.EditRetryStateCompleted ||
		result.HistoryRevision != 2 || result.ReplacementTurnID == "" {
		t.Fatalf("EditRetry() result = %#v", result)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.rollbackCalls != 1 || runtime.execCalls != 1 || runtime.historyReads != 1 {
		t.Fatalf(
			"provider calls rollback=%d exec=%d reads=%d, want 1,1,1",
			runtime.rollbackCalls, runtime.execCalls, runtime.historyReads,
		)
	}
	if runtime.canonicalSubmitOccurredAtUnixMS <= 0 {
		t.Fatalf(
			"canonical submit occurrence time = %d, want a durable claim timestamp",
			runtime.canonicalSubmitOccurredAtUnixMS,
		)
	}
	if len(runtime.content) != 3 ||
		runtime.content[0].Text != "edited prompt" ||
		runtime.content[1].AttachmentID != "attachment-1" ||
		runtime.content[2].Path != "README.md" {
		t.Fatalf("replacement content = %#v", runtime.content)
	}
	original, found, err := store.GetTurn(t.Context(), "workspace-1", "session-1", "turn-original")
	if err != nil || !found || len(original.FileChanges) == 0 {
		t.Fatalf("audited original turn = %#v, found=%v error=%v", original, found, err)
	}
}

func TestEditRetryPreEffectProviderErrorReleasesOnlySessionFence(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.historyUnsupported = true
	runtime.mu.Unlock()
	result, err := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original",
		agenthost.EditRetryInput{EditedText: "edited prompt", ClientOperationID: "edit-provider-unsupported", ExpectedHistoryRevision: 0},
	)
	if !errors.Is(err, agenthost.ErrRuntimeHistoryUnsupported) || result.OperationID == "" {
		t.Fatalf("EditRetry() result=%#v error=%v, want provider-unsupported error with durable operation", result, err)
	}
	op, found, err := store.GetRuntimeOperation(t.Context(), "workspace-1", result.OperationID)
	if err != nil || !found || op.Status != storesqlite.RuntimeOperationStatusFailed {
		t.Fatalf("operation=%#v found=%v error=%v, want failed terminal operation", op, found, err)
	}
	history, found, err := store.GetSessionHistory(t.Context(), "workspace-1", "session-1")
	if err != nil || !found || history.RecoveryState != storesqlite.SessionHistoryRecoveryReady || history.OperationID != "" {
		t.Fatalf("session history=%#v found=%v error=%v, want ready fence", history, found, err)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.historyReads != 0 || runtime.rollbackCalls != 0 || runtime.execCalls != 0 {
		t.Fatalf("provider calls history=%d rollback=%d exec=%d, want 0/0/0", runtime.historyReads, runtime.rollbackCalls, runtime.execCalls)
	}
}

func TestEditRetryReplacementHistoryReadFailureKeepsOnlyCurrentOperationBlocked(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.execOutcomeUnknown = true
	runtime.historyReadErrorOn = 3
	runtime.historyReadError = errors.New("provider history temporarily unavailable")
	runtime.mu.Unlock()
	first, err := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original",
		agenthost.EditRetryInput{EditedText: "edited prompt", ClientOperationID: "edit-history-read-retry", ExpectedHistoryRevision: 0},
	)
	if !errors.Is(err, agenthost.ErrEditRetryRecoveryRequired) || first.OperationID == "" {
		t.Fatalf("EditRetry() result=%#v error=%v, want blocked recovery operation", first, err)
	}
	// The next read is an explicit, read-only reconciliation pass. A temporary
	// history-read failure must not turn an uncertain provider boundary into an
	// automatic retry.
	runtime.mu.Lock()
	runtime.historyReadErrorOn = runtime.historyReads + 1
	runtime.mu.Unlock()
	reconciled, reconcileErr := recoverEditRetryCommand(
		host, t.Context(), agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID, agenthost.EditRetryRecoveryActionReconcile,
	)
	if reconcileErr != nil || reconciled.State != agenthost.EditRetryStateRecoveryRequired {
		t.Fatalf("reconcile result=%#v error=%v, want blocked recovery", reconciled, reconcileErr)
	}
	op, found, err := store.GetRuntimeOperation(t.Context(), "workspace-1", first.OperationID)
	if err != nil || !found || op.Status != storesqlite.RuntimeOperationStatusBlocked || op.LeaseOwner != "" || op.NextAttemptAtMS != 0 {
		t.Fatalf("blocked operation=%#v found=%v error=%v, want no automatic retry", op, found, err)
	}
	history, found, err := store.GetSessionHistory(t.Context(), "workspace-1", "session-1")
	if err != nil || !found || history.RecoveryState != storesqlite.SessionHistoryRecoveryRequired || history.OperationID != first.OperationID {
		t.Fatalf("session history=%#v found=%v error=%v, want retained recovery fence", history, found, err)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != 1 || runtime.rollbackCalls != 1 {
		t.Fatalf("provider mutations rollback=%d exec=%d, want 1/1", runtime.rollbackCalls, runtime.execCalls)
	}
}

func TestEditRetryReconcilesProviderSuccessAfterLocalProvenanceFailure(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.provenanceError = errors.New("injected local provenance failure")
	runtime.mu.Unlock()
	first, err := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original",
		agenthost.EditRetryInput{EditedText: "edited prompt", ClientOperationID: "edit-provenance-repair", ExpectedHistoryRevision: 0},
	)
	if !errors.Is(err, agenthost.ErrEditRetryRecoveryRequired) || first.OperationID == "" {
		t.Fatalf("EditRetry() result=%#v error=%v, want session-local recovery", first, err)
	}
	runtime.mu.Lock()
	execCalls := runtime.execCalls
	runtime.mu.Unlock()
	recovered, err := recoverEditRetryCommand(
		host, t.Context(), agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID, agenthost.EditRetryRecoveryActionReconcile,
	)
	if err != nil || recovered.State != agenthost.EditRetryStateCompleted {
		t.Fatalf("reconcile result=%#v error=%v, want completed local repair", recovered, err)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != execCalls {
		t.Fatalf("reconcile redispatched provider exec=%d, want %d", runtime.execCalls, execCalls)
	}
	submission, found, err := store.GetTurnSubmission(t.Context(), "workspace-1", "session-1", recovered.ReplacementTurnID)
	if err != nil || !found || submission.ClientSubmitID != "edit-retry:"+first.OperationID || submission.DisplayPrompt != "edited prompt" {
		t.Fatalf("repaired submission=%#v found=%v error=%v", submission, found, err)
	}
}

func TestEditRetryDefersTransientPostProviderPersistenceFailure(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.provenanceError = errors.New("database is locked (5) (SQLITE_BUSY)")
	runtime.mu.Unlock()
	first, err := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original",
		agenthost.EditRetryInput{EditedText: "edited prompt", ClientOperationID: "edit-transient-store", ExpectedHistoryRevision: 0},
	)
	if !errors.Is(err, agenthost.ErrEditRetryResendPending) || first.OperationID == "" {
		t.Fatalf("EditRetry() result=%#v error=%v, want deferred resend-pending operation", first, err)
	}
	op, found, err := store.GetRuntimeOperation(t.Context(), "workspace-1", first.OperationID)
	if err != nil || !found || op.Status != storesqlite.RuntimeOperationStatusPrepared || op.LeaseOwner != "" || op.NextAttemptAtMS <= op.UpdatedAtUnixMS {
		t.Fatalf("deferred operation=%#v found=%v error=%v, want unleased future retry", op, found, err)
	}
	payload, err := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
	if err != nil || payload.Checkpoint != storesqlite.EditRetryCheckpointReplacementDispatched {
		t.Fatalf("deferred payload=%#v error=%v, want replacement_dispatched checkpoint", payload, err)
	}
	history, found, err := store.GetSessionHistory(t.Context(), "workspace-1", "session-1")
	if err != nil || !found || history.RecoveryState != storesqlite.SessionHistoryRecoveryResendPending || history.OperationID != first.OperationID {
		t.Fatalf("session history=%#v found=%v error=%v, want retained resend fence", history, found, err)
	}

	runtime.mu.Lock()
	runtime.provenanceError = nil
	execCalls := runtime.execCalls
	runtime.mu.Unlock()
	recovered, err := recoverEditRetryCommand(
		host, t.Context(), agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID, agenthost.EditRetryRecoveryActionReconcile,
	)
	if err != nil || recovered.State != agenthost.EditRetryStateCompleted {
		t.Fatalf("reconcile result=%#v error=%v, want completed without redispatch", recovered, err)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != execCalls || runtime.rollbackCalls != 1 {
		t.Fatalf("provider calls rollback=%d exec=%d, want 1 and unchanged exec=%d", runtime.rollbackCalls, runtime.execCalls, execCalls)
	}
}

func TestEditRetrySagaDoesNotRedispatchAmbiguousRollback(t *testing.T) {
	host, _, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.rollbackUnknown = true
	runtime.mu.Unlock()
	input := agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-unknown",
		ExpectedHistoryRevision: 0,
	}
	_, firstErr := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original", input,
	)
	if !errors.Is(firstErr, agenthost.ErrEditRetryInProgress) {
		t.Fatalf("first EditRetry() error = %v", firstErr)
	}
	_, secondErr := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original", input,
	)
	if !errors.Is(secondErr, agenthost.ErrEditRetryInProgress) {
		t.Fatalf("second EditRetry() error = %v", secondErr)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.rollbackCalls != 1 || runtime.execCalls != 0 {
		t.Fatalf("provider calls rollback=%d exec=%d, want 1,0", runtime.rollbackCalls, runtime.execCalls)
	}
}

func TestEditRetryFenceBlocksOrdinarySendButAllowsTypedGoalControl(t *testing.T) {
	host, _, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.rollbackUnknown = true
	runtime.mu.Unlock()
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	if _, err := host.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-fence", ExpectedHistoryRevision: 0,
	}); !errors.Is(err, agenthost.ErrEditRetryInProgress) {
		t.Fatalf("EditRetry() error = %v, want ErrEditRetryInProgress", err)
	}
	if _, err := host.SendInput(t.Context(), ref, agenthost.SendInput{
		Content: []agenthost.PromptContentBlock{{Type: "text", Text: "ordinary send"}},
	}); !errors.Is(err, agenthost.ErrEditRetryInProgress) {
		t.Fatalf("ordinary SendInput() error = %v, want ErrEditRetryInProgress", err)
	}
	result, err := host.SendInput(t.Context(), ref, agenthost.SendInput{
		Content: []agenthost.PromptContentBlock{{Type: "text", Text: "/goal pause"}},
	})
	if err != nil {
		t.Fatalf("typed goal SendInput() error = %v", err)
	}
	if result.Kind != "goalControl" || result.GoalControl == nil {
		t.Fatalf("typed goal SendInput() result = %#v", result)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.goalControlCalls != 1 {
		t.Fatalf("goal-control calls = %d, want 1", runtime.goalControlCalls)
	}
}

func TestEditRetrySagaReconcilesAcceptedReplacementAfterResponseLoss(t *testing.T) {
	host, _, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.execOutcomeUnknown = true
	runtime.execOutcomeUnknownAccepted = true
	runtime.mu.Unlock()
	first, err := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original",
		agenthost.EditRetryInput{
			EditedText: "edited prompt", ClientOperationID: "edit-response-loss",
			ExpectedHistoryRevision: 0,
		},
	)
	if !errors.Is(err, agenthost.ErrEditRetryRecoveryRequired) {
		t.Fatalf("EditRetry() error = %v, want session-local recovery", err)
	}
	if first.OperationID == "" {
		t.Fatalf("EditRetry() result = %#v, want durable operation", first)
	}
	if first.State != agenthost.EditRetryStateRecoveryRequired || first.ReasonCode != agenthost.EditRetryReasonCodeProviderOutcomeUnknown {
		t.Fatalf("EditRetry() result = %#v, want blocked provider-outcome-unknown recovery", first)
	}
	if err := host.StepRuntimeOperationWorker(t.Context(), true); err != nil {
		t.Fatalf("StepRuntimeOperationWorker() error = %v", err)
	}
	runtime.mu.Lock()
	if runtime.execCalls != 1 {
		runtime.mu.Unlock()
		t.Fatalf("automatic worker redispatched unknown replacement: execCalls=%d", runtime.execCalls)
	}
	runtime.mu.Unlock()
	recovered, err := recoverEditRetryCommand(
		host,
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionReconcile,
	)
	if err != nil {
		t.Fatalf("RecoverEditRetryCommand(reconcile) error = %v", err)
	}
	if recovered.State != agenthost.EditRetryStateCompleted {
		t.Fatalf("RecoverEditRetryCommand(reconcile) result = %#v, want completed", recovered)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != 1 || runtime.reconcileAcceptanceCalls != 1 {
		t.Fatalf(
			"provider exec=%d acceptance reconciles=%d, want 1/1",
			runtime.execCalls,
			runtime.reconcileAcceptanceCalls,
		)
	}
	if got, want := runtime.reconcileAcceptanceInput.RootTurnID, recovered.ReplacementTurnID; got != want {
		t.Fatalf("acceptance root turn id = %q, want %q", got, want)
	}
	if got, want := runtime.reconcileAcceptanceInput.ClientUserMessageID, "edit-retry:"+first.OperationID; got != want {
		t.Fatalf("acceptance client user message id = %q, want %q", got, want)
	}
	if runtime.reconcileAcceptanceInput.ClientUserMessageID == runtime.reconcileAcceptanceInput.RootTurnID {
		t.Fatal("provider correlation identity reused canonical replacement turn id")
	}
}

func TestEditRetrySagaRetriesReplacementOnlyAfterAuthoritativeAbsence(t *testing.T) {
	host, _, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.execOutcomeUnknown = true
	runtime.mu.Unlock()
	first, err := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original",
		agenthost.EditRetryInput{
			EditedText: "edited prompt", ClientOperationID: "edit-absent",
			ExpectedHistoryRevision: 0,
		},
	)
	if !errors.Is(err, agenthost.ErrEditRetryRecoveryRequired) {
		t.Fatalf("EditRetry() error = %v, want session-local recovery", err)
	}
	reconciled, err := recoverEditRetryCommand(
		host,
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionReconcile,
	)
	if err != nil || reconciled.State != agenthost.EditRetryStateResendPending {
		t.Fatalf("reconcile result=%#v error=%v, want explicit resend-pending state", reconciled, err)
	}
	runtime.mu.Lock()
	if runtime.execCalls != 1 {
		t.Fatalf("reconcile exec calls = %d, want 1", runtime.execCalls)
	}
	runtime.mu.Unlock()
	retried, err := recoverEditRetryCommand(
		host,
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionRetryReplacement,
	)
	if err != nil {
		t.Fatalf("retry replacement error = %v", err)
	}
	if retried.State != agenthost.EditRetryStateCompleted {
		t.Fatalf("retry replacement result = %#v, want completed", retried)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != 2 || runtime.rollbackCalls != 1 {
		t.Fatalf(
			"provider exec=%d rollback=%d, want 2/1",
			runtime.execCalls,
			runtime.rollbackCalls,
		)
	}
}

func TestEditRetrySagaCanRetryReplacementAfterSecondAuthoritativeAbsence(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.execOutcomeUnknown = true
	runtime.mu.Unlock()
	first, err := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original",
		agenthost.EditRetryInput{
			EditedText: "edited prompt", ClientOperationID: "edit-absent-twice",
			ExpectedHistoryRevision: 0,
		},
	)
	if !errors.Is(err, agenthost.ErrEditRetryRecoveryRequired) {
		t.Fatalf("EditRetry() error = %v, want session-local recovery", err)
	}
	reconciled, err := recoverEditRetryCommand(
		host,
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionReconcile,
	)
	if err != nil || reconciled.State != agenthost.EditRetryStateResendPending {
		t.Fatalf("first reconcile result=%#v error=%v, want explicit resend-pending state", reconciled, err)
	}
	runtime.mu.Lock()
	runtime.execOutcomeUnknown = true
	runtime.mu.Unlock()
	if _, err := recoverEditRetryCommand(
		host,
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionRetryReplacement,
	); !errors.Is(err, agenthost.ErrEditRetryRecoveryRequired) {
		t.Fatalf("first retry error = %v, want session-local recovery", err)
	}
	reconciled, err = recoverEditRetryCommand(
		host,
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionReconcile,
	)
	if err != nil || reconciled.State != agenthost.EditRetryStateResendPending {
		t.Fatalf("second reconcile result=%#v error=%v, want explicit resend-pending state", reconciled, err)
	}
	retried, err := recoverEditRetryCommand(
		host,
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionRetryReplacement,
	)
	if err != nil || retried.State != agenthost.EditRetryStateCompleted {
		t.Fatalf("second retry result = %#v error=%v, want completed", retried, err)
	}
	operation, found, err := store.GetRuntimeOperation(
		t.Context(), "workspace-1", first.OperationID,
	)
	if err != nil || !found {
		t.Fatalf("GetRuntimeOperation() found=%v error=%v", found, err)
	}
	payload, err := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	if err != nil || payload.DispatchAttempt != 3 {
		t.Fatalf("replacement dispatch attempt=%d error=%v, want 3", payload.DispatchAttempt, err)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != 3 || runtime.rollbackCalls != 1 {
		t.Fatalf(
			"provider exec=%d rollback=%d, want 3/1",
			runtime.execCalls,
			runtime.rollbackCalls,
		)
	}
}

func TestEditRetrySagaRetriesDefinitivelyNotDispatchedReplacement(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.execNotDispatchedBeforeTurn = true
	runtime.mu.Unlock()
	first, err := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original",
		agenthost.EditRetryInput{
			EditedText: "edited prompt", ClientOperationID: "edit-not-dispatched",
			ExpectedHistoryRevision: 0,
		},
	)
	if !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("EditRetry() error = %v, want resend pending", err)
	}
	blocked, found, err := store.GetRuntimeOperation(t.Context(), "workspace-1", first.OperationID)
	if err != nil || !found || blocked.Status != storesqlite.RuntimeOperationStatusBlocked || blocked.NextAttemptAtMS != 0 {
		t.Fatalf("not-dispatched operation=%#v found=%v error=%v, want non-claimable blocked state", blocked, found, err)
	}
	if err := host.StepRuntimeOperationWorker(t.Context(), true); err != nil {
		t.Fatalf("blocked operation worker step error = %v", err)
	}
	afterWorker, found, err := store.GetRuntimeOperation(t.Context(), "workspace-1", first.OperationID)
	if err != nil || !found || afterWorker.Attempt != blocked.Attempt {
		t.Fatalf("worker changed blocked operation=%#v found=%v error=%v", afterWorker, found, err)
	}
	retried, err := recoverEditRetryCommand(
		host,
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionRetryReplacement,
	)
	if err != nil {
		t.Fatalf("retry replacement error = %v", err)
	}
	if retried.State != agenthost.EditRetryStateCompleted {
		t.Fatalf("retry replacement result = %#v, want completed", retried)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != 2 || runtime.rollbackCalls != 1 {
		t.Fatalf(
			"provider exec=%d rollback=%d, want 2/1",
			runtime.execCalls,
			runtime.rollbackCalls,
		)
	}
}

func TestEditRetrySagaBlocksExplicitProviderRejection(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.execRejected = true
	runtime.mu.Unlock()
	first, err := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original",
		agenthost.EditRetryInput{
			EditedText: "edited prompt", ClientOperationID: "edit-provider-rejected",
			ExpectedHistoryRevision: 0,
		},
	)
	if !errors.Is(err, agenthost.ErrEditRetryRecoveryRequired) {
		t.Fatalf("EditRetry() error = %v, want recovery required", err)
	}
	operation, found, err := store.GetRuntimeOperation(t.Context(), "workspace-1", first.OperationID)
	if err != nil || !found {
		t.Fatalf("GetRuntimeOperation() found=%v error=%v", found, err)
	}
	if operation.Status != storesqlite.RuntimeOperationStatusBlocked ||
		operation.LastError != string(storesqlite.EditRetryReasonProviderRejected) ||
		operation.NextAttemptAtMS != 0 || operation.LeaseOwner != "" {
		t.Fatalf("blocked operation = %#v, want provider-rejected blocked state", operation)
	}
	payload, err := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	if err != nil || payload.Checkpoint != storesqlite.EditRetryCheckpointReplacementDispatched ||
		!payload.ReplacementNotDispatched || payload.RedispatchProofAt != 0 {
		t.Fatalf("rejection payload = %#v error=%v, want negative receipt without stale proof", payload, err)
	}
	history, found, err := store.GetSessionHistory(t.Context(), "workspace-1", "session-1")
	if err != nil || !found || history.RecoveryState != storesqlite.SessionHistoryRecoveryRequired || history.OperationID != first.OperationID {
		t.Fatalf("session history = %#v found=%v error=%v, want recovery-required fence", history, found, err)
	}
	if err := host.StepRuntimeOperationWorker(t.Context(), true); err != nil {
		t.Fatalf("StepRuntimeOperationWorker() error = %v", err)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != 1 || runtime.rollbackCalls != 1 {
		t.Fatalf("provider calls rollback=%d exec=%d, want 1/1 with no automatic retry", runtime.rollbackCalls, runtime.execCalls)
	}
}

func newHostEditRetryFixture(t *testing.T) (*agenthost.Host, *storesqlite.Store, *hostEditRetryRuntime) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "edit-retry.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		Kind: storesqlite.SessionKindRoot, Provider: "codex",
		ProviderSessionID: "thread-1", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(t.Context(), storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			Kind: storesqlite.SessionKindRoot, Provider: "codex",
			ProviderSessionID: "thread-1", OccurredAtUnixMS: 2,
		},
		Turn: &storesqlite.TurnTransition{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			TurnID: "turn-original", Phase: storesqlite.TurnPhaseRunning,
			Origin: storesqlite.TurnOriginUserPrompt, StartedAtUnixMS: 2, OccurredAtUnixMS: 2,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID: "workspace-1", RootAgentSessionID: "session-1",
			RootTurnID: "turn-original", ProviderTurnID: "provider-original",
			Phase: storesqlite.RootProviderTurnPhaseRunning, OccurredAtUnixMS: 2,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(t.Context(), storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			Kind: storesqlite.SessionKindRoot, Provider: "codex",
			ProviderSessionID: "thread-1", OccurredAtUnixMS: 3,
		},
		Turn: &storesqlite.TurnTransition{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			TurnID: "turn-original", Phase: storesqlite.TurnPhaseSettled,
			Outcome: storesqlite.TurnOutcomeCompleted, Origin: storesqlite.TurnOriginUserPrompt,
			FileChanges:     map[string]any{"files": []any{"changed.txt"}},
			SettledAtUnixMS: 3, OccurredAtUnixMS: 3,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID: "workspace-1", RootAgentSessionID: "session-1",
			RootTurnID: "turn-original", ProviderTurnID: "provider-original",
			Phase:   storesqlite.RootProviderTurnPhaseCompleted,
			Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 3,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RecordTurnSubmission(t.Context(), storesqlite.TurnSubmission{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-original",
		ContentJSON:   `[{"type":"text","text":"original"},{"type":"image","mimeType":"image/png","attachmentId":"attachment-1"},{"type":"mention","name":"README","path":"README.md"}]`,
		DisplayPrompt: "original", CapabilityRefsJSON: `[]`,
		TuttiModeSnapshotJSON: `null`, ClientSubmitID: "submit-original",
		CreatedAtUnixMS: 3, UpdatedAtUnixMS: 3,
	}); err != nil {
		t.Fatal(err)
	}
	runtime := &hostEditRetryRuntime{
		store: store, providerTurns: []agenthost.RuntimeHistoryTurn{{ID: "provider-original"}},
	}
	host := agenthost.New(agenthost.Config{
		CanonicalStore:  sqliteCanonicalStore{Store: store},
		TurnSubmissions: store, EffectiveHistory: store, RuntimeOperations: store,
		Runtime: runtime, HistoryRuntime: runtime, GoalRuntime: runtime, OperationOwner: "worker-1",
	})
	return host, store, runtime
}

type hostEditRetryRuntime struct {
	mu                          sync.Mutex
	store                       *storesqlite.Store
	providerTurns               []agenthost.RuntimeHistoryTurn
	rollbackCalls               int
	rollbackNotDispatched       bool
	execCalls                   int
	historyReads                int
	historyReadStarted          chan struct{}
	historyReadRelease          <-chan struct{}
	historyReadError            error
	historyReadErrorOn          int
	rollbackUnknown             bool
	rollbackUnknownApplied      bool
	execOutcomeUnknown          bool
	execOutcomeUnknownAccepted  bool
	execNotDispatchedBeforeTurn bool
	execRejected                bool
	afterExec                   func() error
	afterRollback               func() error
	rollbackLedger              *rollbackMutationLedger
	replacementLedger           *replacementMutationLedger
	reconcileAcceptanceCalls    int
	reconcileAcceptanceInput    agenthost.RuntimeProviderTurnAcceptanceInput
	goalControlCalls            int
	cancelCalls                 map[string]int
	cancelErrors                map[string]error
	content                     []agenthost.PromptContentBlock

	canonicalSubmitOccurredAtUnixMS int64
	provenanceError                 error
	historyUnsupported              bool
}

func (*hostEditRetryRuntime) Start(context.Context, agenthost.RuntimeStartInput) (agenthost.ProviderRuntimeSession, error) {
	return agenthost.ProviderRuntimeSession{}, nil
}
func (r *hostEditRetryRuntime) Resume(context.Context, agenthost.RuntimeResumeInput) (agenthost.ProviderRuntimeSession, error) {
	return r.session(), nil
}
func (r *hostEditRetryRuntime) Session(string, string) (agenthost.ProviderRuntimeSession, bool) {
	return r.session(), true
}
func (*hostEditRetryRuntime) session() agenthost.ProviderRuntimeSession {
	return agenthost.ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex",
		ProviderSessionID: "thread-1", InitialTitleEstablished: true,
	}
}
func (*hostEditRetryRuntime) CanResume(agenthost.RuntimeResumeInput) bool { return true }
func (r *hostEditRetryRuntime) Exec(ctx context.Context, input agenthost.RuntimeExecInput) (agenthost.RuntimeExecResult, error) {
	r.mu.Lock()
	r.execCalls++
	r.content = append([]agenthost.PromptContentBlock(nil), input.Content...)
	r.canonicalSubmitOccurredAtUnixMS = input.CanonicalSubmitOccurredAtUnixMS
	providerTurnID := "provider-" + input.TurnID
	outcomeUnknown := r.execOutcomeUnknown
	outcomeUnknownAccepted := r.execOutcomeUnknownAccepted
	notDispatchedBeforeTurn := r.execNotDispatchedBeforeTurn
	rejected := r.execRejected
	afterExec := r.afterExec
	r.execOutcomeUnknown = false
	r.execOutcomeUnknownAccepted = false
	r.execNotDispatchedBeforeTurn = false
	r.execRejected = false
	if !outcomeUnknown || outcomeUnknownAccepted {
		if !notDispatchedBeforeTurn && !rejected {
			r.providerTurns = append(r.providerTurns, agenthost.RuntimeHistoryTurn{
				ID: providerTurnID, ClientUserMessageID: input.ClientSubmitID,
			})
			if r.replacementLedger != nil && input.HistoryReplacement {
				r.replacementLedger.Record(input.ClientSubmitID)
			}
		}
	}
	r.mu.Unlock()
	if rejected {
		return agenthost.RuntimeExecResult{
			ProviderDispatch: agenthost.RuntimeProviderDispatchResult{
				Disposition: agenthost.RuntimeDispatchDispositionRejected,
			},
		}, errors.New("provider rejected turn/start")
	}
	if notDispatchedBeforeTurn {
		return agenthost.RuntimeExecResult{
			ProviderDispatch: agenthost.RuntimeProviderDispatchResult{
				Disposition: agenthost.RuntimeDispatchDispositionNotDispatched,
			},
		}, errors.New("turn/start was not dispatched")
	}
	if _, _, err := r.store.RecordTurnTransition(ctx, storesqlite.TurnTransition{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		TurnID: input.TurnID, Phase: storesqlite.TurnPhaseSubmitted,
		Origin: storesqlite.TurnOriginUserPrompt, OccurredAtUnixMS: 10,
	}); err != nil {
		return agenthost.RuntimeExecResult{}, err
	}
	if outcomeUnknown {
		if !outcomeUnknownAccepted {
			if _, _, settleErr := r.store.RecordTurnTransition(
				ctx,
				storesqlite.TurnTransition{
					WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
					TurnID: input.TurnID, Phase: storesqlite.TurnPhaseSettled,
					Outcome: storesqlite.TurnOutcomeFailed,
					Origin:  storesqlite.TurnOriginUserPrompt, OccurredAtUnixMS: 11,
				},
			); settleErr != nil {
				return agenthost.RuntimeExecResult{}, settleErr
			}
		}
		return agenthost.RuntimeExecResult{
			TurnID: input.TurnID,
			ProviderDispatch: agenthost.RuntimeProviderDispatchResult{
				Disposition: agenthost.RuntimeDispatchDispositionOutcomeUnknown,
			},
		}, errors.New("turn/start response lost")
	}
	if _, err := r.store.ReportActivityState(ctx, storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
			Kind: storesqlite.SessionKindRoot, Provider: "codex",
			ProviderSessionID: "thread-1", OccurredAtUnixMS: 11,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID: input.WorkspaceID, RootAgentSessionID: input.AgentSessionID,
			RootTurnID: input.TurnID, ProviderTurnID: providerTurnID,
			Phase: storesqlite.RootProviderTurnPhaseRunning, OccurredAtUnixMS: 11,
		},
	}); err != nil {
		return agenthost.RuntimeExecResult{}, err
	}
	if afterExec != nil {
		if err := afterExec(); err != nil {
			return agenthost.RuntimeExecResult{}, err
		}
	}
	return agenthost.RuntimeExecResult{
		TurnID: input.TurnID,
		ProviderDispatch: agenthost.RuntimeProviderDispatchResult{
			Disposition: agenthost.RuntimeDispatchDispositionApplied,
			Acceptance: &agenthost.RuntimeProviderAcceptanceReceipt{
				ProviderSessionID: "thread-1", ProviderTurnID: providerTurnID,
				Source: agenthost.RuntimeAcceptanceSourceTurnStartResponse,
			},
		},
	}, nil
}
func (r *hostEditRetryRuntime) ReconcileProviderTurnAcceptance(
	ctx context.Context,
	input agenthost.RuntimeProviderTurnAcceptanceInput,
) error {
	r.mu.Lock()
	r.reconcileAcceptanceCalls++
	r.reconcileAcceptanceInput = input
	r.mu.Unlock()
	_, err := r.store.ReportActivityState(ctx, storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
			Kind: storesqlite.SessionKindRoot, Provider: input.Provider,
			ProviderSessionID: input.ExpectedProviderSessionID, OccurredAtUnixMS: 12,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID: input.WorkspaceID, RootAgentSessionID: input.AgentSessionID,
			RootTurnID: input.RootTurnID, ProviderTurnID: input.ExpectedProviderTurnID,
			Phase: storesqlite.RootProviderTurnPhaseRunning, OccurredAtUnixMS: 12,
		},
	})
	return err
}
func (*hostEditRetryRuntime) ValidatePromptContent(context.Context, agenthost.RuntimeExecInput) error {
	return nil
}
func (r *hostEditRetryRuntime) DurablyReportSubmitProvenance(_ context.Context, input agenthost.RuntimeSubmitProvenanceInput) error {
	if input.CanonicalSubmitOccurredAtUnixMS <= 0 {
		return errors.New("canonical submit occurrence time is required")
	}
	r.mu.Lock()
	if err := r.provenanceError; err != nil {
		r.mu.Unlock()
		return err
	}
	r.canonicalSubmitOccurredAtUnixMS = input.CanonicalSubmitOccurredAtUnixMS
	r.mu.Unlock()
	return nil
}
func (r *hostEditRetryRuntime) GoalControl(context.Context, agenthost.RuntimeGoalControlInput) (agenthost.RuntimeGoalControlResult, error) {
	r.mu.Lock()
	r.goalControlCalls++
	r.mu.Unlock()
	return agenthost.RuntimeGoalControlResult{}, nil
}
func (r *hostEditRetryRuntime) Cancel(_ context.Context, input agenthost.RuntimeCancelInput) (agenthost.RuntimeCancelResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancelCalls == nil {
		r.cancelCalls = make(map[string]int)
	}
	r.cancelCalls[input.RootAgentSessionID]++
	return agenthost.RuntimeCancelResult{}, r.cancelErrors[input.RootAgentSessionID]
}
func (*hostEditRetryRuntime) SubmitInteractive(context.Context, agenthost.RuntimeSubmitInteractiveInput) (agenthost.RuntimeSubmitInteractiveResult, error) {
	return agenthost.RuntimeSubmitInteractiveResult{}, nil
}
func (*hostEditRetryRuntime) InteractiveDisposition(string, string, string, string, string) agenthost.RuntimeInteractiveDisposition {
	return agenthost.RuntimeInteractiveDispositionUnknown
}
func (*hostEditRetryRuntime) UpdateSettings(context.Context, agenthost.RuntimeUpdateSettingsInput) error {
	return nil
}
func (r *hostEditRetryRuntime) SetTitle(context.Context, agenthost.RuntimeSetTitleInput) (agenthost.ProviderRuntimeSession, error) {
	return r.session(), nil
}
func (r *hostEditRetryRuntime) SetVisible(context.Context, agenthost.RuntimeSetVisibleInput) (agenthost.ProviderRuntimeSession, error) {
	return r.session(), nil
}
func (*hostEditRetryRuntime) Close(context.Context, agenthost.RuntimeCloseInput) error { return nil }
func (r *hostEditRetryRuntime) SupportsEffectiveHistory(context.Context, agenthost.RuntimeHistoryInput) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return !r.historyUnsupported, nil
}
func (r *hostEditRetryRuntime) ReadEffectiveHistory(ctx context.Context, _ agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistorySnapshot, error) {
	r.mu.Lock()
	r.historyReads++
	readNumber := r.historyReads
	readErr := r.historyReadError
	started, release := r.historyReadStarted, r.historyReadRelease
	snapshot := agenthost.RuntimeHistorySnapshot{
		ProviderSessionID: "thread-1",
		Turns:             append([]agenthost.RuntimeHistoryTurn(nil), r.providerTurns...),
	}
	r.mu.Unlock()
	if readErr != nil && readNumber == r.historyReadErrorOn {
		return agenthost.RuntimeHistorySnapshot{}, readErr
	}
	if started != nil {
		select {
		case started <- struct{}{}:
		default:
		}
	}
	if release != nil {
		select {
		case <-release:
		case <-ctx.Done():
			return agenthost.RuntimeHistorySnapshot{}, ctx.Err()
		}
	}
	return snapshot, nil
}
func (r *hostEditRetryRuntime) RollbackLatestTurn(context.Context, agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistoryMutationResult, error) {
	r.mu.Lock()
	r.rollbackCalls++
	notDispatched, unknown, unknownApplied := r.rollbackNotDispatched, r.rollbackUnknown, r.rollbackUnknownApplied
	afterRollback, ledger := r.afterRollback, r.rollbackLedger
	r.rollbackNotDispatched, r.rollbackUnknown, r.rollbackUnknownApplied = false, false, false
	if notDispatched {
		r.mu.Unlock()
		if afterRollback != nil {
			if err := afterRollback(); err != nil {
				return agenthost.RuntimeHistoryMutationResult{}, err
			}
		}
		return agenthost.RuntimeHistoryMutationResult{Disposition: agenthost.RuntimeDispatchDispositionNotDispatched}, errors.New("rollback was not dispatched")
	}
	if unknown {
		if unknownApplied {
			r.providerTurns = r.providerTurns[:len(r.providerTurns)-1]
			if ledger != nil {
				ledger.Record()
			}
		}
		r.mu.Unlock()
		if afterRollback != nil {
			if err := afterRollback(); err != nil {
				return agenthost.RuntimeHistoryMutationResult{}, err
			}
		}
		return agenthost.RuntimeHistoryMutationResult{
			Disposition: agenthost.RuntimeDispatchDispositionOutcomeUnknown,
		}, errors.New("rollback response lost")
	}
	r.providerTurns = r.providerTurns[:len(r.providerTurns)-1]
	if ledger != nil {
		ledger.Record()
	}
	snapshot := agenthost.RuntimeHistorySnapshot{
		ProviderSessionID: "thread-1",
		Turns:             append([]agenthost.RuntimeHistoryTurn(nil), r.providerTurns...),
	}
	r.mu.Unlock()
	if afterRollback != nil {
		if err := afterRollback(); err != nil {
			return agenthost.RuntimeHistoryMutationResult{}, err
		}
	}
	return agenthost.RuntimeHistoryMutationResult{
		Disposition: agenthost.RuntimeDispatchDispositionApplied, Snapshot: &snapshot,
	}, nil
}
