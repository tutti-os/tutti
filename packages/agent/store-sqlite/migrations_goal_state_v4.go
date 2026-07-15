package storesqlite

import (
	"context"
	"fmt"
)

// V4 preserves the first provider acceptance time and its attempt baseline so
// repeated safe clear retries cannot extend the convergence deadline forever.
func (s *Store) applyWorkspaceAgentGoalStateV4(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentGoalStateV4)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, column := range []struct{ name, ddl string }{
		{"accepted_at_unix_ms", `ALTER TABLE workspace_agent_goal_control_operations ADD COLUMN accepted_at_unix_ms INTEGER`},
		{"accepted_attempt", `ALTER TABLE workspace_agent_goal_control_operations ADD COLUMN accepted_attempt INTEGER NOT NULL DEFAULT 0`},
	} {
		exists, columnErr := hasColumnTx(ctx, tx, "workspace_agent_goal_control_operations", column.name)
		if columnErr != nil {
			return columnErr
		}
		if !exists {
			if _, columnErr = tx.ExecContext(ctx, column.ddl); columnErr != nil {
				return fmt.Errorf("add goal accepted column %s: %w", column.name, columnErr)
			}
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE workspace_agent_goal_control_operations
SET accepted_at_unix_ms = CASE
      WHEN accepted_at_unix_ms IS NULL OR accepted_at_unix_ms = 0 THEN updated_at_unix_ms
      ELSE accepted_at_unix_ms
    END,
    accepted_attempt = CASE
      WHEN accepted_attempt = 0 THEN attempt
      ELSE accepted_attempt
    END
WHERE provider_phase = 'accepted'
  AND (accepted_at_unix_ms IS NULL OR accepted_at_unix_ms = 0 OR accepted_attempt = 0)`); err != nil {
		return fmt.Errorf("backfill accepted goal operation baseline: %w", err)
	}
	if err = recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentGoalStateV4); err != nil {
		return err
	}
	return tx.Commit()
}
