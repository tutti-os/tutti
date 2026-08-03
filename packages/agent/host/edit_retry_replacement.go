package agenthost

import (
	"context"
	"errors"
	"fmt"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// reconcileBlockedEditRetryReadOnly never wakes, leases, or advances a
// blocked operation. The durable fence marks an uncertain provider boundary;
// explicit reconciliation is permitted to inspect authoritative history, but
// it cannot turn that observation into a new provider mutation automatically.
func (h *Host) reconcileBlockedEditRetryReadOnly(ctx context.Context, operation storesqlite.RuntimeOperation, expectedOperationVersion, expectedHistoryRevision int64) (storesqlite.RuntimeOperation, error) {
	payload, err := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	if err != nil || len(payload.BeforeProviderIDs) == 0 {
		return operation, ErrEditRetryRecoveryRequired
	}
	session, found, err := h.store.GetSession(ctx, operation.WorkspaceID, operation.AgentSessionID)
	if err != nil || !found {
		return operation, ErrEditRetryRecoveryRequired
	}
	supported, err := h.historyRuntime.SupportsEffectiveHistory(ctx, RuntimeHistoryInput{WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID, Provider: session.Provider})
	if err != nil || !supported {
		return h.reconcileBlockedEditRetry(ctx, operation, expectedOperationVersion, expectedHistoryRevision, storesqlite.BlockedEditRetryReconcileUnknown, "", nil, "")
	}
	snapshot, err := h.historyRuntime.ReadEffectiveHistory(ctx, RuntimeHistoryInput{
		WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID, Provider: session.Provider,
	})
	if err != nil {
		return h.reconcileBlockedEditRetry(ctx, operation, expectedOperationVersion, expectedHistoryRevision, storesqlite.BlockedEditRetryReconcileUnknown, "", nil, "")
	}
	actual := runtimeHistoryTurnIDs(snapshot)
	disposition, providerTurnID := storesqlite.BlockedEditRetryReconcileUnknown, ""
	if strings.TrimSpace(snapshot.ProviderSessionID) == payload.ProviderSessionID {
		// Only a pre-effect checkpoint can safely interpret a source-presence
		// snapshot as the original canonical turn still being authoritative.
		// A retracted source at a later checkpoint is an ambiguous provider /
		// canonical split and must remain blocked.
		if payload.Checkpoint == storesqlite.EditRetryCheckpointPrepared && equalEditRetryIDs(actual, payload.BeforeProviderIDs) {
			disposition = storesqlite.BlockedEditRetryReconcileSourcePresent
		} else if (payload.Checkpoint == storesqlite.EditRetryCheckpointRollbackConfirmed || payload.Checkpoint == storesqlite.EditRetryCheckpointReplacementDispatched) && len(payload.BeforeProviderIDs) > 0 && equalEditRetryIDs(actual, payload.BeforeProviderIDs[:len(payload.BeforeProviderIDs)-1]) {
			disposition = storesqlite.BlockedEditRetryReconcileReplacementAbsent
		} else if payload.Checkpoint == storesqlite.EditRetryCheckpointReplacementDispatched && len(actual) == len(payload.BeforeProviderIDs) && equalEditRetryIDs(actual[:len(actual)-1], payload.BeforeProviderIDs[:len(payload.BeforeProviderIDs)-1]) {
			last := snapshot.Turns[len(snapshot.Turns)-1]
			if strings.TrimSpace(last.ID) != "" && last.ID == actual[len(actual)-1] && strings.TrimSpace(last.ClientUserMessageID) == payload.ClientSubmitID {
				disposition, providerTurnID = storesqlite.BlockedEditRetryReconcileReplacementPresent, last.ID
			}
		}
	}
	reconciled, reconcileErr := h.reconcileBlockedEditRetry(ctx, operation, expectedOperationVersion, expectedHistoryRevision, disposition, snapshot.ProviderSessionID, actual, providerTurnID)
	if errors.Is(reconcileErr, storesqlite.ErrRuntimeOperationSubjectState) && disposition != storesqlite.BlockedEditRetryReconcileUnknown {
		return h.reconcileBlockedEditRetry(ctx, operation, expectedOperationVersion, expectedHistoryRevision, storesqlite.BlockedEditRetryReconcileUnknown, "", nil, "")
	}
	return reconciled, reconcileErr
}

func (h *Host) reconcileBlockedEditRetry(ctx context.Context, operation storesqlite.RuntimeOperation, version, revision int64, disposition storesqlite.BlockedEditRetryReconcileDisposition, providerSessionID string, providerTurns []string, providerTurnID string) (storesqlite.RuntimeOperation, error) {
	reconciled, _, err := h.effectiveHistory.ReconcileBlockedEditRetry(ctx, storesqlite.ReconcileBlockedEditRetryInput{WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID, ExpectedOperationVersion: version, ExpectedHistoryRevision: revision, ClientActionID: editRetryClientAction(ctx), ActionIdentity: editRetryRecoveryActionIdentity(EditRetryRecoveryActionReconcile, version, uint64(revision)), Disposition: disposition, ProviderSessionID: providerSessionID, ProviderTurnIDs: providerTurns, ProviderTurnID: providerTurnID, NowUnixMS: h.now().UnixMilli()})
	return reconciled, err
}

func (h *Host) reconcileEditRetryReplacement(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
	replacementInput SendInput,
) (storesqlite.RuntimeOperation, bool, bool, error) {
	payload, err := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	if err != nil || len(payload.BeforeProviderIDs) == 0 {
		return operation, false, false, editRetryInvariant("replacement checkpoint is invalid")
	}
	session, found, err := h.store.GetSession(ctx, operation.WorkspaceID, operation.AgentSessionID)
	if err != nil || !found {
		return operation, false, false, err
	}
	snapshot, err := h.historyRuntime.ReadEffectiveHistory(ctx, RuntimeHistoryInput{
		WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID, Provider: session.Provider,
	})
	if err != nil {
		return operation, false, false, err
	}
	if strings.TrimSpace(snapshot.ProviderSessionID) != payload.ProviderSessionID {
		return operation, false, false, editRetryInvariant(
			"provider session changed while reconciling replacement",
		)
	}
	expectedPrefix := payload.BeforeProviderIDs[:len(payload.BeforeProviderIDs)-1]
	actual := runtimeHistoryTurnIDs(snapshot)
	if equalEditRetryIDs(actual, expectedPrefix) {
		return operation, false, true, nil
	}
	if len(actual) != len(expectedPrefix)+1 ||
		!equalEditRetryIDs(actual[:len(expectedPrefix)], expectedPrefix) {
		failed, failErr := h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict,
			editRetryInvariant("provider history diverged while reconciling replacement"),
		)
		return failed, false, false, failErr
	}
	replacement := snapshot.Turns[len(snapshot.Turns)-1]
	if strings.TrimSpace(replacement.ClientUserMessageID) != payload.ClientSubmitID ||
		strings.TrimSpace(replacement.ID) == "" {
		failed, failErr := h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict,
			editRetryInvariant("provider replacement cannot be correlated to the stable submit identity"),
		)
		return failed, false, false, failErr
	}
	completed, err := h.completeEditRetryAcceptance(
		ctx, operation, owner, replacementInput,
		RuntimeProviderAcceptanceReceipt{
			ProviderSessionID: snapshot.ProviderSessionID,
			ProviderTurnID:    replacement.ID,
			Source:            RuntimeAcceptanceSourceHistoryRead,
		},
		nil,
	)
	if err != nil {
		failed, failErr := h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonRecoveryRequired, err,
		)
		return failed, false, false, failErr
	}
	return completed, true, false, nil
}

