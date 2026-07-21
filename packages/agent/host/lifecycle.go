package agenthost

import (
	"context"
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
	ref := SessionRef{WorkspaceID: workspaceID, AgentSessionID: input.AgentSessionID}
	normalized, promptText, err := normalizeOptionalPromptContent(input.InitialContent)
	if err != nil {
		return CreateSessionResult{}, err
	}
	typedGoal, isTypedGoal := ParseTypedGoalControl(normalized, false)
	metadata := submissionMetadata(input.Metadata, input.ClientSubmitID)
	goalMetadata := clonePayload(metadata)
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
		if claim.Status != "accepted" {
			return CreateSessionResult{}, ErrSubmitDeliveryUnknown
		}
		canonicalSession, _, readErr := h.store.GetSession(ctx, workspaceID, input.AgentSessionID)
		if readErr != nil {
			return CreateSessionResult{}, readErr
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
		return h.runtime.Start(ctx, RuntimeStartInput{
			WorkspaceID: workspaceID, AgentSessionID: input.AgentSessionID, AgentTargetID: input.AgentTargetID,
			Provider: input.Provider, Cwd: prepared.Cwd, Env: append([]string(nil), prepared.Env...),
			Title: value(input.Title), InitialTitleEstablished: NormalizeTitle(value(input.Title)) != "",
			PermissionModeID: value(input.PermissionModeID), Model: value(input.Model), PlanMode: valueBool(input.PlanMode),
			BrowserUse: input.BrowserUse, ComputerUse: input.ComputerUse,
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
	canonicalSession, err := h.store.InitializeRuntimeSession(ctx, session)
	if err != nil {
		h.observeStep(ctx, "session_create", "session_persisted", session.ID, session.Provider, startedAt, err)
		return CreateSessionResult{}, cleanup(err, true, false)
	}
	if strings.TrimSpace(canonicalSession.ID) != strings.TrimSpace(session.ID) || strings.TrimSpace(canonicalSession.WorkspaceID) != workspaceID || strings.TrimSpace(canonicalSession.RailSectionKey) == "" {
		identityErr := fmt.Errorf("initialize workspace agent session: persisted session identity mismatch")
		h.observeStep(ctx, "session_create", "session_persisted", session.ID, session.Provider, startedAt, identityErr)
		return CreateSessionResult{}, cleanup(identityErr, true, true)
	}
	h.observeStep(ctx, "session_create", "session_persisted", session.ID, session.Provider, startedAt, nil)
	if len(normalized) == 0 && !isTypedGoal {
		return CreateSessionResult{Session: session, Canonical: canonicalSession}, nil
	}
	if isTypedGoal {
		goalResult, goalErr := h.goalControl(ctx, GoalControlInput{
			WorkspaceID: workspaceID, AgentSessionID: session.ID,
			Action: typedGoal.Action, Objective: typedGoal.Objective,
			SubmissionMetadata: goalMetadata,
		})
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
	content, preparedDisplay, err := h.prepareContent(workspaceID, session.ID, normalized)
	if err != nil {
		h.observeStep(ctx, "session_create", "prompt_prepared", session.ID, session.Provider, startedAt, err)
		return CreateSessionResult{}, cleanup(err, true, true)
	}
	h.observeStep(ctx, "session_create", "prompt_prepared", session.ID, session.Provider, startedAt, nil)
	displayPrompt := strings.TrimSpace(input.InitialDisplayPrompt)
	initialTitle := ""
	if !session.InitialTitleEstablished {
		initialTitle = DeriveInitialTitle(session.Title, firstNonEmpty(displayPrompt, promptText, preparedDisplay))
	}
	startedAt = h.now()
	turnID := strings.TrimSpace(input.TurnID)
	if turnID == "" {
		turnID = uuid.NewString()
	}
	execResult, err := h.runtime.Exec(ctx, RuntimeExecInput{
		WorkspaceID: workspaceID, AgentSessionID: session.ID, TurnID: turnID,
		ClientSubmitID: input.ClientSubmitID, CapabilityRefs: append([]CapabilityReference(nil), input.CapabilityRefs...), Content: content,
		DisplayPrompt: displayPrompt, InitialTitle: initialTitle, InitialTitleBase: session.Title,
		Metadata: cloneMap(metadata), TuttiModeSnapshot: input.TuttiModeSnapshot,
	})
	if err != nil {
		h.observeStep(ctx, "session_create", "runtime_exec", session.ID, session.Provider, startedAt, err)
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
			ClientSubmitID: input.ClientSubmitID, Content: content, DisplayPrompt: displayPrompt,
		}); err != nil {
			// Provider acceptance is already possible. Keep the runtime, canonical
			// session, and prepared claim intact so a retry cannot dispatch twice.
			claimPending = false
			return CreateSessionResult{}, errors.Join(ErrSubmitDeliveryUnknown, err)
		}
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
	if live, ok := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID); ok {
		if !ExternalImportResumeSupported(live.RuntimeContext) {
			return ProviderRuntimeSession{}, ErrSessionNotFound
		}
		return live, nil
	}
	if !found || strings.TrimSpace(canonicalSession.Provider) == "" {
		return ProviderRuntimeSession{}, ErrSessionNotFound
	}
	policy := ResolveResumePolicy(canonicalSession)
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
		ProviderSessionID: strings.TrimSpace(canonicalSession.ProviderSessionID), Cwd: prepared.Cwd,
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
	return result, nil
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
		if claim.Status != "accepted" {
			return SendInputResult{}, ErrSubmitDeliveryUnknown
		}
		return h.acceptedSubmitResult(ctx, ref, claim)
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
	content, preparedDisplay, err := h.prepareContent(ref.WorkspaceID, ref.AgentSessionID, normalized)
	if err != nil {
		h.observeStep(ctx, "message_send", "prompt_prepared", ref.AgentSessionID, session.Provider, startedAt, err)
		return SendInputResult{}, err
	}
	h.observeStep(ctx, "message_send", "prompt_prepared", ref.AgentSessionID, session.Provider, startedAt, nil)
	displayPrompt, initialTitle := strings.TrimSpace(input.DisplayPrompt), ""
	if !input.Guidance && !session.InitialTitleEstablished {
		initialTitle = DeriveInitialTitle(session.Title, firstNonEmpty(displayPrompt, promptText, preparedDisplay))
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
			TurnID: turnID, ClientSubmitID: input.ClientSubmitID,
			CapabilityRefs: append([]CapabilityReference(nil), input.CapabilityRefs...), Content: content,
			DisplayPrompt: displayPrompt, InitialTitle: initialTitle, InitialTitleBase: session.Title,
			Guidance: input.Guidance, Metadata: cloneMap(metadata), TuttiModeSnapshot: input.TuttiModeSnapshot,
		})
	}()
	if err != nil {
		h.observeStep(ctx, "message_send", "runtime_exec", ref.AgentSessionID, session.Provider, startedAt, err)
		if input.Guidance {
			// Guidance targets an already-live turn and transport failure cannot
			// prove rejection. Preserve the claim as a replay fence.
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
			ClientSubmitID: input.ClientSubmitID, Content: content, DisplayPrompt: displayPrompt, Guidance: input.Guidance,
		}); err != nil {
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

func (h *Host) acceptedSubmitResult(ctx context.Context, ref SessionRef, claim storesqlite.SubmitClaim) (SendInputResult, error) {
	canonicalSession, ok, err := h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return SendInputResult{}, err
	}
	if !ok {
		if _, live := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID); !live {
			return SendInputResult{}, ErrSessionNotFound
		}
	}
	turn, ok, err := h.store.GetTurn(ctx, ref.WorkspaceID, ref.AgentSessionID, claim.TurnID)
	if err != nil {
		return SendInputResult{}, err
	}
	if !ok {
		return SendInputResult{}, ErrSubmitDeliveryUnknown
	}
	live, _ := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID)
	availability := SubmitAvailability{State: "available"}
	if strings.TrimSpace(canonicalSession.ActiveTurnID) != "" {
		availability = SubmitAvailability{State: "blocked", Reason: "active_turn"}
	}
	return SendInputResult{
		Session: live, Canonical: canonicalSession, Turn: &turn, TurnID: claim.TurnID,
		TurnLifecycle: lifecycleFromTurn(turn), SubmitAvailability: availability,
	}, nil
}

