package storesqlite

import (
	"context"
	"fmt"
	"sort"
	"time"
)

// systemTargetSource marks host-seeded targets; legacy ID reconciliation
// only rewrites rows with this source.
const systemTargetSource = "system"

func (s *Store) applyAgentTargetsV1(ctx context.Context) error {
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
`); err != nil {
			return fmt.Errorf("migrate workspace database for agent targets: %w", err)
		}
		if err := s.recordMigration(ctx, schemaMigrationAgentTargetsV1); err != nil {
			return err
		}
	}

	return s.seedSystemAgentTargets(ctx, now)
}

func (s *Store) applyAgentTargetsV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentTargetsV2)
	if err != nil || applied {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE agent_targets ADD COLUMN icon_url TEXT`); err != nil {
		return fmt.Errorf("add agent target icon URL: %w", err)
	}
	return s.recordMigration(ctx, schemaMigrationAgentTargetsV2)
}

func (s *Store) applyAgentTargetsV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentTargetsV3)
	if err != nil || applied {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE agent_targets ADD COLUMN hero_image_url TEXT`); err != nil {
		return fmt.Errorf("add agent target hero image URL: %w", err)
	}
	return s.recordMigration(ctx, schemaMigrationAgentTargetsV3)
}

func (s *Store) applyAgentTargetsV4(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentTargetsV4)
	if err != nil || applied {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE agent_targets ADD COLUMN sidebar_icon_url TEXT`); err != nil {
		return fmt.Errorf("add agent target sidebar icon URL: %w", err)
	}
	return s.recordMigration(ctx, schemaMigrationAgentTargetsV4)
}

func (s *Store) applyAgentTargetsV5(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentTargetsV5)
	if err != nil || applied {
		if err != nil {
			return err
		}
		return s.seedSystemAgentTargets(ctx, unixMs(time.Now().UTC()))
	}
	if _, err := s.db.ExecContext(ctx, `
ALTER TABLE agent_targets RENAME COLUMN sidebar_icon_url TO mask_icon_url;
UPDATE agent_targets SET mask_icon_url = NULL;
DELETE FROM agent_targets WHERE launch_ref_json LIKE '%"type":"agent_extension"%';
`); err != nil {
		return fmt.Errorf("replace agent target sidebar icon with mask icon: %w", err)
	}
	if err := s.recordMigration(ctx, schemaMigrationAgentTargetsV5); err != nil {
		return err
	}
	return s.seedSystemAgentTargets(ctx, unixMs(time.Now().UTC()))
}

