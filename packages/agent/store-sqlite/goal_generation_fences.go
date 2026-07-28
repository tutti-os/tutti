package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

const goalGenerationFenceColumns = `
fence_id,workspace_id,agent_session_id,target_operation_id,target_revision,target_repair_epoch,
client_submit_id,reason,status,clear_operation_id,COALESCE(lease_owner,''),
COALESCE(lease_expires_at_unix_ms,0),COALESCE(next_attempt_at_unix_ms,0),attempt,last_error,
created_at_unix_ms,updated_at_unix_ms,COALESCE(completed_at_unix_ms,0)`

func scanGoalGenerationFence(row rowScanner) (GoalGenerationFence, error) {
	var fence GoalGenerationFence
	err := row.Scan(
		&fence.FenceID, &fence.WorkspaceID, &fence.AgentSessionID, &fence.TargetOperationID,
		&fence.TargetRevision, &fence.TargetRepairEpoch, &fence.ClientSubmitID, &fence.Reason,
		&fence.Status, &fence.ClearOperationID, &fence.LeaseOwner, &fence.LeaseExpiresAtUnixMS,
		&fence.NextAttemptAtUnixMS, &fence.Attempt, &fence.LastError, &fence.CreatedAtUnixMS,
		&fence.UpdatedAtUnixMS, &fence.CompletedAtUnixMS,
	)
	return fence, err
}

