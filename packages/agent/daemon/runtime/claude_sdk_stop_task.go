package agentruntime

import (
	"context"
)

// StopTask asks the sidecar to stop one background delegated task via the
// SDK's targeted stopTask, leaving the root query and other tasks running.
// The task id may be either the provider task id or the launching tool call
// id; the sidecar resolves both.
func (a *ClaudeCodeSDKAdapter) StopTask(ctx context.Context, session Session, taskID string) (bool, error) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return false, ErrSessionDisconnected
	}
	stopCtx, cancel := context.WithTimeout(ctx, claudeSDKGoalCommandTimeout)
	defer cancel()
	response, err := a.roundTripClaudeSDKResponse(stopCtx, session.AgentSessionID, adapterSession, claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "stop_task",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
			"taskId":         taskID,
			"toolCallId":     taskID,
		},
	})
	if err != nil {
		return false, err
	}
	return payloadBoolValue(response.Payload, "stopped"), nil
}
