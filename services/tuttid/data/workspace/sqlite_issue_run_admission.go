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
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

func (s *SQLiteStore) AdmitTuttiModeSchedule(
	ctx context.Context,
	admission executionbiz.ScheduleAdmission,
) (executionbiz.ScheduleResult, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return executionbiz.ScheduleResult{}, err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return executionbiz.ScheduleResult{}, fmt.Errorf("begin Tutti mode schedule admission: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	replayed, found, err := getTuttiModeScheduleReplay(ctx, tx, admission)
	if err != nil {
		return executionbiz.ScheduleResult{}, err
	}
	if found {
		return replayed, nil
	}

	executionID, err := validateTuttiModeScheduleFence(ctx, tx, admission)
	if err != nil {
		return executionbiz.ScheduleResult{}, err
	}
	if err := acceptTuttiModeSettlementSubjectForSchedule(
		ctx, tx, executionID, admission,
	); err != nil {
		return executionbiz.ScheduleResult{}, err
	}
	tasks, issue, err := validateTuttiModeScheduleTasks(ctx, tx, admission)
	if err != nil {
		return executionbiz.ScheduleResult{}, err
	}
	if err := validateTuttiModeScheduleCapacity(ctx, tx, admission.WorkspaceID, issue, len(tasks)); err != nil {
		return executionbiz.ScheduleResult{}, err
	}
	if err := insertTuttiModeScheduledRuns(ctx, tx, admission, tasks); err != nil {
		return executionbiz.ScheduleResult{}, err
	}
	if err := projectScheduledTuttiModeIssue(ctx, tx, admission.WorkspaceID, admission.IssueID, admission.Now); err != nil {
		return executionbiz.ScheduleResult{}, err
	}
	if err := resolveTuttiModeScheduleCheckpoint(ctx, tx, executionID, admission); err != nil {
		return executionbiz.ScheduleResult{}, err
	}

	result := executionbiz.ScheduleResult{
		ExecutionID:   executionID,
		CheckpointID:  admission.CheckpointID,
		GraphRevision: admission.ExpectedGraphRevision,
		RunIDs:        make([]string, 0, len(admission.Runs)),
	}
	for _, run := range admission.Runs {
		result.RunIDs = append(result.RunIDs, run.RunID)
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return executionbiz.ScheduleResult{}, fmt.Errorf("encode Tutti mode schedule result: %w", err)
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_tutti_execution_mutations (
  workspace_id, execution_id, issue_id, source_session_id, kind, request_id,
  input_sha256, checkpoint_id, expected_graph_revision, result_graph_revision,
  result_json, created_at_unix_ms
) VALUES (?, ?, ?, ?, 'schedule', ?, ?, ?, ?, ?, ?, ?)
`, admission.WorkspaceID, executionID, admission.IssueID, admission.SourceSessionID,
		admission.RequestID, admission.InputSHA256, admission.CheckpointID,
		admission.ExpectedGraphRevision, admission.ExpectedGraphRevision,
		string(resultJSON), unixMs(admission.Now))
	if err != nil {
		if isSQLiteUniqueConstraintError(err) {
			return executionbiz.ScheduleResult{}, executionbiz.ErrScheduleMutationConflict
		}
		return executionbiz.ScheduleResult{}, fmt.Errorf("record Tutti mode schedule mutation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return executionbiz.ScheduleResult{}, fmt.Errorf("commit Tutti mode schedule admission: %w", err)
	}
	return result, nil
}

func acceptTuttiModeSettlementSubjectForSchedule(
	ctx context.Context,
	tx *sql.Tx,
	executionID string,
	admission executionbiz.ScheduleAdmission,
) error {
	var kind, subjectTaskID, subjectRunID string
	err := tx.QueryRowContext(ctx, `
SELECT kind, subject_task_id, subject_run_id
FROM workspace_tutti_execution_checkpoints
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
`, admission.WorkspaceID, executionID, admission.CheckpointID).
		Scan(&kind, &subjectTaskID, &subjectRunID)
	if err != nil {
		return fmt.Errorf("get scheduled settlement subject: %w", err)
	}
	if kind != string(executionbiz.CheckpointKindTaskSettled) {
		return nil
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_issue_tasks
SET status = 'completed', acceptance_state = 'user_accepted',
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND task_id = ?
  AND status = 'pending_acceptance'
  AND EXISTS (
    SELECT 1 FROM workspace_issue_runs
    WHERE workspace_id = ? AND issue_id = ? AND task_id = ?
      AND run_id = ? AND status = 'completed'
  )
`, unixMs(admission.Now), admission.WorkspaceID, admission.IssueID, subjectTaskID,
		admission.WorkspaceID, admission.IssueID, subjectTaskID, subjectRunID)
	if err != nil {
		return fmt.Errorf("accept settlement subject for schedule: %w", err)
	}
	return requireRowsAffected(
		result, executionbiz.ErrScheduleRejected,
		"accept settlement subject for schedule",
	)
}

func getTuttiModeScheduleReplay(
	ctx context.Context,
	tx *sql.Tx,
	admission executionbiz.ScheduleAdmission,
) (executionbiz.ScheduleResult, bool, error) {
	var inputSHA256, resultJSON string
	err := tx.QueryRowContext(ctx, `
SELECT input_sha256, result_json
FROM workspace_tutti_execution_mutations
WHERE workspace_id = ? AND source_session_id = ? AND kind = 'schedule'
  AND issue_id = ? AND request_id = ?
`, admission.WorkspaceID, admission.SourceSessionID, admission.IssueID, admission.RequestID).
		Scan(&inputSHA256, &resultJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return executionbiz.ScheduleResult{}, false, nil
	}
	if err != nil {
		return executionbiz.ScheduleResult{}, false, fmt.Errorf("get Tutti mode schedule replay: %w", err)
	}
	if inputSHA256 != admission.InputSHA256 {
		return executionbiz.ScheduleResult{}, false, executionbiz.ErrScheduleMutationConflict
	}
	var result executionbiz.ScheduleResult
	if err := json.Unmarshal([]byte(resultJSON), &result); err != nil {
		return executionbiz.ScheduleResult{}, false, fmt.Errorf("decode Tutti mode schedule replay: %w", err)
	}
	result.Replayed = true
	return result, true, nil
}

func validateTuttiModeScheduleFence(
	ctx context.Context,
	tx *sql.Tx,
	admission executionbiz.ScheduleAdmission,
) (string, error) {
	var executionID, sourceSessionID, status string
	var graphRevision int64
	err := tx.QueryRowContext(ctx, `
SELECT execution_id, source_session_id, status, graph_revision
FROM workspace_tutti_executions
WHERE workspace_id = ? AND issue_id = ?
`, admission.WorkspaceID, admission.IssueID).
		Scan(&executionID, &sourceSessionID, &status, &graphRevision)
	if errors.Is(err, sql.ErrNoRows) {
		return "", executionbiz.ErrExecutionNotFound
	}
	if err != nil {
		return "", fmt.Errorf("get Tutti mode execution schedule fence: %w", err)
	}
	if sourceSessionID != admission.SourceSessionID ||
		graphRevision != admission.ExpectedGraphRevision ||
		(status != string(executionbiz.StatusAwaitingSchedule) &&
			status != string(executionbiz.StatusAwaitingMain)) {
		return "", executionbiz.ErrScheduleRejected
	}
	var checkpointStatus string
	var checkpointRevision int64
	err = tx.QueryRowContext(ctx, `
SELECT status, graph_revision
FROM workspace_tutti_execution_checkpoints
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
`, admission.WorkspaceID, executionID, admission.CheckpointID).
		Scan(&checkpointStatus, &checkpointRevision)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", executionbiz.ErrScheduleRejected
		}
		return "", fmt.Errorf("get Tutti mode schedule checkpoint fence: %w", err)
	}
	if checkpointStatus != string(executionbiz.CheckpointStatusActive) ||
		checkpointRevision != admission.ExpectedGraphRevision {
		return "", executionbiz.ErrScheduleRejected
	}
	return executionID, nil
}