func (s *Store) PrepareGoalGenerationFence(ctx context.Context, input GoalGenerationFencePrepare) (GoalGenerationFence, bool, error) {
	input.FenceID = strings.TrimSpace(input.FenceID)
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.TargetOperationID = strings.TrimSpace(input.TargetOperationID)
	input.ClientSubmitID = strings.TrimSpace(input.ClientSubmitID)
	input.Reason = strings.TrimSpace(input.Reason)
	if input.FenceID == "" || input.WorkspaceID == "" || input.AgentSessionID == "" ||
		input.TargetOperationID == "" || input.OccurredAtUnixMS <= 0 {
		return GoalGenerationFence{}, false, ErrGoalGenerationFenceConflict
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GoalGenerationFence{}, false, err
	}
	defer func() { _ = tx.Rollback() }()

	target, found, err := getGoalControlOperationTx(ctx, tx, input.WorkspaceID, input.TargetOperationID)
	if err != nil {
		return GoalGenerationFence{}, false, err
	}
	if !found || target.AgentSessionID != input.AgentSessionID || target.GoalRevision <= 0 {
		return GoalGenerationFence{}, false, ErrGoalGenerationFenceConflict
	}
	result, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO workspace_agent_goal_generation_fences (
 fence_id,workspace_id,agent_session_id,target_operation_id,target_revision,target_repair_epoch,
 client_submit_id,reason,status,created_at_unix_ms,updated_at_unix_ms
) VALUES (?,?,?,?,?,?,?,?,?,?,?)
`, input.FenceID, input.WorkspaceID, input.AgentSessionID, input.TargetOperationID,
		target.GoalRevision, target.RepairEpoch, input.ClientSubmitID, input.Reason,
		GoalGenerationFenceStatusPending, input.OccurredAtUnixMS, input.OccurredAtUnixMS)
	if err != nil {
		return GoalGenerationFence{}, false, err
	}
	created, err := rowsWereAffected(result, "prepare goal generation fence")
	if err != nil {
		return GoalGenerationFence{}, false, err
	}
	fence, found, err := getGoalGenerationFenceTx(ctx, tx, input.WorkspaceID, input.FenceID)
	if err != nil {
		return GoalGenerationFence{}, false, err
	}
	if !found {
		// Another request may already own the unique target/client identity.
		fence, found, err = findGoalGenerationFenceTx(ctx, tx, input.WorkspaceID, input.AgentSessionID, input.TargetOperationID, input.ClientSubmitID)
		if err != nil {
			return GoalGenerationFence{}, false, err
		}
	}
	if !found || fence.AgentSessionID != input.AgentSessionID ||
		fence.TargetOperationID != input.TargetOperationID ||
		(input.ClientSubmitID != "" && fence.ClientSubmitID != input.ClientSubmitID) {
		return GoalGenerationFence{}, false, ErrGoalGenerationFenceConflict
	}
	if err := tx.Commit(); err != nil {
		return GoalGenerationFence{}, false, err
	}
	return fence, created, nil
}

func (s *Store) GetGoalGenerationFence(ctx context.Context, workspaceID, fenceID string) (GoalGenerationFence, bool, error) {
	return getGoalGenerationFence(ctx, s.db, strings.TrimSpace(workspaceID), strings.TrimSpace(fenceID))
}

func getGoalGenerationFenceTx(ctx context.Context, tx *sql.Tx, workspaceID, fenceID string) (GoalGenerationFence, bool, error) {
	return getGoalGenerationFence(ctx, tx, workspaceID, fenceID)
}

func getGoalGenerationFence(ctx context.Context, q goalProvenanceQueryer, workspaceID, fenceID string) (GoalGenerationFence, bool, error) {
	fence, err := scanGoalGenerationFence(q.QueryRowContext(ctx, `
SELECT `+goalGenerationFenceColumns+` FROM workspace_agent_goal_generation_fences
WHERE workspace_id=? AND fence_id=?`, workspaceID, fenceID))
	if errors.Is(err, sql.ErrNoRows) {
		return GoalGenerationFence{}, false, nil
	}
	return fence, err == nil, err
}

func findGoalGenerationFenceTx(ctx context.Context, tx *sql.Tx, workspaceID, agentSessionID, targetOperationID, clientSubmitID string) (GoalGenerationFence, bool, error) {
	query := `SELECT ` + goalGenerationFenceColumns + ` FROM workspace_agent_goal_generation_fences
WHERE workspace_id=? AND agent_session_id=? AND target_operation_id=?`
	args := []any{workspaceID, agentSessionID, targetOperationID}
	if clientSubmitID != "" {
		query += ` AND client_submit_id=?`
		args = append(args, clientSubmitID)
	}
	fence, err := scanGoalGenerationFence(tx.QueryRowContext(ctx, query, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return GoalGenerationFence{}, false, nil
	}
	return fence, err == nil, err
}

func (s *Store) ListGoalGenerationFencesForSession(ctx context.Context, workspaceID, agentSessionID string) ([]GoalGenerationFence, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+goalGenerationFenceColumns+`
FROM workspace_agent_goal_generation_fences
WHERE workspace_id=? AND agent_session_id=?
ORDER BY target_revision,target_operation_id`, strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var fences []GoalGenerationFence
	for rows.Next() {
		fence, scanErr := scanGoalGenerationFence(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		fences = append(fences, fence)
	}
	return fences, rows.Err()
}

func (s *Store) ListClaimableGoalGenerationFences(ctx context.Context, input ListClaimableGoalGenerationFencesInput) ([]GoalGenerationFence, error) {
	if input.NowUnixMS <= 0 || input.Limit <= 0 {
		return nil, ErrGoalGenerationFenceConflict
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+goalGenerationFenceColumns+`
FROM workspace_agent_goal_generation_fences
WHERE (status=? AND (next_attempt_at_unix_ms IS NULL OR next_attempt_at_unix_ms<=?))
   OR (status=? AND lease_expires_at_unix_ms<=?)
ORDER BY created_at_unix_ms,fence_id LIMIT ?`,
		GoalGenerationFenceStatusPending, input.NowUnixMS,
		GoalGenerationFenceStatusProcessing, input.NowUnixMS, input.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var fences []GoalGenerationFence
	for rows.Next() {
		fence, scanErr := scanGoalGenerationFence(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		fences = append(fences, fence)
	}
	return fences, rows.Err()
}

func (s *Store) ClaimGoalGenerationFence(ctx context.Context, input ClaimGoalGenerationFenceInput) (GoalGenerationFence, bool, error) {
	input.FenceID = strings.TrimSpace(input.FenceID)
	input.LeaseOwner = strings.TrimSpace(input.LeaseOwner)
	if input.FenceID == "" || input.LeaseOwner == "" || input.NowUnixMS <= 0 || input.LeaseExpiresAtMS <= input.NowUnixMS {
		return GoalGenerationFence{}, false, ErrGoalGenerationFenceConflict
	}
	result, err := s.db.ExecContext(ctx, `UPDATE workspace_agent_goal_generation_fences
SET status=?,lease_owner=?,lease_expires_at_unix_ms=?,attempt=attempt+1,updated_at_unix_ms=?
WHERE fence_id=? AND (
 (status=? AND (next_attempt_at_unix_ms IS NULL OR next_attempt_at_unix_ms<=?))
 OR (status=? AND lease_expires_at_unix_ms<=?)
)`, GoalGenerationFenceStatusProcessing, input.LeaseOwner, input.LeaseExpiresAtMS, input.NowUnixMS,
		input.FenceID, GoalGenerationFenceStatusPending, input.NowUnixMS,
		GoalGenerationFenceStatusProcessing, input.NowUnixMS)
	if err != nil {
		return GoalGenerationFence{}, false, err
	}
	claimed, err := rowsWereAffected(result, "claim goal generation fence")
	if err != nil || !claimed {
		return GoalGenerationFence{}, false, err
	}
	fence, err := scanGoalGenerationFence(s.db.QueryRowContext(ctx, `SELECT `+goalGenerationFenceColumns+`
FROM workspace_agent_goal_generation_fences WHERE fence_id=?`, input.FenceID))
	return fence, err == nil, err
}

func (s *Store) ReleaseGoalGenerationFence(ctx context.Context, input ReleaseGoalGenerationFenceInput) (GoalGenerationFence, bool, error) {
	input.FenceID = strings.TrimSpace(input.FenceID)
	input.LeaseOwner = strings.TrimSpace(input.LeaseOwner)
	input.ClearOperationID = strings.TrimSpace(input.ClearOperationID)
	if input.FenceID == "" || input.LeaseOwner == "" || input.NowUnixMS <= 0 || input.NextAttemptAtMS <= input.NowUnixMS {
		return GoalGenerationFence{}, false, ErrGoalGenerationFenceConflict
	}
	result, err := s.db.ExecContext(ctx, `UPDATE workspace_agent_goal_generation_fences
SET status=?,clear_operation_id=CASE WHEN ?<>'' THEN ? ELSE clear_operation_id END,
 lease_owner=NULL,lease_expires_at_unix_ms=NULL,next_attempt_at_unix_ms=?,last_error=?,updated_at_unix_ms=?
WHERE fence_id=? AND status=? AND lease_owner=?`,
		GoalGenerationFenceStatusPending, input.ClearOperationID, input.ClearOperationID,
		input.NextAttemptAtMS, strings.TrimSpace(input.LastError), input.NowUnixMS,
		input.FenceID, GoalGenerationFenceStatusProcessing, input.LeaseOwner)
	if err != nil {
		return GoalGenerationFence{}, false, err
	}
	changed, err := rowsWereAffected(result, "release goal generation fence")
	if err != nil || !changed {
		return GoalGenerationFence{}, false, err
	}
	fence, err := scanGoalGenerationFence(s.db.QueryRowContext(ctx, `SELECT `+goalGenerationFenceColumns+`
FROM workspace_agent_goal_generation_fences WHERE fence_id=?`, input.FenceID))
	return fence, err == nil, err
}

func (s *Store) CompleteGoalGenerationFence(ctx context.Context, input CompleteGoalGenerationFenceInput) (GoalGenerationFence, bool, error) {
	input.FenceID = strings.TrimSpace(input.FenceID)
	input.LeaseOwner = strings.TrimSpace(input.LeaseOwner)
	input.ClearOperationID = strings.TrimSpace(input.ClearOperationID)
	if input.FenceID == "" || input.LeaseOwner == "" || input.OccurredAtUnixMS <= 0 {
		return GoalGenerationFence{}, false, ErrGoalGenerationFenceConflict
	}
	result, err := s.db.ExecContext(ctx, `UPDATE workspace_agent_goal_generation_fences
SET status=?,clear_operation_id=CASE WHEN ?<>'' THEN ? ELSE clear_operation_id END,
 lease_owner=NULL,lease_expires_at_unix_ms=NULL,next_attempt_at_unix_ms=NULL,last_error='',
 completed_at_unix_ms=?,updated_at_unix_ms=?
WHERE fence_id=? AND status=? AND lease_owner=?`,
		GoalGenerationFenceStatusCompleted, input.ClearOperationID, input.ClearOperationID,
		input.OccurredAtUnixMS, input.OccurredAtUnixMS, input.FenceID,
		GoalGenerationFenceStatusProcessing, input.LeaseOwner)
	if err != nil {
		return GoalGenerationFence{}, false, err
	}
	changed, err := rowsWereAffected(result, "complete goal generation fence")
	if err != nil || !changed {
		return GoalGenerationFence{}, false, err
	}
	fence, err := scanGoalGenerationFence(s.db.QueryRowContext(ctx, `SELECT `+goalGenerationFenceColumns+`
FROM workspace_agent_goal_generation_fences WHERE fence_id=?`, input.FenceID))
	return fence, err == nil, err
}

func (s *Store) RequeueLeasedGoalGenerationFencesOnStartup(ctx context.Context, nowUnixMS int64) (int64, error) {
	if nowUnixMS <= 0 {
		return 0, ErrGoalGenerationFenceConflict
	}
	result, err := s.db.ExecContext(ctx, `UPDATE workspace_agent_goal_generation_fences
SET status=?,lease_owner=NULL,lease_expires_at_unix_ms=NULL,next_attempt_at_unix_ms=?,updated_at_unix_ms=?
WHERE status IN (?,?)`, GoalGenerationFenceStatusPending, nowUnixMS, nowUnixMS,
		GoalGenerationFenceStatusPending, GoalGenerationFenceStatusProcessing)
	if err != nil {
		return 0, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("requeue goal generation fences rows affected: %w", err)
	}
	return count, nil
}
