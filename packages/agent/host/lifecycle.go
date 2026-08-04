package agenthost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func (h *Host) CreateSession(ctx context.Context, workspaceID string, input CreateSessionInput) (CreateSessionResult, error) {
	workspaceID, input.AgentSessionID = strings.TrimSpace(workspaceID), strings.TrimSpace(input.AgentSessionID)
	input.Provider, input.AgentTargetID = strings.TrimSpace(input.Provider), strings.TrimSpace(input.AgentTargetID)
	if h == nil || h.runtime == nil || h.store == nil || workspaceID == "" || input.AgentSessionID == "" || input.Provider == "" {
		return CreateSessionResult{}, ErrInvalidArgument
	}
	var err error
	input.RailPlacement, err = normalizeRailPlacement(input.RailPlacement)
	if err != nil {
		return CreateSessionResult{}, err
	}
	ref := SessionRef{WorkspaceID: workspaceID, AgentSessionID: input.AgentSessionID}
	normalized, promptText, err := normalizeOptionalPromptContent(input.InitialContent)
	if err != nil {
		return CreateSessionResult{}, err
	}
	typedGoal, isTypedGoal := ParseTypedGoalControl(normalized, false)
	if input.InitialGoalControl != nil {
		if len(normalized) != 0 {
			return CreateSessionResult{}, ErrInvalidArgument
		}
		typedGoal, err = normalizeTypedGoalControl(*input.InitialGoalControl)
		if err != nil {
			return CreateSessionResult{}, err
		}
		isTypedGoal = true
	}
	metadata := submissionMetadata(input.Metadata, input.ClientSubmitID)
	goalMetadata := clonePayload(metadata)
	goalInput := GoalControlInput{
		WorkspaceID: workspaceID, AgentSessionID: input.AgentSessionID,
		Action: typedGoal.Action, Objective: typedGoal.Objective,
		ClientSubmitID: input.ClientSubmitID, SubmissionMetadata: goalMetadata,
	}
	if isTypedGoal {
		if replay, found, replayErr := h.replayInitialGoalCreate(ctx, input, goalInput); found || replayErr != nil {
			return replay, replayErr
		}
	}
	claimMetadata := metadata
	if isTypedGoal || len(normalized) == 0 {
		normalized = nil
		claimMetadata = nil
	}
	if len(normalized) > 0 && strings.TrimSpace(input.TurnID) == "" {
		input.TurnID = uuid.NewString()
	}
	claim, claimPending, err := h.prepareSubmitClaim(ctx, ref, claimMetadata, input.TurnID)
	if err != nil {
		if errors.Is(err, storesqlite.ErrSubmitClaimTurnConflict) {
			return CreateSessionResult{}, errors.Join(ErrSubmitDeliveryUnknown, err)
		}
		return CreateSessionResult{}, err
	}
	if claim.ClientSubmitID != "" && !claimPending {
		if claim.Status != "accepted" && claim.Status != "rejected" {
			return CreateSessionResult{}, ErrSubmitDeliveryUnknown
		}
		canonicalSession, _, readErr := h.store.GetSession(ctx, workspaceID, input.AgentSessionID)
		if readErr != nil {
			return CreateSessionResult{}, readErr
		}
		if !railPlacementMatchesSession(input.RailPlacement, canonicalSession) {
			return CreateSessionResult{}, ErrRailPlacementConflict
		}
		runtimeSession, _ := h.runtime.Session(workspaceID, input.AgentSessionID)
		return CreateSessionResult{Session: runtimeSession, Canonical: canonicalSession, TurnID: claim.TurnID}, nil
	}
	defer func() {
		if claimPending {
			h.abandonSubmitClaim(ref, claim.ClientSubmitID)
		}
	}()

	prepared := PreparedRuntime{Cwd: strings.TrimSpace(value(input.Cwd))}
	if h.preparation != nil {
		prepared, err = h.preparation.Prepare(ctx, createPreparationInput(workspaceID, input))
		if err != nil {
			return CreateSessionResult{}, err
		}
	}
	cleanup := func(cause error, started bool, canonicalCreated bool) error {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		var cleanupErrs []error
		cleanupErrs = append(cleanupErrs, cause)
		if started {
			cleanupErrs = append(cleanupErrs, h.runtime.Close(cleanupCtx, RuntimeCloseInput{WorkspaceID: workspaceID, AgentSessionID: input.AgentSessionID}))
		}
		if canonicalCreated {
			_, deleteErr := h.store.RollbackRuntimeSessionInitialization(cleanupCtx, workspaceID, input.AgentSessionID)
			cleanupErrs = append(cleanupErrs, deleteErr)
		}
		if h.preparation != nil {
			cleanupErrs = append(cleanupErrs, h.preparation.Cleanup(cleanupCtx, RuntimeCleanupInput{
				WorkspaceID: workspaceID, AgentSessionID: input.AgentSessionID, Provider: input.Provider,
			}))
		}
		return errors.Join(cleanupErrs...)
	}
	startedAt := h.now()
	release, err := h.acquireStartup(ctx, input.Provider)
	if err != nil {
		h.observeStep(ctx, "session_create", "runtime_started", input.AgentSessionID, input.Provider, startedAt, err)
		return CreateSessionResult{}, cleanup(err, false, false)
	}
	session, err := func() (ProviderRuntimeSession, error) {
		defer release()
		runtimeTitle, initialTitleEstablished := initialGoalRuntimeTitle(value(input.Title), input.InitialDisplayPrompt, typedGoal, isTypedGoal)
		return h.runtime.Start(ctx, RuntimeStartInput{
			WorkspaceID: workspaceID, AgentSessionID: input.AgentSessionID, AgentTargetID: input.AgentTargetID,
			Provider: input.Provider, Cwd: prepared.Cwd, Env: append([]string(nil), prepared.Env...),
			Title: runtimeTitle, InitialTitleEstablished: initialTitleEstablished,
			PermissionModeID: value(input.PermissionModeID), Model: value(input.Model), PlanMode: valueBool(input.PlanMode),
			BrowserUse: input.BrowserUse, ComputerUse: input.ComputerUse, CodexSaverMode: valueBool(input.CodexSaverMode),
			ProviderTargetRef: cloneMap(firstMap(prepared.ProviderTargetRef, input.ProviderTargetRef)),
			RuntimeContext:    cloneMap(input.RuntimeContext), ReasoningEffort: value(input.ReasoningEffort),
			Speed: value(input.Speed), ConversationDetailMode: strings.TrimSpace(input.ConversationDetailMode),
			Visible: input.Visible, Provisional: len(normalized) > 0,
		})
	}()
	if err != nil {
		h.observeStep(ctx, "session_create", "runtime_started", input.AgentSessionID, input.Provider, startedAt, err)
		return CreateSessionResult{}, cleanup(err, false, false)
	}
	h.observeStep(ctx, "session_create", "runtime_started", session.ID, session.Provider, startedAt, nil)
	startedAt = h.now()
	canonicalSession, err := h.store.InitializeRuntimeSession(ctx, RuntimeSessionInitialization{
		Session:       session,
		RailPlacement: input.RailPlacement,
	})
	if err != nil {
		h.observeStep(ctx, "session_create", "session_persisted", session.ID, session.Provider, startedAt, err)
		return CreateSessionResult{}, cleanup(err, true, false)
	}
	if strings.TrimSpace(canonicalSession.ID) != strings.TrimSpace(session.ID) || strings.TrimSpace(canonicalSession.WorkspaceID) != workspaceID || strings.TrimSpace(canonicalSession.RailSectionKey) == "" {
		identityErr := fmt.Errorf("initialize workspace agent session: persisted session identity mismatch")
		h.observeStep(ctx, "session_create", "session_persisted", session.ID, session.Provider, startedAt, identityErr)
		return CreateSessionResult{}, cleanup(identityErr, true, true)
	}
	if !railPlacementMatchesSession(input.RailPlacement, canonicalSession) {
		placementErr := ErrRailPlacementConflict
		h.observeStep(ctx, "session_create", "session_persisted", session.ID, session.Provider, startedAt, placementErr)
		return CreateSessionResult{}, cleanup(placementErr, true, true)
	}
	h.observeStep(ctx, "session_create", "session_persisted", session.ID, session.Provider, startedAt, nil)
	if len(normalized) == 0 && !isTypedGoal {
		return CreateSessionResult{Session: session, Canonical: canonicalSession}, nil
	}
	if isTypedGoal {
		goalInput.AgentSessionID = session.ID
		goalResult, goalErr := h.goalControl(ctx, goalInput)
		if goalErr != nil {
			// A typed goal starts from a non-provisional, already published
			// session. Preserve that canonical session on command failure just as
			// the legacy Service did; rolling it back would leave subscribers with
			// an unpaired session-created event.
			return CreateSessionResult{}, cleanup(goalErr, true, false)
		}
		if refreshed, ok := h.runtime.Session(workspaceID, session.ID); ok {
			session = refreshed
		}
		return CreateSessionResult{
			Session: session, Canonical: goalResult.Canonical,
			Kind: "goalControl", GoalControl: &goalResult,
		}, nil
	}
	startedAt = h.now()
	if err := h.runtime.ValidatePromptContent(ctx, RuntimeExecInput{WorkspaceID: workspaceID, AgentSessionID: session.ID, Content: normalized}); err != nil {
		h.observeStep(ctx, "session_create", "prompt_validated", session.ID, session.Provider, startedAt, err)
		return CreateSessionResult{}, cleanup(err, true, true)
	}
	h.observeStep(ctx, "session_create", "prompt_validated", session.ID, session.Provider, startedAt, nil)
	startedAt = h.now()
	preparedContent, err := h.prepareContent(workspaceID, session.ID, normalized)
	if err != nil {
		h.observeStep(ctx, "session_create", "prompt_prepared", session.ID, session.Provider, startedAt, err)
		return CreateSessionResult{}, cleanup(err, true, true)
	}
	h.observeStep(ctx, "session_create", "prompt_prepared", session.ID, session.Provider, startedAt, nil)
	displayPrompt := strings.TrimSpace(input.InitialDisplayPrompt)
	initialTitle := ""
	if !session.InitialTitleEstablished {
		initialTitle = DeriveInitialTitle(session.Title, firstNonEmpty(displayPrompt, promptText, preparedContent.DisplayText))
	}
	startedAt = h.now()
	turnID := strings.TrimSpace(input.TurnID)
	if turnID == "" {
		turnID = uuid.NewString()
	}
	execResult, err := h.runtime.Exec(ctx, RuntimeExecInput{
		WorkspaceID: workspaceID, AgentSessionID: session.ID, TurnID: turnID,
		ClientSubmitID: claim.ClientSubmitID, CanonicalSubmitOccurredAtUnixMS: claim.CreatedAtUnixMS,
		CapabilityRefs: append([]CapabilityReference(nil), input.CapabilityRefs...), Content: preparedContent.Hydrated,
		DisplayPrompt: displayPrompt, InitialTitle: initialTitle, InitialTitleBase: session.Title,
		Metadata: cloneMap(metadata), TuttiModeSnapshot: input.TuttiModeSnapshot,
		RequireProviderAcceptance: true,
	})
	if err != nil {
		h.observeStep(ctx, "session_create", "runtime_exec", session.ID, session.Provider, startedAt, err)
		disposition := execResult.ProviderDispatch.Disposition
		if disposition == RuntimeDispatchDispositionRejected ||
			disposition == RuntimeDispatchDispositionApplied ||
			disposition == RuntimeDispatchDispositionOutcomeUnknown {
			if persistErr := h.persistRuntimeSubmitOutcome(
				ctx, SessionRef{WorkspaceID: workspaceID, AgentSessionID: session.ID}, execResult,
				firstNonEmpty(claim.ClientSubmitID, input.ClientSubmitID, legacyClientSubmitID(metadata)),
				claim.CreatedAtUnixMS, preparedContent, displayPrompt, input.CapabilityRefs,
				input.TuttiModeSnapshot,
			); persistErr != nil {
				claimPending = false
				return CreateSessionResult{}, errors.Join(ErrSubmitDeliveryUnknown, err, persistErr)
			}
			if disposition == RuntimeDispatchDispositionRejected {
				// A definitive rejection keeps the visible Session/failed Turn. The
				// claim is a terminal idempotency fence, so replay reads the same
				// failed Turn without invoking the provider again. Once that terminal
				// report is durable, discard the startup runtime without publishing a
				// canonical completion over the failure.
				if strings.TrimSpace(execResult.TurnID) != "" {
					claimPending = false
					if rejectErr := h.finalizeRejectedSubmitClaim(ref, firstNonEmpty(claim.ClientSubmitID, input.ClientSubmitID, legacyClientSubmitID(metadata)), execResult.TurnID); rejectErr != nil {
						return CreateSessionResult{}, errors.Join(ErrSubmitDeliveryUnknown, err, rejectErr)
					}
				}
				return CreateSessionResult{}, h.discardRejectedPreparedRuntime(ctx, err, workspaceID, session.ID, session.Provider)
			}
			claimPending = false
			return CreateSessionResult{}, errors.Join(ErrSubmitDeliveryUnknown, err)
		}
		return CreateSessionResult{}, cleanup(err, true, true)
	}
	turnID = strings.TrimSpace(execResult.TurnID)
	if turnID == "" {
		h.observeStep(ctx, "session_create", "runtime_exec", session.ID, session.Provider, startedAt, ErrSubmitDeliveryUnknown)
		return CreateSessionResult{}, cleanup(ErrSubmitDeliveryUnknown, true, true)
	}
	if expectedTurnID := strings.TrimSpace(input.TurnID); expectedTurnID != "" && turnID != expectedTurnID {
		claimPending = false
		return CreateSessionResult{}, ErrSubmitDeliveryUnknown
	}
	if reporter, ok := h.runtime.(RuntimeSubmitProvenanceReporter); ok {
		if err := reporter.DurablyReportSubmitProvenance(ctx, RuntimeSubmitProvenanceInput{
			WorkspaceID: workspaceID, AgentSessionID: session.ID, TurnID: turnID,
			ClientSubmitID: claim.ClientSubmitID, CanonicalSubmitOccurredAtUnixMS: claim.CreatedAtUnixMS,
			Content: preparedContent.Hydrated, DisplayPrompt: displayPrompt,
		}); err != nil {
			// Provider acceptance is already possible. Keep the runtime, canonical
			// session, and prepared claim intact so a retry cannot dispatch twice.
			claimPending = false
			return CreateSessionResult{}, errors.Join(ErrSubmitDeliveryUnknown, err)
		}
	}
	if err := h.recordTurnSubmission(
		ctx, ref, turnID, input.ClientSubmitID, preparedContent.Persisted,
		displayPrompt, input.CapabilityRefs, input.TuttiModeSnapshot,
	); err != nil {
		claimPending = false
		return CreateSessionResult{}, errors.Join(ErrSubmitDeliveryUnknown, err)
	}
	if claim.ClientSubmitID != "" {
		claimPending = false
		if err := h.acceptSubmitClaim(ref, claim.ClientSubmitID, turnID); err != nil {
			return CreateSessionResult{}, errors.Join(ErrSubmitDeliveryUnknown, err)
		}
	}
	if refreshed, ok := h.runtime.Session(workspaceID, session.ID); ok {
		session = refreshed
	}
	if refreshed, ok, readErr := h.store.GetSession(ctx, workspaceID, session.ID); readErr == nil && ok {
		canonicalSession = refreshed
	}
	h.observeStep(ctx, "session_create", "runtime_exec", session.ID, session.Provider, startedAt, nil)
	return CreateSessionResult{Session: session, Canonical: canonicalSession, TurnID: turnID}, nil
}

