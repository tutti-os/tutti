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

func (s *SQLiteStore) RotateTuttiModeExecutionWakeAfterCanceledDelivery(
	ctx context.Context,
	workspaceID string,
	wakeID string,
	leaseOwner string,
	message string,
	now time.Time,
) error {
	if err := s.ensureIssueDatabase(); err != nil {
		return err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	wakeID = strings.TrimSpace(wakeID)
	leaseOwner = strings.TrimSpace(leaseOwner)
	if workspaceID == "" || wakeID == "" || leaseOwner == "" {
		return executionbiz.ErrWakeRejected
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin canceled Tutti mode wake rotation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var (
		executionID    string
		issueID        string
		checkpointID   string
		clientSubmitID string
		sourceSession  string
		targetSession  string
		sequence       int64
	)
	err = tx.QueryRowContext(ctx, `
SELECT w.execution_id, e.issue_id, w.checkpoint_id, w.wake_sequence,
       w.client_submit_id, e.source_session_id, w.target_session_id
FROM workspace_tutti_execution_wakes w
JOIN workspace_tutti_executions e
  ON e.workspace_id = w.workspace_id AND e.execution_id = w.execution_id
JOIN workspace_tutti_execution_checkpoints c
  ON c.workspace_id = w.workspace_id AND c.execution_id = w.execution_id
 AND c.checkpoint_id = w.checkpoint_id
WHERE w.workspace_id = ? AND w.wake_id = ?
  AND w.target_kind = 'main'
  AND w.status = 'leased' AND w.lease_owner = ?
  AND w.lease_expires_at_unix_ms > ?
  AND e.status IN ('awaiting_schedule', 'running', 'awaiting_main', 'pending_goal_review')
  AND c.status = 'active'
`, workspaceID, wakeID, leaseOwner, unixMs(now)).Scan(
		&executionID,
		&issueID,
		&checkpointID,
		&sequence,
		&clientSubmitID,
		&sourceSession,
		&targetSession,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return executionbiz.ErrWakeRejected
	}
	if err != nil {
		return fmt.Errorf("get canceled Tutti mode wake rotation authority: %w", err)
	}
	expectedExecutionID, executionOK := executionbiz.ExecutionID(issueID)
	expectedWakeID, wakeOK := executionbiz.MainWakeID(checkpointID, sequence)
	expectedClientSubmitID, submitOK := executionbiz.MainWakeClientSubmitID(expectedWakeID)
	if !executionOK || executionID != expectedExecutionID ||
		!wakeOK || wakeID != expectedWakeID ||
		!submitOK || clientSubmitID != expectedClientSubmitID ||
		strings.TrimSpace(sourceSession) == "" ||
		targetSession != sourceSession {
		return executionbiz.ErrWakeIntegrity
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET status = 'canceled', lease_owner = '', lease_expires_at_unix_ms = 0,
    last_error = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND wake_id = ?
  AND status = 'leased' AND lease_owner = ?
  AND lease_expires_at_unix_ms > ?
`, strings.TrimSpace(message), unixMs(now), workspaceID, wakeID, leaseOwner, unixMs(now))
	if err != nil {
		return fmt.Errorf("cancel delivered Tutti mode wake: %w", err)
	}
	if err := requireRowsAffected(
		result,
		executionbiz.ErrWakeRejected,
		"cancel delivered Tutti mode wake",
	); err != nil {
		return err
	}
	checkpoint := executionbiz.Checkpoint{
		ID:     checkpointID,
		Status: executionbiz.CheckpointStatusActive,
	}
	if err := prepareTuttiModeMainWakeSequenceTx(
		ctx,
		tx,
		workspaceID,
		executionID,
		checkpoint,
		sequence+1,
		now,
		now,
	); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit canceled Tutti mode wake rotation: %w", err)
	}
	return nil
}
