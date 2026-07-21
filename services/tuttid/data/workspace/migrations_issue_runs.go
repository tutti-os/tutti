package workspace

import (
	"context"
	"fmt"
	"time"
)

const schemaMigrationWorkspaceIssuesV12 = "workspace_issue_tasks_launch_overrides_v1"
const schemaMigrationWorkspaceIssuesV13 = "workspace_issue_tasks_parallelizable_v1"

// applyWorkspaceIssuesV12 introduces the task-level assignment and launch
// override fields recorded from the Tutti Mode plan review: per-task agent
// target, model plan, model, execution directory, dependency graph, permission
// mode, and reasoning effort. Empty values inherit the target default and the
// Issue-level intensity. The migration is additive so existing local Issue
// Manager data remains valid.
func (s *SQLiteStore) applyWorkspaceIssuesV12(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV12)
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
		{"agent_target_id", "TEXT NOT NULL DEFAULT ''"},
		{"model_plan_id", "TEXT NOT NULL DEFAULT ''"},
		{"model", "TEXT NOT NULL DEFAULT ''"},
		{"execution_directory", "TEXT NOT NULL DEFAULT ''"},
		{"dependency_task_ids_json", "TEXT NOT NULL DEFAULT '[]'"},
		{"permission_mode_id", "TEXT NOT NULL DEFAULT ''"},
		{"reasoning_effort", "TEXT NOT NULL DEFAULT ''"},
	}
	for _, column := range columns {
		hasColumn, err := s.hasColumn(ctx, "workspace_issue_tasks", column.name)
		if err != nil {
			return err
		}
		if hasColumn {
			continue
		}
		statement := fmt.Sprintf("ALTER TABLE workspace_issue_tasks ADD COLUMN %s %s;", column.name, column.definition)
		if _, err := s.writeDB.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("add workspace_issue_tasks.%s: %w", column.name, err)
		}
	}
	if _, err := s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV12, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace issue task launch overrides migration: %w", err)
	}
	return nil
}

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
