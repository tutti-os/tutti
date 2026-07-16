package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentGoalStateV7(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentGoalStateV7)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	exists, err := hasColumnTx(ctx, tx, "workspace_agent_goal_control_operations", "client_submit_id")
	if err != nil {
		return err
	}
	if !exists {
		if _, err = tx.ExecContext(ctx, `ALTER TABLE workspace_agent_goal_control_operations ADD COLUMN client_submit_id TEXT NOT NULL DEFAULT ''`); err != nil {
			return fmt.Errorf("add goal client submit identity: %w", err)
		}
	}
	if err = recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentGoalStateV7); err != nil {
		return err
	}
	return tx.Commit()
}
