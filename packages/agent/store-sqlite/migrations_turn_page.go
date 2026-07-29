package storesqlite

import (
	"context"
	"fmt"
)

// applyWorkspaceAgentSessionTurnPageIndexV1 gives descending session-Turn
// discovery the same stable ordering as its cursor. Without this index,
// LIMIT still requires SQLite to scan and sort the complete session history.
func (s *Store) applyWorkspaceAgentSessionTurnPageIndexV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSessionTurnPageIndexV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent session turn page index v1: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
CREATE INDEX IF NOT EXISTS idx_workspace_agent_turns_session_started_desc
  ON workspace_agent_turns(
    workspace_id,
    agent_session_id,
    started_at_unix_ms DESC,
    turn_id DESC
  );
`); err != nil {
		return fmt.Errorf("create workspace agent session turn page index: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentSessionTurnPageIndexV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent session turn page index v1: %w", err)
	}
	return nil
}
