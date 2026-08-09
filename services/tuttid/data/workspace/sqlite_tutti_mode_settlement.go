package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

func (s *SQLiteStore) FailTuttiModeRunLaunch(
	ctx context.Context,
	failure executionbiz.RunLaunchFailure,
) (executionbiz.Checkpoint, bool, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return executionbiz.Checkpoint{}, false, err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return executionbiz.Checkpoint{}, false, fmt.Errorf(
			"begin Tutti mode Run launch failure: %w", err,
		)
	}
	defer func() { _ = tx.Rollback() }()

	var taskID string
	if err := tx.QueryRowContext(ctx, `
SELECT task_id
FROM workspace_issue_runs
WHERE workspace_id = ? AND issue_id = ? AND run_id = ? AND status = 'running'
`, failure.WorkspaceID, failure.IssueID, failure.RunID).Scan(&taskID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return executionbiz.Checkpoint{}, false, executionbiz.ErrScheduleRejected
		}
		return executionbiz.Checkpoint{}, false, fmt.Errorf(
			"get running Run for launch failure: %w", err,
		)
	}
	intentMutation, err := tx.ExecContext(ctx, `
UPDATE workspace_issue_run_launch_intents
SET status = 'failed', lease_owner = '', lease_expires_at_unix_ms = 0,
    last_error = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
  AND status = 'leased' AND lease_owner = ?
`, failure.ErrorMessage, unixMs(failure.Now), failure.WorkspaceID,
		failure.IssueID, failure.RunID, failure.LeaseOwner)
	if err != nil {
		return executionbiz.Checkpoint{}, false, fmt.Errorf(
			"fail Tutti mode Run launch intent: %w", err,
		)
	}
	if err := requireRowsAffected(
		intentMutation, executionbiz.ErrScheduleRejected,
		"fail owned Tutti mode Run launch intent",
	); err != nil {
		return executionbiz.Checkpoint{}, false, err
	}
	runMutation, err := tx.ExecContext(ctx, `
UPDATE workspace_issue_runs
SET status = 'failed', error_message = ?, completed_at_unix_ms = ?,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND task_id = ? AND run_id = ?
  AND status = 'running'
`, failure.ErrorMessage, unixMs(failure.Now), unixMs(failure.Now),
		failure.WorkspaceID, failure.IssueID, taskID, failure.RunID)
	if err != nil {
		return executionbiz.Checkpoint{}, false, fmt.Errorf(
			"fail Tutti mode Run before launch: %w", err,
		)
	}
	if err := requireRowsAffected(
		runMutation, executionbiz.ErrScheduleRejected,
		"fail running Tutti mode Run before launch",
	); err != nil {
		return executionbiz.Checkpoint{}, false, err
	}
	taskMutation, err := tx.ExecContext(ctx, `
UPDATE workspace_issue_tasks
SET status = 'failed', acceptance_state = 'agent_claimed',
    acceptance_summary = '', updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND task_id = ?
  AND status = 'running' AND latest_run_id = ?
`, unixMs(failure.Now), failure.WorkspaceID, failure.IssueID, taskID, failure.RunID)
	if err != nil {
		return executionbiz.Checkpoint{}, false, fmt.Errorf(
			"fail Tutti mode task before launch: %w", err,
		)
	}
	if err := requireRowsAffected(
		taskMutation, executionbiz.ErrScheduleRejected,
		"fail running Tutti mode task before launch",
	); err != nil {
		return executionbiz.Checkpoint{}, false, err
	}
	if err := projectWorkspaceIssueTasks(
		ctx, tx, failure.WorkspaceID, failure.IssueID, failure.Now,
	); err != nil {
		return executionbiz.Checkpoint{}, false, err
	}
	checkpoint, created, err := ensureTuttiModeRunSettlementTx(
		ctx, tx, executionbiz.RunSettlement{
			WorkspaceID: failure.WorkspaceID, IssueID: failure.IssueID,
			TaskID: taskID, RunID: failure.RunID,
			Status: workspaceissues.StatusFailed, Now: failure.Now,
		},
	)
	if err != nil {
		return executionbiz.Checkpoint{}, false, err
	}
	topicMutation, err := tx.ExecContext(ctx, `
UPDATE workspace_issue_topics
SET last_activity_at_unix_ms = ?
WHERE workspace_id = ? AND topic_id = (
  SELECT topic_id FROM workspace_issues
  WHERE workspace_id = ? AND issue_id = ?
)
`, unixMs(failure.Now), failure.WorkspaceID, failure.WorkspaceID, failure.IssueID)
	if err != nil {
		return executionbiz.Checkpoint{}, false, fmt.Errorf(
			"touch topic after Tutti mode launch failure: %w", err,
		)
	}
	if err := requireRowsAffected(
		topicMutation, workspaceissues.ErrTopicNotFound,
		"touch topic after Tutti mode launch failure",
	); err != nil {
		return executionbiz.Checkpoint{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return executionbiz.Checkpoint{}, false, fmt.Errorf(
			"commit Tutti mode Run launch failure: %w", err,
		)
	}
	return checkpoint, created, nil
}

