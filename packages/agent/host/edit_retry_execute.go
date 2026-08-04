package agenthost

import (
	"context"
	"errors"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func (h *Host) executeEditRetryRuntimeOperation(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
	recovering bool,
) (storesqlite.RuntimeOperation, error) {
	// Claim increments Attempt before Host reaches a provider boundary. The
	// configured eighth lease is still the final permitted attempt; only a
	// would-be ninth attempt is blocked before a provider read or mutation.
	if h.editRetryPreEffectBudgetExceeded(operation) {
		return h.blockEditRetryBudget(ctx, operation, owner, ErrEditRetryRecoveryRequired)
	}
	payload, err := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	if err != nil {
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict, err,
		)
	}
	if payload.SagaVersion != storesqlite.EditRetrySagaVersionCurrent {
		// V1 has been migrated to either a terminal no-effect record or a
		// blocked incident. A direct caller must not revive it around the claim
		// query and reach a provider boundary.
		if h.effectiveHistory == nil {
			return operation, ErrEditRetryRecoveryRequired
		}
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict,
			editRetryInvariant("unsupported edit retry saga version %d", payload.SagaVersion),
		)
	}
	history, foundHistory, historyErr := h.effectiveHistory.GetSessionHistory(
		ctx, operation.WorkspaceID, operation.AgentSessionID,
	)
	if historyErr != nil || !foundHistory || history.OperationID != operation.OperationID ||
		history.RecoveryState == storesqlite.SessionHistoryRecoveryReady {
		// Legacy prepared rows may predate the compound prepare fence. They are
		// never eligible for an automatic provider mutation after restart; block
		// them while atomically restoring this operation as the session owner.
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonLocalStateInconsistent,
			editRetryInvariant("prepared edit retry is missing its session fence"),
		)
	}
	envelope, found, err := h.turnSubmissions.GetTurnSubmission(
		ctx, operation.WorkspaceID, operation.AgentSessionID, operation.TurnID,
	)
	if err != nil {
		return h.releaseEditRetry(ctx, operation, owner, storesqlite.EditRetryReasonTurnNotFound, err)
	}
	if !found {
		if payload.Checkpoint == storesqlite.EditRetryCheckpointPrepared {
			return h.failEditRetryBeforeRollback(
				ctx, operation, owner, storesqlite.EditRetryReasonTurnNotFound, ErrEditRetryNotEligible,
			)
		}
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonTurnNotFound, ErrEditRetryRecoveryRequired,
		)
	}
	replacementInput, err := editRetryReplacementInput(envelope, payload.EditedText)
	if err != nil {
		if payload.Checkpoint == storesqlite.EditRetryCheckpointPrepared {
			return h.failEditRetryBeforeRollback(
				ctx, operation, owner, storesqlite.EditRetryReasonTurnNotFound, err,
			)
		}
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict, err,
		)
	}
	switch payload.Checkpoint {
	case storesqlite.EditRetryCheckpointPrepared:
		operation, err = h.dispatchEditRetryRollback(ctx, operation, owner, replacementInput)
		if err != nil {
			return operation, err
		}
		payload, _ = storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	case storesqlite.EditRetryCheckpointRollbackDispatched:
		operation, err = h.reconcileEditRetryRollback(ctx, operation, owner)
		if err != nil {
			return operation, err
		}
		payload, _ = storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	case storesqlite.EditRetryCheckpointRollbackAborted:
		if h.effectiveHistory == nil {
			return operation, ErrEditRetryNotEligible
		}
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict,
			editRetryInvariant("rollback_aborted checkpoint was still claimable"),
		)
	}
	if payload.Checkpoint != storesqlite.EditRetryCheckpointRollbackConfirmed &&
		payload.Checkpoint != storesqlite.EditRetryCheckpointReplacementDispatched {
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict,
			editRetryInvariant("unexpected checkpoint %q after rollback", payload.Checkpoint),
		)
	}
	dispatch := false
	if payload.Checkpoint == storesqlite.EditRetryCheckpointRollbackConfirmed {
		payload.Checkpoint = storesqlite.EditRetryCheckpointReplacementDispatched
		operation, err = h.checkpointEditRetry(ctx, operation, owner, payload)
		if err != nil {
			return operation, err
		}
		dispatch = true
	} else {
		operation, accepted, absent, reconcileErr := h.reconcileEditRetryReplacement(
			ctx, operation, owner, replacementInput,
		)
		if reconcileErr != nil || accepted {
			return operation, reconcileErr
		}
		action := editRetryRecoveryAction(ctx)
		if action != EditRetryRecoveryActionRetryReplacement {
			cause := ErrEditRetryResendPending
			if !absent {
				cause = ErrEditRetryRecoveryRequired
			}
			return h.releaseEditRetry(
				ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown, cause,
			)
		}
		if !absent {
			return h.releaseEditRetry(
				ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown,
				ErrEditRetryRecoveryRequired,
			)
		}
		// Only RecoverEditRetryCommand's compound authorization can consume
		// authoritative absence evidence. A worker must never manufacture a
		// second dispatch capability after restart.
		payload, _ = storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
		if payload.RedispatchProofAt <= 0 {
			return h.releaseEditRetry(
				ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown,
				ErrEditRetryResendPending,
			)
		}
		dispatch = true
	}
	if !dispatch {
		return h.releaseEditRetry(
			ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown,
			ErrEditRetryResendPending,
		)
	}
	operation, err = h.dispatchEditRetryReplacement(ctx, operation, owner, replacementInput)
	if recovering && errors.Is(err, ErrEditRetryRecoveryRequired) {
		// Recovery has durably surfaced the explicit state and can continue
		// booting the Host; the user can now choose a recovery action.
		return operation, nil
	}
	return operation, err
}

