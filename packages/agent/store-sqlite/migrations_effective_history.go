package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentEffectiveHistoryV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentEffectiveHistoryV1)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent effective history migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS workspace_agent_session_history (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  history_revision INTEGER NOT NULL DEFAULT 0 CHECK (history_revision >= 0),
  recovery_state TEXT NOT NULL DEFAULT 'ready'
    CHECK (recovery_state IN ('ready','rollback_pending','resend_pending','recovery_required')),
  operation_id TEXT NOT NULL DEFAULT '',
  updated_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, agent_session_id),
  FOREIGN KEY (workspace_id, agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_agent_turn_history (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  history_state TEXT NOT NULL DEFAULT 'effective'
    CHECK (history_state IN ('effective','retracted')),
  retracted_by_operation_id TEXT NOT NULL DEFAULT '',
  replacement_turn_id TEXT NOT NULL DEFAULT '',
  updated_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, agent_session_id, turn_id),
  FOREIGN KEY (workspace_id, agent_session_id, turn_id)
    REFERENCES workspace_agent_turns(workspace_id, agent_session_id, turn_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_agent_turn_history_effective
  ON workspace_agent_turn_history(
    workspace_id, agent_session_id, history_state, updated_at_unix_ms DESC, turn_id DESC
  );

CREATE TABLE IF NOT EXISTS workspace_agent_turn_submissions (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  display_prompt TEXT NOT NULL DEFAULT '',
  capability_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(capability_refs_json)),
  tutti_mode_snapshot_json TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(tutti_mode_snapshot_json)),
  client_submit_id TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id, turn_id),
  FOREIGN KEY (workspace_id, agent_session_id, turn_id)
    REFERENCES workspace_agent_turns(workspace_id, agent_session_id, turn_id) ON DELETE CASCADE
);

DELETE FROM workspace_agent_turn_submissions
WHERE NOT EXISTS (
  SELECT 1 FROM workspace_agent_turns turns
  WHERE turns.workspace_id = workspace_agent_turn_submissions.workspace_id
    AND turns.agent_session_id = workspace_agent_turn_submissions.agent_session_id
    AND turns.turn_id = workspace_agent_turn_submissions.turn_id
);
DELETE FROM workspace_agent_turn_history
WHERE NOT EXISTS (
  SELECT 1 FROM workspace_agent_turns turns
  WHERE turns.workspace_id = workspace_agent_turn_history.workspace_id
    AND turns.agent_session_id = workspace_agent_turn_history.agent_session_id
    AND turns.turn_id = workspace_agent_turn_history.turn_id
);
DELETE FROM workspace_agent_session_history
WHERE NOT EXISTS (
  SELECT 1 FROM workspace_agent_sessions sessions
  WHERE sessions.workspace_id = workspace_agent_session_history.workspace_id
    AND sessions.agent_session_id = workspace_agent_session_history.agent_session_id
);

INSERT OR IGNORE INTO workspace_agent_session_history (
  workspace_id, agent_session_id, history_revision, recovery_state,
  operation_id, updated_at_unix_ms
)
SELECT workspace_id, agent_session_id, 0, 'ready', '', updated_at_unix_ms
FROM workspace_agent_sessions;

INSERT OR IGNORE INTO workspace_agent_turn_history (
  workspace_id, agent_session_id, turn_id, history_state,
  retracted_by_operation_id, replacement_turn_id, updated_at_unix_ms
)
SELECT workspace_id, agent_session_id, turn_id, 'effective', '', '', updated_at_unix_ms
FROM workspace_agent_turns;

CREATE TRIGGER IF NOT EXISTS workspace_agent_session_history_after_insert
AFTER INSERT ON workspace_agent_sessions
BEGIN
  INSERT OR IGNORE INTO workspace_agent_session_history (
    workspace_id, agent_session_id, history_revision, recovery_state,
    operation_id, updated_at_unix_ms
  ) VALUES (
    NEW.workspace_id, NEW.agent_session_id, 0, 'ready', '', NEW.updated_at_unix_ms
  );
END;

CREATE TRIGGER IF NOT EXISTS workspace_agent_turn_history_after_insert
AFTER INSERT ON workspace_agent_turns
BEGIN
  INSERT OR IGNORE INTO workspace_agent_turn_history (
    workspace_id, agent_session_id, turn_id, history_state,
    retracted_by_operation_id, replacement_turn_id, updated_at_unix_ms
  ) VALUES (
    NEW.workspace_id, NEW.agent_session_id, NEW.turn_id, 'effective', '', '', NEW.updated_at_unix_ms
  );
END;
`); err != nil {
		return fmt.Errorf("create workspace agent effective history tables: %w", err)
	}
	if !applied {
		if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentEffectiveHistoryV1); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent effective history migration: %w", err)
	}
	return nil
}

func (s *Store) applyWorkspaceAgentEffectiveHistoryV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentEffectiveHistoryV2)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent effective history v2 migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	hasMetadata, err := hasColumnTx(ctx, tx, "workspace_agent_turn_submissions", "metadata_json")
	if err != nil {
		return err
	}
	if !hasMetadata {
		if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_turn_submissions
ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object')
`); err != nil {
			return fmt.Errorf("add workspace agent turn submission metadata: %w", err)
		}
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentEffectiveHistoryV2); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent effective history v2 migration: %w", err)
	}
	return nil
}
