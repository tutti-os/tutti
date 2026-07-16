package agentruntime

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

type acpLiveState struct {
	currentMode             string
	availableCommands       []AgentSessionCommand
	commandsKnown           bool
	configOptions           map[string]any
	configOptionDescriptors []map[string]any
	modelsAPI               bool
	usage                   acpUsageState
	goal                    map[string]any
}

type acpLiveStateSnapshot struct {
	currentMode             string
	availableCommands       []AgentSessionCommand
	configOptions           map[string]any
	configOptionDescriptors []map[string]any
	modelsAPI               bool
	usage                   acpUsageState
	goal                    map[string]any
}

type acpUsageState struct {
	contextUsedTokens   int64
	contextWindowTokens int64
	contextKnown        bool
	contextModel        string
	tokens              runtimeTokenUsage
	quotas              []map[string]any
}

func newACPLiveState() acpLiveState {
	return acpLiveState{
		configOptions: map[string]any{},
	}
}

func (s *acpLiveState) ensureInitialized() {
	if s == nil {
		return
	}
	if s.configOptions == nil {
		s.configOptions = map[string]any{}
	}
}

func cloneACPLiveState(state acpLiveState) acpLiveState {
	cloned := acpLiveState{
		currentMode:             strings.TrimSpace(state.currentMode),
		availableCommands:       cloneAgentSessionCommands(state.availableCommands),
		commandsKnown:           state.commandsKnown,
		configOptionDescriptors: cloneConfigOptionDescriptors(state.configOptionDescriptors),
		modelsAPI:               state.modelsAPI,
		usage:                   state.usage,
		goal:                    clonePayload(state.goal),
	}
	if len(state.configOptions) > 0 {
		cloned.configOptions = clonePayload(state.configOptions)
	} else {
		cloned.configOptions = map[string]any{}
	}
	return cloned
}

func snapshotACPLiveState(state acpLiveState) acpLiveStateSnapshot {
	return acpLiveStateSnapshot{
		currentMode:             strings.TrimSpace(state.currentMode),
		availableCommands:       cloneAgentSessionCommands(state.availableCommands),
		configOptions:           clonePayload(state.configOptions),
		configOptionDescriptors: cloneConfigOptionDescriptors(state.configOptionDescriptors),
		modelsAPI:               state.modelsAPI,
		usage:                   state.usage,
		goal:                    clonePayload(state.goal),
	}
}

func acpUsageRuntimeContext(usage acpUsageState) map[string]any {
	if !usage.contextKnown && !usage.tokens.known && len(usage.quotas) == 0 {
		return nil
	}
	result := usage.tokens.runtimeContextFields()
	if result == nil {
		result = map[string]any{}
	}
	if usage.contextKnown {
		result["contextWindow"] = map[string]any{
			"usedTokens":  usage.contextUsedTokens,
			"totalTokens": usage.contextWindowTokens,
		}
	}
	if len(usage.quotas) > 0 {
		result["quotas"] = cloneUsageQuotas(usage.quotas)
	}
	return result
}

func commandSnapshotFromACPLiveState(
	agentSessionID string,
	state acpLiveState,
) (AgentSessionCommandSnapshot, bool) {
	if !state.commandsKnown {
		return AgentSessionCommandSnapshot{}, false
	}
	return AgentSessionCommandSnapshot{
		AgentSessionID: strings.TrimSpace(agentSessionID),
		Commands:       cloneAgentSessionCommands(state.availableCommands),
	}, true
}

func applyACPUpdateToLiveState(
	state *acpLiveState,
	agentSessionID string,
	raw json.RawMessage,
) *AgentSessionCommandSnapshot {
	if state == nil {
		return nil
	}
	var params struct {
		Update map[string]any `json:"update"`
	}
	if err := json.Unmarshal(raw, &params); err != nil || params.Update == nil {
		return nil
	}
	updateType := strings.TrimSpace(asString(params.Update["sessionUpdate"]))
	state.ensureInitialized()
	switch updateType {
	case "current_mode_update":
		if mode := acpModeValue(params.Update); mode != "" {
			state.currentMode = mode
		}
	case "available_commands_update":
		if commands, ok := acpCommandsValue(params.Update); ok {
			state.availableCommands = commands
			state.commandsKnown = true
			snapshot, _ := commandSnapshotFromACPLiveState(agentSessionID, *state)
			return &snapshot
		}
	case "config_option_update":
		if descriptors := acpConfigOptionDescriptorsFromUpdate(params.Update); len(descriptors) > 0 {
			applyACPConfigOptionDescriptors(state, descriptors)
		}
		for key, value := range acpConfigValues(params.Update) {
			state.configOptions[key] = value
			updateConfigOptionDescriptorValue(state.configOptionDescriptors, key, value)
		}
	case "usage_update":
		if usage, ok := acpUsageValue(params.Update); ok {
			state.usage = mergeACPUsageState(state.usage, usage)
		}
	case "thread_goal_update":
		if goal := payloadObject(params.Update["goal"]); len(goal) > 0 {
			state.goal = clonePayload(goal)
		}
	case "thread_goal_clear", "thread_goal_cleared":
		state.goal = nil
	}
	return nil
}

