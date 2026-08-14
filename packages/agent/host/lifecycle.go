package agenthost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// CreateSession reports at most one aggregated TerminalFailure for a failed
// command. Cleanup after a primary failure stays diagnostic.
func (h *Host) CreateSession(ctx context.Context, workspaceID string, input CreateSessionInput) (CreateSessionResult, error) {
	clientSubmitID := firstNonEmptyTrimmed(input.ClientSubmitID, legacyClientSubmitID(input.Metadata))
	activationID := strings.TrimSpace(input.ActivationID)
	operationID := firstNonEmptyTrimmed(activationID, clientSubmitID, input.AgentSessionID)
	ctx, command := h.beginCommand(ctx, commandTerminalFailureInput{
		flow: "session_create", workspaceID: workspaceID, agentSessionID: input.AgentSessionID,
		operationID: operationID, requestID: activationID, clientSubmitID: clientSubmitID, turnID: input.TurnID,
	})
	var result CreateSessionResult
	err := h.withWorkspaceRuntimeOperation(ctx, workspaceID, func(operationCtx context.Context) error {
		var createErr error
		result, createErr = h.createSession(operationCtx, workspaceID, input)
		return createErr
	})
	command.finish(ctx, h, err)
	return result, err
}

func (h *Host) createSession(ctx context.Context, workspaceID string, input CreateSessionInput) (CreateSessionResult, error) {
	workspaceID, input.AgentSessionID = strings.TrimSpace(workspaceID), strings.TrimSpace(input.AgentSessionID)
	input.Provider, input.AgentTargetID = strings.TrimSpace(input.Provider), strings.TrimSpace(input.AgentTargetID)
	if h == nil || h.runtime == nil || h.store == nil || workspaceID == "" || input.AgentSessionID == "" || input.Provider == "" {
		return createSessionFailureResult(input, ErrInvalidArgument)
	}
	var err error
	input.RailPlacement, err = normalizeRailPlacement(input.RailPlacement)
	if err != nil {
		return createSessionFailureResult(input, err)
	}
	ref := SessionRef{WorkspaceID: workspaceID, AgentSessionID: input.AgentSessionID}
	normalized, promptText, err := normalizeOptionalPromptContent(input.InitialContent)
	if err != nil {
		return createSessionFailureResult(input, err)
	}
	typedGoal, isTypedGoal := ParseTypedGoalControl(normalized, false)
	if input.InitialGoalControl != nil {
		if len(normalized) != 0 {
			return createSessionFailureResult(input, ErrInvalidArgument)
		}
		typedGoal, err = normalizeTypedGoalControl(*input.InitialGoalControl)
		if err != nil {
			return createSessionFailureResult(input, err)
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
			return createSessionFailureResult(input, errors.Join(ErrSubmitDeliveryUnknown, err))
		}
		return createSessionFailureResult(input, err)
	}
	if claim.ClientSubmitID != "" && !claimPending {
		if claim.Status != "accepted" && claim.Status != "rejected" {
			return createSessionFailureResult(input, ErrSubmitDeliveryUnknown)
		}
		canonicalSession, _, readErr := h.store.GetSession(ctx, workspaceID, input.AgentSessionID)
		if readErr != nil {
			return createSessionFailureResult(input, readErr)
		}
		if !railPlacementMatchesSession(input.RailPlacement, canonicalSession) {
			return createSessionFailureResult(input, ErrRailPlacementConflict)
		}
		runtimeSession, _ := h.runtime.Session(workspaceID, input.AgentSessionID)
		return CreateSessionResult{Session: runtimeSession, Canonical: canonicalSession, TurnID: claim.TurnID, SessionStatus: CreateSessionStatusCreated, InitialGoalStatus: CreateSessionInitialGoalStatusNotRequested}, nil
	}
	defer func() {
		if claimPending {
			h.abandonSubmitClaim(ref, claim.ClientSubmitID)
		}
	}()
	runtimePublisher, ok := h.runtime.(RuntimeSessionInitializationPublisher)
	if !ok {
		return createSessionFailureResult(input, ErrRuntimeSessionPublishUnavailable)
	}

	prepared := PreparedRuntime{Cwd: strings.TrimSpace(value(input.Cwd))}
	if h.preparation != nil {
		preparedAt := h.now()
		prepared, err = h.preparation.Prepare(ctx, createPreparationInput(workspaceID, input))
		// Only observe failures here. Service adapters already emit the success
		// node_result for runtime_prepared before Host CreateSession; a success
		// LifecycleStep would duplicate that analytics event.
		if err != nil {
			h.observeStep(ctx, "session_create", "runtime_prepared", workspaceID, input.AgentSessionID, input.Provider, preparedAt, err)
			return createSessionFailureResult(input, err)
		}
	}
	sessionLockHeld := false
	cleanup := func(cause error, started bool, canonicalCreated bool) error {
		return h.cleanupFailedCreate(ctx, ref, input.Provider, cause, failedCreateCleanupState{
			RuntimeStarted: started, CanonicalCreated: canonicalCreated, SessionLockHeld: sessionLockHeld,
		})
	}
	releaseSession, err := h.acquireSession(ctx, ref)
	if err != nil {
		return createSessionFailureResult(input, cleanup(err, false, false))
	}
	sessionLockHeld = true
	defer func() {
		if sessionLockHeld {
			releaseSession()
		}
	}()
	canonicalBeforeStart, canonicalExisted, err := h.store.GetSession(ctx, workspaceID, input.AgentSessionID)
	if err != nil {
		return createSessionFailureResult(input, cleanup(err, false, false))
	}
	if canonicalExisted && !railPlacementMatchesSession(input.RailPlacement, canonicalBeforeStart) {
		return createSessionFailureResult(input, cleanup(ErrRailPlacementConflict, false, false))
	}
	startedAt := h.now()
	release, err := h.acquireStartup(ctx, input.Provider)
	if err != nil {
		h.observeStep(ctx, "session_create", "runtime_started", workspaceID, input.AgentSessionID, input.Provider, startedAt, err)
		return createSessionFailureResult(input, cleanup(err, false, false))
	}
	startResult, err := func() (RuntimeStartResult, error) {
		defer release()
		runtimeTitle, initialTitleEstablished := initialGoalRuntimeTitle(value(input.Title), input.InitialDisplayPrompt, typedGoal, isTypedGoal)
		return h.runtime.Start(ctx, RuntimeStartInput{
			WorkspaceID: workspaceID, AgentSessionID: input.AgentSessionID, AgentTargetID: input.AgentTargetID,
			Provider: input.Provider, Cwd: prepared.Cwd, Env: append([]string(nil), prepared.Env...),
			MCPServers: cloneHostMCPServerBindings(prepared.MCPServers), Title: runtimeTitle, InitialTitleEstablished: initialTitleEstablished,
			PermissionModeID: value(input.PermissionModeID), Model: value(input.Model), PlanMode: valueBool(input.PlanMode),
			BrowserUse: input.BrowserUse, ComputerUse: input.ComputerUse, CodexSaverMode: valueBool(input.CodexSaverMode),
			ProviderTargetRef: cloneMap(firstMap(prepared.ProviderTargetRef, input.ProviderTargetRef)),
			RuntimeContext:    cloneMap(input.RuntimeContext), ReasoningEffort: value(input.ReasoningEffort),
			Speed: value(input.Speed), ConversationDetailMode: strings.TrimSpace(input.ConversationDetailMode),
			Visible: input.Visible, Provisional: len(normalized) > 0,
			CanonicalInitPending: true,
		})
	}()
	if err != nil {
		h.observeStep(ctx, "session_create", "runtime_started", workspaceID, input.AgentSessionID, input.Provider, startedAt, err)
		return createSessionFailureResult(input, cleanup(err, false, false))
	}
	session := startResult.Session
	runtimeCreated := startResult.Created
	h.observeStep(ctx, "session_create", "runtime_started", workspaceID, session.ID, session.Provider, startedAt, nil)
	startedAt = h.now()
	canonicalSession, err := h.store.InitializeRuntimeSession(ctx, RuntimeSessionInitialization{
		Session:       session,
		RailPlacement: input.RailPlacement,
	})
	if err != nil {
		h.observeStep(ctx, "session_create", "session_persisted", workspaceID, session.ID, session.Provider, startedAt, err)
		return createSessionFailureResult(input, cleanup(err, runtimeCreated, false))
	}
	canonicalCreated := !canonicalExisted
	if strings.TrimSpace(canonicalSession.ID) != strings.TrimSpace(session.ID) || strings.TrimSpace(canonicalSession.WorkspaceID) != workspaceID || strings.TrimSpace(canonicalSession.RailSectionKey) == "" {
		identityErr := fmt.Errorf("initialize workspace agent session: persisted session identity mismatch")
		h.observeStep(ctx, "session_create", "session_persisted", workspaceID, session.ID, session.Provider, startedAt, identityErr)
		return createSessionFailureResult(input, cleanup(identityErr, runtimeCreated, canonicalCreated))
	}
	if !railPlacementMatchesSession(input.RailPlacement, canonicalSession) {
		placementErr := ErrRailPlacementConflict
		h.observeStep(ctx, "session_create", "session_persisted", workspaceID, session.ID, session.Provider, startedAt, placementErr)
		return createSessionFailureResult(input, cleanup(placementErr, runtimeCreated, canonicalCreated))
	}
	h.observeStep(ctx, "session_create", "session_persisted", workspaceID, session.ID, session.Provider, startedAt, nil)
	startedAt = h.now()
	published, err := publishRuntimeSessionInitialization(
		ctx,
		runtimePublisher,
		RuntimeSessionInitializationPublishInput{
			WorkspaceID: workspaceID, AgentSessionID: session.ID,
		},
	)
	if err != nil {
		h.observeStep(ctx, "session_create", "session_published", workspaceID, session.ID, session.Provider, startedAt, err)
		return createSessionFailureResult(input, cleanup(err, runtimeCreated, canonicalCreated))
	}
	if strings.TrimSpace(published.ID) != strings.TrimSpace(session.ID) ||
		strings.TrimSpace(published.WorkspaceID) != workspaceID {
		publishErr := errors.New("publish workspace agent session: runtime session identity mismatch")
		h.observeStep(ctx, "session_create", "session_published", workspaceID, session.ID, session.Provider, startedAt, publishErr)
		return createSessionFailureResult(input, cleanup(publishErr, runtimeCreated, canonicalCreated))
	}
	session = published
	h.observeStep(ctx, "session_create", "session_published", workspaceID, session.ID, session.Provider, startedAt, nil)
	if len(normalized) == 0 && !isTypedGoal {
		return CreateSessionResult{Session: session, Canonical: canonicalSession, SessionStatus: CreateSessionStatusCreated, InitialGoalStatus: CreateSessionInitialGoalStatusNotRequested}, nil
	}
	if isTypedGoal {
		releaseSession()
		sessionLockHeld = false
		goalInput.AgentSessionID = session.ID
		goalResult, goalErr := h.goalControl(ctx, goalInput)
		if goalErr != nil {
			if goalControlResultPending(goalResult) {
				if refreshed, ok := h.runtime.Session(workspaceID, session.ID); ok {
					session = refreshed
				}
				return CreateSessionResult{
					Session: session, Canonical: canonicalSession, Kind: "goalControl", GoalControl: &goalResult,
					SessionStatus: CreateSessionStatusCreated, InitialGoalStatus: CreateSessionInitialGoalStatusUnknown,
				}, goalErr
			}
			// A typed goal starts from a non-provisional, already published
			// session. Preserve that canonical session on command failure just as
			// the legacy Service did; rolling it back would leave subscribers with
			// an unpaired session-created event.
			return CreateSessionResult{Session: session, Canonical: canonicalSession, Kind: "goalControl", SessionStatus: CreateSessionStatusCreated, InitialGoalStatus: CreateSessionInitialGoalStatusFailed}, cleanup(goalErr, runtimeCreated, false)
		}
		if refreshed, ok := h.runtime.Session(workspaceID, session.ID); ok {
			session = refreshed
		}
		return CreateSessionResult{Session: session, Canonical: goalResult.Canonical, Kind: "goalControl", GoalControl: &goalResult, SessionStatus: CreateSessionStatusCreated, InitialGoalStatus: CreateSessionInitialGoalStatusSucceeded}, nil
	}
	startedAt = h.now()
	if err := h.runtime.ValidatePromptContent(ctx, RuntimeExecInput{WorkspaceID: workspaceID, AgentSessionID: session.ID, Content: normalized}); err != nil {
		h.observeStep(ctx, "session_create", "prompt_validated", workspaceID, session.ID, session.Provider, startedAt, err)
		return createSessionFailureResult(input, cleanup(err, runtimeCreated, canonicalCreated))
	}
	h.observeStep(ctx, "session_create", "prompt_validated", workspaceID, session.ID, session.Provider, startedAt, nil)
	startedAt = h.now()
	preparedContent, err := h.prepareContent(workspaceID, session.ID, normalized)
	if err != nil {
		h.observeStep(ctx, "session_create", "prompt_prepared", workspaceID, session.ID, session.Provider, startedAt, err)
		return createSessionFailureResult(input, cleanup(err, runtimeCreated, canonicalCreated))
	}
	h.observeStep(ctx, "session_create", "prompt_prepared", workspaceID, session.ID, session.Provider, startedAt, nil)
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
		h.observeStep(ctx, "session_create", "runtime_exec", workspaceID, session.ID, session.Provider, startedAt, err)
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
				return createSessionCreatedErrorResult(input, session, canonicalSession, errors.Join(ErrSubmitDeliveryUnknown, err, persistErr))
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
						return createSessionCreatedErrorResult(input, session, canonicalSession, errors.Join(ErrSubmitDeliveryUnknown, err, rejectErr))
					}
				}
				return createSessionCreatedErrorResult(input, session, canonicalSession, h.discardRejectedPreparedRuntime(ctx, err, workspaceID, session.ID, session.Provider))
			}
			claimPending = false
			return createSessionCreatedErrorResult(input, session, canonicalSession, errors.Join(ErrSubmitDeliveryUnknown, err))
		}
		return createSessionFailureResult(input, cleanup(err, runtimeCreated, canonicalCreated))
	}
	turnID = strings.TrimSpace(execResult.TurnID)
	if turnID == "" {
		h.observeStep(ctx, "session_create", "runtime_exec", workspaceID, session.ID, session.Provider, startedAt, ErrSubmitDeliveryUnknown)
		return createSessionFailureResult(input, cleanup(ErrSubmitDeliveryUnknown, runtimeCreated, canonicalCreated))
	}
	if expectedTurnID := strings.TrimSpace(input.TurnID); expectedTurnID != "" && turnID != expectedTurnID {
		claimPending = false
		return createSessionCreatedErrorResult(input, session, canonicalSession, ErrSubmitDeliveryUnknown)
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
			return createSessionCreatedErrorResult(input, session, canonicalSession, errors.Join(ErrSubmitDeliveryUnknown, err))
		}
	}
	if err := h.recordTurnSubmission(
		ctx, ref, turnID, input.ClientSubmitID, preparedContent.Persisted,
		displayPrompt, input.CapabilityRefs, input.TuttiModeSnapshot,
	); err != nil {
		claimPending = false
		return createSessionCreatedErrorResult(input, session, canonicalSession, errors.Join(ErrSubmitDeliveryUnknown, err))
	}
	if claim.ClientSubmitID != "" {
		claimPending = false
		if err := h.acceptSubmitClaim(ref, claim.ClientSubmitID, turnID); err != nil {
			return createSessionCreatedErrorResult(input, session, canonicalSession, errors.Join(ErrSubmitDeliveryUnknown, err))
		}
	}
	if refreshed, ok := h.runtime.Session(workspaceID, session.ID); ok {
		session = refreshed
	}
	if refreshed, ok, readErr := h.store.GetSession(ctx, workspaceID, session.ID); readErr == nil && ok {
		canonicalSession = refreshed
	}
	h.observeStep(ctx, "session_create", "runtime_exec", workspaceID, session.ID, session.Provider, startedAt, nil)
	return CreateSessionResult{Session: session, Canonical: canonicalSession, TurnID: turnID, SessionStatus: CreateSessionStatusCreated, InitialGoalStatus: CreateSessionInitialGoalStatusNotRequested}, nil
}

