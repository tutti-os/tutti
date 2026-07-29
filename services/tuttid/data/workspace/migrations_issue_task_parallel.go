package workspace

import (
	"context"
	"fmt"
	"time"
)

// applyWorkspaceIssuesV13 records the per-task parallel opt-in from the Tutti
// Mode plan review. Sequential stays the default: false means the task waits
// for its predecessors, true lets it run alongside other ready tasks.
func (s *SQLiteStore) applyWorkspaceIssuesV13(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV13)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	hasColumn, err := s.hasColumn(ctx, "workspace_issue_tasks", "parallelizable")
	if err != nil {
		return err
	}
	if !hasColumn {
		if _, err := s.writeDB.ExecContext(ctx, "ALTER TABLE workspace_issue_tasks ADD COLUMN parallelizable INTEGER NOT NULL DEFAULT 0;"); err != nil {
			return fmt.Errorf("add workspace_issue_tasks.parallelizable: %w", err)
		}
	}
	if _, err := s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV13, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace issue task parallelizable migration: %w", err)
	}
	return nil
}
