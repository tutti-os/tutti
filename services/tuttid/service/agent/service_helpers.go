package agent

import (
	"errors"
	"strings"
)

const (
	runtimeConfigOptionIDReasoningEffort       = "reasoning_effort"
	runtimeConfigOptionIDLegacyReasoningEffort = "model_reasoning_effort"
	runtimeConfigOptionIDEffort                = "effort"
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

func cloneSession(session Session) Session {
	cloned := session
	cloned.Settings = cloneComposerSettingsPointer(session.Settings)
	cloned.RuntimeContext = clonePayload(session.RuntimeContext)
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

func clonePayload(payload map[string]any) map[string]any {
	if len(payload) == 0 {
		return nil
	}
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		out[key] = value
	}
	return out
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

func normalizeRuntimeError(err error) error {
	if errors.Is(err, ErrSessionNotFound) {
		return ErrSessionNotFound
	}
	return err
}
