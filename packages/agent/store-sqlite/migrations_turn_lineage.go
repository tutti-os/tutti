package storesqlite

import (
	"context"
	"fmt"
)

// applyWorkspaceAgentTurnLineageV1 adds parent_turn_id and relation columns
// to workspace_agent_turns so Retry/Edit can record turn lineage without
// introducing Child Sessions. Both columns are nullable: existing turns have
// no lineage and remain valid after migration.
func (s *Store) applyWorkspaceAgentTurnLineageV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentTurnLineageV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent turn lineage v1: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	columns := []struct {
		name string
		sql  string
	}{
		{"parent_turn_id", `ALTER TABLE workspace_agent_turns ADD COLUMN parent_turn_id TEXT`},
		{"relation", `ALTER TABLE workspace_agent_turns ADD COLUMN relation TEXT CHECK (relation IS NULL OR relation IN ('retry', 'edit'))`},
	}
	for _, column := range columns {
		hasColumn, err := hasColumnTx(ctx, tx, "workspace_agent_turns", column.name)
		if err != nil {
			return err
		}
		if !hasColumn {
			if _, err := tx.ExecContext(ctx, column.sql); err != nil {
				return fmt.Errorf("add workspace agent turn %s: %w", column.name, err)
			}
		}
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentTurnLineageV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent turn lineage v1: %w", err)
	}
	committed = true
	return nil
}