func (h *Host) EnsureRuntimeSession(ctx context.Context, ref SessionRef) (ProviderRuntimeSession, error) {
	ref.WorkspaceID, ref.AgentSessionID = strings.TrimSpace(ref.WorkspaceID), strings.TrimSpace(ref.AgentSessionID)
	if h == nil || h.runtime == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return ProviderRuntimeSession{}, ErrSessionNotFound
	}
	release, err := h.acquireSession(ctx, ref)
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	defer release()
	return h.ensureRuntimeSessionLocked(ctx, ref)
}

func (h *Host) ensureRuntimeSessionLocked(ctx context.Context, ref SessionRef) (ProviderRuntimeSession, error) {
	deleted, err := h.store.SessionDeleted(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	if deleted {
		return ProviderRuntimeSession{}, ErrSessionNotFound
	}
	canonicalSession, found, err := h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	if found && ResolveResumePolicy(canonicalSession).Mode == ResumeModeReject {
		return ProviderRuntimeSession{}, ErrSessionNotFound
	}
	policy := ResolveResumePolicy(canonicalSession)
	evidence := storesqlite.ProviderSessionResumeEvidence{}
	if found && policy.Mode != ResumeModeRecreate {
		evidence, err = h.store.GetProviderSessionResumeEvidence(ctx, ref.WorkspaceID, ref.AgentSessionID)
		if err != nil {
			return ProviderRuntimeSession{}, err
		}
	}
	if live, ok := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID); ok {
		if !ExternalImportResumeSupported(live.RuntimeContext) {
			return ProviderRuntimeSession{}, ErrSessionNotFound
		}
		if policy.Mode != ResumeModeRecreate &&
			!runtimeSessionHasActiveTurn(live) &&
			strings.TrimSpace(canonicalSession.ActiveTurnID) == "" &&
			evidence.HasSettledTurn && !evidence.Established {
			return ProviderRuntimeSession{}, ErrProviderSessionNotEstablished
		}
		live.Resumable = live.Resumable || evidence.Established
		// Controller may retain the Session record after releasing an idle
		// provider connection. Controller's registry handles connection
		// replacement; clearing this Host marker additionally refreshes its
		// retained set from the durable store before Ensure returns.
		if !h.runtimeSessionLive(ref.WorkspaceID, ref.AgentSessionID) {
			h.goalFencesRestored.Delete(ref.WorkspaceID + "\x00" + ref.AgentSessionID)
		}
		if err := h.restoreGoalGenerationFencesOnce(ctx, ref); err != nil {
			return ProviderRuntimeSession{}, err
		}
		return live, nil
	}
	if !found || strings.TrimSpace(canonicalSession.Provider) == "" {
		return ProviderRuntimeSession{}, ErrSessionNotFound
	}
	if policy.Mode != ResumeModeRecreate &&
		!evidence.Established &&
		(!evidence.HasTurns || evidence.HasSettledTurn) {
		return ProviderRuntimeSession{}, ErrProviderSessionNotEstablished
	}
	prepared := PreparedRuntime{Cwd: strings.TrimSpace(canonicalSession.Cwd)}
	settings := composerSettingsFromMap(canonicalSession.Settings)
	if h.preparation != nil {
		prepared, err = h.preparation.Prepare(ctx, resumePreparationInput(canonicalSession, settings))
		if err != nil {
			return ProviderRuntimeSession{}, err
		}
	}
	if prepared.Settings != nil {
		settings = *prepared.Settings
	}
	release, err := h.acquireStartup(ctx, canonicalSession.Provider)
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	defer release()
	result, err := h.runtime.Resume(ctx, RuntimeResumeInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		AgentTargetID: strings.TrimSpace(canonicalSession.AgentTargetID), Provider: strings.TrimSpace(canonicalSession.Provider),
		ProviderSessionID: strings.TrimSpace(canonicalSession.ProviderSessionID), Resumable: evidence.Established, Cwd: prepared.Cwd,
		Env: append([]string(nil), prepared.Env...), Title: strings.TrimSpace(canonicalSession.Title),
		Status: persistedRuntimeStatus(canonicalSession.ActiveTurnID), Settings: settings,
		CreatedAtUnixMS: canonicalSession.CreatedAtUnixMS, UpdatedAtUnixMS: canonicalSession.UpdatedAtUnixMS,
		Visible: boolPointer(canonicalSession.Metadata.Visible), RuntimeContext: cloneMap(firstMap(prepared.RuntimeContext, canonicalSession.InternalRuntimeContext)),
		ProviderTargetRef: cloneMap(prepared.ProviderTargetRef), Metadata: canonicalSession.Metadata,
		InternalRuntimeContext: cloneMap(canonicalSession.InternalRuntimeContext), RecreateIfMissing: policy.Mode == ResumeModeRecreate,
	})
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	if err := h.restoreGoalGenerationFences(ctx, ref); err != nil {
		return ProviderRuntimeSession{}, err
	}
	h.goalFencesRestored.Store(ref.WorkspaceID+"\x00"+ref.AgentSessionID, struct{}{})
	return result, nil
}

