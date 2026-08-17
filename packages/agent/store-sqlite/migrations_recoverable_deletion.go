package storesqlite

import (
	"context"
	"fmt"
)

// applyWorkspaceAgentRecoverableDeletionV1 marks only tombstones written by
// the lossless deletion path as restorable. Existing tombstones intentionally
// retain version zero because older deletion code removed their Turn graph.
func (s *Store) applyWorkspaceAgentRecoverableDeletionV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentRecoverableDeletionV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent recoverable deletion migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, column := range []struct {
		name string
		ddl  string
	}{
		{
			name: "recoverable_delete_version",
			ddl: `
ALTER TABLE workspace_agent_sessions
ADD COLUMN recoverable_delete_version INTEGER NOT NULL DEFAULT 0
	CHECK (recoverable_delete_version IN (0, 1))`,
		},
		{
			name: "recoverable_delete_tree_size",
			ddl: `
ALTER TABLE workspace_agent_sessions
ADD COLUMN recoverable_delete_tree_size INTEGER NOT NULL DEFAULT 0
	CHECK (recoverable_delete_tree_size >= 0)`,
		},
	} {
		hasColumn, err := hasColumnTx(ctx, tx, "workspace_agent_sessions", column.name)
		if err != nil {
			return err
		}
		if !hasColumn {
			if _, err := tx.ExecContext(ctx, column.ddl); err != nil {
				return fmt.Errorf("add workspace agent %s: %w", column.name, err)
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `
CREATE INDEX IF NOT EXISTS idx_workspace_agent_sessions_deleted_page
  ON workspace_agent_sessions(
    workspace_id, session_kind, updated_at_unix_ms DESC, agent_session_id ASC
  )
  WHERE deleted_at_unix_ms > 0;
CREATE INDEX IF NOT EXISTS idx_workspace_agent_sessions_recoverable_resources
  ON workspace_agent_sessions(workspace_id, recoverable_delete_version, agent_session_id)
  WHERE deleted_at_unix_ms > 0 AND recoverable_delete_version = 1;
`); err != nil {
		return fmt.Errorf("index workspace agent recoverable deletion: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentRecoverableDeletionV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent recoverable deletion migration: %w", err)
	}
	return nil
}
