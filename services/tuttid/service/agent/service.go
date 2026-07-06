package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentsidecarservice "github.com/tutti-os/tutti/services/tuttid/service/agentsidecar"
)

var (
	ErrInvalidArgument                  = errors.New("invalid agent session request")
	ErrActiveTurnGuidanceUnsupported    = errors.New("agent provider does not support active-turn guidance")
	ErrPromptImageUnsupported           = errors.New("agent prompt image input is unsupported")
	ErrSessionNoActiveTurn              = errors.New("agent session has no active turn")
	ErrSessionNotFound                  = errors.New("workspace agent session not found")
	ErrSkillBundleUnavailable           = errors.New("agent skill bundle renderer is unavailable")
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
		liveModelCache:            newComposerLiveModelCache(),
		claudeStartupLock:         newClaudeStartupSerializer(),
	}
}

func (s *Service) Create(ctx context.Context, workspaceID string, input CreateSessionInput) (Session, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	input.AgentTargetID = strings.TrimSpace(input.AgentTargetID)
	launch, err := s.resolveCreateSessionLaunch(ctx, input)
	if err != nil {
		return Session{}, err
	}
	provider := launch.Provider
	if workspaceID == "" || provider == "" {
		return Session{}, ErrInvalidArgument
	}
	input.Provider = provider
	input.ProviderTargetRef = launch.ProviderTargetRef
	input.ConversationDetailMode = preferencesbiz.NormalizeDesktopAgentConversationDetailMode(input.ConversationDetailMode)
	if normalizedPermissionModeID := normalizePermissionModeIDForProvider(
		provider,
		value(input.PermissionModeID),
	); normalizedPermissionModeID != "" {
		input.PermissionModeID = &normalizedPermissionModeID
	} else {
		input.PermissionModeID = nil
	}
	input.AgentSessionID = agentSessionIDOrNew(input.AgentSessionID)
	logAgentSubmitTrace("service.create.entered", workspaceID, input.AgentSessionID, input.Metadata, map[string]any{
		"provider": provider,
	})
	var normalizedContent []PromptContentBlock
	if len(input.InitialContent) > 0 {
		var err error
		nodeStartedAt := time.Now()
		normalizedContent, _, err = normalizePromptContent(input.InitialContent)
		if err != nil {
			s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "content_normalized", provider, nodeStartedAt, err)
			return Session{}, err
		}
		s.reportAgentServiceNodeSuccess(ctx, input.AgentSessionID, "session_create", "content_normalized", provider, nodeStartedAt)
	}
	logAgentSubmitTrace("service.create.content_normalized", workspaceID, input.AgentSessionID, input.Metadata, map[string]any{
		"content_block_count": len(normalizedContent),
	})
	nodeStartedAt := time.Now()
	if err := s.ensureProviderRuntimeInstalled(ctx, provider); err != nil {
		s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "provider_runtime_checked", provider, nodeStartedAt, err)
		return Session{}, err
	}
	s.reportAgentServiceNodeSuccess(ctx, input.AgentSessionID, "session_create", "provider_runtime_checked", provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.provider_ready", workspaceID, input.AgentSessionID, input.Metadata, nil)
	input.Model = s.resolveCreateSessionModel(ctx, provider, input.Model)
	nodeStartedAt = time.Now()
	if err := s.validateComposerModelForCreate(ctx, provider, workspaceID, value(input.Cwd), value(input.Model)); err != nil {
		s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "model_validated", provider, nodeStartedAt, err)
		return Session{}, err
	}
	s.reportAgentServiceNodeSuccess(ctx, input.AgentSessionID, "session_create", "model_validated", provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.model_validated", workspaceID, input.AgentSessionID, input.Metadata, map[string]any{
		"model": value(input.Model),
	})
	nodeStartedAt = time.Now()
	cwd, err := s.resolveCwd(ctx, input.Cwd)
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "cwd_resolved", provider, nodeStartedAt, err)
		return Session{}, err
	}
	s.reportAgentServiceNodeSuccess(ctx, input.AgentSessionID, "session_create", "cwd_resolved", provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.cwd_resolved", workspaceID, input.AgentSessionID, input.Metadata, map[string]any{
		"cwd": cwd,
	})
	nodeStartedAt = time.Now()
	prepared, err := s.prepareRuntime(ctx, workspaceID, cwd, input)
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "runtime_prepared", provider, nodeStartedAt, err)
		return Session{}, err
	}
	s.reportAgentServiceNodeSuccess(ctx, input.AgentSessionID, "session_create", "runtime_prepared", provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.runtime_prepared", workspaceID, input.AgentSessionID, input.Metadata, map[string]any{
		"cwd":       prepared.Cwd,
		"env_count": len(prepared.Env),
	})
	cleanupPrepared := func(cause error) error {
		cleanupErr := s.cleanupRuntime(ctx, workspaceID, strings.TrimSpace(input.AgentSessionID))
		if cleanupErr == nil {
			return cause
		}
		return errors.Join(cause, cleanupErr)
	}
	logAgentSubmitTrace("service.create.runtime_start_requested", workspaceID, input.AgentSessionID, input.Metadata, nil)
	nodeStartedAt = time.Now()
	// Wait out any in-flight Claude startup so this session never overlaps
	// another credential-touching Claude process during OAuth refresh. Released
	// as soon as this session has started.
	releaseStartup, err := s.awaitClaudeStartupSlot(ctx, provider)
	if err != nil {
		return Session{}, cleanupPrepared(err)
	}
	session, err := func() (RuntimeSession, error) {
		defer releaseStartup()
		return s.controller().Start(ctx, RuntimeStartInput{
			WorkspaceID:      workspaceID,
			AgentSessionID:   strings.TrimSpace(input.AgentSessionID),
			AgentTargetID:    input.AgentTargetID,
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
			BrowserUse:        input.BrowserUse,
			ComputerUse:       input.ComputerUse,
			ProviderTargetRef: clonePayload(input.ProviderTargetRef),
			RuntimeContext:    clonePayload(input.RuntimeContext),
			Speed: normalizeSpeedForProvider(
				provider,
				value(input.Speed),
			),
			ConversationDetailMode: input.ConversationDetailMode,
			Visible:                input.Visible,
		})
	}()
	if err != nil {
		normalizedErr := normalizeRuntimeError(err)
		s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "runtime_started", provider, nodeStartedAt, normalizedErr)
		return Session{}, cleanupPrepared(normalizedErr)
	}
	s.reportAgentServiceNodeSuccess(ctx, session.ID, "session_create", "runtime_started", session.Provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.runtime_start_resolved", workspaceID, session.ID, input.Metadata, map[string]any{
		"session_status": session.Status,
	})
	if len(normalizedContent) == 0 {
		return serviceSessionWithComposerSkillOptions(
			session,
			s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session)),
			s.discoverComposerSkillOptions(session.Provider, session.Cwd, session.Env),
		), nil
	}
	nodeStartedAt = time.Now()
	if err := s.validatePromptContentForExec(ctx, workspaceID, session.ID, normalizedContent); err != nil {
		s.reportAgentServiceNodeFailure(ctx, session.ID, "session_create", "prompt_validated", session.Provider, nodeStartedAt, err)
		closeErr := s.controller().Close(ctx, RuntimeCloseInput{
			WorkspaceID:    workspaceID,
			AgentSessionID: session.ID,
		})
		return Session{}, cleanupPrepared(errors.Join(err, closeErr))
	}
	s.reportAgentServiceNodeSuccess(ctx, session.ID, "session_create", "prompt_validated", session.Provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.prompt_validated", workspaceID, session.ID, input.Metadata, nil)
	nodeStartedAt = time.Now()
	content, _, err := s.prepareNormalizedPromptContentForExec(workspaceID, session.ID, normalizedContent, "")
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, session.ID, "session_create", "prompt_prepared", session.Provider, nodeStartedAt, err)
		closeErr := s.controller().Close(ctx, RuntimeCloseInput{
			WorkspaceID:    workspaceID,
			AgentSessionID: session.ID,
		})
		return Session{}, cleanupPrepared(errors.Join(err, closeErr))
	}
	s.reportAgentServiceNodeSuccess(ctx, session.ID, "session_create", "prompt_prepared", session.Provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.prompt_prepared", workspaceID, session.ID, input.Metadata, map[string]any{
		"content_block_count": len(content),
	})
	displayPrompt := strings.TrimSpace(input.InitialDisplayPrompt)
	logAgentSubmitTrace("service.create.exec_requested", workspaceID, session.ID, input.Metadata, nil)
	nodeStartedAt = time.Now()
	if _, err := s.controller().Exec(ctx, RuntimeExecInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: session.ID,
		Content:        content,
		DisplayPrompt:  displayPrompt,
		Metadata:       cloneMetadata(input.Metadata),
	}); err != nil {
		normalizedErr := normalizeRuntimeError(err)
		s.reportAgentServiceNodeFailure(ctx, session.ID, "session_create", "runtime_exec", session.Provider, nodeStartedAt, normalizedErr)
		closeErr := s.controller().Close(ctx, RuntimeCloseInput{
			WorkspaceID:    workspaceID,
			AgentSessionID: session.ID,
		})
		return Session{}, cleanupPrepared(errors.Join(normalizedErr, closeErr))
	}
	s.reportAgentServiceNodeSuccess(ctx, session.ID, "session_create", "runtime_exec", session.Provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.exec_resolved", workspaceID, session.ID, input.Metadata, nil)
	if refreshed, ok := s.controller().Session(workspaceID, session.ID); ok {
		session = refreshed
	}
	return serviceSessionWithComposerSkillOptions(
		session,
		s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session)),
		s.discoverComposerSkillOptions(session.Provider, session.Cwd, session.Env),
	), nil
}

