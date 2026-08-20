package storesqlite

import (
	"context"
	"database/sql"
)

func updateGoalStateForOperationCompletionTx(
	ctx context.Context,
	tx *sql.Tx,
	input GoalControlOperationComplete,
	op GoalControlOperation,
	syncStatus string,
	evidenceJSON string,
	stateLastError string,
	observedAtUnixMS int64,
	localStop bool,
	supersededLocalStop bool,
) (bool, error) {
	if supersededLocalStop {
		return false, nil
	}
	query := `
UPDATE workspace_agent_session_goals
SET observed_json = ?, sync_status = ?, pending_operation_id = NULL,
    execution_pending = ?, last_evidence_json = ?, last_error = ?, observed_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND pending_operation_id = ?
	`
	args := []any{
		nullableJSONMap(input.Observed), syncStatus,
		boolInt(input.ExecutionPending && goalExecutionPendingAfterObservation(true, input.Observed, syncStatus)),
		evidenceJSON, stateLastError,
		observedAtUnixMS, input.OccurredAtUnixMS, input.WorkspaceID, op.AgentSessionID, input.OperationID,
	}
	if localStop {
		query = `
UPDATE workspace_agent_session_goals
SET observed_json = ?, sync_status = ?, pending_operation_id = NULL,
    execution_pending = 0, last_evidence_json = ?, last_error = ?, observed_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND revision = ?
  AND (pending_operation_id = ? OR pending_operation_id IS NULL)
		`
		args = []any{
			nullableJSONMap(input.Observed), syncStatus, evidenceJSON, stateLastError,
			observedAtUnixMS, input.OccurredAtUnixMS, input.WorkspaceID, op.AgentSessionID,
			op.GoalRevision, input.OperationID,
		}
	}
	result, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return false, err
	}
	if !localStop {
		return true, nil
	}
	updated, err := rowsWereAffected(result, "complete local stop goal state CAS")
	if err != nil {
		return false, err
	}
	if !updated {
		return false, ErrGoalOperationConflict
	}
	return true, nil
}
