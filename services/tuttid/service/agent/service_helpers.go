package agent

import (
	"errors"
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const (
	runtimeConfigOptionIDReasoningEffort       = "reasoning_effort"
	runtimeConfigOptionIDLegacyReasoningEffort = "model_reasoning_effort"
	runtimeConfigOptionIDEffort                = "effort"
	runtimeContextAdapterClaudeAgentSDK        = "claude-agent-sdk"
	runtimeContextCapabilityImageInput         = "imageInput"
)

func cloneSessionMessages(messages []SessionMessage) []SessionMessage {
	if len(messages) == 0 {
		return nil
	}
	out := make([]SessionMessage, 0, len(messages))
	for _, message := range messages {
		out = append(out, SessionMessage{
			ID:                message.ID,
			AgentSessionID:    strings.TrimSpace(message.AgentSessionID),
			MessageID:         strings.TrimSpace(message.MessageID),
			TurnID:            strings.TrimSpace(message.TurnID),
			Role:              strings.TrimSpace(message.Role),
			Kind:              strings.TrimSpace(message.Kind),
			Status:            strings.TrimSpace(message.Status),
			Payload:           clonePayload(message.Payload),
			OccurredAtUnixMS:  message.OccurredAtUnixMS,
			StartedAtUnixMS:   message.StartedAtUnixMS,
			CompletedAtUnixMS: message.CompletedAtUnixMS,
			CreatedAtUnixMS:   message.CreatedAtUnixMS,
			UpdatedAtUnixMS:   message.UpdatedAtUnixMS,
			Version:           message.Version,
		})
	}
	return out
}

func cloneGeneratedFiles(files []GeneratedFile) []GeneratedFile {
	if len(files) == 0 {
		return []GeneratedFile{}
	}
	out := make([]GeneratedFile, 0, len(files))
	for _, file := range files {
		path := strings.TrimSpace(file.Path)
		if path == "" {
			continue
		}
		label := strings.TrimSpace(file.Label)
		if label == "" {
			label = path
		}
		out = append(out, GeneratedFile{
			Path:  path,
			Label: label,
		})
	}
	return out
}

func cloneSession(session Session) Session {
	cloned := session
	cloned.Settings = cloneComposerSettingsPointer(session.Settings)
	cloned.RuntimeContext = clonePayload(session.RuntimeContext)
	cloned.TurnLifecycle = cloneTurnLifecycle(session.TurnLifecycle)
	cloned.SubmitAvailability = cloneSubmitAvailability(session.SubmitAvailability)
	if session.Title != nil {
		title := *session.Title
		cloned.Title = &title
	}
	if session.UpdatedAt != nil {
		updatedAt := *session.UpdatedAt
		cloned.UpdatedAt = &updatedAt
	}
	if session.EndedAt != nil {
		endedAt := *session.EndedAt
		cloned.EndedAt = &endedAt
	}
	if session.LastError != nil {
		lastError := *session.LastError
		cloned.LastError = &lastError
	}
	return cloned
}

func cloneSubmitAvailability(value *SubmitAvailability) *SubmitAvailability {
	if value == nil {
		return nil
	}
	return &SubmitAvailability{
		State:  strings.TrimSpace(value.State),
		Reason: strings.TrimSpace(value.Reason),
	}
}

func cloneCompletedCommand(value *CompletedCommand) *CompletedCommand {
	if value == nil {
		return nil
	}
	return &CompletedCommand{
		Kind:   strings.TrimSpace(value.Kind),
		Status: strings.TrimSpace(value.Status),
	}
}

func cloneTurnLifecycle(value *TurnLifecycle) *TurnLifecycle {
	if value == nil {
		return nil
	}
	var activeTurnID *string
	if value.ActiveTurnID != nil {
		active := strings.TrimSpace(*value.ActiveTurnID)
		activeTurnID = &active
	}
	var outcome *string
	if value.Outcome != nil {
		next := strings.TrimSpace(*value.Outcome)
		outcome = &next
	}
	return &TurnLifecycle{
		ActiveTurnID:     activeTurnID,
		Phase:            strings.TrimSpace(value.Phase),
		Settling:         value.Settling,
		Outcome:          outcome,
		CompletedCommand: cloneCompletedCommand(value.CompletedCommand),
	}
}

func clonePayload(payload map[string]any) map[string]any {
	if len(payload) == 0 {
		return nil
	}
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		out[key] = clonePayloadValue(value)
	}
	return out
}

func clonePayloadValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = clonePayloadValue(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = clonePayloadValue(item)
		}
		return out
	default:
		return value
	}
}

func cloneComposerSettingsPointer(settings *ComposerSettings) *ComposerSettings {
	if settings == nil {
		return nil
	}
	cloned := *settings
	if composerSettingsIsEmpty(cloned) {
		return nil
	}
	return &cloned
}

func cloneComposerSettings(settings ComposerSettings) ComposerSettings {
	return settings
}

func cloneComposerSettingsPointerValue(settings *ComposerSettings) ComposerSettings {
	if settings == nil {
		return ComposerSettings{}
	}
	return *settings
}

