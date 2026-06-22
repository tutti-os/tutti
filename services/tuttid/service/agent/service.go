package agent

import (
	"context"
	"errors"
	"log/slog"
	"sort"
	"strings"

	"github.com/google/uuid"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agentsidecarservice "github.com/tutti-os/tutti/services/tuttid/service/agentsidecar"
)

var (
	ErrInvalidArgument                  = errors.New("invalid agent session request")
	ErrPromptImageUnsupported           = errors.New("agent prompt image input is unsupported")
	ErrSessionNotFound                  = errors.New("workspace agent session not found")
	ErrSessionSettingsRequireNewSession = errors.New("agent session settings update requires a new session to preserve context")
)

func NewService(runtime RuntimeController) *Service {
	if runtime == nil {
		panic("agent service requires a runtime")
	}
	return &Service{
		Runtime:                   runtime,
		skillOptionsCache:         newComposerSkillOptionsCache(),
		providerAvailabilityCache: newProviderAvailabilityCache(),
		capabilityCatalogCache:    newComposerCapabilityCatalogCache(),
	}
}

func (s *Service) List(ctx context.Context, workspaceID string) ([]Session, error) {
	return s.ListFiltered(ctx, workspaceID, ListSessionsInput{})
}

func (s *Service) ListFiltered(ctx context.Context, workspaceID string, input ListSessionsInput) ([]Session, error) {
	_ = ctx
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil, ErrInvalidArgument
	}
	sessionByID := make(map[string]Session)
	if s.SessionReader != nil {
		if persisted, ok := s.SessionReader.ListSessions(workspaceID); ok {
			for _, session := range persisted {
				sessionByID[strings.TrimSpace(session.ID)] = sessionFromPersisted(
					session,
					persistedSessionCanResume(s.controller(), session),
				)
			}
		}
	}
	sessions := s.controller().Sessions(workspaceID)
	for _, session := range sessions {
		service := serviceSession(
			session,
			s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session)),
		)
		if s.SessionReader != nil {
			if persisted, ok := s.SessionReader.GetSession(workspaceID, session.ID); ok {
				service = mergePersistedSessionState(service, persisted)
			}
		}
		sessionByID[strings.TrimSpace(session.ID)] = service
	}
	result := make([]Session, 0, len(sessionByID))
	for _, session := range sessionByID {
		result = append(result, cloneSession(session))
	}

	result = filterSessions(result, input)
	sort.SliceStable(result, func(left, right int) bool {
		leftUpdatedAtUnixMS := sessionUpdatedAtUnixMS(result[left])
		rightUpdatedAtUnixMS := sessionUpdatedAtUnixMS(result[right])
		if leftUpdatedAtUnixMS == rightUpdatedAtUnixMS {
			return strings.TrimSpace(result[left].ID) < strings.TrimSpace(result[right].ID)
		}
		return leftUpdatedAtUnixMS > rightUpdatedAtUnixMS
	})
	if input.Limit > 0 && len(result) > input.Limit {
		result = result[:input.Limit]
	}
	return result, nil
}

