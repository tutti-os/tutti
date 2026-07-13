package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentRuntimeOperationsV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentRuntimeOperationsV2)
	if err != nil || applied {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `
ALTER TABLE workspace_agent_runtime_operation_events RENAME TO workspace_agent_runtime_operation_events_v1;
ALTER TABLE workspace_agent_runtime_operations RENAME TO workspace_agent_runtime_operations_v1;
DROP INDEX IF EXISTS idx_workspace_agent_runtime_operations_claimable;
DROP INDEX IF EXISTS idx_workspace_agent_runtime_operations_session;
DROP INDEX IF EXISTS idx_workspace_agent_runtime_operation_events_workspace;

CREATE TABLE workspace_agent_runtime_operations (
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) > 0),
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('interactive_response','cancel_turn','plan_decision')),
  status TEXT NOT NULL CHECK (status IN ('prepared','leased','completed','failed')),
  result TEXT CHECK (result IS NULL OR result IN ('answered','superseded','canceled','already_settled','applied','failed')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) > 0),
  turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
  request_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  lease_owner TEXT,
  lease_expires_at_unix_ms INTEGER,
  next_attempt_at_unix_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  last_error TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  completed_at_unix_ms INTEGER,
  UNIQUE (workspace_id, agent_session_id, kind, subject_id),
  CHECK ((kind = 'interactive_response' AND request_id IS NOT NULL AND subject_id = request_id)
      OR (kind = 'cancel_turn' AND request_id IS NULL AND subject_id = turn_id)
      OR (kind = 'plan_decision' AND request_id IS NOT NULL
          AND subject_id = turn_id AND request_id = turn_id
          AND json_extract(payload_json, '$.promptKind') = 'plan-implementation'
          AND json_extract(payload_json, '$.action') = 'implement'
		  AND length(json_extract(payload_json, '$.idempotencyKey')) > 0
          AND json_extract(payload_json, '$.clientSubmitId') = 'plan-decision:' || operation_id
          AND json_extract(payload_json, '$.step') IN ('prepared','settings_applied','send_dispatched','send_confirmed')
          AND ((json_extract(payload_json, '$.step') = 'send_confirmed'
				AND length(json_extract(payload_json, '$.confirmedTurnId')) > 0
				AND json_extract(payload_json, '$.confirmedTurnId') != turn_id)
               OR (json_extract(payload_json, '$.step') != 'send_confirmed'
                   AND json_extract(payload_json, '$.confirmedTurnId') IS NULL)))),
  CHECK ((status = 'leased' AND lease_owner IS NOT NULL AND length(lease_owner) > 0 AND lease_expires_at_unix_ms > 0)
      OR (status != 'leased' AND lease_owner IS NULL AND lease_expires_at_unix_ms IS NULL)),
  CHECK ((status = 'prepared' AND next_attempt_at_unix_ms IS NOT NULL)
      OR (status != 'prepared' AND next_attempt_at_unix_ms IS NULL)),
  CHECK ((status = 'completed' AND result IS NOT NULL AND completed_at_unix_ms IS NOT NULL)
      OR (status != 'completed' AND completed_at_unix_ms IS NULL)),
  FOREIGN KEY (workspace_id, agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_session_id, turn_id)
    REFERENCES workspace_agent_turns(workspace_id, agent_session_id, turn_id) ON DELETE CASCADE
);

INSERT INTO workspace_agent_runtime_operations
SELECT * FROM workspace_agent_runtime_operations_v1;

CREATE INDEX idx_workspace_agent_runtime_operations_claimable
  ON workspace_agent_runtime_operations(status, next_attempt_at_unix_ms, lease_expires_at_unix_ms, created_at_unix_ms, operation_id);
CREATE INDEX idx_workspace_agent_runtime_operations_session
  ON workspace_agent_runtime_operations(workspace_id, agent_session_id, updated_at_unix_ms);

CREATE TABLE workspace_agent_runtime_operation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('interactive_completed','turn_canceled','plan_decision_completed')),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at_unix_ms INTEGER NOT NULL,
  published_at_unix_ms INTEGER,
  FOREIGN KEY (operation_id) REFERENCES workspace_agent_runtime_operations(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_session_id)
	REFERENCES workspace_agent_sessions(workspace_id, agent_session_id) ON DELETE CASCADE
);

INSERT INTO workspace_agent_runtime_operation_events
SELECT * FROM workspace_agent_runtime_operation_events_v1;

CREATE INDEX idx_workspace_agent_runtime_operation_events_workspace
  ON workspace_agent_runtime_operation_events(workspace_id, published_at_unix_ms, id);

DROP TABLE workspace_agent_runtime_operation_events_v1;
DROP TABLE workspace_agent_runtime_operations_v1;
`); err != nil {
		return fmt.Errorf("migrate workspace agent runtime operations v2: %w", err)
	}
	return s.recordMigration(ctx, schemaMigrationWorkspaceAgentRuntimeOperationsV2)
}
