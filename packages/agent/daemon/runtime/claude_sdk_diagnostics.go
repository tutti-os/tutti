package agentruntime

import (
	"log/slog"
	"strings"
)

func (a *ClaudeCodeSDKAdapter) logClaudeSDKLifecycleEvent(agentSessionID string, adapterSession *claudeSDKAdapterSession, event claudeSDKSidecarEvent) {
	if !claudeSDKLifecycleEventDiagnostic(event) {
		return
	}
	a.mu.Lock()
	adapterSession.diagnosticEventSeq++
	sequence := adapterSession.diagnosticEventSeq
	providerSessionID := strings.TrimSpace(adapterSession.providerSessionID)
	rootTurnID := strings.TrimSpace(adapterSession.rootTurnID)
	a.mu.Unlock()

	payload := event.Payload
	args := []any{
		"event", "agent_session.claude_sdk.lifecycle_event",
		"sequence", sequence,
		"agent_session_id", strings.TrimSpace(agentSessionID),
		"provider_session_id", providerSessionID,
		"root_turn_id", rootTurnID,
		"sidecar_event_type", strings.TrimSpace(event.Type),
	}
	for _, field := range []struct {
		logKey     string
		payloadKey string
	}{
		{logKey: "turn_id", payloadKey: "turnId"},
		{logKey: "sdk_message_type", payloadKey: "sdkMessageType"},
		{logKey: "sdk_message_subtype", payloadKey: "sdkMessageSubtype"},
		{logKey: "active_turn_id_before", payloadKey: "activeTurnIdBefore"},
		{logKey: "task_id", payloadKey: "taskId"},
		{logKey: "agent_id", payloadKey: "agentId"},
		{logKey: "tool_use_id", payloadKey: "toolUseId"},
		{logKey: "tool_call_id", payloadKey: "toolCallId"},
		{logKey: "parent_tool_use_id", payloadKey: "parentToolUseId"},
		{logKey: "tool_name", payloadKey: "toolName"},
		{logKey: "status", payloadKey: "status"},
		{logKey: "stop_reason", payloadKey: "stopReason"},
	} {
		if value := strings.TrimSpace(payloadString(payload, field.payloadKey)); value != "" {
			args = append(args, field.logKey, value)
		}
	}
	if payloadBoolValue(payload, "synthetic") {
		args = append(args, "synthetic", true)
	}
	if payloadBoolValue(payload, "taskNotification") {
		args = append(args, "task_notification", true)
	}
	if payloadBoolValue(payload, "rootContinuationCandidate") {
		args = append(args, "root_continuation_candidate", true)
	}
	if payloadBoolValue(payload, "syntheticTimeout") {
		args = append(args, "synthetic_timeout", true)
	}
	slog.Info("agent session Claude SDK lifecycle event", args...)
}

func claudeSDKLifecycleEventDiagnostic(event claudeSDKSidecarEvent) bool {
	switch strings.TrimSpace(event.Type) {
	case "sdk_lifecycle_observed",
		"turn_started", "turn_completed", "turn_canceled", "turn_failed",
		"task_started", "task_progress", "task_completed":
		return true
	case "tool_started", "tool_completed", "tool_failed":
		return strings.EqualFold(strings.TrimSpace(payloadString(event.Payload, "toolName")), "Agent") ||
			strings.EqualFold(strings.TrimSpace(payloadString(event.Payload, "toolName")), "Task")
	default:
		return false
	}
}
