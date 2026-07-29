package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
	"maps"
)

func (s *Store) applyWorkspaceAgentRuntimeOperationsV4(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentRuntimeOperationsV4)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent runtime operations v4: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if err := preflightRuntimeOperationIdentitiesV4(ctx, tx); err != nil {
		return err
	}
	before, err := runtimeOperationMigrationCounts(ctx, tx, "workspace_agent_runtime_operations", "workspace_agent_runtime_operation_events")
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_runtime_operation_events RENAME TO workspace_agent_runtime_operation_events_v3;
ALTER TABLE workspace_agent_runtime_operations RENAME TO workspace_agent_runtime_operations_v3;
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
  CHECK ((kind = 'interactive_response' AND request_id IS NOT NULL)
      OR (kind = 'cancel_turn' AND request_id IS NULL)
      OR (kind = 'plan_decision' AND request_id IS NOT NULL
          AND request_id = turn_id
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

INSERT INTO workspace_agent_runtime_operations (
  operation_id, workspace_id, agent_session_id, kind, status, result, turn_id,
  request_id, payload_json, lease_owner, lease_expires_at_unix_ms,
  next_attempt_at_unix_ms, attempt, version, last_error, created_at_unix_ms,
  updated_at_unix_ms, completed_at_unix_ms
)
SELECT
  operation_id, workspace_id, agent_session_id, kind, status, result, turn_id,
  request_id, payload_json, lease_owner, lease_expires_at_unix_ms,
  next_attempt_at_unix_ms, attempt, version, last_error, created_at_unix_ms,
  updated_at_unix_ms, completed_at_unix_ms
FROM workspace_agent_runtime_operations_v3;

CREATE UNIQUE INDEX idx_workspace_agent_runtime_operations_interactive_identity
  ON workspace_agent_runtime_operations(workspace_id, agent_session_id, turn_id, request_id)
  WHERE kind = 'interactive_response';
CREATE UNIQUE INDEX idx_workspace_agent_runtime_operations_cancel_identity
  ON workspace_agent_runtime_operations(workspace_id, agent_session_id, turn_id)
  WHERE kind = 'cancel_turn';
CREATE UNIQUE INDEX idx_workspace_agent_runtime_operations_plan_identity
  ON workspace_agent_runtime_operations(workspace_id, agent_session_id, turn_id)
  WHERE kind = 'plan_decision';
CREATE INDEX idx_workspace_agent_runtime_operations_claimable
  ON workspace_agent_runtime_operations(status, next_attempt_at_unix_ms, lease_expires_at_unix_ms, created_at_unix_ms, operation_id);
CREATE INDEX idx_workspace_agent_runtime_operations_session
  ON workspace_agent_runtime_operations(workspace_id, agent_session_id, updated_at_unix_ms);

CREATE TABLE workspace_agent_runtime_operation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('interactive_completed','turn_canceled','plan_decision_pending_confirmation','plan_decision_completed')),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at_unix_ms INTEGER NOT NULL,
  published_at_unix_ms INTEGER,
  FOREIGN KEY (operation_id) REFERENCES workspace_agent_runtime_operations(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id) ON DELETE CASCADE,
  UNIQUE (operation_id, kind)
);

INSERT INTO workspace_agent_runtime_operation_events (
  id, operation_id, workspace_id, agent_session_id, kind, payload_json,
  created_at_unix_ms, published_at_unix_ms
)
SELECT
  id, operation_id, workspace_id, agent_session_id, kind, payload_json,
  created_at_unix_ms, published_at_unix_ms
FROM workspace_agent_runtime_operation_events_v3;

CREATE INDEX idx_workspace_agent_runtime_operation_events_workspace
  ON workspace_agent_runtime_operation_events(workspace_id, published_at_unix_ms, id);
`); err != nil {
		return fmt.Errorf("migrate workspace agent runtime operations v4: %w", err)
	}

	after, err := runtimeOperationMigrationCounts(ctx, tx, "workspace_agent_runtime_operations", "workspace_agent_runtime_operation_events")
	if err != nil {
		return err
	}
	if !maps.Equal(before, after) {
		return fmt.Errorf("migrate workspace agent runtime operations v4: copied row distribution changed: before=%v after=%v", before, after)
	}
	if err := requireRuntimeOperationRowsPreservedV4(ctx, tx); err != nil {
		return err
	}
	if err := requireNoForeignKeyViolations(ctx, tx, "workspace_agent_runtime_operations"); err != nil {
		return err
	}
	if err := requireNoForeignKeyViolations(ctx, tx, "workspace_agent_runtime_operation_events"); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
DROP TABLE workspace_agent_runtime_operation_events_v3;
DROP TABLE workspace_agent_runtime_operations_v3;
`); err != nil {
		return fmt.Errorf("drop workspace agent runtime operations v3 tables: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentRuntimeOperationsV4); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent runtime operations v4: %w", err)
	}
	return nil
}

