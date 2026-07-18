package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	claudecodeservice "github.com/tutti-os/tutti/services/tuttid/service/claudecode"
)

var (
	ErrInvalidArgument                  = agenthost.ErrInvalidArgument
	ErrActiveTurnGuidanceUnsupported    = errors.New("agent provider does not support active-turn guidance")
	ErrPromptImageUnsupported           = errors.New("agent prompt image input is unsupported")
	ErrSessionNoActiveTurn              = errors.New("agent session has no active turn")
	ErrSessionNotFound                  = agenthost.ErrSessionNotFound
	ErrRuntimeSessionDisconnected       = agenthost.ErrRuntimeSessionDisconnected
	ErrInteractiveRequestNotLive        = errors.New("interactive request is no longer live")
	ErrInteractiveAlreadyAnswered       = errors.New("interactive request has already been answered")
	ErrSkillBundleUnavailable           = errors.New("agent skill bundle renderer is unavailable")
	ErrSessionSettingsRequireNewSession = errors.New("agent session settings update requires a new session to preserve context")
	ErrSubmitDeliveryUnknown            = agenthost.ErrSubmitDeliveryUnknown
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
	if err := s.applyCreateSessionComposerDefaults(ctx, &input); err != nil {
		return Session{}, err
	}
	input.ConversationDetailMode = preferencesbiz.NormalizeDesktopAgentConversationDetailMode(input.ConversationDetailMode)
	normalizedPermissionModeID := normalizePermissionModeIDForLaunch(provider, input.ProviderTargetRef, value(input.PermissionModeID))
	if normalizedPermissionModeID != "" {
		input.PermissionModeID = &normalizedPermissionModeID
	} else {
		input.PermissionModeID = nil
	}
	input.AgentSessionID = agentSessionIDOrNew(input.AgentSessionID)
	logAgentSubmitTrace("service.create.entered", workspaceID, input.AgentSessionID, input.Metadata, map[string]any{"provider": provider})
	var normalizedContent []PromptContentBlock
	if len(input.InitialContent) > 0 {
		nodeStartedAt := time.Now()
		normalizedContent, _, err = normalizePromptContent(input.InitialContent)
		if err != nil {
			s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "content_normalized", provider, nodeStartedAt, err)
			return Session{}, err
		}
		s.reportAgentServiceNodeSuccess(ctx, input.AgentSessionID, "session_create", "content_normalized", provider, nodeStartedAt)
	}
	logAgentSubmitTrace("service.create.content_normalized", workspaceID, input.AgentSessionID, input.Metadata, map[string]any{"content_block_count": len(normalizedContent)})
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
	input.ReasoningEffort = s.clampReasoningEffortPointerForLaunch(
		ctx,
		provider,
		input.ProviderTargetRef,
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
	if providerTargetRefKind(input.ProviderTargetRef) == "agent_extension" {
		nodeStartedAt = time.Now()
		if err := s.validateExtensionComposerSettingsForCreate(ctx, workspaceID, cwd, input); err != nil {
			s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "settings_validated", provider, nodeStartedAt, err)
			return Session{}, err
		}
		s.reportAgentServiceNodeSuccess(ctx, input.AgentSessionID, "session_create", "settings_validated", provider, nodeStartedAt)
	}
	nodeStartedAt = time.Now()
	prepared, err := s.prepareRuntime(ctx, workspaceID, cwd, input)
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "runtime_prepared", provider, nodeStartedAt, err)
		return Session{}, err
	}
	s.reportAgentServiceNodeSuccess(ctx, input.AgentSessionID, "session_create", "runtime_prepared", provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.runtime_prepared", workspaceID, input.AgentSessionID, input.Metadata, map[string]any{"cwd": prepared.Cwd, "env_count": len(prepared.Env)})
	ctx = withServicePreparedRuntime(ctx, s, prepared)
	runtimeSettings := ComposerSettings{
		Model:            clampComposerModelForLaunch(provider, input.ProviderTargetRef, value(input.Model)),
		PermissionModeID: value(input.PermissionModeID),
		PlanMode:         clampComposerPlanModeForLaunch(provider, input.ProviderTargetRef, valueBool(input.PlanMode)),
		BrowserUse:       input.BrowserUse,
		ComputerUse:      input.ComputerUse,
		ReasoningEffort:  normalizeReasoningEffortForLaunch(provider, input.ProviderTargetRef, value(input.ReasoningEffort)),
		Speed:            normalizeSpeedForLaunch(provider, input.ProviderTargetRef, value(input.Speed)),
	}
	hostInput := agenthost.CreateSessionInput{
		AgentSessionID: input.AgentSessionID, AgentTargetID: input.AgentTargetID, Provider: input.Provider,
		InitialContent: normalizedContent, InitialDisplayPrompt: input.InitialDisplayPrompt,
		Metadata: input.Metadata, Title: input.Title, Cwd: stringPointer(prepared.Cwd),
		PermissionModeID: input.PermissionModeID,
		Model:            stringPointer(runtimeSettings.Model),
		PlanMode:         boolPointer(runtimeSettings.PlanMode),
		BrowserUse:       input.BrowserUse, ComputerUse: input.ComputerUse,
		ProviderTargetRef:      input.ProviderTargetRef,
		ReasoningEffort:        stringPointer(runtimeSettings.ReasoningEffort),
		RuntimeContext:         stampAgentExtensionComposerScope(input.RuntimeContext, input.ProviderTargetRef, cwd, runtimeSettings),
		Speed:                  stringPointer(runtimeSettings.Speed),
		ConversationDetailMode: input.ConversationDetailMode, Visible: input.Visible,
	}
	logAgentSubmitTrace("service.create.runtime_start_requested", workspaceID, input.AgentSessionID, input.Metadata, nil)
	hostResult, err := s.ApplicationHost().CreateSession(ctx, workspaceID, hostInput)
	if err != nil {
		return Session{}, err
	}
	session := hostResult.Session
	logAgentSubmitTrace("service.create.runtime_start_resolved", workspaceID, session.ID, input.Metadata, map[string]any{"provider_runtime_status": session.Status})
	persistedSession := persistedSessionFromHost(hostResult.Canonical)
	if strings.TrimSpace(session.ID) == "" && strings.TrimSpace(hostResult.TurnID) != "" {
		return s.Get(ctx, workspaceID, input.AgentSessionID)
	}
	if hostResult.Kind == "goalControl" {
		return s.Get(ctx, workspaceID, session.ID)
	}
	if len(normalizedContent) == 0 {
		return serviceSessionWithPersistedFreshness(
			session,
			persistedSession,
			s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session)),
		), nil
	}
	logAgentSubmitTrace("service.create.prompt_validated", workspaceID, session.ID, input.Metadata, nil)
	logAgentSubmitTrace("service.create.prompt_prepared", workspaceID, session.ID, input.Metadata, map[string]any{"content_block_count": len(normalizedContent)})
	logAgentSubmitTrace("service.create.exec_resolved", workspaceID, session.ID, input.Metadata, map[string]any{"turn_id": hostResult.TurnID})
	return serviceSessionWithPersistedFreshness(
		session,
		persistedSession,
		s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session)),
	), nil
}