func (s *Service) Create(ctx context.Context, workspaceID string, input CreateSessionInput) (Session, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	provider := strings.TrimSpace(input.Provider)
	if workspaceID == "" || provider == "" {
		return Session{}, ErrInvalidArgument
	}
	input.Provider = provider
	if normalizedPermissionModeID := normalizePermissionModeIDForProvider(
		provider,
		value(input.PermissionModeID),
	); normalizedPermissionModeID != "" {
		input.PermissionModeID = &normalizedPermissionModeID
	} else {
		input.PermissionModeID = nil
	}
	input.AgentSessionID = agentSessionIDOrNew(input.AgentSessionID)
	var normalizedContent []PromptContentBlock
	if len(input.InitialContent) > 0 {
		var err error
		normalizedContent, _, err = normalizePromptContent(input.InitialContent)
		if err != nil {
			return Session{}, err
		}
	}
	if err := s.ensureProviderRuntimeInstalled(ctx, provider); err != nil {
		return Session{}, err
	}
	cwd, err := s.resolveCwd(ctx, input.Cwd)
	if err != nil {
		return Session{}, err
	}
	prepared, err := s.prepareRuntime(ctx, workspaceID, cwd, input)
	if err != nil {
		return Session{}, err
	}
	cleanupPrepared := func(cause error) error {
		cleanupErr := s.cleanupRuntime(ctx, workspaceID, strings.TrimSpace(input.AgentSessionID))
		if cleanupErr == nil {
			return cause
		}
		return errors.Join(cause, cleanupErr)
	}
	session, err := s.controller().Start(ctx, RuntimeStartInput{
		WorkspaceID:      workspaceID,
		AgentSessionID:   strings.TrimSpace(input.AgentSessionID),
		Provider:         provider,
		Cwd:              prepared.Cwd,
		Env:              prepared.Env,
		Title:            value(input.Title),
		PermissionModeID: value(input.PermissionModeID),
		Model:            clampComposerModelForProvider(provider, value(input.Model)),
		PlanMode:         clampComposerPlanModeForProvider(provider, valueBool(input.PlanMode)),
		ReasoningEffort: normalizeReasoningEffortForProvider(
			provider,
			value(input.ReasoningEffort),
		),
		BrowserUse:  input.BrowserUse,
		ComputerUse: input.ComputerUse,
		Speed: normalizeSpeedForProvider(
			provider,
			value(input.Speed),
		),
		Visible: input.Visible,
	})
	if err != nil {
		return Session{}, cleanupPrepared(normalizeRuntimeError(err))
	}
	if len(normalizedContent) == 0 {
		return serviceSessionWithComposerSkillOptions(
			session,
			s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session)),
			s.discoverComposerSkillOptions(session.Provider, session.Cwd, session.Env),
		), nil
	}
	if err := s.validatePromptContentForExec(ctx, workspaceID, session.ID, normalizedContent); err != nil {
		closeErr := s.controller().Close(ctx, RuntimeCloseInput{
			WorkspaceID:    workspaceID,
			AgentSessionID: session.ID,
		})
		return Session{}, cleanupPrepared(errors.Join(err, closeErr))
	}
	content, _, err := s.prepareNormalizedPromptContentForExec(workspaceID, session.ID, normalizedContent, "")
	if err != nil {
		closeErr := s.controller().Close(ctx, RuntimeCloseInput{
			WorkspaceID:    workspaceID,
			AgentSessionID: session.ID,
		})
		return Session{}, cleanupPrepared(errors.Join(err, closeErr))
	}
	displayPrompt := strings.TrimSpace(input.InitialDisplayPrompt)
	if _, err := s.controller().Exec(ctx, RuntimeExecInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: session.ID,
		Content:        content,
		DisplayPrompt:  displayPrompt,
	}); err != nil {
		closeErr := s.controller().Close(ctx, RuntimeCloseInput{
			WorkspaceID:    workspaceID,
			AgentSessionID: session.ID,
		})
		return Session{}, cleanupPrepared(errors.Join(normalizeRuntimeError(err), closeErr))
	}
	if refreshed, ok := s.controller().Session(workspaceID, session.ID); ok {
		session = refreshed
	}
	return serviceSessionWithComposerSkillOptions(
		session,
		s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session)),
		s.discoverComposerSkillOptions(session.Provider, session.Cwd, session.Env),
	), nil
}

func agentSessionIDOrNew(agentSessionID string) string {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID != "" {
		return agentSessionID
	}
	return uuid.NewString()
}

type preparedRuntime struct {
	Cwd string
	Env []string
}

