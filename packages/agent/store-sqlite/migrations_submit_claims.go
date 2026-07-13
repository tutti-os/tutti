package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentSubmitClaimsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSubmitClaimsV1)
	if err != nil || applied {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS workspace_agent_submit_claims (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  client_submit_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared','accepted')),
  turn_id TEXT,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id, client_submit_id),
  CHECK ((status = 'prepared' AND turn_id IS NULL)
      OR (status = 'accepted' AND length(turn_id) > 0))
);`); err != nil {
		return fmt.Errorf("create workspace agent submit claims: %w", err)
	}
	return s.recordMigration(ctx, schemaMigrationWorkspaceAgentSubmitClaimsV1)
}
