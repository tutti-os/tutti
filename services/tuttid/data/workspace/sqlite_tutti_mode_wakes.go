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

func prepareTuttiModeMainWakeTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	executionID string,
	checkpoint executionbiz.Checkpoint,
	now time.Time,
) error {
	return prepareTuttiModeMainWakeSequenceTx(
		ctx, tx, workspaceID, executionID, checkpoint, 1, now, now,
	)
}

func prepareTuttiModeMainWakeSequenceTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	executionID string,
	checkpoint executionbiz.Checkpoint,
	sequence int64,
	dueAt time.Time,
	now time.Time,
) error {
	if checkpoint.Status != executionbiz.CheckpointStatusActive {
		return nil
	}
	wakeID, ok := executionbiz.MainWakeID(checkpoint.ID, sequence)
	if !ok {
		return executionbiz.ErrWakeIntegrity
	}
	clientSubmitID, ok := executionbiz.MainWakeClientSubmitID(wakeID)
	if !ok {
		return executionbiz.ErrWakeIntegrity
	}
	result, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO workspace_tutti_execution_wakes (
  workspace_id, execution_id, checkpoint_id, wake_id, target_kind,
  wake_sequence, client_submit_id, target_session_id, status,
  due_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
)
SELECT e.workspace_id, e.execution_id, ?, ?, 'main', ?, ?,
       e.source_session_id, 'prepared', ?, ?, ?
FROM workspace_tutti_executions e
JOIN workspace_tutti_execution_checkpoints c
  ON c.workspace_id = e.workspace_id AND c.execution_id = e.execution_id
WHERE e.workspace_id = ? AND e.execution_id = ?
  AND c.checkpoint_id = ? AND c.status = 'active'
`, checkpoint.ID, wakeID, sequence, clientSubmitID, unixMs(dueAt), unixMs(now), unixMs(now),
		workspaceID, executionID, checkpoint.ID)
	if err != nil {
		return fmt.Errorf("prepare Tutti mode main wake: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("inspect prepared Tutti mode main wake: %w", err)
	}
	if affected == 0 {
		var equivalent int
		err := tx.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM workspace_tutti_execution_wakes w
JOIN workspace_tutti_executions e
  ON e.workspace_id = w.workspace_id AND e.execution_id = w.execution_id
JOIN workspace_tutti_execution_checkpoints c
  ON c.workspace_id = w.workspace_id AND c.execution_id = w.execution_id
 AND c.checkpoint_id = w.checkpoint_id
WHERE w.workspace_id = ? AND w.execution_id = ? AND w.wake_id = ?
  AND w.checkpoint_id = ? AND w.target_kind = 'main' AND w.wake_sequence = ?
  AND w.client_submit_id = ? AND w.target_session_id = e.source_session_id
  AND w.status IN ('prepared', 'leased', 'dispatched', 'turn_settled')
  AND c.status = 'active'
`, workspaceID, executionID, wakeID, checkpoint.ID, sequence, clientSubmitID).Scan(&equivalent)
		if err != nil || equivalent != 1 {
			if err != nil {
				return fmt.Errorf("verify Tutti mode main wake: %w", err)
			}
			return executionbiz.ErrWakeIntegrity
		}
	}
	return nil
}

func (s *SQLiteStore) PrepareDueTuttiModeExecutionWatchdogs(
	ctx context.Context,
	workspaceID string,
	now time.Time,
) error {
	if err := s.ensureIssueDatabase(); err != nil {
		return err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Tutti mode watchdog preparation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := repairStaleActiveTuttiModeCheckpointRevisionsTx(
		ctx, tx, workspaceID, now,
	); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `
SELECT execution_id, graph_revision, watchdog_due_at_unix_ms
FROM workspace_tutti_executions
WHERE workspace_id = ?
  AND status IN ('awaiting_schedule', 'running', 'awaiting_main', 'pending_goal_review')
  AND watchdog_due_at_unix_ms <= ?
ORDER BY watchdog_due_at_unix_ms ASC, execution_id ASC
`, workspaceID, unixMs(now))
	if err != nil {
		return fmt.Errorf("list due Tutti mode watchdogs: %w", err)
	}
	type dueExecution struct {
		id            string
		graphRevision int64
		dueAtUnixMS   int64
	}
	var due []dueExecution
	for rows.Next() {
		var item dueExecution
		if err := rows.Scan(&item.id, &item.graphRevision, &item.dueAtUnixMS); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan due Tutti mode watchdog: %w", err)
		}
		due = append(due, item)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close due Tutti mode watchdogs: %w", err)
	}
	for _, item := range due {
		if err := prepareDueTuttiModeWatchdogTx(
			ctx, tx, workspaceID, item.id, item.graphRevision,
			time.UnixMilli(item.dueAtUnixMS).UTC(), now,
		); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Tutti mode watchdog preparation: %w", err)
	}
	return nil
}

