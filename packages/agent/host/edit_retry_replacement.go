package agenthost

import (
	"context"
	"errors"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

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

func (h *Host) authorizeEditRetryRedispatch(
	ctx context.Context,
	operation storesqlite.RuntimeOperation,
	owner string,
) (storesqlite.RuntimeOperation, error) {
	payload, err := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	if err != nil || len(payload.BeforeProviderIDs) == 0 {
		return operation, editRetryInvariant("redispatch checkpoint is invalid")
	}
	session, found, err := h.store.GetSession(ctx, operation.WorkspaceID, operation.AgentSessionID)
	if err != nil || !found {
		return operation, err
	}
	snapshot, err := h.historyRuntime.ReadEffectiveHistory(ctx, RuntimeHistoryInput{
		WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID, Provider: session.Provider,
	})
	if err != nil {
		return operation, err
	}
	expectedPrefix := payload.BeforeProviderIDs[:len(payload.BeforeProviderIDs)-1]
	if strings.TrimSpace(snapshot.ProviderSessionID) != payload.ProviderSessionID ||
		!equalEditRetryIDs(runtimeHistoryTurnIDs(snapshot), expectedPrefix) {
		return operation, ErrEditRetryRecoveryRequired
	}
	now := h.now().UnixMilli()
	proofAt := now
	if proofAt <= payload.RedispatchProofAt {
		proofAt = payload.RedispatchProofAt + 1
	}
	prepared, _, err := h.effectiveHistory.PrepareEditRetryReplacementRedispatch(
		ctx, storesqlite.PrepareEditRetryReplacementRedispatchInput{
			WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
			LeaseOwner: owner, ReplacementTurnID: payload.ReplacementTurnID,
			ProviderSessionID: payload.ProviderSessionID,
			ProviderTurnIDs:   append([]string(nil), expectedPrefix...),
			ProofAtUnixMS:     proofAt,
			NowUnixMS:         now,
		},
	)
	return prepared, err
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
	claimMetadataJSON, err := submitClaimMetadataJSON(input.Metadata)
	if err != nil {
		return h.failEditRetryRecovery(
			ctx, operation, owner, storesqlite.EditRetryReasonOperationConflict, err,
		)
	}
	claim, created, err := h.store.PrepareSubmitClaim(ctx, storesqlite.SubmitClaimPrepare{
		WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID,
		ClientSubmitID: payload.ClientSubmitID, CanonicalTurnID: payload.ReplacementTurnID,
		MetadataJSON: claimMetadataJSON, NowUnixMS: h.now().UnixMilli(),
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
	if execResult.ProviderDispatch.Disposition == RuntimeDispatchDispositionRejected ||
		execResult.ProviderDispatch.Disposition == RuntimeDispatchDispositionNotDispatched {
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
		input.DisplayPrompt, input.CapabilityRefs, input.Metadata, input.TuttiModeSnapshot,
	); err != nil {
		return err
	}
	return h.acceptSubmitClaim(
		SessionRef{WorkspaceID: operation.WorkspaceID, AgentSessionID: operation.AgentSessionID},
		payload.ClientSubmitID, payload.ReplacementTurnID,
	)
}
