package storesqlite

import (
	"context"
	"fmt"
	"maps"
)

// V6 is deliberately a compatibility rebuild, not a destructive migration.
// SQLite cannot add a value to a CHECK constraint in place, so it copies every
// existing operation/event row unchanged before allowing the new blocked state
// and abandoned terminal result. Older binaries can continue reading the prior
// states during a two-release rollout; writers do not emit blocked until this
// migration is present.
func (s *Store) applyWorkspaceAgentRuntimeOperationsV6(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentRuntimeOperationsV6)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent runtime operations v6: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	before, err := runtimeOperationMigrationCounts(ctx, tx, "workspace_agent_runtime_operations", "workspace_agent_runtime_operation_events")
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_runtime_operation_events RENAME TO workspace_agent_runtime_operation_events_v5;
ALTER TABLE workspace_agent_runtime_operations RENAME TO workspace_agent_runtime_operations_v5;
DROP INDEX IF EXISTS idx_workspace_agent_runtime_operations_interactive_identity;
DROP INDEX IF EXISTS idx_workspace_agent_runtime_operations_cancel_identity;
DROP INDEX IF EXISTS idx_workspace_agent_runtime_operations_plan_identity;
DROP INDEX IF EXISTS idx_workspace_agent_runtime_operations_edit_retry_identity;
DROP INDEX IF EXISTS idx_workspace_agent_runtime_operations_claimable;
DROP INDEX IF EXISTS idx_workspace_agent_runtime_operations_session;
DROP INDEX IF EXISTS idx_workspace_agent_runtime_operation_events_workspace;

CREATE TABLE workspace_agent_runtime_operations (
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) > 0),
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('interactive_response','cancel_turn','plan_decision','edit_retry')),
  status TEXT NOT NULL CHECK (status IN ('prepared','leased','blocked','completed','failed')),
  result TEXT CHECK (result IS NULL OR result IN ('answered','superseded','canceled','already_settled','applied','abandoned','failed')),
  turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
  request_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  lease_owner TEXT,
  lease_expires_at_unix_ms INTEGER,
  next_attempt_at_unix_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  last_error TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  completed_at_unix_ms INTEGER,
  CHECK ((kind = 'interactive_response' AND request_id IS NOT NULL)
      OR (kind = 'cancel_turn' AND request_id IS NULL)
      OR (kind = 'plan_decision' AND request_id IS NOT NULL AND request_id = turn_id)
      OR (kind = 'edit_retry' AND request_id IS NOT NULL AND length(request_id) > 0)),
  CHECK ((status = 'leased' AND lease_owner IS NOT NULL AND length(lease_owner) > 0 AND lease_expires_at_unix_ms > 0)
      OR (status != 'leased' AND lease_owner IS NULL AND lease_expires_at_unix_ms IS NULL)),
  CHECK ((status = 'prepared' AND next_attempt_at_unix_ms IS NOT NULL)
      OR (status != 'prepared' AND next_attempt_at_unix_ms IS NULL)),
  CHECK ((status = 'completed' AND result IS NOT NULL AND completed_at_unix_ms IS NOT NULL)
      OR (status != 'completed' AND completed_at_unix_ms IS NULL)),
  FOREIGN KEY (workspace_id, agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_session_id, turn_id)
    REFERENCES workspace_agent_turns(workspace_id, agent_session_id, turn_id) ON DELETE CASCADE
);

INSERT INTO workspace_agent_runtime_operations (
  operation_id, workspace_id, agent_session_id, kind, status, result, turn_id,
  request_id, payload_json, lease_owner, lease_expires_at_unix_ms,
  next_attempt_at_unix_ms, attempt, version, last_error, created_at_unix_ms,
  updated_at_unix_ms, completed_at_unix_ms
)
SELECT
  operation_id, workspace_id, agent_session_id, kind, status, result, turn_id,
  request_id, payload_json, lease_owner, lease_expires_at_unix_ms,
  next_attempt_at_unix_ms, attempt, version, last_error, created_at_unix_ms,
  updated_at_unix_ms, completed_at_unix_ms