// authorizeEditRetryReplacementRetry reads provider history before entering
// SQLite, then atomically binds that evidence to the command CAS, fence and
// recovery-action ledger. It does not hold a database transaction across the
// provider read.
func (h *Host) authorizeEditRetryReplacementRetry(ctx context.Context, operation storesqlite.RuntimeOperation, expectedOperationVersion, expectedHistoryRevision int64) (storesqlite.RuntimeOperation, error) {
	payload, err := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	if err != nil || payload.Checkpoint != storesqlite.EditRetryCheckpointReplacementDispatched || len(payload.BeforeProviderIDs) == 0 {
		return operation, ErrEditRetryRecoveryRequired
	}
	session, found, err := h.store.GetSession(ctx, operation.WorkspaceID, operation.AgentSessionID)
	if err != nil || !found {
		return operation, err
	}
	snapshot, err := h.historyRuntime.ReadEffectiveHistory(ctx, RuntimeHistoryInput{WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID, Provider: session.Provider})
	if err != nil {
		// A compound completion may have committed before its caller observed the
		// response. Never turn that terminal fact into a recovery failure.
		if durable, found, readErr := h.operations.GetRuntimeOperation(ctx, operation.WorkspaceID, operation.OperationID); readErr == nil && found && durable.Status == storesqlite.RuntimeOperationStatusCompleted {
			return durable, nil
		}
		return operation, err
	}
	prefix := payload.BeforeProviderIDs[:len(payload.BeforeProviderIDs)-1]
	if strings.TrimSpace(snapshot.ProviderSessionID) != payload.ProviderSessionID || !equalEditRetryIDs(runtimeHistoryTurnIDs(snapshot), prefix) {
		return operation, ErrEditRetryRecoveryRequired
	}
	now := h.now().UnixMilli()
	proofAt := now
	if proofAt <= payload.RedispatchProofAt {
		proofAt = payload.RedispatchProofAt + 1
	}
	authorized, _, err := h.effectiveHistory.AuthorizeEditRetryReplacementRetry(ctx, storesqlite.AuthorizeEditRetryReplacementRetryInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID, ExpectedOperationVersion: expectedOperationVersion, ExpectedHistoryRevision: expectedHistoryRevision,
		ClientActionID:    firstNonEmpty(editRetryClientAction(ctx), fmt.Sprintf("recover:%s:retry_replacement:%d", operation.OperationID, expectedOperationVersion)),
		ActionIdentity:    editRetryRecoveryActionIdentity(EditRetryRecoveryActionRetryReplacement, expectedOperationVersion, uint64(expectedHistoryRevision)),
		ReplacementTurnID: payload.ReplacementTurnID, ProviderSessionID: payload.ProviderSessionID, ProviderTurnIDs: append([]string(nil), prefix...), ProofAtUnixMS: proofAt, NowUnixMS: now,
	})
	return authorized, err
}

