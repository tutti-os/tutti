package agenthost

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

const (
	editRetryMaxAttempts        = 8
	editRetryMaxAge             = 24 * time.Hour
	editRetryPersistenceTimeout = 5 * time.Second
	editRetryPersistenceRetries = 3
	editRetryPersistenceBackoff = 50 * time.Millisecond
)

type editRetryRecoveryContextKey struct{}
type editRetryClientActionContextKey struct{}
type editRetryExpectedOperationVersionContextKey struct{}
type editRetryExpectedHistoryRevisionContextKey struct{}

func withEditRetryRecoveryAction(ctx context.Context, action EditRetryRecoveryAction) context.Context {
	return context.WithValue(ctx, editRetryRecoveryContextKey{}, action)
}

func editRetryRecoveryAction(ctx context.Context) EditRetryRecoveryAction {
	action, _ := ctx.Value(editRetryRecoveryContextKey{}).(EditRetryRecoveryAction)
	return action
}
func withEditRetryClientAction(ctx context.Context, actionID string) context.Context {
	return context.WithValue(ctx, editRetryClientActionContextKey{}, actionID)
}
func editRetryClientAction(ctx context.Context) string {
	value, _ := ctx.Value(editRetryClientActionContextKey{}).(string)
	return value
}

func withEditRetryExpectedVersions(ctx context.Context, operationVersion int64, historyRevision uint64) context.Context {
	ctx = context.WithValue(ctx, editRetryExpectedOperationVersionContextKey{}, operationVersion)
	return context.WithValue(ctx, editRetryExpectedHistoryRevisionContextKey{}, historyRevision)
}

func editRetryExpectedVersions(ctx context.Context, operationVersion int64, historyRevision uint64) (int64, int64) {
	expectedOperationVersion, ok := ctx.Value(editRetryExpectedOperationVersionContextKey{}).(int64)
	if !ok || expectedOperationVersion <= 0 {
		expectedOperationVersion = operationVersion
	}
	expectedHistoryRevision, ok := ctx.Value(editRetryExpectedHistoryRevisionContextKey{}).(uint64)
	if !ok {
		expectedHistoryRevision = historyRevision
	}
	return expectedOperationVersion, int64(expectedHistoryRevision)
}

func editRetryRecoveryActionIdentity(action EditRetryRecoveryAction, operationVersion int64, historyRevision uint64) string {
	if action == EditRetryRecoveryActionAbandon {
		return fmt.Sprintf("abandon:%d:%d", operationVersion, historyRevision)
	}
	return fmt.Sprintf("wake:%s:%d:%d", action, operationVersion, historyRevision)
}

