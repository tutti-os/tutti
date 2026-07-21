package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	claudecodeservice "github.com/tutti-os/tutti/services/tuttid/service/claudecode"
)

const liveModelDiscoveryPollInterval = 100 * time.Millisecond
const liveModelDiscoveryTimeout = 20 * time.Second
const liveModelDiscoveryDeleteDelay = 10 * time.Minute
const liveModelDiscoveryLifecycleTimeout = 10 * time.Minute
const hiddenModelDiscoveryTriggeredEvent = "agent.model_discovery.hidden_session_triggered"

func logHiddenModelDiscoveryTriggered(provider string, agentSessionID string) {
	slog.Info(
		"agent hidden model discovery session triggered",
		"event", hiddenModelDiscoveryTriggeredEvent,
		"provider", agentprovider.NormalizeOpen(provider),
		"agent_session_id", strings.TrimSpace(agentSessionID),
	)
}

func (s *Service) claudeStartup() *claudecodeservice.StartupGate {
	if s.claudeStartupLock == nil {
		s.claudeStartupLock = claudecodeservice.DefaultStartupGate
	}
	return s.claudeStartupLock
}

// awaitClaudeStartupSlot blocks until no other credential-touching Claude
// startup is running, then returns a release function the caller must invoke
// once its own session startup has completed. Non-Claude providers do not
// participate and get a no-op release.
func (s *Service) awaitClaudeStartupSlot(ctx context.Context, provider string) (func(), error) {
	if !isClaudeSDKLiveModelProvider(provider) {
		return func() {}, nil
	}
	if err := s.claudeStartup().Acquire(ctx); err != nil {
		return nil, err
	}
	return s.claudeStartup().Release, nil
}

// liveModelOptionsFromRunningSession returns the model list already
// advertised by a live session of the provider in the workspace, if any. It
// lets model discovery reuse an in-flight conversation instead of spawning a
// second process next to it.
func (s *Service) liveModelOptionsFromRunningSession(workspaceID string, provider string, agentTargetIDs ...string) ([]ComposerConfigOptionValue, bool) {
	provider = agentprovider.NormalizeOpen(provider)
	agentTargetID := ""
	if len(agentTargetIDs) > 0 {
		agentTargetID = agentTargetIDs[0]
	}
	return s.liveModelOptionsFromRunningSessionForScope(newComposerLiveModelScope(provider, workspaceID, "", agentTargetID))
}

func (s *Service) liveModelOptionsFromRunningSessionForScope(scope composerLiveModelScope) ([]ComposerConfigOptionValue, bool) {
	hasProviderSession := false
	var selected []ComposerConfigOptionValue
	var selectedUnixMS int64 = -1
	selectedSessionID := ""
	invalidatedAtUnixMS := s.liveModelInvalidatedAtUnixMSForProvider(scope.provider)
	for _, session := range s.controller().Sessions(scope.workspaceID) {
		if agentprovider.NormalizeOpen(session.Provider) != scope.provider {
			continue
		}
		if scope.agentTargetID != "" && strings.TrimSpace(session.AgentTargetID) != scope.agentTargetID {
			continue
		}
		if !scope.matchesExtensionRuntimeContext(session.RuntimeContext) {
			continue
		}
		sessionCatalogUnixMS := firstNonZeroInt64(session.UpdatedAtUnixMS, session.CreatedAtUnixMS)
		options := extractModelOptionsFromRuntimeContext(session.RuntimeContext, scope.modelConfigOptionID)
		logClaudeModelCatalogInvalidationDebug("running_session_model_options_inspected", map[string]any{
			"workspaceId":         scope.workspaceID,
			"provider":            scope.provider,
			"agentSessionId":      session.ID,
			"status":              session.Status,
			"visible":             session.Visible,
			"hiddenDiscovery":     isHiddenLiveModelDiscoveryRuntimeContext(session.RuntimeContext),
			"createdAtUnixMs":     session.CreatedAtUnixMS,
			"updatedAtUnixMs":     session.UpdatedAtUnixMS,
			"invalidatedAtUnixMs": invalidatedAtUnixMS,
			"modelOptionCount":    len(options),
			"modelOptionValues":   composerConfigOptionValuesDebugValues(options),
			"modelSource":         stringFromAny(session.RuntimeContext["modelCatalogSource"]),
		})
		if invalidatedAtUnixMS > 0 && sessionCatalogUnixMS <= invalidatedAtUnixMS {
			logClaudeModelCatalogInvalidationDebug("running_session_model_options_skipped_stale_after_invalidation", map[string]any{
				"workspaceId":         scope.workspaceID,
				"provider":            scope.provider,
				"agentSessionId":      session.ID,
				"createdAtUnixMs":     session.CreatedAtUnixMS,
				"updatedAtUnixMs":     session.UpdatedAtUnixMS,
				"invalidatedAtUnixMs": invalidatedAtUnixMS,
				"modelOptionCount":    len(options),
				"modelOptionValues":   composerConfigOptionValuesDebugValues(options),
			})
			continue
		}
		hasProviderSession = true
		if len(options) > 0 && (sessionCatalogUnixMS > selectedUnixMS ||
			(sessionCatalogUnixMS == selectedUnixMS && session.ID > selectedSessionID)) {
			logClaudeModelCatalogInvalidationDebug("running_session_model_options_reused", map[string]any{
				"workspaceId":       scope.workspaceID,
				"provider":          scope.provider,
				"agentSessionId":    session.ID,
				"modelOptionCount":  len(options),
				"modelOptionValues": composerConfigOptionValuesDebugValues(options),
			})
			selected = options
			selectedUnixMS = sessionCatalogUnixMS
			selectedSessionID = session.ID
		}
	}
	if len(selected) > 0 {
		return selected, true
	}
	if hasProviderSession {
		logClaudeModelCatalogInvalidationDebug("running_session_without_reusable_models", map[string]any{
			"workspaceId": scope.workspaceID,
			"provider":    scope.provider,
		})
	}
	return nil, hasProviderSession
}

