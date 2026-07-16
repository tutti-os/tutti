package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentGoalStateV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentGoalStateV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent goal state v1: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if _, err := tx.ExecContext(ctx, `
CREATE TABLE workspace_agent_session_goals (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  desired_json TEXT CHECK (desired_json IS NULL OR json_valid(desired_json)),
  observed_json TEXT CHECK (observed_json IS NULL OR json_valid(observed_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  tombstoned INTEGER NOT NULL DEFAULT 0 CHECK (tombstoned IN (0,1)),
  sync_status TEXT NOT NULL CHECK (sync_status IN ('pending','applying','synced','diverged','unknown','failed')),
  pending_operation_id TEXT,
  last_evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(last_evidence_json)),
  last_error TEXT NOT NULL DEFAULT '',
  observed_at_unix_ms INTEGER,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id),
  FOREIGN KEY (workspace_id, agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id) ON DELETE CASCADE
);

CREATE TABLE workspace_agent_goal_control_operations (
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) > 0),
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
  action TEXT NOT NULL CHECK (action IN ('pause','resume','clear','set','reconcile')),
  objective TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('prepared','dispatched','completed','failed','superseded')),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  last_error TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  completed_at_unix_ms INTEGER,
  UNIQUE (workspace_id, agent_session_id, goal_revision),
  FOREIGN KEY (workspace_id, agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id) ON DELETE CASCADE
);

INSERT INTO workspace_agent_session_goals (
  workspace_id, agent_session_id, desired_json, observed_json, revision,
  tombstoned, sync_status, last_evidence_json, observed_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms
)
SELECT workspace_id, agent_session_id,
       json_extract(session_metadata_json, '$.goal'),
       json_extract(session_metadata_json, '$.goal'),
       0, 0,
       CASE WHEN json_type(session_metadata_json, '$.goal') = 'object' THEN 'synced' ELSE 'unknown' END,
       '{"source":"migration_backfill","confidence":"persisted_session_snapshot"}',
       last_event_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_sessions
WHERE deleted_at_unix_ms = 0;

CREATE INDEX idx_workspace_agent_goal_operations_pending
  ON workspace_agent_goal_control_operations(status, updated_at_unix_ms, operation_id);
CREATE INDEX idx_workspace_agent_goal_operations_session
  ON workspace_agent_goal_control_operations(workspace_id, agent_session_id, goal_revision DESC);
`); err != nil {
		return fmt.Errorf("migrate workspace agent goal state v1: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentGoalStateV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent goal state v1: %w", err)
	}
	committed = true
	return nil
}
