package workspace

import (
	"context"
	"fmt"
	"time"
)

// applyWorkspaceIssuesV6 adds the durable execution profile, task assignment,
// dependency, acceptance, and run-accounting fields used by Ultra Plan. The
// migration is additive so existing local Issue Manager data remains valid.
func (s *SQLiteStore) applyWorkspaceIssuesV6(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV6)
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
		{"workspace_issues", "planning_source", "TEXT NOT NULL DEFAULT 'manual'"},
		{"workspace_issues", "source_session_id", "TEXT NOT NULL DEFAULT ''"},
		{"workspace_issues", "reasoning_intensity", "INTEGER NOT NULL DEFAULT 50"},
		{"workspace_issues", "orchestration_intensity", "INTEGER NOT NULL DEFAULT 50"},
		{"workspace_issues", "budget_mode", "TEXT NOT NULL DEFAULT 'auto'"},
		{"workspace_issues", "budget_token_limit", "INTEGER NOT NULL DEFAULT 0"},
		{"workspace_issues", "budget_consumed_tokens", "INTEGER NOT NULL DEFAULT 0"},
		{"workspace_issues", "budget_quota_waterline_percent", "REAL NOT NULL DEFAULT 10"},
		{"workspace_issues", "budget_remaining_quota_percent", "REAL NOT NULL DEFAULT 0"},
		{"workspace_issues", "budget_has_remaining_quota", "INTEGER NOT NULL DEFAULT 0"},
		{"workspace_issues", "budget_status", "TEXT NOT NULL DEFAULT 'active'"},
		{"workspace_issues", "cost_currency", "TEXT NOT NULL DEFAULT 'USD'"},
		{"workspace_issues", "estimated_cost_micros", "INTEGER NOT NULL DEFAULT 0"},
		{"workspace_issues", "actual_cost_micros", "INTEGER NOT NULL DEFAULT 0"},
		{"workspace_issue_tasks", "agent_target_id", "TEXT NOT NULL DEFAULT ''"},
		{"workspace_issue_tasks", "model_plan_id", "TEXT NOT NULL DEFAULT ''"},
		{"workspace_issue_tasks", "model", "TEXT NOT NULL DEFAULT ''"},
		{"workspace_issue_tasks", "execution_directory", "TEXT NOT NULL DEFAULT ''"},
		{"workspace_issue_tasks", "dependency_task_ids_json", "TEXT NOT NULL DEFAULT '[]'"},
		{"workspace_issue_tasks", "acceptance_state", "TEXT NOT NULL DEFAULT 'agent_claimed'"},
		{"workspace_issue_tasks", "acceptance_summary", "TEXT NOT NULL DEFAULT ''"},
		{"workspace_issue_runs", "model_plan_id", "TEXT NOT NULL DEFAULT ''"},
		{"workspace_issue_runs", "model", "TEXT NOT NULL DEFAULT ''"},
		{"workspace_issue_runs", "reasoning_intensity", "INTEGER NOT NULL DEFAULT 50"},
		{"workspace_issue_runs", "input_tokens", "INTEGER NOT NULL DEFAULT 0"},
		{"workspace_issue_runs", "output_tokens", "INTEGER NOT NULL DEFAULT 0"},
		{"workspace_issue_runs", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"},
		{"workspace_issue_runs", "cache_write_tokens", "INTEGER NOT NULL DEFAULT 0"},
		{"workspace_issue_runs", "cost_currency", "TEXT NOT NULL DEFAULT 'USD'"},
		{"workspace_issue_runs", "estimated_cost_micros", "INTEGER NOT NULL DEFAULT 0"},
		{"workspace_issue_runs", "actual_cost_micros", "INTEGER NOT NULL DEFAULT 0"},
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
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("add %s.%s: %w", column.table, column.name, err)
		}
	}

	if _, err := s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV6, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace issue orchestration migration: %w", err)
	}
	return nil
}

// applyWorkspaceIssuesV7 persists the Create-and-Start orchestration choice.
// Keeping it on the Issue lets successor dispatch continue after a desktop
// restart instead of relying on renderer-local state.
func (s *SQLiteStore) applyWorkspaceIssuesV7(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV7)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	hasColumn, err := s.hasColumn(ctx, "workspace_issues", "sequential_execution")
	if err != nil {
		return err
	}
	if !hasColumn {
		if _, err := s.db.ExecContext(ctx, "ALTER TABLE workspace_issues ADD COLUMN sequential_execution INTEGER NOT NULL DEFAULT 0;"); err != nil {
			return fmt.Errorf("add workspace_issues.sequential_execution: %w", err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV7, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace issue sequential execution migration: %w", err)
	}
	return nil
}

// applyWorkspaceIssuesV8 records whether an auto-started Issue may dispatch
// multiple dependency-ready Tasks. Existing Issues remain sequential/manual.
func (s *SQLiteStore) applyWorkspaceIssuesV8(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV8)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	hasColumn, err := s.hasColumn(ctx, "workspace_issues", "parallel_execution")
	if err != nil {
		return err
	}
	if !hasColumn {
		if _, err := s.db.ExecContext(ctx, "ALTER TABLE workspace_issues ADD COLUMN parallel_execution INTEGER NOT NULL DEFAULT 0;"); err != nil {
			return fmt.Errorf("add workspace_issues.parallel_execution: %w", err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV8, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace issue parallel execution migration: %w", err)
	}
	return nil
}

// applyWorkspaceIssuesV9 persists the user's explicit pause choice. A pause
// blocks only future dispatch; already-running Agent sessions continue and
// can still settle their durable runs.
func (s *SQLiteStore) applyWorkspaceIssuesV9(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV9)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	hasColumn, err := s.hasColumn(ctx, "workspace_issues", "dispatch_paused")
	if err != nil {
		return err
	}
	if !hasColumn {
		if _, err := s.db.ExecContext(ctx, "ALTER TABLE workspace_issues ADD COLUMN dispatch_paused INTEGER NOT NULL DEFAULT 0;"); err != nil {
			return fmt.Errorf("add workspace_issues.dispatch_paused: %w", err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV9, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace issue dispatch pause migration: %w", err)
	}
	return nil
}

// applyWorkspaceIssuesV10 adds an idempotent ledger for collaboration usage
// associated with an Issue. Task-delegate CollaborationRuns that mirror an
// Issue Run are deliberately excluded by the resolver before insertion.
func (s *SQLiteStore) applyWorkspaceIssuesV10(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV10)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS workspace_issue_collaboration_usage (
  workspace_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  collaboration_run_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL DEFAULT '',
  target_session_id TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_currency TEXT NOT NULL DEFAULT '',
  estimated_cost_micros INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, collaboration_run_id),
  FOREIGN KEY (workspace_id, issue_id)
    REFERENCES workspace_issues(workspace_id, issue_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_issue_collaboration_usage_issue
  ON workspace_issue_collaboration_usage(workspace_id, issue_id, created_at_unix_ms);

CREATE INDEX IF NOT EXISTS idx_workspace_issue_collaboration_usage_target_session
  ON workspace_issue_collaboration_usage(workspace_id, target_session_id);

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV10, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("migrate workspace issue collaboration usage: %w", err)
	}
	return nil
}