func validateTuttiModeScheduleTasks(
	ctx context.Context,
	tx *sql.Tx,
	admission executionbiz.ScheduleAdmission,
) (map[string]workspaceissues.Task, workspaceissues.Issue, error) {
	row := tx.QueryRowContext(ctx, fmt.Sprintf(`
SELECT %s
FROM workspace_issues
WHERE workspace_id = ? AND issue_id = ?
`, issueSelectColumns), admission.WorkspaceID, admission.IssueID)
	issue, err := scanWorkspaceIssue(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, workspaceissues.Issue{}, workspaceissues.ErrIssueNotFound
	}
	if err != nil {
		return nil, workspaceissues.Issue{}, fmt.Errorf("get scheduled Tutti mode Issue: %w", err)
	}
	if issue.PlanningSource != workspaceissues.PlanningSourceTuttiModePlan ||
		issue.SourceSessionID != admission.SourceSessionID || issue.DispatchPaused ||
		issue.Budget.Status != workspaceissues.BudgetStatusActive {
		return nil, workspaceissues.Issue{}, executionbiz.ErrScheduleRejected
	}

	rows, err := tx.QueryContext(ctx, fmt.Sprintf(`
SELECT %s
FROM workspace_issue_tasks
WHERE workspace_id = ? AND issue_id = ? AND superseded_at_unix_ms = 0
ORDER BY sort_index ASC, id ASC
`, taskSelectColumns), admission.WorkspaceID, admission.IssueID)
	if err != nil {
		return nil, workspaceissues.Issue{}, fmt.Errorf("list tasks for Tutti mode schedule: %w", err)
	}
	allTasks, err := scanWorkspaceIssueTasks(rows)
	closeErr := rows.Close()
	if err != nil {
		return nil, workspaceissues.Issue{}, err
	}
	if closeErr != nil {
		return nil, workspaceissues.Issue{}, fmt.Errorf("close tasks for Tutti mode schedule: %w", closeErr)
	}
	byID := make(map[string]workspaceissues.Task, len(allTasks))
	for _, task := range allTasks {
		byID[task.TaskID] = task
	}
	selected := make(map[string]workspaceissues.Task, len(admission.Runs))
	for _, run := range admission.Runs {
		if _, duplicate := selected[run.TaskID]; duplicate {
			return nil, workspaceissues.Issue{}, executionbiz.ErrScheduleRejected
		}
		task, ok := byID[run.TaskID]
		if !ok || !workspaceissues.IssueTaskEligibleForRun(task, byID) {
			return nil, workspaceissues.Issue{}, executionbiz.ErrScheduleRejected
		}
		selected[run.TaskID] = task
	}
	return selected, issue, nil
}