func repairStaleActiveTuttiModeCheckpointRevisionsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	now time.Time,
) error {
	_, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_executions
SET watchdog_due_at_unix_ms = MIN(watchdog_due_at_unix_ms, ?),
    updated_at_unix_ms = ?
WHERE workspace_id = ?
  AND status IN ('awaiting_schedule', 'running', 'awaiting_main', 'pending_goal_review')
  AND EXISTS (
    SELECT 1
    FROM workspace_tutti_execution_checkpoints c
    WHERE c.workspace_id = workspace_tutti_executions.workspace_id
      AND c.execution_id = workspace_tutti_executions.execution_id
      AND c.status = 'active'
      AND c.kind IN ('task_settled', 'task_failed', 'task_canceled', 'watchdog')
      AND c.graph_revision < workspace_tutti_executions.graph_revision
  )
`, unixMs(now), unixMs(now), workspaceID)
	if err != nil {
		return fmt.Errorf("advance stale Tutti mode checkpoint recovery: %w", err)
	}
	_, err = tx.ExecContext(ctx, `
UPDATE workspace_tutti_execution_checkpoints
SET graph_revision = (
      SELECT e.graph_revision
      FROM workspace_tutti_executions e
      WHERE e.workspace_id = workspace_tutti_execution_checkpoints.workspace_id
        AND e.execution_id = workspace_tutti_execution_checkpoints.execution_id
    ),
    updated_at_unix_ms = ?
WHERE workspace_id = ?
  AND status = 'active'
  AND kind IN ('task_settled', 'task_failed', 'task_canceled', 'watchdog')
  AND EXISTS (
    SELECT 1
    FROM workspace_tutti_executions e
    WHERE e.workspace_id = workspace_tutti_execution_checkpoints.workspace_id
      AND e.execution_id = workspace_tutti_execution_checkpoints.execution_id
      AND e.status IN ('awaiting_schedule', 'running', 'awaiting_main', 'pending_goal_review')
      AND workspace_tutti_execution_checkpoints.graph_revision < e.graph_revision
  )
`, unixMs(now), workspaceID)
	if err != nil {
		return fmt.Errorf("rebind stale active Tutti mode checkpoint revision: %w", err)
	}
	return nil
}

func prepareDueTuttiModeWatchdogTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	executionID string,
	graphRevision int64,
	dueAt time.Time,
	now time.Time,
) error {
	row := tx.QueryRowContext(ctx, `
SELECT checkpoint_id, execution_id, kind, status, sequence, graph_revision,
       subject_task_id, subject_run_id, creation_reason, requires_goal_review,
       created_at_unix_ms, updated_at_unix_ms, resolved_at_unix_ms
FROM workspace_tutti_execution_checkpoints
WHERE workspace_id = ? AND execution_id = ? AND status = 'active'
`, workspaceID, executionID)
	checkpoint, err := scanTuttiModeExecutionCheckpoint(row)
	if errors.Is(err, sql.ErrNoRows) {
		var maxSequence int64
		if err := tx.QueryRowContext(ctx, `
SELECT COALESCE(MAX(sequence), 0)
FROM workspace_tutti_execution_checkpoints
WHERE workspace_id = ? AND execution_id = ?
`, workspaceID, executionID).Scan(&maxSequence); err != nil {
			return fmt.Errorf("get watchdog checkpoint sequence: %w", err)
		}
		checkpointID, ok := executionbiz.WatchdogCheckpointID(
			executionID, maxSequence+1,
		)
		if !ok {
			return executionbiz.ErrWakeIntegrity
		}
		checkpoint = executionbiz.Checkpoint{
			ID: checkpointID, ExecutionID: executionID,
			Kind: executionbiz.CheckpointKindWatchdog, Status: executionbiz.CheckpointStatusActive,
			Sequence: maxSequence + 1, GraphRevision: graphRevision,
			CreationReason: "fixed_inactivity_watchdog",
			CreatedAt:      now, UpdatedAt: now,
		}
		if err := insertTuttiModeExecutionCheckpoint(
			ctx, tx, workspaceID, checkpoint,
		); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_executions
SET status = 'awaiting_main', updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ?
  AND status IN ('awaiting_schedule', 'running', 'awaiting_main', 'pending_goal_review')
`, unixMs(now), workspaceID, executionID); err != nil {
			return fmt.Errorf("activate Tutti mode watchdog checkpoint: %w", err)
		}
		return prepareTuttiModeMainWakeSequenceTx(
			ctx, tx, workspaceID, executionID, checkpoint, 1, dueAt, now,
		)
	}
	if err != nil {
		return fmt.Errorf("get active Tutti mode watchdog checkpoint: %w", err)
	}
	var latestStatus string
	var latestSequence int64
	err = tx.QueryRowContext(ctx, `
SELECT status, wake_sequence
FROM workspace_tutti_execution_wakes
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
  AND target_kind = 'main'
ORDER BY wake_sequence DESC LIMIT 1
`, workspaceID, executionID, checkpoint.ID).Scan(&latestStatus, &latestSequence)
	if errors.Is(err, sql.ErrNoRows) {
		return prepareTuttiModeMainWakeSequenceTx(
			ctx, tx, workspaceID, executionID, checkpoint, 1, dueAt, now,
		)
	}
	if err != nil {
		return fmt.Errorf("get active checkpoint wake generation: %w", err)
	}
	if latestStatus != string(executionbiz.WakeStatusTurnSettled) {
		return nil
	}
	return prepareTuttiModeMainWakeSequenceTx(
		ctx, tx, workspaceID, executionID, checkpoint,
		latestSequence+1, dueAt, now,
	)
}