func requireRuntimeOperationRowsPreservedV4(ctx context.Context, tx *sql.Tx) error {
	operationColumns := `operation_id, workspace_id, agent_session_id, kind, status, result, turn_id,
request_id, payload_json, lease_owner, lease_expires_at_unix_ms, next_attempt_at_unix_ms,
attempt, version, last_error, created_at_unix_ms, updated_at_unix_ms, completed_at_unix_ms`
	eventColumns := `id, operation_id, workspace_id, agent_session_id, kind, payload_json,
created_at_unix_ms, published_at_unix_ms`
	for _, comparison := range []struct {
		label      string
		oldTable   string
		newTable   string
		columnList string
	}{
		{
			label: "operations", oldTable: "workspace_agent_runtime_operations_v3",
			newTable: "workspace_agent_runtime_operations", columnList: operationColumns,
		},
		{
			label: "events", oldTable: "workspace_agent_runtime_operation_events_v3",
			newTable: "workspace_agent_runtime_operation_events", columnList: eventColumns,
		},
	} {
		for _, direction := range [][2]string{{comparison.oldTable, comparison.newTable}, {comparison.newTable, comparison.oldTable}} {
			query := `SELECT COUNT(*) FROM (SELECT ` + comparison.columnList + ` FROM ` + direction[0] +
				` EXCEPT SELECT ` + comparison.columnList + ` FROM ` + direction[1] + `)`
			var differences int64
			if err := tx.QueryRowContext(ctx, query).Scan(&differences); err != nil {
				return fmt.Errorf("verify workspace agent runtime operation v4 %s: %w", comparison.label, err)
			}
			if differences != 0 {
				return fmt.Errorf("verify workspace agent runtime operation v4 %s: found %d changed rows", comparison.label, differences)
			}
		}
	}
	return nil
}

func preflightRuntimeOperationIdentitiesV4(ctx context.Context, tx *sql.Tx) error {
	var conflicts int
	err := tx.QueryRowContext(ctx, `
SELECT COUNT(*) FROM (
  SELECT 1
  FROM workspace_agent_runtime_operations
  WHERE kind = 'interactive_response'
  GROUP BY workspace_id, agent_session_id, turn_id, request_id
  HAVING COUNT(*) > 1
  UNION ALL
  SELECT 1
  FROM workspace_agent_runtime_operations
  WHERE kind = 'cancel_turn'
  GROUP BY workspace_id, agent_session_id, turn_id
  HAVING COUNT(*) > 1
  UNION ALL
  SELECT 1
  FROM workspace_agent_runtime_operations
  WHERE kind = 'plan_decision'
  GROUP BY workspace_id, agent_session_id, turn_id
  HAVING COUNT(*) > 1
)
`).Scan(&conflicts)
	if err != nil {
		return fmt.Errorf("preflight workspace agent runtime operation identities v4: %w", err)
	}
	if conflicts != 0 {
		return fmt.Errorf("preflight workspace agent runtime operation identities v4: found %d conflicting durable identities", conflicts)
	}
	return nil
}

func runtimeOperationMigrationCounts(ctx context.Context, tx *sql.Tx, operationsTable, eventsTable string) (map[string]int64, error) {
	counts := make(map[string]int64)
	for _, query := range []struct {
		prefix string
		sql    string
	}{
		{prefix: "operation", sql: `SELECT kind, status, COUNT(*) FROM ` + operationsTable + ` GROUP BY kind, status`},
		{prefix: "event", sql: `SELECT kind, '', COUNT(*) FROM ` + eventsTable + ` GROUP BY kind`},
	} {
		rows, err := tx.QueryContext(ctx, query.sql)
		if err != nil {
			return nil, fmt.Errorf("count workspace agent runtime operation migration rows: %w", err)
		}
		for rows.Next() {
			var kind, status string
			var count int64
			if err := rows.Scan(&kind, &status, &count); err != nil {
				rows.Close()
				return nil, fmt.Errorf("scan workspace agent runtime operation migration counts: %w", err)
			}
			counts[query.prefix+"\x00"+kind+"\x00"+status] = count
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, fmt.Errorf("iterate workspace agent runtime operation migration counts: %w", err)
		}
		rows.Close()
	}
	return counts, nil
}

func requireNoForeignKeyViolations(ctx context.Context, tx *sql.Tx, table string) error {
	rows, err := tx.QueryContext(ctx, `PRAGMA foreign_key_check(`+table+`)`)
	if err != nil {
		return fmt.Errorf("check %s foreign keys: %w", table, err)
	}
	defer rows.Close()
	if rows.Next() {
		return fmt.Errorf("check %s foreign keys: migration produced a foreign key violation", table)
	}
	return rows.Err()
}
