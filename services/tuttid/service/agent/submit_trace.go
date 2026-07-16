package agent

import (
	"log/slog"
	"strings"
	"time"
)

func logAgentSubmitTrace(event string, workspaceID string, agentSessionID string, clientSubmitID string, metadata map[string]any, fields map[string]any) {
	LogSubmitTrace(event, workspaceID, agentSessionID, clientSubmitID, metadata, fields)
}

// LogSubmitTrace records cross-layer timings for client-initiated agent submits.
func LogSubmitTrace(event string, workspaceID string, agentSessionID string, clientSubmitID string, metadata map[string]any, fields map[string]any) {
	clientSubmitID = strings.TrimSpace(clientSubmitID)
	if clientSubmitID == "" {
		return
	}
	args := []any{
		"event", "agent.submit.trace",
		"trace_event", event,
		"workspace_id", strings.TrimSpace(workspaceID),
		"agent_session_id", strings.TrimSpace(agentSessionID),
		"client_submit_id", clientSubmitID,
	}
	if submittedAt := metadataInt64(metadata, "clientSubmittedAtUnixMs"); submittedAt > 0 {
		args = append(args,
			"client_submitted_at_unix_ms", submittedAt,
			"elapsed_since_client_submit_ms", time.Now().UnixMilli()-submittedAt,
		)
	}
	for key, value := range fields {
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			args = append(args, trimmed, value)
		}
	}
	slog.Info("agent submit trace", args...)
}

func metadataInt64(metadata map[string]any, key string) int64 {
	if len(metadata) == 0 {
		return 0
	}
	switch value := metadata[key].(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	}
	return 0
}
