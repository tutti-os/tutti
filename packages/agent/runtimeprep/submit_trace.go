package runtimeprep

import (
	"log/slog"
	"strings"
	"time"
)

func logRuntimePrepareTrace(event string, input PrepareInput, fields map[string]any) {
	clientSubmitID := metadataString(input.Metadata, "clientSubmitId")
	if clientSubmitID == "" {
		return
	}
	args := []any{
		"event", "agent.submit.trace",
		"trace_event", event,
		"workspace_id", strings.TrimSpace(input.WorkspaceID),
		"agent_session_id", strings.TrimSpace(input.AgentSessionID),
		"client_submit_id", clientSubmitID,
	}
	if submittedAt := metadataInt64(input.Metadata, "clientSubmittedAtUnixMs"); submittedAt > 0 {
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

func metadataString(metadata map[string]any, key string) string {
	if len(metadata) == 0 {
		return ""
	}
	value, _ := metadata[key].(string)
	return strings.TrimSpace(value)
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
