package storesqlite

import (
	"context"
	"fmt"
)

// V8 adds durable per-event retry state without rebuilding existing outbox
// rows. Legacy pending rows remain immediately eligible (NULL retry time).
func (s *Store) applyWorkspaceAgentRuntimeOperationsV8(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentRuntimeOperationsV8)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin runtime operations v8 migration: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	for _, statement := range []string{
		`ALTER TABLE workspace_agent_runtime_operation_events ADD COLUMN publish_attempt INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE workspace_agent_runtime_operation_events ADD COLUMN next_attempt_at_unix_ms INTEGER`,
		`ALTER TABLE workspace_agent_runtime_operation_events ADD COLUMN last_error_code TEXT NOT NULL DEFAULT ''`,
		`CREATE INDEX IF NOT EXISTS idx_workspace_agent_runtime_operation_events_pending_retry ON workspace_agent_runtime_operation_events(published_at_unix_ms, next_attempt_at_unix_ms, id)`,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate runtime operations v8: %w", err)
		}
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentRuntimeOperationsV8); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit runtime operations v8 migration: %w", err)
	}
	committed = true
	return nil
}
