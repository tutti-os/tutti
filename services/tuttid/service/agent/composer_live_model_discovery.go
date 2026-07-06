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
	"golang.org/x/sync/singleflight"
)

const liveModelDiscoveryPollInterval = 100 * time.Millisecond
const liveModelDiscoveryTimeout = 20 * time.Second
const liveModelDiscoveryDeleteDelay = 10 * time.Minute
const liveModelDiscoveryCleanupTimeout = 5 * time.Second
const claudeModelCatalogInvalidationDebugPrefix = "CLAUDE_MODEL_CATALOG_INVALIDATION_DEBUG"

func logClaudeModelCatalogInvalidationDebug(stage string, payload map[string]any) {
	if payload == nil {
		payload = map[string]any{}
	}
	payload["stage"] = stage
	encoded, err := json.Marshal(payload)
	if err != nil {
		encoded, _ = json.Marshal(map[string]any{
			"stage":        stage,
			"marshalError": err.Error(),
		})
	}
	slog.Warn(claudeModelCatalogInvalidationDebugPrefix, "payload_json", string(encoded))
}

// claudeStartupSerializer serializes credential-touching Claude startups so that
// Tutti never runs two `claude` processes that both refresh the shared OAuth
// token at the same time.
//
// Claude OAuth refresh rotates the refresh token. If two Claude startups
// overlap and both read the same stale token, the later writer can leave the
// shared credential store unusable. This is a channel-based mutex so acquisition
// honors context cancel.
type claudeStartupSerializer struct {
	sem chan struct{}
}

func newClaudeStartupSerializer() *claudeStartupSerializer {
	return &claudeStartupSerializer{sem: make(chan struct{}, 1)}
}