func (h *Host) dispatchEditRetryReplacement(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
	input SendInput,
) (storesqlite.RuntimeOperation, error) {
	payload, err := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	if err != nil {
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict, err,
		)
	}
	ref := SessionRef{WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID}
	release, err := h.acquireSession(ctx, ref)
	if err != nil {
		return h.releaseEditRetry(
			ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown, err,
		)
	}
	defer release()
	session, err := h.ensureRuntimeSessionLocked(ctx, ref)
	if err != nil {
		return h.releaseEditRetry(
			ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown, err,
		)
	}
	if strings.TrimSpace(session.ProviderSessionID) != payload.ProviderSessionID {
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict,
			editRetryInvariant("provider session changed before replacement dispatch"),
		)
	}
	hydrated := append([]PromptContentBlock(nil), input.Content...)
	if h.attachments != nil {
		hydrated, err = h.attachments.HydrateRuntimeContent(
			operation.WorkspaceID, operation.AgentSessionID, input.Content,
		)
		if err != nil {
			return h.failEditRetryRecovery(
				ctx, operation, owner, storesqlite.EditRetryReasonRecoveryRequired, err,
			)
		}
	}
	if err := h.runtime.ValidatePromptContent(ctx, RuntimeExecInput{
		WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID, Content: hydrated,
	}); err != nil {
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonRecoveryRequired, err,
		)
	}
	claim, created, err := h.store.PrepareSubmitClaim(ctx, storesqlite.SubmitClaimPrepare{
		WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID,
		ClientSubmitID: payload.ClientSubmitID, CanonicalTurnID: payload.ReplacementTurnID,
		NowUnixMS: h.now().UnixMilli(),
	})
	if err != nil {
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict, err,
		)
	}
	if claim.CanonicalTurnID != payload.ReplacementTurnID {
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict,
			storesqlite.ErrSubmitClaimTurnConflict,
		)
	}
	if !created && claim.Status == "accepted" {
		completed, accepted, _, reconcileErr := h.reconcileEditRetryReplacement(
			ctx, operation, owner, input,
		)
		if accepted || reconcileErr != nil {
			return completed, reconcileErr
		}
		return h.releaseEditRetry(
			ctx, operation, owner, storesqlite.EditRetryReasonReplacementNotProvenAbsent,
			ErrEditRetryResendPending,
		)
	}
	if !created && claim.Status == "rejected" {
		// A terminal rejected claim is a durable no-redispatch fence. The
		// replacement operation cannot safely turn that failed submission back
		// into provider work, so fail closed instead of calling Exec again.
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict,
			ErrSubmitDeliveryUnknown,
		)
	}
	execResult, execErr := h.runtime.Exec(ctx, RuntimeExecInput{
		WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID,
		TurnID: payload.ReplacementTurnID, ClientSubmitID: payload.ClientSubmitID,
		CapabilityRefs: append([]CapabilityReference(nil), input.CapabilityRefs...),
		Content:        hydrated, DisplayPrompt: input.DisplayPrompt,
		Metadata:           map[string]any{"clientSubmitId": payload.ClientSubmitID},
		HistoryReplacement: true, RequireProviderAcceptance: true,
		TuttiModeSnapshot: input.TuttiModeSnapshot,
	})
	if strings.TrimSpace(execResult.TurnID) != "" &&
		strings.TrimSpace(execResult.TurnID) != payload.ReplacementTurnID {
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict,
			ErrSubmitDeliveryUnknown,
		)
	}
	if receipt := execResult.ProviderDispatch.Acceptance; receipt != nil &&
		execResult.ProviderDispatch.Disposition == RuntimeDispatchDispositionApplied {
		completed, completeErr := h.completeEditRetryAcceptance(
			ctx, operation, owner, input, *receipt, hydrated,
		)
		if completeErr == nil {
			return completed, nil
		}
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonRecoveryRequired, completeErr,
		)
	}
	if strings.TrimSpace(execResult.TurnID) == payload.ReplacementTurnID {
		if err := h.recordEditRetryReplacementSubmission(ctx, operation, input, hydrated); err != nil {
			return h.failEditRetryRecovery(
				ctx, operation, owner, storesqlite.EditRetryReasonRecoveryRequired, err,
			)
		}
	}
	if execResult.ProviderDispatch.Disposition == RuntimeDispatchDispositionNotDispatched {
		// An intent checkpoint is deliberately not proof that the provider did
		// nothing. Persist this provider-neutral negative receipt before making
		// the terminal Abandon action available; a failed persistence leaves the
		// fence in place and recovery must reconcile instead.
		payload.ReplacementNotDispatched = true
		checkpointed, checkpointErr := h.checkpointEditRetry(ctx, operation, owner, payload)
		if checkpointErr != nil {
			return operation, checkpointErr
		}
		return h.releaseEditRetry(
			ctx, checkpointed, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown,
			errors.Join(ErrEditRetryResendPending, execErr),
		)
	}
	if execResult.ProviderDispatch.Disposition == RuntimeDispatchDispositionRejected {
		return h.releaseEditRetry(
			ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown,
			errors.Join(ErrEditRetryResendPending, execErr),
		)
	}
	// A timeout or disconnect is not evidence that turn/start was rejected.
	// Leave the stable ids and replacement_dispatched checkpoint intact; only
	// a later authoritative history read may complete or authorize a retry.
	return h.releaseEditRetry(
		ctx, operation, owner, storesqlite.EditRetryReasonProviderOutcomeUnknown,
		errors.Join(ErrEditRetryResendPending, execErr),
	)
}

