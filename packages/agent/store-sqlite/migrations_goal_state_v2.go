package storesqlite

import (
	"context"
	"fmt"
)

// Goal state v2 turns the control log into a recoverable outbox. The Goal
// table remains the source of desired state; these columns only describe
// delivery ownership and the furthest durable provider phase.
func (s *Store) applyWorkspaceAgentGoalStateV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentGoalStateV2)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent goal state v2: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, statement := range []string{
		`ALTER TABLE workspace_agent_goal_control_operations ADD COLUMN provider_phase TEXT NOT NULL DEFAULT 'prepared'`,
		`ALTER TABLE workspace_agent_goal_control_operations ADD COLUMN lease_owner TEXT`,
		`ALTER TABLE workspace_agent_goal_control_operations ADD COLUMN lease_expires_at_unix_ms INTEGER`,
		`ALTER TABLE workspace_agent_goal_control_operations ADD COLUMN next_attempt_at_unix_ms INTEGER`,
		`ALTER TABLE workspace_agent_goal_control_operations ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0`,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate workspace agent goal state v2: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_goal_control_operations
SET provider_phase = CASE status
  WHEN 'prepared' THEN 'prepared'
  WHEN 'dispatched' THEN 'dispatched'
  WHEN 'completed' THEN 'applied'
  ELSE 'unknown'
END,
next_attempt_at_unix_ms = CASE WHEN status IN ('prepared','dispatched') THEN updated_at_unix_ms ELSE NULL END;
DROP INDEX IF EXISTS idx_workspace_agent_goal_operations_pending;
CREATE INDEX idx_workspace_agent_goal_operations_claimable
  ON workspace_agent_goal_control_operations(status, next_attempt_at_unix_ms, lease_expires_at_unix_ms, created_at_unix_ms, operation_id);
`); err != nil {
		return fmt.Errorf("backfill workspace agent goal state v2: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentGoalStateV2); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent goal state v2: %w", err)
	}
	return nil
}