func validateTuttiModeScheduleCapacity(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	issue workspaceissues.Issue,
	requested int,
) error {
	var running, activeIssueRuns int
	if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*), COALESCE(SUM(CASE WHEN issue_id = ? THEN 1 ELSE 0 END), 0)
FROM workspace_issue_runs
WHERE workspace_id = ? AND status = 'running' AND TRIM(agent_session_id) <> ''
`, issue.IssueID, workspaceID).Scan(&running, &activeIssueRuns); err != nil {
		return fmt.Errorf("count running Issue Runs for Tutti mode schedule: %w", err)
	}
	if requested < 1 ||
		requested > workspaceissues.IssueAutomaticRunAdmissionSlots(issue, running, activeIssueRuns) {
		return executionbiz.ErrScheduleRejected
	}
	return nil
}

func insertTuttiModeScheduledRuns(
	ctx context.Context,
	tx *sql.Tx,
	admission executionbiz.ScheduleAdmission,
	tasks map[string]workspaceissues.Task,
) error {
	for _, run := range admission.Runs {
		task := tasks[run.TaskID]
		_, err := tx.ExecContext(ctx, `
INSERT INTO workspace_issue_runs (
  run_id, task_id, issue_id, workspace_id, requester_user_id, agent_user_id,
  agent_target_id, agent_session_id, agent_provider, model_plan_id, model,
  reasoning_intensity, status, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, summary, error_message, output_dir, execution_directory,
  created_at_unix_ms, started_at_unix_ms, completed_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, run.RunID, run.TaskID, run.IssueID, run.WorkspaceID, run.RequesterUserID,
			run.AgentUserID, run.AgentTargetID, run.AgentSessionID, run.AgentProvider,
			run.ModelPlanID, run.Model, run.ReasoningIntensity, string(run.Status),
			run.Usage.InputTokens, run.Usage.OutputTokens, run.Usage.CacheReadTokens,
			run.Usage.CacheWriteTokens, run.Summary, run.ErrorMessage, run.OutputDir,
			run.ExecutionDirectory, run.CreatedAtUnixMS, run.StartedAtUnixMS,
			run.CompletedAtUnixMS, run.UpdatedAtUnixMS)
		if err != nil {
			if isSQLiteUniqueConstraintError(err) {
				return executionbiz.ErrScheduleRejected
			}
			return fmt.Errorf("create scheduled Tutti mode Run: %w", err)
		}
		result, err := tx.ExecContext(ctx, `
UPDATE workspace_issue_tasks
SET status = 'running', acceptance_state = 'agent_claimed',
    acceptance_summary = '', latest_run_id = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND task_id = ? AND status = 'not_started'
`, run.RunID, run.UpdatedAtUnixMS, admission.WorkspaceID, admission.IssueID, run.TaskID)
		if err != nil {
			return fmt.Errorf("claim scheduled Tutti mode task: %w", err)
		}
		if err := requireRowsAffected(result, executionbiz.ErrScheduleRejected, "claim scheduled Tutti mode task"); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_issue_run_launch_intents (
  workspace_id, issue_id, task_id, run_id, launch_intent_id, client_submit_id,
  status, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
`, admission.WorkspaceID, admission.IssueID, task.TaskID, run.RunID,
			"launch-intent:"+run.RunID, workspaceissues.IssueRunClientSubmitID(run.RunID),
			run.CreatedAtUnixMS, run.UpdatedAtUnixMS)
		if err != nil {
			return fmt.Errorf("create scheduled Tutti mode launch intent: %w", err)
		}
	}
	return nil
}

func projectScheduledTuttiModeIssue(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	issueID string,
	now time.Time,
) error {
	var all, notStarted, running, pending, completed, failed, canceled int
	err := tx.QueryRowContext(ctx, `
SELECT COUNT(*),
       SUM(CASE WHEN status = 'not_started' THEN 1 ELSE 0 END),
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END),
       SUM(CASE WHEN status = 'pending_acceptance' THEN 1 ELSE 0 END),
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END),
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),
       SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END)
