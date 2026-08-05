package agenthost

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func (h *Host) sendInputSerialized(
	ctx context.Context,
	ref SessionRef,
	input SendInput,
	normalized []PromptContentBlock,
	metadata map[string]any,
) (SendInputResult, error) {
	var err error
	if err := h.requireSendAllowedByEffectiveHistory(ctx, ref); err != nil {
		return SendInputResult{}, err
	}
	if !input.Guidance && strings.TrimSpace(input.TurnID) == "" {
		input.TurnID = uuid.NewString()
	}
	claim, claimPending, err := h.prepareSubmitClaim(ctx, ref, metadata, input.TurnID)
	if err != nil {
		if errors.Is(err, storesqlite.ErrSubmitClaimTurnConflict) {
			return SendInputResult{}, errors.Join(ErrSubmitDeliveryUnknown, err)
		}
		return SendInputResult{}, err
	}
	if claim.ClientSubmitID != "" && !claimPending {
		if claim.Status != "accepted" && claim.Status != "rejected" {
			return SendInputResult{}, ErrSubmitDeliveryUnknown
		}
		return h.replayedSubmitResult(ctx, ref, claim)
	}
	defer func() {
		if claimPending {
			h.abandonSubmitClaim(ref, claim.ClientSubmitID)
		}
	}()
	release, err := h.acquireSession(ctx, ref)
	if err != nil {
		return SendInputResult{}, err
	}
	defer release()
	startedAt := h.now()
	session, err := h.ensureRuntimeSessionLocked(ctx, ref)
	if err != nil {
		h.observeStep(ctx, "message_send", "runtime_session_ready", ref.AgentSessionID, "", startedAt, err)
		return SendInputResult{}, err
	}
	h.observeStep(ctx, "message_send", "runtime_session_ready", ref.AgentSessionID, session.Provider, startedAt, nil)
	augmentation, err := h.ensureTurnCapability(
		ctx,
		ref,
		session,
		claim.TurnID,
		claim.ClientSubmitID,
		input.TurnCapabilityInvocation,
	)
	if err != nil {
		return SendInputResult{}, err
	}
	var promptText string
	normalized, promptText, err = mergeTurnCapabilityPromptContent(normalized, augmentation)
	if err != nil {
		return SendInputResult{}, err
	}
	startedAt = h.now()
	if err := h.runtime.ValidatePromptContent(ctx, RuntimeExecInput{WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, Content: normalized}); err != nil {
		h.observeStep(ctx, "message_send", "prompt_validated", ref.AgentSessionID, session.Provider, startedAt, err)
		return SendInputResult{}, err
	}
	h.observeStep(ctx, "message_send", "prompt_validated", ref.AgentSessionID, session.Provider, startedAt, nil)
	startedAt = h.now()
	preparedContent, err := h.prepareContent(ref.WorkspaceID, ref.AgentSessionID, normalized)
	if err != nil {
		h.observeStep(ctx, "message_send", "prompt_prepared", ref.AgentSessionID, session.Provider, startedAt, err)
		return SendInputResult{}, err
	}
	h.observeStep(ctx, "message_send", "prompt_prepared", ref.AgentSessionID, session.Provider, startedAt, nil)
	displayPrompt, initialTitle := strings.TrimSpace(input.DisplayPrompt), ""
	if !input.Guidance && !session.InitialTitleEstablished {
		initialTitle = DeriveInitialTitle(session.Title, firstNonEmpty(displayPrompt, promptText, preparedContent.DisplayText))
	}
	startedAt = h.now()
	releaseStartup, err := h.acquireStartup(ctx, session.Provider)
	if err != nil {
		h.observeStep(ctx, "message_send", "runtime_exec", ref.AgentSessionID, session.Provider, startedAt, err)
		return SendInputResult{}, err
	}
	execResult, err := func() (RuntimeExecResult, error) {
		defer releaseStartup()
		turnID := strings.TrimSpace(input.TurnID)
		if turnID == "" && !input.Guidance {
			turnID = uuid.NewString()
		}
		return h.runtime.Exec(ctx, RuntimeExecInput{
			WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
			TurnID: turnID, ClientSubmitID: claim.ClientSubmitID,
			CanonicalSubmitOccurredAtUnixMS: claim.CreatedAtUnixMS,
			CapabilityRefs:                  append([]CapabilityReference(nil), input.CapabilityRefs...), Content: preparedContent.Hydrated,
			DisplayPrompt: displayPrompt, InitialTitle: initialTitle, InitialTitleBase: session.Title,
			Guidance: input.Guidance, Metadata: cloneMap(metadata), TuttiModeSnapshot: input.TuttiModeSnapshot,
			RequireProviderAcceptance: !input.Guidance,
		})
	}()
	if err != nil {
		h.observeStep(ctx, "message_send", "runtime_exec", ref.AgentSessionID, session.Provider, startedAt, err)
		if !input.Guidance && strings.TrimSpace(execResult.TurnID) != "" {
			if persistErr := h.persistRuntimeSubmitOutcome(
				ctx, ref, execResult,
				firstNonEmpty(claim.ClientSubmitID, input.ClientSubmitID, legacyClientSubmitID(metadata)),
				claim.CreatedAtUnixMS, preparedContent, displayPrompt, input.CapabilityRefs,
				input.TuttiModeSnapshot,
			); persistErr != nil {
				claimPending = false
				return SendInputResult{}, errors.Join(ErrSubmitDeliveryUnknown, err, persistErr)
			}
		}
		if !input.Guidance &&
			execResult.ProviderDispatch.Disposition == RuntimeDispatchDispositionRejected {
			// The failed Turn and prompt are already durable. Resolve the claim to
			// a terminal rejected state before the deferred cleanup can run.
			if strings.TrimSpace(execResult.TurnID) != "" {
				claimPending = false
				if rejectErr := h.finalizeRejectedSubmitClaim(ref, firstNonEmpty(claim.ClientSubmitID, input.ClientSubmitID, legacyClientSubmitID(metadata)), execResult.TurnID); rejectErr != nil {
					return SendInputResult{}, errors.Join(ErrSubmitDeliveryUnknown, err, rejectErr)
				}
				return SendInputResult{}, err
			}
		}
		if input.Guidance && execResult.ProviderDispatch.Disposition == RuntimeDispatchDispositionNotDispatched {
			// The runtime rejected the exact target before provider admission. Keep
			// claimPending true so the deferred cleanup removes the prepared claim;
			// this is a known rejection, not an outcome-unknown delivery.
			return SendInputResult{}, err
		}
		if input.Guidance ||
			execResult.ProviderDispatch.Disposition == RuntimeDispatchDispositionApplied ||
			execResult.ProviderDispatch.Disposition == RuntimeDispatchDispositionOutcomeUnknown {
			// Guidance targets an already-live turn and transport failure cannot
			// prove rejection. A positive/unknown provider dispatch likewise
			// preserves the claim as a recovery fence.
			claimPending = false
			return SendInputResult{}, errors.Join(ErrSubmitDeliveryUnknown, err)
		}
		return SendInputResult{}, err
	}
	turnID := strings.TrimSpace(execResult.TurnID)
	if turnID == "" {
		h.observeStep(ctx, "message_send", "runtime_exec", ref.AgentSessionID, session.Provider, startedAt, ErrSubmitDeliveryUnknown)
		return SendInputResult{}, ErrSubmitDeliveryUnknown
	}
	if expectedTurnID := strings.TrimSpace(input.TurnID); !input.Guidance && expectedTurnID != "" && turnID != expectedTurnID {
		claimPending = false
		return SendInputResult{}, ErrSubmitDeliveryUnknown
	}
	if reporter, ok := h.runtime.(RuntimeSubmitProvenanceReporter); ok {
		if err := reporter.DurablyReportSubmitProvenance(ctx, RuntimeSubmitProvenanceInput{
			WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, TurnID: turnID,
			ClientSubmitID: claim.ClientSubmitID, CanonicalSubmitOccurredAtUnixMS: claim.CreatedAtUnixMS,
			Content: preparedContent.Hydrated, DisplayPrompt: displayPrompt, Guidance: input.Guidance,
		}); err != nil {
			claimPending = false
			return SendInputResult{}, errors.Join(ErrSubmitDeliveryUnknown, err)
		}
	}
	if !input.Guidance {
		if err := h.recordTurnSubmission(
			ctx, ref, turnID, input.ClientSubmitID, preparedContent.Persisted,
			displayPrompt, input.CapabilityRefs, input.TuttiModeSnapshot,
		); err != nil {
			claimPending = false
			return SendInputResult{}, errors.Join(ErrSubmitDeliveryUnknown, err)
		}
	}
	if claim.ClientSubmitID != "" {
		claimPending = false
		if err := h.acceptSubmitClaim(ref, claim.ClientSubmitID, turnID); err != nil {
			return SendInputResult{}, errors.Join(ErrSubmitDeliveryUnknown, err)
		}
	}
	h.observeStep(ctx, "message_send", "runtime_exec", ref.AgentSessionID, session.Provider, startedAt, nil)
	canonicalSession, ok, err := h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return SendInputResult{}, err
	}
	_ = ok
	turn, ok, err := h.store.GetTurn(ctx, ref.WorkspaceID, ref.AgentSessionID, turnID)
	if err != nil {
		return SendInputResult{}, err
	}
	var turnPtr *storesqlite.Turn
	if ok {
		turnPtr = &turn
	}
	return SendInputResult{
		Session: session, Canonical: canonicalSession, Turn: turnPtr, TurnID: turnID,
		TurnLifecycle: execResult.TurnLifecycle, SubmitAvailability: execResult.SubmitAvailability,
	}, nil
}