func mergeACPUsageState(previous acpUsageState, next acpUsageState) acpUsageState {
	merged := next
	if merged.contextKnown &&
		merged.contextWindowTokens <= 0 &&
		previous.contextKnown &&
		previous.contextWindowTokens > 0 {
		merged.contextWindowTokens = previous.contextWindowTokens
		merged.contextModel = previous.contextModel
	}
	if !merged.contextKnown && previous.contextKnown {
		merged.contextKnown = true
		merged.contextUsedTokens = previous.contextUsedTokens
		merged.contextWindowTokens = previous.contextWindowTokens
		merged.contextModel = previous.contextModel
	}
	if len(merged.quotas) == 0 && len(previous.quotas) > 0 {
		merged.quotas = cloneUsageQuotas(previous.quotas)
	}
	if !merged.tokens.known && previous.tokens.known {
		merged.tokens = previous.tokens
	}
	return merged
}

func acpUsageValue(update map[string]any) (acpUsageState, bool) {
	if len(update) == 0 {
		return acpUsageState{}, false
	}
	context := update
	for _, key := range []string{"contextWindow", "context_window", "context"} {
		if nested, ok := update[key].(map[string]any); ok {
			context = nested
			break
		}
	}
	used, usedOK := firstInt64Value(context,
		"usedTokens",
		"used_tokens",
		"tokensUsed",
		"tokens_used",
		"currentTokens",
		"current_tokens",
		"used",
		"current",
	)
	total, totalOK := firstInt64Value(context,
		"totalTokens",
		"total_tokens",
		"windowTokens",
		"window_tokens",
		"contextWindowTokens",
		"context_window_tokens",
		"modelContextWindow",
		"model_context_window",
		"size",
		"limit",
		"max",
	)
	tokens := runtimeTokenUsageFromPayload(update)
	if (!usedOK || !totalOK) && !tokens.known {
		return acpUsageState{}, false
	}
	if used < 0 {
		used = 0
	}
	if total < 0 {
		total = 0
	}
	return acpUsageState{
		contextUsedTokens:   used,
		contextWindowTokens: total,
		contextKnown:        usedOK && totalOK,
		tokens:              tokens,
	}, true
}

func acpFloatValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		if err == nil {
			return parsed, true
		}
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err == nil {
			return parsed, true
		}
	}
	return 0, false
}

func cloneUsageQuotas(quotas []map[string]any) []map[string]any {
	if len(quotas) == 0 {
		return nil
	}
	cloned := make([]map[string]any, 0, len(quotas))
	for _, quota := range quotas {
		cloned = append(cloned, clonePayload(quota))
	}
	return cloned
}

func firstInt64Value(source map[string]any, keys ...string) (int64, bool) {
	for _, key := range keys {
		if value, ok := source[key]; ok {
			if parsed, ok := int64Value(value); ok {
				return parsed, true
			}
		}
	}
	return 0, false
}

func int64Value(value any) (int64, bool) {
	switch typed := value.(type) {
	case int:
		return int64(typed), true
	case int8:
		return int64(typed), true
	case int16:
		return int64(typed), true
	case int32:
		return int64(typed), true
	case int64:
		return typed, true
	case uint:
		return int64(typed), true
	case uint8:
		return int64(typed), true
	case uint16:
		return int64(typed), true
	case uint32:
		return int64(typed), true
	case uint64:
		if typed > uint64(^uint64(0)>>1) {
			return 0, false
		}
		return int64(typed), true
	case float32:
		return int64(typed), true
	case float64:
		return int64(typed), true
	case json.Number:
		if parsed, err := typed.Int64(); err == nil {
			return parsed, true
		}
		if parsed, err := strconv.ParseFloat(typed.String(), 64); err == nil {
			return int64(parsed), true
		}
		return 0, false
	case string:
		raw := strings.TrimSpace(typed)
		if raw == "" {
			return 0, false
		}
		if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil {
			return parsed, true
		}
		if parsed, err := strconv.ParseFloat(raw, 64); err == nil {
			return int64(parsed), true
		}
		return 0, false
	default:
		return 0, false
	}
}

