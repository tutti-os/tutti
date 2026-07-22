package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
)

// applyWorkspaceAgentActivityTurnsV1 creates the protocol v2 turn and
// interaction entities and backfills historical turn records from message
// turn ids.
//
// Backfill semantics (agent-gui refactor plan, rule nine adjacent):
//   - every distinct non-empty message turn_id becomes a settled turn;
//   - outcome defaults to completed; the newest turn of a failed/canceled
//     session inherits that session outcome (older turns of the same
//     session had to complete for a newer one to exist);
//   - reruns are harmless: inserts use INSERT OR IGNORE and the outcome
//     repair only touches rows the insert created (settled + backfill
//     marker), so live rows written after the migration are never touched.
func (s *Store) applyWorkspaceAgentActivityTurnsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityTurnsV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent activity turns v1: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	if _, err := tx.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS workspace_agent_turns (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
  phase TEXT NOT NULL CHECK (phase IN ('submitted','running','waiting','settling','settled')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed','failed','canceled','interrupted')),
  error_json TEXT,
  file_changes_json TEXT,
  completed_command_json TEXT,
  backfilled INTEGER NOT NULL DEFAULT 0,
  turn_origin TEXT NOT NULL DEFAULT 'legacy_unknown'
    CHECK (turn_origin IN ('user_prompt','goal_arm','goal_continuation','provider_initiated','legacy_unknown')),
  source_goal_operation_id TEXT,
  source_goal_revision INTEGER CHECK (source_goal_revision IS NULL OR source_goal_revision >= 0),
  source_goal_repair_epoch INTEGER CHECK (source_goal_repair_epoch IS NULL OR source_goal_repair_epoch >= 0),
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  settled_at_unix_ms INTEGER,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  root_provider_turn_id TEXT,
  root_provider_turn_phase TEXT CHECK (root_provider_turn_phase IS NULL OR root_provider_turn_phase IN ('running','completed')),
  root_provider_turn_outcome TEXT CHECK (root_provider_turn_outcome IS NULL OR root_provider_turn_outcome IN ('completed','failed','canceled','interrupted')),
  root_provider_turn_error_json TEXT,
  root_provider_turn_completed_command_json TEXT,
  root_provider_turn_updated_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  parent_turn_id TEXT,
  relation TEXT CHECK (relation IS NULL OR relation IN ('retry', 'edit')),
  PRIMARY KEY (workspace_id, agent_session_id, turn_id),
  FOREIGN KEY (workspace_id, agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_agent_turns_session_phase
  ON workspace_agent_turns(workspace_id, agent_session_id, phase);

CREATE TABLE IF NOT EXISTS workspace_agent_interactions (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) > 0),
  turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('approval','question','plan')),
  status TEXT NOT NULL CHECK (status IN ('pending','answered','superseded')),
  tool_name TEXT NOT NULL DEFAULT '',
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id, turn_id, request_id),
  FOREIGN KEY (workspace_id, agent_session_id, turn_id)
    REFERENCES workspace_agent_turns(workspace_id, agent_session_id, turn_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_agent_interactions_session_status
  ON workspace_agent_interactions(workspace_id, agent_session_id, status);
`); err != nil {
		return fmt.Errorf("migrate workspace agent activity turns v1: %w", err)
	}

	hasActiveTurnID, err := hasColumnTx(ctx, tx, "workspace_agent_sessions", "active_turn_id")
	if err != nil {
		return err
	}
	if !hasActiveTurnID {
		if _, err := tx.ExecContext(ctx, `ALTER TABLE workspace_agent_sessions ADD COLUMN active_turn_id TEXT;`); err != nil {
			return fmt.Errorf("migrate workspace agent sessions active turn id: %w", err)
		}
	}

	if err := backfillWorkspaceAgentTurnsTx(ctx, tx); err != nil {
		return err
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentActivityTurnsV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent activity turns v1: %w", err)
	}
	committed = true
	return nil
}

func (s *Store) applyWorkspaceAgentActivityInteractionsV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityInteractionsV2)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent interactions v2: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
CREATE TABLE workspace_agent_interactions_v2 (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) > 0),
  turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('approval','question','plan')),
  status TEXT NOT NULL CHECK (status IN ('pending','answered','superseded')),
  tool_name TEXT NOT NULL DEFAULT '',
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id, turn_id, request_id),
  FOREIGN KEY (workspace_id, agent_session_id, turn_id)
    REFERENCES workspace_agent_turns(workspace_id, agent_session_id, turn_id)
    ON DELETE CASCADE
);
INSERT INTO workspace_agent_interactions_v2 (
  workspace_id, agent_session_id, request_id, turn_id, kind, status, tool_name,
  input_json, output_json, metadata_json, created_at_unix_ms, updated_at_unix_ms
)
SELECT workspace_id, agent_session_id, request_id, turn_id, kind, status, tool_name,
       input_json, output_json, metadata_json, created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_interactions;
DROP TABLE workspace_agent_interactions;
ALTER TABLE workspace_agent_interactions_v2 RENAME TO workspace_agent_interactions;
CREATE INDEX idx_workspace_agent_interactions_session_status
  ON workspace_agent_interactions(workspace_id, agent_session_id, status);
`); err != nil {
		return fmt.Errorf("migrate workspace agent interactions v2: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentActivityInteractionsV2); err != nil {
		return err
	}
	return tx.Commit()
}