func (h *Host) GetEditRetryAvailability(ctx context.Context, ref SessionRef) (EditRetryAvailability, error) {
	ref.WorkspaceID = strings.TrimSpace(ref.WorkspaceID)
	ref.AgentSessionID = strings.TrimSpace(ref.AgentSessionID)
	if ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return EditRetryAvailability{}, ErrInvalidArgument
	}
	if h == nil || h.store == nil || h.operations == nil || h.effectiveHistory == nil ||
		h.turnSubmissions == nil || h.historyRuntime == nil || h.runtime == nil {
		return EditRetryAvailability{
			RecoveryState: EditRetryStatePrepared,
			ReasonCode:    EditRetryReasonCodeProviderUnsupported,
		}, nil
	}
	history, found, err := h.effectiveHistory.GetSessionHistory(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return EditRetryAvailability{}, err
	}
	if !found {
		return EditRetryAvailability{}, ErrSessionNotFound
	}
	result := EditRetryAvailability{
		HistoryRevision: history.Revision,
		OperationID:     history.OperationID,
	}
	var operation storesqlite.RuntimeOperation
	var operationFound bool
	if history.OperationID != "" {
		if readOperation, found, readErr := h.operations.GetRuntimeOperation(ctx, ref.WorkspaceID, history.OperationID); readErr == nil && found {
			if readOperation.WorkspaceID == ref.WorkspaceID && readOperation.AgentSessionID == ref.AgentSessionID &&
				readOperation.Kind == storesqlite.RuntimeOperationKindEditRetry && readOperation.OperationID == history.OperationID &&
				readOperation.Status != storesqlite.RuntimeOperationStatusCompleted && readOperation.Status != storesqlite.RuntimeOperationStatusFailed {
				operation, operationFound = readOperation, true
				result.OperationVersion, result.NextAttemptAtMS, result.Attempt = operation.Version, operation.NextAttemptAtMS, operation.Attempt
				result.Automatic = operation.Status == storesqlite.RuntimeOperationStatusPrepared && operation.NextAttemptAtMS > 0
			}
		}
	}
	if history.RecoveryState != storesqlite.SessionHistoryRecoveryReady && !operationFound {
		// A non-ready fence is actionable only for its exact edit-retry owner.
		// Cross-session pointers, terminal owners, and missing operations remain
		// visible as recovery_required but cannot authorize a mutation.
		result.RecoveryState = EditRetryStateRecoveryRequired
		result.ReasonCode = EditRetryReasonCodeRecoveryRequired
		result.AvailableActions = nil
		return result, nil
	}
	switch history.RecoveryState {
	case storesqlite.SessionHistoryRecoveryRollbackPending:
		result.RecoveryState = EditRetryStateRollingBack
		result.AvailableActions = []EditRetryRecoveryAction{EditRetryRecoveryActionReconcile}
	case storesqlite.SessionHistoryRecoveryResendPending:
		result.RecoveryState = EditRetryStateResendPending
		result.AvailableActions = []EditRetryRecoveryAction{EditRetryRecoveryActionReconcile}
		payload, _ := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
		if operationFound && payload.ReplacementNotDispatched && payload.RedispatchProofAt == 0 {
			result.AvailableActions = append(result.AvailableActions, EditRetryRecoveryActionRetryReplacement)
		}
		if operationFound && editRetryCanAbandon(operation) {
			result.AvailableActions = append(result.AvailableActions, EditRetryRecoveryActionAbandon)
		}
	case storesqlite.SessionHistoryRecoveryRequired:
		result.RecoveryState = EditRetryStateRecoveryRequired
		result.ReasonCode = EditRetryReasonCodeRecoveryRequired
		if operationFound && operation.Status == storesqlite.RuntimeOperationStatusBlocked {
			// A block halts automatic claims, not explicit read-only reconciliation.
			result.AvailableActions = []EditRetryRecoveryAction{EditRetryRecoveryActionReconcile}
		}
	default:
		result.RecoveryState = EditRetryStatePrepared
	}
	if history.RecoveryState == storesqlite.SessionHistoryRecoveryReady && !h.editRetryAdmission.AllowsNew() {
		// Do not probe a provider for a feature the product has not admitted.
		// This remains distinct from a provider which is genuinely unsupported.
		return EditRetryAvailability{
			HistoryRevision: history.Revision, RecoveryState: EditRetryStatePrepared,
			ReasonCode: EditRetryReasonCodeRolloutDisabled,
		}, nil
	}
	if history.RecoveryState != storesqlite.SessionHistoryRecoveryReady {
		// Recovery eligibility is entirely derived from the exact durable
		// operation/fence. An availability read must not turn into a provider
		// support probe merely because product admission for new work changed.
		if operationFound {
			result.ReasonCode = editRetryReasonFromOperation(operation)
		}
		return result, nil
	}
	session, found, err := h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return result, err
	}
	if !found {
		return result, ErrSessionNotFound
	}
	result.Supported, err = h.historyRuntime.SupportsEffectiveHistory(ctx, RuntimeHistoryInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, Provider: session.Provider,
	})
	if err != nil {
		return result, err
	}
	if !result.Supported {
		result.ReasonCode = EditRetryReasonCodeProviderUnsupported
		return result, nil
	}
	if strings.TrimSpace(session.ActiveTurnID) != "" {
		result.ReasonCode = EditRetryReasonCodeTurnNotSettled
		return result, nil
	}
	children, err := h.store.ListChildSessions(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return result, err
	}
	if len(children) != 0 {
		result.ReasonCode = EditRetryReasonCodeTurnNotLatest
		return result, nil
	}
	turns, err := h.effectiveHistory.ListEffectiveSessionTurns(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return result, err
	}
	if len(turns) == 0 {
		result.ReasonCode = EditRetryReasonCodeTurnNotFound
		return result, nil
	}
	turn := turns[len(turns)-1]
	if turn.Phase != storesqlite.TurnPhaseSettled ||
		turn.Origin != storesqlite.TurnOriginUserPrompt ||
		strings.TrimSpace(turn.RootProviderTurnID) == "" {
		result.ReasonCode = EditRetryReasonCodeTurnNotSettled
		return result, nil
	}
	envelope, found, err := h.turnSubmissions.GetTurnSubmission(ctx, ref.WorkspaceID, ref.AgentSessionID, turn.TurnID)
	if err != nil {
		return result, err
	}
	if !found {
		result.ReasonCode = EditRetryReasonCodeTurnNotFound
		return result, nil
	}
	if _, err := editRetryReplacementInput(envelope, "eligibility-probe"); err != nil {
		result.ReasonCode = EditRetryReasonCodeTurnNotFound
		return result, nil
	}
	result.Eligible = true
	result.TurnID = turn.TurnID
	result.ReasonCode = ""
	return result, nil
}

func editRetryCanAbandon(operation storesqlite.RuntimeOperation) bool {
	if operation.Kind != storesqlite.RuntimeOperationKindEditRetry ||
		(operation.Status != storesqlite.RuntimeOperationStatusPrepared && operation.Status != storesqlite.RuntimeOperationStatusBlocked) {
		return false
	}
	if operation.Status == storesqlite.RuntimeOperationStatusBlocked &&
		editRetryReasonFromOperation(operation) != EditRetryReasonCodeReplacementNotProvenAbsent {
		return false
	}
	payload, err := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	if err != nil {
		return false
	}
	return payload.Checkpoint == storesqlite.EditRetryCheckpointRollbackConfirmed ||
		(payload.Checkpoint == storesqlite.EditRetryCheckpointReplacementDispatched &&
			payload.ReplacementNotDispatched)
}

