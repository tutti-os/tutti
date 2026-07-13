package agentcontext

import (
	"fmt"
	"path/filepath"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type imageLocalPathResolver func(agentSessionID string, attachmentID string, mimeType string) (string, bool)

func sessionSummaryValue(session agentservice.Session) map[string]any {
	value := map[string]any{
		"agentSessionId":  strings.TrimSpace(session.ID),
		"provider":        strings.TrimSpace(session.Provider),
		"cwd":             strings.TrimSpace(session.Cwd),
		"visible":         session.Visible,
		"resumable":       session.Resumable,
		"createdAtUnixMs": session.CreatedAt.UnixMilli(),
		"activeTurnId":    nil,
	}
	if session.UpdatedAt != nil {
		value["updatedAtUnixMs"] = session.UpdatedAt.UnixMilli()
	}
	if session.EndedAt != nil {
		value["endedAtUnixMs"] = session.EndedAt.UnixMilli()
	}
	if turnID := strings.TrimSpace(session.ActiveTurnID); turnID != "" {
		value["activeTurnId"] = turnID
	}
	if session.ActiveTurn != nil {
		value["activeTurn"] = turnCompactValue(*session.ActiveTurn)
	}
	if session.LatestTurn != nil {
		value["latestTurn"] = turnCompactValue(*session.LatestTurn)
	}
	value["pendingInteractions"] = interactionCompactValues(session.PendingInteractions)
	if session.Title != nil {
		value["title"] = strings.TrimSpace(*session.Title)
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
		"activeTurnId":   strings.TrimSpace(session.ActiveTurnID),
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

func turnCompactValue(value agentactivitybiz.Turn) map[string]any {
	result := map[string]any{
		"turnId": strings.TrimSpace(value.TurnID),
		"phase":  strings.TrimSpace(value.Phase),
	}
	if outcome := strings.TrimSpace(value.Outcome); outcome != "" {
		result["outcome"] = outcome
	}
	return result
}

func interactionCompactValues(values []agentactivitybiz.Interaction) []any {
	result := make([]any, 0, len(values))
	for _, value := range values {
		result = append(result, map[string]any{
			"requestId": strings.TrimSpace(value.RequestID), "turnId": strings.TrimSpace(value.TurnID),
			"kind": strings.TrimSpace(value.Kind), "status": strings.TrimSpace(value.Status),
		})
	}
	return result
}

func messageCompactValue(message agentservice.SessionMessage, imageLocalPath imageLocalPathResolver) map[string]any {
	value := map[string]any{
		"role":   strings.TrimSpace(message.Role),
		"kind":   strings.TrimSpace(message.Kind),
		"status": strings.TrimSpace(message.Status),
	}
	if messageID := strings.TrimSpace(message.MessageID); messageID != "" {
		value["messageId"] = messageID
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
	if images := messageCompactImages(message, imageLocalPath); len(images) > 0 {
		value["images"] = images
	}
	return value
}

func messageCompactValues(messages []agentservice.SessionMessage, imageLocalPath imageLocalPathResolver) []any {
	values := make([]any, 0, len(messages))
	for _, message := range messages {
		values = append(values, messageCompactValue(message, imageLocalPath))
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

func messageCompactImages(message agentservice.SessionMessage, imageLocalPath imageLocalPathResolver) []any {
	blocks, ok := message.Payload["content"].([]any)
	if !ok || len(blocks) == 0 {
		return nil
	}
	images := make([]any, 0)
	for _, block := range blocks {
		item, ok := block.(map[string]any)
		if !ok || strings.TrimSpace(fmt.Sprint(item["type"])) != "image" {
			continue
		}
		attachmentID := strings.TrimSpace(fmt.Sprint(item["attachmentId"]))
		mimeType := strings.TrimSpace(fmt.Sprint(item["mimeType"]))
		image := map[string]any{}
		if attachmentID != "" && attachmentID != "<nil>" {
			image["attachmentId"] = attachmentID
		}
		if mimeType != "" && mimeType != "<nil>" {
			image["mimeType"] = mimeType
		}
		if name := strings.TrimSpace(fmt.Sprint(item["name"])); name != "" && name != "<nil>" {
			image["name"] = name
		}
		if localPath := compactImageLocalPath(message.AgentSessionID, attachmentID, mimeType, item, imageLocalPath); localPath != "" {
			image["localPath"] = localPath
			if _, ok := image["name"]; !ok {
				image["name"] = filepath.Base(localPath)
			}
		}
		if len(image) > 0 {
			images = append(images, image)
		}
	}
	return images
}

func compactImageLocalPath(
	agentSessionID string,
	attachmentID string,
	mimeType string,
	block map[string]any,
	imageLocalPath imageLocalPathResolver,
) string {
	if imageLocalPath != nil && attachmentID != "" && attachmentID != "<nil>" {
		if path, ok := imageLocalPath(agentSessionID, attachmentID, mimeType); ok {
			if trimmed := strings.TrimSpace(path); trimmed != "" {
				return trimmed
			}
		}
	}
	for _, key := range []string{"localPath", "path"} {
		if path := strings.TrimSpace(fmt.Sprint(block[key])); path != "" && path != "<nil>" {
			return path
		}
	}
	return ""
}
