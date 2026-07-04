package workspace

import (
	"context"
	"fmt"
	"time"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

const legacyIDLocalCodex = "local-codex"
const legacyIDLocalClaudeCode = "local-claude-code"

func (s *SQLiteStore) applyAgentTargetsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentTargetsV1)
	if err != nil {
		return err
	}

	now := unixMs(time.Now().UTC())
	if !applied {
		if _, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS agent_targets (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  launch_ref_json TEXT NOT NULL,
  name TEXT NOT NULL,
  icon_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_targets_display
  ON agent_targets(enabled DESC, sort_order ASC, name ASC, id ASC);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationAgentTargetsV1, now); err != nil {
			return fmt.Errorf("migrate workspace database for agent targets: %w", err)
		}
	}

	return s.seedSystemAgentTargets(ctx, now)
}

func (s *SQLiteStore) seedSystemAgentTargets(ctx context.Context, now int64) error {
	if err := s.reconcileLegacySystemAgentTargetID(ctx, legacyIDLocalCodex, agenttargetbiz.IDLocalCodex, now); err != nil {
		return err
	}
	if err := s.reconcileLegacySystemAgentTargetID(ctx, legacyIDLocalClaudeCode, agenttargetbiz.IDLocalClaudeCode, now); err != nil {
		return err
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(now) {
		if _, err := s.db.ExecContext(ctx, `
INSERT OR IGNORE INTO agent_targets (
  id,
  provider,
  launch_ref_json,
  name,
  icon_key,
  enabled,
  source,
  sort_order,
  created_at_ms,
  updated_at_ms
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, target.ID, target.Provider, target.LaunchRefJSON, target.Name, target.IconKey, target.Enabled, target.Source, target.SortOrder, target.CreatedAtUnixMS, target.UpdatedAtUnixMS); err != nil {
			return fmt.Errorf("seed system agent target %q: %w", target.ID, err)
		}
	}
	return nil
}

func (s *SQLiteStore) reconcileLegacySystemAgentTargetID(ctx context.Context, legacyID string, currentID string, now int64) error {
	if _, err := s.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET agent_target_id = ?
WHERE agent_target_id = ?
`, currentID, legacyID); err != nil {
		return fmt.Errorf("reconcile legacy agent target session id %q: %w", legacyID, err)
	}
	if _, err := s.db.ExecContext(ctx, `
UPDATE agent_targets
SET id = ?, updated_at_ms = ?
WHERE id = ?
  AND source = ?
  AND NOT EXISTS (SELECT 1 FROM agent_targets WHERE id = ?)
`, currentID, now, legacyID, agenttargetbiz.SourceSystem, currentID); err != nil {
		return fmt.Errorf("reconcile legacy system agent target id %q: %w", legacyID, err)
	}
	if _, err := s.db.ExecContext(ctx, `
DELETE FROM agent_targets
WHERE id = ?
  AND source = ?
`, legacyID, agenttargetbiz.SourceSystem); err != nil {
		return fmt.Errorf("delete legacy system agent target %q: %w", legacyID, err)
	}
	return nil
}