func (h *Host) EditRetry(
	ctx context.Context,
	ref SessionRef,
	turnID string,
	input EditRetryInput,
) (EditRetryResult, error) {
	ref.WorkspaceID = strings.TrimSpace(ref.WorkspaceID)
	ref.AgentSessionID = strings.TrimSpace(ref.AgentSessionID)
	if h == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return EditRetryResult{}, ErrInvalidArgument
	}
	if !h.editRetryAdmission.AllowsNew() {
		// Product rollout policy refuses before any durable operation is created.
		return EditRetryResult{}, ErrRuntimeHistoryUnsupported
	}
	var result EditRetryResult
	err := h.withSessionMutationActor(ctx, ref.WorkspaceID, ref.AgentSessionID, func(actorCtx context.Context) error {
		var commandErr error
		result, commandErr = h.editRetrySerialized(actorCtx, ref, turnID, input)
		return commandErr
	})
	return result, normalizeEditRetryBoundaryError(err)
}

// recoverEditRetry executes a CAS-bound recovery command after its public
// envelope has supplied a stable client action identity and expected durable
// versions. It is deliberately private so Host consumers cannot read fresh
// versions and bypass the action ledger before a replacement dispatch.
func (h *Host) recoverEditRetry(
	ctx context.Context,
	ref SessionRef,
	operationID string,
	action EditRetryRecoveryAction,
) (EditRetryResult, error) {
	ref.WorkspaceID = strings.TrimSpace(ref.WorkspaceID)
	ref.AgentSessionID = strings.TrimSpace(ref.AgentSessionID)
	operationID = strings.TrimSpace(operationID)
	if h == nil || h.operations == nil || h.effectiveHistory == nil ||
		ref.WorkspaceID == "" || ref.AgentSessionID == "" || operationID == "" ||
		(action != EditRetryRecoveryActionReconcile &&
			action != EditRetryRecoveryActionRetryReplacement) {
		return EditRetryResult{}, ErrInvalidArgument
	}
	var result EditRetryResult
	err := h.withSessionMutationActor(ctx, ref.WorkspaceID, ref.AgentSessionID, func(actorCtx context.Context) error {
		operation, found, readErr := h.operations.GetRuntimeOperation(actorCtx, ref.WorkspaceID, operationID)
		if readErr != nil {
			return readErr
		}
		if !found || operation.Kind != storesqlite.RuntimeOperationKindEditRetry ||
			operation.AgentSessionID != ref.AgentSessionID {
			return ErrEditRetryNotEligible
		}
		history, historyFound, historyErr := h.effectiveHistory.GetSessionHistory(
			actorCtx, ref.WorkspaceID, ref.AgentSessionID,
		)
		if historyErr != nil {
			return historyErr
		}
		expectedOperationVersion, expectedHistoryRevision := editRetryExpectedVersions(actorCtx, operation.Version, history.Revision)
		expectedIdentity := editRetryRecoveryActionIdentity(action, expectedOperationVersion, uint64(expectedHistoryRevision))
		recorded, actionFound, actionErr := h.effectiveHistory.GetRuntimeOperationRecoveryAction(actorCtx, ref.WorkspaceID, operationID, editRetryClientAction(actorCtx))
		if actionErr != nil {
			return actionErr
		}
		if actionFound {
			if recorded.ActionIdentity != expectedIdentity {
				return storesqlite.ErrRuntimeOperationActionConflict
			}
			result = editRetryResult(operation, history)
			return nil
		}
		// This is the linearization point for a public recovery command. It
		// intentionally occurs inside the session actor and before Supports /
		// ReadEffectiveHistory, so a command waiting behind another action cannot
		// inspect or act on a newer operation with stale caller versions.
		if !historyFound || history.OperationID != operationID || operation.Version != expectedOperationVersion || int64(history.Revision) != expectedHistoryRevision {
			return ErrEditRetryHistoryConflict
		}
		if operation.Status == storesqlite.RuntimeOperationStatusCompleted {
			result = editRetryResult(operation, history)
			return nil
		}
		if operation.Status == storesqlite.RuntimeOperationStatusBlocked && action == EditRetryRecoveryActionReconcile {
			reconciled, reconcileErr := h.reconcileBlockedEditRetryReadOnly(actorCtx, operation, expectedOperationVersion, expectedHistoryRevision)
			currentHistory, _, _ := h.effectiveHistory.GetSessionHistory(actorCtx, ref.WorkspaceID, ref.AgentSessionID)
			result = editRetryResult(reconciled, currentHistory)
			return reconcileErr
		}
		if operation.Status == storesqlite.RuntimeOperationStatusFailed ||
			(operation.Status == storesqlite.RuntimeOperationStatusBlocked && action != EditRetryRecoveryActionRetryReplacement) {
			result = editRetryResult(operation, history)
			return ErrEditRetryRecoveryRequired
		}
		if action == EditRetryRecoveryActionRetryReplacement {
			operation, readErr = h.authorizeEditRetryReplacementRetry(actorCtx, operation, expectedOperationVersion, expectedHistoryRevision)
			if readErr != nil {
				return readErr
			}
		} else if _, _, wakeErr := h.effectiveHistory.WakeDeferredEditRetry(actorCtx, storesqlite.WakeDeferredEditRetryInput{
			WorkspaceID: ref.WorkspaceID, OperationID: operationID,
			ExpectedOperationVersion: expectedOperationVersion, ExpectedHistoryRevision: expectedHistoryRevision,
			ClientActionID: firstNonEmpty(editRetryClientAction(actorCtx), fmt.Sprintf("recover:%s:%s:%d", operationID, action, operation.Version)),
			ActionIdentity: editRetryRecoveryActionIdentity(action, expectedOperationVersion, uint64(expectedHistoryRevision)), NowUnixMS: h.now().UnixMilli(),
		}); wakeErr != nil {
			return wakeErr
		}
		if action != EditRetryRecoveryActionRetryReplacement {
			operation, _, readErr = h.operations.GetRuntimeOperation(actorCtx, ref.WorkspaceID, operationID)
			if readErr != nil {
				return readErr
			}
		}
		processed, processErr := h.processRuntimeOperationSerialized(
			withEditRetryRecoveryAction(actorCtx, action),
			operation, false,
		)
		currentHistory, _, _ := h.effectiveHistory.GetSessionHistory(
			actorCtx, ref.WorkspaceID, ref.AgentSessionID,
		)
		result = editRetryResult(processed, currentHistory)
		return normalizeEditRetryError(processed, processErr)
	})
	return result, normalizeEditRetryBoundaryError(err)
}