func (s *Service) prepareRuntime(ctx context.Context, workspaceID string, cwd string, input CreateSessionInput) (preparedRuntime, error) {
	if s.RuntimePreparer == nil {
		return preparedRuntime{Cwd: cwd}, nil
	}
	provider := strings.TrimSpace(input.Provider)
	prepared, err := s.RuntimePreparer.Prepare(ctx, agentsidecarservice.PrepareInput{
		WorkspaceID:      workspaceID,
		AgentSessionID:   strings.TrimSpace(input.AgentSessionID),
		Provider:         provider,
		Cwd:              cwd,
		Title:            value(input.Title),
		PermissionModeID: value(input.PermissionModeID),
		PlanMode:         clampComposerPlanModeForProvider(provider, valueBool(input.PlanMode)),
		BrowserUse:       clampComposerBrowserUseForProvider(provider, input.BrowserUse),
		ComputerUse:      clampComposerComputerUseForProvider(provider, input.ComputerUse),
		Model:            clampComposerModelForProvider(provider, value(input.Model)),
		ReasoningEffort: normalizeReasoningEffortForProvider(
			provider,
			value(input.ReasoningEffort),
		),
		ExtraSkills: sessionSkillBundlesToProviderSkillBundles(input.ExtraSkills),
	})
	if err != nil {
		return preparedRuntime{}, err
	}
	if strings.TrimSpace(prepared.Cwd) == "" {
		prepared.Cwd = cwd
	}
	return preparedRuntime{
		Cwd: prepared.Cwd,
		Env: append([]string(nil), prepared.Env...),
	}, nil
}

func sessionSkillBundlesToProviderSkillBundles(input []SessionSkillBundle) []agentsidecarservice.ProviderSkillBundle {
	if len(input) == 0 {
		return nil
	}
	bundles := make([]agentsidecarservice.ProviderSkillBundle, 0, len(input))
	for _, skill := range input {
		files := make(map[string]string, len(skill.Files))
		for path, content := range skill.Files {
			files[path] = content
		}
		bundles = append(bundles, agentsidecarservice.ProviderSkillBundle{
			Name:  skill.Name,
			Files: files,
		})
	}
	return bundles
}

func (s *Service) resolveCwd(ctx context.Context, input *string) (string, error) {
	cwd := value(input)
	if cwd != "" {
		return cwd, nil
	}
	if s.SessionDirectoryAllocator == nil {
		return "", nil
	}
	return s.SessionDirectoryAllocator.CreateSessionDirectory(ctx)
}

func (s *Service) Get(ctx context.Context, workspaceID string, agentSessionID string) (Session, error) {
	return s.get(ctx, workspaceID, agentSessionID, true)
}

func (s *Service) ReadAttachment(ctx context.Context, workspaceID string, agentSessionID string, attachmentID string) (PromptAttachment, error) {
	_ = ctx
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	attachmentID = strings.TrimSpace(attachmentID)
	if workspaceID == "" || agentSessionID == "" || attachmentID == "" {
		return PromptAttachment{}, ErrInvalidArgument
	}
	store := s.PromptAttachmentStore
	if strings.TrimSpace(store.RootDir) == "" {
		return PromptAttachment{}, ErrSessionNotFound
	}
	return store.ReadAttachment(workspaceID, agentSessionID, attachmentID)
}

func (s *Service) get(ctx context.Context, workspaceID string, agentSessionID string, reconcileStaleTurn bool) (Session, error) {
	session, ok := s.controller().Session(workspaceID, agentSessionID)
	if ok {
		if reconcileStaleTurn && !isRuntimeActiveTurnStatus(session.Status) {
			if _, err := s.reconcilePersistedStaleTurn(ctx, workspaceID, agentSessionID); err != nil {
				return Session{}, err
			}
		}
		service := serviceSession(
			session,
			s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session)),
		)
		if s.SessionReader != nil {
			if persisted, ok := s.SessionReader.GetSession(workspaceID, agentSessionID); ok {
				service = mergePersistedSessionState(service, persisted)
			}
		}
		return service, nil
	}
	if reconcileStaleTurn {
		if _, err := s.reconcilePersistedStaleTurn(ctx, workspaceID, agentSessionID); err != nil {
			return Session{}, err
		}
	}
	if s.SessionReader != nil {
		if persisted, ok := s.SessionReader.GetSession(workspaceID, agentSessionID); ok {
			return sessionFromPersisted(
				persisted,
				persistedSessionCanResume(s.controller(), persisted),
			), nil
		}
	}
	return Session{}, ErrSessionNotFound
}