func runtimeSessionHasActiveTurn(session ProviderRuntimeSession) bool {
	return session.TurnLifecycle != nil &&
		session.TurnLifecycle.ActiveTurnID != nil &&
		strings.TrimSpace(*session.TurnLifecycle.ActiveTurnID) != ""
}

func (h *Host) SendInput(ctx context.Context, ref SessionRef, input SendInput) (SendInputResult, error) {
	ref.WorkspaceID, ref.AgentSessionID = strings.TrimSpace(ref.WorkspaceID), strings.TrimSpace(ref.AgentSessionID)
	if h == nil || h.runtime == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return SendInputResult{}, ErrInvalidArgument
	}
	normalized, promptText, err := normalizePromptContent(input.Content)
	if err != nil {
		return SendInputResult{}, err
	}
	metadata := submissionMetadata(input.Metadata, input.ClientSubmitID)
	if typedGoal, ok := ParseTypedGoalControl(normalized, input.Guidance); ok {
		goalResult, goalErr := h.goalControl(ctx, GoalControlInput{
			WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
			Action: typedGoal.Action, Objective: typedGoal.Objective,
			ClientSubmitID:     input.ClientSubmitID,
			SubmissionMetadata: metadata,
		})
		if goalErr != nil {
			return SendInputResult{}, goalErr
		}
		session, _ := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID)
		return SendInputResult{
			Session: session, Canonical: goalResult.Canonical,
			Kind: "goalControl", GoalControl: &goalResult,
		}, nil
	}
	var result SendInputResult
	err = h.withSessionMutationActor(ctx, ref.WorkspaceID, ref.AgentSessionID, func(actorCtx context.Context) error {
		var sendErr error
		result, sendErr = h.sendInputSerialized(actorCtx, ref, input, normalized, promptText, metadata)
		return sendErr
	})
	return result, err
}

