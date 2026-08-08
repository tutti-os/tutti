package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

// CreateIssueRunWithLaunchIntent atomically claims the task, creates the Run,
// and records the stable external-delivery identity. Recovery can therefore
// redeliver after any crash without creating a second Agent turn.
func (s *SQLiteStore) CreateIssueRunWithLaunchIntent(
	ctx context.Context,
	prepared workspaceissues.PreparedRun,
	clientSubmitID string,
	payloadJSON string,
) (workspaceissues.Run, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Run{}, err
	}
	clientSubmitID = strings.TrimSpace(clientSubmitID)
	if clientSubmitID == "" || prepared.Run.TaskID == "" ||
		prepared.Task.TaskID != prepared.Run.TaskID ||
		prepared.Issue.IssueID != prepared.Run.IssueID {
		return workspaceissues.Run{}, workspaceissues.ErrInvalidArgument
	}
	payloadJSON = strings.TrimSpace(payloadJSON)
	if !json.Valid([]byte(payloadJSON)) {
		return workspaceissues.Run{}, workspaceissues.ErrInvalidArgument
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return workspaceissues.Run{}, fmt.Errorf("begin Issue Run launch admission: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if prepared.TaskIsNew {
		if _, err := insertWorkspaceIssueTask(ctx, tx, prepared.Task); err != nil {
			return workspaceissues.Run{}, err
		}
	}
	if err := insertWorkspaceIssueRun(ctx, tx, prepared.Run); err != nil {
		return workspaceissues.Run{}, err
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_issue_tasks
SET status = 'running', acceptance_state = 'agent_claimed',
    acceptance_summary = '', latest_run_id = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND task_id = ?
`, prepared.Run.RunID, prepared.Run.UpdatedAtUnixMS, prepared.Run.WorkspaceID,
		prepared.Run.IssueID, prepared.Run.TaskID)
	if err != nil {
		return workspaceissues.Run{}, fmt.Errorf("claim Issue Run launch task: %w", err)
	}
	if err := requireRowsAffected(result, workspaceissues.ErrInvalidArgument, "claim Issue Run launch task"); err != nil {
		return workspaceissues.Run{}, err
	}
	if err := projectWorkspaceIssueTasks(
		ctx, tx, prepared.Run.WorkspaceID, prepared.Run.IssueID,
		time.UnixMilli(prepared.Run.UpdatedAtUnixMS).UTC(),
	); err != nil {
		return workspaceissues.Run{}, err
	}
	result, err = tx.ExecContext(ctx, `
UPDATE workspace_issue_topics
SET last_activity_at_unix_ms = ?
WHERE workspace_id = ? AND topic_id = ?
`, prepared.Run.UpdatedAtUnixMS, prepared.Run.WorkspaceID, prepared.Issue.TopicID)
	if err != nil {
		return workspaceissues.Run{}, fmt.Errorf("touch topic during Issue Run launch admission: %w", err)
	}
	if err := requireRowsAffected(result, workspaceissues.ErrTopicNotFound, "touch topic during Issue Run launch admission"); err != nil {
		return workspaceissues.Run{}, err
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_issue_run_launch_intents (
  workspace_id, issue_id, task_id, run_id, launch_intent_id, client_submit_id,
  status, payload_json, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)
`, prepared.Run.WorkspaceID, prepared.Run.IssueID, prepared.Run.TaskID,
		prepared.Run.RunID, "launch-intent:"+prepared.Run.RunID, clientSubmitID,
		payloadJSON, prepared.Run.CreatedAtUnixMS, prepared.Run.UpdatedAtUnixMS)
	if err != nil {
		return workspaceissues.Run{}, fmt.Errorf("create Issue Run launch intent: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return workspaceissues.Run{}, fmt.Errorf("commit Issue Run launch admission: %w", err)
	}
	return s.GetRun(ctx, prepared.Run.WorkspaceID, prepared.Run.IssueID, prepared.Run.TaskID, prepared.Run.RunID)
}

func (s *SQLiteStore) ListPreparedIssueRunLaunches(
	ctx context.Context,
	workspaceID string,
) ([]workspaceissues.PreparedRunLaunch, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return nil, err
	}
	rows, err := s.readDB.QueryContext(ctx, fmt.Sprintf(`
SELECT %s, intents.client_submit_id, intents.payload_json
FROM workspace_issue_runs AS runs
JOIN workspace_issue_run_launch_intents AS intents
  ON intents.workspace_id = runs.workspace_id
 AND intents.issue_id = runs.issue_id
 AND intents.task_id = runs.task_id
 AND intents.run_id = runs.run_id
JOIN workspace_issues AS issues
  ON issues.workspace_id = runs.workspace_id
 AND issues.issue_id = runs.issue_id
WHERE runs.workspace_id = ? AND runs.status = 'running'
  AND intents.status = 'prepared'
  AND issues.dispatch_paused = 0
  AND issues.planning_source <> ?
ORDER BY runs.created_at_unix_ms ASC, runs.id ASC
`, prefixedRunSelectColumns("runs")), strings.TrimSpace(workspaceID),
		string(workspaceissues.PlanningSourceTuttiModePlan))
	if err != nil {
		return nil, fmt.Errorf("list prepared Issue Run launches: %w", err)
	}
	defer rows.Close()
	launches := make([]workspaceissues.PreparedRunLaunch, 0)
	for rows.Next() {
		var payloadJSON string
		run, clientSubmitID, err := scanPreparedIssueRunLaunch(rows, &payloadJSON)
		if err != nil {
			return nil, err
		}
		launches = append(launches, workspaceissues.PreparedRunLaunch{
			Run: run, ClientSubmitID: clientSubmitID, OpaquePayload: payloadJSON,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate prepared Issue Run launches: %w", err)
	}
	return launches, nil
}

// HasPendingIssueRunLaunch reports whether deleting the Issue (taskID empty)
// or one task would destroy an explicit launch while external delivery is
// still pending or in flight.
func (s *SQLiteStore) HasPendingIssueRunLaunch(
	ctx context.Context,
	workspaceID, issueID, taskID string,
) (bool, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return false, err
	}
	var found int
	err := s.readDB.QueryRowContext(ctx, `
SELECT 1
FROM workspace_issue_run_launch_intents
WHERE workspace_id = ? AND issue_id = ?
  AND status IN ('prepared', 'leased')
  AND (? = '' OR task_id = ?)
LIMIT 1
`, strings.TrimSpace(workspaceID), strings.TrimSpace(issueID), strings.TrimSpace(taskID), strings.TrimSpace(taskID)).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("find pending Issue Run launch: %w", err)
	}
	return found == 1, nil
}