func (h *Host) EnsureRuntimeSession(ctx context.Context, ref SessionRef) (ProviderRuntimeSession, error) {
	ref.WorkspaceID, ref.AgentSessionID = strings.TrimSpace(ref.WorkspaceID), strings.TrimSpace(ref.AgentSessionID)
	if h == nil || h.runtime == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return ProviderRuntimeSession{}, ErrSessionNotFound
	}
	var result ProviderRuntimeSession
	err := h.withWorkspaceRuntimeOperation(ctx, ref.WorkspaceID, func(operationCtx context.Context) error {
		var ensureErr error
		result, ensureErr = h.ensureRuntimeSession(operationCtx, ref)
		return ensureErr
	})
	return result, err
}

func (h *Host) ensureRuntimeSession(ctx context.Context, ref SessionRef) (ProviderRuntimeSession, error) {
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
		if !evidence.Established {
			evidence.Established, err = h.goalStateProvesProviderSessionEstablished(ctx, ref)
			if err != nil {
				return ProviderRuntimeSession{}, err
			}
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
		return ProviderRuntimeSession{}, h.cleanupRejectedPreparedRuntime(ctx, ref, canonicalSession.Provider, err)
	}
	defer release()
	goalGenerationFences, err := h.listRuntimeGoalGenerationFences(ctx, ref)
	if err != nil {
		return ProviderRuntimeSession{}, h.cleanupRejectedPreparedRuntime(ctx, ref, canonicalSession.Provider, err)
	}
	result, err := h.runtime.Resume(ctx, RuntimeResumeInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		AgentTargetID: strings.TrimSpace(canonicalSession.AgentTargetID), Provider: strings.TrimSpace(canonicalSession.Provider),
		ProviderSessionID: strings.TrimSpace(canonicalSession.ProviderSessionID), Resumable: evidence.Established, Cwd: prepared.Cwd,
		Env: append([]string(nil), prepared.Env...), MCPServers: cloneHostMCPServerBindings(prepared.MCPServers), Title: strings.TrimSpace(canonicalSession.Title),
		Status: persistedRuntimeStatus(canonicalSession.ActiveTurnID), Settings: settings,
		CreatedAtUnixMS: canonicalSession.CreatedAtUnixMS, UpdatedAtUnixMS: canonicalSession.UpdatedAtUnixMS,
		Visible: boolPointer(canonicalSession.Metadata.Visible), RuntimeContext: cloneMap(firstMap(prepared.RuntimeContext, canonicalSession.InternalRuntimeContext)),
		ProviderTargetRef: cloneMap(prepared.ProviderTargetRef), Metadata: canonicalSession.Metadata,
		InternalRuntimeContext: cloneMap(canonicalSession.InternalRuntimeContext),
		GoalGenerationFences:   append([]RuntimeGoalGenerationFenceInput(nil), goalGenerationFences...),
		RecreateIfMissing:      policy.Mode == ResumeModeRecreate,
	})
	if err != nil {
		return ProviderRuntimeSession{}, h.cleanupRejectedPreparedRuntime(ctx, ref, canonicalSession.Provider, err)
	}
	if err := h.restoreGoalGenerationFences(ctx, ref); err != nil {
		return ProviderRuntimeSession{}, h.cleanupRejectedPreparedRuntime(ctx, ref, canonicalSession.Provider, err)
	}
	h.goalFencesRestored.Store(ref.WorkspaceID+"\x00"+ref.AgentSessionID, struct{}{})
	return result, nil
}

