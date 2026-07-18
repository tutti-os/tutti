package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
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
	_, err = s.writeDB.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS desktop_preferences (
  id TEXT PRIMARY KEY,
  agent_dock_layout TEXT NOT NULL DEFAULT 'unified',
  dock_icon_style TEXT NOT NULL DEFAULT 'flat',
  dock_placement TEXT NOT NULL DEFAULT 'bottom',
  deleted_agent_conversation_retention_days INTEGER NOT NULL DEFAULT 30,
  default_agent_provider TEXT NOT NULL DEFAULT 'codex',
  agent_conversation_detail_mode TEXT NOT NULL DEFAULT 'coding',
  agent_composer_defaults_by_provider_json TEXT NOT NULL DEFAULT '{}',
  agent_gui_conversation_rail_collapsed_by_provider_json TEXT NOT NULL DEFAULT '{}',
  file_default_openers_by_extension_json TEXT NOT NULL DEFAULT '{"htm":"appBrowser","html":"appBrowser","shtml":"appBrowser","xhtml":"appBrowser"}',
  locale TEXT NOT NULL,
  minimize_animation TEXT NOT NULL DEFAULT 'scale',
  theme_source TEXT NOT NULL,
  sleep_prevention_mode TEXT NOT NULL DEFAULT 'never',
  browser_use_connection_mode TEXT NOT NULL DEFAULT 'isolated',
  app_catalog_channel TEXT NOT NULL DEFAULT 'production',
  update_channel TEXT NOT NULL DEFAULT 'stable',
  update_policy TEXT NOT NULL DEFAULT 'prompt',
  show_app_developer_sources INTEGER NOT NULL DEFAULT 0,
  workbench_window_snapping_enabled INTEGER NOT NULL DEFAULT 0,
  workbench_window_snapping_shortcut_preset TEXT NOT NULL DEFAULT 'commandArrows',
  feature_flags_json TEXT,
  workbench_shortcuts_json TEXT,
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

func (s *SQLiteStore) applyDesktopPreferencesDeletedAgentRetentionV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesDeletedAgentRetentionV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	hasColumn, err := s.hasColumn(ctx, "desktop_preferences", "deleted_agent_conversation_retention_days")
	if err != nil {
		return err
	}
	if !hasColumn {
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN deleted_agent_conversation_retention_days INTEGER NOT NULL DEFAULT 30;
`); err != nil {
			return fmt.Errorf("migrate desktop deleted agent conversation retention: %w", err)
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?);
`, schemaMigrationDesktopPreferencesDeletedAgentRetentionV1, unixMs(time.Now().UTC()))
	if err != nil {
		return fmt.Errorf("record desktop deleted agent conversation retention migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesAgentDockLayoutV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesAgentDockLayoutV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	hasAgentDockLayout, err := s.hasColumn(ctx, "desktop_preferences", "agent_dock_layout")
	if err != nil {
		return err
	}
	if !hasAgentDockLayout {
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN agent_dock_layout TEXT NOT NULL DEFAULT 'unified';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop agent dock layout: %w", err)
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesAgentDockLayoutV1, now)
	if err != nil {
		return fmt.Errorf("record desktop agent dock layout migration: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesAgentConversationDetailModeV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesAgentConversationDetailModeV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	hasAgentConversationDetailMode, err := s.hasColumn(ctx, "desktop_preferences", "agent_conversation_detail_mode")
	if err != nil {
		return err
	}
	if !hasAgentConversationDetailMode {
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN agent_conversation_detail_mode TEXT NOT NULL DEFAULT 'coding';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop agent conversation detail mode: %w", err)
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesAgentConversationDetailModeV1, now)
	if err != nil {
		return fmt.Errorf("record desktop agent conversation detail mode migration: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesFeatureFlagsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesFeatureFlagsV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	columns := []struct {
		name       string
		definition string
	}{
		{"feature_flags_json", "TEXT"},
		{"workbench_shortcuts_json", "TEXT"},
	}
	for _, column := range columns {
		hasColumn, err := s.hasColumn(ctx, "desktop_preferences", column.name)
		if err != nil {
			return err
		}
		if hasColumn {
			continue
		}
		if _, err := s.writeDB.ExecContext(ctx, fmt.Sprintf(`
ALTER TABLE desktop_preferences
  ADD COLUMN %s %s;`, column.name, column.definition)); err != nil {
			return fmt.Errorf("migrate workspace database for desktop feature flags preferences %s: %w", column.name, err)
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesFeatureFlagsV1, now)
	if err != nil {
		return fmt.Errorf("record desktop feature flags preferences migration: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesShowAppDeveloperSourcesV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesShowAppDeveloperSourcesV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	hasShowAppDeveloperSources, err := s.hasColumn(ctx, "desktop_preferences", "show_app_developer_sources")
	if err != nil {
		return err
	}
	if !hasShowAppDeveloperSources {
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN show_app_developer_sources INTEGER NOT NULL DEFAULT 0;`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop app developer sources: %w", err)
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesShowAppDeveloperSourcesV1, now)
	if err != nil {
		return fmt.Errorf("record desktop app developer sources migration: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesFileDefaultOpenersV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesFileDefaultOpenersV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	hasFileDefaultOpeners, err := s.hasColumn(ctx, "desktop_preferences", "file_default_openers_by_extension_json")
	if err != nil {
		return err
	}
	if !hasFileDefaultOpeners {
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN file_default_openers_by_extension_json TEXT NOT NULL DEFAULT '{"htm":"appBrowser","html":"appBrowser","shtml":"appBrowser","xhtml":"appBrowser"}';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop file default openers: %w", err)
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesFileDefaultOpenersV1, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database for desktop file default openers: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesAppCatalogChannelV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesAppCatalogChannelV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	hasAppCatalogChannel, err := s.hasColumn(ctx, "desktop_preferences", "app_catalog_channel")
	if err != nil {
		return err
	}
	if !hasAppCatalogChannel {
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN app_catalog_channel TEXT NOT NULL DEFAULT 'production';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop app catalog channel: %w", err)
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesAppCatalogChannelV1, now)
	if err != nil {
		return fmt.Errorf("record desktop app catalog channel migration: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesMinimizeAnimationV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesMinimizeAnimationV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	hasMinimizeAnimation, err := s.hasColumn(ctx, "desktop_preferences", "minimize_animation")
	if err != nil {
		return err
	}

	now := unixMs(time.Now().UTC())
	if !hasMinimizeAnimation {
		_, err = s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences ADD COLUMN minimize_animation TEXT NOT NULL DEFAULT 'scale';
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesMinimizeAnimationV1, now)
		if err != nil {
			return fmt.Errorf("migrate workspace database for desktop preferences minimize animation: %w", err)
		}
		return nil
	}

	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesMinimizeAnimationV1, now)
	if err != nil {
		return fmt.Errorf("mark desktop preferences minimize animation migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesAgentGUIConversationRailV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesAgentGUIConversationRailV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	hasAgentGUIConversationRail, err := s.hasColumn(ctx, "desktop_preferences", "agent_gui_conversation_rail_collapsed_by_provider_json")
	if err != nil {
		return err
	}
	if !hasAgentGUIConversationRail {
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN agent_gui_conversation_rail_collapsed_by_provider_json TEXT NOT NULL DEFAULT '{}';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop agent gui conversation rail: %w", err)
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesAgentGUIConversationRailV1, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database for desktop agent gui conversation rail: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesWindowSnappingV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesWindowSnappingV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	hasWindowSnappingEnabled, err := s.hasColumn(ctx, "desktop_preferences", "workbench_window_snapping_enabled")
	if err != nil {
		return err
	}
	if !hasWindowSnappingEnabled {
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN workbench_window_snapping_enabled INTEGER NOT NULL DEFAULT 0;`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop workbench window snapping enabled: %w", err)
		}
	}
	hasWindowSnappingShortcutPreset, err := s.hasColumn(ctx, "desktop_preferences", "workbench_window_snapping_shortcut_preset")
	if err != nil {
		return err
	}
	if !hasWindowSnappingShortcutPreset {
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN workbench_window_snapping_shortcut_preset TEXT NOT NULL DEFAULT 'commandArrows';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop workbench window snapping shortcut preset: %w", err)
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesWindowSnappingV1, now)
	if err != nil {
		return fmt.Errorf("record desktop workbench window snapping migration: %w", err)
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
		if _, err := s.writeDB.ExecContext(ctx, `
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
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN update_policy TEXT NOT NULL DEFAULT 'prompt';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop update policy: %w", err)
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
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
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN sleep_prevention_mode TEXT NOT NULL DEFAULT 'never';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop sleep prevention mode: %w", err)
		}
		if hasLegacyPreventSleepEnabled {
			if _, err := s.writeDB.ExecContext(ctx, `
UPDATE desktop_preferences
SET sleep_prevention_mode = 'whileAgentRunning'
WHERE prevent_sleep_while_agent_running_enabled = 1;`); err != nil {
				return fmt.Errorf("migrate legacy desktop sleep prevention mode values: %w", err)
			}
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
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
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN dock_placement TEXT NOT NULL DEFAULT 'bottom';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop dock placement: %w", err)
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
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
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN dock_icon_style TEXT NOT NULL DEFAULT 'flat';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop dock icon style: %w", err)
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
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
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN default_agent_provider TEXT NOT NULL DEFAULT 'codex';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop default agent provider: %w", err)
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
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
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN agent_composer_defaults_by_provider_json TEXT NOT NULL DEFAULT '{}';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop agent composer defaults: %w", err)
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesAgentComposerDefaultsV1, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database for desktop agent composer defaults: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyDesktopPreferencesAgentComposerDefaultsByAgentTargetV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationDesktopPreferencesAgentComposerDefaultsByAgentTargetV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	hasColumn, err := s.hasColumn(ctx, "desktop_preferences", "agent_composer_defaults_by_agent_target_json")
	if err != nil {
		return err
	}
	if !hasColumn {
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN agent_composer_defaults_by_agent_target_json TEXT NOT NULL DEFAULT '{}';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop agent composer defaults by agent target: %w", err)
		}
	}
	if err := s.backfillAgentComposerDefaultsByAgentTarget(ctx); err != nil {
		return fmt.Errorf("migrate workspace database for desktop agent composer defaults by agent target: %w", err)
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesAgentComposerDefaultsByAgentTargetV1, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database for desktop agent composer defaults by agent target: %w", err)
	}

	return nil
}

// backfillAgentComposerDefaultsByAgentTarget copies the legacy provider-keyed
// composer defaults onto their local agent target ids exactly once. After
// this data migration nothing reads the legacy column anymore, so remembered
// defaults (including explicit clears) are fully owned by the new column.
func (s *SQLiteStore) backfillAgentComposerDefaultsByAgentTarget(ctx context.Context) error {
	row := s.writeDB.QueryRowContext(ctx, `
SELECT agent_composer_defaults_by_provider_json, agent_composer_defaults_by_agent_target_json
FROM desktop_preferences
WHERE id = ?
`, desktopPreferencesRowID)
	var legacyJSON string
	var byAgentTargetJSON string
	if err := row.Scan(&legacyJSON, &byAgentTargetJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}

	byAgentTarget, err := decodeAgentComposerDefaultsByProvider(byAgentTargetJSON)
	if err != nil {
		return err
	}
	if len(byAgentTarget) > 0 {
		return nil
	}
	legacy, err := decodeAgentComposerDefaultsByProvider(legacyJSON)
	if err != nil {
		return err
	}
	migrated := map[string]preferencesbiz.AgentComposerDefaults{}
	for provider, defaults := range legacy {
		agentTargetID := preferencesbiz.LocalAgentTargetIDForProvider(provider)
		if agentTargetID == "" || defaults.IsZero() {
			continue
		}
		migrated[agentTargetID] = defaults
	}
	if len(migrated) == 0 {
		return nil
	}
	migratedJSON, err := encodeAgentComposerDefaultsByProvider(migrated)
	if err != nil {
		return err
	}
	_, err = s.writeDB.ExecContext(ctx, `
UPDATE desktop_preferences
SET agent_composer_defaults_by_agent_target_json = ?
WHERE id = ?
`, migratedJSON, desktopPreferencesRowID)
	return err
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
		if _, err := s.writeDB.ExecContext(ctx, `
ALTER TABLE desktop_preferences
  ADD COLUMN browser_use_connection_mode TEXT NOT NULL DEFAULT 'isolated';`); err != nil {
			return fmt.Errorf("migrate workspace database for desktop browser use connection mode: %w", err)
		}
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationDesktopPreferencesBrowserUseConnectionModeV1, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database for desktop browser use connection mode: %w", err)
	}

	return nil
}