func (s *Service) liveModelInvalidatedAtUnixMSForProvider(provider string) int64 {
	normalized := agentprovider.NormalizeOpen(provider)
	if normalized == "" {
		return 0
	}
	s.liveModelDiscoveryMu.Lock()
	defer s.liveModelDiscoveryMu.Unlock()
	return s.liveModelInvalidatedAtUnixMS[normalized]
}

var errLiveModelDiscoverySessionFailed = errors.New("live model discovery session failed")
var errLiveModelDiscoveryAlreadyAttempted = errors.New("live model discovery already attempted")

func (s *Service) discoverLiveComposerModelsUncachedForScope(
	ctx context.Context,
	scope composerLiveModelScope,
	providerTargetRef map[string]any,
	settings ComposerSettings,
) ([]ComposerConfigOptionValue, error) {
	isExtension := providerTargetRefKind(providerTargetRef) == "agent_extension"
	if isExtension {
		logAgentExtensionComposerDebug("discovery_started", map[string]any{
			"agentTargetId": scope.agentTargetID,
			"provider":      scope.provider,
			"workspaceId":   scope.workspaceID,
		})
	}
	resolvedCwd, err := s.resolveLiveModelDiscoveryCwd(ctx, scope.provider, scope.cwd)
	if err != nil {
		if isExtension {
			logAgentExtensionComposerDebug("cwd_resolution_failed", map[string]any{"error": err.Error(), "provider": scope.provider})
		}
		return nil, err
	}
	if isExtension && strings.TrimSpace(resolvedCwd) == "" {
		resolvedCwd, err = resolveAgentExtensionComposerDiscoveryCwd(scope.provider)
		if err != nil {
			logAgentExtensionComposerDebug("cwd_resolution_failed", map[string]any{"error": err.Error(), "provider": scope.provider})
			return nil, err
		}
	}
	if reused, hasProviderSession := s.liveModelOptionsFromRunningSessionForScope(scope); hasProviderSession {
		if len(reused) > 0 {
			return reused, nil
		}
		return nil, errLiveModelDiscoveryAlreadyAttempted
	}
	// Spawning a hidden probe session is opt-in per provider: it creates a
	// real provider session (and, for account-backed CLIs, server-side
	// artifacts), so providers without the flag only ever reuse running
	// sessions.
	if !composerProfileFor(scope.provider).LiveModelProbeSession &&
		providerTargetRefKind(providerTargetRef) != "agent_extension" {
		return nil, errLiveModelDiscoveryAlreadyAttempted
	}
	releaseStartup, err := s.awaitClaudeStartupSlot(ctx, scope.provider)
	if err != nil {
		return nil, err
	}
	// Recheck after waiting: another key may have started a reusable session
	// while this request waited for the credential-sensitive startup slot.
	if reused, hasProviderSession := s.liveModelOptionsFromRunningSessionForScope(scope); hasProviderSession {
		releaseStartup()
		if len(reused) > 0 {
			return reused, nil
		}
		return nil, errLiveModelDiscoveryAlreadyAttempted
	}
	var session ProviderRuntimeSession
	visible := false
	startInput := CreateSessionInput{
		AgentSessionID:    uuid.NewString(),
		AgentTargetID:     scope.agentTargetID,
		Provider:          scope.provider,
		ProviderTargetRef: clonePayload(providerTargetRef),
		Cwd:               &resolvedCwd,
		PermissionModeID:  stringPointer(strings.TrimSpace(settings.PermissionModeID)),
		PlanMode:          boolPointer(settings.PlanMode),
		BrowserUse:        settings.BrowserUse,
		ComputerUse:       settings.ComputerUse,
		ReasoningEffort:   stringPointer(strings.TrimSpace(settings.ReasoningEffort)),
		Speed:             stringPointer(strings.TrimSpace(settings.Speed)),
		Visible:           &visible,
	}
	logHiddenModelDiscoveryTriggered(scope.provider, startInput.AgentSessionID)
	session, err = func() (ProviderRuntimeSession, error) {
		defer releaseStartup()
		prepared, prepareErr := s.prepareRuntime(ctx, scope.workspaceID, resolvedCwd, startInput)
		if prepareErr != nil {
			return ProviderRuntimeSession{}, prepareErr
		}
		runtimeSession, startErr := s.controller().Start(ctx, RuntimeStartInput{
			WorkspaceID:       scope.workspaceID,
			AgentSessionID:    startInput.AgentSessionID,
			AgentTargetID:     scope.agentTargetID,
			Provider:          scope.provider,
			Cwd:               prepared.Cwd,
			Env:               prepared.Env,
			PermissionModeID:  value(startInput.PermissionModeID),
			Model:             clampComposerModelForLaunch(scope.provider, providerTargetRef, value(startInput.Model)),
			PlanMode:          clampComposerPlanModeForLaunch(scope.provider, providerTargetRef, valueBool(startInput.PlanMode)),
			BrowserUse:        startInput.BrowserUse,
			ComputerUse:       startInput.ComputerUse,
			ReasoningEffort:   normalizeReasoningEffortForLaunch(scope.provider, providerTargetRef, value(startInput.ReasoningEffort)),
			Speed:             normalizeSpeedForLaunch(scope.provider, providerTargetRef, value(startInput.Speed)),
			ProviderTargetRef: clonePayload(providerTargetRef),
			RuntimeContext: stampAgentExtensionComposerScope(map[string]any{
				"hiddenLiveModelDiscovery": true,
				"visible":                  false,
			}, providerTargetRef, scope.cwd, settings),
			Visible: startInput.Visible,
		})
		if startErr != nil {
			return ProviderRuntimeSession{}, normalizeRuntimeError(startErr)
		}
		return runtimeSession, nil
	}()
	if err != nil {
		s.invalidateProviderAvailability(scope.provider)
		if isExtension {
			logAgentExtensionComposerDebug("runtime_start_failed", map[string]any{
				"agentTargetId": scope.agentTargetID,
				"error":         err.Error(),
				"provider":      scope.provider,
			})
		}
		cleanupCtx := ctx
		cancelCleanup := func() {}
		if isExtension {
			cleanupCtx, cancelCleanup = context.WithTimeout(context.Background(), liveModelDiscoveryLifecycleTimeout)
		}
		cleanupErr := s.cleanupRuntime(cleanupCtx, scope.workspaceID, startInput.AgentSessionID)
		cancelCleanup()
		if cleanupErr != nil {
			return nil, errors.Join(err, cleanupErr)
		}
		return nil, err
	}
	s.markLiveModelDiscoveryAttempted(scope.key())
	if isExtension {
		logAgentExtensionComposerDebug("runtime_started", map[string]any{
			"agentSessionId": session.ID,
			"agentTargetId":  scope.agentTargetID,
			"provider":       scope.provider,
		})
	}
	s.trackLiveModelDiscoverySession(scope, session.ID)
	options, runtimeContext, pollErr := s.pollComposerModelOptions(
		ctx,
		scope.workspaceID,
		session,
		isExtension,
		scope.modelConfigOptionID,
	)
	if isExtension {
		runtimeContext = stampAgentExtensionComposerScope(runtimeContext, providerTargetRef, scope.cwd, settings)
		if len(runtimeContext) > 0 {
			s.setComposerRuntimeContextForScope(scope, time.Now().UTC(), runtimeContext)
		}
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), liveModelDiscoveryLifecycleTimeout)
		cleanupErr := s.cleanupLiveModelDiscoveryRuntime(cleanupCtx, scope.workspaceID, session.ID)
		cancelCleanup()
		if cleanupErr == nil {
			s.untrackLiveModelDiscoverySession(scope.workspaceID, session.ID)
		} else {
			s.scheduleLiveModelDiscoveryDelete(scope.workspaceID, session.ID)
		}
		if pollErr != nil || cleanupErr != nil {
			return nil, errors.Join(pollErr, cleanupErr)
		}
		return options, nil
	}
	s.scheduleLiveModelDiscoveryDelete(scope.workspaceID, session.ID)
	return options, pollErr
}