func backfillWorkspaceAgentTurnsTx(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase, outcome, backfilled,
  started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
)
SELECT
  message_times.workspace_id,
  message_times.agent_session_id,
  message_times.turn_id,
  'settled',
  'completed',
  1,
  COALESCE(
    MIN(CASE WHEN message_times.role = 'user' THEN message_times.started_at_unix_ms END),
    MIN(message_times.started_at_unix_ms)
  ),
  MAX(message_times.settled_at_unix_ms),
  COALESCE(
    MIN(CASE WHEN message_times.role = 'user' THEN message_times.started_at_unix_ms END),
    MIN(message_times.started_at_unix_ms)
  ),
  MAX(message_times.settled_at_unix_ms)
FROM (
  SELECT
    m.workspace_id,
    m.agent_session_id,
    TRIM(m.turn_id) AS turn_id,
    m.role,
    CASE
      WHEN m.started_at_unix_ms > 0 THEN m.started_at_unix_ms
      WHEN m.occurred_at_unix_ms > 0 THEN m.occurred_at_unix_ms
      ELSE m.created_at_unix_ms
    END AS started_at_unix_ms,
    CASE
      WHEN m.completed_at_unix_ms > 0 THEN m.completed_at_unix_ms
      WHEN m.occurred_at_unix_ms > 0 THEN m.occurred_at_unix_ms
      WHEN m.updated_at_unix_ms > 0 THEN m.updated_at_unix_ms
      ELSE m.created_at_unix_ms
    END AS settled_at_unix_ms
  FROM workspace_agent_messages m
  INNER JOIN workspace_agent_sessions s
    ON s.workspace_id = m.workspace_id
   AND s.agent_session_id = m.agent_session_id
  WHERE TRIM(m.turn_id) != ''
    AND m.deleted_at_unix_ms = 0
    AND s.deleted_at_unix_ms = 0
) AS message_times
GROUP BY message_times.workspace_id, message_times.agent_session_id, message_times.turn_id
`); err != nil {
		return fmt.Errorf("backfill workspace agent turns: %w", err)
	}

	// Claimed legacy databases may still carry a pre-activity sessions table
	// without a status column; those sessions have no terminal status to
	// inherit, so the outcome repair is skipped.
	hasStatus, err := hasColumnTx(ctx, tx, "workspace_agent_sessions", "status")
	if err != nil {
		return err
	}
	if !hasStatus {
		return nil
	}

	// The newest backfilled turn of a failed/canceled session inherits the
	// session outcome; ties on settled_at fall back to lexically greatest
	// turn id for determinism.
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET outcome = (
  SELECT CASE s.status WHEN 'failed' THEN 'failed' ELSE 'canceled' END
  FROM workspace_agent_sessions s
  WHERE s.workspace_id = workspace_agent_turns.workspace_id
    AND s.agent_session_id = workspace_agent_turns.agent_session_id
)
WHERE backfilled = 1
  AND EXISTS (
    SELECT 1
    FROM workspace_agent_sessions s
    WHERE s.workspace_id = workspace_agent_turns.workspace_id
      AND s.agent_session_id = workspace_agent_turns.agent_session_id
      AND s.status IN ('failed', 'canceled')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM workspace_agent_turns newer
    WHERE newer.workspace_id = workspace_agent_turns.workspace_id
      AND newer.agent_session_id = workspace_agent_turns.agent_session_id
      AND newer.backfilled = 1
      AND (
        newer.settled_at_unix_ms > workspace_agent_turns.settled_at_unix_ms
        OR (
          newer.settled_at_unix_ms = workspace_agent_turns.settled_at_unix_ms
          AND newer.turn_id > workspace_agent_turns.turn_id
        )
      )
  )
`); err != nil {
		return fmt.Errorf("repair backfilled workspace agent turn outcomes: %w", err)
	}
	return nil
}

