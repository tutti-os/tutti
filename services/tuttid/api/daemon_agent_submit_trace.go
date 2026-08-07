package api

import (
	"log/slog"
	"strings"
)

func logAgentSubmitTrace(event string, workspaceID string, agentSessionID string, clientSubmitID string, _ map[string]any, fields map[string]any) {
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
	for key, value := range fields {
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			args = append(args, trimmed, value)
		}
	}
	slog.Info("agent submit trace", args...)
}

func logCreateAgentSubmitTrace(event string, workspaceID string, agentSessionID string, clientSubmitID string, metadata map[string]any, provider string, sessionStatus string, err error) {
	fields := map[string]any{}
	if strings.TrimSpace(provider) != "" {
		fields["provider"] = strings.TrimSpace(provider)
	}
	if strings.TrimSpace(sessionStatus) != "" {
		fields["session_status"] = strings.TrimSpace(sessionStatus)
	}
	if err != nil {
		fields["error"] = err.Error()
	}
	logAgentSubmitTrace(event, workspaceID, agentSessionID, clientSubmitID, metadata, fields)
}

func logSendAgentSubmitTrace(event string, workspaceID string, agentSessionID string, clientSubmitID string, metadata map[string]any, sessionStatus string, turnID string, turnPhase string, err error) {
	fields := map[string]any{}
	if strings.TrimSpace(sessionStatus) != "" {
		fields["session_status"] = strings.TrimSpace(sessionStatus)
	}
	if strings.TrimSpace(turnID) != "" {
		fields["turn_id"] = strings.TrimSpace(turnID)
	}
	if strings.TrimSpace(turnPhase) != "" {
		fields["turn_phase"] = strings.TrimSpace(turnPhase)
	}
	if err != nil {
		fields["error"] = err.Error()
	}
	logAgentSubmitTrace(event, workspaceID, agentSessionID, clientSubmitID, metadata, fields)
}