FROM workspace_issue_tasks
WHERE workspace_id = ? AND issue_id = ? AND superseded_at_unix_ms = 0
`, workspaceID, issueID).Scan(&all, &notStarted, &running, &pending, &completed, &failed, &canceled)
	if err != nil {
		return fmt.Errorf("project scheduled Tutti mode Issue: %w", err)
	}
	status := workspaceissues.ProjectIssueStatus(workspaceissues.StatusCounts{
		All: all, NotStarted: notStarted, Running: running,
		PendingAcceptance: pending, Completed: completed, Failed: failed, Canceled: canceled,
	})
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_issues
SET status = ?, task_count = ?, not_started_count = ?, running_count = ?,
    pending_acceptance_count = ?, completed_count = ?, failed_count = ?,
    canceled_count = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ?
`, string(status), all, notStarted, running, pending, completed, failed, canceled,
		unixMs(now), workspaceID, issueID)
	if err != nil {
		return fmt.Errorf("update scheduled Tutti mode Issue projection: %w", err)
	}
	return requireRowsAffected(result, workspaceissues.ErrIssueNotFound, "update scheduled Tutti mode Issue projection")
}

func resolveTuttiModeScheduleCheckpoint(
	ctx context.Context,
	tx *sql.Tx,
	executionID string,
	admission executionbiz.ScheduleAdmission,
) error {
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_execution_checkpoints
SET status = 'resolved', updated_at_unix_ms = ?, resolved_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
  AND status = 'active' AND graph_revision = ?
`, unixMs(admission.Now), unixMs(admission.Now), admission.WorkspaceID,
		executionID, admission.CheckpointID, admission.ExpectedGraphRevision)
	if err != nil {
		return fmt.Errorf("resolve Tutti mode schedule checkpoint: %w", err)
	}
	if err := requireRowsAffected(result, executionbiz.ErrScheduleRejected, "resolve Tutti mode schedule checkpoint"); err != nil {
		return err
	}
	if err := acknowledgeTuttiModeCheckpointWakesTx(
		ctx, tx, admission.WorkspaceID, executionID, admission.CheckpointID, admission.Now,
	); err != nil {
		return err
	}
	nextStatus := executionbiz.StatusRunning
	var nextCheckpointID string
	err = tx.QueryRowContext(ctx, `
SELECT checkpoint_id
FROM workspace_tutti_execution_checkpoints
WHERE workspace_id = ? AND execution_id = ? AND status = 'pending'
ORDER BY sequence ASC
LIMIT 1
`, admission.WorkspaceID, executionID).Scan(&nextCheckpointID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("get next Tutti mode schedule checkpoint: %w", err)
	}
	if err == nil {
		result, err = tx.ExecContext(ctx, `
UPDATE workspace_tutti_execution_checkpoints
SET status = 'active', updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
  AND status = 'pending'
`, unixMs(admission.Now), admission.WorkspaceID, executionID, nextCheckpointID)
		if err != nil {
			return fmt.Errorf("promote next Tutti mode schedule checkpoint: %w", err)
		}
		if err := requireRowsAffected(result, executionbiz.ErrScheduleRejected, "promote next Tutti mode schedule checkpoint"); err != nil {
			return err
		}
		nextCheckpoint, found, err := getTuttiModeCheckpointTx(
			ctx, tx, admission.WorkspaceID, executionID, nextCheckpointID,
		)
		if err != nil || !found {
			if err == nil {
				err = executionbiz.ErrScheduleRejected
			}
			return err
		}
		if err := prepareTuttiModeMainWakeTx(
			ctx, tx, admission.WorkspaceID, executionID, nextCheckpoint, admission.Now,
		); err != nil {
			return err
		}
		nextStatus = executionbiz.StatusAwaitingMain
	}
	result, err = tx.ExecContext(ctx, `
UPDATE workspace_tutti_executions
SET status = ?, last_orchestrator_activity_at_unix_ms = ?,
    watchdog_due_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND graph_revision = ?
`, string(nextStatus), unixMs(admission.Now), unixMs(admission.Now.Add(executionbiz.WatchdogInterval)),
		unixMs(admission.Now), admission.WorkspaceID, executionID,
		admission.ExpectedGraphRevision)
	if err != nil {
		return fmt.Errorf("advance Tutti mode execution after schedule: %w", err)
	}
	return requireRowsAffected(result, executionbiz.ErrScheduleRejected, "advance Tutti mode execution after schedule")
}

func (s *SQLiteStore) ListPreparedTuttiModeRunLaunches(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runIDs []string,
	_ time.Time,
) ([]executionbiz.PreparedRunLaunch, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return nil, err
	}
	where := []string{
		"runs.workspace_id = ?",
		"runs.status = 'running'",
		"intents.status = 'prepared'",
	}
	args := []any{strings.TrimSpace(workspaceID)}
	if strings.TrimSpace(issueID) != "" {
		where = append(where, "runs.issue_id = ?")
		args = append(args, strings.TrimSpace(issueID))
	}
	placeholders := make([]string, len(runIDs))
	for index, runID := range runIDs {
		placeholders[index] = "?"
		args = append(args, strings.TrimSpace(runID))
	}
	if len(placeholders) > 0 {
		where = append(where, "runs.run_id IN ("+strings.Join(placeholders, ",")+")")
	}
	rows, err := s.readDB.QueryContext(ctx, fmt.Sprintf(`
SELECT %s, intents.client_submit_id
FROM workspace_issue_runs AS runs
JOIN workspace_issue_run_launch_intents AS intents
  ON intents.workspace_id = runs.workspace_id
 AND intents.issue_id = runs.issue_id
 AND intents.task_id = runs.task_id
 AND intents.run_id = runs.run_id
WHERE %s
ORDER BY runs.created_at_unix_ms ASC, runs.id ASC
`, prefixedRunSelectColumns("runs"), strings.Join(where, " AND ")), args...)
	if err != nil {
		return nil, fmt.Errorf("list prepared Tutti mode Run launches: %w", err)
	}
	defer rows.Close()
	runs := make([]executionbiz.PreparedRunLaunch, 0, len(runIDs))
	for rows.Next() {
		run, clientSubmitID, scanErr := scanPreparedTuttiModeRunLaunch(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		runs = append(runs, executionbiz.PreparedRunLaunch{
			Run: run, ClientSubmitID: clientSubmitID,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate prepared Tutti mode Run launches: %w", err)
	}
	return runs, nil
}

func (s *SQLiteStore) MarkTuttiModeRunLaunchIntentDispatched(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
	leaseOwner string,
	now time.Time,
) error {
	if err := s.ensureIssueDatabase(); err != nil {
		return err
	}
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_launch_intents
SET status = 'dispatched', lease_owner = '', lease_expires_at_unix_ms = 0,
    dispatched_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
  AND status = 'leased' AND lease_owner = ?
`, unixMs(now), unixMs(now), strings.TrimSpace(workspaceID),
		strings.TrimSpace(issueID), strings.TrimSpace(runID), strings.TrimSpace(leaseOwner))
	if err != nil {
		return fmt.Errorf("mark Tutti mode Run launch dispatched: %w", err)
	}
	return requireRowsAffected(result, executionbiz.ErrScheduleRejected, "mark Tutti mode Run launch dispatched")
}

