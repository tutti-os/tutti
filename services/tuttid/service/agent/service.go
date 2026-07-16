package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tutti-os/tutti/packages/agent/daemon/titletext"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	claudecodeservice "github.com/tutti-os/tutti/services/tuttid/service/claudecode"
)

var (
	ErrInvalidArgument                  = errors.New("invalid agent session request")
	ErrActiveTurnGuidanceUnsupported    = errors.New("agent provider does not support active-turn guidance")
	ErrPromptImageUnsupported           = errors.New("agent prompt image input is unsupported")
	ErrSessionNoActiveTurn              = errors.New("agent session has no active turn")
	ErrSessionNotFound                  = errors.New("workspace agent session not found")
	ErrRuntimeSessionDisconnected       = errors.New("agent runtime session is disconnected")
	ErrInteractiveRequestNotLive        = errors.New("interactive request is no longer live")
	ErrInteractiveAlreadyAnswered       = errors.New("interactive request has already been answered")
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
		claudeStartupLock:         claudecodeservice.DefaultStartupGate,
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
	var normalizedPromptText string
	if len(input.InitialContent) > 0 {
		var err error
		nodeStartedAt := time.Now()
		normalizedContent, normalizedPromptText, err = normalizePromptContent(input.InitialContent)
		if err != nil {
			s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "content_normalized", provider, nodeStartedAt, err)
			return Session{}, err
		}
		s.reportAgentServiceNodeSuccess(ctx, input.AgentSessionID, "session_create", "content_normalized", provider, nodeStartedAt)
	}
	logAgentSubmitTrace("service.create.content_normalized", workspaceID, input.AgentSessionID, input.Metadata, map[string]any{
		"content_block_count": len(normalizedContent),
	})
	typedGoal, isTypedGoal := parseTypedGoalControl(
		normalizedContent,
		firstNonEmptyString(strings.TrimSpace(input.InitialDisplayPrompt), normalizedPromptText),
		false,
	)
	var submitClaim agentactivitybiz.SubmitClaim
	claimPending := false
	if len(normalizedContent) > 0 && !isTypedGoal {
		submitClaim, claimPending, err = s.prepareSubmitClaim(ctx, workspaceID, input.AgentSessionID, input.Metadata)
		if err != nil {
			return Session{}, err
		}
		if submitClaim.ClientSubmitID != "" && !claimPending {
			if submitClaim.Status == "accepted" {
				return s.Get(ctx, workspaceID, input.AgentSessionID)
			}
			return Session{}, ErrSubmitDeliveryUnknown
		}
		defer func() {
			if claimPending {
				s.abandonSubmitClaim(workspaceID, input.AgentSessionID, submitClaim.ClientSubmitID)
			}
		}()
	}
	requestedModel := value(input.Model)
	input.Model = s.resolveCreateSessionModel(ctx, provider, input.ProviderTargetRef, value(input.Cwd), input.Model)
	nodeStartedAt := time.Now()
	if providerTargetRefKind(input.ProviderTargetRef) != "agent_extension" {
		if err := s.validateComposerModelForCreate(ctx, provider, workspaceID, value(input.Cwd), requestedModel); err != nil {
			s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "model_validated", provider, nodeStartedAt, err)
			return Session{}, err
		}
	}
	s.reportAgentServiceNodeSuccess(ctx, input.AgentSessionID, "session_create", "model_validated", provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.model_validated", workspaceID, input.AgentSessionID, input.Metadata, map[string]any{
		"model": value(input.Model),
	})
	input.ReasoningEffort = s.clampReasoningEffortPointerForModel(
		ctx,
		provider,
		value(input.Model),
		input.ReasoningEffort,
	)
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
	cleanupCreateFailure := func(cause error, startedSessionID string) error {
		cleanupCtx, cancelCleanup := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancelCleanup()
		var closeErr error
		if startedSessionID = strings.TrimSpace(startedSessionID); startedSessionID != "" {
			closeErr = s.controller().Close(cleanupCtx, RuntimeCloseInput{
				WorkspaceID:    workspaceID,
				AgentSessionID: startedSessionID,
			})
		}
		cleanupErr := s.cleanupRuntime(cleanupCtx, workspaceID, strings.TrimSpace(input.AgentSessionID))
		return errors.Join(cause, closeErr, cleanupErr)
	}
	logAgentSubmitTrace("service.create.runtime_start_requested", workspaceID, input.AgentSessionID, input.Metadata, nil)
	nodeStartedAt = time.Now()
	// Wait out any in-flight Claude startup so this session never overlaps
	// another credential-touching Claude process during OAuth refresh. Released
	// as soon as this session has started.
	releaseStartup, err := s.awaitClaudeStartupSlot(ctx, provider)
	if err != nil {
		return Session{}, cleanupCreateFailure(err, "")
	}
	session, err := func() (ProviderRuntimeSession, error) {
		defer releaseStartup()
		return s.controller().Start(ctx, RuntimeStartInput{
			WorkspaceID:             workspaceID,
			AgentSessionID:          strings.TrimSpace(input.AgentSessionID),
			AgentTargetID:           input.AgentTargetID,
			Provider:                provider,
			Cwd:                     prepared.Cwd,
			Env:                     prepared.Env,
			Title:                   value(input.Title),
			InitialTitleEstablished: titletext.Normalize(value(input.Title)) != "",
			PermissionModeID:        value(input.PermissionModeID),
			Model:                   clampComposerModelForLaunch(provider, input.ProviderTargetRef, value(input.Model)),
			PlanMode:                clampComposerPlanModeForProvider(provider, valueBool(input.PlanMode)),
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
			Provisional:            len(normalizedContent) > 0 && !isTypedGoal,
		})
	}()
	if err != nil {
		s.invalidateProviderAvailability(provider)
		normalizedErr := normalizeRuntimeError(err)
		s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "runtime_started", provider, nodeStartedAt, normalizedErr)
		return Session{}, cleanupCreateFailure(normalizedErr, "")
	}
	s.reportAgentServiceNodeSuccess(ctx, session.ID, "session_create", "runtime_started", session.Provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.runtime_start_resolved", workspaceID, session.ID, input.Metadata, map[string]any{
		"provider_runtime_status": session.Status,
	})
	persistedSession, err := s.initializeRuntimeSession(ctx, session)
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, session.ID, "session_create", "session_persisted", session.Provider, nodeStartedAt, err)
		return Session{}, cleanupCreateFailure(err, session.ID)
	}
	s.reportAgentServiceNodeSuccess(ctx, session.ID, "session_create", "session_persisted", session.Provider, nodeStartedAt)
	if isTypedGoal {
		result, goalErr := s.goalControl(ctx, workspaceID, session.ID, typedGoal.Action, typedGoal.Objective, input.Metadata)
		if goalErr != nil {
			return Session{}, cleanupCreateFailure(goalErr, session.ID)
		}
		return result.Session, nil
	}
	if len(normalizedContent) == 0 {
		return serviceSessionWithPersistedFreshness(
			session,
			persistedSession,
			s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session)),
		), nil
	}
	nodeStartedAt = time.Now()
	if err := s.validatePromptContentForExec(ctx, workspaceID, session.ID, normalizedContent); err != nil {
		s.reportAgentServiceNodeFailure(ctx, session.ID, "session_create", "prompt_validated", session.Provider, nodeStartedAt, err)
		return Session{}, cleanupCreateFailure(err, session.ID)
	}
	s.reportAgentServiceNodeSuccess(ctx, session.ID, "session_create", "prompt_validated", session.Provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.prompt_validated", workspaceID, session.ID, input.Metadata, nil)
	nodeStartedAt = time.Now()
	content, preparedDisplayPrompt, err := s.prepareNormalizedPromptContentForExec(workspaceID, session.ID, normalizedContent, "")
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, session.ID, "session_create", "prompt_prepared", session.Provider, nodeStartedAt, err)
		return Session{}, cleanupCreateFailure(err, session.ID)
	}
	s.reportAgentServiceNodeSuccess(ctx, session.ID, "session_create", "prompt_prepared", session.Provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.prompt_prepared", workspaceID, session.ID, input.Metadata, map[string]any{
		"content_block_count": len(content),
	})
	displayPrompt := strings.TrimSpace(input.InitialDisplayPrompt)
	visiblePrompt := firstNonEmptyString(displayPrompt, normalizedPromptText, preparedDisplayPrompt)
	initialTitle := ""
	if !session.InitialTitleEstablished {
		initialTitle = titletext.DeriveInitial(session.Title, visiblePrompt)
	}
	logAgentSubmitTrace("service.create.exec_requested", workspaceID, session.ID, input.Metadata, nil)
	nodeStartedAt = time.Now()
	execResult, err := s.controller().Exec(ctx, RuntimeExecInput{
		WorkspaceID:      workspaceID,
		AgentSessionID:   session.ID,
		Content:          content,
		DisplayPrompt:    displayPrompt,
		InitialTitle:     initialTitle,
		InitialTitleBase: session.Title,
		Metadata:         cloneMetadata(input.Metadata),
	})
	if err != nil {
		normalizedErr := normalizeRuntimeError(err)
		s.reportAgentServiceNodeFailure(ctx, session.ID, "session_create", "runtime_exec", session.Provider, nodeStartedAt, normalizedErr)
		return Session{}, cleanupCreateFailure(normalizedErr, session.ID)
	}
	if submitClaim.ClientSubmitID != "" {
		claimPending = false
		if err := s.acceptSubmitClaim(workspaceID, session.ID, submitClaim.ClientSubmitID, execResult.TurnID); err != nil {
			return Session{}, err
		}
	}
	s.reportAgentServiceNodeSuccess(ctx, session.ID, "session_create", "runtime_exec", session.Provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.exec_resolved", workspaceID, session.ID, input.Metadata, nil)
	if refreshed, ok := s.controller().Session(workspaceID, session.ID); ok {
		session = refreshed
	}
	return serviceSessionWithPersistedFreshness(
		session,
		persistedSession,
		s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session)),
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