func (s *Service) Delete(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return false, ErrInvalidArgument
	}
	runtimeClosed := false
	if _, ok := s.controller().Session(workspaceID, agentSessionID); ok {
		if err := s.controller().Close(ctx, RuntimeCloseInput{
			WorkspaceID:    workspaceID,
			AgentSessionID: agentSessionID,
		}); err != nil {
			return false, normalizeRuntimeError(err)
		}
		runtimeClosed = true
	}
	deleter, ok := s.SessionReader.(SessionDeleter)
	if !ok {
		if runtimeClosed {
			if err := s.cleanupRuntime(ctx, workspaceID, agentSessionID); err != nil {
				return false, err
			}
			return true, nil
		}
		return false, ErrSessionNotFound
	}
	removed, err := deleter.DeleteSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return false, err
	}
	if !removed && !runtimeClosed {
		return false, ErrSessionNotFound
	}
	if err := s.cleanupRuntime(ctx, workspaceID, agentSessionID); err != nil {
		return false, err
	}
	return removed || runtimeClosed, nil
}

func (s *Service) Clear(ctx context.Context, workspaceID string) (ClearSessionsResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return ClearSessionsResult{}, ErrInvalidArgument
	}
	for _, session := range s.controller().Sessions(workspaceID) {
		if err := s.controller().Close(ctx, RuntimeCloseInput{
			WorkspaceID:    workspaceID,
			AgentSessionID: session.ID,
		}); err != nil {
			return ClearSessionsResult{}, normalizeRuntimeError(err)
		}
		if err := s.cleanupRuntime(ctx, workspaceID, session.ID); err != nil {
			return ClearSessionsResult{}, err
		}
	}
	clearer, ok := s.SessionReader.(SessionClearer)
	if !ok {
		return ClearSessionsResult{}, ErrSessionNotFound
	}
	return clearer.ClearSessions(ctx, workspaceID)
}

func (s *Service) UpdatePin(ctx context.Context, workspaceID string, agentSessionID string, pinned bool) (Session, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return Session{}, ErrInvalidArgument
	}
	updater, ok := s.SessionReader.(SessionPinUpdater)
	if !ok {
		return Session{}, ErrSessionNotFound
	}
	persisted, updated, err := updater.UpdateSessionPinned(ctx, workspaceID, agentSessionID, pinned)
	if err != nil {
		return Session{}, err
	}
	if !updated {
		return Session{}, ErrSessionNotFound
	}
	if runtime, ok := s.controller().Session(workspaceID, agentSessionID); ok {
		service := serviceSession(
			runtime,
			s.controller().CanResume(runtimeResumeInputFromRuntimeSession(runtime)),
		)
		return mergePersistedSessionState(service, persisted), nil
	}
	return sessionFromPersisted(
		persisted,
		persistedSessionCanResume(s.controller(), persisted),
	), nil
}

func (s *Service) cleanupRuntime(ctx context.Context, workspaceID string, agentSessionID string) error {
	if s.RuntimePreparer == nil {
		return nil
	}
	return s.RuntimePreparer.Cleanup(ctx, agentsidecarservice.CleanupInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
	})
}