func (s *Service) applyCreateSessionComposerDefaults(ctx context.Context, input *CreateSessionInput) error {
	if input == nil || s.AgentComposerDefaultsReader == nil {
		return nil
	}
	defaults, err := s.AgentComposerDefaultsReader.GetAgentComposerDefaultsForTarget(ctx, input.AgentTargetID)
	if err != nil {
		return fmt.Errorf("get agent composer defaults for create: %w", err)
	}
	if input.Model == nil && strings.TrimSpace(defaults.Model) != "" {
		input.Model = stringPointer(defaults.Model)
	}
	if input.PermissionModeID == nil && strings.TrimSpace(defaults.PermissionModeID) != "" {
		input.PermissionModeID = stringPointer(defaults.PermissionModeID)
	}
	if input.ReasoningEffort == nil && strings.TrimSpace(defaults.ReasoningEffort) != "" {
		input.ReasoningEffort = stringPointer(defaults.ReasoningEffort)
	}
	if input.Speed == nil && strings.TrimSpace(defaults.Speed) != "" {
		input.Speed = stringPointer(defaults.Speed)
	}
	return nil
}

func normalizePermissionModeIDForLaunch(provider string, providerTargetRef map[string]any, value string) string {
	if providerTargetRefKind(providerTargetRef) == "agent_extension" {
		return strings.TrimSpace(value)
	}
	return normalizePermissionModeIDForProvider(provider, value)
}

