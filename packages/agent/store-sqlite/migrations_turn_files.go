package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentGeneratedFilesRecentTurnsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentGeneratedFilesRecentTurnsV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent generated files recent turns migration: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	if _, err := tx.ExecContext(ctx, `
DROP TABLE IF EXISTS workspace_agent_turn_files;

CREATE INDEX IF NOT EXISTS idx_workspace_agent_turns_workspace_settled_recent
  ON workspace_agent_turns(
    workspace_id,
    settled_at_unix_ms DESC,
    agent_session_id DESC,
    turn_id DESC
  )
  WHERE phase = 'settled';
`); err != nil {
		return fmt.Errorf("apply workspace agent generated files recent turns schema: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentGeneratedFilesRecentTurnsV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent generated files recent turns migration: %w", err)
	}
	committed = true
	return nil
}