// RecoverEditRetryCommand is the public CAS-bound recovery command used by
// transport adapters. Lifecycle validation remains in Host.
func (h *Host) RecoverEditRetryCommand(ctx context.Context, ref SessionRef, operationID string, input RecoverEditRetryInput) (EditRetryResult, error) {
	ref.WorkspaceID, ref.AgentSessionID, operationID = strings.TrimSpace(ref.WorkspaceID), strings.TrimSpace(ref.AgentSessionID), strings.TrimSpace(operationID)
	if h == nil || h.operations == nil || h.effectiveHistory == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" || operationID == "" ||
		strings.TrimSpace(input.ClientActionID) == "" || input.ExpectedOperationVersion <= 0 ||
		(input.Action != EditRetryRecoveryActionReconcile && input.Action != EditRetryRecoveryActionRetryReplacement && input.Action != EditRetryRecoveryActionAbandon) {
		return EditRetryResult{}, ErrInvalidArgument
	}
	if !h.editRetryRecovery.AllowsMutation() && input.Action != EditRetryRecoveryActionReconcile {
		return EditRetryResult{}, ErrEditRetryRecoveryRequired
	}
	commandCtx := withEditRetryClientAction(ctx, input.ClientActionID)
	commandCtx = withEditRetryExpectedVersions(commandCtx, input.ExpectedOperationVersion, input.ExpectedHistoryRevision)
	if input.Action == EditRetryRecoveryActionAbandon {
		return h.abandonEditRetry(commandCtx, ref, operationID, input)
	}
	result, recoverErr := h.recoverEditRetry(commandCtx, ref, operationID, input.Action)
	// A concurrent compound recovery action can win after this command's
	// initial read. Re-read only to classify that stale command as a stable CAS
	// conflict rather than leaking a transient provider/recovery disposition.
	if input.Action == EditRetryRecoveryActionRetryReplacement && (errors.Is(recoverErr, ErrEditRetryRecoveryRequired) || errors.Is(recoverErr, ErrEditRetryResendPending)) {
		if _, found, actionErr := h.effectiveHistory.GetRuntimeOperationRecoveryAction(ctx, ref.WorkspaceID, operationID, input.ClientActionID); actionErr == nil && found {
			return result, recoverErr
		}
		current, currentFound, currentErr := h.operations.GetRuntimeOperation(ctx, ref.WorkspaceID, operationID)
		currentHistory, historyFound, historyErr := h.effectiveHistory.GetSessionHistory(ctx, ref.WorkspaceID, ref.AgentSessionID)
		if currentErr == nil && historyErr == nil && currentFound && historyFound && (current.Version != input.ExpectedOperationVersion || currentHistory.Revision != input.ExpectedHistoryRevision) {
			return result, ErrEditRetryHistoryConflict
		}
	}
	return result, recoverErr
}

