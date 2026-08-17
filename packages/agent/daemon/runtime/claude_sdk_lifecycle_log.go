package agentruntime

import (
	"log/slog"
	"strings"
)

func claudeSDKLifecycleEventLogLevel(eventType string) slog.Level {
	if strings.TrimSpace(eventType) == "continuation_delayed" {
		return slog.LevelWarn
	}
	return slog.LevelInfo
}

func claudeSDKLifecycleLogArgs(payload map[string]any) []any {
	args := make([]any, 0, 42)
	for _, field := range []struct {
		logKey     string
		payloadKey string
	}{
		{logKey: "turn_id", payloadKey: "turnId"},
		{logKey: "sdk_message_type", payloadKey: "sdkMessageType"},
		{logKey: "sdk_message_subtype", payloadKey: "sdkMessageSubtype"},
		{logKey: "diagnostic_marker", payloadKey: "diagnosticMarker"},
		{logKey: "diagnostic_boundary", payloadKey: "diagnosticBoundary"},
		{logKey: "route_decision", payloadKey: "routeDecision"},
		{logKey: "sdk_message_origin", payloadKey: "sdkMessageOrigin"},
		{logKey: "sdk_message_uuid", payloadKey: "sdkMessageUuid"},
		{logKey: "attachment_type", payloadKey: "attachmentType"},
		{logKey: "goal_met_field_type", payloadKey: "goalMetFieldType"},
		{logKey: "goal_sentinel_field_type", payloadKey: "goalSentinelFieldType"},
		{logKey: "active_goal_value_type", payloadKey: "activeGoalValueType"},
		{logKey: "active_turn_id_before", payloadKey: "activeTurnIdBefore"},
		{logKey: "task_id", payloadKey: "taskId"},
		{logKey: "agent_id", payloadKey: "agentId"},
		{logKey: "tool_use_id", payloadKey: "toolUseId"},
		{logKey: "tool_call_id", payloadKey: "toolCallId"},
		{logKey: "parent_tool_use_id", payloadKey: "parentToolUseId"},
		{logKey: "tool_name", payloadKey: "toolName"},
		{logKey: "status", payloadKey: "status"},
		{logKey: "state", payloadKey: "state"},
		{logKey: "stop_reason", payloadKey: "stopReason"},
		{logKey: "goal_source", payloadKey: "source"},
		{logKey: "goal_update_type", payloadKey: "updateType"},
		{logKey: "sdk_assistant_error", payloadKey: "sdkAssistantError"},
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
	for _, field := range []struct {
		logKey     string
		payloadKey string
	}{
		{logKey: "transcript_path_present", payloadKey: "transcriptPathPresent"},
		{logKey: "goal_condition_present", payloadKey: "goalConditionPresent"},
		{logKey: "goal_met_value", payloadKey: "goalMetValue"},
		{logKey: "goal_sentinel_value", payloadKey: "goalSentinelValue"},
	} {
		if _, ok := payload[field.payloadKey]; ok {
			args = append(args, field.logKey, payloadBoolValue(payload, field.payloadKey))
		}
	}
	if payloadBoolValue(payload, "sdkResultIsError") {
		args = append(args, "sdk_result_is_error", true)
	}
	args = appendClaudeSDKRetryDiagnostics(args, payload)
	if apiErrorStatus := payloadInt64(payload, "sdkApiErrorStatus"); apiErrorStatus > 0 {
		args = append(args, "sdk_api_error_status", apiErrorStatus)
	}
	if payloadBoolValue(payload, "syntheticTimeout") {
		args = append(args, "synthetic_timeout", true)
	}
	if goal := payloadObject(payload["goal"]); len(goal) > 0 {
		if status := strings.TrimSpace(asString(goal["status"])); status != "" {
			args = append(args, "goal_status", status)
		}
	}
	for _, field := range []struct {
		logKey     string
		payloadKey string
	}{
		{logKey: "background_tasks_observed", payloadKey: "backgroundTasksObservedCount"},
		{logKey: "background_tasks_running", payloadKey: "backgroundTasksRunningCount"},
		{logKey: "background_tasks_no_longer_live", payloadKey: "backgroundTasksNoLongerLiveCount"},
		{logKey: "delegated_tasks_known", payloadKey: "delegatedTasksKnownCount"},
		{logKey: "delegated_tasks_running", payloadKey: "delegatedTasksRunningCount"},
		{logKey: "delegated_tasks_completed", payloadKey: "delegatedTasksCompletedCount"},
		{logKey: "delegated_tasks_failed", payloadKey: "delegatedTasksFailedCount"},
		{logKey: "delegated_tasks_stopped", payloadKey: "delegatedTasksStoppedCount"},
		{logKey: "continuation_waited_ms", payloadKey: "waitedMs"},
	} {
		if _, ok := payload[field.payloadKey]; ok {
			args = append(args, field.logKey, payloadInt64(payload, field.payloadKey))
		}
	}
	if usage := payloadMap(payload, "usage"); len(usage) > 0 {
		for _, field := range []struct {
			logKey     string
			payloadKey string
		}{
			{logKey: "usage_total_tokens", payloadKey: "total_tokens"},
			{logKey: "usage_input_tokens", payloadKey: "input_tokens"},
			{logKey: "usage_output_tokens", payloadKey: "output_tokens"},
			{logKey: "usage_cache_read_input_tokens", payloadKey: "cache_read_input_tokens"},
			{logKey: "usage_cache_creation_input_tokens", payloadKey: "cache_creation_input_tokens"},
			{logKey: "usage_tool_uses", payloadKey: "tool_uses"},
			{logKey: "usage_duration_ms", payloadKey: "duration_ms"},
		} {
			if _, ok := usage[field.payloadKey]; ok {
				args = append(args, field.logKey, payloadInt64(usage, field.payloadKey))
			}
		}
	}
	return args
}