func (s *SQLiteStore) GetTuttiModeRunLaunchClientSubmitID(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
) (string, bool, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return "", false, err
	}
	var clientSubmitID string
	err := s.readDB.QueryRowContext(ctx, `
SELECT client_submit_id
FROM workspace_issue_run_launch_intents
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
`, strings.TrimSpace(workspaceID), strings.TrimSpace(issueID), strings.TrimSpace(runID)).
		Scan(&clientSubmitID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("get Tutti mode Run launch submit identity: %w", err)
	}
	return clientSubmitID, true, nil
}

func (s *SQLiteStore) ClaimTuttiModeRunLaunchIntent(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
	leaseOwner string,
	now time.Time,
	leaseExpires time.Time,
) (bool, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return false, err
	}
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_launch_intents
SET status = 'leased', attempt_count = attempt_count + 1,
    lease_owner = ?, lease_expires_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
  AND status = 'prepared'
  AND EXISTS (
    SELECT 1
    FROM workspace_issue_runs AS runs
    WHERE runs.workspace_id = workspace_issue_run_launch_intents.workspace_id
      AND runs.issue_id = workspace_issue_run_launch_intents.issue_id
      AND runs.run_id = workspace_issue_run_launch_intents.run_id
      AND runs.status = 'running'
  )