func (h *Host) sendInputSerialized(
	ctx context.Context,
	ref SessionRef,
	input SendInput,
	normalized []PromptContentBlock,
	promptText string,
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

func (h *Host) UpdateTitle(ctx context.Context, input UpdateTitleInput) (UpdateTitleResult, error) {
	input.WorkspaceID, input.AgentSessionID = strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.AgentSessionID)
	input.Title = strings.TrimSpace(input.Title)
	if h == nil || h.store == nil || h.runtime == nil || input.WorkspaceID == "" || input.AgentSessionID == "" {
		return UpdateTitleResult{}, ErrInvalidArgument
	}
	if utf8.RuneCountInString(input.Title) > MaxSessionTitleRunes {
		return UpdateTitleResult{}, ErrSessionTitleTooLong
	}
	canonicalSession, updated, err := h.store.UpdateSessionTitle(ctx, input.WorkspaceID, input.AgentSessionID, input.Title)
	if err != nil {
		return UpdateTitleResult{}, err
	}
	if !updated {
		return UpdateTitleResult{}, ErrSessionNotFound
	}
	result := UpdateTitleResult{Canonical: canonicalSession}
	if _, ok := h.runtime.Session(input.WorkspaceID, input.AgentSessionID); !ok {
		return result, nil
	}
	runtimeSession, err := h.runtime.SetTitle(ctx, RuntimeSetTitleInput{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, Title: canonicalSession.Title,
	})
	if err != nil {
		return UpdateTitleResult{}, err
	}
	result.Session = runtimeSession
	return result, nil
}