func (s *SQLiteStore) ObserveTuttiModeSourceSessionActivity(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	now time.Time,
) error {
	if err := s.ensureIssueDatabase(); err != nil {
		return err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	sessionID = strings.TrimSpace(sessionID)
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Tutti mode source-session activity: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := observeTuttiModeSourceSessionActivityTx(
		ctx, tx, workspaceID, sessionID, now,
	); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Tutti mode source-session activity: %w", err)
	}
	return nil
}

func acknowledgeTuttiModeCheckpointWakesTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	executionID string,
	checkpointID string,
	now time.Time,
) error {
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET status = 'acknowledged', lease_owner = '', lease_expires_at_unix_ms = 0,
    acknowledged_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
  AND status IN ('prepared', 'leased', 'dispatched', 'turn_settled')
`, unixMs(now), unixMs(now), workspaceID, executionID, checkpointID)
	if err != nil {
		return fmt.Errorf("acknowledge Tutti mode checkpoint wakes: %w", err)
	}
	return requireRowsAffected(
		result,
		executionbiz.ErrWakeRejected,
		"acknowledge Tutti mode checkpoint wake",
	)
}

func (s *SQLiteStore) ListTuttiModeExecutionWakes(
	ctx context.Context,
	workspaceID string,
	issueID string,
) ([]executionbiz.Wake, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return nil, err
	}
	rows, err := s.readDB.QueryContext(ctx, wakeSelectQuery+`
WHERE e.workspace_id = ? AND e.issue_id = ?
ORDER BY c.sequence ASC, w.wake_sequence ASC
`, strings.TrimSpace(workspaceID), strings.TrimSpace(issueID))
	if err != nil {
		return nil, fmt.Errorf("list Tutti mode execution wakes: %w", err)
	}
	return scanTuttiModeWakes(rows)
}

func (s *SQLiteStore) ListDispatchableTuttiModeMainWakes(
	ctx context.Context,
	workspaceID string,
	now time.Time,
) ([]executionbiz.Wake, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return nil, err
	}
	rows, err := s.readDB.QueryContext(ctx, wakeSelectQuery+`
WHERE e.workspace_id = ?
  AND e.status IN ('awaiting_schedule', 'running', 'awaiting_main', 'pending_goal_review')
  AND c.status = 'active'
  AND w.target_kind = 'main' AND w.status = 'prepared'
  AND w.due_at_unix_ms <= ?
ORDER BY w.due_at_unix_ms ASC, e.execution_id ASC, c.sequence ASC, w.wake_sequence ASC
`, strings.TrimSpace(workspaceID), unixMs(now))
	if err != nil {
		return nil, fmt.Errorf("list dispatchable Tutti mode main wakes: %w", err)
	}
	return scanTuttiModeWakes(rows)
}

func (s *SQLiteStore) ListDispatchedTuttiModeMainWakes(
	ctx context.Context,
	workspaceID string,
) ([]executionbiz.Wake, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return nil, err
	}
	rows, err := s.readDB.QueryContext(ctx, wakeSelectQuery+`
WHERE e.workspace_id = ?
  AND e.status IN ('awaiting_schedule', 'running', 'awaiting_main', 'pending_goal_review')
  AND c.status = 'active'
  AND w.status = 'dispatched'
  AND w.target_kind = 'main'
ORDER BY w.dispatched_at_unix_ms ASC, e.execution_id ASC, c.sequence ASC
`, strings.TrimSpace(workspaceID))
	if err != nil {
		return nil, fmt.Errorf("list dispatched Tutti mode main wakes: %w", err)
	}
	return scanTuttiModeWakes(rows)
}

func (s *SQLiteStore) ListCorruptedTuttiModeMainWakes(
	ctx context.Context,
	workspaceID string,
	now time.Time,
) ([]executionbiz.Wake, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return nil, err
	}
	rows, err := s.readDB.QueryContext(ctx, wakeSelectQuery+`
WHERE e.workspace_id = ?
  AND e.status IN ('awaiting_schedule', 'running', 'awaiting_main', 'pending_goal_review')
  AND c.status = 'active'
  AND w.status = 'prepared' AND w.due_at_unix_ms <= ?
  AND w.target_kind != 'main'
  AND w.wake_sequence > 0
  AND w.wake_id = c.checkpoint_id || ':wake:main:' || CAST(w.wake_sequence AS TEXT)
  AND w.client_submit_id = 'tutti-execution-wake:' || w.wake_id
ORDER BY w.due_at_unix_ms ASC, e.execution_id ASC, c.sequence ASC
`, strings.TrimSpace(workspaceID), unixMs(now))
	if err != nil {
		return nil, fmt.Errorf("list corrupted Tutti mode main wakes: %w", err)
	}
	return scanTuttiModeWakes(rows)
}

func (s *SQLiteStore) GetTuttiModeExecutionWake(
	ctx context.Context,
	workspaceID string,
	wakeID string,
) (executionbiz.Wake, bool, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return executionbiz.Wake{}, false, err
	}
	wake, err := scanTuttiModeWake(s.readDB.QueryRowContext(ctx, wakeSelectQuery+`
WHERE e.workspace_id = ? AND w.wake_id = ?
`, strings.TrimSpace(workspaceID), strings.TrimSpace(wakeID)))
	if errors.Is(err, sql.ErrNoRows) {
		return executionbiz.Wake{}, false, nil
	}
	if err != nil {
		return executionbiz.Wake{}, false, fmt.Errorf("get Tutti mode execution wake: %w", err)
	}
	return wake, true, nil
}

func (s *SQLiteStore) ClaimTuttiModeExecutionWake(
	ctx context.Context,
	workspaceID string,
	wakeID string,
	leaseOwner string,
	now time.Time,
	leaseExpiresAt time.Time,
) (bool, error) {
	futureActivityCutoff := unixMs(now.Add(-executionbiz.WatchdogInterval))
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET status = 'leased', attempt_count = attempt_count + 1,
    lease_owner = ?, lease_expires_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND wake_id = ? AND status = 'prepared'
  AND due_at_unix_ms <= ?
  AND NOT EXISTS (
    SELECT 1
    FROM (`+tuttiModeRelevantSourceActivitySelectSQL+`) relevant_activity
    WHERE relevant_activity.workspace_id =
      workspace_tutti_execution_wakes.workspace_id
      AND relevant_activity.agent_session_id =
        workspace_tutti_execution_wakes.target_session_id
      AND relevant_activity.activity_at_unix_ms > (
        SELECT e.last_orchestrator_activity_at_unix_ms
        FROM workspace_tutti_executions e
        WHERE e.workspace_id = workspace_tutti_execution_wakes.workspace_id
          AND e.execution_id = workspace_tutti_execution_wakes.execution_id
      )
      AND relevant_activity.activity_at_unix_ms > ?
  )
  AND EXISTS (
    SELECT 1
    FROM workspace_tutti_executions e
    JOIN workspace_tutti_execution_checkpoints c
      ON c.workspace_id = e.workspace_id AND c.execution_id = e.execution_id
    WHERE e.workspace_id = workspace_tutti_execution_wakes.workspace_id
      AND e.execution_id = workspace_tutti_execution_wakes.execution_id
      AND e.source_session_id = workspace_tutti_execution_wakes.target_session_id
      AND e.status IN ('awaiting_schedule', 'running', 'awaiting_main', 'pending_goal_review')
      AND c.checkpoint_id = workspace_tutti_execution_wakes.checkpoint_id
      AND c.status = 'active'
  )
`, leaseOwner, unixMs(leaseExpiresAt), unixMs(now), workspaceID, wakeID,
		unixMs(now), futureActivityCutoff)
	if err != nil {
		return false, fmt.Errorf("claim Tutti mode execution wake: %w", err)
	}
	affected, err := result.RowsAffected()
	return affected == 1, err
}

