package workspace

import (
	"context"
	"fmt"
	"time"
)

func (s *SQLiteStore) applyDesktopPreferencesV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	_, err = s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS desktop_preferences (
  id TEXT PRIMARY KEY,
  dock_icon_style TEXT NOT NULL DEFAULT 'flat',
  dock_placement TEXT NOT NULL DEFAULT 'bottom',
  default_agent_provider TEXT NOT NULL DEFAULT 'codex',
  agent_composer_defaults_by_provider_json TEXT NOT NULL DEFAULT '{}',
  locale TEXT NOT NULL,
  theme_source TEXT NOT NULL,
  sleep_prevention_mode TEXT NOT NULL DEFAULT 'never',
  browser_use_connection_mode TEXT NOT NULL DEFAULT 'isolated',
  update_channel TEXT NOT NULL DEFAULT 'stable',
  update_policy TEXT NOT NULL DEFAULT 'prompt',
  updated_at_unix_ms INTEGER NOT NULL
);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesV1, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database for desktop preferences: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesUpdateSettingsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesUpdateSettingsV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	hasUpdateChannel, err := s.hasColumn(ctx, "desktop_preferences", "update_channel")
	if err != nil {
		return err
	}
	if !hasUpdateChannel {
		if _, err := s.db.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN update_channel TEXT NOT NULL DEFAULT 'stable';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop update channel: %w", err)
		}
	}
	hasUpdatePolicy, err := s.hasColumn(ctx, "desktop_preferences", "update_policy")
	if err != nil {
		return err
	}
	if !hasUpdatePolicy {
		if _, err := s.db.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN update_policy TEXT NOT NULL DEFAULT 'prompt';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop update policy: %w", err)
		}
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesUpdateSettingsV1, now)
	if err != nil {
		return fmt.Errorf("record desktop update settings migration: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesSleepPreventionModeV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesSleepPreventionModeV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	hasSleepPreventionMode, err := s.hasColumn(ctx, "desktop_preferences", "sleep_prevention_mode")
	if err != nil {
		return err
	}
	hasLegacyPreventSleepEnabled, err := s.hasColumn(ctx, "desktop_preferences", "prevent_sleep_while_agent_running_enabled")
	if err != nil {
		return err
	}
	if !hasSleepPreventionMode {
		if _, err := s.db.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN sleep_prevention_mode TEXT NOT NULL DEFAULT 'never';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop sleep prevention mode: %w", err)
		}
		if hasLegacyPreventSleepEnabled {
			if _, err := s.db.ExecContext(ctx, `
UPDATE desktop_preferences
SET sleep_prevention_mode = 'whileAgentRunning'
WHERE prevent_sleep_while_agent_running_enabled = 1;`); err != nil {
				return fmt.Errorf("migrate legacy desktop sleep prevention mode values: %w", err)
			}
		}
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesSleepPreventionModeV1, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database for desktop sleep prevention mode: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesDockPlacementV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesDockPlacementV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	hasDockPlacement, err := s.hasColumn(ctx, "desktop_preferences", "dock_placement")
	if err != nil {
		return err
	}
	if !hasDockPlacement {
		if _, err := s.db.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN dock_placement TEXT NOT NULL DEFAULT 'bottom';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop dock placement: %w", err)
		}
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesDockPlacementV1, now)
	if err != nil {
		return fmt.Errorf("record desktop dock placement migration: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesDockIconStyleV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesDockIconStyleV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	hasDockIconStyle, err := s.hasColumn(ctx, "desktop_preferences", "dock_icon_style")
	if err != nil {
		return err
	}
	if !hasDockIconStyle {
		if _, err := s.db.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN dock_icon_style TEXT NOT NULL DEFAULT 'flat';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop dock icon style: %w", err)
		}
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesDockIconStyleV1, now)
	if err != nil {
		return fmt.Errorf("record desktop dock icon style migration: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesDefaultAgentProviderV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesDefaultAgentProviderV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	hasDefaultAgentProvider, err := s.hasColumn(ctx, "desktop_preferences", "default_agent_provider")
	if err != nil {
		return err
	}
	if !hasDefaultAgentProvider {
		if _, err := s.db.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN default_agent_provider TEXT NOT NULL DEFAULT 'codex';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop default agent provider: %w", err)
		}
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesDefaultAgentProviderV1, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database for desktop default agent provider: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesAgentComposerDefaultsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesAgentComposerDefaultsV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	hasAgentComposerDefaults, err := s.hasColumn(ctx, "desktop_preferences", "agent_composer_defaults_by_provider_json")
	if err != nil {
		return err
	}
	if !hasAgentComposerDefaults {
		if _, err := s.db.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN agent_composer_defaults_by_provider_json TEXT NOT NULL DEFAULT '{}';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop agent composer defaults: %w", err)
		}
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesAgentComposerDefaultsV1, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database for desktop agent composer defaults: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesBrowserUseConnectionModeV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesBrowserUseConnectionModeV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	hasBrowserUseConnectionMode, err := s.hasColumn(ctx, "desktop_preferences", "browser_use_connection_mode")
	if err != nil {
		return err
	}
	if !hasBrowserUseConnectionMode {
		if _, err := s.db.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN browser_use_connection_mode TEXT NOT NULL DEFAULT 'isolated';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop browser use connection mode: %w", err)
		}
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesBrowserUseConnectionModeV1, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database for desktop browser use connection mode: %w", err)
	}

	return nil
}
