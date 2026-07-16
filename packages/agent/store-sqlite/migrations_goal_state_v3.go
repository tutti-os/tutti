package storesqlite

import (
	"context"
	"fmt"
)

// V3 permits a deterministic repair operation to share the current desired
// revision after that revision's original operation already completed.
func (s *Store) applyWorkspaceAgentGoalStateV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentGoalStateV3)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, column := range []struct {
		name string
		ddl  string
	}{
		{name: "repair_required", ddl: `ALTER TABLE workspace_agent_goal_control_operations ADD COLUMN repair_required INTEGER NOT NULL DEFAULT 0`},
		{name: "repair_epoch", ddl: `ALTER TABLE workspace_agent_goal_control_operations ADD COLUMN repair_epoch INTEGER NOT NULL DEFAULT 0`},
	} {
		exists, columnErr := hasColumnTx(ctx, tx, "workspace_agent_goal_control_operations", column.name)
		if columnErr != nil {
			return columnErr
		}
		if !exists {
			if _, columnErr = tx.ExecContext(ctx, column.ddl); columnErr != nil {
				return fmt.Errorf("add goal repair column %s: %w", column.name, columnErr)
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `
CREATE TABLE workspace_agent_goal_control_operations_v3 (
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) > 0),
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
  action TEXT NOT NULL CHECK (action IN ('pause','resume','clear','set','reconcile')),
  objective TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('prepared','dispatched','completed','failed','superseded')),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  last_error TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  completed_at_unix_ms INTEGER,
  provider_phase TEXT NOT NULL DEFAULT 'prepared',
  lease_owner TEXT,
  lease_expires_at_unix_ms INTEGER,
  next_attempt_at_unix_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  repair_required INTEGER NOT NULL DEFAULT 0 CHECK (repair_required IN (0,1)),
  repair_epoch INTEGER NOT NULL DEFAULT 0,
  accepted_at_unix_ms INTEGER,
  accepted_attempt INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (workspace_id, agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id) ON DELETE CASCADE
);
INSERT INTO workspace_agent_goal_control_operations_v3
SELECT operation_id, workspace_id, agent_session_id, goal_revision, action, objective,
       status, evidence_json, last_error, created_at_unix_ms, updated_at_unix_ms,
       completed_at_unix_ms, provider_phase, lease_owner, lease_expires_at_unix_ms,
       next_attempt_at_unix_ms, attempt, repair_required, repair_epoch,
       NULL, 0
FROM workspace_agent_goal_control_operations;
DROP TABLE workspace_agent_goal_control_operations;
ALTER TABLE workspace_agent_goal_control_operations_v3 RENAME TO workspace_agent_goal_control_operations;
CREATE INDEX idx_workspace_agent_goal_operations_claimable
  ON workspace_agent_goal_control_operations(status, next_attempt_at_unix_ms, lease_expires_at_unix_ms, created_at_unix_ms, operation_id);
CREATE INDEX idx_workspace_agent_goal_operations_session
  ON workspace_agent_goal_control_operations(workspace_id, agent_session_id, goal_revision DESC);
`); err != nil {
		return fmt.Errorf("migrate workspace agent goal state v3: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentGoalStateV3); err != nil {
		return err
	}
	return tx.Commit()
}