`, strings.TrimSpace(leaseOwner), unixMs(leaseExpires), unixMs(now),
		strings.TrimSpace(workspaceID), strings.TrimSpace(issueID),
		strings.TrimSpace(runID))
	if err != nil {
		return false, fmt.Errorf("claim Tutti mode Run launch intent: %w", err)
	}
	return rowsWereAffected(result, "claim Tutti mode Run launch intent")
}

func (s *SQLiteStore) ReleaseTuttiModeRunLaunchIntent(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
	leaseOwner string,
	now time.Time,
) error {
	if err := s.ensureIssueDatabase(); err != nil {
		return err
	}
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_launch_intents
SET status = 'prepared', lease_owner = '', lease_expires_at_unix_ms = 0,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
  AND status = 'leased' AND lease_owner = ?
`, unixMs(now), strings.TrimSpace(workspaceID), strings.TrimSpace(issueID),
		strings.TrimSpace(runID), strings.TrimSpace(leaseOwner))
	if err != nil {
		return fmt.Errorf("release Tutti mode Run launch intent: %w", err)
	}
	return requireRowsAffected(result, executionbiz.ErrScheduleRejected, "release Tutti mode Run launch intent")
}

func (s *SQLiteStore) RenewTuttiModeRunLaunchIntent(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
	leaseOwner string,
	now time.Time,
	leaseExpires time.Time,
) error {
	if err := s.ensureIssueDatabase(); err != nil {
		return err
	}
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_launch_intents
SET lease_expires_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
  AND status = 'leased' AND lease_owner = ?
`, unixMs(leaseExpires), unixMs(now), strings.TrimSpace(workspaceID),
		strings.TrimSpace(issueID), strings.TrimSpace(runID), strings.TrimSpace(leaseOwner))
	if err != nil {
		return fmt.Errorf("renew Tutti mode Run launch intent: %w", err)
	}
	return requireRowsAffected(result, executionbiz.ErrScheduleRejected, "renew Tutti mode Run launch intent")
}

func (s *SQLiteStore) RequeueLeasedTuttiModeRunLaunchIntents(
	ctx context.Context,
	workspaceID string,
	now time.Time,
) error {
	if err := s.ensureIssueDatabase(); err != nil {
		return err
	}
	_, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_launch_intents
SET status = 'prepared', lease_owner = '', lease_expires_at_unix_ms = 0,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND status = 'leased'
  AND lease_expires_at_unix_ms <= ?
`, unixMs(now), strings.TrimSpace(workspaceID), unixMs(now))
	if err != nil {
		return fmt.Errorf("requeue leased Tutti mode Run launch intents: %w", err)
	}
	return nil
}