func (h *Host) recordTurnSubmission(
	ctx context.Context,
	ref SessionRef,
	turnID string,
	clientSubmitID string,
	content []PromptContentBlock,
	displayPrompt string,
	capabilityRefs []CapabilityReference,
	tuttiModeSnapshot *TuttiModeTurnSnapshot,
) error {
	if h == nil || h.turnSubmissions == nil {
		return nil
	}
	contentJSON, err := json.Marshal(content)
	if err != nil {
		return fmt.Errorf("encode turn submission content: %w", err)
	}
	capabilityRefsJSON, err := json.Marshal(capabilityRefs)
	if err != nil {
		return fmt.Errorf("encode turn submission capability refs: %w", err)
	}
	tuttiModeSnapshotJSON, err := json.Marshal(tuttiModeSnapshot)
	if err != nil {
		return fmt.Errorf("encode turn submission tutti mode snapshot: %w", err)
	}
	now := h.now().UnixMilli()
	_, _, err = h.turnSubmissions.RecordTurnSubmission(ctx, storesqlite.TurnSubmission{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		TurnID: strings.TrimSpace(turnID), ContentJSON: string(contentJSON),
		DisplayPrompt:         strings.TrimSpace(displayPrompt),
		CapabilityRefsJSON:    string(capabilityRefsJSON),
		TuttiModeSnapshotJSON: string(tuttiModeSnapshotJSON),
		ClientSubmitID:        strings.TrimSpace(clientSubmitID),
		CreatedAtUnixMS:       now, UpdatedAtUnixMS: now,
	})
	if err != nil {
		return fmt.Errorf("record turn submission envelope: %w", err)
	}
	return nil
}

