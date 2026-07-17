package workspace

import (
	"context"
	"fmt"
	"time"
)

func (s *SQLiteStore) applyWorkspaceAgentsV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentsV2)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent fallbacks migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agents
  ADD COLUMN model_fallbacks_json TEXT NOT NULL DEFAULT '[]';
`); err != nil {
		return fmt.Errorf("add workspace agent model fallbacks: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationWorkspaceAgentsV2, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace agent fallbacks migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent fallbacks migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyWorkspaceAgentsV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentsV3)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent call conditions migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agents
  ADD COLUMN call_conditions_json TEXT NOT NULL DEFAULT '[]';
`); err != nil {
		return fmt.Errorf("add workspace agent call conditions: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationWorkspaceAgentsV3, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace agent call conditions migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent call conditions migration: %w", err)
	}
	return nil
}

// applyWorkspaceAgentsV5 is the Wave 4-2 contract cleanup migration. It
// renames the user-facing purpose text into the retained description field,
// retires the per-Agent enabled switch by normalizing every stored row to
// enabled, and clears retired permission overrides. The legacy purpose,
// enabled, and permissions_json columns stay in place physically (SQLite
// column drops rebuild the table) but are no longer read or written.
func (s *SQLiteStore) applyWorkspaceAgentsV5(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentsV5)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent contract cleanup migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agents
  ADD COLUMN description TEXT NOT NULL DEFAULT '';

UPDATE workspace_agents SET description = purpose;

UPDATE workspace_agents SET enabled = 1 WHERE enabled <> 1;

UPDATE workspace_agents SET permissions_json = '[]' WHERE permissions_json <> '[]';
`); err != nil {
		return fmt.Errorf("apply workspace agent contract cleanup: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationWorkspaceAgentsV5, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace agent contract cleanup migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent contract cleanup migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyWorkspaceAgentsV4(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentsV4)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent capability selection migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agents
  ADD COLUMN capabilities_explicit INTEGER NOT NULL DEFAULT 0;

UPDATE workspace_agents
SET capabilities_explicit = 1
WHERE skills_json <> '[]' OR tools_json <> '[]';
`); err != nil {
		return fmt.Errorf("add workspace agent capability selection: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationWorkspaceAgentsV4, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace agent capability selection migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent capability selection migration: %w", err)
	}
	return nil
}