FROM workspace_agent_runtime_operations_v5;

CREATE UNIQUE INDEX idx_workspace_agent_runtime_operations_interactive_identity
  ON workspace_agent_runtime_operations(workspace_id, agent_session_id, turn_id, request_id)
  WHERE kind = 'interactive_response';
CREATE UNIQUE INDEX idx_workspace_agent_runtime_operations_cancel_identity
  ON workspace_agent_runtime_operations(workspace_id, agent_session_id, turn_id)
  WHERE kind = 'cancel_turn';
CREATE UNIQUE INDEX idx_workspace_agent_runtime_operations_plan_identity
  ON workspace_agent_runtime_operations(workspace_id, agent_session_id, turn_id)
  WHERE kind = 'plan_decision';
CREATE UNIQUE INDEX idx_workspace_agent_runtime_operations_edit_retry_identity
  ON workspace_agent_runtime_operations(workspace_id, agent_session_id, request_id)
  WHERE kind = 'edit_retry';
CREATE INDEX idx_workspace_agent_runtime_operations_claimable
  ON workspace_agent_runtime_operations(status, next_attempt_at_unix_ms, lease_expires_at_unix_ms, created_at_unix_ms, operation_id);
CREATE INDEX idx_workspace_agent_runtime_operations_session
  ON workspace_agent_runtime_operations(workspace_id, agent_session_id, updated_at_unix_ms);

CREATE TABLE workspace_agent_runtime_operation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'interactive_completed','turn_canceled',
    'plan_decision_pending_confirmation','plan_decision_completed',
    'edit_retry_rollback_pending','edit_retry_rollback_confirmed',
    'edit_retry_completed','edit_retry_recovery_required','edit_retry_abandoned','edit_retry_wake'
  )),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at_unix_ms INTEGER NOT NULL,
  published_at_unix_ms INTEGER,
  FOREIGN KEY (operation_id) REFERENCES workspace_agent_runtime_operations(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id) ON DELETE CASCADE,
  UNIQUE (operation_id, kind)
);

INSERT INTO workspace_agent_runtime_operation_events (
  id, operation_id, workspace_id, agent_session_id, kind, payload_json,
  created_at_unix_ms, published_at_unix_ms
)
SELECT
  id, operation_id, workspace_id, agent_session_id, kind, payload_json,
  created_at_unix_ms, published_at_unix_ms
FROM workspace_agent_runtime_operation_events_v5;

CREATE INDEX idx_workspace_agent_runtime_operation_events_workspace
  ON workspace_agent_runtime_operation_events(workspace_id, published_at_unix_ms, id);

CREATE TABLE IF NOT EXISTS workspace_agent_runtime_operation_recovery_actions (
  operation_id TEXT NOT NULL,
  client_action_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  action_identity TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, operation_id, client_action_id),
  FOREIGN KEY (operation_id) REFERENCES workspace_agent_runtime_operations(operation_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workspace_agent_runtime_operation_recovery_actions_workspace
  ON workspace_agent_runtime_operation_recovery_actions(workspace_id, operation_id, created_at_unix_ms);

DROP TABLE workspace_agent_runtime_operation_events_v5;
DROP TABLE workspace_agent_runtime_operations_v5;
`); err != nil {
		return fmt.Errorf("migrate workspace agent runtime operations v6: %w", err)
	}
	after, err := runtimeOperationMigrationCounts(ctx, tx, "workspace_agent_runtime_operations", "workspace_agent_runtime_operation_events")
	if err != nil {
		return err
	}
	if !maps.Equal(before, after) {
		return fmt.Errorf("migrate workspace agent runtime operations v6: copied row distribution changed: before=%v after=%v", before, after)
	}
	if err := requireNoForeignKeyViolations(ctx, tx, "workspace_agent_runtime_operations"); err != nil {
		return err
	}
	if err := requireNoForeignKeyViolations(ctx, tx, "workspace_agent_runtime_operation_events"); err != nil {
		return err
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentRuntimeOperationsV6); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent runtime operations v6: %w", err)
	}
	return nil
}
