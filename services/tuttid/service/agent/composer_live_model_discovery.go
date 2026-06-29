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

var liveComposerModelDiscoveryGroup singleflight.Group

var errLiveModelDiscoverySessionFailed = errors.New("live model discovery session failed")

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

func (s *Service) discoverLiveComposerModelsUncached(
	ctx context.Context,
	workspaceID string,
	cwd string,
	settings ComposerSettings,
) ([]ComposerConfigOptionValue, error) {
	provider := agentprovider.ClaudeCode
	if err := s.ensureProviderRuntimeInstalled(ctx, provider); err != nil {
		return nil, err
	}
	resolvedCwd := strings.TrimSpace(cwd)
	if resolvedCwd != "" {
		resolved, err := s.resolveCwd(ctx, &resolvedCwd)
		if err != nil {
			return nil, err
		}
		resolvedCwd = resolved
	}
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
	prepared, err := s.prepareRuntime(ctx, workspaceID, resolvedCwd, startInput)
	if err != nil {
		return nil, err
	}
	session, err := s.controller().Start(ctx, RuntimeStartInput{
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
		Visible:          startInput.Visible,
	})
	if err != nil {
		cleanupErr := s.cleanupRuntime(ctx, workspaceID, startInput.AgentSessionID)
		if cleanupErr != nil {
			return nil, errors.Join(normalizeRuntimeError(err), cleanupErr)
		}
		return nil, normalizeRuntimeError(err)
	}
	defer func() {
		_, _ = s.Delete(context.Background(), workspaceID, session.ID)
	}()
	return s.pollComposerModelOptions(ctx, workspaceID, session)
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
	if strings.TrimSpace(input.WorkspaceID) != "" {
		now := time.Now().UTC()
		cached, ok := s.getLiveComposerModelOptions(provider, input.WorkspaceID, input.Cwd, now)
		if ok {
			liveModels = cached
		} else {
			discovered, err := s.discoverLiveComposerModels(ctx, input.WorkspaceID, input.Cwd, effectiveSettings)
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return ComposerOptions{}, err
			}
			if err == nil && len(discovered) > 0 {
				liveModels = discovered
				s.setLiveComposerModelOptions(provider, input.WorkspaceID, input.Cwd, now, discovered)
			}
		}
	}
	if len(liveModels) > 0 {
		return mergeLiveModelsIntoComposerOptions(options, liveModels), nil
	}
	return clearUnverifiedLiveComposerModel(options), nil
}

func mergeLiveModelsIntoComposerOptions(options ComposerOptions, liveModels []ComposerConfigOptionValue) ComposerOptions {
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
	options.RuntimeContext = mergeLiveModelsIntoRuntimeContext(options.RuntimeContext, selected, normalized)
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
	runtimeContext["modelCatalogSource"] = "acp-live-discovery"
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