func acpConfigOptionsUpdateKey(raw json.RawMessage) (string, bool) {
	var params struct {
		Update map[string]any `json:"update"`
	}
	if err := json.Unmarshal(raw, &params); err != nil || params.Update == nil {
		return "", false
	}
	if strings.TrimSpace(asString(params.Update["sessionUpdate"])) != "config_option_update" {
		return "", false
	}
	return strings.TrimSpace(asString(params.Update["key"])), true
}

func applyACPConfigOptionsResult(state *acpLiveState, raw json.RawMessage) {
	if state == nil || len(raw) == 0 {
		return
	}
	var payload struct {
		ConfigOptions []map[string]any `json:"configOptions"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || len(payload.ConfigOptions) == 0 {
		return
	}
	applyACPConfigOptionDescriptors(state, payload.ConfigOptions)
}

func applyACPModelsResult(state *acpLiveState, raw json.RawMessage) {
	if state == nil || len(raw) == 0 {
		return
	}
	var payload struct {
		Models *struct {
			AvailableModels []struct {
				Description string `json:"description"`
				ModelID     string `json:"modelId"`
				Name        string `json:"name"`
			} `json:"availableModels"`
			CurrentModelID string `json:"currentModelId"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.Models == nil {
		return
	}
	state.modelsAPI = true
	options := make([]any, 0, len(payload.Models.AvailableModels))
	for _, model := range payload.Models.AvailableModels {
		modelID := strings.TrimSpace(model.ModelID)
		if modelID == "" {
			continue
		}
		label := strings.TrimSpace(model.Name)
		if label == "" {
			label = modelID
		}
		option := map[string]any{"value": modelID, "label": label}
		if description := strings.TrimSpace(model.Description); description != "" {
			option["description"] = description
		}
		options = append(options, option)
	}
	if len(options) == 0 {
		return
	}
	descriptor := map[string]any{
		"id":           "model",
		"name":         "Model",
		"currentValue": strings.TrimSpace(payload.Models.CurrentModelID),
		"options":      options,
	}
	descriptors := cloneConfigOptionDescriptors(state.configOptionDescriptors)
	replaced := false
	for index := range descriptors {
		if strings.TrimSpace(asString(descriptors[index]["id"])) == "model" {
			descriptors[index] = descriptor
			replaced = true
			break
		}
	}
	if !replaced {
		descriptors = append(descriptors, descriptor)
	}
	applyACPConfigOptionDescriptors(state, descriptors)
}

func applyACPModesResult(state *acpLiveState, raw json.RawMessage) {
	if state == nil || len(raw) == 0 {
		return
	}
	var payload struct {
		Modes *struct {
			AvailableModes []struct {
				Description string `json:"description"`
				ID          string `json:"id"`
				Name        string `json:"name"`
			} `json:"availableModes"`
			CurrentModeID string `json:"currentModeId"`
		} `json:"modes"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.Modes == nil {
		return
	}
	options := make([]any, 0, len(payload.Modes.AvailableModes))
	for _, mode := range payload.Modes.AvailableModes {
		id := strings.TrimSpace(mode.ID)
		if id == "" {
			continue
		}
		label := strings.TrimSpace(mode.Name)
		if label == "" {
			label = id
		}
		option := map[string]any{"value": id, "label": label}
		if description := strings.TrimSpace(mode.Description); description != "" {
			option["description"] = description
		}
		options = append(options, option)
	}
	if len(options) == 0 {
		return
	}
	current := strings.TrimSpace(payload.Modes.CurrentModeID)
	descriptor := map[string]any{
		"id":           "mode",
		"name":         "Mode",
		"currentValue": current,
		"options":      options,
	}
	descriptors := cloneConfigOptionDescriptors(state.configOptionDescriptors)
	replaced := false
	for index := range descriptors {
		if strings.TrimSpace(asString(descriptors[index]["id"])) == "mode" {
			descriptors[index] = descriptor
			replaced = true
			break
		}
	}
	if !replaced {
		descriptors = append(descriptors, descriptor)
	}
	applyACPConfigOptionDescriptors(state, descriptors)
	if current != "" {
		state.currentMode = current
	}
}

func applyACPConfigOptionDescriptors(state *acpLiveState, descriptors []map[string]any) {
	if state == nil || len(descriptors) == 0 {
		return
	}
	state.ensureInitialized()
	state.configOptionDescriptors = cloneConfigOptionDescriptors(descriptors)
	previousValues := clonePayload(state.configOptions)
	nextValues := make(map[string]any, len(descriptors))
	for _, option := range descriptors {
		id := strings.TrimSpace(asString(option["id"]))
		if id == "" {
			continue
		}
		if value, ok := configOptionCurrentValue(option); ok {
			nextValues[id] = value
		} else if value, ok := previousValues[id]; ok {
			nextValues[id] = value
		}
	}
	state.configOptions = nextValues
}

func acpConfigOptionDescriptorsFromUpdate(update map[string]any) []map[string]any {
	for _, key := range []string{"configOptions", "config_options"} {
		if descriptors := configOptionDescriptors(update[key]); len(descriptors) > 0 {
			return descriptors
		}
	}
	return nil
}

func configOptionDescriptors(value any) []map[string]any {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return nil
	}
	descriptors := make([]map[string]any, 0, len(items))
	for _, item := range items {
		option, ok := item.(map[string]any)
		if !ok || strings.TrimSpace(asString(option["id"])) == "" {
			continue
		}
		descriptors = append(descriptors, clonePayloadDeep(option))
	}
	return descriptors
}

func configOptionCurrentValue(option map[string]any) (any, bool) {
	for _, key := range []string{"currentValue", "current_value", "value"} {
		if value, ok := option[key]; ok {
			return clonePayloadValue(value), true
		}
	}
	return nil, false
}

func updateConfigOptionDescriptorValue(descriptors []map[string]any, configID string, value any) {
	configID = strings.TrimSpace(configID)
	if configID == "" {
		return
	}
	for _, option := range descriptors {
		if strings.TrimSpace(asString(option["id"])) == configID {
			option["currentValue"] = clonePayloadValue(value)
			return
		}
	}
}

func acpConfigOptionMatches(state acpLiveState, configID string, value string) bool {
	configID = strings.TrimSpace(configID)
	if configID == "" {
		return false
	}
	got, ok := state.configOptions[configID]
	return ok && strings.TrimSpace(asString(got)) == strings.TrimSpace(value)
}

// acpConfigOptionAdvertisesValue reports whether the live agent has advertised
// value as a selectable option for configID (e.g. a concrete model id in the
// "model" option). It lets callers accept any value the running agent will
// actually honor, instead of relying on a hardcoded alias list.
func acpConfigOptionAdvertisesValue(state acpLiveState, configID string, value string) bool {
	configID = strings.TrimSpace(configID)
	value = strings.TrimSpace(value)
	if configID == "" || value == "" {
		return false
	}
	for _, descriptor := range state.configOptionDescriptors {
		if strings.TrimSpace(asString(descriptor["id"])) != configID {
			continue
		}
		for _, option := range configOptionEntries(descriptor["options"]) {
			if strings.TrimSpace(asString(option["value"])) == value {
				return true
			}
		}
	}
	return false
}

func configOptionEntries(options any) []map[string]any {
	switch items := options.(type) {
	case []map[string]any:
		return items
	case []any:
		out := make([]map[string]any, 0, len(items))
		for _, item := range items {
			if option, ok := item.(map[string]any); ok {
				out = append(out, option)
			}
		}
		return out
	default:
		return nil
	}
}

func cloneConfigOptionDescriptors(descriptors []map[string]any) []map[string]any {
	if len(descriptors) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(descriptors))
	for _, option := range descriptors {
		if len(option) == 0 {
			continue
		}
		out = append(out, clonePayloadDeep(option))
	}
	return out
}

func canonicalACPConfigForRuntimeContext(config map[string]any) map[string]any {
	if len(config) == 0 {
		return nil
	}
	out := make(map[string]any, len(config))
	keys := make([]string, 0, len(config))
	for key := range config {
		keys = append(keys, key)
	}
	sort.SliceStable(keys, func(i, j int) bool {
		leftPriority := acpConfigOptionCanonicalPriority(keys[i])
		rightPriority := acpConfigOptionCanonicalPriority(keys[j])
		if leftPriority != rightPriority {
			return leftPriority < rightPriority
		}
		return keys[i] < keys[j]
	})
	for _, key := range keys {
		value := config[key]
		canonicalKey := canonicalACPConfigOptionID(key)
		if _, exists := out[canonicalKey]; exists {
			continue
		}
		out[canonicalKey] = clonePayloadValue(value)
	}
	return out
}

func canonicalACPConfigOptionDescriptorsForRuntimeContext(descriptors []map[string]any) []map[string]any {
	if len(descriptors) == 0 {
		return nil
	}
	type selectedDescriptor struct {
		descriptor map[string]any
		index      int
		priority   int
	}
	selected := map[string]selectedDescriptor{}
	for _, descriptor := range descriptors {
		if len(descriptor) == 0 {
			continue
		}
		cloned := clonePayloadDeep(descriptor)
		rawID := strings.TrimSpace(asString(cloned["id"]))
		canonicalID := canonicalACPConfigOptionID(rawID)
		if canonicalID == "" {
			continue
		}
		priority := acpConfigOptionCanonicalPriority(rawID)
		index := len(selected)
		if previous, ok := selected[canonicalID]; ok {
			if previous.priority <= priority {
				continue
			}
			index = previous.index
		}
		cloned["id"] = canonicalID
		if rawID != "" && rawID != canonicalID {
			cloned["runtimeId"] = rawID
		}
		selected[canonicalID] = selectedDescriptor{
			descriptor: cloned,
			index:      index,
			priority:   priority,
		}
	}
	values := make([]selectedDescriptor, 0, len(selected))
	for _, value := range selected {
		values = append(values, value)
	}
	sort.SliceStable(values, func(i, j int) bool {
		if values[i].index != values[j].index {
			return values[i].index < values[j].index
		}
		return asString(values[i].descriptor["id"]) < asString(values[j].descriptor["id"])
	})
	out := make([]map[string]any, 0, len(values))
	for _, value := range values {
		out = append(out, value.descriptor)
	}
	return out
}

func acpConfigOptionCanonicalPriority(id string) int {
	switch strings.TrimSpace(id) {
	case "reasoning_effort":
		return 0
	case "model_reasoning_effort":
		return 1
	case "effort":
		return 2
	case "thought_level":
		return 3
	default:
		return 0
	}
}

func canonicalACPConfigOptionID(id string) string {
	id = strings.TrimSpace(id)
	switch id {
	case "model_reasoning_effort", "effort", "thought_level":
		return "reasoning_effort"
	default:
		return id
	}
}

func sessionSettingsWithACPConfig(
	base *SessionSettings,
	provider string,
	defaultPermissionModeID string,
	config map[string]any,
	allowModelOverride bool,
) *SessionSettings {
	settings := normalizeSessionSettings(base, provider, defaultPermissionModeID)
	hasSettings := base != nil
	if model := asString(config["model"]); model != "" && allowModelOverride {
		settings.Model = model
		hasSettings = true
	}
	if reasoning := firstNonEmpty(
		asString(config["reasoning_effort"]),
		asString(config["model_reasoning_effort"]),
		asString(config["effort"]),
		asString(config["thought_level"]),
	); reasoning != "" {
		settings.ReasoningEffort = reasoning
		hasSettings = true
	}
	if speed := firstNonEmpty(
		asString(config["service_tier"]),
		asString(config["speed"]),
		asString(config["fast"]),
	); speed != "" {
		settings.Speed = speed
		hasSettings = true
	}
	if !hasSettings {
		return nil
	}
	return cloneSessionSettings(settings)
}

func acpLiveStateReasoningConfigOptionID(state acpLiveStateSnapshot) string {
	supported := make(map[string]bool, len(state.configOptionDescriptors))
	for _, descriptor := range state.configOptionDescriptors {
		if id := strings.TrimSpace(asString(descriptor["id"])); id != "" {
			supported[id] = true
		}
	}
	if len(supported) == 0 {
		for id := range state.configOptions {
			supported[id] = true
		}
	}
	return acpReasoningConfigOptionID(supported)
}
