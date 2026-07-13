package agent

import (
	"context"
	"encoding/json"
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
const claudeModelCatalogInvalidationDebugPrefix = "CLAUDE_MODEL_CATALOG_INVALIDATION_DEBUG"

var claudeModelCatalogDebugSafeFields = map[string]struct{}{
	"agentSessionId":        {},
	"checkedAtUnixMs":       {},
	"createdAtUnixMs":       {},
	"deletedAttemptMarkers": {},
	"deletedCacheEntries":   {},
	"hiddenDiscovery":       {},
	"invalidatedAtUnixMs":   {},
	"modelOptionCount":      {},
	"modelSource":           {},
	"occurredAtUnixMs":      {},
	"provider":              {},
	"status":                {},
	"updatedAtUnixMs":       {},
	"visible":               {},
	"workspaceId":           {},
}

func logClaudeModelCatalogInvalidationDebug(stage string, payload map[string]any) {
	safePayload := claudeModelCatalogDebugPayload(stage, payload)
	encoded, err := json.Marshal(safePayload)
	if err != nil {
		encoded = []byte(`{"stage":"debug_payload_unavailable"}`)
	}
	slog.Debug(claudeModelCatalogInvalidationDebugPrefix, "payload_json", string(encoded))
}

func claudeModelCatalogDebugPayload(stage string, payload map[string]any) map[string]any {
	safePayload := make(map[string]any, len(payload)+1)
	for key, value := range payload {
		if _, ok := claudeModelCatalogDebugSafeFields[key]; ok {
			safePayload[key] = value
		}
	}
	safePayload["stage"] = stage
	if _, hasError := payload["error"]; hasError {
		safePayload["errorClass"] = "discovery_failed"
	}
	return safePayload
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
	provider = agentprovider.Normalize(provider)
	agentTargetID := ""
	if len(agentTargetIDs) > 0 {
		agentTargetID = agentTargetIDs[0]
	}
	hasProviderSession := false
	invalidatedAtUnixMS := s.liveModelInvalidatedAtUnixMSForProvider(provider)
	for _, session := range s.controller().Sessions(workspaceID) {
		if agentprovider.Normalize(session.Provider) != provider {
			continue
		}
		if agentTargetID = strings.TrimSpace(agentTargetID); agentTargetID != "" && strings.TrimSpace(session.AgentTargetID) != agentTargetID {
			continue
		}
		sessionCatalogUnixMS := firstNonZeroInt64(session.UpdatedAtUnixMS, session.CreatedAtUnixMS)
		options := extractModelOptionsFromRuntimeContext(session.RuntimeContext)
		logClaudeModelCatalogInvalidationDebug("running_session_model_options_inspected", map[string]any{
			"workspaceId":         workspaceID,
			"provider":            provider,
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
				"workspaceId":         workspaceID,
				"provider":            provider,
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
		if len(options) > 0 {
			logClaudeModelCatalogInvalidationDebug("running_session_model_options_reused", map[string]any{
				"workspaceId":       workspaceID,
				"provider":          provider,
				"agentSessionId":    session.ID,
				"modelOptionCount":  len(options),
				"modelOptionValues": composerConfigOptionValuesDebugValues(options),
			})
			return options, true
		}
	}
	if hasProviderSession {
		logClaudeModelCatalogInvalidationDebug("running_session_without_reusable_models", map[string]any{
			"workspaceId": workspaceID,
			"provider":    provider,
		})
	}
	return nil, hasProviderSession
}

func (s *Service) liveModelInvalidatedAtUnixMSForProvider(provider string) int64 {
	normalized := agentprovider.Normalize(provider)
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
	resolvedCwd, err := s.resolveLiveModelDiscoveryCwd(ctx, scope.provider, scope.cwd)
	if err != nil {
		return nil, err
	}
	if reused, hasProviderSession := s.liveModelOptionsFromRunningSession(scope.workspaceID, scope.provider, scope.agentTargetID); hasProviderSession {
		if len(reused) > 0 {
			return reused, nil
		}
		return nil, errLiveModelDiscoveryAlreadyAttempted
	}
	// Spawning a hidden probe session is opt-in per provider: it creates a
	// real provider session (and, for account-backed CLIs, server-side
	// artifacts), so providers without the flag only ever reuse running
	// sessions.
	if !composerProfileFor(scope.provider).LiveModelProbeSession {
		return nil, errLiveModelDiscoveryAlreadyAttempted
	}
	if err := s.ensureProviderRuntimeInstalled(ctx, scope.provider); err != nil {
		return nil, err
	}
	releaseStartup, err := s.awaitClaudeStartupSlot(ctx, scope.provider)
	if err != nil {
		return nil, err
	}
	// Recheck after waiting: another key may have started a reusable session
	// while this request waited for the credential-sensitive startup slot.
	if reused, hasProviderSession := s.liveModelOptionsFromRunningSession(scope.workspaceID, scope.provider, scope.agentTargetID); hasProviderSession {
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
			Model:             clampComposerModelForProvider(scope.provider, value(startInput.Model)),
			PlanMode:          clampComposerPlanModeForProvider(scope.provider, valueBool(startInput.PlanMode)),
			BrowserUse:        startInput.BrowserUse,
			ComputerUse:       startInput.ComputerUse,
			ReasoningEffort:   normalizeReasoningEffortForProvider(scope.provider, value(startInput.ReasoningEffort)),
			Speed:             normalizeSpeedForProvider(scope.provider, value(startInput.Speed)),
			ProviderTargetRef: clonePayload(providerTargetRef),
			RuntimeContext: map[string]any{
				"hiddenLiveModelDiscovery": true,
				"visible":                  false,
			},
			Visible: startInput.Visible,
		})
		if startErr != nil {
			return ProviderRuntimeSession{}, normalizeRuntimeError(startErr)
		}
		return runtimeSession, nil
	}()
	if err != nil {
		cleanupErr := s.cleanupRuntime(ctx, scope.workspaceID, startInput.AgentSessionID)
		if cleanupErr != nil {
			return nil, errors.Join(err, cleanupErr)
		}
		return nil, err
	}
	s.markLiveModelDiscoveryAttempted(scope.key())
	s.trackLiveModelDiscoverySession(scope, session.ID)
	s.scheduleLiveModelDiscoveryDelete(scope.workspaceID, session.ID)
	return s.pollComposerModelOptions(ctx, scope.workspaceID, session)
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
		if _, err := s.Delete(cleanupCtx, workspaceID, agentSessionID); err == nil || errors.Is(err, ErrSessionNotFound) {
			s.untrackLiveModelDiscoverySession(workspaceID, agentSessionID)
		}
	})
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
) ([]ComposerConfigOptionValue, error) {
	ticker := time.NewTicker(liveModelDiscoveryPollInterval)
	defer ticker.Stop()
	current := session
	for {
		if options := extractModelOptionsFromRuntimeContext(current.RuntimeContext); len(options) > 0 {
			return options, nil
		}
		if err := liveModelDiscoverySessionFailureError(current); err != nil {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
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

func extractModelOptionsFromRuntimeContext(runtimeContext map[string]any) []ComposerConfigOptionValue {
	if len(runtimeContext) == 0 {
		return nil
	}
	configOptions, ok := runtimeContext["configOptions"].([]any)
	if !ok {
		if typed, typedOK := runtimeContext["configOptions"].([]map[string]any); typedOK {
			configOptions = make([]any, 0, len(typed))
			for _, item := range typed {
				configOptions = append(configOptions, item)
			}
		}
	}
	if len(configOptions) == 0 {
		return nil
	}
	for _, optionRaw := range configOptions {
		optionMap, ok := optionRaw.(map[string]any)
		if !ok || strings.TrimSpace(stringFromAny(optionMap["id"])) != "model" {
			continue
		}
		return composerConfigOptionValuesFromAny(optionMap["options"])
	}
	return nil
}

func composerConfigOptionValuesFromAny(input any) []ComposerConfigOptionValue {
	rawOptions, ok := input.([]any)
	if !ok {
		if typed, typedOK := input.([]map[string]string); typedOK {
			rawOptions = make([]any, 0, len(typed))
			for _, item := range typed {
				rawOptions = append(rawOptions, item)
			}
		}
	}
	if len(rawOptions) == 0 {
		return nil
	}
	options := make([]ComposerConfigOptionValue, 0, len(rawOptions))
	for _, raw := range rawOptions {
		optionMap, ok := raw.(map[string]any)
		if !ok {
			if typed, typedOK := raw.(map[string]string); typedOK {
				optionMap = map[string]any{
					"id":    typed["id"],
					"name":  typed["name"],
					"label": typed["label"],
					"value": typed["value"],
				}
			} else {
				continue
			}
		}
		value := strings.TrimSpace(stringFromAny(optionMap["value"]))
		if value == "" {
			continue
		}
		label := strings.TrimSpace(stringFromAny(optionMap["label"]))
		if label == "" {
			label = strings.TrimSpace(stringFromAny(optionMap["name"]))
		}
		if label == "" {
			label = value
		}
		id := strings.TrimSpace(stringFromAny(optionMap["id"]))
		if id == "" {
			id = value
		}
		var supportsImageInput *bool
		if value, ok := boolFromAny(optionMap["supportsImageInput"]); ok {
			supportsImageInput = &value
		}
		options = append(options, ComposerConfigOptionValue{
			ID:                 id,
			Label:              label,
			Value:              value,
			Description:        strings.TrimSpace(stringFromAny(optionMap["description"])),
			SupportsImageInput: supportsImageInput,
		})
	}
	return options
}

func (s *Service) mergeLiveComposerModelsForComposerOptions(
	ctx context.Context,
	input ComposerOptionsInput,
	effectiveSettings ComposerSettings,
	options ComposerOptions,
) (ComposerOptions, error) {
	provider := agentprovider.Normalize(input.Provider)
	scope := newComposerLiveModelScope(provider, input.WorkspaceID, input.Cwd, input.AgentTargetID)
	var liveModels []ComposerConfigOptionValue
	modelSource := "claude-static"
	if strings.TrimSpace(input.WorkspaceID) != "" {
		now := time.Now().UTC()
		reused, hasProviderSession := s.liveModelOptionsFromRunningSession(input.WorkspaceID, provider, input.AgentTargetID)
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
			} else if persisted, ok := s.persistedLiveModelFallback(input.WorkspaceID, input.Cwd, provider, now, input.AgentTargetID); ok {
				liveModels = persisted
				modelSource = runtimeLiveModelCatalogSource
			}
		default:
			// No running session: prefer the cache, else one hidden discovery,
			// else fall through to the static fallback below.
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
			} else {
				discovered, err := s.discoverLiveComposerModels(ctx, input, effectiveSettings)
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					return ComposerOptions{}, err
				}
				if err == nil && len(discovered) > 0 {
					liveModels = discovered
					modelSource = runtimeLiveModelCatalogSource
				} else if persisted, ok := s.persistedLiveModelFallback(input.WorkspaceID, input.Cwd, provider, now, input.AgentTargetID); ok {
					// No live session, no cache, and discovery could not run
					// (Cursor never probes; Claude probes once per key). Restore
					// the last list a past session persisted so the picker does
					// not collapse to the single selected model.
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
			ID:                 id,
			Label:              label,
			Value:              value,
			Description:        strings.TrimSpace(option.Description),
			SupportsImageInput: option.SupportsImageInput,
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
