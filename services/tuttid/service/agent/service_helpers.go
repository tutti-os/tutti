package agent

import (
	"errors"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
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
	cloned.Metadata = cloneSessionMetadata(session.Metadata)
	cloned.Settings = cloneComposerSettingsPointer(session.Settings)
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
	cloned.ActiveTurn = cloneActivityTurn(session.ActiveTurn)
	cloned.LatestTurn = cloneActivityTurn(session.LatestTurn)
	cloned.ActiveTurnID = strings.TrimSpace(session.ActiveTurnID)
	cloned.LatestTurnInteractions = cloneActivityInteractions(session.LatestTurnInteractions)
	cloned.PendingInteractions = cloneActivityInteractions(session.PendingInteractions)
	return cloned
}

func cloneSessionMetadata(metadata agentactivitybiz.SessionMetadata) agentactivitybiz.SessionMetadata {
	cloned := metadata
	cloned.Capabilities = append([]string(nil), metadata.Capabilities...)
	if metadata.Usage != nil {
		value := *metadata.Usage
		if metadata.Usage.ContextWindow != nil {
			contextWindow := *metadata.Usage.ContextWindow
			value.ContextWindow = &contextWindow
		}
		value.Quotas = append([]agentactivitybiz.SessionUsageQuota(nil), metadata.Usage.Quotas...)
		for index := range value.Quotas {
			if metadata.Usage.Quotas[index].ResetsAtUnixMS != nil {
				resetsAtUnixMS := *metadata.Usage.Quotas[index].ResetsAtUnixMS
				value.Quotas[index].ResetsAtUnixMS = &resetsAtUnixMS
			}
		}
		cloned.Usage = &value
	}
	if metadata.BackgroundAgents != nil {
		value := *metadata.BackgroundAgents
		value.Items = append([]agentactivitybiz.SessionBackgroundAgentItem(nil), metadata.BackgroundAgents.Items...)
		cloned.BackgroundAgents = &value
	}
	if metadata.Goal != nil {
		value := *metadata.Goal
		cloned.Goal = &value
	}
	return cloned
}

func cloneActivityTurn(value *agentactivitybiz.Turn) *agentactivitybiz.Turn {
	if value == nil {
		return nil
	}
	cloned := *value
	cloned.FileChanges = clonePayload(value.FileChanges)
	return &cloned
}

func cloneActivityInteractions(values []agentactivitybiz.Interaction) []agentactivitybiz.Interaction {
	if values == nil {
		return nil
	}
	cloned := make([]agentactivitybiz.Interaction, len(values))
	for index, value := range values {
		cloned[index] = value
		cloned[index].Input = clonePayload(value.Input)
		cloned[index].Output = clonePayload(value.Output)
		cloned[index].Metadata = clonePayload(value.Metadata)
	}
	return cloned
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
