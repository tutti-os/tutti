package agentcontext

import (
	"fmt"
	"strings"

	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func sessionSummaryValue(session agentservice.Session) map[string]any {
	value := map[string]any{
		"agentSessionId": strings.TrimSpace(session.ID),
		"provider":       strings.TrimSpace(session.Provider),
		"cwd":            strings.TrimSpace(session.Cwd),
		"status":         strings.TrimSpace(session.Status),
		"visible":        session.Visible,
		"resumable":      session.Resumable,
		"createdAt":      session.CreatedAt,
		"updatedAt":      session.UpdatedAt,
		"endedAt":        session.EndedAt,
		"lastError":      session.LastError,
	}
	if session.Title != nil {
		value["title"] = strings.TrimSpace(*session.Title)
	}
	if turnLifecycle := turnLifecycleCompactValue(session.TurnLifecycle); turnLifecycle != nil {
		value["turnLifecycle"] = turnLifecycle
	}
	if submitAvailability := submitAvailabilityCompactValue(session.SubmitAvailability); submitAvailability != nil {
		value["submitAvailability"] = submitAvailability
	}
	return value
}

func sessionInspectValue(session agentservice.Session) map[string]any {
	value := sessionSummaryValue(session)
	if session.Settings != nil {
		value["settings"] = agentservice.ComposerSettingsToMap(*session.Settings)
	}
	return value
}

func sessionActionValue(session agentservice.Session) map[string]any {
	value := map[string]any{
		"agentSessionId": strings.TrimSpace(session.ID),
		"provider":       strings.TrimSpace(session.Provider),
		"status":         strings.TrimSpace(session.Status),
	}
	if session.Title != nil {
		title := strings.TrimSpace(*session.Title)
		if title != "" {
			value["title"] = title
		}
	}
	return value
}

func sessionSummaryValues(sessions []agentservice.Session) []any {
	values := make([]any, 0, len(sessions))
	for _, session := range sessions {
		values = append(values, sessionSummaryValue(session))
	}
	return values
}

func turnLifecycleCompactValue(value *agentservice.TurnLifecycle) map[string]any {
	if value == nil {
		return nil
	}
	result := map[string]any{
		"activeTurnId": nil,
		"phase":        strings.TrimSpace(value.Phase),
		"settling":     value.Settling,
	}
	if value.ActiveTurnID != nil {
		result["activeTurnId"] = strings.TrimSpace(*value.ActiveTurnID)
	}
	if value.Outcome != nil {
		result["outcome"] = strings.TrimSpace(*value.Outcome)
	}
	if value.CompletedCommand != nil {
		result["completedCommand"] = map[string]any{
			"kind":   strings.TrimSpace(value.CompletedCommand.Kind),
			"status": strings.TrimSpace(value.CompletedCommand.Status),
		}
	}
	return result
}

func submitAvailabilityCompactValue(value *agentservice.SubmitAvailability) map[string]any {
	if value == nil {
		return nil
	}
	return map[string]any{
		"state":  strings.TrimSpace(value.State),
		"reason": strings.TrimSpace(value.Reason),
	}
}

func messageCompactValue(message agentservice.SessionMessage) map[string]any {
	value := map[string]any{
		"role":   strings.TrimSpace(message.Role),
		"kind":   strings.TrimSpace(message.Kind),
		"status": strings.TrimSpace(message.Status),
	}
	if turnID := strings.TrimSpace(message.TurnID); turnID != "" {
		value["turnId"] = turnID
	}
	if message.Version > 0 {
		value["version"] = message.Version
	}
	if message.OccurredAtUnixMS > 0 {
		value["occurredAtUnixMs"] = message.OccurredAtUnixMS
	}
	if text := messageCompactText(message.Payload, message.Kind); text != "" {
		value["text"] = text
	}
	return value
}

func messageCompactValues(messages []agentservice.SessionMessage) []any {
	values := make([]any, 0, len(messages))
	for _, message := range messages {
		values = append(values, messageCompactValue(message))
	}
	return values
}

func messageCompactText(payload map[string]any, kind string) string {
	if len(payload) == 0 {
		return ""
	}
	if text, ok := payload["text"].(string); ok {
		if trimmed := strings.TrimSpace(text); trimmed != "" {
			return trimmed
		}
	}
	if content, ok := payload["content"].(string); ok {
		if trimmed := strings.TrimSpace(content); trimmed != "" {
			return trimmed
		}
	}
	if blocks, ok := payload["content"].([]any); ok {
		if text := compactTextFromContentBlocks(blocks); text != "" {
			return text
		}
	}
	if name := strings.TrimSpace(fmt.Sprint(payload["name"])); name != "" && name != "<nil>" {
		return strings.TrimSpace(kind + ": " + name)
	}
	if status := strings.TrimSpace(fmt.Sprint(payload["status"])); status != "" && status != "<nil>" {
		return strings.TrimSpace(kind + ": " + status)
	}
	return ""
}

func compactTextFromContentBlocks(blocks []any) string {
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		item, ok := block.(map[string]any)
		if !ok {
			continue
		}
		if text, ok := item["text"].(string); ok {
			if trimmed := strings.TrimSpace(text); trimmed != "" {
				parts = append(parts, trimmed)
			}
		}
	}
	return strings.Join(parts, "\n")
}