func normalizeReasoningEffortForLaunch(provider string, providerTargetRef map[string]any, value string) string {
	if providerTargetRefKind(providerTargetRef) == "agent_extension" {
		return strings.TrimSpace(value)
	}
	return normalizeReasoningEffortForProvider(provider, value)
}

func normalizeSpeedForLaunch(provider string, providerTargetRef map[string]any, value string) string {
	if providerTargetRefKind(providerTargetRef) == "agent_extension" {
		return strings.TrimSpace(value)
	}
	return normalizeSpeedForProvider(provider, value)
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
		WorkspaceID:               workspaceID,
		AgentSessionID:            strings.TrimSpace(input.AgentSessionID),
		AgentTargetID:             strings.TrimSpace(input.AgentTargetID),
		Provider:                  provider,
		Cwd:                       cwd,
		Title:                     value(input.Title),
		PermissionModeID:          value(input.PermissionModeID),
		PlanMode:                  clampComposerPlanModeForLaunch(provider, input.ProviderTargetRef, valueBool(input.PlanMode)),
		BrowserUse:                clampComposerBrowserUseForProvider(provider, input.BrowserUse),
		ComputerUse:               clampComposerComputerUseForProvider(provider, input.ComputerUse),
		ProviderTargetRef:         clonePayload(input.ProviderTargetRef),
		Model:                     clampComposerModelForLaunch(provider, input.ProviderTargetRef, value(input.Model)),
		ReasoningEffort:           normalizeReasoningEffortForLaunch(provider, input.ProviderTargetRef, value(input.ReasoningEffort)),
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
	result, err := s.ApplicationHost().GetSession(ctx, agenthost.SessionRef{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
	})
	if err != nil {
		return Session{}, err
	}
	persisted := persistedSessionFromHost(result.Canonical)
	if !result.Live && s.SessionReader != nil && isStaleHiddenLiveModelDiscoverySession(persisted) {
		if _, err := s.Delete(ctx, workspaceID, agentSessionID); err != nil && !errors.Is(err, ErrSessionNotFound) {
			return Session{}, err
		}
		return Session{}, ErrSessionNotFound
	}
	return s.projectHostSessionResult(ctx, result.Canonical, result.Session, result.Live, true)
}

func (s *Service) Delete(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	result, err := s.ApplicationHost().DeleteSession(ctx, agenthost.SessionRef{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
	})
	return result.Deleted, err
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
	result, err := s.ApplicationHost().UpdatePin(ctx, agenthost.UpdatePinInput{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID, Pinned: pinned,
	})
	if err != nil {
		return Session{}, err
	}
	persisted := persistedSessionFromHost(result.Canonical)
	if result.Live {
		service := serviceSession(
			result.Session,
			s.controller().CanResume(runtimeResumeInputFromRuntimeSession(result.Session)),
		)
		return s.withProtocolV2TurnState(
			ctx,
			workspaceID,
			mergePersistedSessionState(service, persisted),
		)
	}
	return sessionFromPersisted(
		persisted,
		s.persistedSessionCanResume(ctx, persisted),
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
	_, err := s.ApplicationHost().SubmitInteractive(
		ctx,
		agenthost.SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID},
		requestID,
		input,
	)
	if err != nil {
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
