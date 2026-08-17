package agentcontext

import (
	"fmt"
	"net/url"
	"path/filepath"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type imageLocalPathResolver func(agentSessionID string, attachmentID string, mimeType string) (string, bool)

func agentSessionMentionURI(workspaceID string, sessionID string) string {
	workspaceID = strings.TrimSpace(workspaceID)
	sessionID = strings.TrimSpace(sessionID)
	if workspaceID == "" || sessionID == "" {
		return ""
	}
	query := url.Values{"workspaceId": []string{workspaceID}}
	return "mention://agent-session/" + url.PathEscape(sessionID) + "?" + query.Encode()
}

func addAgentSessionReference(value map[string]any, workspaceID string, sessionID string) {
	workspaceID = strings.TrimSpace(workspaceID)
	sessionID = strings.TrimSpace(sessionID)
	mentionURI := agentSessionMentionURI(workspaceID, sessionID)
	if mentionURI == "" {
		return
	}
	value["agentSessionId"] = sessionID
	value["workspaceId"] = workspaceID
	value["mentionUri"] = mentionURI
}

func sessionSummaryValue(workspaceID string, session agentservice.Session) map[string]any {
	value := map[string]any{
		"agentSessionId":  strings.TrimSpace(session.ID),
		"agentTargetId":   strings.TrimSpace(session.AgentTargetID),
		"provider":        strings.TrimSpace(session.Provider),
		"cwd":             strings.TrimSpace(session.Cwd),
		"visible":         session.Visible,
		"resumable":       session.Resumable,
		"createdAtUnixMs": session.CreatedAt.UnixMilli(),
		"activeTurnId":    nil,
	}
	addAgentSessionReference(value, workspaceID, session.ID)
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
	if session.Isolation != nil {
		value["isolation"] = isolationCompactValue(*session.Isolation)
	}
	return value
}

func sessionInspectValue(workspaceID string, session agentservice.Session) map[string]any {
	value := sessionSummaryValue(workspaceID, session)
	if session.Settings != nil {
		value["settings"] = agentservice.ComposerSettingsToMap(*session.Settings)
	}
	return value
}

func sessionActionValue(workspaceID string, session agentservice.Session) map[string]any {
	value := map[string]any{
		"agentSessionId": strings.TrimSpace(session.ID),
		"agentTargetId":  strings.TrimSpace(session.AgentTargetID),
		"provider":       strings.TrimSpace(session.Provider),
		"activeTurnId":   strings.TrimSpace(session.ActiveTurnID),
	}
	addAgentSessionReference(value, workspaceID, session.ID)
	if session.Title != nil {
		title := strings.TrimSpace(*session.Title)
		if title != "" {
			value["title"] = title
		}
	}
	if session.Isolation != nil {
		value["isolation"] = isolationCompactValue(*session.Isolation)
	}
	return value
}

func isolationCompactValue(isolation agentservice.SessionIsolation) map[string]any {
	value := map[string]any{
		"mode": strings.TrimSpace(isolation.Mode), "worktreePath": strings.TrimSpace(isolation.WorktreePath),
		"branch": strings.TrimSpace(isolation.Branch), "baseCommit": strings.TrimSpace(isolation.BaseCommit),
	}
	if worktreeID := strings.TrimSpace(isolation.WorktreeID); worktreeID != "" {
		value["worktreeId"] = worktreeID
	}
	return value
}

func sessionSummaryValues(workspaceID string, sessions []agentservice.Session) []any {
	values := make([]any, 0, len(sessions))
	for _, session := range sessions {
		values = append(values, sessionSummaryValue(workspaceID, session))
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
	if strings.TrimSpace(kind) == "tool_call" {
		for _, key := range []string{"output", "error"} {
			if text := messageCompactToolBodyText(payload[key]); text != "" {
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

func messageCompactToolBodyText(value any) string {
	body, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	for _, key := range []string{"text", "message", "summary", "stdout", "stderr"} {
		if text, ok := body[key].(string); ok {
			if trimmed := strings.TrimSpace(text); trimmed != "" {
				return trimmed
			}
		}
	}
	if matches, ok := body["matches"].([]any); ok {
		values := make([]string, 0, len(matches))
		for _, match := range matches {
			if text, ok := match.(string); ok {
				if trimmed := strings.TrimSpace(text); trimmed != "" {
					values = append(values, trimmed)
				}
			}
		}
		return strings.Join(values, ", ")
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
	images := messageCompactToolImages(message)
	if strings.TrimSpace(message.Kind) == "tool_call" {
		return images
	}
	blocks, ok := message.Payload["content"].([]any)
	if !ok || len(blocks) == 0 {
		return images
	}
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

func messageCompactToolImages(message agentservice.SessionMessage) []any {
	if strings.TrimSpace(message.Kind) != "tool_call" {
		return nil
	}
	output, ok := message.Payload["output"].(map[string]any)
	if !ok {
		return nil
	}
	paths := make([]string, 0)
	if values, ok := output["savedPaths"].([]any); ok {
		for _, value := range values {
			if path, ok := value.(string); ok {
				if trimmed := strings.TrimSpace(path); trimmed != "" {
					paths = appendUniqueCompactString(paths, trimmed)
				}
			}
		}
	}
	if path, ok := output["savedPath"].(string); ok {
		if trimmed := strings.TrimSpace(path); trimmed != "" {
			paths = appendUniqueCompactString(paths, trimmed)
		}
	}
	mimeType, _ := output["imageMimeType"].(string)
	images := make([]any, 0, len(paths))
	for _, path := range paths {
		image := map[string]any{
			"localPath": path,
			"name":      filepath.Base(path),
		}
		if trimmed := strings.TrimSpace(mimeType); trimmed != "" {
			image["mimeType"] = trimmed
		}
		images = append(images, image)
	}
	return images
}

func appendUniqueCompactString(values []string, value string) []string {
	for _, current := range values {
		if current == value {
			return values
		}
	}
	return append(values, value)
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
