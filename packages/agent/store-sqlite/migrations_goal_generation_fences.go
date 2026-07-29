package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentGoalGenerationFencesV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentGoalGenerationFencesV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS workspace_agent_goal_generation_fences (
  fence_id TEXT PRIMARY KEY CHECK(length(fence_id) > 0),
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  target_operation_id TEXT NOT NULL CHECK(length(target_operation_id) > 0),
  target_revision INTEGER NOT NULL CHECK(target_revision > 0),
  target_repair_epoch INTEGER NOT NULL CHECK(target_repair_epoch >= 0),
  client_submit_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('pending','processing','completed')),
  clear_operation_id TEXT NOT NULL DEFAULT '',
  lease_owner TEXT,
  lease_expires_at_unix_ms INTEGER,
  next_attempt_at_unix_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  completed_at_unix_ms INTEGER,
  UNIQUE(workspace_id,agent_session_id,target_operation_id),
  FOREIGN KEY(workspace_id,agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id,agent_session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_goal_generation_fences_claimable
  ON workspace_agent_goal_generation_fences(status,next_attempt_at_unix_ms,lease_expires_at_unix_ms,created_at_unix_ms,fence_id);
CREATE INDEX IF NOT EXISTS idx_goal_generation_fences_session
  ON workspace_agent_goal_generation_fences(workspace_id,agent_session_id,target_revision,target_operation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_generation_fences_client_submit
  ON workspace_agent_goal_generation_fences(workspace_id,agent_session_id,client_submit_id)
  WHERE client_submit_id <> '';
`); err != nil {
		return fmt.Errorf("create durable goal generation fences: %w", err)
	}
	if err = recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentGoalGenerationFencesV1); err != nil {
		return err
	}
	return tx.Commit()
}
