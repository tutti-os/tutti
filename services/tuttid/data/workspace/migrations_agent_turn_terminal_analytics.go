package workspace

import (
	"context"
	"fmt"
	"time"
)

func (s *SQLiteStore) applyAgentTurnTerminalAnalyticsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentTurnTerminalAnalyticsV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Agent Turn terminal analytics v1 migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS agent_turn_terminal_analytics (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT '',
  turn_origin TEXT NOT NULL,
  turn_outcome TEXT NOT NULL,
  error_code TEXT NOT NULL DEFAULT '',
  startup_reconciled INTEGER NOT NULL DEFAULT 0 CHECK (startup_reconciled IN (0, 1)),
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  settled_at_unix_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'delivered', 'ignored')),
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_expires_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  ignored_reason TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  delivered_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, agent_session_id, turn_id),
  FOREIGN KEY (workspace_id, agent_session_id, turn_id)
    REFERENCES workspace_agent_turns(workspace_id, agent_session_id, turn_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_turn_terminal_analytics_delivery
  ON agent_turn_terminal_analytics(status, lease_expires_at_unix_ms, created_at_unix_ms);
`); err != nil {
		return fmt.Errorf("migrate Agent Turn terminal analytics v1: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationAgentTurnTerminalAnalyticsV1, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record Agent Turn terminal analytics v1 migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Agent Turn terminal analytics v1 migration: %w", err)
	}
	return nil
}
