package storesqlite

import "strings"

func goalControlAuditMessageUpdate(input GoalControlOperationPrepare, revision int64) MessageUpdate {
	auditID := "goal-control:" + strings.TrimSpace(input.OperationID)
	content := "/goal " + strings.TrimSpace(input.Action)
	if input.Action == "set" {
		content = "/goal " + strings.TrimSpace(input.Objective)
	}
	payload := map[string]any{
		"action":          strings.TrimSpace(input.Action),
		"auditId":         auditID,
		"content":         content,
		"goalControl":     true,
		"goalRepairEpoch": int64(0),
		"goalRevision":    revision,
		"operationId":     strings.TrimSpace(input.OperationID),
		"text":            content,
	}
	if clientSubmitID := strings.TrimSpace(input.ClientSubmitID); clientSubmitID != "" {
		payload["clientSubmitId"] = clientSubmitID
		payload["messageId"] = "client-submit:user:" + clientSubmitID
	}
	return MessageUpdate{
		MessageID:        auditID,
		Role:             "user",
		Kind:             "session_audit",
		Status:           "completed",
		Payload:          payload,
		OccurredAtUnixMS: input.OccurredAtUnixMS,
	}
}