func (s *Service) discoverLiveComposerModelsUncached(
	ctx context.Context,
	provider string,
	workspaceID string,
	cwd string,
	settings ComposerSettings,
) ([]ComposerConfigOptionValue, error) {
	return s.discoverLiveComposerModelsUncachedForScope(
		ctx,
		newComposerLiveModelScope(provider, workspaceID, cwd, ""),
		nil,
		settings,
	)
}

func (s *Service) scheduleLiveModelDiscoveryDelete(workspaceID string, agentSessionID string) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return
	}
	delay := s.liveModelDiscoveryDeleteDelay()
	time.AfterFunc(delay, func() {
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), liveModelDiscoveryLifecycleTimeout)
		defer cancelCleanup()
		if err := s.cleanupLiveModelDiscoveryRuntime(cleanupCtx, workspaceID, agentSessionID); err == nil {
			s.untrackLiveModelDiscoverySession(workspaceID, agentSessionID)
		}
	})
}

func (s *Service) cleanupLiveModelDiscoveryRuntime(ctx context.Context, workspaceID, agentSessionID string) error {
	if _, live := s.controller().Session(workspaceID, agentSessionID); live {
		err := normalizeRuntimeError(s.controller().Close(ctx, RuntimeCloseInput{
			WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
		}))
		if err != nil && !errors.Is(err, ErrSessionNotFound) {
			return err
		}
	}
	return s.cleanupRuntime(ctx, workspaceID, agentSessionID)
}

