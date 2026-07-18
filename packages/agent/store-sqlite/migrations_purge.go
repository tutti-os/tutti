package storesqlite

import "context"

func (s *Store) applyWorkspaceAgentDeletedPurgeIndexV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentDeletedPurgeIndexV1)
	if err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `
CREATE INDEX IF NOT EXISTS idx_workspace_agent_sessions_deleted_purge
  ON workspace_agent_sessions(deleted_at_unix_ms, workspace_id, agent_session_id)
  WHERE deleted_at_unix_ms > 0;
CREATE INDEX IF NOT EXISTS idx_workspace_agent_runtime_operation_events_session
  ON workspace_agent_runtime_operation_events(workspace_id, agent_session_id);
`); err != nil {
		return err
	}
	if applied {
		return nil
	}
	return s.recordMigration(ctx, schemaMigrationWorkspaceAgentDeletedPurgeIndexV1)
}
