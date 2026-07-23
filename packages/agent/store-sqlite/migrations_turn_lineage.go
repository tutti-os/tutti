package storesqlite

import (
	"context"
	"fmt"
	"strings"
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

// applyWorkspaceAgentTurnLineageV2 installs SQLite checks for lineage shape.
// Parent existence and settlement stay in the transactional Go store boundary,
// where they can return a useful error and preserve compatibility with existing
// rows; these triggers protect direct SQLite writes from malformed pairs.
func (s *Store) applyWorkspaceAgentTurnLineageV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentTurnLineageV2)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent turn lineage v2: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	for _, event := range []string{"INSERT", "UPDATE"} {
		name := "workspace_agent_turns_lineage_" + strings.ToLower(event) + "_check"
		statement := fmt.Sprintf(`CREATE TRIGGER IF NOT EXISTS %s
BEFORE %s ON workspace_agent_turns
FOR EACH ROW
WHEN (
  (NEW.parent_turn_id IS NULL) != (NEW.relation IS NULL) OR
  (NEW.parent_turn_id IS NOT NULL AND (length(trim(NEW.parent_turn_id)) = 0 OR NEW.parent_turn_id = NEW.turn_id)) OR
  (NEW.relation IS NOT NULL AND NEW.relation NOT IN ('retry', 'edit'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid workspace agent turn lineage');
END`, name, event)
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("create workspace agent turn lineage %s check: %w", strings.ToLower(event), err)
		}
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentTurnLineageV2); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent turn lineage v2: %w", err)
	}
	committed = true
	return nil
}
