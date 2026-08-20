package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

const desktopPreferencesInsertSQL = `
INSERT INTO desktop_preferences (
  id,
  agent_cli_update_check_enabled,
  default_agent_provider,
  agent_conversation_detail_mode,
  agent_dock_layout,
  dock_icon_style,
  dock_placement,
  deleted_agent_conversation_retention_days,
  locale,
  theme_source,
  sleep_prevention_mode,
  update_channel,
  update_policy,
  agent_composer_defaults_by_provider_json,
  agent_composer_defaults_by_agent_target_json,
  agent_gui_conversation_rail_collapsed_by_provider_json,
  agent_session_launch_modes_by_workspace_json,
  file_default_openers_by_extension_json,
  app_catalog_channel,
  browser_use_connection_mode,
  minimize_animation,
  show_app_developer_sources,
  workbench_window_snapping_enabled,
  workbench_window_snapping_shortcut_preset,
  feature_flags_json,
  workbench_shortcuts_json,
  updated_at_unix_ms
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

const desktopPreferencesReplaceOnConflictSQL = `
ON CONFLICT(id) DO UPDATE SET
  agent_cli_update_check_enabled = excluded.agent_cli_update_check_enabled,
  default_agent_provider = excluded.default_agent_provider,
  agent_conversation_detail_mode = excluded.agent_conversation_detail_mode,
  agent_dock_layout = excluded.agent_dock_layout,
  dock_icon_style = excluded.dock_icon_style,
  dock_placement = excluded.dock_placement,
  deleted_agent_conversation_retention_days = excluded.deleted_agent_conversation_retention_days,
  locale = excluded.locale,
  theme_source = excluded.theme_source,
  sleep_prevention_mode = excluded.sleep_prevention_mode,
  update_channel = excluded.update_channel,
  update_policy = excluded.update_policy,
  agent_composer_defaults_by_provider_json = excluded.agent_composer_defaults_by_provider_json,
  agent_gui_conversation_rail_collapsed_by_provider_json = excluded.agent_gui_conversation_rail_collapsed_by_provider_json,
  file_default_openers_by_extension_json = excluded.file_default_openers_by_extension_json,
  app_catalog_channel = excluded.app_catalog_channel,
  browser_use_connection_mode = excluded.browser_use_connection_mode,
  minimize_animation = excluded.minimize_animation,
  show_app_developer_sources = excluded.show_app_developer_sources,
  workbench_window_snapping_enabled = excluded.workbench_window_snapping_enabled,
  workbench_window_snapping_shortcut_preset = excluded.workbench_window_snapping_shortcut_preset,
  feature_flags_json = excluded.feature_flags_json,
  workbench_shortcuts_json = excluded.workbench_shortcuts_json,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`

type desktopPreferencesExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

type encodedDesktopPreferences struct {
	agentComposerDefaultsJSON              string
	agentComposerDefaultsByAgentTargetJSON string
	agentGUIConversationRailCollapsedJSON  string
	agentSessionLaunchModesJSON            string
	featureFlagsJSON                       string
	fileDefaultOpenersJSON                 string
	workbenchShortcutsJSON                 string
}

func (s *SQLiteStore) PutDesktopPreferences(ctx context.Context, preferences preferencesbiz.DesktopPreferences) (preferencesbiz.DesktopPreferences, error) {
	if s == nil || s.writeDB == nil {
		return preferencesbiz.DesktopPreferences{}, errors.New("workspace database is not initialized")
	}

	if _, err := writeDesktopPreferences(ctx, s.writeDB, preferences, desktopPreferencesReplaceOnConflictSQL); err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("put desktop preferences: %w", err)
	}

	// Re-read after the write because the dedicated target-defaults or launch-mode
	// patch may have committed between a full preferences caller's read and this
	// update. The conflict clause deliberately preserves those columns, so
	// returning the input object here would publish a stale snapshot.
	return s.GetDesktopPreferences(ctx)
}

func (s *SQLiteStore) InitializeDesktopPreferences(
	ctx context.Context,
	preferences preferencesbiz.DesktopPreferences,
) (preferencesbiz.DesktopPreferences, bool, error) {
	if s == nil || s.writeDB == nil {
		return preferencesbiz.DesktopPreferences{}, false, errors.New("workspace database is not initialized")
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, false, fmt.Errorf("begin desktop preferences initialization: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	created, err := insertDesktopPreferencesIfAbsent(ctx, tx, preferences)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, false, fmt.Errorf("initialize desktop preferences: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return preferencesbiz.DesktopPreferences{}, false, fmt.Errorf("commit desktop preferences initialization: %w", err)
	}
	stored, err := s.GetDesktopPreferences(ctx)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, false, fmt.Errorf("read initialized desktop preferences: %w", err)
	}
	return stored, created, nil
}

func insertDesktopPreferencesIfAbsent(
	ctx context.Context,
	execer desktopPreferencesExecer,
	preferences preferencesbiz.DesktopPreferences,
) (bool, error) {
	result, err := writeDesktopPreferences(ctx, execer, preferences, "ON CONFLICT(id) DO NOTHING")
	if err != nil {
		return false, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("count initialized desktop preferences rows: %w", err)
	}
	return rows == 1, nil
}

func writeDesktopPreferences(
	ctx context.Context,
	execer desktopPreferencesExecer,
	preferences preferencesbiz.DesktopPreferences,
	conflictSQL string,
) (sql.Result, error) {
	encoded, err := encodeDesktopPreferences(preferences)
	if err != nil {
		return nil, err
	}
	return execer.ExecContext(
		ctx,
		desktopPreferencesInsertSQL+conflictSQL,
		desktopPreferencesRowID,
		preferences.AgentCLIUpdateCheckEnabled,
		preferences.DefaultAgentProvider,
		preferencesbiz.NormalizeDesktopAgentConversationDetailMode(preferences.AgentConversationDetailMode),
		preferencesbiz.NormalizeDesktopAgentDockLayout(preferences.AgentDockLayout),
		preferences.DockIconStyle,
		preferences.DockPlacement,
		preferencesbiz.NormalizeDeletedAgentConversationRetentionDays(preferences.DeletedAgentConversationRetentionDays),
		preferences.Locale,
		preferences.ThemeSource,
		preferences.SleepPreventionMode,
		preferences.UpdateChannel,
		preferences.UpdatePolicy,
		encoded.agentComposerDefaultsJSON,
		encoded.agentComposerDefaultsByAgentTargetJSON,
		encoded.agentGUIConversationRailCollapsedJSON,
		encoded.agentSessionLaunchModesJSON,
		encoded.fileDefaultOpenersJSON,
		preferences.AppCatalogChannel,
		preferences.BrowserUseConnectionMode,
		preferences.MinimizeAnimation,
		preferences.ShowAppDeveloperSources,
		preferences.WindowSnappingEnabled,
		preferences.WindowSnappingShortcutPreset,
		encoded.featureFlagsJSON,
		encoded.workbenchShortcutsJSON,
		unixMs(time.Now().UTC()),
	)
}

func encodeDesktopPreferences(preferences preferencesbiz.DesktopPreferences) (encodedDesktopPreferences, error) {
	var encoded encodedDesktopPreferences
	var err error
	encoded.agentComposerDefaultsJSON, err = encodeAgentComposerDefaultsByProvider(preferences.AgentComposerDefaultsByProvider)
	if err != nil {
		return encoded, fmt.Errorf("encode desktop preferences agent composer defaults: %w", err)
	}
	encoded.agentComposerDefaultsByAgentTargetJSON, err = encodeAgentComposerDefaultsByProvider(preferences.AgentComposerDefaultsByAgentTarget)
	if err != nil {
		return encoded, fmt.Errorf("encode desktop preferences agent composer defaults by agent target: %w", err)
	}
	encoded.agentGUIConversationRailCollapsedJSON, err = encodeAgentGUIConversationRailCollapsedByProvider(preferences.AgentGUIConversationRailCollapsedByProvider)
	if err != nil {
		return encoded, fmt.Errorf("encode desktop preferences agent gui conversation rail: %w", err)
	}
	encoded.agentSessionLaunchModesJSON, err = encodeAgentSessionLaunchModesByWorkspace(preferences.AgentSessionLaunchModesByWorkspace)
	if err != nil {
		return encoded, fmt.Errorf("encode desktop preferences Agent Session launch modes: %w", err)
	}
	encoded.fileDefaultOpenersJSON, err = encodeFileDefaultOpenersByExtension(preferences.FileDefaultOpenersByExtension)
	if err != nil {
		return encoded, fmt.Errorf("encode desktop preferences file default openers: %w", err)
	}
	encoded.featureFlagsJSON, err = encodeFeatureFlags(preferences.FeatureFlags)
	if err != nil {
		return encoded, fmt.Errorf("encode desktop preferences feature flags: %w", err)
	}
	encoded.workbenchShortcutsJSON, err = encodeWorkbenchShortcuts(preferences.WorkbenchShortcuts)
	if err != nil {
		return encoded, fmt.Errorf("encode desktop preferences workbench shortcuts: %w", err)
	}
	return encoded, nil
}