func (h *Host) dispatchEditRetryRollback(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
	replacementInput SendInput,
) (storesqlite.RuntimeOperation, error) {
	ref := SessionRef{WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID}
	release, err := h.acquireSession(ctx, ref)
	if err != nil {
		return h.releaseEditRetry(ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown, err)
	}
	defer release()
	session, err := h.ensureRuntimeSessionLocked(ctx, ref)
	if err != nil {
		return h.releaseEditRetry(ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown, err)
	}
	hydrated := append([]PromptContentBlock(nil), replacementInput.Content...)
	if h.attachments != nil {
		hydrated, err = h.attachments.HydrateRuntimeContent(ref.WorkspaceID, ref.AgentSessionID, replacementInput.Content)
		if err != nil {
			return h.failEditRetryBeforeRollback(
				ctx, operation, owner, storesqlite.EditRetryReasonTurnNotFound, err,
			)
		}
	}
	if err := h.runtime.ValidatePromptContent(ctx, RuntimeExecInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, Content: hydrated,
	}); err != nil {
		return h.failEditRetryBeforeRollback(
			ctx, operation, owner, storesqlite.EditRetryReasonTurnNotFound, err,
		)
	}
	effectiveTurns, err := h.effectiveHistory.ListEffectiveSessionTurns(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return h.releaseEditRetry(ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown, err)
	}
	beforeIDs, err := editRetryProviderTurnIDs(effectiveTurns, operation.TurnID)
	if err != nil {
		return h.failEditRetryBeforeRollback(
			ctx, operation, owner, storesqlite.EditRetryReasonTurnNotLatest, err,
		)
	}
	runtimeInput := RuntimeHistoryInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, Provider: session.Provider,
	}
	supported, err := h.historyRuntime.SupportsEffectiveHistory(ctx, runtimeInput)
	if err != nil {
		return h.releaseEditRetry(ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown, err)
	}
	if !supported {
		return h.failEditRetryBeforeRollback(ctx, operation, owner, storesqlite.EditRetryReasonProviderUnsupported, ErrRuntimeHistoryUnsupported)
	}
	current, err := h.historyRuntime.ReadEffectiveHistory(ctx, runtimeInput)
	if err != nil {
		return h.releaseEditRetry(ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown, err)
	}
	if strings.TrimSpace(current.ProviderSessionID) != strings.TrimSpace(session.ProviderSessionID) ||
		!equalEditRetryIDs(runtimeHistoryTurnIDs(current), beforeIDs) {
		return h.failEditRetryBeforeRollback(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict,
			editRetryInvariant("provider history does not match canonical history before rollback"),
		)
	}
	payload, _ := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	if len(payload.BeforeProviderIDs) == 0 {
		operation, _, err = h.effectiveHistory.CaptureEditRetryPreEffectSnapshot(ctx, storesqlite.CaptureEditRetryPreEffectSnapshotInput{
			WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID, LeaseOwner: owner,
			ProviderSessionID: strings.TrimSpace(session.ProviderSessionID), ProviderTurnIDs: beforeIDs,
			NowUnixMS: h.now().UnixMilli(),
		})
		if err != nil {
			return operation, err
		}
		payload, _ = storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	}
	if payload.ProviderSessionID != strings.TrimSpace(session.ProviderSessionID) || !equalEditRetryIDs(payload.BeforeProviderIDs, beforeIDs) {
		return h.failEditRetryBeforeRollback(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict,
			editRetryInvariant("durable pre-effect snapshot does not match provider history"),
		)
	}
	payload.Checkpoint = storesqlite.EditRetryCheckpointRollbackDispatched
	operation, _, err = h.effectiveHistory.MarkEditRetryRollbackDispatched(
		ctx, storesqlite.MarkEditRetryRollbackDispatchedInput{
			WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
			LeaseOwner: owner, Payload: payload, NowUnixMS: h.now().UnixMilli(),
		},
	)
	if err != nil {
		return operation, err
	}
	if publishErr := h.publishRuntimeOperationEvents(ctx, operation.WorkspaceID); publishErr != nil {
		logRuntimeOperationFailure(operation, publishErr)
	}
	mutation, rollbackErr := h.historyRuntime.RollbackLatestTurn(ctx, runtimeInput)
	snapshot := mutation.Snapshot
	if snapshot == nil {
		observed, readErr := h.historyRuntime.ReadEffectiveHistory(ctx, runtimeInput)
		if readErr == nil {
			snapshot = &observed
		} else if rollbackErr == nil {
			rollbackErr = readErr
		}
	}
	expectedAfter := beforeIDs[:len(beforeIDs)-1]
	if snapshot != nil &&
		strings.TrimSpace(snapshot.ProviderSessionID) == payload.ProviderSessionID &&
		equalEditRetryIDs(runtimeHistoryTurnIDs(*snapshot), expectedAfter) {
		return h.confirmEditRetryRollback(ctx, operation, owner, expectedAfter)
	}
	if mutation.Disposition == RuntimeDispatchDispositionRejected ||
		mutation.Disposition == RuntimeDispatchDispositionNotDispatched {
		if snapshot != nil && equalEditRetryIDs(runtimeHistoryTurnIDs(*snapshot), beforeIDs) {
			return h.abortEditRetryRollback(ctx, operation, owner, beforeIDs, rollbackErr)
		}
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict,
			editRetryInvariant("explicit rollback rejection returned divergent history"),
		)
	}
	// The dispatch outcome is unknown. The durable rollback_dispatched fence is
	// intentionally retained; all future progress is authoritative read-only
	// reconciliation and this code path never calls rollback again.
	return h.releaseEditRetry(
		ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown,
		errors.Join(ErrEditRetryInProgress, rollbackErr),
	)
}

