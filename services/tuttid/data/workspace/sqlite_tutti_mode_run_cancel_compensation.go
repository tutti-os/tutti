package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

func (s *SQLiteStore) EnsureTuttiModeRunCancelCompensation(
	ctx context.Context,
	workspaceID string,
	issueID string,
	taskID string,
	runID string,
	now time.Time,
) (bool, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return false, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	issueID = strings.TrimSpace(issueID)
	taskID = strings.TrimSpace(taskID)
	runID = strings.TrimSpace(runID)
	if _, err := s.writeDB.ExecContext(ctx, `
INSERT OR IGNORE INTO workspace_issue_run_cancel_compensations (
  workspace_id, issue_id, task_id, run_id, agent_session_id, client_submit_id,
  status, created_at_unix_ms, updated_at_unix_ms
)
SELECT r.workspace_id, r.issue_id, r.task_id, r.run_id, r.agent_session_id,
       i.client_submit_id, 'prepared', ?, ?
FROM workspace_issue_runs r
JOIN workspace_issue_run_launch_intents i
  ON i.workspace_id = r.workspace_id AND i.issue_id = r.issue_id
 AND i.task_id = r.task_id AND i.run_id = r.run_id
WHERE r.workspace_id = ? AND r.issue_id = ? AND r.task_id = ? AND r.run_id = ?
`, unixMs(now), unixMs(now), workspaceID, issueID, taskID, runID); err != nil {
		return false, fmt.Errorf("ensure Tutti mode Run cancel compensation: %w", err)
	}
	var found int
	err := s.readDB.QueryRowContext(ctx, `
SELECT 1
FROM workspace_issue_run_cancel_compensations
WHERE workspace_id = ? AND issue_id = ? AND task_id = ? AND run_id = ?
`, workspaceID, issueID, taskID, runID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("get Tutti mode Run cancel compensation: %w", err)
	}
	return true, nil
}

func (s *SQLiteStore) ListPreparedTuttiModeRunCancelCompensations(
	ctx context.Context,
	workspaceID string,
) ([]executionbiz.RunCancelCompensation, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return nil, err
	}
	rows, err := s.readDB.QueryContext(ctx, `
SELECT workspace_id, issue_id, task_id, run_id, agent_session_id, client_submit_id
FROM workspace_issue_run_cancel_compensations
WHERE workspace_id = ? AND status = 'prepared'
ORDER BY created_at_unix_ms ASC, run_id ASC
`, strings.TrimSpace(workspaceID))
	if err != nil {
		return nil, fmt.Errorf("list Tutti mode Run cancel compensations: %w", err)
	}
	defer rows.Close()
	var items []executionbiz.RunCancelCompensation
	for rows.Next() {
		var item executionbiz.RunCancelCompensation
		if err := rows.Scan(
			&item.WorkspaceID,
			&item.IssueID,
			&item.TaskID,
			&item.RunID,
			&item.AgentSessionID,
			&item.ClientSubmitID,
		); err != nil {
			return nil, fmt.Errorf("scan Tutti mode Run cancel compensation: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate Tutti mode Run cancel compensations: %w", err)
	}
	return items, nil
}

func (s *SQLiteStore) ClaimTuttiModeRunCancelCompensation(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
	leaseOwner string,
	now time.Time,
	leaseExpires time.Time,
) (bool, error) {
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_cancel_compensations
SET status = 'leased', attempt_count = attempt_count + 1,
    lease_owner = ?, lease_expires_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND run_id = ? AND status = 'prepared'
`, strings.TrimSpace(leaseOwner), unixMs(leaseExpires), unixMs(now),
		strings.TrimSpace(workspaceID), strings.TrimSpace(issueID),
		strings.TrimSpace(runID))
	if err != nil {
		return false, fmt.Errorf("claim Tutti mode Run cancel compensation: %w", err)
	}
	return rowsWereAffected(result, "claim Tutti mode Run cancel compensation")
}

func (s *SQLiteStore) ReleaseTuttiModeRunCancelCompensation(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
	leaseOwner string,
	message string,
	now time.Time,
) error {
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_cancel_compensations
SET status = 'prepared', lease_owner = '', lease_expires_at_unix_ms = 0,
    last_error = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
  AND status = 'leased' AND lease_owner = ?
`, strings.TrimSpace(message), unixMs(now), strings.TrimSpace(workspaceID),
		strings.TrimSpace(issueID), strings.TrimSpace(runID),
		strings.TrimSpace(leaseOwner))
	if err != nil {
		return fmt.Errorf("release Tutti mode Run cancel compensation: %w", err)
	}
	return requireRowsAffected(
		result, executionbiz.ErrScheduleRejected,
		"release owned Tutti mode Run cancel compensation",
	)
}

func (s *SQLiteStore) CompleteTuttiModeRunCancelCompensation(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
	leaseOwner string,
	now time.Time,
) error {
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_cancel_compensations
SET status = 'completed', lease_owner = '', lease_expires_at_unix_ms = 0,
    last_error = '', completed_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
  AND status = 'leased' AND lease_owner = ?
`, unixMs(now), unixMs(now), strings.TrimSpace(workspaceID),
		strings.TrimSpace(issueID), strings.TrimSpace(runID),
		strings.TrimSpace(leaseOwner))
	if err != nil {
		return fmt.Errorf("complete Tutti mode Run cancel compensation: %w", err)
	}
	return requireRowsAffected(
		result, executionbiz.ErrScheduleRejected,
		"complete owned Tutti mode Run cancel compensation",
	)
}

func (s *SQLiteStore) RequeueLeasedTuttiModeRunCancelCompensations(
	ctx context.Context,
	workspaceID string,
	now time.Time,
) error {
	if _, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_cancel_compensations
SET status = 'prepared', lease_owner = '', lease_expires_at_unix_ms = 0,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND status = 'leased'
  AND lease_expires_at_unix_ms <= ?
`, unixMs(now), strings.TrimSpace(workspaceID), unixMs(now)); err != nil {
		return fmt.Errorf("requeue Tutti mode Run cancel compensations: %w", err)
	}
	return nil
}