func (s *SQLiteStore) EnsureTuttiModeRunSettlement(
	ctx context.Context,
	settlement executionbiz.RunSettlement,
) (executionbiz.Checkpoint, bool, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return executionbiz.Checkpoint{}, false, err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return executionbiz.Checkpoint{}, false, fmt.Errorf("begin Tutti mode settlement: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	checkpoint, created, err := ensureTuttiModeRunSettlementTx(ctx, tx, settlement)
	if err != nil {
		return executionbiz.Checkpoint{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return executionbiz.Checkpoint{}, false, fmt.Errorf("commit Tutti mode settlement: %w", err)
	}
	return checkpoint, created, nil
}

func ensureTuttiModeRunSettlementTx(
	ctx context.Context,
	tx *sql.Tx,
	settlement executionbiz.RunSettlement,
) (executionbiz.Checkpoint, bool, error) {
	var executionID string
	var graphRevision int64
	var executionStatus string
	err := tx.QueryRowContext(ctx, `
SELECT execution_id, graph_revision, status
FROM workspace_tutti_executions
WHERE workspace_id = ? AND issue_id = ?
`, settlement.WorkspaceID, settlement.IssueID).Scan(&executionID, &graphRevision, &executionStatus)
	if errors.Is(err, sql.ErrNoRows) {
		return executionbiz.Checkpoint{}, false, executionbiz.ErrExecutionNotFound
	}
	if err != nil {
		return executionbiz.Checkpoint{}, false, fmt.Errorf("get settlement execution: %w", err)
	}
	var runStatus string
	err = tx.QueryRowContext(ctx, `
SELECT status FROM workspace_issue_runs
WHERE workspace_id = ? AND issue_id = ? AND task_id = ? AND run_id = ?
`, settlement.WorkspaceID, settlement.IssueID, settlement.TaskID, settlement.RunID).Scan(&runStatus)
	if err != nil {
		return executionbiz.Checkpoint{}, false, fmt.Errorf("get settled Run: %w", err)
	}
	kind, ok := settlementCheckpointKind(workspaceissues.Status(runStatus))
	if !ok {
		return executionbiz.Checkpoint{}, false, executionbiz.ErrInvalidExecution
	}
	if err := sealTerminalTuttiModeRunLaunchIntent(
		ctx, tx, settlement, workspaceissues.Status(runStatus),
	); err != nil {
		return executionbiz.Checkpoint{}, false, err
	}
	if suppressTuttiModeSettlementCheckpoint(executionStatus) {
		return executionbiz.Checkpoint{}, false, nil
	}
	checkpointID, _ := executionbiz.RunSettlementCheckpointID(executionID, settlement.RunID)
	existing, found, err := getTuttiModeCheckpointTx(
		ctx, tx, settlement.WorkspaceID, executionID, checkpointID,
	)
	if err != nil || found {
		return existing, false, err
	}
	var activeCount int
	var maxSequence int64
	if err := tx.QueryRowContext(ctx, `
SELECT
  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END),
  COALESCE(MAX(sequence), 0)
FROM workspace_tutti_execution_checkpoints
WHERE workspace_id = ? AND execution_id = ?
`, settlement.WorkspaceID, executionID).Scan(&activeCount, &maxSequence); err != nil {
		return executionbiz.Checkpoint{}, false, fmt.Errorf("inspect settlement backlog: %w", err)
	}
	status := executionbiz.CheckpointStatusPending
	if activeCount == 0 {
		status = executionbiz.CheckpointStatusActive
	}
	checkpoint := executionbiz.Checkpoint{
		ID: checkpointID, ExecutionID: executionID, Kind: kind, Status: status,
		Sequence: maxSequence + 1, GraphRevision: graphRevision,
		SubjectTaskID: settlement.TaskID, SubjectRunID: settlement.RunID,
		CreationReason: "authoritative_run_terminal",
		CreatedAt:      settlement.Now, UpdatedAt: settlement.Now,
	}
	if err := insertTuttiModeExecutionCheckpoint(ctx, tx, settlement.WorkspaceID, checkpoint); err != nil {
		return executionbiz.Checkpoint{}, false, err
	}
	if err := prepareTuttiModeMainWakeTx(
		ctx, tx, settlement.WorkspaceID, executionID, checkpoint, settlement.Now,
	); err != nil {
		return executionbiz.Checkpoint{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_executions
SET status = 'awaiting_main', last_orchestrator_activity_at_unix_ms = ?,
    watchdog_due_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ?
`, unixMs(settlement.Now), unixMs(settlement.Now.Add(executionbiz.WatchdogInterval)),
		unixMs(settlement.Now), settlement.WorkspaceID, executionID); err != nil {
		return executionbiz.Checkpoint{}, false, fmt.Errorf("advance execution after settlement: %w", err)
	}
	if err := appendAllTasksTerminalCheckpointIfReady(
		ctx, tx, settlement.WorkspaceID, settlement.IssueID, executionID,
		graphRevision, settlement.Now,
	); err != nil {
		return executionbiz.Checkpoint{}, false, err
	}
	return checkpoint, true, nil
}

func sealTerminalTuttiModeRunLaunchIntent(
	ctx context.Context,
	tx *sql.Tx,
	settlement executionbiz.RunSettlement,
	status workspaceissues.Status,
) error {
	if _, err := tx.ExecContext(ctx, `
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
  AND i.status IN ('leased', 'dispatched')
`, unixMs(settlement.Now), unixMs(settlement.Now), settlement.WorkspaceID,
		settlement.IssueID, settlement.TaskID, settlement.RunID); err != nil {
		return fmt.Errorf("prepare terminal Tutti mode Run cancel compensation: %w", err)
	}
	intentStatus := "canceled"
	if status == workspaceissues.StatusFailed {
		intentStatus = "failed"
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_issue_run_launch_intents
SET status = ?, lease_owner = '', lease_expires_at_unix_ms = 0,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
  AND status IN ('prepared', 'leased')
`, intentStatus, unixMs(settlement.Now), settlement.WorkspaceID,
		settlement.IssueID, settlement.RunID); err != nil {
		return fmt.Errorf("seal terminal Tutti mode Run launch intent: %w", err)
	}
	return nil
}

func settlementCheckpointKind(status workspaceissues.Status) (executionbiz.CheckpointKind, bool) {
	switch status {
	case workspaceissues.StatusCompleted:
		return executionbiz.CheckpointKindTaskSettled, true
	case workspaceissues.StatusFailed:
		return executionbiz.CheckpointKindTaskFailed, true
	case workspaceissues.StatusCanceled:
		return executionbiz.CheckpointKindTaskCanceled, true
	default:
		return "", false
	}
}

func suppressTuttiModeSettlementCheckpoint(status string) bool {
	switch executionbiz.Status(status) {
	case executionbiz.StatusOrphanedSource,
		executionbiz.StatusCompleted,
		executionbiz.StatusArchiving,
		executionbiz.StatusArchived:
		return true
	default:
		return false
	}
}

func appendAllTasksTerminalCheckpointIfReady(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	issueID string,
	executionID string,
	graphRevision int64,
	now time.Time,
) error {
	var nonTerminalTasks, missingSettlements int
	if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*) FROM workspace_issue_tasks
WHERE workspace_id = ? AND issue_id = ? AND superseded_at_unix_ms = 0
  AND status IN ('not_started', 'running')
`, workspaceID, issueID).Scan(&nonTerminalTasks); err != nil {
		return fmt.Errorf("count non-terminal tasks: %w", err)
	}
	if nonTerminalTasks != 0 {
		return nil
	}
	if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM workspace_issue_runs r
LEFT JOIN workspace_tutti_execution_checkpoints c
  ON c.workspace_id = r.workspace_id AND c.execution_id = ?
 AND c.subject_run_id = r.run_id
WHERE r.workspace_id = ? AND r.issue_id = ?
  AND r.status IN ('completed', 'failed', 'canceled')
  AND c.checkpoint_id IS NULL
`, executionID, workspaceID, issueID).Scan(&missingSettlements); err != nil {
		return fmt.Errorf("count missing settlement checkpoints: %w", err)
	}
	if missingSettlements != 0 {
		return nil
	}
	checkpointID, _ := executionbiz.AllTasksTerminalCheckpointID(executionID)
	existing, found, err := getTuttiModeCheckpointTx(
		ctx, tx, workspaceID, executionID, checkpointID,
	)
	if err != nil {
		return err
	}
	var maxSequence int64
	if err := tx.QueryRowContext(ctx, `
SELECT COALESCE(MAX(sequence), 0)
FROM workspace_tutti_execution_checkpoints
WHERE workspace_id = ? AND execution_id = ?
`, workspaceID, executionID).Scan(&maxSequence); err != nil {
		return fmt.Errorf("get terminal checkpoint sequence: %w", err)
	}
	if found {
		if existing.Status != executionbiz.CheckpointStatusSuperseded {
			return nil
		}
		result, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_execution_checkpoints
SET status = 'pending', sequence = ?, graph_revision = ?,
    creation_reason = 'all_issue_tasks_terminal', requires_goal_review = 1,
    created_at_unix_ms = ?, updated_at_unix_ms = ?, resolved_at_unix_ms = 0
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
  AND kind = 'all_tasks_terminal' AND status = 'superseded'
`, maxSequence+1, graphRevision, unixMs(now), unixMs(now), workspaceID,
			executionID, checkpointID)
		if err != nil {
			return fmt.Errorf("rearm superseded Tutti mode terminal checkpoint: %w", err)
		}
		return requireRowsAffected(
			result,
			executionbiz.ErrExecutionConflict,
			"rearm superseded Tutti mode terminal checkpoint",
		)
	}
	return insertTuttiModeExecutionCheckpoint(ctx, tx, workspaceID, executionbiz.Checkpoint{
		ID: checkpointID, ExecutionID: executionID,
		Kind:     executionbiz.CheckpointKindAllTasksTerminal,
		Status:   executionbiz.CheckpointStatusPending,
		Sequence: maxSequence + 1, GraphRevision: graphRevision,
		CreationReason: "all_issue_tasks_terminal", RequiresGoalReview: true,
		CreatedAt: now, UpdatedAt: now,
	})
}

func getTuttiModeCheckpointTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	executionID string,
	checkpointID string,
) (executionbiz.Checkpoint, bool, error) {
	row := tx.QueryRowContext(ctx, `
SELECT checkpoint_id, execution_id, kind, status, sequence, graph_revision,
       subject_task_id, subject_run_id, creation_reason, requires_goal_review,
       created_at_unix_ms, updated_at_unix_ms, resolved_at_unix_ms
FROM workspace_tutti_execution_checkpoints
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
`, workspaceID, executionID, checkpointID)
	checkpoint, err := scanTuttiModeExecutionCheckpoint(row)
	if errors.Is(err, sql.ErrNoRows) {
		return executionbiz.Checkpoint{}, false, nil
	}
	if err != nil {
		return executionbiz.Checkpoint{}, false, fmt.Errorf("get Tutti mode checkpoint: %w", err)
	}
	return checkpoint, true, nil
}

func (s *SQLiteStore) RepairTuttiModeRunSettlements(
	ctx context.Context,
	workspaceID string,
	now time.Time,
) (int, error) {
	rows, err := s.readDB.QueryContext(ctx, `
SELECT r.issue_id, r.task_id, r.run_id, r.status
FROM workspace_issue_runs r
JOIN workspace_tutti_executions e
  ON e.workspace_id = r.workspace_id AND e.issue_id = r.issue_id
LEFT JOIN workspace_tutti_execution_checkpoints c
  ON c.workspace_id = e.workspace_id AND c.execution_id = e.execution_id
 AND c.subject_run_id = r.run_id
LEFT JOIN workspace_issue_run_launch_intents i
  ON i.workspace_id = r.workspace_id AND i.issue_id = r.issue_id
 AND i.run_id = r.run_id
LEFT JOIN workspace_issue_run_cancel_compensations cc
  ON cc.workspace_id = r.workspace_id AND cc.issue_id = r.issue_id
 AND cc.run_id = r.run_id
WHERE r.workspace_id = ? AND r.status IN ('completed', 'failed', 'canceled')
  AND (
    (e.status NOT IN ('orphaned_source', 'completed', 'archiving', 'archived')
      AND c.checkpoint_id IS NULL)
    OR i.status IN ('prepared', 'leased')
    OR (i.status = 'dispatched' AND cc.run_id IS NULL)
  )
ORDER BY r.completed_at_unix_ms ASC, r.created_at_unix_ms ASC, r.run_id ASC
`, workspaceID)
	if err != nil {
		return 0, fmt.Errorf("list missing Tutti mode settlements: %w", err)
	}
	var settlements []executionbiz.RunSettlement
	for rows.Next() {
		var settlement executionbiz.RunSettlement
		if err := rows.Scan(&settlement.IssueID, &settlement.TaskID, &settlement.RunID, &settlement.Status); err != nil {
			_ = rows.Close()
			return 0, fmt.Errorf("scan missing Tutti mode settlement: %w", err)
		}
		settlement.WorkspaceID = workspaceID
		settlement.Now = now
		settlements = append(settlements, settlement)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	repaired := 0
	for _, settlement := range settlements {
		if _, created, err := s.EnsureTuttiModeRunSettlement(ctx, settlement); err != nil {
			return repaired, err
		} else if created {
			repaired++
		}
	}
	terminalRepairs, err := s.repairSupersededTuttiModeTerminalCheckpoints(
		ctx, workspaceID, now,
	)
	if err != nil {
		return repaired, err
	}
	return repaired + terminalRepairs, nil
}

func (s *SQLiteStore) repairSupersededTuttiModeTerminalCheckpoints(
	ctx context.Context,
	workspaceID string,
	now time.Time,
) (int, error) {
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	type candidate struct {
		issueID       string
		executionID   string
		graphRevision int64
	}
	rows, err := tx.QueryContext(ctx, `
SELECT e.issue_id, e.execution_id, e.graph_revision
FROM workspace_tutti_executions e
JOIN workspace_tutti_execution_checkpoints terminal
  ON terminal.workspace_id = e.workspace_id
 AND terminal.execution_id = e.execution_id
 AND terminal.kind = 'all_tasks_terminal'
 AND terminal.status = 'superseded'
WHERE e.workspace_id = ? AND e.status = 'awaiting_main'
  AND EXISTS (
    SELECT 1 FROM workspace_tutti_execution_checkpoints active
    WHERE active.workspace_id = e.workspace_id
      AND active.execution_id = e.execution_id
      AND active.status = 'active'
      AND active.kind IN ('task_settled', 'task_failed', 'task_canceled')
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspace_issue_tasks task
    WHERE task.workspace_id = e.workspace_id
      AND task.issue_id = e.issue_id
      AND task.superseded_at_unix_ms = 0
      AND task.status IN ('not_started', 'running')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM workspace_issue_runs run
    LEFT JOIN workspace_tutti_execution_checkpoints settlement
      ON settlement.workspace_id = run.workspace_id
     AND settlement.execution_id = e.execution_id
     AND settlement.subject_run_id = run.run_id
    WHERE run.workspace_id = e.workspace_id
      AND run.issue_id = e.issue_id
      AND run.status IN ('completed', 'failed', 'canceled')
      AND settlement.checkpoint_id IS NULL
  )
ORDER BY e.updated_at_unix_ms ASC, e.execution_id ASC
`, workspaceID)
	if err != nil {
		return 0, fmt.Errorf("list superseded Tutti mode terminal checkpoints: %w", err)
	}
	var candidates []candidate
	for rows.Next() {
		var current candidate
		if err := rows.Scan(
			&current.issueID, &current.executionID, &current.graphRevision,
		); err != nil {
			_ = rows.Close()
			return 0, fmt.Errorf("scan superseded Tutti mode terminal checkpoint: %w", err)
		}
		candidates = append(candidates, current)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	for _, current := range candidates {
		if err := appendAllTasksTerminalCheckpointIfReady(
			ctx, tx, workspaceID, current.issueID, current.executionID,
			current.graphRevision, now,
		); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return len(candidates), nil
}

func (s *SQLiteStore) AdmitTuttiModeAcknowledge(
	ctx context.Context,
	admission executionbiz.AcknowledgeAdmission,
) (executionbiz.AcknowledgeResult, error) {
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return executionbiz.AcknowledgeResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var executionID, sourceSessionID, status string
	var graphRevision int64
	err = tx.QueryRowContext(ctx, `
SELECT execution_id, source_session_id, status, graph_revision
FROM workspace_tutti_executions WHERE workspace_id = ? AND issue_id = ?
`, admission.WorkspaceID, admission.IssueID).
		Scan(&executionID, &sourceSessionID, &status, &graphRevision)
	if errors.Is(err, sql.ErrNoRows) {
		return executionbiz.AcknowledgeResult{}, executionbiz.ErrExecutionNotFound
	}
	if err != nil {
		return executionbiz.AcknowledgeResult{}, err
	}
	replay, found, err := getTuttiModeAcknowledgeReplay(ctx, tx, admission)
	if err != nil || found {
		return replay, err
	}
	if sourceSessionID != admission.SourceSessionID ||
		graphRevision != admission.ExpectedGraphRevision ||
		status == string(executionbiz.StatusPendingGoalReview) {
		return executionbiz.AcknowledgeResult{}, executionbiz.ErrAcknowledgeRejected
	}
	checkpoint, found, err := getTuttiModeCheckpointTx(
		ctx, tx, admission.WorkspaceID, executionID, admission.CheckpointID,
	)
	if err != nil || !found {
		if err == nil {
			err = executionbiz.ErrAcknowledgeRejected
		}
		return executionbiz.AcknowledgeResult{}, err
	}
	if checkpoint.Status != executionbiz.CheckpointStatusActive ||
		(checkpoint.Kind != executionbiz.CheckpointKindTaskSettled &&
			checkpoint.Kind != executionbiz.CheckpointKindTaskFailed &&
			checkpoint.Kind != executionbiz.CheckpointKindTaskCanceled &&
			checkpoint.Kind != executionbiz.CheckpointKindWatchdog) {
		return executionbiz.AcknowledgeResult{}, executionbiz.ErrAcknowledgeRejected
	}
	var running, later int
	if err := tx.QueryRowContext(ctx, `
SELECT
 (SELECT COUNT(*) FROM workspace_issue_runs
   WHERE workspace_id = ? AND issue_id = ? AND status = 'running'),
 (SELECT COUNT(*) FROM workspace_tutti_execution_checkpoints
   WHERE workspace_id = ? AND execution_id = ? AND sequence > ? AND status = 'pending')
`, admission.WorkspaceID, admission.IssueID, admission.WorkspaceID, executionID,
		checkpoint.Sequence).Scan(&running, &later); err != nil {
		return executionbiz.AcknowledgeResult{}, err
	}
	if running == 0 && later == 0 {
		return executionbiz.AcknowledgeResult{}, executionbiz.ErrAcknowledgeRejected
	}
	if checkpoint.Kind == executionbiz.CheckpointKindTaskSettled {
		taskMutation, err := tx.ExecContext(ctx, `
UPDATE workspace_issue_tasks
SET status = 'completed', acceptance_state = 'user_accepted', updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND task_id = ?
  AND status = 'pending_acceptance'
`, unixMs(admission.Now), admission.WorkspaceID, admission.IssueID, checkpoint.SubjectTaskID)
		if err != nil {
			return executionbiz.AcknowledgeResult{}, err
		}
		if err := requireRowsAffected(
			taskMutation, executionbiz.ErrAcknowledgeRejected,
			"accept Tutti mode settled task",
		); err != nil {
			return executionbiz.AcknowledgeResult{}, err
		}
	}
	checkpointMutation, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_execution_checkpoints
SET status = 'resolved', updated_at_unix_ms = ?, resolved_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ? AND status = 'active'
`, unixMs(admission.Now), unixMs(admission.Now), admission.WorkspaceID,
		executionID, checkpoint.ID)
	if err != nil {
		return executionbiz.AcknowledgeResult{}, err
	}
	if err := requireRowsAffected(
		checkpointMutation, executionbiz.ErrAcknowledgeRejected,
		"resolve Tutti mode settlement checkpoint",
	); err != nil {
		return executionbiz.AcknowledgeResult{}, err
	}
	if err := acknowledgeTuttiModeCheckpointWakesTx(
		ctx, tx, admission.WorkspaceID, executionID, checkpoint.ID, admission.Now,
	); err != nil {
		return executionbiz.AcknowledgeResult{}, err
	}
	var next executionbiz.Checkpoint
	row := tx.QueryRowContext(ctx, `
SELECT checkpoint_id, execution_id, kind, status, sequence, graph_revision,
       subject_task_id, subject_run_id, creation_reason, requires_goal_review,
       created_at_unix_ms, updated_at_unix_ms, resolved_at_unix_ms
FROM workspace_tutti_execution_checkpoints
WHERE workspace_id = ? AND execution_id = ? AND status = 'pending'
ORDER BY sequence ASC LIMIT 1
`, admission.WorkspaceID, executionID)
	next, err = scanTuttiModeExecutionCheckpoint(row)
	if !errors.Is(err, sql.ErrNoRows) && err != nil {
		return executionbiz.AcknowledgeResult{}, err
	}
	nextStatus := executionbiz.StatusAwaitingMain
	if errors.Is(err, sql.ErrNoRows) {
		next = executionbiz.Checkpoint{}
		if running > 0 {
			nextStatus = executionbiz.StatusRunning
		}
	} else {
		next.Status = executionbiz.CheckpointStatusActive
		nextCheckpointMutation, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_execution_checkpoints
SET status = 'active', graph_revision = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ? AND status = 'pending'
`, graphRevision, unixMs(admission.Now), admission.WorkspaceID, executionID, next.ID)
		if err != nil {
			return executionbiz.AcknowledgeResult{}, err
		}
		if err := requireRowsAffected(
			nextCheckpointMutation, executionbiz.ErrAcknowledgeRejected,
			"promote next Tutti mode settlement checkpoint",
		); err != nil {
			return executionbiz.AcknowledgeResult{}, err
		}
		next.GraphRevision = graphRevision
		if next.Kind == executionbiz.CheckpointKindAllTasksTerminal {
			nextStatus = executionbiz.StatusPendingGoalReview
			if err := prepareTuttiModeGoalReviewTx(
				ctx, tx, admission.WorkspaceID, executionID, next, admission.Now,
			); err != nil {
				return executionbiz.AcknowledgeResult{}, err
			}
		} else if err := prepareTuttiModeMainWakeTx(
			ctx, tx, admission.WorkspaceID, executionID, next, admission.Now,
		); err != nil {
			return executionbiz.AcknowledgeResult{}, err
		}
	}
	executionMutation, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_executions
SET status = ?, last_orchestrator_activity_at_unix_ms = ?,
    watchdog_due_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ?
`, string(nextStatus), unixMs(admission.Now),
		unixMs(admission.Now.Add(executionbiz.WatchdogInterval)), unixMs(admission.Now),
		admission.WorkspaceID, executionID)
	if err != nil {
		return executionbiz.AcknowledgeResult{}, err
	}
	if err := requireRowsAffected(
		executionMutation, executionbiz.ErrAcknowledgeRejected,
		"advance Tutti mode execution after acknowledge",
	); err != nil {
		return executionbiz.AcknowledgeResult{}, err
	}
	if checkpoint.Kind == executionbiz.CheckpointKindTaskSettled {
		if err := projectWorkspaceIssueTasks(
			ctx, tx, admission.WorkspaceID, admission.IssueID, admission.Now,
		); err != nil {
			return executionbiz.AcknowledgeResult{}, err
		}
	}
	result := executionbiz.AcknowledgeResult{
		ExecutionID: executionID, CheckpointID: checkpoint.ID,
		GraphRevision: graphRevision, NextCheckpointID: next.ID,
		NextCheckpointKind: next.Kind, NextCheckpointState: next.Status,
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return executionbiz.AcknowledgeResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_tutti_execution_mutations (
 workspace_id, execution_id, issue_id, source_session_id, kind, request_id,
 input_sha256, checkpoint_id, expected_graph_revision, result_graph_revision,
 result_json, created_at_unix_ms
) VALUES (?, ?, ?, ?, 'acknowledge', ?, ?, ?, ?, ?, ?, ?)
`, admission.WorkspaceID, executionID, admission.IssueID, admission.SourceSessionID,
		admission.RequestID, admission.InputSHA256, admission.CheckpointID,
		admission.ExpectedGraphRevision, graphRevision, string(encoded), unixMs(admission.Now)); err != nil {
		if isSQLiteUniqueConstraintError(err) {
			return executionbiz.AcknowledgeResult{}, executionbiz.ErrAcknowledgeMutationConflict
		}
		return executionbiz.AcknowledgeResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return executionbiz.AcknowledgeResult{}, err
	}
	return result, nil
}

func getTuttiModeAcknowledgeReplay(
	ctx context.Context,
	tx *sql.Tx,
	admission executionbiz.AcknowledgeAdmission,
) (executionbiz.AcknowledgeResult, bool, error) {
	var digest, encoded string
	err := tx.QueryRowContext(ctx, `
SELECT input_sha256, result_json FROM workspace_tutti_execution_mutations
WHERE workspace_id = ? AND source_session_id = ? AND kind = 'acknowledge'
 AND issue_id = ? AND request_id = ?
`, admission.WorkspaceID, admission.SourceSessionID, admission.IssueID,
		admission.RequestID).Scan(&digest, &encoded)
	if errors.Is(err, sql.ErrNoRows) {
		return executionbiz.AcknowledgeResult{}, false, nil
	}
	if err != nil {
		return executionbiz.AcknowledgeResult{}, false, err
	}
	if digest != admission.InputSHA256 {
		return executionbiz.AcknowledgeResult{}, false, executionbiz.ErrAcknowledgeMutationConflict
	}
	var result executionbiz.AcknowledgeResult
	if err := json.Unmarshal([]byte(encoded), &result); err != nil {
		return executionbiz.AcknowledgeResult{}, false, err
	}
	result.Replayed = true
	return result, true, nil
}
