package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentGoalProvenanceLedgerV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentGoalProvenanceLedgerV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS workspace_agent_goal_provenance_ledger (
 workspace_id TEXT NOT NULL,
 agent_session_id TEXT NOT NULL,
 session_created_at_unix_ms INTEGER NOT NULL,
 provider_session_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 operation_id TEXT NOT NULL DEFAULT '',
 goal_revision INTEGER NOT NULL DEFAULT 0,
 repair_epoch INTEGER NOT NULL DEFAULT 0,
 ambiguous INTEGER NOT NULL DEFAULT 0 CHECK(ambiguous IN (0,1)),
 created_at_unix_ms INTEGER NOT NULL,
 updated_at_unix_ms INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,agent_session_id,session_created_at_unix_ms,provider_session_id,fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_goal_provenance_ledger_session
 ON workspace_agent_goal_provenance_ledger(workspace_id,agent_session_id);
`); err != nil {
		return fmt.Errorf("create durable goal provenance ledger: %w", err)
	}
	if err = recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentGoalProvenanceLedgerV1); err != nil {
		return err
	}
	return tx.Commit()
}