type resolvedCreateSessionLaunch struct {
	Provider          string
	ProviderTargetRef map[string]any
}

func (s *Service) resolveCreateSessionLaunch(ctx context.Context, input CreateSessionInput) (resolvedCreateSessionLaunch, error) {
	requestProvider := strings.TrimSpace(input.Provider)
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	if agentTargetID == "" {
		return resolvedCreateSessionLaunch{}, fmt.Errorf("%w: agent target id is required for agent session launch", ErrInvalidArgument)
	}
	if s.AgentTargetStore == nil {
		return resolvedCreateSessionLaunch{}, fmt.Errorf("%w: agent target store is unavailable", ErrInvalidArgument)
	}
	target, err := s.AgentTargetStore.GetAgentTarget(ctx, agentTargetID)
	if err != nil {
		if errors.Is(err, workspacedata.ErrAgentTargetNotFound) {
			return resolvedCreateSessionLaunch{}, fmt.Errorf("%w: agent target not found", ErrInvalidArgument)
		}
		return resolvedCreateSessionLaunch{}, fmt.Errorf("get agent target: %w", err)
	}
	normalized, err := agenttargetbiz.NormalizeTarget(target)
	if err != nil {
		return resolvedCreateSessionLaunch{}, fmt.Errorf("%w: %v", ErrInvalidArgument, err)
	}
	if !normalized.Enabled {
		return resolvedCreateSessionLaunch{}, fmt.Errorf("%w: agent target is disabled", ErrInvalidArgument)
	}
	derivedRef, err := agenttargetbiz.RuntimeProviderTargetRef(normalized)
	if err != nil {
		return resolvedCreateSessionLaunch{}, fmt.Errorf("%w: invalid agent target launch ref", ErrInvalidArgument)
	}
	derivedProvider, _ := derivedRef["provider"].(string)
	derivedProvider = strings.TrimSpace(derivedProvider)
	if requestProvider != "" && requestProvider != derivedProvider {
		return resolvedCreateSessionLaunch{}, fmt.Errorf("%w: provider does not match agent target", ErrInvalidArgument)
	}
	return resolvedCreateSessionLaunch{
		Provider:          derivedProvider,
		ProviderTargetRef: derivedRef,
	}, nil
}