func (s *Service) liveModelDiscoveryDeleteDelay() time.Duration {
	if s.LiveModelDiscoveryDeleteDelay != 0 {
		return s.LiveModelDiscoveryDeleteDelay
	}
	return liveModelDiscoveryDeleteDelay
}

func isHiddenLiveModelDiscoveryRuntimeContext(runtimeContext map[string]any) bool {
	hidden, _ := runtimeContext["hiddenLiveModelDiscovery"].(bool)
	return hidden
}

func isStaleHiddenLiveModelDiscoverySession(session PersistedSession) bool {
	runtimeContext := persistedSessionRuntimeContext(session)
	if isHiddenLiveModelDiscoveryRuntimeContext(runtimeContext) {
		return true
	}
	if !isClaudeSDKLiveModelProvider(session.Provider) {
		return false
	}
	if session.Metadata.Visible {
		return false
	}
	return strings.TrimSpace(session.Settings.Model) == "" && strings.TrimSpace(session.Cwd) == "/"
}

func (s *Service) pollComposerModelOptions(
	ctx context.Context,
	workspaceID string,
	session ProviderRuntimeSession,
	acceptComposerData bool,
	modelConfigOptionID string,
) ([]ComposerConfigOptionValue, map[string]any, error) {
	ticker := time.NewTicker(liveModelDiscoveryPollInterval)
	defer ticker.Stop()
	current := session
	for {
		if options := extractModelOptionsFromRuntimeContext(current.RuntimeContext, modelConfigOptionID); len(options) > 0 {
			return options, clonePayload(current.RuntimeContext), nil
		}
		if acceptComposerData && composerRuntimeContextHasComposerData(current.RuntimeContext) {
			return nil, clonePayload(current.RuntimeContext), nil
		}
		if err := liveModelDiscoverySessionFailureError(current); err != nil {
			return nil, clonePayload(current.RuntimeContext), err
		}
		select {
		case <-ctx.Done():
			return nil, clonePayload(current.RuntimeContext), ctx.Err()
		case <-ticker.C:
			refreshed, ok := s.controller().Session(workspaceID, current.ID)
			if ok {
				current = refreshed
			}
		}
	}
}

