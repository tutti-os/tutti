package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentGoalStateV6(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentGoalStateV6)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS workspace_agent_goal_repair_incidents (
 workspace_id TEXT NOT NULL, agent_session_id TEXT NOT NULL, goal_revision INTEGER NOT NULL,
 generation_count INTEGER NOT NULL DEFAULT 0, terminal INTEGER NOT NULL DEFAULT 0,
 last_source_id TEXT NOT NULL DEFAULT '', updated_at_unix_ms INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,agent_session_id,goal_revision)
);
CREATE TABLE IF NOT EXISTS workspace_agent_goal_reconcile_inbox (
 request_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_session_id TEXT NOT NULL,
 payload_json TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
 lease_owner TEXT, lease_expires_at_unix_ms INTEGER, next_attempt_at_unix_ms INTEGER,
 last_error TEXT NOT NULL DEFAULT '', created_at_unix_ms INTEGER NOT NULL,
 updated_at_unix_ms INTEGER NOT NULL, completed_at_unix_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_goal_reconcile_inbox_claim
 ON workspace_agent_goal_reconcile_inbox(status,next_attempt_at_unix_ms,lease_expires_at_unix_ms);
CREATE INDEX IF NOT EXISTS idx_goal_reconcile_inbox_session
 ON workspace_agent_goal_reconcile_inbox(workspace_id,agent_session_id);
`); err != nil {
		return fmt.Errorf("create durable goal repair/inbox state: %w", err)
	}
	if err = recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentGoalStateV6); err != nil {
		return err
	}
	return tx.Commit()
}