func (h *Host) prepareContent(workspaceID, sessionID string, content []PromptContentBlock) ([]PromptContentBlock, string, error) {
	if h.attachments == nil {
		return append([]PromptContentBlock(nil), content...), "", nil
	}
	persisted, err := h.attachments.PersistRequestContent(workspaceID, sessionID, content)
	if err != nil {
		return nil, "", err
	}
	hydrated, err := h.attachments.HydrateRuntimeContent(workspaceID, sessionID, persisted)
	if err != nil {
		return nil, "", err
	}
	return hydrated, imageOnlyDisplayText(persisted), nil
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
		PlanMode: valueBool(input.PlanMode), BrowserUse: valueBoolDefault(input.BrowserUse, true), ComputerUse: valueBoolDefault(input.ComputerUse, true),
		ProviderTargetRef: cloneMap(input.ProviderTargetRef), Model: value(input.Model), ReasoningEffort: value(input.ReasoningEffort),
		ConversationDetailMode: input.ConversationDetailMode, Metadata: cloneMap(input.Metadata), RuntimeContext: cloneMap(input.RuntimeContext),
	}
}

func resumePreparationInput(session storesqlite.Session, settings ComposerSettings) RuntimePreparationInput {
	return RuntimePreparationInput{
		WorkspaceID: session.WorkspaceID, AgentSessionID: session.ID, AgentTargetID: session.AgentTargetID,
		Provider: session.Provider, Cwd: session.Cwd, Title: session.Title, PermissionModeID: settings.PermissionModeID,
		PlanMode: settings.PlanMode, BrowserUse: valueBoolDefault(settings.BrowserUse, true), ComputerUse: valueBoolDefault(settings.ComputerUse, true),
		Model: settings.Model, ReasoningEffort: settings.ReasoningEffort, ConversationDetailMode: settings.ConversationDetailMode,
		RuntimeContext: cloneMap(session.InternalRuntimeContext), SessionOrigin: session.Origin,
		ProviderSessionID: session.ProviderSessionID, CreatedAtUnixMS: session.CreatedAtUnixMS,
		UpdatedAtUnixMS: session.UpdatedAtUnixMS, Visible: session.Metadata.Visible, Settings: settings,
		SessionMetadata: session.Metadata,
	}
}

func composerSettingsFromMap(values map[string]any) ComposerSettings {
	result := ComposerSettings{}
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