// SendInput reports at most one aggregated TerminalFailure for a failed
// command. Guidance target binding and goal control own their own emissions.
func (h *Host) SendInput(ctx context.Context, ref SessionRef, input SendInput) (SendInputResult, error) {
	clientSubmitID := firstNonEmptyTrimmed(input.ClientSubmitID, legacyClientSubmitID(input.Metadata))
	ctx, command := h.beginCommand(ctx, commandTerminalFailureInput{
		flow: "message_send", workspaceID: ref.WorkspaceID, agentSessionID: ref.AgentSessionID,
		operationID:    firstNonEmptyTrimmed(clientSubmitID, input.TurnID),
		clientSubmitID: clientSubmitID, turnID: input.TurnID,
	})
	result, err := h.sendInput(ctx, ref, input)
	command.finish(ctx, h, err)
	return result, err
}

func (h *Host) sendInput(ctx context.Context, ref SessionRef, input SendInput) (SendInputResult, error) {
	ref.WorkspaceID, ref.AgentSessionID = strings.TrimSpace(ref.WorkspaceID), strings.TrimSpace(ref.AgentSessionID)
	if h == nil || h.runtime == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return SendInputResult{}, ErrInvalidArgument
	}
	// Guidance is a mutation of an already-running canonical Turn. Host
	// consumers must bind that mutation to the exact Turn observed at the
	// interaction boundary; allowing the runtime to infer "current" would make
	// an A->B transition during transport silently steer B.
	if input.Guidance && strings.TrimSpace(input.TurnID) == "" {
		err := ErrActiveTurnTargetRequired
		h.observeTerminalFailure(ctx, TerminalFailure{
			Flow:           "guidance",
			FailureStage:   "guidance_target",
			WorkspaceID:    ref.WorkspaceID,
			AgentSessionID: ref.AgentSessionID,
			ClientSubmitID: strings.TrimSpace(input.ClientSubmitID),
			ErrorCode:      guidanceTargetFailureCode(err),
			ErrorMessage:   err.Error(),
			Retryable:      false,
		})
		return SendInputResult{}, err
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
		h.observeStep(ctx, "message_send", "runtime_session_ready", ref.WorkspaceID, ref.AgentSessionID, "", startedAt, err)
		return SendInputResult{}, err
	}
	h.observeStep(ctx, "message_send", "runtime_session_ready", ref.WorkspaceID, ref.AgentSessionID, session.Provider, startedAt, nil)
	startedAt = h.now()
	if err := h.runtime.ValidatePromptContent(ctx, RuntimeExecInput{WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, Content: normalized}); err != nil {
		h.observeStep(ctx, "message_send", "prompt_validated", ref.WorkspaceID, ref.AgentSessionID, session.Provider, startedAt, err)
		return SendInputResult{}, err
	}
	h.observeStep(ctx, "message_send", "prompt_validated", ref.WorkspaceID, ref.AgentSessionID, session.Provider, startedAt, nil)
	startedAt = h.now()
	preparedContent, err := h.prepareContent(ref.WorkspaceID, ref.AgentSessionID, normalized)
	if err != nil {
		h.observeStep(ctx, "message_send", "prompt_prepared", ref.WorkspaceID, ref.AgentSessionID, session.Provider, startedAt, err)
		return SendInputResult{}, err
	}
	h.observeStep(ctx, "message_send", "prompt_prepared", ref.WorkspaceID, ref.AgentSessionID, session.Provider, startedAt, nil)
	displayPrompt, initialTitle := strings.TrimSpace(input.DisplayPrompt), ""
	if !input.Guidance && !session.InitialTitleEstablished {
		initialTitle = DeriveInitialTitle(session.Title, firstNonEmpty(displayPrompt, promptText, preparedContent.DisplayText))
	}
	startedAt = h.now()
	releaseStartup, err := h.acquireStartup(ctx, session.Provider)
	if err != nil {
		h.observeStep(ctx, "message_send", "runtime_exec", ref.WorkspaceID, ref.AgentSessionID, session.Provider, startedAt, err)
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
		// Only an explicit target verdict is a guidance-target failure. Any
		// other undispatched guidance is an ordinary runtime_exec failure that
		// the command boundary aggregates.
		if input.Guidance &&
			(errors.Is(err, ErrActiveTurnTargetMismatch) || errors.Is(err, ErrActiveTurnTargetRequired)) {
			h.observeGuidanceTargetFailure(ctx, ref, session.Provider, input.TurnID, claim.ClientSubmitID, startedAt, err)
		} else {
			h.observeStep(ctx, "message_send", "runtime_exec", ref.WorkspaceID, ref.AgentSessionID, session.Provider, startedAt, err)
		}
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
		h.observeStep(ctx, "message_send", "runtime_exec", ref.WorkspaceID, ref.AgentSessionID, session.Provider, startedAt, ErrSubmitDeliveryUnknown)
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
	h.observeStep(ctx, "message_send", "runtime_exec", ref.WorkspaceID, ref.AgentSessionID, session.Provider, startedAt, nil)
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
	if h.editRetryDisabled {
		// Durable edit-retry is neutralized, so a fence whose owning operation is
		// no longer in flight can never clear through the saga (recovery only
		// quarantines claimable operations; a previously failed one is invisible
		// to it). Heal it here so the session is not send-blocked forever; if the
		// clear does not apply (operation still in flight), fall through to the
		// normal fence error.
		if cleared, clearErr := h.effectiveHistory.ClearAbandonedEditRetryFence(ctx, storesqlite.ClearAbandonedEditRetryFenceInput{
			WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, NowUnixMS: h.now().UnixMilli(),
		}); clearErr == nil && cleared {
			return nil
		}
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
