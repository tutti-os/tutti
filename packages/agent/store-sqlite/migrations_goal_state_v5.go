package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentGoalStateV5(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentGoalStateV5)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, c := range []struct{ name, ddl string }{
		{"first_dispatched_at_unix_ms", `ALTER TABLE workspace_agent_goal_control_operations ADD COLUMN first_dispatched_at_unix_ms INTEGER`},
		{"dispatched_attempt", `ALTER TABLE workspace_agent_goal_control_operations ADD COLUMN dispatched_attempt INTEGER NOT NULL DEFAULT 0`},
	} {
		exists, e := hasColumnTx(ctx, tx, "workspace_agent_goal_control_operations", c.name)
		if e != nil {
			return e
		}
		if !exists {
			if _, e = tx.ExecContext(ctx, c.ddl); e != nil {
				return fmt.Errorf("add goal dispatch column %s: %w", c.name, e)
			}
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE workspace_agent_goal_control_operations SET
 first_dispatched_at_unix_ms=CASE WHEN first_dispatched_at_unix_ms IS NULL OR first_dispatched_at_unix_ms=0 THEN updated_at_unix_ms ELSE first_dispatched_at_unix_ms END,
 dispatched_attempt=CASE WHEN dispatched_attempt=0 THEN attempt ELSE dispatched_attempt END
WHERE status IN ('prepared','dispatched') AND provider_phase IN ('dispatched','accepted','applied')
 AND (first_dispatched_at_unix_ms IS NULL OR first_dispatched_at_unix_ms=0 OR dispatched_attempt=0)`); err != nil {
		return fmt.Errorf("backfill goal dispatch baseline: %w", err)
	}
	if err = recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentGoalStateV5); err != nil {
		return err
	}
	return tx.Commit()
}
