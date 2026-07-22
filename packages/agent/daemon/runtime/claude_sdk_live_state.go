package agentruntime

import (
	"log/slog"
	"sort"
	"strings"
)

type claudeSDKLiveState struct {
	availableCommands       []AgentSessionCommand
	commandsKnown           bool
	configOptions           map[string]any
	configOptionDescriptors []map[string]any
	usage                   claudeSDKUsageState
	goal                    map[string]any
}

type claudeSDKUsageState struct {
	contextUsedTokens   int64
	contextWindowTokens int64
	contextKnown        bool
	contextModel        string
	quotas              []map[string]any
}

func newClaudeSDKLiveState() claudeSDKLiveState {
	return claudeSDKLiveState{
		availableCommands: claudeSDKDefaultCommands(),
		commandsKnown:     true,
		configOptions:     map[string]any{},
	}
}

func (s *claudeSDKLiveState) ensureInitialized() {
	if s != nil && s.configOptions == nil {
		s.configOptions = map[string]any{}
	}
}

func claudeSDKCommandSnapshot(agentSessionID string, state claudeSDKLiveState) AgentSessionCommandSnapshot {
	return AgentSessionCommandSnapshot{
		AgentSessionID: strings.TrimSpace(agentSessionID),
		Commands:       cloneAgentSessionCommands(state.availableCommands),
	}
}