func (h *Host) completeEditRetryAcceptance(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
	input SendInput,
	receipt RuntimeProviderAcceptanceReceipt,
	hydrated []PromptContentBlock,
) (storesqlite.RuntimeOperation, error) {
	payload, err := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	if err != nil {
		return operation, err
	}
	if strings.TrimSpace(receipt.ProviderSessionID) != payload.ProviderSessionID ||
		strings.TrimSpace(receipt.ProviderTurnID) == "" {
		return operation, editRetryInvariant("provider acceptance receipt identity mismatch")
	}
	if err := h.recordEditRetryReplacementSubmission(ctx, operation, input, hydrated); err != nil {
		return operation, err
	}
	replacement, found, err := h.store.GetTurn(
		ctx, operation.WorkspaceID, operation.AgentSessionID, payload.ReplacementTurnID,
	)
	if err != nil {
		if durable, found, readErr := h.operations.GetRuntimeOperation(ctx, operation.WorkspaceID, operation.OperationID); readErr == nil && found && durable.Status == storesqlite.RuntimeOperationStatusCompleted {
			return durable, nil
		}
		return operation, err
	}
	if (!found || strings.TrimSpace(replacement.RootProviderTurnID) == "") &&
		receipt.Source == RuntimeAcceptanceSourceHistoryRead {
		reconciler, ok := h.runtime.(RuntimeProviderTurnAcceptanceReconciler)
		if !ok {
			return operation, editRetryInvariant(
				"runtime cannot persist provider-history acceptance",
			)
		}
		session, sessionFound, sessionErr := h.store.GetSession(
			ctx,
			operation.WorkspaceID,
			operation.AgentSessionID,
		)
		if sessionErr != nil {
			return operation, sessionErr
		}
		if !sessionFound {
			return operation, ErrSessionNotFound
		}
		if err := reconciler.ReconcileProviderTurnAcceptance(
			ctx,
			RuntimeProviderTurnAcceptanceInput{
				WorkspaceID:               operation.WorkspaceID,
				AgentSessionID:            operation.AgentSessionID,
				Provider:                  session.Provider,
				RootTurnID:                payload.ReplacementTurnID,
				ExpectedProviderSessionID: payload.ProviderSessionID,
				ExpectedProviderTurnID:    receipt.ProviderTurnID,
				ClientUserMessageID:       payload.ClientSubmitID,
			},
		); err != nil {
			return operation, err
		}
	}
	completion, _, err := h.effectiveHistory.CompleteEditRetryRuntimeOperation(
		ctx, storesqlite.CompleteEditRetryRuntimeOperationInput{
			WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
			LeaseOwner: owner, ReplacementTurnID: payload.ReplacementTurnID,
			ProviderTurnID: receipt.ProviderTurnID, NowUnixMS: h.now().UnixMilli(),
		},
	)
	if err != nil {
		return operation, err
	}
	if publishErr := h.publishRuntimeOperationEvents(ctx, operation.WorkspaceID); publishErr != nil {
		logRuntimeOperationFailure(completion.Operation, publishErr)
	}
	return completion.Operation, nil
}

