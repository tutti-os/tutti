package workspace

import (
	"context"
	"fmt"
	"time"
)

// applyWorkspaceIssuesV15 adds the execution-lifecycle fields the Tutti Mode
// Issue run loop needs: the explicit dispatch pause on the Issue, the durable
// acceptance verdict on each task, and the per-run launch (model plan, model,
// reasoning intensity) and token-usage accounting columns. The migration is
// additive so existing local Issue Manager data remains valid.
func (s *SQLiteStore) applyWorkspaceIssuesV15(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV15)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	columns := []struct {
		table      string
		name       string
		definition string
	}{
		{"workspace_issues", "dispatch_paused", "INTEGER NOT NULL DEFAULT 0"},
		{"workspace_issue_tasks", "acceptance_state", "TEXT NOT NULL DEFAULT 'agent_claimed'"},
		{"workspace_issue_tasks", "acceptance_summary", "TEXT NOT NULL DEFAULT ''"},
		{"workspace_issue_runs", "model_plan_id", "TEXT NOT NULL DEFAULT ''"},
		{"workspace_issue_runs", "model", "TEXT NOT NULL DEFAULT ''"},
		{"workspace_issue_runs", "reasoning_intensity", "INTEGER NOT NULL DEFAULT 50"},
		{"workspace_issue_runs", "input_tokens", "INTEGER NOT NULL DEFAULT 0"},
		{"workspace_issue_runs", "output_tokens", "INTEGER NOT NULL DEFAULT 0"},
		{"workspace_issue_runs", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"},
		{"workspace_issue_runs", "cache_write_tokens", "INTEGER NOT NULL DEFAULT 0"},
	}
	for _, column := range columns {
		hasColumn, err := s.hasColumn(ctx, column.table, column.name)
		if err != nil {
			return err
		}
		if hasColumn {
			continue
		}
		statement := fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s;", column.table, column.name, column.definition)
		if _, err := s.writeDB.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("add %s.%s: %w", column.table, column.name, err)
		}
	}
	if _, err := s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV15, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace issue execution lifecycle migration: %w", err)
	}
	return nil
}

// applyWorkspaceIssuesV16 records the per-task acceptance bypass from the
// Tutti Mode plan review. False keeps the default human acceptance gate;
// true auto-accepts a successful completion so dispatch advances unattended.
func (s *SQLiteStore) applyWorkspaceIssuesV16(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV16)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	hasColumn, err := s.hasColumn(ctx, "workspace_issue_tasks", "auto_accept")
	if err != nil {
		return err
	}
	if !hasColumn {
		if _, err := s.writeDB.ExecContext(ctx, "ALTER TABLE workspace_issue_tasks ADD COLUMN auto_accept INTEGER NOT NULL DEFAULT 0;"); err != nil {
			return fmt.Errorf("add workspace_issue_tasks.auto_accept: %w", err)
		}
	}
	if _, err := s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV16, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace issue task auto accept migration: %w", err)
	}
	return nil
}
