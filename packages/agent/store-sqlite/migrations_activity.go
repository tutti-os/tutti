package storesqlite

import (
	"context"
	"fmt"
	"sort"
)

func (s *Store) applyWorkspaceAgentActivityV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	// Unlike the pre-extraction tuttid schema, workspace_agent_sessions has
	// no foreign key into a host workspaces table; hosts delete a
	// workspace's rows explicitly via ClearSessions.
	_, err = s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS workspace_agent_sessions (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
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
  PRIMARY KEY (workspace_id, agent_session_id)
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
`)
	if err != nil {
		return fmt.Errorf("migrate workspace database agent activity v1: %w", err)
	}

	return s.recordMigration(ctx, schemaMigrationWorkspaceAgentActivityV1)
}

func (s *Store) applyWorkspaceAgentActivityV2(ctx context.Context) error {
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
	return s.recordMigration(ctx, schemaMigrationWorkspaceAgentActivityV2)
}

func (s *Store) applyWorkspaceAgentActivityV3(ctx context.Context) error {
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

	if !hasPinnedAt {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE workspace_agent_sessions ADD COLUMN pinned_at_unix_ms INTEGER NOT NULL DEFAULT 0;`); err != nil {
			return fmt.Errorf("migrate workspace agent activity to v3 pinned state: %w", err)
		}
	}
	return s.recordMigration(ctx, schemaMigrationWorkspaceAgentActivityV3)
}

func (s *Store) applyWorkspaceAgentActivityV4(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityV4)
	if err != nil {
		return err
	}

	// The column is repaired even when the migration is already recorded:
	// some databases carry the v4 marker without the column.
	hasAgentTargetID, err := s.hasColumn(ctx, "workspace_agent_sessions", "agent_target_id")
	if err != nil {
		return err
	}

	if !hasAgentTargetID {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE workspace_agent_sessions ADD COLUMN agent_target_id TEXT;`); err != nil {
			return fmt.Errorf("migrate workspace agent activity to v4 agent target id: %w", err)
		}
	}
	if applied {
		return nil
	}
	return s.recordMigration(ctx, schemaMigrationWorkspaceAgentActivityV4)
}

func (s *Store) applyWorkspaceAgentActivityV5(ctx context.Context) error {
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

	return s.recordMigration(ctx, schemaMigrationWorkspaceAgentActivityV5)
}

func (s *Store) applyWorkspaceAgentActivityV6(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityV6)
	if err != nil {
		return err
	}

	hasUserID, err := s.hasColumn(ctx, "workspace_agent_sessions", "user_id")
	if err != nil {
		return err
	}

	if !hasUserID {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE workspace_agent_sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT '';`); err != nil {
			return fmt.Errorf("migrate workspace agent activity to v6 user id: %w", err)
		}
	}
	if applied {
		return nil
	}
	return s.recordMigration(ctx, schemaMigrationWorkspaceAgentActivityV6)
}

func (s *Store) backfillSystemAgentTargetIDs(ctx context.Context) error {
	providers := make([]string, 0, len(s.opts.TargetIDBackfillByProvider))
	for provider := range s.opts.TargetIDBackfillByProvider {
		providers = append(providers, provider)
	}
	sort.Strings(providers)
	for _, provider := range providers {
		if _, err := s.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET agent_target_id = ?
WHERE (agent_target_id IS NULL OR TRIM(agent_target_id) = '')
  AND provider = ?
`, s.opts.TargetIDBackfillByProvider[provider], provider); err != nil {
			return fmt.Errorf("backfill %s agent target ids: %w", provider, err)
		}
	}
	return nil
}