func (h *Host) recordEditRetryReplacementSubmission(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	input SendInput,
	hydrated []PromptContentBlock,
) error {
	payload, err := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	if err != nil {
		return err
	}
	if reporter, ok := h.runtime.(RuntimeSubmitProvenanceReporter); ok {
		if hydrated == nil {
			hydrated = append([]PromptContentBlock(nil), input.Content...)
			if h.attachments != nil {
				hydrated, err = h.attachments.HydrateRuntimeContent(
					operation.WorkspaceID, operation.AgentSessionID, input.Content,
				)
				if err != nil {
					return err
				}
			}
		}
		if err := reporter.DurablyReportSubmitProvenance(ctx, RuntimeSubmitProvenanceInput{
			WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID,
			TurnID: payload.ReplacementTurnID, ClientSubmitID: payload.ClientSubmitID,
			Content: hydrated, DisplayPrompt: input.DisplayPrompt,
		}); err != nil {
			return err
		}
	}
	if err := h.recordTurnSubmission(
		ctx,
		SessionRef{WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID},
		payload.ReplacementTurnID, payload.ClientSubmitID, input.Content,
		input.DisplayPrompt, input.CapabilityRefs, input.TuttiModeSnapshot,
	); err != nil {
		return err
	}
	return h.acceptSubmitClaim(
		SessionRef{WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID},
		payload.ClientSubmitID, payload.ReplacementTurnID,
	)
}
