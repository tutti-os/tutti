package workspace

import (
	"context"
	"fmt"
	"time"
)

// applyWorkspaceIssuesV17 adds logical supersession metadata. Obsolete tasks
// remain durable so their Runs, outputs, and audit history stay queryable.
func (s *SQLiteStore) applyWorkspaceIssuesV17(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV17)
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
		{"superseded_at_unix_ms", "INTEGER NOT NULL DEFAULT 0"},
		{"superseded_by_task_id", "TEXT NOT NULL DEFAULT ''"},
	}
	for _, column := range columns {
		hasColumn, err := s.hasColumn(ctx, "workspace_issue_tasks", column.name)
		if err != nil {
			return err
		}
		if hasColumn {
			continue
		}
		statement := fmt.Sprintf(
			"ALTER TABLE workspace_issue_tasks ADD COLUMN %s %s;",
			column.name, column.definition,
		)
		if _, err := s.writeDB.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("add workspace_issue_tasks.%s: %w", column.name, err)
		}
	}
	if _, err := s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV17, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace issue task supersession migration: %w", err)
	}
	return nil
}