func (s *Service) Cancel(ctx context.Context, workspaceID string, agentSessionID string) (CancelSessionResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	slog.Info("workspace agent session cancel requested",
		"event", "workspace_agent_session.cancel.requested",
		"workspaceId", workspaceID,
		"agentSessionId", agentSessionID,
	)
	ensured, err := s.ensureRuntimeSessionResult(ctx, workspaceID, agentSessionID)
	if err != nil {
		slog.Warn("workspace agent session cancel prepare failed",
			"event", "workspace_agent_session.cancel.prepare_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"error", err.Error(),
		)
		return CancelSessionResult{}, err
	}
	if ensured.StaleTurnReconciled {
		session, getErr := s.get(ctx, workspaceID, agentSessionID, false)
		if getErr != nil {
			slog.Warn("workspace agent session cancel stale turn refresh failed",
				"event", "workspace_agent_session.cancel.stale_turn_refresh_failed",
				"workspaceId", workspaceID,
				"agentSessionId", agentSessionID,
				"error", getErr.Error(),
			)
			return CancelSessionResult{}, getErr
		}
		slog.Info("workspace agent session cancel skipped after stale turn reconciliation",
			"event", "workspace_agent_session.cancel.stale_turn_reconciled",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"cancelReason", string(CancelReasonStaleTurnReconciled),
			"returnedStatus", session.Status,
		)
		return CancelSessionResult{
			Session:  session,
			Canceled: false,
			Reason:   CancelReasonStaleTurnReconciled,
		}, nil
	}
	cancelResult, err := s.controller().Cancel(ctx, RuntimeCancelInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Reason:         "user requested cancellation",
	})
	if err != nil {
		normalizedErr := normalizeRuntimeError(err)
		slog.Warn("workspace agent session cancel runtime request failed",
			"event", "workspace_agent_session.cancel.runtime_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"error", normalizedErr.Error(),
		)
		return CancelSessionResult{}, normalizedErr
	}
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		slog.Warn("workspace agent session cancel refresh failed",
			"event", "workspace_agent_session.cancel.refresh_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"error", err.Error(),
		)
		return CancelSessionResult{}, err
	}
	cancelReason := cancelReasonFromRuntimeResult(cancelResult)
	slog.Info("workspace agent session cancel completed",
		"event", "workspace_agent_session.cancel.completed",
		"workspaceId", workspaceID,
		"agentSessionId", agentSessionID,
		"runtimeAgentSessionId", cancelResult.AgentSessionID,
		"runtimeCanceled", cancelResult.Canceled,
		"cancelReason", string(cancelReason),
		"returnedStatus", session.Status,
	)
	return CancelSessionResult{
		Session:  session,
		Canceled: cancelResult.Canceled,
		Reason:   cancelReason,
	}, nil
}

func cancelReasonFromRuntimeResult(result RuntimeCancelResult) CancelReason {
	if result.Canceled {
		return CancelReasonActiveTurnCanceled
	}
	return CancelReasonNoActiveTurn
}

func (s *Service) SendInput(ctx context.Context, workspaceID string, agentSessionID string, input SendInput) (Session, error) {
	if _, err := s.ensureRuntimeSession(ctx, workspaceID, agentSessionID); err != nil {
		return Session{}, err
	}
	normalizedContent, _, err := normalizePromptContent(input.Content)
	if err != nil {
		return Session{}, err
	}
	if err := s.validatePromptContentForExec(ctx, workspaceID, agentSessionID, normalizedContent); err != nil {
		return Session{}, err
	}
	content, _, err := s.prepareNormalizedPromptContentForExec(workspaceID, agentSessionID, normalizedContent, "")
	if err != nil {
		return Session{}, err
	}
	displayPrompt := strings.TrimSpace(input.DisplayPrompt)
	result, err := s.controller().Exec(ctx, RuntimeExecInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Content:        content,
		DisplayPrompt:  displayPrompt,
	})
	if err != nil {
		return Session{}, normalizeRuntimeError(err)
	}
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, err
	}
	if strings.TrimSpace(result.SessionStatus) != "" {
		session.Status = serviceStatus(result.SessionStatus)
		session.EndedAt = endedAtForStatus(result.SessionStatus, session.UpdatedAt)
	}
	return session, nil
}

func (s *Service) validatePromptContentForExec(ctx context.Context, workspaceID, agentSessionID string, content []PromptContentBlock) error {
	if err := s.controller().ValidatePromptContent(ctx, RuntimeExecInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Content:        content,
	}); err != nil {
		return normalizeRuntimeError(err)
	}
	return nil
}

func (s *Service) prepareNormalizedPromptContentForExec(workspaceID, agentSessionID string, content []PromptContentBlock, displayPrompt string) ([]PromptContentBlock, string, error) {
	store := s.PromptAttachmentStore
	persisted, err := store.PersistRequestContent(workspaceID, agentSessionID, content)
	if err != nil {
		return nil, "", err
	}
	hydrated, err := store.HydrateRuntimeContent(workspaceID, agentSessionID, persisted)
	if err != nil {
		return nil, "", err
	}
	if strings.TrimSpace(displayPrompt) == "" {
		displayPrompt = promptImageOnlyDisplayText(persisted)
	}
	return hydrated, displayPrompt, nil
}

