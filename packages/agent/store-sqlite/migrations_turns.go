package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"
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

	if _, err := s.db.ExecContext(ctx, `
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
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  settled_at_unix_ms INTEGER,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
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
  PRIMARY KEY (workspace_id, agent_session_id, request_id),
  FOREIGN KEY (workspace_id, agent_session_id, turn_id)
    REFERENCES workspace_agent_turns(workspace_id, agent_session_id, turn_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_agent_interactions_session_status
  ON workspace_agent_interactions(workspace_id, agent_session_id, status);
`); err != nil {
		return fmt.Errorf("migrate workspace agent activity turns v1: %w", err)
	}

	hasActiveTurnID, err := s.hasColumn(ctx, "workspace_agent_sessions", "active_turn_id")
	if err != nil {
		return err
	}
	if !hasActiveTurnID {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE workspace_agent_sessions ADD COLUMN active_turn_id TEXT;`); err != nil {
			return fmt.Errorf("migrate workspace agent sessions active turn id: %w", err)
		}
	}

	if err := s.backfillWorkspaceAgentTurns(ctx); err != nil {
		return err
	}

	return s.recordMigration(ctx, schemaMigrationWorkspaceAgentActivityTurnsV1)
}

func (s *Store) backfillWorkspaceAgentTurns(ctx context.Context) error {
	now := unixMs(time.Now().UTC())
	if _, err := s.db.ExecContext(ctx, `
INSERT OR IGNORE INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase, outcome, backfilled,
  started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
)
SELECT
  workspace_id,
  agent_session_id,
  TRIM(turn_id),
  'settled',
  'completed',
  1,
  MIN(CASE
    WHEN started_at_unix_ms > 0 THEN started_at_unix_ms
    WHEN occurred_at_unix_ms > 0 THEN occurred_at_unix_ms
    ELSE created_at_unix_ms
  END),
  MAX(MAX(completed_at_unix_ms, occurred_at_unix_ms, updated_at_unix_ms)),
  ?,
  ?
FROM workspace_agent_messages
WHERE TRIM(turn_id) != ''
GROUP BY workspace_id, agent_session_id, TRIM(turn_id)
`, now, now); err != nil {
		return fmt.Errorf("backfill workspace agent turns: %w", err)
	}

	// Claimed legacy databases may still carry a pre-activity sessions table
	// without a status column; those sessions have no terminal status to
	// inherit, so the outcome repair is skipped.
	hasStatus, err := s.hasColumn(ctx, "workspace_agent_sessions", "status")
	if err != nil {
		return err
	}
	if !hasStatus {
		return nil
	}

	// The newest backfilled turn of a failed/canceled session inherits the
	// session outcome; ties on settled_at fall back to lexically greatest
	// turn id for determinism.
	if _, err := s.db.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET outcome = (
  SELECT CASE s.status WHEN 'failed' THEN 'failed' ELSE 'canceled' END
  FROM workspace_agent_sessions s
  WHERE s.workspace_id = workspace_agent_turns.workspace_id
    AND s.agent_session_id = workspace_agent_turns.agent_session_id
),
updated_at_unix_ms = ?
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
`, now); err != nil {
		return fmt.Errorf("repair backfilled workspace agent turn outcomes: %w", err)
	}
	return nil
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

	if err := s.rebuildWorkspaceAgentMessagesV2(ctx); err != nil {
		return err
	}

	return s.recordMigration(ctx, schemaMigrationWorkspaceAgentActivityMessagesV2)
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
  message_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  turn_id TEXT CHECK (turn_id IS NULL OR length(turn_id) > 0),
  role TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  completed_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  deleted_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  UNIQUE (workspace_id, agent_session_id, message_id),
  FOREIGN KEY (workspace_id, agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id)
    ON DELETE CASCADE
);
`); err != nil {
			return fmt.Errorf("create workspace agent messages v2 table: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_messages_v2 (
  id, workspace_id, agent_session_id, message_id, version, turn_id, role, kind, status,
  payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
  deleted_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
)
SELECT
  id, workspace_id, agent_session_id, message_id, version, NULLIF(TRIM(turn_id), ''), role, kind, status,
  payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
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
		return nil
	})
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