func hasColumnTx(ctx context.Context, tx *sql.Tx, tableName string, columnName string) (bool, error) {
	rows, err := tx.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, tableName)
	if err != nil {
		return false, fmt.Errorf("inspect table %s columns: %w", tableName, err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return false, fmt.Errorf("scan table %s column: %w", tableName, err)
		}
		if name == columnName {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("inspect table %s columns: %w", tableName, err)
	}
	return false, nil
}

// applyWorkspaceAgentActivityMessagesV2 rebuilds workspace_agent_messages so
// message ownership is an explicit choice (protocol v2 rule eight): turn_id
// is either a non-empty turn reference or NULL for session-level messages.
// Historical empty strings are normalized to NULL — "attribution unknown" is
// honestly expressed as session-level instead of faked.
func (s *Store) applyWorkspaceAgentActivityMessagesV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityMessagesV2)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	if err := s.ensureWorkspaceAgentMessageSemanticsColumn(ctx); err != nil {
		return err
	}

	return s.rebuildWorkspaceAgentMessagesV2(ctx)
}

// rebuildWorkspaceAgentMessagesV2 performs the table rebuild on a dedicated
// connection and releases it before returning, so the migration ledger write
// that follows can obtain a pool connection even with a single-connection
// pool.
func (s *Store) rebuildWorkspaceAgentMessagesV2(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("open connection for workspace agent messages v2: %w", err)
	}
	defer conn.Close()

	// The rebuild follows the documented SQLite table-rebuild procedure:
	// disable FK enforcement on this connection, rebuild inside one
	// transaction, re-enable enforcement.
	if _, err := conn.ExecContext(ctx, `PRAGMA foreign_keys = OFF;`); err != nil {
		return fmt.Errorf("disable foreign keys for workspace agent messages v2: %w", err)
	}
	defer func() {
		_, _ = conn.ExecContext(ctx, `PRAGMA foreign_keys = ON;`)
	}()

	return runInConnTx(ctx, conn, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
CREATE TABLE workspace_agent_messages_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  message_id TEXT NOT NULL CHECK (length(message_id) > 0),
  version INTEGER NOT NULL CHECK (version > 0),
  turn_id TEXT CHECK (turn_id IS NULL OR length(turn_id) > 0),
  role TEXT NOT NULL CHECK (length(role) > 0),
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  status TEXT NOT NULL DEFAULT '',
	semantics_json TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(semantics_json)),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  occurred_at_unix_ms INTEGER NOT NULL DEFAULT 0 CHECK (occurred_at_unix_ms >= 0),
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0 CHECK (started_at_unix_ms >= 0),
  completed_at_unix_ms INTEGER NOT NULL DEFAULT 0 CHECK (completed_at_unix_ms >= 0),
  deleted_at_unix_ms INTEGER NOT NULL DEFAULT 0 CHECK (deleted_at_unix_ms >= 0),
  created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
  updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= 0),
  UNIQUE (workspace_id, agent_session_id, message_id),
  FOREIGN KEY (workspace_id, agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_session_id, turn_id)
    REFERENCES workspace_agent_turns(workspace_id, agent_session_id, turn_id)
);
`); err != nil {
			return fmt.Errorf("create workspace agent messages v2 table: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_messages_v2 (
  id, workspace_id, agent_session_id, message_id, version, turn_id, role, kind, status,
  semantics_json, payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
  deleted_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
)
SELECT
  id, workspace_id, agent_session_id, message_id, version,
  CASE
    WHEN NULLIF(TRIM(turn_id), '') IS NULL THEN NULL
    WHEN EXISTS (
      SELECT 1
      FROM workspace_agent_turns turn_parent
      WHERE turn_parent.workspace_id = workspace_agent_messages.workspace_id
        AND turn_parent.agent_session_id = workspace_agent_messages.agent_session_id
        AND turn_parent.turn_id = TRIM(workspace_agent_messages.turn_id)
    ) THEN TRIM(turn_id)
    ELSE NULL
  END,
  role, kind, status,
  semantics_json, payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
  deleted_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_messages
`); err != nil {
			return fmt.Errorf("copy workspace agent messages into v2 table: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DROP TABLE workspace_agent_messages;`); err != nil {
			return fmt.Errorf("drop legacy workspace agent messages table: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `ALTER TABLE workspace_agent_messages_v2 RENAME TO workspace_agent_messages;`); err != nil {
			return fmt.Errorf("rename workspace agent messages v2 table: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
CREATE INDEX IF NOT EXISTS idx_workspace_agent_messages_session_version
  ON workspace_agent_messages(workspace_id, agent_session_id, deleted_at_unix_ms, version);

CREATE INDEX IF NOT EXISTS idx_workspace_agent_messages_session_display
  ON workspace_agent_messages(workspace_id, agent_session_id, deleted_at_unix_ms, id);
`); err != nil {
			return fmt.Errorf("recreate workspace agent message indexes: %w", err)
		}
		return recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentActivityMessagesV2)
	})
}

// applyWorkspaceAgentActivityTurnIntegrityV1 repairs child references written
// by the original messages-v2 rebuild and adds the index used by conversation
// rail latest-turn ordering.
func (s *Store) applyWorkspaceAgentActivityTurnIntegrityV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityTurnIntegrityV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent activity turn integrity v1: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_messages
SET turn_id = NULL
WHERE turn_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM workspace_agent_turns turn_parent
    WHERE turn_parent.workspace_id = workspace_agent_messages.workspace_id
      AND turn_parent.agent_session_id = workspace_agent_messages.agent_session_id
      AND turn_parent.turn_id = workspace_agent_messages.turn_id
  );

CREATE INDEX IF NOT EXISTS idx_workspace_agent_turns_session_latest
  ON workspace_agent_turns(
    workspace_id,
    agent_session_id,
    updated_at_unix_ms DESC,
    created_at_unix_ms DESC,
    started_at_unix_ms DESC,
    turn_id DESC
  );
`); err != nil {
		return fmt.Errorf("apply workspace agent activity turn integrity v1: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentActivityTurnIntegrityV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent activity turn integrity v1: %w", err)
	}
	committed = true
	return nil
}

func runInConnTx(ctx context.Context, conn *sql.Conn, fn func(*sql.Tx) error) error {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent messages v2 rebuild: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent messages v2 rebuild: %w", err)
	}
	committed = true
	return nil
}