func (h *Host) abandonEditRetry(ctx context.Context, ref SessionRef, operationID string, input RecoverEditRetryInput) (EditRetryResult, error) {
	var result EditRetryResult
	err := h.withSessionMutationActor(ctx, ref.WorkspaceID, ref.AgentSessionID, func(actorCtx context.Context) error {
		operation, found, readErr := h.operations.GetRuntimeOperation(actorCtx, ref.WorkspaceID, operationID)
		if readErr != nil || !found || operation.Kind != storesqlite.RuntimeOperationKindEditRetry || operation.AgentSessionID != ref.AgentSessionID {
			return ErrEditRetryNotEligible
		}
		history, found, readErr := h.effectiveHistory.GetSessionHistory(actorCtx, ref.WorkspaceID, ref.AgentSessionID)
		if readErr != nil || !found {
			return ErrEditRetryHistoryConflict
		}
		expectedIdentity := editRetryRecoveryActionIdentity(input.Action, input.ExpectedOperationVersion, input.ExpectedHistoryRevision)
		recorded, actionFound, actionErr := h.effectiveHistory.GetRuntimeOperationRecoveryAction(actorCtx, ref.WorkspaceID, operationID, input.ClientActionID)
		if actionErr != nil {
			return actionErr
		}
		if actionFound {
			if recorded.ActionIdentity != expectedIdentity {
				return storesqlite.ErrRuntimeOperationActionConflict
			}
			result = editRetryResult(operation, history)
			return nil
		}
		if history.OperationID != operationID || operation.Version != input.ExpectedOperationVersion || history.Revision != input.ExpectedHistoryRevision {
			return ErrEditRetryHistoryConflict
		}
		abandoned, _, abandonErr := h.effectiveHistory.AbandonEditRetry(actorCtx, storesqlite.AbandonEditRetryInput{
			WorkspaceID: ref.WorkspaceID, OperationID: operationID,
			ExpectedOperationVersion: input.ExpectedOperationVersion, ExpectedHistoryRevision: int64(input.ExpectedHistoryRevision),
			ClientActionID: input.ClientActionID, NowUnixMS: h.now().UnixMilli(),
		})
		if abandonErr != nil {
			return abandonErr
		}
		currentHistory, _, _ := h.effectiveHistory.GetSessionHistory(actorCtx, ref.WorkspaceID, ref.AgentSessionID)
		result = editRetryResult(abandoned, currentHistory)
		return nil
	})
	return result, normalizeEditRetryBoundaryError(err)
}

func (h *Host) editRetrySerialized(
	ctx context.Context,
	ref SessionRef,
	turnID string,
	input EditRetryInput,
) (EditRetryResult, error) {
	turnID = strings.TrimSpace(turnID)
	input.ClientOperationID = strings.TrimSpace(input.ClientOperationID)
	if h.store == nil || h.operations == nil || h.effectiveHistory == nil ||
		h.turnSubmissions == nil || h.historyRuntime == nil || h.runtime == nil ||
		turnID == "" || strings.TrimSpace(input.EditedText) == "" ||
		input.ClientOperationID == "" || input.ExpectedHistoryRevision > math.MaxInt64 {
		return EditRetryResult{}, ErrInvalidArgument
	}
	history, found, err := h.effectiveHistory.GetSessionHistory(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return EditRetryResult{}, err
	}
	if !found {
		return EditRetryResult{}, ErrSessionNotFound
	}
	operationID := runtimeOperationID(
		ref.WorkspaceID, ref.AgentSessionID,
		storesqlite.RuntimeOperationKindEditRetry, input.ClientOperationID,
	)
	if existing, exists, readErr := h.operations.GetRuntimeOperation(ctx, ref.WorkspaceID, operationID); readErr != nil {
		return EditRetryResult{}, readErr
	} else if exists {
		if !editRetryRequestMatches(existing, turnID, input) {
			return editRetryResult(existing, history), ErrRuntimeOperationIdentityMismatch
		}
		if existing.Status == storesqlite.RuntimeOperationStatusCompleted {
			return editRetryResult(existing, history), nil
		}
		if existing.Status == storesqlite.RuntimeOperationStatusFailed ||
			existing.Status == storesqlite.RuntimeOperationStatusBlocked {
			return editRetryResult(existing, history), ErrEditRetryRecoveryRequired
		}
		processed, processErr := h.processRuntimeOperationSerialized(ctx, existing, false)
		currentHistory, _, _ := h.effectiveHistory.GetSessionHistory(ctx, ref.WorkspaceID, ref.AgentSessionID)
		return editRetryResult(processed, currentHistory), normalizeEditRetryError(processed, processErr)
	}
	if history.RecoveryState != storesqlite.SessionHistoryRecoveryReady {
		return EditRetryResult{}, editRetryHistoryFenceError(history.RecoveryState)
	}
	if history.Revision != input.ExpectedHistoryRevision {
		return EditRetryResult{}, ErrEditRetryHistoryConflict
	}
	_, found, err = h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return EditRetryResult{}, err
	}
	if !found {
		return EditRetryResult{}, ErrSessionNotFound
	}
	// Prepare the operation and its session fence before any provider capability
	// probe or history read. The runtime worker captures read-only pre-effect
	// evidence in a second durable checkpoint before it can write rollback
	// intent. A crash at either boundary therefore leaves a recoverable local
	// owner instead of an unrecorded external interaction.
	replacementTurnID := uuid.NewSHA1(uuid.NameSpaceURL, []byte(operationID+"\x00replacement")).String()
	payload := storesqlite.EditRetryOperationPayload{
		ClientOperationID: input.ClientOperationID,
		EditedText:        input.EditedText, ReplacementTurnID: replacementTurnID,
		ClientSubmitID:   "edit-retry:" + operationID,
		ExpectedRevision: int64(input.ExpectedHistoryRevision),
		Checkpoint:       storesqlite.EditRetryCheckpointPrepared,
		DispatchAttempt:  1,
	}
	payloadMap, err := storesqlite.EncodeEditRetryOperationPayload(payload)
	if err != nil {
		return EditRetryResult{}, err
	}
	operation, _, err := h.effectiveHistory.PrepareEditRetry(ctx, storesqlite.RuntimeOperationPrepare{
		OperationID: operationID, WorkspaceID: ref.WorkspaceID,
		AgentSessionID: ref.AgentSessionID, Kind: storesqlite.RuntimeOperationKindEditRetry,
		TurnID: turnID, RequestID: input.ClientOperationID,
		Payload: payloadMap, OccurredAtMS: h.now().UnixMilli(),
	})
	if err != nil {
		if errors.Is(err, storesqlite.ErrRuntimeOperationSubjectState) {
			return EditRetryResult{}, ErrEditRetryNotEligible
		}
		return EditRetryResult{}, err
	}
	processed, processErr := h.processRuntimeOperationSerialized(ctx, operation, false)
	currentHistory, _, _ := h.effectiveHistory.GetSessionHistory(ctx, ref.WorkspaceID, ref.AgentSessionID)
	return editRetryResult(processed, currentHistory), normalizeEditRetryError(processed, processErr)
}