func (s *SQLiteStore) ReleaseTuttiModeExecutionWake(
	ctx context.Context,
	workspaceID string,
	wakeID string,
	leaseOwner string,
	message string,
	now time.Time,
) error {
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET status = 'prepared', lease_owner = '', lease_expires_at_unix_ms = 0,
    last_error = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND wake_id = ? AND status = 'leased' AND lease_owner = ?
`, strings.TrimSpace(message), unixMs(now), workspaceID, wakeID, leaseOwner)
	if err != nil {
		return fmt.Errorf("release Tutti mode execution wake: %w", err)
	}
	return requireRowsAffected(result, executionbiz.ErrWakeRejected, "release owned Tutti mode execution wake")
}

func (s *SQLiteStore) MarkTuttiModeExecutionWakeDispatched(
	ctx context.Context,
	workspaceID string,
	wakeID string,
	leaseOwner string,
	canonicalSessionID string,
	canonicalTurnID string,
	expectedDueAt time.Time,
	now time.Time,
) error {
	futureActivityCutoff := unixMs(now.Add(-executionbiz.WatchdogInterval))
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET status = 'dispatched', canonical_session_id = ?, canonical_turn_id = ?,
    lease_owner = '', lease_expires_at_unix_ms = 0, last_error = '',
    dispatched_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND wake_id = ? AND status = 'leased' AND lease_owner = ?
  AND lease_expires_at_unix_ms > ?
  AND due_at_unix_ms = ? AND due_at_unix_ms <= ?
  AND target_session_id = ?
  AND NOT EXISTS (
    SELECT 1
    FROM (`+tuttiModeRelevantSourceActivitySelectSQL+`) relevant_activity
    WHERE relevant_activity.workspace_id =
      workspace_tutti_execution_wakes.workspace_id
      AND relevant_activity.agent_session_id =
        workspace_tutti_execution_wakes.target_session_id
      AND relevant_activity.activity_at_unix_ms > (
        SELECT e.last_orchestrator_activity_at_unix_ms
        FROM workspace_tutti_executions e
        WHERE e.workspace_id = workspace_tutti_execution_wakes.workspace_id
          AND e.execution_id = workspace_tutti_execution_wakes.execution_id
      )
      AND relevant_activity.activity_at_unix_ms > ?
  )
  AND EXISTS (
    SELECT 1
    FROM workspace_tutti_executions e
    JOIN workspace_tutti_execution_checkpoints c
      ON c.workspace_id = e.workspace_id AND c.execution_id = e.execution_id
    WHERE e.workspace_id = workspace_tutti_execution_wakes.workspace_id
      AND e.execution_id = workspace_tutti_execution_wakes.execution_id
      AND e.source_session_id = workspace_tutti_execution_wakes.target_session_id
      AND e.status IN ('awaiting_schedule', 'running', 'awaiting_main', 'pending_goal_review')
      AND c.checkpoint_id = workspace_tutti_execution_wakes.checkpoint_id
      AND c.status = 'active'
  )
`, canonicalSessionID, canonicalTurnID, unixMs(now), unixMs(now),
		workspaceID, wakeID, leaseOwner, unixMs(now),
		unixMs(expectedDueAt), unixMs(now), canonicalSessionID,
		futureActivityCutoff)
	if err != nil {
		return fmt.Errorf("mark Tutti mode execution wake dispatched: %w", err)
	}
	return requireRowsAffected(result, executionbiz.ErrWakeRejected, "dispatch owned Tutti mode execution wake")
}

