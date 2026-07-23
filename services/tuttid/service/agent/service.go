package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
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
	ErrInteractionRequestNotFound       = agenthost.ErrInteractionNotFound
	ErrInteractionSemanticNotFound      = errors.New("agent interaction semantic was not found")
	ErrInteractionSemanticAmbiguous     = errors.New("agent interaction semantic is ambiguous")
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
	result, err := s.CreateWithResult(ctx, workspaceID, input)
	return result.Session, err
}

// CreateWithResult creates a session while retaining the exact Turn identity
// returned by Host for the optional initial submission.
func (s *Service) CreateWithResult(ctx context.Context, workspaceID string, input CreateSessionInput) (CreateSessionResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	input.AgentTargetID = strings.TrimSpace(input.AgentTargetID)
	launch, err := s.resolveCreateSessionLaunch(ctx, workspaceID, &input)
	if err != nil {
		return CreateSessionResult{}, err
	}
	provider := launch.Provider
	if workspaceID == "" || provider == "" {
		return CreateSessionResult{}, ErrInvalidArgument
	}
	input.Provider = provider
	input.ProviderTargetRef = launch.ProviderTargetRef
	permissionModeExplicit := strings.TrimSpace(value(input.PermissionModeID)) != ""
	if err := s.applyCreateSessionComposerDefaults(ctx, &input); err != nil {
		return CreateSessionResult{}, err
	}
	input.ConversationDetailMode = preferencesbiz.NormalizeDesktopAgentConversationDetailMode(input.ConversationDetailMode)
	requestedPermissionModeID := strings.TrimSpace(value(input.PermissionModeID))
	if input.StrictPermissionMode && requestedPermissionModeID != "" &&
		!permissionModeConfigHasModeID(permissionConfigForProvider(provider), requestedPermissionModeID) {
		return CreateSessionResult{}, fmt.Errorf("%w: permission mode is unsupported by the workspace agent harness", ErrInvalidArgument)
	}
	normalizedPermissionModeID := normalizePermissionModeIDForLaunch(provider, input.ProviderTargetRef, value(input.PermissionModeID))
	if normalizedPermissionModeID != "" {
		input.PermissionModeID = &normalizedPermissionModeID
	} else {
		input.PermissionModeID = nil
	}
	input.AgentSessionID = agentSessionIDOrNew(input.AgentSessionID)
	input.ClientSubmitID = strings.TrimSpace(input.ClientSubmitID)
	if input.ClientSubmitID == "" {
		legacyClientSubmitID, _ := input.Metadata["clientSubmitId"].(string)
		input.ClientSubmitID = strings.TrimSpace(legacyClientSubmitID)
	}
	logAgentSubmitTrace("service.create.entered", workspaceID, input.AgentSessionID, input.ClientSubmitID, input.Metadata, map[string]any{"provider": provider})
	var normalizedContent []PromptContentBlock
	if len(input.InitialContent) > 0 {
		nodeStartedAt := time.Now()
		normalizedContent, _, err = normalizePromptContent(input.InitialContent)
		if err != nil {
			s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "content_normalized", provider, nodeStartedAt, err)
			return CreateSessionResult{}, err
		}
		s.reportAgentServiceNodeSuccess(ctx, input.AgentSessionID, "session_create", "content_normalized", provider, nodeStartedAt)
	}
	logAgentSubmitTrace("service.create.content_normalized", workspaceID, input.AgentSessionID, input.ClientSubmitID, input.Metadata, map[string]any{"content_block_count": len(normalizedContent)})
	requestedModel := value(input.Model)
	nodeStartedAt := time.Now()
	planResolution, err := s.resolveCreateSessionModelForPlanOrProvider(ctx, workspaceID, provider, requestedModel, &input)
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "model_validated", provider, nodeStartedAt, err)
		return CreateSessionResult{}, err
	}
	s.reportAgentServiceNodeSuccess(ctx, input.AgentSessionID, "session_create", "model_validated", provider, nodeStartedAt)
	input.RuntimeContext = runtimeContextWithSessionRuntimeSnapshot(input.RuntimeContext, input, provider, planResolution)
	logAgentSubmitTrace("service.create.model_validated", workspaceID, input.AgentSessionID, input.ClientSubmitID, input.Metadata, map[string]any{
		"model": value(input.Model),
	})
	if err := s.applyCreateSessionReasoningIntensity(ctx, provider, value(input.Model), &input); err != nil {
		return CreateSessionResult{}, err
	}
	input.ReasoningEffort = s.clampReasoningEffortPointerForLaunch(
		ctx,
		provider,
		input.ProviderTargetRef,
		value(input.Model),
		input.ReasoningEffort,
	)
	isolationMode := strings.TrimSpace(input.Isolation)
	if isolationMode != "" && isolationMode != WorktreeIsolationMode {
		return CreateSessionResult{}, fmt.Errorf("%w: unsupported session isolation mode %q", ErrInvalidArgument, isolationMode)
	}
	s.worktreeIsolationMu.RLock()
	defer s.worktreeIsolationMu.RUnlock()
	nodeStartedAt = time.Now()
	if isolationMode == WorktreeIsolationMode && strings.TrimSpace(value(input.Cwd)) == "" {
		err := &WorktreeIsolationError{Kind: ErrNotAGitRepo}
		s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "cwd_resolved", provider, nodeStartedAt, err)
		return CreateSessionResult{}, err
	}
	cwd, err := s.resolveCwd(ctx, input.Cwd)
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "cwd_resolved", provider, nodeStartedAt, err)
		return CreateSessionResult{}, err
	}
	s.reportAgentServiceNodeSuccess(ctx, input.AgentSessionID, "session_create", "cwd_resolved", provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.cwd_resolved", workspaceID, input.AgentSessionID, input.ClientSubmitID, input.Metadata, map[string]any{
		"cwd": cwd,
	})
	var isolation *SessionIsolation
	var isolationWarnings []SessionWarning
	keepWorktree := false
	if isolationMode == WorktreeIsolationMode {
		created, warnings, createErr := s.createSessionWorktree(ctx, workspaceID, cwd, input.AgentSessionID)
		if createErr != nil {
			return CreateSessionResult{}, createErr
		}
		isolation = &created
		isolationWarnings = warnings
		cwd = created.WorktreePath
		input.Cwd = stringPointer(cwd)
		input.RuntimeContext = sessionIsolationRuntimeContext(input.RuntimeContext, created)
		defer func() {
			if !keepWorktree {
				s.rollbackSessionWorktree(context.Background(), created)
			}
		}()
	}
	if providerTargetRefKind(input.ProviderTargetRef) == "agent_extension" {
		nodeStartedAt = time.Now()
		if err := s.validateExtensionComposerSettingsForCreate(
			ctx,
			workspaceID,
			cwd,
			&input,
			permissionModeExplicit,
		); err != nil {
			s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "settings_validated", provider, nodeStartedAt, err)
			return CreateSessionResult{}, err
		}
		s.reportAgentServiceNodeSuccess(ctx, input.AgentSessionID, "session_create", "settings_validated", provider, nodeStartedAt)
	}
	nodeStartedAt = time.Now()
	prepared, err := s.prepareRuntime(ctx, workspaceID, cwd, input, planResolution.Endpoint)
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, input.AgentSessionID, "session_create", "runtime_prepared", provider, nodeStartedAt, err)
		return CreateSessionResult{}, err
	}
	if isolation != nil {
		prepared.Cwd = isolation.WorktreePath
	}
	s.reportAgentServiceNodeSuccess(ctx, input.AgentSessionID, "session_create", "runtime_prepared", provider, nodeStartedAt)
	logAgentSubmitTrace("service.create.runtime_prepared", workspaceID, input.AgentSessionID, input.ClientSubmitID, input.Metadata, map[string]any{"cwd": prepared.Cwd, "env_count": len(prepared.Env)})
	if err := s.preparePlanFirstUse(ctx, workspaceID, input.AgentSessionID, planResolution.Endpoint, input.AgentTargetID); err != nil {
		return CreateSessionResult{}, err
	}
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
		Metadata: input.Metadata, ClientSubmitID: input.ClientSubmitID,
		CapabilityRefs: append([]CapabilityReference(nil), input.CapabilityRefs...), Title: input.Title, Cwd: stringPointer(prepared.Cwd),
		PermissionModeID: input.PermissionModeID,
		Model:            stringPointer(runtimeSettings.Model),
		PlanMode:         boolPointer(runtimeSettings.PlanMode),
		BrowserUse:       input.BrowserUse, ComputerUse: input.ComputerUse,
		ProviderTargetRef:      input.ProviderTargetRef,
		ReasoningEffort:        stringPointer(runtimeSettings.ReasoningEffort),
		RuntimeContext:         stampAgentExtensionComposerScope(input.RuntimeContext, input.ProviderTargetRef, cwd, runtimeSettings),
		Speed:                  stringPointer(runtimeSettings.Speed),
		ConversationDetailMode: input.ConversationDetailMode, Visible: input.Visible,
		RailPlacement: input.RailPlacement,
	}
	if err := s.applyInitialTuttiModeActivation(ctx, workspaceID, input.AgentSessionID, input.InitialTuttiModeActivation); err != nil {
		return CreateSessionResult{}, err
	}
	var preparedTuttiModeTurnID string
	_, typedGoal := agenthost.ParseTypedGoalControl(normalizedContent, false)
	if len(normalizedContent) > 0 && !typedGoal {
		canonicalTurnID, claimErr := s.existingSubmitCanonicalTurnID(ctx, workspaceID, input.AgentSessionID, input.ClientSubmitID, input.Metadata)
		if claimErr != nil {
			return CreateSessionResult{}, claimErr
		}
		if canonicalTurnID != "" {
			// A durable claim already owns this submit: reuse its canonical
			// turn instead of binding a fresh snapshot, so a retry reconciles
			// against the claimed turn and never redispatches.
			preparedTuttiModeTurnID = canonicalTurnID
			hostInput.TurnID = canonicalTurnID
		} else {
			turnID, snapshot, snapshotErr := s.prepareTuttiModeExec(ctx, workspaceID, input.AgentSessionID, false, ProviderRuntimeSession{}, "")
			if snapshotErr != nil {
				if input.InitialTuttiModeActivation != nil {
					activationErr := s.deleteTuttiModeActivationSessionState(context.WithoutCancel(ctx), workspaceID, input.AgentSessionID)
					snapshotErr = errors.Join(snapshotErr, activationErr)
				}
				return CreateSessionResult{}, snapshotErr
			}
			preparedTuttiModeTurnID = turnID
			hostInput.TurnID = turnID
			hostInput.TuttiModeSnapshot = runtimeTuttiModeTurnSnapshot(snapshot)
		}
	}
	logAgentSubmitTrace("service.create.runtime_start_requested", workspaceID, input.AgentSessionID, input.ClientSubmitID, input.Metadata, nil)
	hostResult, err := s.ApplicationHost().CreateSession(ctx, workspaceID, hostInput)
	if err != nil {
		// Delivery-unknown means provider acceptance is already possible:
		// keep the prepared claim, bound snapshot, and activation so a retry
		// reconciles instead of double-dispatching.
		if !errors.Is(err, ErrSubmitDeliveryUnknown) {
			_ = s.deleteTuttiModeActivationSessionState(context.WithoutCancel(ctx), workspaceID, input.AgentSessionID)
		}
		return CreateSessionResult{}, err
	}
	keepWorktree = true
	session := hostResult.Session
	logAgentSubmitTrace("service.create.runtime_start_resolved", workspaceID, session.ID, input.ClientSubmitID, input.Metadata, map[string]any{"provider_runtime_status": session.Status})
	persistedSession := persistedSessionFromHost(hostResult.Canonical)
	if strings.TrimSpace(session.ID) == "" && strings.TrimSpace(hostResult.TurnID) != "" {
		result, getErr := s.Get(ctx, workspaceID, input.AgentSessionID)
		return CreateSessionResult{
			Session: decorateIsolatedSession(result, isolation, isolationWarnings),
			TurnID:  strings.TrimSpace(hostResult.TurnID),
		}, getErr
	}
	if hostResult.Kind == "goalControl" {
		result, getErr := s.Get(ctx, workspaceID, session.ID)
		return CreateSessionResult{
			Session: decorateIsolatedSession(result, isolation, isolationWarnings),
			TurnID:  strings.TrimSpace(hostResult.TurnID),
		}, getErr
	}
	if preparedTuttiModeTurnID != "" && strings.TrimSpace(hostResult.TurnID) != preparedTuttiModeTurnID {
		return CreateSessionResult{}, ErrSubmitDeliveryUnknown
	}
	if len(normalizedContent) == 0 {
		created, err := s.projectSessionForResponse(ctx, workspaceID, serviceSessionWithPersistedFreshness(
			session,
			persistedSession,
			s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session)),
		))
		return CreateSessionResult{
			Session: decorateIsolatedSession(created, isolation, isolationWarnings),
			TurnID:  strings.TrimSpace(hostResult.TurnID),
		}, err
	}
	logAgentSubmitTrace("service.create.prompt_validated", workspaceID, session.ID, input.ClientSubmitID, input.Metadata, nil)
	logAgentSubmitTrace("service.create.prompt_prepared", workspaceID, session.ID, input.ClientSubmitID, input.Metadata, map[string]any{"content_block_count": len(normalizedContent)})
	logAgentSubmitTrace("service.create.exec_resolved", workspaceID, session.ID, input.ClientSubmitID, input.Metadata, map[string]any{"turn_id": hostResult.TurnID})
	created, err := s.projectSessionForResponse(ctx, workspaceID, serviceSessionWithPersistedFreshness(
		session,
		persistedSession,
		s.controller().CanResume(runtimeResumeInputFromRuntimeSession(session)),
	))
	return CreateSessionResult{
		Session: decorateIsolatedSession(created, isolation, isolationWarnings),
		TurnID:  strings.TrimSpace(hostResult.TurnID),
	}, err
}

