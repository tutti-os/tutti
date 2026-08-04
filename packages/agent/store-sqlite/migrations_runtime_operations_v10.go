package storesqlite

import (
	"context"
	"fmt"
)

// V10 gives every runtime-operation outbox fact a durable occurrence identity.
// Existing rows retain their IDs and get a legacy identity, while new recovery
// actions are unique by their action/proof identity rather than only kind.
func (s *Store) applyWorkspaceAgentRuntimeOperationsV10(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentRuntimeOperationsV10)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin runtime operations v10 migration: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	// sqlite_sequence records the high-water mark even when old rows have been
	// purged. Capture it before rebuilding so a restart cannot reuse a stable
	// event ID that a consumer has already seen.
	var highwater int64
	if err := tx.QueryRowContext(ctx, `
SELECT MAX(
  COALESCE((SELECT seq FROM sqlite_sequence WHERE name='workspace_agent_runtime_operation_events'), 0),
  COALESCE((SELECT MAX(id) FROM workspace_agent_runtime_operation_events), 0)
)`).Scan(&highwater); err != nil {
		return fmt.Errorf("read runtime operation event sequence: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_runtime_operation_events RENAME TO workspace_agent_runtime_operation_events_v9;
DROP INDEX IF EXISTS idx_workspace_agent_runtime_operation_events_workspace;
DROP INDEX IF EXISTS idx_workspace_agent_runtime_operation_events_pending_retry;
CREATE TABLE workspace_agent_runtime_operation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'interactive_completed','turn_canceled','plan_decision_pending_confirmation','plan_decision_completed',
    'edit_retry_rollback_pending','edit_retry_rollback_confirmed','edit_retry_completed',
    'edit_retry_recovery_required','edit_retry_abandoned','edit_retry_wake','edit_retry_replacement_authorized'
  )),
  occurrence_key TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at_unix_ms INTEGER NOT NULL,
  published_at_unix_ms INTEGER,
  publish_attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_unix_ms INTEGER,
  last_error_code TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (operation_id) REFERENCES workspace_agent_runtime_operations(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_session_id) REFERENCES workspace_agent_sessions(workspace_id, agent_session_id) ON DELETE CASCADE,
  UNIQUE (operation_id, kind, occurrence_key)
);
INSERT INTO workspace_agent_runtime_operation_events (
 id,operation_id,workspace_id,agent_session_id,kind,occurrence_key,payload_json,created_at_unix_ms,published_at_unix_ms,publish_attempt,next_attempt_at_unix_ms,last_error_code
) SELECT id,operation_id,workspace_id,agent_session_id,kind,'legacy:' || id,payload_json,created_at_unix_ms,published_at_unix_ms,publish_attempt,next_attempt_at_unix_ms,last_error_code
FROM workspace_agent_runtime_operation_events_v9;
CREATE INDEX idx_workspace_agent_runtime_operation_events_workspace ON workspace_agent_runtime_operation_events(workspace_id,published_at_unix_ms,id);
CREATE INDEX idx_workspace_agent_runtime_operation_events_pending_retry ON workspace_agent_runtime_operation_events(published_at_unix_ms,next_attempt_at_unix_ms,id);
DROP TABLE workspace_agent_runtime_operation_events_v9;
`); err != nil {
		return fmt.Errorf("migrate runtime operations v10: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE sqlite_sequence SET seq = CASE WHEN seq < ? THEN ? ELSE seq END WHERE name='workspace_agent_runtime_operation_events'`, highwater, highwater); err != nil {
		return fmt.Errorf("restore runtime operation event sequence: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO sqlite_sequence(name, seq) SELECT 'workspace_agent_runtime_operation_events', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='workspace_agent_runtime_operation_events')`, highwater); err != nil {
		return fmt.Errorf("initialize runtime operation event sequence: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentRuntimeOperationsV10); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit runtime operations v10 migration: %w", err)
	}
	committed = true
	return nil
}
