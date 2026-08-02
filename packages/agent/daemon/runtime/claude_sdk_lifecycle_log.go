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
		{logKey: "sdk_message_origin", payloadKey: "sdkMessageOrigin"},
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
		{logKey: "transcript_source", payloadKey: "transcriptSource"},
		{logKey: "transcript_phase", payloadKey: "phase"},
		{logKey: "transcript_reason", payloadKey: "reason"},
		{logKey: "goal_operation_id", payloadKey: "goalOperationId"},
		{logKey: "transcript_error", payloadKey: "error"},
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
	if payloadBoolValue(payload, "sdkResultIsError") {
		args = append(args, "sdk_result_is_error", true)
	}
	for _, field := range []struct {
		logKey     string
		payloadKey string
	}{
		{logKey: "root_transcript", payloadKey: "rootTranscript"},
		{logKey: "transcript_session_matches", payloadKey: "sessionMatches"},
		{logKey: "query_generation_active", payloadKey: "queryGenerationActive"},
		{logKey: "goal_generation_still_active", payloadKey: "goalGenerationStillActive"},
	} {
		if _, ok := payload[field.payloadKey]; ok {
			args = append(args, field.logKey, payloadBoolValue(payload, field.payloadKey))
		}
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
		{logKey: "query_generation_id", payloadKey: "queryGenerationId"},
		{logKey: "transcript_replay_attempt", payloadKey: "attempt"},
		{logKey: "transcript_batch_entries", payloadKey: "batchEntryCount"},
		{logKey: "goal_status_entries", payloadKey: "goalStatusEntryCount"},
		{logKey: "terminal_goal_status_entries", payloadKey: "terminalGoalStatusEntryCount"},
		{logKey: "projected_goal_updates", payloadKey: "projectedUpdateCount"},
		{logKey: "projected_goal_terminals", payloadKey: "projectedTerminalCount"},
		{logKey: "ignored_goal_duplicates", payloadKey: "ignoredDuplicateCount"},
		{logKey: "ignored_goal_invalid", payloadKey: "ignoredInvalidCount"},
		{logKey: "ignored_goal_stale_generation", payloadKey: "ignoredStaleGenerationCount"},
		{logKey: "ignored_goal_unbound_generation", payloadKey: "ignoredUnboundGenerationCount"},
		{logKey: "ignored_goal_objective_mismatch", payloadKey: "ignoredObjectiveMismatchCount"},
		{logKey: "ignored_goal_outside_current_turn", payloadKey: "ignoredOutsideCurrentTurnCount"},
		{logKey: "live_goal_status_entries", payloadKey: "liveGoalStatusEntryCount"},
		{logKey: "replayed_goal_status_entries", payloadKey: "replayedGoalStatusEntryCount"},
		{logKey: "goal_revision", payloadKey: "goalRevision"},
		{logKey: "goal_repair_epoch", payloadKey: "goalRepairEpoch"},
	} {
		if _, ok := payload[field.payloadKey]; ok {
			args = append(args, field.logKey, payloadInt64(payload, field.payloadKey))
		}
	}
	return args
}