func decorateIsolatedSession(session Session, isolation *SessionIsolation, warnings []SessionWarning) Session {
	if isolation != nil {
		copy := *isolation
		session.Isolation = &copy
	}
	if len(warnings) > 0 {
		session.Warnings = append([]SessionWarning(nil), warnings...)
	}
	return session
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

func (s *Service) resolveCreateSessionLaunch(ctx context.Context, workspaceID string, input *CreateSessionInput) (resolvedCreateSessionLaunch, error) {
	if input == nil {
		return resolvedCreateSessionLaunch{}, ErrInvalidArgument
	}
	requestProvider := strings.TrimSpace(input.Provider)
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	if agentTargetID == "" {
		return resolvedCreateSessionLaunch{}, fmt.Errorf("%w: agent target id is required for agent session launch", ErrInvalidArgument)
	}
	if strings.HasPrefix(agentTargetID, workspaceAgentIDPrefix) {
		return s.resolveWorkspaceAgentLaunch(ctx, strings.TrimSpace(workspaceID), input, requestProvider)
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
	input.HarnessAgentTargetID = normalized.ID
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

func (s *Service) prepareRuntime(ctx context.Context, workspaceID string, cwd string, input CreateSessionInput, endpoints ...*runtimeprep.ModelEndpointConfig) (preparedRuntime, error) {
	var planEndpoint *runtimeprep.ModelEndpointConfig
	if len(endpoints) > 0 {
		planEndpoint = endpoints[0]
	} else {
		provider := strings.TrimSpace(input.Provider)
		planEndpoint, _ = s.resolveModelPlanEndpoint(ctx, workspaceID, input.AgentTargetID, provider, value(input.Model))
	}
	return s.prepareRuntimeWithModelEndpoint(ctx, workspaceID, cwd, input, planEndpoint)
}

// prepareRuntimeWithModelEndpoint prepares a launch with an already resolved
// endpoint. Create and snapshot-based resume use this path so plan resolution
// cannot drift between validation and process preparation.
func (s *Service) prepareRuntimeWithModelEndpoint(
	ctx context.Context,
	workspaceID string,
	cwd string,
	input CreateSessionInput,
	planEndpoint *runtimeprep.ModelEndpointConfig,
) (preparedRuntime, error) {
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
		ModelEndpoint:             planEndpoint,
		Title:                     value(input.Title),
		PermissionModeID:          value(input.PermissionModeID),
		PlanMode:                  clampComposerPlanModeForLaunch(provider, input.ProviderTargetRef, valueBool(input.PlanMode)),
		BrowserUse:                clampComposerBrowserUseForProvider(provider, input.BrowserUse),
		ComputerUse:               clampComposerComputerUseForProvider(provider, input.ComputerUse),
		ProviderTargetRef:         clonePayload(input.ProviderTargetRef),
		Model:                     clampComposerModelForLaunch(provider, input.ProviderTargetRef, value(input.Model)),
		ReasoningEffort:           normalizeReasoningEffortForLaunch(provider, input.ProviderTargetRef, value(input.ReasoningEffort)),
		ConversationDetailMode:    input.ConversationDetailMode,
		AgentName:                 input.AgentName,
		AgentDescription:          input.AgentDescription,
		AgentInstructions:         input.AgentInstructions,
		AgentCapabilitiesExplicit: input.AgentCapabilitiesExplicit,
		AgentSkills:               append([]string(nil), input.AgentSkills...),
		AgentTools:                append([]string(nil), input.AgentTools...),
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

func (s *Service) releaseAgentResources(ctx context.Context, agentSessionID string) {
	if s.AgentSessionResourceReleaser == nil {
		return
	}
	if err := s.AgentSessionResourceReleaser.ReleaseAgent(ctx, agentSessionID); err != nil {
		slog.WarnContext(ctx, "release Agent session resources failed",
			"agentSessionId", strings.TrimSpace(agentSessionID),
			"error", err,
			"event", "agent.session.resource_release_failed",
		)
	}
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
	return s.projectHostSessionResult(ctx, result.Canonical, result.Session, result.Live, false)
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

func (s *Service) cleanupSessionResources(ctx context.Context, workspaceID string, agentSessionID string) error {
	var runtimeErr error
	if s.RuntimePreparer != nil {
		runtimeErr = s.cleanupRuntime(ctx, workspaceID, agentSessionID)
	}
	var agentResourceErr error
	if s.AgentSessionResourceReleaser != nil {
		agentResourceErr = s.AgentSessionResourceReleaser.ReleaseAgent(ctx, strings.TrimSpace(agentSessionID))
	}
	return errors.Join(runtimeErr, agentResourceErr)
}

func (s *Service) SubmitInteractive(ctx context.Context, ref agenthost.InteractionRef, input agenthost.SubmitInteractiveInput) (Session, error) {
	input.Payload = clonePayload(input.Payload)
	_, err := s.ApplicationHost().SubmitInteractive(ctx, ref, input)
	if err != nil {
		return Session{}, normalizeRuntimeError(err)
	}
	return s.Get(ctx, ref.WorkspaceID, ref.AgentSessionID)
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
