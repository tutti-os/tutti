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