func applyClaudeSDKConfigOptionDescriptors(state *claudeSDKLiveState, descriptors []map[string]any) {
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

func claudeSDKUsageStateFromPayload(update map[string]any) (claudeSDKUsageState, bool) {
	if len(update) == 0 {
		return claudeSDKUsageState{}, false
	}
	context := update
	for _, key := range []string{"contextWindow", "context_window", "context"} {
		if nested, ok := update[key].(map[string]any); ok {
			context = nested
			break
		}
	}
	used, usedOK := firstInt64Value(context, "usedTokens", "used_tokens", "tokensUsed", "tokens_used", "currentTokens", "current_tokens", "used", "current")
	total, totalOK := firstInt64Value(context, "totalTokens", "total_tokens", "windowTokens", "window_tokens", "contextWindowTokens", "context_window_tokens", "modelContextWindow", "model_context_window", "size", "limit", "max")
	if !usedOK || !totalOK {
		return claudeSDKUsageState{}, false
	}
	if used < 0 {
		used = 0
	}
	if total < 0 {
		total = 0
	}
	return claudeSDKUsageState{
		contextUsedTokens:   used,
		contextWindowTokens: total,
		contextKnown:        true,
	}, true
}

func mergeClaudeSDKUsageState(previous claudeSDKUsageState, next claudeSDKUsageState) claudeSDKUsageState {
	merged := next
	if merged.contextKnown && merged.contextWindowTokens <= 0 && previous.contextKnown && previous.contextWindowTokens > 0 {
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
	return merged
}

func claudeSDKUsageRuntimeContext(usage claudeSDKUsageState) map[string]any {
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
		result["quotas"] = cloneUsageQuotas(usage.quotas)
	}
	return result
}

func claudeSDKConfigOptionMatches(state claudeSDKLiveState, configID string, value string) bool {
	if state.configOptions == nil {
		return false
	}
	current, ok := state.configOptions[configID]
	return ok && strings.TrimSpace(asString(current)) == strings.TrimSpace(value)
}

func claudeSDKDefaultCommands() []AgentSessionCommand {
	return []AgentSessionCommand{
		{Name: "compact"},
		{Name: "status"},
		{Name: "fast"},
		{Name: "goal"},
		{Name: "review"},
	}
}

func claudeSDKCommandsFromPayload(payload map[string]any) ([]AgentSessionCommand, bool) {
	commands := make([]AgentSessionCommand, 0)
	found := false
	entryCount := 0
	for _, key := range []string{"commands", "availableCommands", "available_commands"} {
		values, ok := payload[key].([]any)
		if !ok {
			continue
		}
		found = true
		entryCount += len(values)
		for _, value := range values {
			command := AgentSessionCommand{}
			switch typed := value.(type) {
			case string:
				command.Name = typed
			case map[string]any:
				command.Name = firstNonEmpty(asString(typed["name"]), asString(typed["id"]), asString(typed["command"]))
				command.Description = firstNonEmpty(asString(typed["description"]), asString(typed["summary"]))
				command.InputHint = firstNonEmpty(asString(typed["inputHint"]), asString(typed["input_hint"]), asString(typed["hint"]))
				if command.InputHint == "" {
					input := payloadObject(typed["input"])
					command.InputHint = firstNonEmpty(asString(input["hint"]), asString(input["inputHint"]), asString(input["input_hint"]))
				}
			}
			if command.Name = strings.TrimSpace(command.Name); command.Name != "" {
				commands = append(commands, command)
			}
		}
	}
	if !found || entryCount > 0 && len(commands) == 0 {
		return nil, false
	}
	return dedupeAgentSessionCommands(commands), true
}

func (s *claudeSDKAdapterSession) commandSnapshot(agentSessionID string) (AgentSessionCommandSnapshot, bool) {
	if s == nil {
		return AgentSessionCommandSnapshot{}, false
	}
	if !s.liveState.commandsKnown {
		return AgentSessionCommandSnapshot{}, false
	}
	return claudeSDKCommandSnapshot(agentSessionID, s.liveState), true
}

func (s *claudeSDKAdapterSession) applyCommandsUpdated(agentSessionID string, payload map[string]any) bool {
	if s == nil {
		return false
	}
	commands, ok := claudeSDKCommandsFromPayload(payload)
	if !ok {
		return false
	}
	s.liveState.availableCommands = commands
	s.liveState.commandsKnown = true
	_ = agentSessionID
	return true
}

func (s *claudeSDKAdapterSession) applyUsageUpdated(payload map[string]any) bool {
	if s == nil {
		return false
	}
	previous := s.liveState.usage
	contextModel := s.currentUsageModel(payload)
	update := claudeSDKUsageUpdate(payload, previous, contextModel)
	if len(update) == 0 {
		s.logUsageUpdate(payload, update, previous, claudeSDKUsageState{}, contextModel, false, "empty_normalized_update")
		return false
	}
	if usage, ok := claudeSDKUsageStateFromPayload(update); ok {
		if usage.contextKnown {
			usage.contextModel = contextModel
		}
		s.liveState.usage = mergeClaudeSDKUsageState(previous, usage)
		s.logUsageUpdate(payload, update, previous, s.liveState.usage, contextModel, true, "")
		return true
	}
	s.logUsageUpdate(payload, update, previous, claudeSDKUsageState{}, contextModel, false, "invalid_normalized_update")
	return false
}

func (s *claudeSDKAdapterSession) logUsageUpdate(
	payload map[string]any,
	update map[string]any,
	previous claudeSDKUsageState,
	current claudeSDKUsageState,
	contextModel string,
	applied bool,
	reason string,
) {
	if s == nil {
		return
	}
	session := s.session
	payloadUsage := payloadMap(payload, "usage")
	contextWindow := payloadMap(payload, "contextWindow")
	payloadKind := "direct"
	switch {
	case len(payload) == 0:
		payloadKind = "empty"
	case len(contextWindow) > 0:
		payloadKind = "context_window"
	case len(payloadUsage) > 0:
		payloadKind = "usage"
	}
	usageSource := payload
	if len(payloadUsage) > 0 {
		usageSource = payloadUsage
	}
	normalizedContext := payloadMap(update, "contextWindow")
	rawContextSource := payload
	if len(contextWindow) > 0 {
		rawContextSource = contextWindow
	}
	rawUsed, _ := firstInt64Value(rawContextSource, "usedTokens", "used_tokens", "used", "totalTokens", "total_tokens", "total")
	rawTotal := claudeSDKContextWindowTokens(payload, contextModel)
	if rawTotal <= 0 {
		rawTotal = claudeSDKContextWindowTokens(usageSource, contextModel)
	}
	rawInput, _ := firstInt64Value(usageSource, "input_tokens", "inputTokens")
	rawOutput, _ := firstInt64Value(usageSource, "output_tokens", "outputTokens")
	rawCacheRead, _ := firstInt64Value(usageSource, "cache_read_input_tokens", "cacheReadInputTokens")
	rawCacheCreate, _ := firstInt64Value(usageSource, "cache_creation_input_tokens", "cacheCreationInputTokens")
	normalizedUsed, _ := firstInt64Value(normalizedContext, "usedTokens", "used_tokens")
	normalizedTotal, _ := firstInt64Value(normalizedContext, "totalTokens", "total_tokens")
	slog.Info("agent session Claude SDK usage update",
		"event", "agent_session.claude_sdk.usage_update",
		"provider", ProviderClaudeCode,
		"adapter", claudeSDKSidecarAdapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", firstNonEmpty(strings.TrimSpace(s.providerSessionID), strings.TrimSpace(session.ProviderSessionID)),
		"turn_id", payloadString(payload, "turnId"),
		"payload_kind", payloadKind,
		"payload_keys", sortedPayloadKeys(payload),
		"usage_keys", sortedPayloadKeys(usageSource),
		"raw_used_tokens", rawUsed,
		"raw_total_tokens", rawTotal,
		"raw_input_tokens", rawInput,
		"raw_output_tokens", rawOutput,
		"raw_cache_read_input_tokens", rawCacheRead,
		"raw_cache_creation_input_tokens", rawCacheCreate,
		"normalized_used_tokens", normalizedUsed,
		"normalized_total_tokens", normalizedTotal,
		"previous_context_known", previous.contextKnown,
		"previous_used_tokens", previous.contextUsedTokens,
		"previous_total_tokens", previous.contextWindowTokens,
		"previous_context_model", previous.contextModel,
		"current_context_known", current.contextKnown,
		"current_used_tokens", current.contextUsedTokens,
		"current_total_tokens", current.contextWindowTokens,
		"current_context_model", current.contextModel,
		"applied", applied,
		"reason", strings.TrimSpace(reason),
	)
}

func sortedPayloadKeys(payload map[string]any) []string {
	if len(payload) == 0 {
		return nil
	}
	keys := make([]string, 0, len(payload))
	for key := range payload {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (s *claudeSDKAdapterSession) currentUsageModel(payload map[string]any) string {
	if s == nil {
		return ""
	}
	if model := claudeSDKCanonicalModel(payloadString(payload, "model")); model != "" {
		return model
	}
	if model := claudeSDKCanonicalModel(asString(s.liveState.configOptions["model"])); model != "" {
		return model
	}
	return claudeSDKCanonicalModel(s.session.SettingsValue().Model)
}

func (s *claudeSDKAdapterSession) applySpeedUpdated(payload map[string]any) bool {
	if s == nil {
		return false
	}
	speed := claudeSDKCanonicalSpeed(payloadString(payload, "speed"))
	if speed == "" {
		speed = claudeSDKSpeedFromFastModeState(payloadString(payload, "state"))
	}
	if speed == "" {
		return false
	}
	return s.applySpeed(speed)
}

func (s *claudeSDKAdapterSession) applySpeed(speed string) bool {
	if s == nil {
		return false
	}
	speed = claudeSDKCanonicalSpeed(speed)
	if speed == "" {
		return false
	}
	s.liveState.ensureInitialized()
	if claudeSDKConfigOptionMatches(s.liveState, "fast", speed) {
		return false
	}
	s.liveState.configOptions["fast"] = speed
	updateConfigOptionDescriptorValue(s.liveState.configOptionDescriptors, "fast", speed)
	return true
}

func (s *claudeSDKAdapterSession) applySettingsPayload(payload map[string]any) bool {
	if s == nil {
		return false
	}
	changed := false
	if model, ok := payload["model"].(string); ok {
		previousModel := s.currentUsageModel(nil)
		modelChanged := s.applyConfigOption("model", strings.TrimSpace(model))
		if modelChanged {
			s.invalidateContextUsageForModelChange(previousModel, s.currentUsageModel(nil))
		}
		changed = modelChanged || changed
	}
	if effort, ok := payload["effort"].(string); ok {
		changed = s.applyConfigOption("effort", strings.TrimSpace(effort)) || changed
	}
	if speed, ok := payload["speed"].(string); ok {
		changed = s.applySpeed(speed) || changed
	}
	if mode, ok := payload["permissionMode"].(string); ok {
		changed = s.applyPermissionMode(mode) || changed
	}
	return changed
}

func (s *claudeSDKAdapterSession) invalidateContextUsageForModelChange(previousModel string, currentModel string) {
	if s == nil || claudeSDKCanonicalModel(previousModel) == claudeSDKCanonicalModel(currentModel) {
		return
	}
	s.liveState.usage.contextUsedTokens = 0
	s.liveState.usage.contextWindowTokens = 0
	s.liveState.usage.contextKnown = false
	s.liveState.usage.contextModel = ""
}

func (s *claudeSDKAdapterSession) applyPermissionMode(mode string) bool {
	mode = claudeSDKPermissionMode(mode)
	if s == nil || mode == "" {
		return false
	}
	return s.applyConfigOption("mode", mode)
}

func (s *claudeSDKAdapterSession) applyConfigOption(configID string, value string) bool {
	if s == nil || strings.TrimSpace(configID) == "" {
		return false
	}
	s.liveState.ensureInitialized()
	value = strings.TrimSpace(value)
	if claudeSDKConfigOptionMatches(s.liveState, configID, value) {
		return false
	}
	if value == "" {
		delete(s.liveState.configOptions, configID)
	} else {
		s.liveState.configOptions[configID] = value
	}
	updateConfigOptionDescriptorValue(s.liveState.configOptionDescriptors, configID, value)
	return true
}

func claudeSDKUsageUpdate(payload map[string]any, previous claudeSDKUsageState, contextModel string) map[string]any {
	if len(payload) == 0 {
		return nil
	}
	if contextWindow := payloadMap(payload, "contextWindow"); len(contextWindow) > 0 {
		if _, ok := firstInt64Value(contextWindow, "totalTokens", "total_tokens", "size", "limit", "max"); !ok {
			total := int64(0)
			if claudeSDKCanReusePreviousContextWindow(previous, contextModel) {
				total = previous.contextWindowTokens
			}
			if total <= 0 {
				total = claudeSDKAssumedContextWindow(contextModel)
			}
			contextWindow = clonePayload(contextWindow)
			contextWindow["totalTokens"] = total
		}
		return map[string]any{
			"sessionUpdate": "usage_update",
			"contextWindow": contextWindow,
		}
	}
	usage := payloadMap(payload, "usage")
	if len(usage) == 0 {
		usage = payload
	}
	used := claudeSDKUsageTokens(usage)
	if explicit, ok := firstInt64Value(payload, "usedTokens", "used_tokens", "used", "totalTokens", "total_tokens", "total"); ok {
		used = explicit
	}
	if used <= 0 {
		return nil
	}
	total := claudeSDKContextWindowTokens(payload, contextModel)
	if total <= 0 {
		total = claudeSDKContextWindowTokens(usage, contextModel)
	}
	if total <= 0 && claudeSDKCanReusePreviousContextWindow(previous, contextModel) {
		total = previous.contextWindowTokens
	}
	if total <= 0 {
		total = claudeSDKAssumedContextWindow(contextModel)
	}
	return map[string]any{
		"sessionUpdate": "usage_update",
		"contextWindow": map[string]any{
			"usedTokens":  used,
			"totalTokens": total,
		},
	}
}

// claudeSDKAssumedContextWindow picks the context-window size to assume when
// the Claude Agent SDK hasn't yet reported an authoritative per-model window
// for this turn (claudeSDKContextWindowTokens returns 0, e.g. every streamed
// usage delta before the turn's final "result" message carries modelUsage)
// and there's no matching previously-known window to carry forward
// (claudeSDKCanReusePreviousContextWindow). Model IDs/aliases across the
// Claude Code model aliases mark 1M-context variants with a "[1m]" suffix,
// including the built-in "sonnet[1m]" alias and user-configured aliases such
// as "claude-fable-5[1m]". Honor that
// convention here too, so a brand-new session/turn on a 1M-context model
// doesn't render the usage popover against the base 200k denominator for the
// entire duration of the turn.
func claudeSDKAssumedContextWindow(contextModel string) int64 {
	if strings.Contains(strings.ToLower(claudeSDKCanonicalModel(contextModel)), "[1m]") {
		return claudeSDK1MContextWindow
	}
	return claudeSDKDefaultContextWindow
}

func claudeSDKCanReusePreviousContextWindow(previous claudeSDKUsageState, contextModel string) bool {
	if !previous.contextKnown || previous.contextWindowTokens <= 0 {
		return false
	}
	contextModel = claudeSDKCanonicalModel(contextModel)
	previousModel := claudeSDKCanonicalModel(previous.contextModel)
	return previousModel == "" || contextModel == "" || previousModel == contextModel
}

func claudeSDKUsageTokens(usage map[string]any) int64 {
	if len(usage) == 0 {
		return 0
	}
	if iterations, ok := usage["iterations"].([]any); ok && len(iterations) > 0 {
		for index := len(iterations) - 1; index >= 0; index-- {
			if item, ok := iterations[index].(map[string]any); ok {
				if used := claudeSDKUsageTokens(item); used > 0 {
					return used
				}
			}
		}
	}
	if total, ok := firstInt64Value(usage, "total_tokens", "totalTokens", "total"); ok && total > 0 {
		return total
	}
	input, _ := firstInt64Value(usage, "input_tokens", "inputTokens")
	output, _ := firstInt64Value(usage, "output_tokens", "outputTokens")
	cacheRead, _ := firstInt64Value(usage, "cache_read_input_tokens", "cacheReadInputTokens")
	cacheCreate, _ := firstInt64Value(usage, "cache_creation_input_tokens", "cacheCreationInputTokens")
	return input + output + cacheRead + cacheCreate
}

func claudeSDKContextWindowTokens(payload map[string]any, contextModel string) int64 {
	if len(payload) == 0 {
		return 0
	}
	if total, ok := firstInt64Value(payload,
		"maxTokens",
		"max_tokens",
		"contextWindowTokens",
		"context_window_tokens",
		"contextWindow",
		"modelContextWindow",
		"model_context_window",
		"size",
		"limit",
		"max",
	); ok {
		return total
	}
	if total := claudeSDKContextWindowTokensFromValue(payload["modelUsage"], contextModel); total > 0 {
		return total
	}
	return 0
}

func claudeSDKContextWindowTokensFromValue(value any, contextModel string) int64 {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			if total := claudeSDKContextWindowTokensFromValue(item, contextModel); total > 0 {
				return total
			}
		}
	case []map[string]any:
		for _, item := range typed {
			if total := claudeSDKContextWindowTokens(item, contextModel); total > 0 {
				return total
			}
		}
	case map[string]any:
		if total := claudeSDKContextWindowTokens(typed, contextModel); total > 0 {
			return total
		}
		normalizedModel := strings.ToLower(strings.TrimSpace(claudeSDKCanonicalModel(contextModel)))
		keys := sortedPayloadKeys(typed)
		if normalizedModel != "" {
			for _, key := range keys {
				if !claudeSDKModelKeyMatchesNormalized(key, normalizedModel) {
					continue
				}
				if total := claudeSDKContextWindowTokensFromValue(typed[key], contextModel); total > 0 {
					return total
				}
			}
			return 0
		}
		if len(keys) == 1 {
			return claudeSDKContextWindowTokensFromValue(typed[keys[0]], contextModel)
		}
	}
	return 0
}

func claudeSDKModelKeyMatchesNormalized(key string, normalizedModel string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	if key == "" || normalizedModel == "" {
		return false
	}
	if key == normalizedModel {
		return true
	}
	key = strings.ReplaceAll(key, "[1m]", "")
	normalizedModel = strings.ReplaceAll(normalizedModel, "[1m]", "")
	return normalizedModel != "" && strings.Contains(key, normalizedModel)
}