func (s *Service) UpdateSettings(ctx context.Context, workspaceID string, agentSessionID string, settings ComposerSettingsPatch) (Session, error) {
	ensured, err := s.ensureRuntimeSessionResult(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, err
	}
	if settings.ReasoningEffort != nil {
		normalizedReasoningEffort := normalizeReasoningEffortForProvider(
			strings.TrimSpace(ensured.Session.Provider),
			*settings.ReasoningEffort,
		)
		settings.ReasoningEffort = &normalizedReasoningEffort
	}
	if settings.Speed != nil {
		normalizedSpeed := normalizeSpeedForProvider(
			strings.TrimSpace(ensured.Session.Provider),
			*settings.Speed,
		)
		settings.Speed = &normalizedSpeed
	}
	if err := s.controller().UpdateSettings(ctx, RuntimeUpdateSettingsInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Settings:       settings,
	}); err != nil {
		return Session{}, normalizeRuntimeError(err)
	}
	return s.Get(ctx, workspaceID, agentSessionID)
}

func (s *Service) SubmitInteractive(ctx context.Context, workspaceID string, agentSessionID string, requestID string, input SubmitInteractiveInput) (Session, error) {
	ensured, err := s.ensureRuntimeSessionResult(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, err
	}
	if ensured.StaleTurnReconciled {
		return s.get(ctx, workspaceID, agentSessionID, false)
	}
	if err := s.controller().SubmitInteractive(ctx, RuntimeSubmitInteractiveInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		RequestID:      requestID,
		Action:         optionalInputString(input.Action),
		OptionID:       optionalInputString(input.OptionID),
		Payload:        input.Payload,
	}); err != nil {
		return Session{}, normalizeRuntimeError(err)
	}
	return s.Get(ctx, workspaceID, agentSessionID)
}

func (s *Service) Subscribe(ctx context.Context, input StreamInput) (EventStream, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return EventStream{}, ErrInvalidArgument
	}
	if _, err := s.ensureRuntimeSession(ctx, workspaceID, agentSessionID); err != nil {
		return EventStream{}, err
	}
	events, unsubscribe, ok := s.controller().Subscribe(workspaceID, agentSessionID)
	if !ok {
		return EventStream{}, ErrSessionNotFound
	}
	return EventStream{
		Events:      serviceStreamEvents(ctx, events),
		Unsubscribe: unsubscribe,
	}, nil
}

func (s *Service) controller() RuntimeController {
	return s.Runtime
}

func optionalInputString(input *string) string {
	if input == nil {
		return ""
	}
	return strings.TrimSpace(*input)
}

func (s *Service) ensureRuntimeSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (RuntimeSession, error) {
	ensured, err := s.ensureRuntimeSessionResult(ctx, workspaceID, agentSessionID)
	return ensured.Session, err
}

type ensuredRuntimeSession struct {
	Session             RuntimeSession
	StaleTurnReconciled bool
}

