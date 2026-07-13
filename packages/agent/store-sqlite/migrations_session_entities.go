package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
)

func (s *Store) applyWorkspaceAgentSessionEntitiesV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentSessionEntitiesV3)
	if err != nil || applied {
		return err
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("open connection for workspace agent session entities v3: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		return fmt.Errorf("disable foreign keys for workspace agent session entities v3: %w", err)
	}
	defer func() { _, _ = conn.ExecContext(ctx, `PRAGMA foreign_keys = ON`) }()
	return runInConnTx(ctx, conn, func(tx *sql.Tx) error {
		if err := ensureSessionEntitySourceColumnsTx(ctx, tx); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
CREATE TABLE workspace_agent_sessions_v3 (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  agent_target_id TEXT,
  provider TEXT NOT NULL DEFAULT '',
  provider_session_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  settings_json TEXT NOT NULL DEFAULT '{}',
  session_metadata_json TEXT NOT NULL DEFAULT '{"visible":true,"imported":false,"capabilities":[]}'
    CHECK (json_valid(session_metadata_json)
      AND json_type(session_metadata_json, '$.visible') IN ('true','false')
      AND json_type(session_metadata_json, '$.imported') IN ('true','false')
      AND json_type(session_metadata_json, '$.capabilities') = 'array'
      AND (json_type(session_metadata_json, '$.backgroundAgents') IS NULL OR json_type(session_metadata_json, '$.backgroundAgents') IN ('null','object'))
      AND (json_type(session_metadata_json, '$.goal') IS NULL OR json_type(session_metadata_json, '$.goal') IN ('null','object'))),
  internal_runtime_context_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(internal_runtime_context_json) AND json_type(internal_runtime_context_json) = 'object'),
  cwd TEXT NOT NULL DEFAULT '',
  rail_section_kind TEXT NOT NULL DEFAULT 'conversations',
  rail_project_path TEXT NOT NULL DEFAULT '',
  rail_section_key TEXT NOT NULL DEFAULT 'conversations',
  title TEXT NOT NULL DEFAULT '',
  message_version INTEGER NOT NULL DEFAULT 0,
  last_event_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  ended_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  pinned_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  deleted_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  active_turn_id TEXT CHECK (active_turn_id IS NULL OR length(active_turn_id) > 0),
  PRIMARY KEY (workspace_id, agent_session_id),
  FOREIGN KEY (workspace_id, agent_session_id, active_turn_id)
    REFERENCES workspace_agent_turns(workspace_id, agent_session_id, turn_id)
    DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO workspace_agent_sessions_v3 (
  workspace_id, agent_session_id, origin, user_id, agent_target_id, provider,
  provider_session_id, model, settings_json, session_metadata_json,
  internal_runtime_context_json, cwd, rail_section_kind, rail_project_path,
  rail_section_key, title, message_version, last_event_at_unix_ms,
  started_at_unix_ms, ended_at_unix_ms, pinned_at_unix_ms, deleted_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms, active_turn_id
)
SELECT workspace_id, agent_session_id, origin, user_id, agent_target_id, provider,
       provider_session_id, model, settings_json, session_metadata_json,
       internal_runtime_context_json, cwd, rail_section_kind, rail_project_path,
       rail_section_key, title, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, pinned_at_unix_ms, deleted_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms, NULLIF(TRIM(active_turn_id), '')
FROM workspace_agent_sessions;
DROP TABLE workspace_agent_sessions;
ALTER TABLE workspace_agent_sessions_v3 RENAME TO workspace_agent_sessions;
CREATE INDEX idx_workspace_agent_sessions_workspace_updated
  ON workspace_agent_sessions(workspace_id, deleted_at_unix_ms, updated_at_unix_ms);
CREATE INDEX idx_workspace_agent_sessions_rail_section_page
  ON workspace_agent_sessions(workspace_id, rail_section_key, deleted_at_unix_ms, updated_at_unix_ms DESC, agent_session_id ASC);
`); err != nil {
			return fmt.Errorf("migrate workspace agent session entities v3: %w", err)
		}
		return recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentSessionEntitiesV3)
	})
}

func ensureSessionEntitySourceColumnsTx(ctx context.Context, tx *sql.Tx) error {
	columns := []struct{ name, definition string }{
		{"origin", "TEXT NOT NULL DEFAULT ''"},
		{"user_id", "TEXT NOT NULL DEFAULT ''"},
		{"agent_target_id", "TEXT"},
		{"provider", "TEXT NOT NULL DEFAULT ''"},
		{"provider_session_id", "TEXT NOT NULL DEFAULT ''"},
		{"model", "TEXT NOT NULL DEFAULT ''"},
		{"settings_json", "TEXT NOT NULL DEFAULT '{}'"},
		{"cwd", "TEXT NOT NULL DEFAULT ''"},
		{"rail_section_kind", "TEXT NOT NULL DEFAULT 'conversations'"},
		{"rail_project_path", "TEXT NOT NULL DEFAULT ''"},
		{"rail_section_key", "TEXT NOT NULL DEFAULT 'conversations'"},
		{"title", "TEXT NOT NULL DEFAULT ''"},
		{"message_version", "INTEGER NOT NULL DEFAULT 0"},
		{"last_event_at_unix_ms", "INTEGER NOT NULL DEFAULT 0"},
		{"started_at_unix_ms", "INTEGER NOT NULL DEFAULT 0"},
		{"ended_at_unix_ms", "INTEGER NOT NULL DEFAULT 0"},
		{"pinned_at_unix_ms", "INTEGER NOT NULL DEFAULT 0"},
		{"deleted_at_unix_ms", "INTEGER NOT NULL DEFAULT 0"},
		{"created_at_unix_ms", "INTEGER NOT NULL DEFAULT 0"},
		{"updated_at_unix_ms", "INTEGER NOT NULL DEFAULT 0"},
		{"active_turn_id", "TEXT"},
	}
	for _, column := range columns {
		exists, err := hasColumnTx(ctx, tx, "workspace_agent_sessions", column.name)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		if _, err := tx.ExecContext(ctx, `ALTER TABLE workspace_agent_sessions ADD COLUMN `+column.name+` `+column.definition); err != nil {
			return fmt.Errorf("add workspace agent session entity source column %s: %w", column.name, err)
		}
	}
	return nil
}