func (s *SQLiteStore) ClaimIssueRunLaunchIntent(
	ctx context.Context,
	workspaceID, issueID, runID, leaseOwner string,
	now, leaseExpires time.Time,
) (bool, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return false, err
	}
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_launch_intents
SET status = 'leased', attempt_count = attempt_count + 1,
    lease_owner = ?, lease_expires_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND run_id = ? AND status = 'prepared'
  AND EXISTS (
    SELECT 1 FROM workspace_issue_runs AS runs
    JOIN workspace_issues AS issues
      ON issues.workspace_id = runs.workspace_id AND issues.issue_id = runs.issue_id
    WHERE runs.workspace_id = workspace_issue_run_launch_intents.workspace_id
      AND runs.issue_id = workspace_issue_run_launch_intents.issue_id
      AND runs.run_id = workspace_issue_run_launch_intents.run_id
      AND runs.status = 'running' AND issues.dispatch_paused = 0
      AND issues.planning_source <> ?
  )
`, strings.TrimSpace(leaseOwner), unixMs(leaseExpires), unixMs(now),
		strings.TrimSpace(workspaceID), strings.TrimSpace(issueID), strings.TrimSpace(runID),
		string(workspaceissues.PlanningSourceTuttiModePlan))
	if err != nil {
		return false, fmt.Errorf("claim Issue Run launch intent: %w", err)
	}
	return rowsWereAffected(result, "claim Issue Run launch intent")
}

func (s *SQLiteStore) RenewIssueRunLaunchIntent(ctx context.Context, workspaceID, issueID, runID, leaseOwner string, now, leaseExpires time.Time) error {
	return s.renewIssueRunLaunchIntent(
		ctx, workspaceID, issueID, runID, leaseOwner, now, leaseExpires,
		workspaceissues.ErrInvalidArgument,
	)
}

func (s *SQLiteStore) ReleaseIssueRunLaunchIntent(ctx context.Context, workspaceID, issueID, runID, leaseOwner string, now time.Time) error {
	return s.releaseIssueRunLaunchIntent(
		ctx, workspaceID, issueID, runID, leaseOwner, now,
		workspaceissues.ErrInvalidArgument,
	)
}

func (s *SQLiteStore) MarkIssueRunLaunchIntentDispatched(ctx context.Context, workspaceID, issueID, runID, leaseOwner string, now time.Time) error {
	return s.markIssueRunLaunchIntentDispatched(
		ctx, workspaceID, issueID, runID, leaseOwner, now,
		workspaceissues.ErrInvalidArgument,
	)
}

// SettleIssueRunLaunch atomically closes an authoritative pre-delivery
// failure/cancellation across the intent, Run, task projection, Issue
// projection, and topic activity.
func (s *SQLiteStore) SettleIssueRunLaunch(
	ctx context.Context,
	settlement workspaceissues.RunLaunchSettlement,
) (workspaceissues.Run, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Run{}, err
	}
	if settlement.Status != workspaceissues.StatusFailed && settlement.Status != workspaceissues.StatusCanceled {
		return workspaceissues.Run{}, workspaceissues.ErrInvalidArgument
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return workspaceissues.Run{}, fmt.Errorf("begin Issue Run launch settlement: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var taskID string
	err = tx.QueryRowContext(ctx, `