func (s *Service) ensureRuntimeSessionResult(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (ensuredRuntimeSession, error) {
	if session, ok := s.controller().Session(workspaceID, agentSessionID); ok {
		staleTurnReconciled := false
		if !isRuntimeActiveTurnStatus(session.Status) {
			var err error
			staleTurnReconciled, err = s.reconcilePersistedStaleTurn(ctx, workspaceID, agentSessionID)
			if err != nil {
				return ensuredRuntimeSession{}, err
			}
		}
		return ensuredRuntimeSession{Session: session, StaleTurnReconciled: staleTurnReconciled}, nil
	}
	if s.SessionReader == nil {
		return ensuredRuntimeSession{}, ErrSessionNotFound
	}
	persisted, ok := s.SessionReader.GetSession(workspaceID, agentSessionID)
	if !ok || strings.TrimSpace(persisted.Provider) == "" {
		return ensuredRuntimeSession{}, ErrSessionNotFound
	}
	if strings.TrimSpace(persisted.Origin) == WorkspaceAgentSessionOriginImported {
		return ensuredRuntimeSession{}, ErrSessionNotFound
	}
	prepared, err := s.prepareRuntimeForResume(ctx, persisted)
	if err != nil {
		return ensuredRuntimeSession{}, err
	}
	session, err := s.controller().Resume(ctx, RuntimeResumeInput{
		WorkspaceID:       strings.TrimSpace(persisted.WorkspaceID),
		AgentSessionID:    strings.TrimSpace(persisted.ID),
		Provider:          strings.TrimSpace(persisted.Provider),
		ProviderSessionID: strings.TrimSpace(persisted.ProviderSessionID),
		Cwd:               strings.TrimSpace(prepared.Cwd),
		Env:               append([]string(nil), prepared.Env...),
		Title:             strings.TrimSpace(persisted.Title),
		Status:            strings.TrimSpace(persisted.Status),
		Settings:          cloneComposerSettings(persisted.Settings),
		CreatedAtUnixMS:   persisted.CreatedAtUnixMS,
		UpdatedAtUnixMS:   persisted.UpdatedAtUnixMS,
		Visible:           boolPointer(visibleFromRuntimeContext(persisted.RuntimeContext, true)),
	})
	if err != nil {
		return ensuredRuntimeSession{}, normalizeRuntimeError(err)
	}
	staleTurnReconciled, err := s.reconcileStaleTurnOnResume(ctx, persisted)
	if err != nil {
		return ensuredRuntimeSession{}, err
	}
	return ensuredRuntimeSession{Session: session, StaleTurnReconciled: staleTurnReconciled}, nil
}

func (s *Service) reconcilePersistedStaleTurn(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	if s.SessionReader == nil {
		return false, nil
	}
	persisted, ok := s.SessionReader.GetSession(workspaceID, agentSessionID)
	if !ok {
		return false, nil
	}
	return s.reconcileStaleTurnOnResume(ctx, persisted)
}

func (s *Service) reconcileStaleTurnOnResume(ctx context.Context, session PersistedSession) (bool, error) {
	shouldReconcile, err := s.shouldReconcileStaleTurn(session)
	if err != nil {
		return false, err
	}
	if !shouldReconcile {
		return false, nil
	}
	reconciler, ok := s.SessionReader.(StaleTurnResumeReconciler)
	if !ok || reconciler == nil {
		return false, nil
	}
	if err := reconciler.ReconcileStaleTurnOnResume(ctx, session); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Service) shouldReconcileStaleTurn(session PersistedSession) (bool, error) {
	if strings.TrimSpace(session.Origin) == WorkspaceAgentSessionOriginImported {
		return false, nil
	}
	if isResumeStaleTurnStatus(session.Status) || isResumeStaleTurnStatus(session.CurrentPhase) {
		return true, nil
	}
	if s == nil || s.MessageReader == nil {
		return false, nil
	}
	page, ok := s.MessageReader.ListSessionMessages(agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    strings.TrimSpace(session.WorkspaceID),
		AgentSessionID: strings.TrimSpace(session.ID),
		Limit:          100,
		Order:          agentactivitybiz.MessageOrderDesc,
	})
	if !ok {
		return false, nil
	}
	return hasStaleResumeOpenToolCall(page.Messages), nil
}

func hasStaleResumeOpenToolCall(messages []SessionMessage) bool {
	for _, message := range messages {
		if isStaleResumeOpenToolCall(message) {
			return true
		}
	}
	return false
}

func isResumeStaleTurnStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "working", "waiting":
		return true
	default:
		return false
	}
}

func isRuntimeActiveTurnStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "working", "waiting":
		return true
	default:
		return false
	}
}

func (s *Service) prepareRuntimeForResume(ctx context.Context, session PersistedSession) (preparedRuntime, error) {
	input := createSessionInputFromPersisted(session)
	return s.prepareRuntime(ctx, strings.TrimSpace(session.WorkspaceID), strings.TrimSpace(session.Cwd), input)
}