func (s *claudeStartupSerializer) acquire(ctx context.Context) error {
	select {
	case s.sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *claudeStartupSerializer) release() {
	select {
	case <-s.sem:
	default:
	}
}

func (s *Service) claudeStartup() *claudeStartupSerializer {
	if s.claudeStartupLock == nil {
		s.claudeStartupLock = newClaudeStartupSerializer()
	}
	return s.claudeStartupLock
}

// awaitClaudeStartupSlot blocks until no other credential-touching Claude
// startup is running, then returns a release function the caller must invoke
// once its own session startup has completed. Non-Claude providers do not
// participate and get a no-op release.
func (s *Service) awaitClaudeStartupSlot(ctx context.Context, provider string) (func(), error) {
	if agentprovider.Normalize(provider) != agentprovider.ClaudeCode {
		return func() {}, nil
	}
	if err := s.claudeStartup().acquire(ctx); err != nil {
		return nil, err
	}
	return s.claudeStartup().release, nil
}

// liveModelOptionsFromRunningSession returns the model list already
// advertised by a live session of the provider in the workspace, if any. It
// lets model discovery reuse an in-flight conversation instead of spawning a
// second process next to it.
func (s *Service) liveModelOptionsFromRunningSession(workspaceID string, provider string) ([]ComposerConfigOptionValue, bool) {
	provider = agentprovider.Normalize(provider)
	hasProviderSession := false
	invalidatedAtUnixMS := s.liveModelInvalidatedAtUnixMSForProvider(provider)
	for _, session := range s.controller().Sessions(workspaceID) {
		if agentprovider.Normalize(session.Provider) != provider {
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

var liveComposerModelDiscoveryGroup singleflight.Group

var errLiveModelDiscoverySessionFailed = errors.New("live model discovery session failed")
var errLiveModelDiscoveryAlreadyAttempted = errors.New("live model discovery already attempted")

func (s *Service) discoverLiveComposerModels(
	ctx context.Context,
	provider string,
	workspaceID string,
	cwd string,
	settings ComposerSettings,
) ([]ComposerConfigOptionValue, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil, ErrInvalidArgument
	}
	provider = agentprovider.Normalize(provider)
	cacheKey := composerLiveModelCacheKey(provider, workspaceID, cwd, liveModelAuthScope(provider))
	resultCh := liveComposerModelDiscoveryGroup.DoChan(cacheKey, func() (any, error) {
		now := time.Now().UTC()
		if cached, ok := s.getLiveComposerModelOptions(provider, workspaceID, cwd, now); ok && len(cached) > 0 {
			logClaudeModelCatalogInvalidationDebug("discovery_cache_hit", map[string]any{
				"workspaceId":       workspaceID,
				"cwd":               cwd,
				"modelOptionCount":  len(cached),
				"modelOptionValues": composerConfigOptionValuesDebugValues(cached),
				"checkedAtUnixMs":   now.UnixMilli(),
				"liveModelCacheKey": cacheKey,
			})
			return cached, nil
		}
		if !s.markLiveModelDiscoveryAttempted(cacheKey) {
			logClaudeModelCatalogInvalidationDebug("discovery_skipped_already_attempted", map[string]any{
				"workspaceId":       workspaceID,
				"cwd":               cwd,
				"liveModelCacheKey": cacheKey,
			})
			return nil, errLiveModelDiscoveryAlreadyAttempted
		}
		logClaudeModelCatalogInvalidationDebug("discovery_uncached_start", map[string]any{
			"workspaceId":       workspaceID,
			"provider":          provider,
			"cwd":               cwd,
			"liveModelCacheKey": cacheKey,
		})
		discovered, discoverErr := s.discoverLiveComposerModelsUncached(ctx, provider, workspaceID, cwd, settings)
		if discoverErr != nil {
			logClaudeModelCatalogInvalidationDebug("discovery_uncached_failed", map[string]any{
				"workspaceId":       workspaceID,
				"cwd":               cwd,
				"liveModelCacheKey": cacheKey,
				"error":             discoverErr.Error(),
			})
			return nil, discoverErr
		}
		s.setLiveComposerModelOptions(provider, workspaceID, cwd, now, discovered)
		logClaudeModelCatalogInvalidationDebug("discovery_uncached_succeeded", map[string]any{
			"workspaceId":       workspaceID,
			"cwd":               cwd,
			"liveModelCacheKey": cacheKey,
			"modelOptionCount":  len(discovered),
			"modelOptionValues": composerConfigOptionValuesDebugValues(discovered),
		})
		return discovered, nil
	})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result := <-resultCh:
		if result.Err != nil {
			return nil, result.Err
		}
		models, _ := result.Val.([]ComposerConfigOptionValue)
		return cloneComposerConfigOptionValues(models), nil
	}
}

func (s *Service) markLiveModelDiscoveryAttempted(cacheKey string) bool {
	cacheKey = strings.TrimSpace(cacheKey)
	if cacheKey == "" {
		return false
	}
	s.liveModelDiscoveryMu.Lock()
	defer s.liveModelDiscoveryMu.Unlock()
	if s.liveModelDiscoveryAttempted == nil {
		s.liveModelDiscoveryAttempted = make(map[string]struct{})
	}
	if _, ok := s.liveModelDiscoveryAttempted[cacheKey]; ok {
		return false
	}
	s.liveModelDiscoveryAttempted[cacheKey] = struct{}{}
	return true
}

func (s *Service) discoverLiveComposerModelsUncached(
	ctx context.Context,
	provider string,
	workspaceID string,
	cwd string,
	settings ComposerSettings,
) ([]ComposerConfigOptionValue, error) {
	resolvedCwd := strings.TrimSpace(cwd)
	if resolvedCwd != "" {
		resolved, err := s.resolveCwd(ctx, &resolvedCwd)
		if err != nil {
			return nil, err
		}
		resolvedCwd = resolved
	}
	if reused, hasProviderSession := s.liveModelOptionsFromRunningSession(workspaceID, provider); hasProviderSession {
		if len(reused) > 0 {
			return reused, nil
		}
		return nil, errLiveModelDiscoveryAlreadyAttempted
	}
	// Spawning a hidden probe session is opt-in per provider: it creates a
	// real provider session (and, for account-backed CLIs, server-side
	// artifacts), so providers without the flag only ever reuse running
	// sessions.
	if !composerProfileFor(provider).LiveModelProbeSession {
		return nil, errLiveModelDiscoveryAlreadyAttempted
	}
	if err := s.ensureProviderRuntimeInstalled(ctx, provider); err != nil {
		return nil, err
	}
	spawnCtx, cancelSpawn := context.WithTimeout(ctx, liveModelDiscoveryTimeout)
	defer cancelSpawn()
	releaseStartup, err := s.awaitClaudeStartupSlot(spawnCtx, provider)
	if err != nil {
		return nil, err
	}
	var session RuntimeSession
	visible := false
	startInput := CreateSessionInput{
		AgentSessionID:   uuid.NewString(),
		Provider:         provider,
		Cwd:              &resolvedCwd,
		PermissionModeID: stringPointer(strings.TrimSpace(settings.PermissionModeID)),
		PlanMode:         boolPointer(settings.PlanMode),
		BrowserUse:       settings.BrowserUse,
		ComputerUse:      settings.ComputerUse,
		ReasoningEffort:  stringPointer(strings.TrimSpace(settings.ReasoningEffort)),
		Speed:            stringPointer(strings.TrimSpace(settings.Speed)),
		Visible:          &visible,
	}
	session, err = func() (RuntimeSession, error) {
		defer releaseStartup()
		prepared, prepareErr := s.prepareRuntime(spawnCtx, workspaceID, resolvedCwd, startInput)
		if prepareErr != nil {
			return RuntimeSession{}, prepareErr
		}
		runtimeSession, startErr := s.controller().Start(spawnCtx, RuntimeStartInput{
			WorkspaceID:      workspaceID,
			AgentSessionID:   startInput.AgentSessionID,
			Provider:         provider,
			Cwd:              prepared.Cwd,
			Env:              prepared.Env,
			PermissionModeID: value(startInput.PermissionModeID),
			Model:            clampComposerModelForProvider(provider, value(startInput.Model)),
			PlanMode:         clampComposerPlanModeForProvider(provider, valueBool(startInput.PlanMode)),
			BrowserUse:       startInput.BrowserUse,
			ComputerUse:      startInput.ComputerUse,
			ReasoningEffort:  normalizeReasoningEffortForProvider(provider, value(startInput.ReasoningEffort)),
			Speed:            normalizeSpeedForProvider(provider, value(startInput.Speed)),
			RuntimeContext: map[string]any{
				"hiddenLiveModelDiscovery": true,
				"visible":                  false,
			},
			Visible: startInput.Visible,
		})
		if startErr != nil {
			return RuntimeSession{}, normalizeRuntimeError(startErr)
		}
		return runtimeSession, nil
	}()
	if err != nil {
		cleanupErr := s.cleanupRuntime(ctx, workspaceID, startInput.AgentSessionID)
		if cleanupErr != nil {
			return nil, errors.Join(err, cleanupErr)
		}
		return nil, err
	}
	s.scheduleLiveModelDiscoveryDelete(workspaceID, session.ID)
	return s.pollComposerModelOptions(spawnCtx, workspaceID, session)
}

func (s *Service) scheduleLiveModelDiscoveryDelete(workspaceID string, agentSessionID string) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return
	}
	delay := s.liveModelDiscoveryDeleteDelay()
	time.AfterFunc(delay, func() {
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), liveModelDiscoveryCleanupTimeout)
		defer cancelCleanup()
		_, _ = s.Delete(cleanupCtx, workspaceID, agentSessionID)
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
	if isHiddenLiveModelDiscoveryRuntimeContext(session.RuntimeContext) {
		return true
	}
	if agentprovider.Normalize(session.Provider) != agentprovider.ClaudeCode {
		return false
	}
	if visibleFromRuntimeContext(session.RuntimeContext, true) {
		return false
	}
	return strings.TrimSpace(session.Settings.Model) == "" && strings.TrimSpace(session.Cwd) == "/"
}

