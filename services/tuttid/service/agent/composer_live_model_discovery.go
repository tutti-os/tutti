package agent

import (
	"context"
	"errors"
	"fmt"
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

// liveClaudeModelOptionsFromRunningSession returns the model list already
// advertised by a live Claude session in the workspace, if any. It lets model
// discovery reuse an in-flight conversation instead of spawning a second,
// credential-sharing process next to it.
func (s *Service) liveClaudeModelOptionsFromRunningSession(workspaceID string) ([]ComposerConfigOptionValue, bool) {
	hasClaudeSession := false
	for _, session := range s.controller().Sessions(workspaceID) {
		if agentprovider.Normalize(session.Provider) != agentprovider.ClaudeCode {
			continue
		}
		hasClaudeSession = true
		if options := extractModelOptionsFromRuntimeContext(session.RuntimeContext); len(options) > 0 {
			return options, true
		}
	}
	return nil, hasClaudeSession
}

var liveComposerModelDiscoveryGroup singleflight.Group

var errLiveModelDiscoverySessionFailed = errors.New("live model discovery session failed")
var errLiveModelDiscoveryAlreadyAttempted = errors.New("live model discovery already attempted")

func (s *Service) discoverLiveComposerModels(
	ctx context.Context,
	workspaceID string,
	cwd string,
	settings ComposerSettings,
) ([]ComposerConfigOptionValue, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil, ErrInvalidArgument
	}
	provider := agentprovider.ClaudeCode
	cacheKey := composerLiveModelCacheKey(provider, workspaceID, cwd)
	resultCh := liveComposerModelDiscoveryGroup.DoChan(cacheKey, func() (any, error) {
		now := time.Now().UTC()
		if cached, ok := s.getLiveComposerModelOptions(provider, workspaceID, cwd, now); ok && len(cached) > 0 {
			return cached, nil
		}
		if !s.markLiveModelDiscoveryAttempted(cacheKey) {
			return nil, errLiveModelDiscoveryAlreadyAttempted
		}
		discovered, discoverErr := s.discoverLiveComposerModelsUncached(ctx, workspaceID, cwd, settings)
		if discoverErr != nil {
			return nil, discoverErr
		}
		s.setLiveComposerModelOptions(provider, workspaceID, cwd, now, discovered)
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
	workspaceID string,
	cwd string,
	settings ComposerSettings,
) ([]ComposerConfigOptionValue, error) {
	provider := agentprovider.ClaudeCode
	resolvedCwd := strings.TrimSpace(cwd)
	if resolvedCwd != "" {
		resolved, err := s.resolveCwd(ctx, &resolvedCwd)
		if err != nil {
			return nil, err
		}
		resolvedCwd = resolved
	}
	if reused, hasClaudeSession := s.liveClaudeModelOptionsFromRunningSession(workspaceID); hasClaudeSession {
		if len(reused) > 0 {
			return reused, nil
		}
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
	provider := agentprovider.ClaudeCode
	var liveModels []ComposerConfigOptionValue
	modelSource := "claude-static"
	if strings.TrimSpace(input.WorkspaceID) != "" {
		now := time.Now().UTC()
		cached, ok := s.getLiveComposerModelOptions(provider, input.WorkspaceID, input.Cwd, now)
		if ok {
			liveModels = cached
			modelSource = "acp-live-discovery"
		} else if reused, hasClaudeSession := s.liveClaudeModelOptionsFromRunningSession(input.WorkspaceID); hasClaudeSession {
			if len(reused) > 0 {
				liveModels = reused
				s.setLiveComposerModelOptions(provider, input.WorkspaceID, input.Cwd, now, reused)
				modelSource = "acp-live-discovery"
			}
			// If a real Claude session exists but has not advertised a model list
			// yet, do not spawn a hidden discovery session next to it.
		} else {
			discovered, err := s.discoverLiveComposerModels(ctx, input.WorkspaceID, input.Cwd, effectiveSettings)
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return ComposerOptions{}, err
			}
			if err == nil && len(discovered) > 0 {
				liveModels = discovered
				modelSource = "acp-live-discovery"
			}
		}
	}
	if len(liveModels) > 0 {
		return mergeComposerModelsIntoComposerOptions(options, liveModels, modelSource), nil
	}
	staticModels := staticClaudeComposerModelOptions(effectiveSettings.Model)
	if len(staticModels) > 0 {
		return mergeComposerModelsIntoComposerOptions(options, staticModels, modelSource), nil
	}
	return clearUnverifiedLiveComposerModel(options), nil
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
