package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentRuntimeOperationsV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentRuntimeOperationsV3)
	if err != nil || applied {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `
ALTER TABLE workspace_agent_runtime_operation_events RENAME TO workspace_agent_runtime_operation_events_v2;
DROP INDEX IF EXISTS idx_workspace_agent_runtime_operation_events_workspace;

CREATE TABLE workspace_agent_runtime_operation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('interactive_completed','turn_canceled','plan_decision_pending_confirmation','plan_decision_completed')),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at_unix_ms INTEGER NOT NULL,
  published_at_unix_ms INTEGER,
  FOREIGN KEY (operation_id) REFERENCES workspace_agent_runtime_operations(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id) ON DELETE CASCADE,
  UNIQUE (operation_id, kind)
);

INSERT INTO workspace_agent_runtime_operation_events
SELECT * FROM workspace_agent_runtime_operation_events_v2;

CREATE INDEX idx_workspace_agent_runtime_operation_events_workspace
  ON workspace_agent_runtime_operation_events(workspace_id, published_at_unix_ms, id);

DROP TABLE workspace_agent_runtime_operation_events_v2;
`); err != nil {
		return fmt.Errorf("migrate workspace agent runtime operations v3: %w", err)
	}
	return s.recordMigration(ctx, schemaMigrationWorkspaceAgentRuntimeOperationsV3)
}
