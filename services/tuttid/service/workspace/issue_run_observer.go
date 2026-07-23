package workspace

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"

	canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

// ObserveAgentSessionState settles Issue runs from the authoritative Agent
// turn lifecycle. Issue Agents are not required to call the Issue Manager CLI
// themselves, so a normal completed turn cannot be mistaken for a vanished
// session by the fallback reconciler.
func (c *IssueExecutionCoordinator) ObserveAgentSessionState(ctx context.Context, input canonical.ReportSessionStateInput, _ canonical.ReportSessionStateReply) {
	status, ok := issueRunStatusFromSessionState(input.State)
	if !ok || c == nil || c.Issues == nil || c.Issues.Store == nil {
		return
	}
	usage := issueRunUsageFromRuntimeContext(input.State.RuntimeContext)
	remainingQuota, hasRemainingQuota := issueRunRemainingQuota(input.State.RuntimeContext)
	settledTurnID := ""
	if input.State.Turn != nil {
		settledTurnID = strings.TrimSpace(input.State.Turn.TurnID)
	}
	errorMessage := ""
	if status != workspaceissues.StatusCompleted {
		errorMessage = strings.TrimSpace(input.State.LastError)
	}
	c.ObserveRunSettlement(ctx, IssueRunSettlement{
		WorkspaceID:              input.WorkspaceID,
		AgentSessionID:           input.AgentSessionID,
		TurnID:                   settledTurnID,
		Status:                   status,
		ErrorMessage:             errorMessage,
		Usage:                    usage,
		RemainingQuotaPercent:    remainingQuota,
		HasRemainingQuotaPercent: hasRemainingQuota,
	})
}

func (c *IssueExecutionCoordinator) ObserveRunSettlement(ctx context.Context, settlement IssueRunSettlement) {
	if c == nil || c.Issues == nil || c.Issues.Store == nil {
		return
	}
	workspaceID := strings.TrimSpace(settlement.WorkspaceID)
	agentSessionID := strings.TrimSpace(settlement.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return
	}
	runs, err := c.Issues.domainService().ListRunningRuns(ctx, workspaceID, defaultIssueRunReconcileLimit)
	if err != nil {
		slog.Warn("list running Issue runs for Agent settlement failed",
			"event", "workspace_issue.agent_settlement_list_failed",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"error", err,
		)
		return
	}
	settledTurnID := strings.TrimSpace(settlement.TurnID)
	for _, run := range runs {
		if strings.TrimSpace(run.AgentSessionID) != agentSessionID {
			continue
		}
		// A delegate session can settle turns that are not the run's own
		// brief (a human interjecting in its conversation, queued guidance).
		// Match the settled turn against the run's initiating submit so only
		// the run's own terminal fact completes it. An unresolved identity is
		// not evidence of settlement: fail closed and let reconciliation retry.
		if c.SettlementReader == nil || settledTurnID == "" {
			c.Issues.enqueueWorkspaceRunReconcile(workspaceID)
			continue
		}
		canonicalSettlement, found, resolveErr := c.SettlementReader.ReadRunSettlement(ctx, workspaceID, agentSessionID, "issue-run:"+run.RunID)
		if resolveErr != nil || !found || strings.TrimSpace(canonicalSettlement.TurnID) == "" {
			c.Issues.enqueueWorkspaceRunReconcile(workspaceID)
			continue
		}
		if strings.TrimSpace(canonicalSettlement.TurnID) != settledTurnID {
			continue
		}
		settlement.Status = canonicalSettlement.Status
		if canonicalSettlement.ErrorMessage != "" {
			settlement.ErrorMessage = canonicalSettlement.ErrorMessage
		}
		if _, err := c.Issues.CompleteRun(ctx, workspaceID, run.IssueID, run.TaskID, run.RunID, CompleteIssueManagerRunInput{
			Status:                   string(settlement.Status),
			ErrorMessage:             settlement.ErrorMessage,
			Usage:                    settlement.Usage,
			RemainingQuotaPercent:    settlement.RemainingQuotaPercent,
			HasRemainingQuotaPercent: settlement.HasRemainingQuotaPercent,
		}); err != nil {
			slog.Warn("settle Issue run from Agent state failed",
				"event", "workspace_issue.agent_settlement_failed",
				"workspace_id", workspaceID,
				"issue_id", run.IssueID,
				"task_id", run.TaskID,
				"run_id", run.RunID,
				"agent_session_id", agentSessionID,
				"error", err,
			)
		}
	}
}

func issueRunStatusFromSessionState(state canonical.WorkspaceAgentSessionStateUpdate) (workspaceissues.Status, bool) {
	outcome := ""
	if lifecycle := state.TurnLifecycle; lifecycle != nil && strings.TrimSpace(lifecycle.Phase) == "settled" && lifecycle.Outcome != nil {
		outcome = strings.TrimSpace(*lifecycle.Outcome)
	}
	if turn := state.Turn; turn != nil && strings.TrimSpace(turn.Phase) == "settled" && strings.TrimSpace(turn.Outcome) != "" {
		outcome = strings.TrimSpace(turn.Outcome)
	}
	switch outcome {
	case "completed":
		return workspaceissues.StatusCompleted, true
	case "canceled":
		return workspaceissues.StatusCanceled, true
	default:
		if outcome != "" {
			return workspaceissues.StatusFailed, true
		}
		return "", false
	}
}

func issueRunUsageFromRuntimeContext(runtimeContext map[string]any) workspaceissues.TokenUsage {
	usage, _ := runtimeContext["usage"].(map[string]any)
	if last, ok := usage["last"].(map[string]any); ok {
		usage = last
	}
	return workspaceissues.TokenUsage{
		InputTokens:      issueRunInt64(usage, "inputTokens", "input_tokens"),
		OutputTokens:     issueRunInt64(usage, "outputTokens", "output_tokens"),
		CacheReadTokens:  issueRunInt64(usage, "cacheReadTokens", "cache_read_tokens", "cachedInputTokens", "cached_input_tokens", "cacheReadInputTokens", "cache_read_input_tokens"),
		CacheWriteTokens: issueRunInt64(usage, "cacheWriteTokens", "cache_write_tokens", "cacheCreationInputTokens", "cache_creation_input_tokens"),
	}
}

func issueRunRemainingQuota(runtimeContext map[string]any) (float64, bool) {
	usage, _ := runtimeContext["usage"].(map[string]any)
	remaining := float64(0)
	found := false
	consider := func(quota map[string]any) {
		value, ok := issueRunFloat64(quota["percentRemaining"])
		if !ok || value < 0 || value > 100 {
			return
		}
		if !found || value < remaining {
			remaining = value
			found = true
		}
	}
	switch quotas := usage["quotas"].(type) {
	case []any:
		for _, raw := range quotas {
			quota, _ := raw.(map[string]any)
			consider(quota)
		}
	case []map[string]any:
		for _, quota := range quotas {
			consider(quota)
		}
	}
	return remaining, found
}

func issueRunInt64(payload map[string]any, keys ...string) int64 {
	for _, key := range keys {
		switch value := payload[key].(type) {
		case int:
			return maxInt64(int64(value), 0)
		case int64:
			return maxInt64(value, 0)
		case uint64:
			if value <= uint64(^uint64(0)>>1) {
				return int64(value)
			}
		case float64:
			return maxInt64(int64(value), 0)
		case json.Number:
			if parsed, err := value.Int64(); err == nil {
				return maxInt64(parsed, 0)
			}
		}
	}
	return 0
}

func issueRunFloat64(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}
