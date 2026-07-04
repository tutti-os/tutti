package workspace

import (
	"context"
	"fmt"
	"time"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func (s *SQLiteStore) applyWorkspaceAgentActivityV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	_, err = s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS workspace_agent_sessions (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT '',
  agent_target_id TEXT,
  provider TEXT NOT NULL DEFAULT '',
  provider_session_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  settings_json TEXT NOT NULL DEFAULT '{}',
  runtime_context_json TEXT NOT NULL DEFAULT '{}',
  cwd TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  current_phase TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  message_version INTEGER NOT NULL DEFAULT 0,
  last_event_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  ended_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  deleted_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_agent_sessions_workspace_updated
  ON workspace_agent_sessions(workspace_id, deleted_at_unix_ms, updated_at_unix_ms);

CREATE TABLE IF NOT EXISTS workspace_agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  turn_id TEXT NOT NULL DEFAULT '',
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

CREATE INDEX IF NOT EXISTS idx_workspace_agent_messages_session_version
  ON workspace_agent_messages(workspace_id, agent_session_id, deleted_at_unix_ms, version);

CREATE INDEX IF NOT EXISTS idx_workspace_agent_messages_session_display
  ON workspace_agent_messages(workspace_id, agent_session_id, deleted_at_unix_ms, id);

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceAgentActivityV1, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database agent activity v1: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyWorkspaceAgentActivityV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityV2)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	hasSettings, err := s.hasColumn(ctx, "workspace_agent_sessions", "settings_json")
	if err != nil {
		return err
	}
	hasRuntimeContext, err := s.hasColumn(ctx, "workspace_agent_sessions", "runtime_context_json")
	if err != nil {
		return err
	}

	now := unixMs(time.Now().UTC())
	if !hasSettings {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE workspace_agent_sessions ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';`); err != nil {
			return fmt.Errorf("migrate workspace agent activity to v2 settings: %w", err)
		}
	}
	if !hasRuntimeContext {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE workspace_agent_sessions ADD COLUMN runtime_context_json TEXT NOT NULL DEFAULT '{}';`); err != nil {
			return fmt.Errorf("migrate workspace agent activity to v2 runtime context: %w", err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceAgentActivityV2, now); err != nil {
		return fmt.Errorf("record workspace agent activity v2 migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyWorkspaceAgentActivityV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityV3)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	hasPinnedAt, err := s.hasColumn(ctx, "workspace_agent_sessions", "pinned_at_unix_ms")
	if err != nil {
		return err
	}

	now := unixMs(time.Now().UTC())
	if !hasPinnedAt {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE workspace_agent_sessions ADD COLUMN pinned_at_unix_ms INTEGER NOT NULL DEFAULT 0;`); err != nil {
			return fmt.Errorf("migrate workspace agent activity to v3 pinned state: %w", err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceAgentActivityV3, now); err != nil {
		return fmt.Errorf("record workspace agent activity v3 migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyWorkspaceAgentActivityV4(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityV4)
	if err != nil {
		return err
	}

	hasAgentTargetID, err := s.hasColumn(ctx, "workspace_agent_sessions", "agent_target_id")
	if err != nil {
		return err
	}

	now := unixMs(time.Now().UTC())
	if !hasAgentTargetID {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE workspace_agent_sessions ADD COLUMN agent_target_id TEXT;`); err != nil {
			return fmt.Errorf("migrate workspace agent activity to v4 agent target id: %w", err)
		}
	}
	if applied {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceAgentActivityV4, now); err != nil {
		return fmt.Errorf("record workspace agent activity v4 migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyWorkspaceAgentActivityV5(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityV5)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	if err := s.backfillSystemAgentTargetIDs(ctx); err != nil {
		return err
	}

	now := unixMs(time.Now().UTC())
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceAgentActivityV5, now); err != nil {
		return fmt.Errorf("record workspace agent activity v5 migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) backfillSystemAgentTargetIDs(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET agent_target_id = ?
WHERE (agent_target_id IS NULL OR TRIM(agent_target_id) = '')
  AND provider = 'codex'
`, agenttargetbiz.IDLocalCodex); err != nil {
		return fmt.Errorf("backfill codex agent target ids: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET agent_target_id = ?
WHERE (agent_target_id IS NULL OR TRIM(agent_target_id) = '')
  AND provider = 'claude-code'
`, agenttargetbiz.IDLocalClaudeCode); err != nil {
		return fmt.Errorf("backfill claude-code agent target ids: %w", err)
	}
	return nil
}