func (s *Service) resolveCreateSessionModel(ctx context.Context, provider string, model *string) *string {
	resolved := normalizeComposerModelForProvider(
		provider,
		clampComposerModelForProvider(provider, value(model)),
	)
	if resolved == "" {
		resolved = composerDefaultModel(ctx, provider, s.ModelCatalog)
	}
	if resolved == "" {
		return nil
	}
	return &resolved
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
		WorkspaceID:       workspaceID,
		AgentSessionID:    strings.TrimSpace(input.AgentSessionID),
		AgentTargetID:     strings.TrimSpace(input.AgentTargetID),
		Provider:          provider,
		Cwd:               cwd,
		Title:             value(input.Title),
		PermissionModeID:  value(input.PermissionModeID),
		PlanMode:          clampComposerPlanModeForProvider(provider, valueBool(input.PlanMode)),
		BrowserUse:        clampComposerBrowserUseForProvider(provider, input.BrowserUse),
		ComputerUse:       clampComposerComputerUseForProvider(provider, input.ComputerUse),
		ProviderTargetRef: clonePayload(input.ProviderTargetRef),
		Model:             clampComposerModelForProvider(provider, value(input.Model)),
		ReasoningEffort: normalizeReasoningEffortForProvider(
			provider,
			value(input.ReasoningEffort),
		),
		ConversationDetailMode:    input.ConversationDetailMode,
		ExtraSkills:               sessionSkillBundlesToProviderSkillBundles(input.ExtraSkills),
		Metadata:                  input.Metadata,
		ExternalRolloutSourcePath: input.ExternalRolloutSourcePath,
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

func (s *Service) LocalAttachmentPath(ctx context.Context, workspaceID string, agentSessionID string, attachmentID string, mimeType string) (string, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	attachmentID = strings.TrimSpace(attachmentID)
	if workspaceID == "" || agentSessionID == "" || attachmentID == "" {
		return "", ErrInvalidArgument
	}
	if _, err := s.Get(ctx, workspaceID, agentSessionID); err != nil {
		return "", err
	}
	store := s.PromptAttachmentStore
	if strings.TrimSpace(store.RootDir) == "" {
		return "", ErrSessionNotFound
	}
	return store.LocalPath(workspaceID, agentSessionID, attachmentID, mimeType)
}

func (s *Service) get(ctx context.Context, workspaceID string, agentSessionID string, reconcileStaleTurn bool) (Session, error) {
	session, ok := s.controller().Session(workspaceID, agentSessionID)
	if ok {
		if reconcileStaleTurn {
			shouldReconcile, err := s.shouldReconcilePersistedStaleTurn(session, workspaceID, agentSessionID)
			if err != nil {
				return Session{}, err
			}
			if shouldReconcile {
				if _, err := s.reconcilePersistedStaleTurn(ctx, workspaceID, agentSessionID); err != nil {
					return Session{}, err
				}
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
			if isStaleHiddenLiveModelDiscoverySession(persisted) {
				if _, err := s.Delete(ctx, workspaceID, agentSessionID); err != nil && !errors.Is(err, ErrSessionNotFound) {
					return Session{}, err
				}
				return Session{}, ErrSessionNotFound
			}
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

// GoalControlSessionResult carries the refreshed session plus the goal
// snapshot after a goal control action (nil after clear).
type GoalControlSessionResult struct {
	Session Session
	Goal    map[string]any
}

// GoalControl performs a direct goal action (pause/resume/clear/set) on the
// session's thread. Like Cancel it is a control operation: it never opens a
// turn, so it works while a turn is running.
func (s *Service) GoalControl(ctx context.Context, workspaceID string, agentSessionID string, action string, objective string) (GoalControlSessionResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	slog.Info("workspace agent session goal control requested",
		"event", "workspace_agent_session.goal_control.requested",
		"workspaceId", workspaceID,
		"agentSessionId", agentSessionID,
		"action", action,
	)
	if _, err := s.ensureRuntimeSessionResult(ctx, workspaceID, agentSessionID); err != nil {
		slog.Warn("workspace agent session goal control prepare failed",
			"event", "workspace_agent_session.goal_control.prepare_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"error", err.Error(),
		)
		return GoalControlSessionResult{}, err
	}
	controlResult, err := s.controller().GoalControl(ctx, RuntimeGoalControlInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Action:         action,
		Objective:      objective,
	})
	if err != nil {
		normalizedErr := normalizeRuntimeError(err)
		slog.Warn("workspace agent session goal control runtime request failed",
			"event", "workspace_agent_session.goal_control.runtime_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"action", action,
			"error", normalizedErr.Error(),
		)
		return GoalControlSessionResult{}, normalizedErr
	}
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		slog.Warn("workspace agent session goal control refresh failed",
			"event", "workspace_agent_session.goal_control.refresh_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"error", err.Error(),
		)
		return GoalControlSessionResult{}, err
	}
	slog.Info("workspace agent session goal control completed",
		"event", "workspace_agent_session.goal_control.completed",
		"workspaceId", workspaceID,
		"agentSessionId", agentSessionID,
		"action", action,
	)
	return GoalControlSessionResult{Session: session, Goal: controlResult.Goal}, nil
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
		if isStaleInteractiveRequestError(err) {
			reconciled, recErr := s.reconcilePersistedStaleTurn(ctx, workspaceID, agentSessionID)
			if recErr != nil {
				return Session{}, recErr
			}
			if reconciled {
				return s.get(ctx, workspaceID, agentSessionID, false)
			}
		}
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