func liveModelDiscoverySessionFailureError(session ProviderRuntimeSession) error {
	if strings.TrimSpace(session.Status) != "failed" {
		return nil
	}
	lastError := strings.TrimSpace(session.LastError)
	if lastError == "" {
		return errLiveModelDiscoverySessionFailed
	}
	return fmt.Errorf("%w: %s", errLiveModelDiscoverySessionFailed, lastError)
}

func staticClaudeComposerModelOptions(selectedModel string) []ComposerConfigOptionValue {
	options := []ComposerConfigOptionValue{
		{ID: "default", Label: "Default", Value: "default"},
		{ID: "opus", Label: "Opus", Value: "opus"},
		{ID: "sonnet", Label: "Sonnet", Value: "sonnet"},
		{ID: "haiku", Label: "Haiku", Value: "haiku"},
	}
	selectedModel = strings.TrimSpace(selectedModel)
	if selectedModel == "" {
		return options
	}
	for _, option := range options {
		if strings.TrimSpace(option.Value) == selectedModel {
			return options
		}
	}
	return append(options, ComposerConfigOptionValue{
		ID:          selectedModel,
		Label:       selectedModel,
		Value:       selectedModel,
		Description: "Claude configured custom model",
	})
}

func (s *Service) mergeLiveComposerModelsForComposerOptions(
	ctx context.Context,
	input ComposerOptionsInput,
	effectiveSettings ComposerSettings,
	options ComposerOptions,
) (ComposerOptions, error) {
	provider := agentprovider.NormalizeOpen(input.Provider)
	scope := newComposerLiveModelScopeForInput(input, effectiveSettings)
	var liveModels []ComposerConfigOptionValue
	modelSource := "claude-static"
	if strings.TrimSpace(input.WorkspaceID) != "" {
		now := time.Now().UTC()
		reused, hasProviderSession := s.liveModelOptionsFromRunningSessionForScope(scope)
		switch {
		case len(reused) > 0:
			// A running session's advertised list is the freshest source. Use it
			// and refresh the cache so the last-known-good entry tracks live
			// changes (this is the only refresh path now that the Claude cache
			// never expires — do not let a stale cache shadow a live session).
			liveModels = reused
			s.setLiveComposerModelOptionsForScope(scope, now, reused)
			modelSource = runtimeLiveModelCatalogSource
			logClaudeModelCatalogInvalidationDebug("composer_options_reused_running_session", map[string]any{
				"workspaceId":       input.WorkspaceID,
				"provider":          provider,
				"cwd":               input.Cwd,
				"modelOptionCount":  len(reused),
				"modelOptionValues": composerConfigOptionValuesDebugValues(reused),
				"checkedAtUnixMs":   now.UnixMilli(),
			})
		case hasProviderSession:
			// A real session exists but has not advertised models yet. Prefer the
			// last-known-good cache over the static fallback, but never spawn a
			// hidden discovery session next to a live session.
			if cached, ok := s.getLiveComposerModelOptionsForScope(scope, now); ok {
				liveModels = cached
				modelSource = runtimeLiveModelCatalogSource
				logClaudeModelCatalogInvalidationDebug("composer_options_cache_hit_with_running_session", map[string]any{
					"workspaceId":       input.WorkspaceID,
					"provider":          provider,
					"cwd":               input.Cwd,
					"modelOptionCount":  len(cached),
					"modelOptionValues": composerConfigOptionValuesDebugValues(cached),
					"checkedAtUnixMs":   now.UnixMilli(),
				})
			} else if persisted, ok := s.persistedLiveModelFallbackForScope(scope, now); ok {
				liveModels = persisted
				modelSource = runtimeLiveModelCatalogSource
			}
		default:
			// No running session: prefer the cache, then the last catalog a
			// persisted session advertised. Only bootstrap a hidden discovery
			// session when neither source can populate the first composer.
			if cached, ok := s.getLiveComposerModelOptionsForScope(scope, now); ok {
				liveModels = cached
				modelSource = runtimeLiveModelCatalogSource
				logClaudeModelCatalogInvalidationDebug("composer_options_cache_hit", map[string]any{
					"workspaceId":       input.WorkspaceID,
					"provider":          provider,
					"cwd":               input.Cwd,
					"modelOptionCount":  len(cached),
					"modelOptionValues": composerConfigOptionValuesDebugValues(cached),
					"checkedAtUnixMs":   now.UnixMilli(),
				})
			} else if persisted, ok := s.persistedLiveModelFallback(input.WorkspaceID, input.Cwd, provider, now, input.AgentTargetID); ok {
				liveModels = persisted
				modelSource = runtimeLiveModelCatalogSource
			} else {
				discovered, err := s.discoverLiveComposerModels(ctx, input, effectiveSettings)
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					return ComposerOptions{}, err
				}
				if err == nil && len(discovered) > 0 {
					liveModels = discovered
					modelSource = runtimeLiveModelCatalogSource
				} else if persisted, ok := s.persistedLiveModelFallbackForScope(scope, now); ok {
					// Discovery may persist a scoped catalog before returning an
					// error. Re-read it so the picker does not collapse to only
					// the selected model.
					liveModels = persisted
					modelSource = runtimeLiveModelCatalogSource
				}
			}
		}
	}
	if len(liveModels) > 0 {
		liveModels = s.enrichModelCapabilityOptions(ctx, provider, liveModels)
		logClaudeModelCatalogInvalidationDebug("composer_options_model_source_selected", map[string]any{
			"workspaceId":       input.WorkspaceID,
			"cwd":               input.Cwd,
			"modelSource":       modelSource,
			"modelOptionCount":  len(liveModels),
			"modelOptionValues": composerConfigOptionValuesDebugValues(liveModels),
		})
		return mergeComposerModelsIntoComposerOptions(options, liveModels, modelSource), nil
	}
	if !isClaudeSDKLiveModelProvider(provider) {
		// Without a live list there is nothing trustworthy to offer beyond
		// the currently selected model; keep the static single-entry select.
		return options, nil
	}
	staticModels := staticClaudeComposerModelOptions(effectiveSettings.Model)
	if len(staticModels) > 0 {
		staticModels = s.enrichModelCapabilityOptions(ctx, provider, staticModels)
		logClaudeModelCatalogInvalidationDebug("composer_options_model_source_selected", map[string]any{
			"workspaceId":       input.WorkspaceID,
			"cwd":               input.Cwd,
			"modelSource":       modelSource,
			"modelOptionCount":  len(staticModels),
			"modelOptionValues": composerConfigOptionValuesDebugValues(staticModels),
		})
		return mergeComposerModelsIntoComposerOptions(options, staticModels, modelSource), nil
	}
	return clearUnverifiedLiveComposerModel(options), nil
}