func (s *SQLiteStore) MarkTuttiModeExecutionWakeTurnSettled(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	turnID string,
	now time.Time,
) (bool, error) {
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin Tutti mode main wake Turn settlement: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var executionID string
	err = tx.QueryRowContext(ctx, `
SELECT execution_id
FROM workspace_tutti_execution_wakes
WHERE workspace_id = ? AND target_kind = 'main' AND status = 'dispatched'
  AND canonical_session_id = ? AND canonical_turn_id = ?
`, workspaceID, sessionID, turnID).Scan(&executionID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("find Tutti mode main wake Turn: %w", err)
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET status = 'turn_settled', turn_settled_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND target_kind = 'main' AND status = 'dispatched'
  AND canonical_session_id = ? AND canonical_turn_id = ?
`, unixMs(now), unixMs(now), workspaceID, sessionID, turnID)
	if err != nil {
		return false, fmt.Errorf("settle Tutti mode main wake Turn: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil || affected != 1 {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_executions
SET last_orchestrator_activity_at_unix_ms = ?,
    watchdog_due_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ?
  AND status IN ('awaiting_schedule', 'running', 'awaiting_main', 'pending_goal_review')
  AND last_orchestrator_activity_at_unix_ms < ?
`, unixMs(now), unixMs(now.Add(executionbiz.WatchdogInterval)), unixMs(now),
		workspaceID, executionID, unixMs(now)); err != nil {
		return false, fmt.Errorf("reset watchdog after main wake Turn: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit Tutti mode main wake Turn settlement: %w", err)
	}
	return true, nil
}