func scanPreparedTuttiModeRunLaunch(
	scanner issueScanner,
) (workspaceissues.Run, string, error) {
	var item workspaceissues.Run
	var id int64
	var status string
	var clientSubmitID string
	err := scanner.Scan(
		&id, &item.RunID, &item.TaskID, &item.IssueID, &item.WorkspaceID,
		&item.RequesterUserID, &item.AgentUserID, &item.AgentTargetID,
		&item.AgentSessionID, &item.AgentProvider, &item.ModelPlanID, &item.Model,
		&item.ReasoningIntensity, &status, &item.Usage.InputTokens,
		&item.Usage.OutputTokens, &item.Usage.CacheReadTokens, &item.Usage.CacheWriteTokens,
		&item.Summary, &item.ErrorMessage, &item.OutputDir, &item.ExecutionDirectory,
		&item.CreatedAtUnixMS, &item.StartedAtUnixMS, &item.CompletedAtUnixMS,
		&item.UpdatedAtUnixMS, &clientSubmitID,
	)
	item.ID = uint64(id)
	item.Status = workspaceissues.Status(status)
	return item, clientSubmitID, err
}

func prefixedRunSelectColumns(alias string) string {
	columns := strings.Split(strings.TrimSpace(runSelectColumns), ",")
	for index, column := range columns {
		columns[index] = alias + "." + strings.TrimSpace(column)
	}
	return strings.Join(columns, ", ")
}
