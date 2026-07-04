package agentruntime

import (
	"encoding/json"
	"strconv"
	"strings"
)

type acpLiveState struct {
	currentMode             string
	availableCommands       []AgentSessionCommand
	commandsKnown           bool
	configOptions           map[string]any
	configOptionDescriptors []map[string]any
	usage                   acpUsageState
	goal                    map[string]any
}

type acpLiveStateSnapshot struct {
	currentMode             string
	availableCommands       []AgentSessionCommand
	configOptions           map[string]any
	configOptionDescriptors []map[string]any
	usage                   acpUsageState
	goal                    map[string]any
}

type acpUsageState struct {
	contextUsedTokens   int64
	contextWindowTokens int64
	contextKnown        bool
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
		usage:                   state.usage,
		goal:                    clonePayload(state.goal),
	}
}

func acpUsageRuntimeContext(usage acpUsageState) map[string]any {
	if !usage.contextKnown && len(usage.quotas) == 0 {
		return nil
	}
	result := map[string]any{}
	if usage.contextKnown {
		result["contextWindow"] = map[string]any{
			"usedTokens":  usage.contextUsedTokens,
			"totalTokens": usage.contextWindowTokens,
		}
	}
	if len(usage.quotas) > 0 {
		result["quotas"] = cloneACPUsageQuotas(usage.quotas)
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
	}
	if !merged.contextKnown && previous.contextKnown {
		merged.contextKnown = true
		merged.contextUsedTokens = previous.contextUsedTokens
		merged.contextWindowTokens = previous.contextWindowTokens
	}
	if len(merged.quotas) == 0 && len(previous.quotas) > 0 {
		merged.quotas = cloneACPUsageQuotas(previous.quotas)
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
	used, usedOK := firstACPInt64(context,
		"usedTokens",
		"used_tokens",
		"tokensUsed",
		"tokens_used",
		"currentTokens",
		"current_tokens",
		"used",
		"current",
	)
	total, totalOK := firstACPInt64(context,
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
	if !usedOK || !totalOK {
		quotas := acpUsageQuotasValue(update)
		if len(quotas) == 0 {
			return acpUsageState{}, false
		}
		return acpUsageState{quotas: quotas}, true
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
		contextKnown:        true,
		quotas:              acpUsageQuotasValue(update),
	}, true
}

func acpUsageQuotasValue(update map[string]any) []map[string]any {
	meta, _ := update["_meta"].(map[string]any)
	if len(meta) == 0 {
		return nil
	}
	rateLimit, _ := meta["_claude/rateLimit"].(map[string]any)
	if len(rateLimit) == 0 {
		return nil
	}
	quotaType, modelName := acpClaudeRateLimitQuotaType(asString(rateLimit["rate_limit_type"]))
	if quotaType == "" {
		return nil
	}
	utilization, ok := acpFloatValue(rateLimit["utilization"])
	if !ok {
		return nil
	}
	usedPercent := utilization
	if usedPercent <= 1 {
		usedPercent *= 100
	}
	if usedPercent < 0 {
		usedPercent = 0
	}
	if usedPercent > 100 {
		usedPercent = 100
	}
	quota := map[string]any{
		"quotaType":        quotaType,
		"percentRemaining": 100 - usedPercent,
	}
	if modelName != "" {
		quota["modelName"] = modelName
	}
	if resetsAt, ok := acpInt64Value(rateLimit["resets_at"]); ok && resetsAt > 0 {
		quota["resetsAtUnixMs"] = resetsAt * 1000
	}
	return []map[string]any{quota}
}

func acpClaudeRateLimitQuotaType(rateLimitType string) (string, string) {
	switch strings.TrimSpace(strings.ToLower(rateLimitType)) {
	case "five_hour":
		return "session", ""
	case "seven_day":
		return "weekly", ""
	case "seven_day_sonnet":
		return "model", "Sonnet"
	case "seven_day_opus":
		return "model", "Opus"
	case "overage":
		return "cost", ""
	default:
		return "", ""
	}
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

func cloneACPUsageQuotas(quotas []map[string]any) []map[string]any {
	if len(quotas) == 0 {
		return nil
	}
	cloned := make([]map[string]any, 0, len(quotas))
	for _, quota := range quotas {
		cloned = append(cloned, clonePayload(quota))
	}
	return cloned
}

func firstACPInt64(source map[string]any, keys ...string) (int64, bool) {
	for _, key := range keys {
		if value, ok := source[key]; ok {
			if parsed, ok := acpInt64Value(value); ok {
				return parsed, true
			}
		}
	}
	return 0, false
}

func acpInt64Value(value any) (int64, bool) {
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
	); reasoning != "" {
		settings.ReasoningEffort = reasoning
		hasSettings = true
	}
	if speed := firstNonEmpty(
		asString(config["service_tier"]),
		asString(config["speed"]),
		asString(config["fast"]),
	); speed != "" {
		if strings.TrimSpace(provider) == ProviderClaudeCode {
			speed = claudeCodeSpeedFromACPFastConfigValue(speed)
		}
		settings.Speed = speed
		hasSettings = true
	}
	if !hasSettings {
		return nil
	}
	return cloneSessionSettings(settings)
}