func (s *Service) resolveCreateSessionModel(ctx context.Context, provider string, providerTargetRef map[string]any, cwd string, model *string) *string {
	resolved := clampComposerModelForLaunch(provider, providerTargetRef, value(model))
	if resolved == "" {
		resolved = composerDefaultModel(ctx, provider, cwd, s.ModelCatalog)
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
	prepared, err := s.RuntimePreparer.Prepare(ctx, runtimeprep.PrepareInput{
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
		Model:             clampComposerModelForLaunch(provider, input.ProviderTargetRef, value(input.Model)),
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

func sessionSkillBundlesToProviderSkillBundles(input []SessionSkillBundle) []runtimeprep.ProviderSkillBundle {
	if len(input) == 0 {
		return nil
	}
	bundles := make([]runtimeprep.ProviderSkillBundle, 0, len(input))
	for _, skill := range input {
		files := make(map[string]string, len(skill.Files))
		for path, content := range skill.Files {
			files[path] = content
		}
		bundles = append(bundles, runtimeprep.ProviderSkillBundle{
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

func (s *Service) GetDetail(ctx context.Context, workspaceID string, agentSessionID string) (SessionDetail, error) {
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return SessionDetail{}, err
	}
	detail := SessionDetail{
		Session:       session,
		ChildSessions: []Session{},
		Turns:         []agentactivitybiz.Turn{},
	}
	if s.TurnStore != nil {
		turns, err := s.TurnStore.ListSessionTurns(ctx, strings.TrimSpace(workspaceID), session.ID)
		if err != nil {
			return SessionDetail{}, err
		}
		detail.Turns = turns
	}
	reader, ok := s.SessionReader.(ChildSessionReader)
	if !ok {
		return detail, nil
	}
	persistedChildren, err := reader.ListChildSessions(ctx, workspaceID, agentSessionID)
	if err != nil {
		return SessionDetail{}, err
	}
	children := make([]Session, 0, len(persistedChildren))
	for _, persisted := range persistedChildren {
		children = append(children, sessionFromPersisted(persisted, false))
	}
	children, err = s.withProtocolV2TurnStates(ctx, strings.TrimSpace(workspaceID), children)
	if err != nil {
		return SessionDetail{}, err
	}
	detail.ChildSessions = children
	return detail, nil
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

func (s *Service) get(ctx context.Context, workspaceID string, agentSessionID string, _ bool) (Session, error) {
	if s.SessionReader != nil {
		deleted, err := s.SessionReader.SessionDeleted(ctx, workspaceID, agentSessionID)
		if err != nil {
			return Session{}, err
		}
		if deleted {
			return Session{}, ErrSessionNotFound
		}
	}
	session, ok := s.controller().Session(workspaceID, agentSessionID)
	if ok {
		resumable := s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session))
		service := serviceSession(session, resumable)
		if s.SessionReader != nil {
			persisted, ok := s.SessionReader.GetSession(workspaceID, agentSessionID)
			if !ok {
				return Session{}, errors.New("live workspace agent session has no persisted session")
			}
			if err := validatePersistedRailSectionKey(persisted); err != nil {
				return Session{}, err
			}
			service = serviceSessionWithPersistedFreshness(session, persisted, resumable)
		}
		return s.withProtocolV2TurnState(ctx, workspaceID, service)
	}
	if s.SessionReader != nil {
		if persisted, ok := s.SessionReader.GetSession(workspaceID, agentSessionID); ok {
			if err := validatePersistedRailSectionKey(persisted); err != nil {
				return Session{}, err
			}
			if isStaleHiddenLiveModelDiscoverySession(persisted) {
				if _, err := s.Delete(ctx, workspaceID, agentSessionID); err != nil && !errors.Is(err, ErrSessionNotFound) {
					return Session{}, err
				}
				return Session{}, ErrSessionNotFound
			}
			return s.withProtocolV2TurnState(ctx, workspaceID, sessionFromPersisted(
				persisted,
				persistedSessionCanResume(s.controller(), persisted),
			))
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
		return s.withProtocolV2TurnState(
			ctx,
			workspaceID,
			mergePersistedSessionState(service, persisted),
		)
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
	return s.RuntimePreparer.Cleanup(ctx, runtimeprep.CleanupInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
	})
}

func (s *Service) SubmitInteractive(ctx context.Context, workspaceID string, agentSessionID string, requestID string, input SubmitInteractiveInput) (Session, error) {
	route, err := s.resolveRuntimeControlRoute(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID))
	if err != nil {
		return Session{}, err
	}
	operation, err := s.prepareInteractiveRuntimeOperation(
		ctx,
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(agentSessionID),
		strings.TrimSpace(requestID),
		input,
		route.RootAgentSessionID,
	)
	if err != nil {
		return Session{}, err
	}
	if _, err := s.processRuntimeOperation(ctx, operation, false); err != nil {
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
