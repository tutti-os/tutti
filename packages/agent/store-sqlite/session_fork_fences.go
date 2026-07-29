package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
)

func activeSessionForkSourceOperationTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID, agentSessionID string,
) (string, bool, error) {
	var operationID string
	err := tx.QueryRowContext(ctx, `
SELECT operation_id
FROM workspace_agent_session_fork_operations
WHERE workspace_id = ?
  AND source_agent_session_id = ?
  AND status IN ('prepared','dispatching','provider_accepted')
LIMIT 1
`, workspaceID, agentSessionID).Scan(&operationID)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read active session fork source reservation: %w", err)
	}
	return operationID, true, nil
}

// requireSessionForkSourceWritableTx is called by every canonical activity
// entity write path. The fence remains held through provider acceptance and is
// released only by a terminal fork transition.
func requireSessionForkSourceWritableTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID, agentSessionID string,
) error {
	_, active, err := activeSessionForkSourceOperationTx(ctx, tx, workspaceID, agentSessionID)
	if err != nil {
		return err
	}
	if active {
		return ErrSessionForkInProgress
	}
	return nil
}

func requireSessionForkSourceQuiescentTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID, agentSessionID string,
) error {
	var busy int
	if err := tx.QueryRowContext(ctx, `
SELECT EXISTS(
  SELECT 1
  FROM workspace_agent_goal_control_operations
  WHERE workspace_id = ? AND agent_session_id = ?
    AND status IN ('prepared','dispatched')
  UNION ALL
  SELECT 1
  FROM workspace_agent_runtime_operations
  WHERE workspace_id = ? AND agent_session_id = ?
    AND status IN ('prepared','leased')
  UNION ALL
  SELECT 1
  FROM workspace_agent_session_goals
  WHERE workspace_id = ? AND agent_session_id = ?
    AND (
      pending_operation_id IS NOT NULL
      OR sync_status IN ('pending','applying')
    )
  UNION ALL
  SELECT 1
  FROM workspace_agent_goal_reconcile_inbox
  WHERE workspace_id = ? AND agent_session_id = ?
    AND status IN ('prepared','leased')
  UNION ALL
  SELECT 1
  FROM workspace_agent_submit_claims
  WHERE workspace_id = ? AND agent_session_id = ?
    AND status = 'prepared'
)
`, workspaceID, agentSessionID, workspaceID, agentSessionID,
		workspaceID, agentSessionID, workspaceID, agentSessionID,
		workspaceID, agentSessionID).Scan(&busy); err != nil {
		return fmt.Errorf("read session fork source quiescence: %w", err)
	}
	if busy != 0 {
		return ErrSessionForkSourceState
	}
	return nil
}

func requireSessionForkDeleteAllowedTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionIDs []string,
) error {
	for _, agentSessionID := range normalizedSessionIDs(agentSessionIDs) {
		if err := requireSessionForkSourceWritableTx(ctx, tx, workspaceID, agentSessionID); err != nil {
			return err
		}
		var status string
		err := tx.QueryRowContext(ctx, `
SELECT operation.status
FROM workspace_agent_session_fork_target_reservations reservation
JOIN workspace_agent_session_fork_operations operation
  ON operation.operation_id = reservation.operation_id
WHERE reservation.workspace_id = ?
  AND reservation.target_agent_session_id = ?
`, workspaceID, agentSessionID).Scan(&status)
		if err == sql.ErrNoRows {
			continue
		}
		if err != nil {
			return fmt.Errorf("read session fork target reservation for delete: %w", err)
		}
		if status != SessionForkStatusCommitted {
			return ErrSessionForkTargetReserved
		}
	}
	return nil
}