func (s *Service) pollComposerModelOptions(
	ctx context.Context,
	workspaceID string,
	session RuntimeSession,
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

func liveModelDiscoverySessionFailureError(session RuntimeSession) error {
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
		options = append(options, ComposerConfigOptionValue{
			ID:          id,
			Label:       label,
			Value:       value,
			Description: strings.TrimSpace(stringFromAny(optionMap["description"])),
		})
	}
	return options
}

func stringFromAny(input any) string {
	if value, ok := input.(string); ok {
		return value
	}
	return ""
}

func (s *Service) mergeLiveComposerModelsForComposerOptions(
	ctx context.Context,
	input ComposerOptionsInput,
	effectiveSettings ComposerSettings,
	options ComposerOptions,
) (ComposerOptions, error) {
	provider := agentprovider.Normalize(input.Provider)
	var liveModels []ComposerConfigOptionValue
	modelSource := "claude-static"
	if strings.TrimSpace(input.WorkspaceID) != "" {
		now := time.Now().UTC()
		reused, hasProviderSession := s.liveModelOptionsFromRunningSession(input.WorkspaceID, provider)
		switch {
		case len(reused) > 0:
			// A running session's advertised list is the freshest source. Use it
			// and refresh the cache so the last-known-good entry tracks live
			// changes (this is the only refresh path now that the Claude cache
			// never expires — do not let a stale cache shadow a live session).
			liveModels = reused
			s.setLiveComposerModelOptions(provider, input.WorkspaceID, input.Cwd, now, reused)
			modelSource = "acp-live-discovery"
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
			if cached, ok := s.getLiveComposerModelOptions(provider, input.WorkspaceID, input.Cwd, now); ok {
				liveModels = cached
				modelSource = "acp-live-discovery"
				logClaudeModelCatalogInvalidationDebug("composer_options_cache_hit_with_running_session", map[string]any{
					"workspaceId":       input.WorkspaceID,
					"provider":          provider,
					"cwd":               input.Cwd,
					"modelOptionCount":  len(cached),
					"modelOptionValues": composerConfigOptionValuesDebugValues(cached),
					"checkedAtUnixMs":   now.UnixMilli(),
				})
			}
		default:
			// No running session: prefer the cache, else one hidden discovery,
			// else fall through to the static fallback below.
			if cached, ok := s.getLiveComposerModelOptions(provider, input.WorkspaceID, input.Cwd, now); ok {
				liveModels = cached
				modelSource = "acp-live-discovery"
				logClaudeModelCatalogInvalidationDebug("composer_options_cache_hit", map[string]any{
					"workspaceId":       input.WorkspaceID,
					"provider":          provider,
					"cwd":               input.Cwd,
					"modelOptionCount":  len(cached),
					"modelOptionValues": composerConfigOptionValuesDebugValues(cached),
					"checkedAtUnixMs":   now.UnixMilli(),
				})
			} else {
				discovered, err := s.discoverLiveComposerModels(ctx, provider, input.WorkspaceID, input.Cwd, effectiveSettings)
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					return ComposerOptions{}, err
				}
				if err == nil && len(discovered) > 0 {
					liveModels = discovered
					modelSource = "acp-live-discovery"
				}
			}
		}
	}
	if len(liveModels) > 0 {
		logClaudeModelCatalogInvalidationDebug("composer_options_model_source_selected", map[string]any{
			"workspaceId":       input.WorkspaceID,
			"cwd":               input.Cwd,
			"modelSource":       modelSource,
			"modelOptionCount":  len(liveModels),
			"modelOptionValues": composerConfigOptionValuesDebugValues(liveModels),
		})
		return mergeComposerModelsIntoComposerOptions(options, liveModels, modelSource), nil
	}
	if provider != agentprovider.ClaudeCode {
		// Without a live list there is nothing trustworthy to offer beyond
		// the currently selected model; keep the static single-entry select.
		return options, nil
	}
	staticModels := staticClaudeComposerModelOptions(effectiveSettings.Model)
	if len(staticModels) > 0 {
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
	return mergeComposerModelsIntoComposerOptions(options, liveModels, "acp-live-discovery")
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
			ID:          id,
			Label:       label,
			Value:       value,
			Description: strings.TrimSpace(option.Description),
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

func composerConfigOptionValuesToRuntimeModelOptions(options []ComposerConfigOptionValue) []map[string]string {
	if len(options) == 0 {
		return []map[string]string{}
	}
	result := make([]map[string]string, 0, len(options))
	for _, option := range options {
		value := strings.TrimSpace(option.Value)
		if value == "" {
			continue
		}
		label := strings.TrimSpace(option.Label)
		if label == "" {
			label = value
		}
		entry := map[string]string{
			"name":  label,
			"value": value,
		}
		// Carry the per-model description through to RuntimeContext. The desktop
		// composer projection prefers this live model list over ModelConfig.Options,
		// so dropping the description here removes the model hover detail.
		if description := strings.TrimSpace(option.Description); description != "" {
			entry["description"] = description
		}
		result = append(result, entry)
	}
	return result
}

func runtimeConfigOptionsAsMapSlice(input any) []map[string]any {
	switch typed := input.(type) {
	case []map[string]any:
		return append([]map[string]any(nil), typed...)
	case []any:
		result := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			result = append(result, entry)
		}
		return result
	default:
		return nil
	}
}

func nullableString(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}
