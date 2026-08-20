package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentGoalStateV8(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentGoalStateV8)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	exists, err := hasColumnTx(ctx, tx, "workspace_agent_session_goals", "execution_pending")
	if err != nil {
		return err
	}
	if !exists {
		if _, err = tx.ExecContext(ctx, `ALTER TABLE workspace_agent_session_goals ADD COLUMN execution_pending INTEGER NOT NULL DEFAULT 0 CHECK (execution_pending IN (0,1))`); err != nil {
			return fmt.Errorf("add Goal execution-pending state: %w", err)
		}
	}
	if err = recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentGoalStateV8); err != nil {
		return err
	}
	return tx.Commit()
}
