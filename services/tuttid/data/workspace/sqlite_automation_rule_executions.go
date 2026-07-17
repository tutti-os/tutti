package workspace

import (
	"context"
	"fmt"
	"strings"
	"time"

	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
)

// RecordAutomationRuleExecution stores one durable launch attempt before the
// target session exists. The primary key over workspace/rule/source/trigger
// makes duplicate trigger deliveries fail loudly instead of double-launching.
func (s *SQLiteStore) RecordAutomationRuleExecution(ctx context.Context, execution automationrulebiz.Execution) error {
	normalized, err := automationrulebiz.NormalizeExecution(execution)
	if err != nil {
		return err
	}
	createdAt := normalized.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}
	updatedAt := normalized.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = createdAt
	}
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO automation_rule_executions (
  workspace_id, rule_id, source_session_id, trigger_id, target_session_id,
  status, failure_reason, total_tokens, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, normalized.WorkspaceID, normalized.RuleID, normalized.SourceSessionID, normalized.TriggerID,
		normalized.TargetSessionID, string(normalized.Status), normalized.FailureReason,
		normalized.TotalTokens, unixMs(createdAt), unixMs(updatedAt)); err != nil {
		return fmt.Errorf("record automation rule execution: %w", err)
	}
	return nil
}

// MarkAutomationRuleExecutionLaunchFailed keeps the failed launch row for
// audit and dedup; a failed launch consumes the trigger rather than retrying.
func (s *SQLiteStore) MarkAutomationRuleExecutionLaunchFailed(ctx context.Context, workspaceID string, targetSessionID string, failureReason string) error {
	if _, err := s.db.ExecContext(ctx, `
UPDATE automation_rule_executions
SET status = ?, failure_reason = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND target_session_id = ?
`, string(automationrulebiz.ExecutionLaunchFailed), strings.TrimSpace(failureReason),
		unixMs(time.Now().UTC()), strings.TrimSpace(workspaceID), strings.TrimSpace(targetSessionID)); err != nil {
		return fmt.Errorf("mark automation rule execution failed: %w", err)
	}
	return nil
}

func (s *SQLiteStore) AutomationRuleExecutionExists(ctx context.Context, workspaceID string, sourceSessionID string, ruleID string, triggerID string) (bool, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM automation_rule_executions
WHERE workspace_id = ? AND source_session_id = ? AND rule_id = ? AND trigger_id = ?
`, strings.TrimSpace(workspaceID), strings.TrimSpace(sourceSessionID), strings.TrimSpace(ruleID), strings.TrimSpace(triggerID))
	var count int
	if err := row.Scan(&count); err != nil {
		return false, fmt.Errorf("automation rule execution lookup: %w", err)
	}
	return count > 0, nil
}

// AutomationRuleUsage counts every launch attempt (including failed ones)
// and sums the recorded target-session token totals for one rule and source
// session.
func (s *SQLiteStore) AutomationRuleUsage(ctx context.Context, workspaceID string, sourceSessionID string, ruleID string) (int, int64, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT COUNT(*), COALESCE(SUM(total_tokens), 0) FROM automation_rule_executions
WHERE workspace_id = ? AND source_session_id = ? AND rule_id = ?
`, strings.TrimSpace(workspaceID), strings.TrimSpace(sourceSessionID), strings.TrimSpace(ruleID))
	var runs int
	var totalTokens int64
	if err := row.Scan(&runs, &totalTokens); err != nil {
		return 0, 0, fmt.Errorf("automation rule usage lookup: %w", err)
	}
	return runs, totalTokens, nil
}

// RecordAutomationTargetUsage settles the launched session's recorded token
// total once; later turns in the same target session do not keep charging
// the rule budget, mirroring the retired CollaborationRun settle-once
// semantics.
func (s *SQLiteStore) RecordAutomationTargetUsage(ctx context.Context, workspaceID string, targetSessionID string, totalTokens int64) error {
	if totalTokens < 0 {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, `
UPDATE automation_rule_executions
SET total_tokens = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND target_session_id = ? AND total_tokens = 0
`, totalTokens, unixMs(time.Now().UTC()), strings.TrimSpace(workspaceID), strings.TrimSpace(targetSessionID)); err != nil {
		return fmt.Errorf("record automation target usage: %w", err)
	}
	return nil
}