func (s *SQLiteStore) FailTuttiModeExecutionWakeIntegrity(
	ctx context.Context,
	workspaceID string,
	wakeID string,
	message string,
	now time.Time,
) error {
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET status = 'failed', lease_owner = '', lease_expires_at_unix_ms = 0,
    last_error = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND wake_id = ? AND status IN ('prepared', 'leased')
`, strings.TrimSpace(message), unixMs(now), workspaceID, wakeID)
	if err != nil {
		return fmt.Errorf("fail invalid Tutti mode execution wake: %w", err)
	}
	return requireRowsAffected(result, executionbiz.ErrWakeRejected, "fail invalid Tutti mode execution wake")
}

func (s *SQLiteStore) RequeueExpiredTuttiModeExecutionWakes(
	ctx context.Context,
	workspaceID string,
	now time.Time,
) error {
	_, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET status = 'prepared', lease_owner = '', lease_expires_at_unix_ms = 0,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND status = 'leased' AND lease_expires_at_unix_ms <= ?
`, unixMs(now), strings.TrimSpace(workspaceID), unixMs(now))
	if err != nil {
		return fmt.Errorf("requeue expired Tutti mode execution wakes: %w", err)
	}
	return nil
}

func (s *SQLiteStore) CancelSuppressedTuttiModeExecutionWakes(
	ctx context.Context,
	workspaceID string,
	now time.Time,
) error {
	_, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET status = 'canceled', lease_owner = '', lease_expires_at_unix_ms = 0,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND status IN ('prepared', 'leased', 'dispatched', 'turn_settled')
  AND EXISTS (
    SELECT 1 FROM workspace_tutti_executions e
    WHERE e.workspace_id = workspace_tutti_execution_wakes.workspace_id
      AND e.execution_id = workspace_tutti_execution_wakes.execution_id
      AND e.status IN ('orphaned_source', 'completed', 'archiving', 'archived')
  )
`, unixMs(now), strings.TrimSpace(workspaceID))
	if err != nil {
		return fmt.Errorf("cancel suppressed Tutti mode execution wakes: %w", err)
	}
	return nil
}

const wakeSelectQuery = `
SELECT w.wake_id, w.workspace_id, w.execution_id, e.issue_id,
       w.checkpoint_id, c.kind, c.graph_revision, w.target_kind,
       e.review_mode, COALESCE(r.review_id, ''),
       COALESCE(r.status, ''), COALESCE(r.verdict, ''),
       COALESCE(r.summary, ''), COALESCE(r.failure_reason, ''),
       w.wake_sequence, w.client_submit_id, e.source_session_id, w.target_session_id,
       w.canonical_session_id, w.canonical_turn_id, w.status,
       w.due_at_unix_ms, w.attempt_count, w.lease_owner,
       w.lease_expires_at_unix_ms, w.dispatched_at_unix_ms,
       w.turn_settled_at_unix_ms, w.acknowledged_at_unix_ms,
       w.last_error, w.created_at_unix_ms, w.updated_at_unix_ms
FROM workspace_tutti_execution_wakes w
JOIN workspace_tutti_executions e
  ON e.workspace_id = w.workspace_id AND e.execution_id = w.execution_id
JOIN workspace_tutti_execution_checkpoints c
  ON c.workspace_id = w.workspace_id AND c.execution_id = w.execution_id
 AND c.checkpoint_id = w.checkpoint_id
LEFT JOIN workspace_tutti_goal_reviews r
  ON r.workspace_id = w.workspace_id AND r.execution_id = w.execution_id
 AND r.checkpoint_id = w.checkpoint_id
`

func scanTuttiModeWakes(rows *sql.Rows) ([]executionbiz.Wake, error) {
	defer func() { _ = rows.Close() }()
	wakes := make([]executionbiz.Wake, 0)
	for rows.Next() {
		wake, err := scanTuttiModeWake(rows)
		if err != nil {
			return nil, fmt.Errorf("scan Tutti mode execution wake: %w", err)
		}
		wakes = append(wakes, wake)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate Tutti mode execution wakes: %w", err)
	}
	return wakes, nil
}

func scanTuttiModeWake(scanner rowScanner) (executionbiz.Wake, error) {
	var wake executionbiz.Wake
	var dueAt, leaseExpiresAt, dispatchedAt, turnSettledAt, acknowledgedAt int64
	var createdAt, updatedAt int64
	err := scanner.Scan(
		&wake.ID, &wake.WorkspaceID, &wake.ExecutionID, &wake.IssueID,
		&wake.CheckpointID, &wake.CheckpointKind, &wake.CheckpointRevision,
		&wake.TargetKind, &wake.ReviewMode, &wake.ReviewID,
		&wake.ReviewStatus, &wake.ReviewVerdict, &wake.ReviewSummary,
		&wake.ReviewFailureReason, &wake.Sequence, &wake.ClientSubmitID,
		&wake.SourceSessionID, &wake.TargetSessionID,
		&wake.CanonicalSessionID, &wake.CanonicalTurnID,
		&wake.Status, &dueAt, &wake.AttemptCount, &wake.LeaseOwner,
		&leaseExpiresAt, &dispatchedAt, &turnSettledAt, &acknowledgedAt,
		&wake.LastError, &createdAt, &updatedAt,
	)
	if err != nil {
		return executionbiz.Wake{}, err
	}
	wake.DueAt = time.UnixMilli(dueAt).UTC()
	wake.LeaseExpiresAt = optionalTuttiModeExecutionTime(leaseExpiresAt)
	wake.DispatchedAt = optionalTuttiModeExecutionTime(dispatchedAt)
	wake.TurnSettledAt = optionalTuttiModeExecutionTime(turnSettledAt)
	wake.AcknowledgedAt = optionalTuttiModeExecutionTime(acknowledgedAt)
	wake.CreatedAt = time.UnixMilli(createdAt).UTC()
	wake.UpdatedAt = time.UnixMilli(updatedAt).UTC()
	return wake, nil
}
