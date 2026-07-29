package agentruntime

import (
	"fmt"
	"sort"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

const (
	maxReportLogMessageUpdates   = 8
	maxReportLogStatePatches     = 6
	maxReportLogEntitiesPerPatch = 3
	maxReportLogSummaryLength    = 600
	maxReportLogErrorLength      = 360
)

func SummarizeReportActivityInputForLog(
	input agentsessionstore.ReportActivityInput,
) ([]string, []string) {
	messageUpdates := summarizeMessageUpdatesForLog(input.MessageUpdates)
	statePatches := summarizeStatePatchesForLog(input.StatePatches)
	return messageUpdates, statePatches
}

func summarizeMessageUpdatesForLog(updates []agentsessionstore.WorkspaceAgentMessageUpdate) []string {
	if len(updates) == 0 {
		return nil
	}
	limit := minReportLogInt(len(updates), maxReportLogMessageUpdates)
	out := make([]string, 0, limit+1)
	for _, update := range updates[:limit] {
		bodyKinds := summarizeBodyKinds(
			payloadHasNonEmptyField(update.Payload, "input"),
			payloadHasNonEmptyField(update.Payload, "output"),
			payloadHasNonEmptyField(update.Payload, "error"),
			payloadHasNonEmptyField(update.Payload, "text"),
		)
		summary := fmt.Sprintf(
			"%s|%s|%s|call=%s|turn=%s|body=%s|name=%s",
			logSummaryValue(update.MessageID),
			logSummaryValue(update.Kind),
			logSummaryValue(update.Status),
			logSummaryValue(update.CallID),
			logSummaryValue(update.TurnID),
			bodyKinds,
			logSummaryValue(messageUpdateNameForLog(update)),
		)
		if shouldLogMessageUpdateError(update) {
			if errorSummary := messageUpdateErrorSummaryForLog(update.Payload); errorSummary != "" {
				summary += fmt.Sprintf("|error=%q", errorSummary)
			}
		}
		out = append(out, trimReportLogSummary(summary))
	}
	if len(updates) > limit {
		out = append(out, fmt.Sprintf("...+%d more message updates", len(updates)-limit))
	}
	return out
}

func summarizeStatePatchesForLog(patches []agentsessionstore.WorkspaceAgentStatePatch) []string {
	if len(patches) == 0 {
		return nil
	}
	limit := minReportLogInt(len(patches), maxReportLogStatePatches)
	out := make([]string, 0, limit+1)
	for _, patch := range patches[:limit] {
		entityLimit := minReportLogInt(len(patch.Entities), maxReportLogEntitiesPerPatch)
		entitySummaries := make([]string, 0, entityLimit+1)
		for _, entity := range patch.Entities[:entityLimit] {
			entitySummaries = append(entitySummaries, trimReportLogSummary(fmt.Sprintf(
				"%s|%s|call=%s|turn=%s|body=%s|done=%t",
				logSummaryValue(firstNonEmpty(entity.Name, entity.CallType)),
				logSummaryValue(entity.Status),
				logSummaryValue(entity.CallID),
				logSummaryValue(entity.TurnID),
				summarizeBodyKinds(
					len(entity.Input) > 0,
					len(entity.Output) > 0,
					len(entity.Error) > 0,
					false,
				),
				entity.CompletedAtUnixMS > 0,
			)))
		}
		if len(patch.Entities) > entityLimit {
			entitySummaries = append(entitySummaries, fmt.Sprintf("...+%d more entities", len(patch.Entities)-entityLimit))
		}
		out = append(out, trimReportLogSummary(fmt.Sprintf(
			"session=%s|phase=%s|lifecycle=%s|turn=%s|turnLifecycle=%s|rootProviderTurn=%s|entities=%s",
			logSummaryValue(patch.AgentSessionID),
			logSummaryValue(patch.CurrentPhase),
			logSummaryValue(patch.LifecycleStatus),
			logSummaryValue(turnPatchSummary(patch.Turn)),
			logSummaryValue(turnLifecycleSummary(patch.TurnLifecycle)),
			logSummaryValue(rootProviderTurnSummary(patch.RootProviderTurn)),
			strings.Join(entitySummaries, ";"),
		)))
	}
	if len(patches) > limit {
		out = append(out, fmt.Sprintf("...+%d more state patches", len(patches)-limit))
	}
	return out
}

func summarizeLogValueCounts(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	counts := make(map[string]int, len(values))
	order := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if counts[value] == 0 {
			order = append(order, value)
		}
		counts[value]++
	}
	if len(order) == 0 {
		return nil
	}
	out := make([]string, 0, len(order))
	for _, value := range order {
		out = append(out, fmt.Sprintf("%s=%d", value, counts[value]))
	}
	return out
}

func payloadHasNonEmptyField(payload map[string]any, key string) bool {
	if len(payload) == 0 {
		return false
	}
	value, ok := payload[key]
	if !ok {
		return false
	}
	return !payloadValueIsEmpty(value)
}

func messageUpdateNameForLog(update agentsessionstore.WorkspaceAgentMessageUpdate) string {
	return firstNonEmpty(
		payloadStringValueForLog(update.Payload, "toolName"),
		payloadStringValueForLog(update.Payload, "name"),
		update.Title,
	)
}