func normalizeRuntimeContextForProvider(
	provider string,
	settings ComposerSettings,
	runtimeContext map[string]any,
) map[string]any {
	if len(runtimeContext) == 0 {
		return nil
	}
	cloned := clonePayload(runtimeContext)
	normalizedProvider := strings.TrimSpace(provider)
	normalizedReasoning := normalizeReasoningEffortForProvider(
		normalizedProvider,
		settings.ReasoningEffort,
	)
	if normalizedReasoning != "" {
		cloned["reasoningEffort"] = normalizedReasoning
	}
	normalizeClaudeSDKRuntimeCapabilities(normalizedProvider, cloned)
	rawConfigOptions, ok := cloned["configOptions"]
	if !ok {
		return cloned
	}
	normalizedConfigOptions, changed := normalizeRuntimeConfigOptionsForProvider(
		normalizedProvider,
		normalizedReasoning,
		rawConfigOptions,
	)
	if changed {
		cloned["configOptions"] = normalizedConfigOptions
	}
	return cloned
}

func normalizeClaudeSDKRuntimeCapabilities(provider string, runtimeContext map[string]any) {
	if agentprovider.Normalize(provider) != agentprovider.ClaudeCode ||
		strings.TrimSpace(runtimeContextString(runtimeContext, "adapter")) != runtimeContextAdapterClaudeAgentSDK {
		return
	}
	runtimeContext["capabilities"] = runtimeContextWithCapability(
		runtimeContext["capabilities"],
		runtimeContextCapabilityImageInput,
	)
}

func runtimeContextWithCapability(raw any, capability string) any {
	capability = strings.TrimSpace(capability)
	if capability == "" {
		return raw
	}
	switch list := raw.(type) {
	case []string:
		for _, entry := range list {
			if strings.TrimSpace(entry) == capability {
				return list
			}
		}
		return append(append([]string(nil), list...), capability)
	case []any:
		for _, entry := range list {
			if text, ok := entry.(string); ok && strings.TrimSpace(text) == capability {
				return list
			}
		}
		next := append([]any(nil), list...)
		next = append(next, capability)
		return next
	default:
		return []string{capability}
	}
}

func runtimeContextString(runtimeContext map[string]any, key string) string {
	value, _ := runtimeContext[key].(string)
	return strings.TrimSpace(value)
}

func normalizeRuntimeConfigOptionsForProvider(
	provider string,
	reasoningEffort string,
	rawConfigOptions any,
) (any, bool) {
	options, ok := rawConfigOptions.([]any)
	if !ok {
		return rawConfigOptions, false
	}
	changed := false
	normalized := make([]any, 0, len(options))
	for _, rawOption := range options {
		record, ok := rawOption.(map[string]any)
		if !ok {
			normalized = append(normalized, rawOption)
			continue
		}
		id := runtimeConfigOptionString(record, "id")
		if !isReasoningRuntimeConfigOptionID(id) {
			normalized = append(normalized, clonePayload(record))
			continue
		}
		nextRecord := clonePayload(record)
		currentValue := reasoningEffort
		if currentValue == "" {
			currentValue = normalizeReasoningEffortForProvider(
				provider,
				runtimeConfigOptionString(record, "currentValue", "current_value"),
			)
		}
		nextRecord["options"] = reasoningEffortOptions(provider, currentValue)
		if currentValue == "" {
			nextRecord["currentValue"] = nil
			delete(nextRecord, "current_value")
		} else {
			nextRecord["currentValue"] = currentValue
			nextRecord["current_value"] = currentValue
		}
		normalized = append(normalized, nextRecord)
		changed = true
	}
	return normalized, changed
}

func runtimeConfigOptionString(record map[string]any, keys ...string) string {
	for _, key := range keys {
		value, _ := record[key].(string)
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func isReasoningRuntimeConfigOptionID(id string) bool {
	switch strings.TrimSpace(id) {
	case runtimeConfigOptionIDLegacyReasoningEffort,
		runtimeConfigOptionIDReasoningEffort,
		runtimeConfigOptionIDEffort:
		return true
	default:
		return false
	}
}

func payloadString(payload map[string]any, key string) string {
	if len(payload) == 0 {
		return ""
	}
	value, _ := payload[key].(string)
	return strings.TrimSpace(value)
}

func payloadBool(payload map[string]any, key string) bool {
	if len(payload) == 0 {
		return false
	}
	value, _ := payload[key].(bool)
	return value
}

func value(input *string) string {
	if input == nil {
		return ""
	}
	return strings.TrimSpace(*input)
}

func valueBool(input *bool) bool {
	return input != nil && *input
}

func stringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func cloneMetadata(metadata map[string]any) map[string]any {
	if len(metadata) == 0 {
		return nil
	}
	cloned := make(map[string]any, len(metadata))
	for key, value := range metadata {
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			cloned[trimmed] = value
		}
	}
	return cloned
}

func normalizeRuntimeError(err error) error {
	if errors.Is(err, ErrSessionNotFound) {
		return ErrSessionNotFound
	}
	return err
}

func isStaleInteractiveRequestError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "no longer live")
}