func composerConfigOptionValuesDebugValues(options []ComposerConfigOptionValue) []string {
	if len(options) == 0 {
		return []string{}
	}
	values := make([]string, 0, len(options))
	for _, option := range options {
		value := strings.TrimSpace(option.Value)
		if value == "" {
			continue
		}
		values = append(values, value)
	}
	return values
}

func mergeLiveModelsIntoComposerOptions(options ComposerOptions, liveModels []ComposerConfigOptionValue) ComposerOptions {
	return mergeComposerModelsIntoComposerOptions(options, liveModels, runtimeLiveModelCatalogSource)
}

func mergeComposerModelsIntoComposerOptions(options ComposerOptions, liveModels []ComposerConfigOptionValue, modelSource string) ComposerOptions {
	normalized := normalizeLiveComposerModelOptions(liveModels)
	if len(normalized) == 0 {
		return options
	}
	selected := liveComposerSelectedModel(options.EffectiveSettings.Model, normalized)
	options.EffectiveSettings.Model = selected
	options.ModelConfig = ComposerConfigOption{
		Configurable: true,
		CurrentValue: selected,
		DefaultValue: selected,
		Options:      cloneComposerConfigOptionValues(normalized),
	}
	options.RuntimeContext = mergeLiveModelsIntoRuntimeContext(options.RuntimeContext, selected, normalized, modelSource)
	options = applyLiveModelReasoningOptions(options, selected, normalized)
	return options
}