func editRetryHistoryFenceError(state string) error {
	switch state {
	case storesqlite.SessionHistoryRecoveryRollbackPending:
		return ErrEditRetryInProgress
	case storesqlite.SessionHistoryRecoveryRequired:
		return ErrEditRetryRecoveryRequired
	default:
		return ErrEditRetryResendPending
	}
}

func normalizeEditRetryError(operation storesqlite.RuntimeOperation, err error) error {
	if err == nil {
		return nil
	}
	payload, _ := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	if operation.Status == storesqlite.RuntimeOperationStatusFailed {
		if payload.Checkpoint == storesqlite.EditRetryCheckpointRollbackAborted {
			return errors.Join(ErrEditRetryNotEligible, err)
		}
		return errors.Join(ErrEditRetryRecoveryRequired, err)
	}
	switch payload.Checkpoint {
	case storesqlite.EditRetryCheckpointRollbackDispatched:
		return errors.Join(ErrEditRetryInProgress, err)
	case storesqlite.EditRetryCheckpointRollbackConfirmed,
		storesqlite.EditRetryCheckpointReplacementDispatched:
		return errors.Join(ErrEditRetryResendPending, err)
	default:
		return err
	}
}

func normalizeEditRetryBoundaryError(err error) error {
	switch {
	case errors.Is(err, storesqlite.ErrRuntimeOperationConflict):
		return fmt.Errorf("%w: %v", ErrRuntimeOperationIdentityMismatch, err)
	case errors.Is(err, storesqlite.ErrRuntimeOperationSubjectState):
		return fmt.Errorf("%w: %v", ErrEditRetryNotEligible, err)
	default:
		return err
	}
}

func (h *Host) failEditRetryBeforeRollback(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
	reason storesqlite.EditRetryReasonCode,
	cause error,
) (storesqlite.RuntimeOperation, error) {
	var failed storesqlite.RuntimeOperation
	err := withEditRetryPersistenceRetry(ctx, func(persistCtx context.Context) error {
		var transitionErr error
		failed, _, transitionErr = h.effectiveHistory.AbortEditRetryRollback(persistCtx, storesqlite.AbortEditRetryRollbackInput{
			WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
			LeaseOwner: owner, ReasonCode: reason, NowUnixMS: h.now().UnixMilli(),
		})
		return transitionErr
	})
	if err != nil {
		return operation, errors.Join(cause, err)
	}
	return failed, cause
}

func (h *Host) releaseEditRetry(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
	_ storesqlite.EditRetryReasonCode,
	cause error,
) (storesqlite.RuntimeOperation, error) {
	if h.editRetryBudgetExhausted(operation) {
		return h.blockEditRetryBudget(ctx, operation, owner, cause)
	}
	var released storesqlite.RuntimeOperation
	err := withEditRetryPersistenceRetry(ctx, func(persistCtx context.Context) error {
		now := h.now()
		var transitionErr error
		released, _, transitionErr = h.effectiveHistory.DeferEditRetry(persistCtx, storesqlite.DeferEditRetryInput{
			WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID, LeaseOwner: owner,
			ReasonCode: storesqlite.EditRetryReasonRetryWait, NowUnixMS: now.UnixMilli(),
			NextAttemptAtMS: editRetryNextAttemptAt(now, operation.OperationID, operation.Attempt),
		})
		return transitionErr
	})
	if err != nil {
		return operation, errors.Join(cause, err)
	}
	return released, cause
}

