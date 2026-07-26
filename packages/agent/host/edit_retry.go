package agenthost

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/google/uuid"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type editRetryRecoveryContextKey struct{}
type editRetryActorContextKey struct{}

func withEditRetryRecoveryAction(ctx context.Context, action EditRetryRecoveryAction) context.Context {
	return context.WithValue(ctx, editRetryRecoveryContextKey{}, action)
}

func editRetryRecoveryAction(ctx context.Context) EditRetryRecoveryAction {
	action, _ := ctx.Value(editRetryRecoveryContextKey{}).(EditRetryRecoveryAction)
	return action
}

func withEditRetryActorHeld(ctx context.Context) context.Context {
	return context.WithValue(ctx, editRetryActorContextKey{}, true)
}

func editRetryActorHeld(ctx context.Context) bool {
	held, _ := ctx.Value(editRetryActorContextKey{}).(bool)
	return held
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
	switch history.RecoveryState {
	case storesqlite.SessionHistoryRecoveryRollbackPending:
		result.RecoveryState = EditRetryStateRollingBack
		result.AvailableActions = []EditRetryRecoveryAction{EditRetryRecoveryActionReconcile}
	case storesqlite.SessionHistoryRecoveryResendPending:
		result.RecoveryState = EditRetryStateResendPending
		result.AvailableActions = []EditRetryRecoveryAction{
			EditRetryRecoveryActionReconcile,
			EditRetryRecoveryActionRetryReplacement,
		}
	case storesqlite.SessionHistoryRecoveryRequired:
		result.RecoveryState = EditRetryStateRecoveryRequired
		result.ReasonCode = EditRetryReasonCodeRecoveryRequired
	default:
		result.RecoveryState = EditRetryStatePrepared
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
	if history.RecoveryState != storesqlite.SessionHistoryRecoveryReady {
		if history.OperationID != "" {
			if operation, ok, readErr := h.operations.GetRuntimeOperation(ctx, ref.WorkspaceID, history.OperationID); readErr == nil && ok {
				result.ReasonCode = editRetryReasonFromOperation(operation)
			}
		}
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
	var result EditRetryResult
	err := h.withSessionMutationActor(ctx, ref.WorkspaceID, ref.AgentSessionID, func(actorCtx context.Context) error {
		var commandErr error
		result, commandErr = h.editRetrySerialized(actorCtx, ref, turnID, input)
		return commandErr
	})
	return result, normalizeEditRetryBoundaryError(err)
}

// RecoverEditRetry executes one explicit, typed recovery action. Reconcile is
// provider-read-only. RetryReplacement first proves absence from authoritative
// history and then consumes that proof before one replacement dispatch.
func (h *Host) RecoverEditRetry(
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
		if !historyFound || history.OperationID != operationID {
			return ErrEditRetryNotEligible
		}
		if operation.Status == storesqlite.RuntimeOperationStatusCompleted {
			result = editRetryResult(operation, history)
			return nil
		}
		if operation.Status == storesqlite.RuntimeOperationStatusFailed {
			result = editRetryResult(operation, history)
			return ErrEditRetryRecoveryRequired
		}
		processed, processErr := h.processRuntimeOperation(
			withEditRetryActorHeld(withEditRetryRecoveryAction(actorCtx, action)),
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
		if existing.Status == storesqlite.RuntimeOperationStatusFailed {
			return editRetryResult(existing, history), ErrEditRetryRecoveryRequired
		}
		processed, processErr := h.processRuntimeOperation(withEditRetryActorHeld(ctx), existing, false)
		currentHistory, _, _ := h.effectiveHistory.GetSessionHistory(ctx, ref.WorkspaceID, ref.AgentSessionID)
		return editRetryResult(processed, currentHistory), normalizeEditRetryError(processed, processErr)
	}
	if history.RecoveryState != storesqlite.SessionHistoryRecoveryReady {
		return EditRetryResult{}, editRetryHistoryFenceError(history.RecoveryState)
	}
	if history.Revision != input.ExpectedHistoryRevision {
		return EditRetryResult{}, ErrEditRetryHistoryConflict
	}
	session, found, err := h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return EditRetryResult{}, err
	}
	if !found {
		return EditRetryResult{}, ErrSessionNotFound
	}
	supported, err := h.historyRuntime.SupportsEffectiveHistory(ctx, RuntimeHistoryInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, Provider: session.Provider,
	})
	if err != nil {
		return EditRetryResult{}, err
	}
	if !supported {
		return EditRetryResult{}, ErrRuntimeHistoryUnsupported
	}
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
	operation, _, err := h.operations.PrepareRuntimeOperation(ctx, storesqlite.RuntimeOperationPrepare{
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
	processed, processErr := h.processRuntimeOperation(withEditRetryActorHeld(ctx), operation, false)
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
	failed, _, err := h.operations.ReleaseOrFailRuntimeOperation(ctx, storesqlite.ReleaseOrFailRuntimeOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
		LeaseOwner: owner, LastError: string(reason), NowUnixMS: h.now().UnixMilli(), Fail: true,
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
	reason storesqlite.EditRetryReasonCode,
	cause error,
) (storesqlite.RuntimeOperation, error) {
	now := h.now()
	released, _, err := h.operations.ReleaseOrFailRuntimeOperation(ctx, storesqlite.ReleaseOrFailRuntimeOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
		LeaseOwner: owner, LastError: string(reason), NowUnixMS: now.UnixMilli(),
		// Edit retry is fenced by stable provider identities and explicit
		// checkpoints. Keep it immediately claimable so a user-triggered
		// reconcile never waits behind generic worker backoff.
		NextAttemptAtMS: now.UnixMilli(),
	})
	if err != nil {
		return operation, errors.Join(cause, err)
	}
	return released, cause
}

func (h *Host) failEditRetryRecovery(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
	reason storesqlite.EditRetryReasonCode,
	cause error,
) (storesqlite.RuntimeOperation, error) {
	failed, _, err := h.effectiveHistory.FailEditRetryRecovery(ctx, storesqlite.FailEditRetryRecoveryInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
		LeaseOwner: owner, ReasonCode: reason, NowUnixMS: h.now().UnixMilli(),
	})
	if err != nil {
		return operation, errors.Join(cause, err)
	}
	if publishErr := h.publishRuntimeOperationEvents(ctx, operation.WorkspaceID); publishErr != nil {
		logRuntimeOperationFailure(failed, publishErr)
	}
	return failed, errors.Join(ErrEditRetryRecoveryRequired, cause)
}

func editRetryInvariant(format string, args ...any) error {
	return fmt.Errorf("edit retry invariant: "+format, args...)
}