func (h *Host) reconcileEditRetryRollback(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
) (storesqlite.RuntimeOperation, error) {
	payload, err := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	if err != nil || len(payload.BeforeProviderIDs) == 0 {
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict,
			editRetryInvariant("rollback checkpoint is invalid"),
		)
	}
	session, found, err := h.store.GetSession(ctx, operation.WorkspaceID, operation.AgentSessionID)
	if err != nil || !found {
		return h.releaseEditRetry(ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown, err)
	}
	snapshot, err := h.historyRuntime.ReadEffectiveHistory(ctx, RuntimeHistoryInput{
		WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID, Provider: session.Provider,
	})
	if err != nil {
		return h.releaseEditRetry(ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown, err)
	}
	if strings.TrimSpace(snapshot.ProviderSessionID) != payload.ProviderSessionID {
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict,
			editRetryInvariant("provider session changed while reconciling rollback"),
		)
	}
	expectedAfter := payload.BeforeProviderIDs[:len(payload.BeforeProviderIDs)-1]
	switch {
	case equalEditRetryIDs(runtimeHistoryTurnIDs(snapshot), expectedAfter):
		return h.confirmEditRetryRollback(ctx, operation, owner, expectedAfter)
	case equalEditRetryIDs(runtimeHistoryTurnIDs(snapshot), payload.BeforeProviderIDs):
		return h.releaseEditRetry(
			ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown,
			ErrEditRetryInProgress,
		)
	default:
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict,
			editRetryInvariant("provider history diverged while reconciling rollback"),
		)
	}
}

func (h *Host) confirmEditRetryRollback(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
	afterIDs []string,
) (storesqlite.RuntimeOperation, error) {
	payload, _ := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	payload.Checkpoint = storesqlite.EditRetryCheckpointRollbackConfirmed
	confirmed, _, err := h.effectiveHistory.ConfirmEditRetryRollback(
		ctx, storesqlite.ConfirmEditRetryRollbackInput{
			WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
			LeaseOwner: owner, Payload: payload, ProviderTurnIDs: append([]string(nil), afterIDs...),
			NowUnixMS: h.now().UnixMilli(),
		},
	)
	if err != nil {
		return operation, err
	}
	if publishErr := h.publishRuntimeOperationEvents(ctx, operation.WorkspaceID); publishErr != nil {
		logRuntimeOperationFailure(confirmed, publishErr)
	}
	return confirmed, nil
}

func (h *Host) abortEditRetryRollback(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
	beforeIDs []string,
	cause error,
) (storesqlite.RuntimeOperation, error) {
	aborted, _, err := h.effectiveHistory.AbortEditRetryRollback(
		ctx, storesqlite.AbortEditRetryRollbackInput{
			WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
			LeaseOwner: owner, ReasonCode: storesqlite.EditRetryReasonProviderOutcomeUnknown,
			NowUnixMS: h.now().UnixMilli(), ProviderTurnIDs: append([]string(nil), beforeIDs...),
		},
	)
	if err != nil {
		return operation, errors.Join(cause, err)
	}
	return aborted, errors.Join(ErrEditRetryNotEligible, cause)
}

func (h *Host) checkpointEditRetry(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
	payload storesqlite.EditRetryOperationPayload,
) (storesqlite.RuntimeOperation, error) {
	payloadMap, err := storesqlite.EncodeEditRetryOperationPayload(payload)
	if err != nil {
		return operation, err
	}
	checkpointed, changed, err := h.operations.CheckpointRuntimeOperation(
		ctx, storesqlite.CheckpointRuntimeOperationInput{
			WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
			LeaseOwner: owner, Payload: payloadMap, NowUnixMS: h.now().UnixMilli(),
		},
	)
	if err != nil {
		return operation, err
	}
	if !changed {
		return checkpointed, storesqlite.ErrRuntimeOperationLeaseLost
	}
	return checkpointed, nil
}