func shouldLogMessageUpdateError(update agentsessionstore.WorkspaceAgentMessageUpdate) bool {
	if !messageUpdateIsCallForLog(update) {
		return false
	}
	status := strings.ToLower(strings.TrimSpace(update.Status))
	if status == "failed" || status == "failure" || status == "error" || status == "errored" {
		return true
	}
	kind := strings.ToLower(strings.TrimSpace(update.Kind))
	return kind == "call.failed" || kind == "call.errored"
}

func messageUpdateIsCallForLog(update agentsessionstore.WorkspaceAgentMessageUpdate) bool {
	kind := strings.ToLower(strings.TrimSpace(update.Kind))
	if kind == "tool_call" || strings.HasPrefix(kind, "call.") {
		return true
	}
	return strings.TrimSpace(update.CallID) != ""
}

func messageUpdateErrorSummaryForLog(payload map[string]any) string {
	for _, candidate := range []any{
		payloadFieldValueForLog(payload, "error", "message"),
		payloadFieldValueForLog(payload, "error", "stderr"),
		payloadFieldValueForLog(payload, "error", "reason"),
		payloadFieldValueForLog(payload, "error", "output"),
		payloadFieldValueForLog(payload, "error", "aggregated_output"),
		payloadFieldValueForLog(payload, "error", "text"),
		payloadValueForLog(payload, "error"),
		payloadFieldValueForLog(payload, "output", "stderr"),
		payloadFieldValueForLog(payload, "output", "aggregated_output"),
		payloadFieldValueForLog(payload, "output", "output"),
	} {
		if summary := summarizePayloadValueForLog(candidate, maxReportLogErrorLength); summary != "" {
			return summary
		}
	}
	return ""
}

func payloadStringValueForLog(payload map[string]any, key string) string {
	value := payloadValueForLog(payload, key)
	switch typed := value.(type) {
	case string:
		return typed
	default:
		return ""
	}
}

func payloadValueForLog(payload map[string]any, key string) any {
	if len(payload) == 0 {
		return nil
	}
	return payload[key]
}

func payloadFieldValueForLog(payload map[string]any, key string, field string) any {
	value := payloadValueForLog(payload, key)
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return object[field]
}

func summarizePayloadValueForLog(value any, limit int) string {
	if payloadValueIsEmpty(value) {
		return ""
	}
	var summary string
	switch typed := value.(type) {
	case string:
		summary = typed
	case map[string]any:
		summary = summarizePayloadMapForLog(typed)
	default:
		summary = fmt.Sprint(typed)
	}
	summary = strings.Join(strings.Fields(summary), " ")
	return trimReportLogSummaryToLength(summary, limit)
}

func summarizePayloadMapForLog(payload map[string]any) string {
	if len(payload) == 0 {
		return ""
	}
	keys := make([]string, 0, len(payload))
	for key := range payload {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		value := summarizePayloadValueForLog(payload[key], maxReportLogErrorLength)
		if value == "" {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s=%s", key, value))
	}
	return strings.Join(parts, " ")
}

func summarizeBodyKinds(hasInput, hasOutput, hasError, hasText bool) string {
	kinds := make([]string, 0, 4)
	if hasInput {
		kinds = append(kinds, "input")
	}
	if hasOutput {
		kinds = append(kinds, "output")
	}
	if hasError {
		kinds = append(kinds, "error")
	}
	if hasText {
		kinds = append(kinds, "text")
	}
	if len(kinds) == 0 {
		return "-"
	}
	return strings.Join(kinds, "+")
}

func turnPatchSummary(turn *agentsessionstore.WorkspaceAgentTurnPatch) string {
	if turn == nil {
		return ""
	}
	parts := []string{logSummaryValue(turn.TurnID)}
	if phase := logSummaryValue(turn.Phase); phase != "-" {
		parts = append(parts, phase)
	}
	if outcome := logSummaryValue(turn.Outcome); outcome != "-" {
		parts = append(parts, outcome)
	}
	return strings.Join(parts, "/")
}

func turnLifecycleSummary(lifecycle *canonical.WorkspaceAgentTurnLifecycle) string {
	if lifecycle == nil {
		return ""
	}
	activeTurnID := ""
	if lifecycle.ActiveTurnID != nil {
		activeTurnID = *lifecycle.ActiveTurnID
	}
	parts := []string{logSummaryValue(activeTurnID), logSummaryValue(lifecycle.Phase)}
	if lifecycle.Outcome != nil {
		if outcome := logSummaryValue(*lifecycle.Outcome); outcome != "-" {
			parts = append(parts, outcome)
		}
	}
	return strings.Join(parts, "/")
}

func rootProviderTurnSummary(turn *canonical.WorkspaceAgentRootProviderTurnTransition) string {
	if turn == nil {
		return ""
	}
	parts := []string{
		logSummaryValue(turn.RootTurnID),
		logSummaryValue(turn.ProviderTurnID),
		logSummaryValue(turn.Phase),
	}
	if outcome := logSummaryValue(turn.Outcome); outcome != "-" {
		parts = append(parts, outcome)
	}
	return strings.Join(parts, "/")
}

func logSummaryValue(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "-"
	}
	return trimReportLogSummary(trimmed)
}

func trimReportLogSummary(value string) string {
	return trimReportLogSummaryToLength(value, maxReportLogSummaryLength)
}

func trimReportLogSummaryToLength(value string, limit int) string {
	trimmed := strings.TrimSpace(value)
	if limit <= 3 {
		return trimmed
	}
	if len(trimmed) <= limit {
		return trimmed
	}
	return trimmed[:limit-3] + "..."
}

func minReportLogInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
