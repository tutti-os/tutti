package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentTurnReplyResourcesV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentTurnReplyResourcesV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent turn reply resources migration: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	if _, err := tx.ExecContext(ctx, `
CREATE TABLE workspace_agent_turn_reply_resources (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local_file', 'external_artifact')),
  source_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id, turn_id, resource_id),
  UNIQUE (workspace_id, agent_session_id, turn_id, dedupe_key),
  FOREIGN KEY (workspace_id, agent_session_id, turn_id)
    REFERENCES workspace_agent_turns(workspace_id, agent_session_id, turn_id)
    ON DELETE CASCADE
);
CREATE INDEX idx_workspace_agent_turn_reply_resources_turn
  ON workspace_agent_turn_reply_resources(workspace_id, agent_session_id, turn_id, created_at_unix_ms, resource_id);
`); err != nil {
		return fmt.Errorf("apply workspace agent turn reply resources schema: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentTurnReplyResourcesV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent turn reply resources migration: %w", err)
	}
	committed = true
	return nil
}
