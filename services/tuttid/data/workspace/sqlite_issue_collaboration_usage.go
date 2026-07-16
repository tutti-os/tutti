package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
)

func (s *SQLiteStore) ResolveIssueCollaborationUsageLink(ctx context.Context, run collabrunbiz.Run) (IssueCollaborationUsageLink, bool, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return IssueCollaborationUsageLink{}, false, err
	}
	workspaceID := strings.TrimSpace(run.WorkspaceID)
	if workspaceID == "" {
		return IssueCollaborationUsageLink{}, false, nil
	}

	if targetSessionID := strings.TrimSpace(run.TargetSessionID); targetSessionID != "" {
		var issueID string
		var taskID string
		err := s.db.QueryRowContext(ctx, `
SELECT issue_id, task_id
FROM workspace_issue_runs
WHERE workspace_id = ? AND agent_session_id = ?
ORDER BY created_at_unix_ms DESC, id DESC
LIMIT 1
`, workspaceID, targetSessionID).Scan(&issueID, &taskID)
		if err == nil {
			return IssueCollaborationUsageLink{IssueID: issueID, TaskID: taskID, DuplicateTaskRun: true}, true, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return IssueCollaborationUsageLink{}, false, fmt.Errorf("resolve duplicate issue collaboration target: %w", err)
		}
	}

	sourceSessionID := strings.TrimSpace(run.SourceSessionID)
	if sourceSessionID == "" {
		return IssueCollaborationUsageLink{}, false, nil
	}
	var issueID string
	var taskID string
	err := s.db.QueryRowContext(ctx, `
SELECT issue_id, task_id
FROM workspace_issue_runs
WHERE workspace_id = ? AND agent_session_id = ?
ORDER BY created_at_unix_ms DESC, id DESC
LIMIT 1
`, workspaceID, sourceSessionID).Scan(&issueID, &taskID)
	if err == nil {
		return IssueCollaborationUsageLink{IssueID: issueID, TaskID: taskID}, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return IssueCollaborationUsageLink{}, false, fmt.Errorf("resolve issue collaboration source run: %w", err)
	}

	err = s.db.QueryRowContext(ctx, `
SELECT issue_id, task_id
FROM workspace_issue_collaboration_usage
WHERE workspace_id = ? AND target_session_id = ?
ORDER BY created_at_unix_ms DESC, collaboration_run_id DESC
LIMIT 1
`, workspaceID, sourceSessionID).Scan(&issueID, &taskID)
	if err == nil {
		return IssueCollaborationUsageLink{IssueID: issueID, TaskID: taskID}, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return IssueCollaborationUsageLink{}, false, fmt.Errorf("resolve descendant issue collaboration source: %w", err)
	}

	createdAtUnixMS := unixMsOrZero(run.CreatedAt)
	if createdAtUnixMS <= 0 {
		return IssueCollaborationUsageLink{}, false, nil
	}
	err = s.db.QueryRowContext(ctx, `
SELECT issue_id
FROM workspace_issues
WHERE workspace_id = ? AND source_session_id = ? AND created_at_unix_ms <= ?
ORDER BY created_at_unix_ms DESC, id DESC
LIMIT 1
`, workspaceID, sourceSessionID, createdAtUnixMS).Scan(&issueID)
	if err == nil {
		return IssueCollaborationUsageLink{IssueID: issueID}, true, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return IssueCollaborationUsageLink{}, false, nil
	}
	return IssueCollaborationUsageLink{}, false, fmt.Errorf("resolve planning-session issue collaboration: %w", err)
}

func (s *SQLiteStore) RecordIssueCollaborationUsage(ctx context.Context, link IssueCollaborationUsageLink, run collabrunbiz.Run) (bool, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return false, err
	}
	if link.DuplicateTaskRun || strings.TrimSpace(link.IssueID) == "" || strings.TrimSpace(run.ID) == "" {
		return false, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin issue collaboration usage transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	result, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO workspace_issue_collaboration_usage (
  workspace_id, issue_id, task_id, collaboration_run_id,
  source_session_id, target_session_id, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, cost_currency,
  estimated_cost_micros, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, run.WorkspaceID, link.IssueID, link.TaskID, run.ID,
		run.SourceSessionID, run.TargetSessionID, run.Usage.InputTokens, run.Usage.OutputTokens,
		run.Usage.CacheReadTokens, run.Usage.CacheWriteTokens, run.Cost.Currency,
		run.Cost.EstimatedMicros, unixMs(run.UpdatedAt))
	if err != nil {
		return false, fmt.Errorf("insert issue collaboration usage: %w", err)
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("read issue collaboration usage insert result: %w", err)
	}
	if inserted == 0 {
		if err := tx.Commit(); err != nil {
			return false, fmt.Errorf("commit duplicate issue collaboration usage: %w", err)
		}
		return false, nil
	}

	totalTokens := run.Usage.Total()
	updatedAtUnixMS := unixMs(run.UpdatedAt)
	result, err = tx.ExecContext(ctx, `
UPDATE workspace_issues
SET budget_consumed_tokens = budget_consumed_tokens + ?,
    budget_status = CASE
      WHEN budget_token_limit > 0 AND budget_consumed_tokens + ? >= budget_token_limit
        THEN 'soft_limited'
      ELSE budget_status
    END,
    estimated_cost_micros = estimated_cost_micros + CASE
      WHEN ? <> '' AND cost_currency = ? THEN ?
      ELSE 0
    END,
    updated_at_unix_ms = MAX(updated_at_unix_ms, ?)
WHERE workspace_id = ? AND issue_id = ?
`, totalTokens, totalTokens, run.Cost.Currency, run.Cost.Currency,
		run.Cost.EstimatedMicros, updatedAtUnixMS, run.WorkspaceID, link.IssueID)
	if err != nil {
		return false, fmt.Errorf("update issue collaboration usage projection: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil {
		return false, fmt.Errorf("read issue collaboration projection result: %w", err)
	} else if affected == 0 {
		return false, fmt.Errorf("record issue collaboration usage: issue not found")
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit issue collaboration usage: %w", err)
	}
	return true, nil
}

func (s *SQLiteStore) GetIssueCollaborationUsageTotals(ctx context.Context, workspaceID string, issueID string, currency string) (IssueCollaborationUsageTotals, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return IssueCollaborationUsageTotals{}, err
	}
	var totals IssueCollaborationUsageTotals
	totals.Cost.Currency = strings.TrimSpace(currency)
	err := s.db.QueryRowContext(ctx, `
SELECT
  COALESCE(SUM(input_tokens), 0),
  COALESCE(SUM(output_tokens), 0),
  COALESCE(SUM(cache_read_tokens), 0),
  COALESCE(SUM(cache_write_tokens), 0),
  COALESCE(SUM(CASE WHEN cost_currency = ? THEN estimated_cost_micros ELSE 0 END), 0)
FROM workspace_issue_collaboration_usage
WHERE workspace_id = ? AND issue_id = ?
`, totals.Cost.Currency, workspaceID, issueID).Scan(
		&totals.Usage.InputTokens,
		&totals.Usage.OutputTokens,
		&totals.Usage.CacheReadTokens,
		&totals.Usage.CacheWriteTokens,
		&totals.Cost.EstimatedMicros,
	)
	if err != nil {
		return IssueCollaborationUsageTotals{}, fmt.Errorf("sum issue collaboration usage: %w", err)
	}
	return totals, nil
}