SELECT runs.task_id
FROM workspace_issue_runs AS runs
JOIN workspace_issues AS issues
  ON issues.workspace_id = runs.workspace_id AND issues.issue_id = runs.issue_id
WHERE runs.workspace_id = ? AND runs.issue_id = ? AND runs.run_id = ?
  AND runs.status = 'running' AND issues.planning_source <> ?
`, settlement.WorkspaceID, settlement.IssueID, settlement.RunID,
		string(workspaceissues.PlanningSourceTuttiModePlan)).Scan(&taskID)
	if errors.Is(err, sql.ErrNoRows) {
		return workspaceissues.Run{}, workspaceissues.ErrRunNotFound
	}
	if err != nil {
		return workspaceissues.Run{}, fmt.Errorf("get running Issue Run launch settlement: %w", err)
	}
	intentStatus := "failed"
	if settlement.Status == workspaceissues.StatusCanceled {
		intentStatus = "canceled"
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_issue_run_launch_intents
SET status = ?, lease_owner = '', lease_expires_at_unix_ms = 0,
    last_error = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
  AND status = 'leased' AND lease_owner = ?
`, intentStatus, strings.TrimSpace(settlement.ErrorMessage), settlement.NowUnixMS,
		settlement.WorkspaceID, settlement.IssueID, settlement.RunID, settlement.LeaseOwner)
	if err != nil {
		return workspaceissues.Run{}, fmt.Errorf("settle Issue Run launch intent: %w", err)
	}
	if err := requireRowsAffected(result, workspaceissues.ErrInvalidArgument, "settle owned Issue Run launch intent"); err != nil {
		return workspaceissues.Run{}, err
	}
	result, err = tx.ExecContext(ctx, `
UPDATE workspace_issue_runs
SET status = ?, error_message = ?, completed_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND task_id = ? AND run_id = ?
  AND status = 'running'
`, string(settlement.Status), strings.TrimSpace(settlement.ErrorMessage), settlement.NowUnixMS,
		settlement.NowUnixMS, settlement.WorkspaceID, settlement.IssueID, taskID, settlement.RunID)
	if err != nil {
		return workspaceissues.Run{}, fmt.Errorf("settle Issue Run before launch: %w", err)
	}
	if err := requireRowsAffected(result, workspaceissues.ErrRunNotFound, "settle running Issue Run before launch"); err != nil {
		return workspaceissues.Run{}, err
	}
	result, err = tx.ExecContext(ctx, `
UPDATE workspace_issue_tasks
SET status = ?, acceptance_state = 'agent_claimed', acceptance_summary = '',
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND task_id = ?
  AND status = 'running' AND latest_run_id = ?
`, string(settlement.Status), settlement.NowUnixMS, settlement.WorkspaceID,
		settlement.IssueID, taskID, settlement.RunID)
	if err != nil {
		return workspaceissues.Run{}, fmt.Errorf("settle Issue task before launch: %w", err)
	}
	if err := requireRowsAffected(result, workspaceissues.ErrTaskNotFound, "settle running Issue task before launch"); err != nil {
		return workspaceissues.Run{}, err
	}
	if err := projectWorkspaceIssueTasks(
		ctx, tx, settlement.WorkspaceID, settlement.IssueID,
		time.UnixMilli(settlement.NowUnixMS).UTC(),
	); err != nil {
		return workspaceissues.Run{}, err
	}
	result, err = tx.ExecContext(ctx, `
UPDATE workspace_issue_topics
SET last_activity_at_unix_ms = ?
WHERE workspace_id = ? AND topic_id = (
  SELECT topic_id FROM workspace_issues WHERE workspace_id = ? AND issue_id = ?
)
`, settlement.NowUnixMS, settlement.WorkspaceID, settlement.WorkspaceID, settlement.IssueID)
	if err != nil {
		return workspaceissues.Run{}, fmt.Errorf("touch topic after Issue Run launch settlement: %w", err)
	}
	if err := requireRowsAffected(result, workspaceissues.ErrTopicNotFound, "touch topic after Issue Run launch settlement"); err != nil {
		return workspaceissues.Run{}, err
	}
	if err := tx.Commit(); err != nil {
		return workspaceissues.Run{}, fmt.Errorf("commit Issue Run launch settlement: %w", err)
	}
	return s.GetRun(ctx, settlement.WorkspaceID, settlement.IssueID, taskID, settlement.RunID)
}

func (s *SQLiteStore) RequeueLeasedIssueRunLaunchIntents(ctx context.Context, workspaceID string, now time.Time) error {
	return s.requeueLeasedIssueRunLaunchIntents(ctx, workspaceID, now)
}