func (s *Store) seedSystemAgentTargets(ctx context.Context, now int64) error {
	legacyIDs := make([]string, 0, len(s.opts.LegacySystemTargetIDRenames))
	for legacyID := range s.opts.LegacySystemTargetIDRenames {
		legacyIDs = append(legacyIDs, legacyID)
	}
	sort.Strings(legacyIDs)
	for _, legacyID := range legacyIDs {
		if err := s.reconcileLegacySystemAgentTargetID(ctx, legacyID, s.opts.LegacySystemTargetIDRenames[legacyID], now); err != nil {
			return err
		}
	}
	if s.opts.SeedSystemTargets == nil {
		return nil
	}
	hasIconURL, err := s.hasColumn(ctx, "agent_targets", "icon_url")
	if err != nil {
		return err
	}
	hasMaskIconURL, err := s.hasColumn(ctx, "agent_targets", "mask_icon_url")
	if err != nil {
		return err
	}
	hasHeroImageURL, err := s.hasColumn(ctx, "agent_targets", "hero_image_url")
	if err != nil {
		return err
	}
	hasIconColumns := hasIconURL && hasMaskIconURL && hasHeroImageURL
	for _, target := range s.opts.SeedSystemTargets(now) {
		if !hasIconColumns {
			if err := s.seedSystemAgentTargetWithoutIconColumns(ctx, target, now); err != nil {
				return err
			}
			continue
		}
		if _, err := s.db.ExecContext(ctx, `
INSERT OR IGNORE INTO agent_targets (
  id,
  provider,
  launch_ref_json,
  name,
  icon_key,
  icon_url,
  mask_icon_url,
  hero_image_url,
  enabled,
  source,
  sort_order,
  created_at_ms,
  updated_at_ms
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, target.ID, target.Provider, target.LaunchRefJSON, target.Name, target.IconKey, target.IconURL, target.MaskIconURL, target.HeroImageURL, target.Enabled, target.Source, target.SortOrder, target.CreatedAtUnixMS, target.UpdatedAtUnixMS); err != nil {
			return fmt.Errorf("seed system agent target %q: %w", target.ID, err)
		}
		if target.Source != systemTargetSource {
			continue
		}
		if _, err := s.db.ExecContext(ctx, `
UPDATE agent_targets
SET provider = ?,
    launch_ref_json = ?,
    name = ?,
    icon_key = ?,
    icon_url = ?,
    mask_icon_url = ?,
    hero_image_url = ?,
    enabled = ?,
    sort_order = ?,
    updated_at_ms = ?
WHERE id = ?
  AND source = ?
  AND (
    provider != ? OR
    launch_ref_json != ? OR
    name != ? OR
    COALESCE(icon_key, '') != ? OR
    COALESCE(icon_url, '') != ? OR
    COALESCE(mask_icon_url, '') != ? OR
    COALESCE(hero_image_url, '') != ? OR
    enabled != ? OR
    sort_order != ?
  )
`,
			target.Provider,
			target.LaunchRefJSON,
			target.Name,
			target.IconKey,
			target.IconURL,
			target.MaskIconURL,
			target.HeroImageURL,
			target.Enabled,
			target.SortOrder,
			now,
			target.ID,
			systemTargetSource,
			target.Provider,
			target.LaunchRefJSON,
			target.Name,
			target.IconKey,
			target.IconURL,
			target.MaskIconURL,
			target.HeroImageURL,
			target.Enabled,
			target.SortOrder,
		); err != nil {
			return fmt.Errorf("refresh system agent target %q: %w", target.ID, err)
		}
	}
	return nil
}

func (s *Store) seedSystemAgentTargetWithoutIconColumns(ctx context.Context, target Target, now int64) error {
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
	if target.Source != systemTargetSource {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, `
UPDATE agent_targets
SET provider = ?,
    launch_ref_json = ?,
    name = ?,
    icon_key = ?,
    enabled = ?,
    sort_order = ?,
    updated_at_ms = ?
WHERE id = ?
  AND source = ?
  AND (
    provider != ? OR
    launch_ref_json != ? OR
    name != ? OR
    COALESCE(icon_key, '') != ? OR
    enabled != ? OR
    sort_order != ?
  )
`,
		target.Provider,
		target.LaunchRefJSON,
		target.Name,
		target.IconKey,
		target.Enabled,
		target.SortOrder,
		now,
		target.ID,
		systemTargetSource,
		target.Provider,
		target.LaunchRefJSON,
		target.Name,
		target.IconKey,
		target.Enabled,
		target.SortOrder,
	); err != nil {
		return fmt.Errorf("refresh system agent target %q: %w", target.ID, err)
	}
	return nil
}

func (s *Store) reconcileLegacySystemAgentTargetID(ctx context.Context, legacyID string, currentID string, now int64) error {
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
`, currentID, now, legacyID, systemTargetSource, currentID); err != nil {
		return fmt.Errorf("reconcile legacy system agent target id %q: %w", legacyID, err)
	}
	if _, err := s.db.ExecContext(ctx, `
DELETE FROM agent_targets
WHERE id = ?
  AND source = ?
`, legacyID, systemTargetSource); err != nil {
		return fmt.Errorf("delete legacy system agent target %q: %w", legacyID, err)
	}
	return nil
}
