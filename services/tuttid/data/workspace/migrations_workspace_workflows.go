package workspace

import (
	"context"
	"fmt"
	"time"
)

func (s *SQLiteStore) applyWorkspaceWorkflowsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceWorkflowsV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	_, err = s.writeDB.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS workspace_workflows (
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL CHECK (workflow_type = 'tutti_mode_plan'),
  owner TEXT NOT NULL CHECK (owner = 'tutti'),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind = 'agent_cli'),
  source_session_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  source_tool_call_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_review', 'in_progress', 'accepted', 'rejected', 'completed', 'failed', 'canceled')),
  current_revision_id TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, workflow_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_workflows_source_session_pending
  ON workspace_workflows(workspace_id, source_session_id, status, updated_at_unix_ms DESC);

CREATE TABLE IF NOT EXISTS tutti_mode_plans (
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, workflow_id),
  FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES workspace_workflows(workspace_id, workflow_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_workflow_turn_links (
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('source', 'decomposition', 'revision', 'feedback')),
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, workflow_id, turn_id, relation),
  FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES workspace_workflows(workspace_id, workflow_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_workflow_turn_links_turn
  ON workspace_workflow_turn_links(workspace_id, turn_id);

CREATE TABLE IF NOT EXISTS workspace_workflow_plan_revisions (
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision_sequence INTEGER NOT NULL CHECK (revision_sequence > 0),
  schema_version TEXT NOT NULL,
  document_path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  produced_by_turn_id TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, workflow_id, revision_id),
  UNIQUE (workspace_id, workflow_id, revision_sequence),
  FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES tutti_mode_plans(workspace_id, workflow_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_workflow_checkpoints (
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('configuration_review', 'task_review')),
  revision_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded', 'canceled')),
  decided_by TEXT NOT NULL DEFAULT '',
  decision_reason TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  decided_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, workflow_id, checkpoint_id),
  FOREIGN KEY (workspace_id, workflow_id, revision_id)
    REFERENCES workspace_workflow_plan_revisions(workspace_id, workflow_id, revision_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_workflow_checkpoints_pending
  ON workspace_workflow_checkpoints(workspace_id, workflow_id, status, created_at_unix_ms);

CREATE TABLE IF NOT EXISTS workspace_workflow_operations (
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('generate_task_graph', 'create_revision', 'create_issue', 'start_issue')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
  revision_id TEXT,
  issue_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  completed_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, workflow_id, operation_id),
  FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES workspace_workflows(workspace_id, workflow_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, workflow_id, revision_id)
    REFERENCES workspace_workflow_plan_revisions(workspace_id, workflow_id, revision_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_workspace_workflow_operations_status
  ON workspace_workflow_operations(workspace_id, workflow_id, status, created_at_unix_ms);

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceWorkflowsV1, unixMs(time.Now().UTC()))
	if err != nil {
		return fmt.Errorf("migrate workspace workflows v1: %w", err)
	}
	return nil
}
