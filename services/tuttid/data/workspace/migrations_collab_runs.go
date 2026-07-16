package workspace

import (
	"context"
	"fmt"
	"time"
)

func (s *SQLiteStore) applyCollabRunsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationCollabRunsV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	_, err = s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS collaboration_runs (
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  trigger_reason TEXT NOT NULL DEFAULT '',
  source_session_id TEXT NOT NULL DEFAULT '',
  target_session_id TEXT NOT NULL DEFAULT '',
  target_agent_target_id TEXT NOT NULL DEFAULT '',
  model_plan_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  context_scope TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  result_text TEXT NOT NULL DEFAULT '',
  failure_reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  adoption TEXT NOT NULL DEFAULT 'pending',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  completed_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, run_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_collaboration_runs_workspace_source
  ON collaboration_runs(workspace_id, source_session_id);

CREATE INDEX IF NOT EXISTS idx_collaboration_runs_workspace_created
  ON collaboration_runs(workspace_id, created_at_unix_ms DESC);

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationCollabRunsV1, now)
	if err != nil {
		return fmt.Errorf("migrate collaboration runs v1: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyCollabRunsRetryV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationCollabRunsRetryV1)
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
		{"context_text", "TEXT NOT NULL DEFAULT ''"},
		{"request_text", "TEXT NOT NULL DEFAULT ''"},
		{"retry_of_run_id", "TEXT NOT NULL DEFAULT ''"},
		{"attempt", "INTEGER NOT NULL DEFAULT 1"},
		{"failure_stage", "TEXT NOT NULL DEFAULT ''"},
		{"cost_currency", "TEXT NOT NULL DEFAULT ''"},
		{"estimated_cost_micros", "INTEGER NOT NULL DEFAULT 0"},
	}
	for _, column := range columns {
		hasColumn, err := s.hasColumn(ctx, "collaboration_runs", column.name)
		if err != nil {
			return err
		}
		if hasColumn {
			continue
		}
		if _, err := s.db.ExecContext(ctx, "ALTER TABLE collaboration_runs ADD COLUMN "+column.name+" "+column.definition+";"); err != nil {
			return fmt.Errorf("add collaboration retry column %s: %w", column.name, err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `
CREATE INDEX IF NOT EXISTS idx_collaboration_runs_retry_parent
  ON collaboration_runs(workspace_id, retry_of_run_id);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationCollabRunsRetryV1, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("migrate collaboration retry v1: %w", err)
	}
	return nil
}

// applyCollabRunsUsageV1 preserves provider-reported cache token categories
// instead of folding or dropping them from collaboration accounting.
func (s *SQLiteStore) applyCollabRunsUsageV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationCollabRunsUsageV1)
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
		{"cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"},
		{"cache_write_tokens", "INTEGER NOT NULL DEFAULT 0"},
	}
	for _, column := range columns {
		hasColumn, err := s.hasColumn(ctx, "collaboration_runs", column.name)
		if err != nil {
			return err
		}
		if hasColumn {
			continue
		}
		if _, err := s.db.ExecContext(ctx, "ALTER TABLE collaboration_runs ADD COLUMN "+column.name+" "+column.definition+";"); err != nil {
			return fmt.Errorf("add collaboration usage column %s: %w", column.name, err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationCollabRunsUsageV1, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("migrate collaboration usage v1: %w", err)
	}
	return nil
}