func (h *Host) editRetryBudgetExhausted(operation storesqlite.RuntimeOperation) bool {
	return operation.Attempt >= editRetryMaxAttempts || h.now().Sub(time.UnixMilli(operation.CreatedAtUnixMS)) >= editRetryMaxAge
}

// editRetryPreEffectBudgetExceeded deliberately uses a strict attempt bound.
// Claim increments Attempt before Host reaches a provider boundary, so attempt
// N denotes the Nth processing lease. The Nth lease remains eligible; only a
// would-be (N+1)th provider attempt is stopped before effect. releaseEditRetry
// then turns the operation blocked after the Nth attempt's durable outcome.
func (h *Host) editRetryPreEffectBudgetExceeded(operation storesqlite.RuntimeOperation) bool {
	return operation.Attempt > editRetryMaxAttempts || h.now().Sub(time.UnixMilli(operation.CreatedAtUnixMS)) >= editRetryMaxAge
}

func (h *Host) blockEditRetryBudget(ctx context.Context, operation storesqlite.RuntimeOperation, owner string, cause error) (storesqlite.RuntimeOperation, error) {
	var blocked storesqlite.RuntimeOperation
	err := withEditRetryPersistenceRetry(ctx, func(persistCtx context.Context) error {
		var transitionErr error
		blocked, _, transitionErr = h.effectiveHistory.BlockEditRetry(persistCtx, storesqlite.BlockEditRetryInput{
			WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID, LeaseOwner: owner,
			ReasonCode: storesqlite.EditRetryReasonRetryBudgetExhausted, NowUnixMS: h.now().UnixMilli(),
		})
		return transitionErr
	})
	if err != nil {
		return operation, errors.Join(cause, err)
	}
	return blocked, errors.Join(ErrEditRetryRecoveryRequired, cause)
}

// editRetryNextAttemptAt keeps retry timing stable across a Host restart. The
// bounded, operation-scoped jitter spreads a shared provider outage without
// changing eligibility before the exponential base delay has elapsed.
func editRetryNextAttemptAt(now time.Time, operationID string, attempt int) int64 {
	if attempt < 1 {
		attempt = 1
	}
	shift := attempt - 1
	if shift > 8 {
		shift = 8
	}
	base := time.Second * time.Duration(1<<shift)
	window := base / 4
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(operationID))
	jitter := time.Duration(hash.Sum64()%uint64(window/time.Millisecond+1)) * time.Millisecond
	return now.Add(base + jitter).UnixMilli()
}

func (h *Host) failEditRetryRecovery(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
	reason storesqlite.EditRetryReasonCode,
	cause error,
) (storesqlite.RuntimeOperation, error) {
	var failed storesqlite.RuntimeOperation
	err := withEditRetryPersistenceRetry(ctx, func(persistCtx context.Context) error {
		var transitionErr error
		failed, _, transitionErr = h.effectiveHistory.BlockEditRetry(persistCtx, storesqlite.BlockEditRetryInput{
			WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
			LeaseOwner: owner, ReasonCode: reason, NowUnixMS: h.now().UnixMilli(),
		})
		return transitionErr
	})
	if err != nil {
		return operation, errors.Join(cause, err)
	}
	persistCtx, cancel := editRetryDurableTransitionContext(ctx)
	defer cancel()
	if publishErr := h.publishRuntimeOperationEvents(persistCtx, operation.WorkspaceID); publishErr != nil {
		logRuntimeOperationFailure(failed, publishErr)
	}
	return failed, errors.Join(ErrEditRetryRecoveryRequired, cause)
}

