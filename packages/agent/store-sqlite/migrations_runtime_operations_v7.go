package storesqlite

import (
	"context"
	"fmt"
)

// V7 closes the recovery-action ledger's workspace boundary. V6 keyed an
// action by workspace and operation but its FK checked operation_id alone;
// this additive rebuild makes a cross-workspace reference impossible even
// when SQLite foreign-key enforcement is enabled by a caller.
func (s *Store) applyWorkspaceAgentRuntimeOperationsV7(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentRuntimeOperationsV7)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent runtime operations v7: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_agent_runtime_operations_workspace_operation
  ON workspace_agent_runtime_operations(workspace_id, operation_id);
ALTER TABLE workspace_agent_runtime_operation_recovery_actions
  RENAME TO workspace_agent_runtime_operation_recovery_actions_v6;
CREATE TABLE workspace_agent_runtime_operation_recovery_actions (
  operation_id TEXT NOT NULL,
  client_action_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  action_identity TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, operation_id, client_action_id),
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES workspace_agent_runtime_operations(workspace_id, operation_id) ON DELETE CASCADE
);
INSERT INTO workspace_agent_runtime_operation_recovery_actions (
  operation_id, client_action_id, workspace_id, action_kind, action_identity, created_at_unix_ms
)
SELECT operation_id, client_action_id, workspace_id, action_kind, action_identity, created_at_unix_ms
FROM workspace_agent_runtime_operation_recovery_actions_v6;
DROP TABLE workspace_agent_runtime_operation_recovery_actions_v6;
CREATE INDEX idx_workspace_agent_runtime_operation_recovery_actions_workspace
  ON workspace_agent_runtime_operation_recovery_actions(workspace_id, operation_id, created_at_unix_ms);
`); err != nil {
		return fmt.Errorf("migrate workspace agent runtime operations v7: %w", err)
	}
	if err := requireNoForeignKeyViolations(ctx, tx, "workspace_agent_runtime_operation_recovery_actions"); err != nil {
		return err
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentRuntimeOperationsV7); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent runtime operations v7: %w", err)
	}
	return nil
}