func (h *Host) requireSendAllowedByEffectiveHistory(ctx context.Context, ref SessionRef) error {
	if h == nil || h.effectiveHistory == nil {
		return nil
	}
	history, found, err := h.effectiveHistory.GetSessionHistory(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil || !found || history.RecoveryState == storesqlite.SessionHistoryRecoveryReady {
		return err
	}
	switch history.RecoveryState {
	case storesqlite.SessionHistoryRecoveryRollbackPending:
		return ErrEditRetryInProgress
	case storesqlite.SessionHistoryRecoveryRequired:
		return ErrEditRetryRecoveryRequired
	default:
		return ErrEditRetryResendPending
	}
}

func (h *Host) acquireSession(ctx context.Context, ref SessionRef) (func(), error) {
	if h.locker == nil {
		return func() {}, nil
	}
	return h.locker.Acquire(ctx, ref)
}

func (h *Host) acquireStartup(ctx context.Context, provider string) (func(), error) {
	if h.startupGate == nil {
		return func() {}, nil
	}
	return h.startupGate.Acquire(ctx, provider)
}

func normalizeOptionalPromptContent(content []PromptContentBlock) ([]PromptContentBlock, string, error) {
	if len(content) == 0 {
		return nil, "", nil
	}
	return normalizePromptContent(content)
}

func createPreparationInput(workspaceID string, input CreateSessionInput) RuntimePreparationInput {
	return RuntimePreparationInput{
		WorkspaceID: workspaceID, AgentSessionID: input.AgentSessionID, AgentTargetID: input.AgentTargetID,
		Provider: input.Provider, Cwd: value(input.Cwd), Title: value(input.Title), PermissionModeID: value(input.PermissionModeID),
		PlanMode: valueBool(input.PlanMode), BrowserUse: valueBoolDefault(input.BrowserUse, true), ComputerUse: valueBoolDefault(input.ComputerUse, true), CodexSaverMode: valueBool(input.CodexSaverMode),
		ProviderTargetRef: cloneMap(input.ProviderTargetRef), Model: value(input.Model), ReasoningEffort: value(input.ReasoningEffort),
		ConversationDetailMode: input.ConversationDetailMode, Metadata: cloneMap(input.Metadata), RuntimeContext: cloneMap(input.RuntimeContext),
	}
}

func resumePreparationInput(session storesqlite.Session, settings ComposerSettings) RuntimePreparationInput {
	return RuntimePreparationInput{
		WorkspaceID: session.WorkspaceID, AgentSessionID: session.ID, AgentTargetID: session.AgentTargetID,
		Provider: session.Provider, Cwd: session.Cwd, Title: session.Title, PermissionModeID: settings.PermissionModeID,
		PlanMode: settings.PlanMode, BrowserUse: valueBoolDefault(settings.BrowserUse, true), ComputerUse: valueBoolDefault(settings.ComputerUse, true), CodexSaverMode: settings.CodexSaverMode,
		Model: settings.Model, ReasoningEffort: settings.ReasoningEffort, ConversationDetailMode: settings.ConversationDetailMode,
		RuntimeContext: cloneMap(session.InternalRuntimeContext), SessionOrigin: session.Origin,
		ProviderSessionID: session.ProviderSessionID, CreatedAtUnixMS: session.CreatedAtUnixMS,
		UpdatedAtUnixMS: session.UpdatedAtUnixMS, Visible: session.Metadata.Visible, Settings: settings,
		SessionMetadata: session.Metadata,
	}
}

func composerSettingsFromMap(values map[string]any) ComposerSettings {
	result := ComposerSettings{}
	result.CodexSaverMode, _ = values["codexSaverMode"].(bool)
	result.Model, _ = values["model"].(string)
	result.PermissionModeID, _ = values["permissionModeId"].(string)
	result.PlanMode, _ = values["planMode"].(bool)
	if value, ok := values["browserUse"].(bool); ok {
		result.BrowserUse = &value
	}
	if value, ok := values["computerUse"].(bool); ok {
		result.ComputerUse = &value
	}
	result.ReasoningEffort, _ = values["reasoningEffort"].(string)
	result.Speed, _ = values["speed"].(string)
	result.ConversationDetailMode, _ = values["conversationDetailMode"].(string)
	return result
}

func lifecycleFromTurn(turn storesqlite.Turn) TurnLifecycle {
	result := TurnLifecycle{Phase: turn.Phase}
	if turnID := strings.TrimSpace(turn.TurnID); turnID != "" && turn.Phase != "settled" {
		result.ActiveTurnID = &turnID
	}
	if turn.Outcome != "" {
		outcome := turn.Outcome
		result.Outcome = &outcome
	}
	if turn.CompletedCommandKind != "" || turn.CompletedCommandStatus != "" {
		result.CompletedCommand = &CompletedCommand{Kind: turn.CompletedCommandKind, Status: turn.CompletedCommandStatus}
	}
	return result
}

func imageOnlyDisplayText(content []PromptContentBlock) string {
	count := 0
	for _, block := range content {
		if block.Type == "image" {
			count++
		}
	}
	if count == 1 {
		return "[Image]"
	}
	if count > 1 {
		return "[Images]"
	}
	return ""
}

func persistedRuntimeStatus(activeTurnID string) string {
	if strings.TrimSpace(activeTurnID) != "" {
		return "working"
	}
	return "ready"
}
func value(input *string) string {
	if input == nil {
		return ""
	}
	return strings.TrimSpace(*input)
}
func valueBool(input *bool) bool { return input != nil && *input }
func valueBoolDefault(input *bool, fallback bool) bool {
	if input == nil {
		return fallback
	}
	return *input
}
func boolPointer(value bool) *bool { return &value }
func firstMap(values ...map[string]any) map[string]any {
	for _, value := range values {
		if len(value) > 0 {
			return value
		}
	}
	return nil
}