// blockEditRetryProviderRejected records an authoritative negative provider
// receipt at the same time as the blocked operation and session fence. A
// rejection is not an unknown outcome: scheduling it through releaseEditRetry
// would create an automatic retry loop and could repeatedly spend provider
// quota. Clear any prior redispatch proof because that proof authorized only
// the request that was just rejected.
func (h *Host) blockEditRetryProviderRejected(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
	payload storesqlite.EditRetryOperationPayload,
	cause error,
) (storesqlite.RuntimeOperation, error) {
	payload.ReplacementNotDispatched = true
	payload.RedispatchProofIDs = nil
	payload.RedispatchProofSID = ""
	payload.RedispatchProofAt = 0
	var blocked storesqlite.RuntimeOperation
	err := withEditRetryPersistenceRetry(ctx, func(persistCtx context.Context) error {
		var transitionErr error
		blocked, _, transitionErr = h.effectiveHistory.BlockEditRetry(persistCtx, storesqlite.BlockEditRetryInput{
			WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
			LeaseOwner: owner, ReasonCode: storesqlite.EditRetryReasonProviderRejected,
			Payload: &payload, NowUnixMS: h.now().UnixMilli(),
		})
		return transitionErr
	})
	if err != nil {
		// If the compound transition failed after the provider rejection, retain
		// the provider-call idempotency fence independently. This fallback is
		// deliberately terminal for the claim; it never releases the operation
		// into automatic retry. A later worker pass will see the rejected claim
		// and block the operation without invoking the provider again.
		if rejectErr := h.rejectSubmitClaim(
			SessionRef{WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID},
			payload.ClientSubmitID, payload.ReplacementTurnID,
		); rejectErr != nil {
			return operation, errors.Join(cause, err, rejectErr)
		}
		return operation, errors.Join(cause, err)
	}
	persistCtx, cancel := editRetryDurableTransitionContext(ctx)
	defer cancel()
	if publishErr := h.publishRuntimeOperationEvents(persistCtx, operation.WorkspaceID); publishErr != nil {
		logRuntimeOperationFailure(blocked, publishErr)
	}
	return blocked, errors.Join(ErrEditRetryRecoveryRequired, cause)
}

// blockEditRetryReplacementNotDispatched keeps a provider-negative receipt
// out of the automatic queue while preserving an explicit, CAS-bound retry or
// abandon action. The provider call did not dispatch, but the worker must not
// infer that from a future retry timestamp and spend the session budget.
func (h *Host) blockEditRetryReplacementNotDispatched(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
	payload storesqlite.EditRetryOperationPayload,
	cause error,
) (storesqlite.RuntimeOperation, error) {
	payload.ReplacementNotDispatched = true
	var blocked storesqlite.RuntimeOperation
	err := withEditRetryPersistenceRetry(ctx, func(persistCtx context.Context) error {
		var transitionErr error
		blocked, _, transitionErr = h.effectiveHistory.BlockEditRetry(persistCtx, storesqlite.BlockEditRetryInput{
			WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
			LeaseOwner: owner, ReasonCode: storesqlite.EditRetryReasonReplacementNotProvenAbsent,
			Payload: &payload, NowUnixMS: h.now().UnixMilli(),
		})
		return transitionErr
	})
	if err != nil {
		return operation, errors.Join(cause, err)
	}
	persistCtx, cancel := editRetryDurableTransitionContext(ctx)
	defer cancel()
	if publishErr := h.publishRuntimeOperationEvents(persistCtx, operation.WorkspaceID); publishErr != nil {
		logRuntimeOperationFailure(blocked, publishErr)
	}
	return blocked, errors.Join(ErrEditRetryResendPending, cause)
}

// editRetryDurableTransitionContext detaches only the final local state
// transition from a canceled provider-attempt context. Provider work never
// receives this context, and the bounded timeout prevents cleanup from
// turning into a wait or spin when SQLite remains unavailable.
func editRetryDurableTransitionContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if ctx == nil {
		return context.WithTimeout(context.Background(), editRetryPersistenceTimeout)
	}
	if ctx.Err() == nil {
		return ctx, func() {}
	}
	return context.WithTimeout(context.WithoutCancel(ctx), editRetryPersistenceTimeout)
}

// withEditRetryPersistenceRetry retries only the small local SQLite state
// transition after an edit-retry attempt. It never wraps provider work: a
// provider call has already crossed its idempotency fence before this helper
// is used. The detached, bounded context lets cancellation finish the local
// convergence without allowing a locked database to hold a worker forever.
func withEditRetryPersistenceRetry(ctx context.Context, transition func(context.Context) error) error {
	if transition == nil {
		return errors.New("edit retry persistence transition is required")
	}
	base := context.Background()
	if ctx != nil {
		base = context.WithoutCancel(ctx)
	}
	persistCtx, cancel := context.WithTimeout(base, editRetryPersistenceTimeout)
	defer cancel()

	var transitionErr error
	for attempt := 0; attempt < editRetryPersistenceRetries; attempt++ {
		transitionErr = transition(persistCtx)
		if transitionErr == nil || !isTransientEditRetryPersistenceError(transitionErr) || attempt == editRetryPersistenceRetries-1 {
			return transitionErr
		}

		delay := editRetryPersistenceBackoff * time.Duration(1<<attempt)
		timer := time.NewTimer(delay)
		select {
		case <-persistCtx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return transitionErr
		case <-timer.C:
		}
	}
	return transitionErr
}

// isTransientEditRetryPersistenceError is intentionally narrow. SQLite
// contention can be retried locally; semantic conflicts and arbitrary local
// failures must remain fail-closed so they cannot be mistaken for a provider
// outcome that is safe to replay.
func isTransientEditRetryPersistenceError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	for _, marker := range []string{
		"sqlite_busy",
		"sqlite_locked",
		"database is busy",
		"database is locked",
		"database table is locked",
		"database schema is locked",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

func editRetryInvariant(format string, args ...any) error {
	return fmt.Errorf("edit retry invariant: "+format, args...)
}
