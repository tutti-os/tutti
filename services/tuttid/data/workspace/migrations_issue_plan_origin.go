package workspace

import (
	"context"
	"fmt"
	"time"
)

// applyWorkspaceIssuesV14 records the plan origin and reviewed execution
// settings of an Issue created from an accepted Tutti Mode or traditional
// plan: planning source provenance, sequential/parallel execution flags,
// execution profile, and token budget. The migration is additive so existing
// local Issue Manager data remains valid.
func (s *SQLiteStore) applyWorkspaceIssuesV14(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV14)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	columns := []struct {
		name       string
		definition string
	}{
		{"planning_source", "TEXT NOT NULL DEFAULT 'manual'"},
		{"source_session_id", "TEXT NOT NULL DEFAULT ''"},
		{"sequential_execution", "INTEGER NOT NULL DEFAULT 0"},
		{"parallel_execution", "INTEGER NOT NULL DEFAULT 0"},
		{"reasoning_intensity", "INTEGER NOT NULL DEFAULT 50"},
		{"orchestration_intensity", "INTEGER NOT NULL DEFAULT 50"},
		{"budget_mode", "TEXT NOT NULL DEFAULT 'auto'"},
		{"budget_token_limit", "INTEGER NOT NULL DEFAULT 0"},
		{"budget_consumed_tokens", "INTEGER NOT NULL DEFAULT 0"},
		{"budget_quota_waterline_percent", "REAL NOT NULL DEFAULT 10"},
		{"budget_remaining_quota_percent", "REAL NOT NULL DEFAULT 0"},
		{"budget_has_remaining_quota", "INTEGER NOT NULL DEFAULT 0"},
		{"budget_status", "TEXT NOT NULL DEFAULT 'active'"},
	}
	for _, column := range columns {
		hasColumn, err := s.hasColumn(ctx, "workspace_issues", column.name)
		if err != nil {
			return err
		}
		if hasColumn {
			continue
		}
		statement := fmt.Sprintf("ALTER TABLE workspace_issues ADD COLUMN %s %s;", column.name, column.definition)
		if _, err := s.writeDB.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("add workspace_issues.%s: %w", column.name, err)
		}
	}
	if _, err := s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV14, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace issue plan origin migration: %w", err)
	}
	return nil
}