func clearUnverifiedLiveComposerModel(options ComposerOptions) ComposerOptions {
	options.EffectiveSettings.Model = ""
	options.ModelConfig = ComposerConfigOption{}
	if options.RuntimeContext == nil {
		return options
	}
	options.RuntimeContext["model"] = nil
	delete(options.RuntimeContext, "modelCatalogSource")
	configOptions := runtimeConfigOptionsAsMapSlice(options.RuntimeContext["configOptions"])
	if len(configOptions) == 0 {
		return options
	}
	filtered := make([]map[string]any, 0, len(configOptions))
	for _, option := range configOptions {
		if strings.TrimSpace(stringFromAny(option["id"])) == "model" {
			continue
		}
		filtered = append(filtered, option)
	}
	options.RuntimeContext["configOptions"] = filtered
	return options
}

func normalizeLiveComposerModelOptions(options []ComposerConfigOptionValue) []ComposerConfigOptionValue {
	if len(options) == 0 {
		return nil
	}
	normalized := make([]ComposerConfigOptionValue, 0, len(options)+1)
	seen := make(map[string]struct{}, len(options)+1)
	for _, option := range options {
		value := strings.TrimSpace(option.Value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		label := strings.TrimSpace(option.Label)
		if label == "" {
			label = value
		}
		id := strings.TrimSpace(option.ID)
		if id == "" {
			id = value
		}
		normalized = append(normalized, ComposerConfigOptionValue{
			ID:                         id,
			Label:                      label,
			Value:                      value,
			Description:                strings.TrimSpace(option.Description),
			SupportsImageInput:         option.SupportsImageInput,
			SupportsReasoningEffort:    option.SupportsReasoningEffort,
			ReasoningEffort:            strings.TrimSpace(option.ReasoningEffort),
			ReasoningEfforts:           append([]AgentModelReasoningEffortOption(nil), option.ReasoningEfforts...),
			ReasoningEffortsAdvertised: option.ReasoningEffortsAdvertised,
		})
	}
	return normalized
}

func liveComposerSelectedModel(selectedModel string, liveModels []ComposerConfigOptionValue) string {
	selectedModel = strings.TrimSpace(selectedModel)
	if selectedModel != "" {
		for _, option := range liveModels {
			if strings.TrimSpace(option.Value) == selectedModel {
				return selectedModel
			}
		}
	}
	for _, option := range liveModels {
		if strings.TrimSpace(option.Value) == "default" {
			return "default"
		}
	}
	for _, option := range liveModels {
		if value := strings.TrimSpace(option.Value); value != "" {
			return value
		}
	}
	return ""
}

func mergeLiveModelsIntoRuntimeContext(
	runtimeContext map[string]any,
	selectedModel string,
	liveModels []ComposerConfigOptionValue,
	modelSource string,
) map[string]any {
	if runtimeContext == nil {
		runtimeContext = map[string]any{}
	}
	modelOption := map[string]any{
		"id":           "model",
		"currentValue": nullableString(selectedModel),
		"options":      composerConfigOptionValuesToRuntimeModelOptions(liveModels),
	}
	configOptions := make([]map[string]any, 0, 4)
	configOptions = append(configOptions, modelOption)
	for _, option := range runtimeConfigOptionsAsMapSlice(runtimeContext["configOptions"]) {
		if strings.TrimSpace(stringFromAny(option["id"])) == "model" {
			continue
		}
		configOptions = append(configOptions, option)
	}
	runtimeContext["configOptions"] = configOptions
	runtimeContext["model"] = nullableString(selectedModel)
	runtimeContext["modelCatalogSource"] = strings.TrimSpace(modelSource)
	return runtimeContext
}

func nullableString(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}
