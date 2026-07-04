package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

const desktopPreferencesRowID = "desktop"

func (s *SQLiteStore) GetDesktopPreferences(ctx context.Context) (preferencesbiz.DesktopPreferences, error) {
	if s == nil || s.db == nil {
		return preferencesbiz.DesktopPreferences{}, errors.New("workspace database is not initialized")
	}

	row := s.db.QueryRowContext(ctx, `
SELECT default_agent_provider, agent_conversation_detail_mode, agent_dock_layout, dock_icon_style, dock_placement, locale, theme_source, sleep_prevention_mode, update_channel, update_policy, agent_composer_defaults_by_provider_json, agent_gui_conversation_rail_collapsed_by_provider_json, browser_use_connection_mode, file_default_openers_by_extension_json, app_catalog_channel, minimize_animation, show_app_developer_sources, workbench_window_snapping_enabled, workbench_window_snapping_shortcut_preset
FROM desktop_preferences
WHERE id = ?
`, desktopPreferencesRowID)

	var defaultAgentProvider string
	var agentConversationDetailMode string
	var agentDockLayout string
	var appCatalogChannel string
	var browserUseConnectionMode string
	var dockIconStyle string
	var dockPlacement string
	var locale string
	var minimizeAnimation string
	var showAppDeveloperSources bool
	var windowSnappingEnabled bool
	var windowSnappingShortcutPreset string
	var themeSource string
	var sleepPreventionMode string
	var updateChannel string
	var updatePolicy string
	var agentComposerDefaultsJSON string
	var agentGUIConversationRailCollapsedJSON string
	var fileDefaultOpenersJSON string
	if err := row.Scan(&defaultAgentProvider, &agentConversationDetailMode, &agentDockLayout, &dockIconStyle, &dockPlacement, &locale, &themeSource, &sleepPreventionMode, &updateChannel, &updatePolicy, &agentComposerDefaultsJSON, &agentGUIConversationRailCollapsedJSON, &browserUseConnectionMode, &fileDefaultOpenersJSON, &appCatalogChannel, &minimizeAnimation, &showAppDeveloperSources, &windowSnappingEnabled, &windowSnappingShortcutPreset); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return preferencesbiz.DefaultDesktopPreferences(), nil
		}
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("get desktop preferences: %w", err)
	}
	agentComposerDefaults, err := decodeAgentComposerDefaultsByProvider(agentComposerDefaultsJSON)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("decode desktop preferences agent composer defaults: %w", err)
	}
	agentGUIConversationRailCollapsed, err := decodeAgentGUIConversationRailCollapsedByProvider(agentGUIConversationRailCollapsedJSON)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("decode desktop preferences agent gui conversation rail: %w", err)
	}
	fileDefaultOpeners, err := decodeFileDefaultOpenersByExtension(fileDefaultOpenersJSON)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("decode desktop preferences file default openers: %w", err)
	}

	return preferencesbiz.DesktopPreferences{
		AgentComposerDefaultsByProvider:             agentComposerDefaults,
		AgentGUIConversationRailCollapsedByProvider: agentGUIConversationRailCollapsed,
		AgentConversationDetailMode:                 preferencesbiz.NormalizeDesktopAgentConversationDetailMode(agentConversationDetailMode),
		AgentDockLayout:                             preferencesbiz.NormalizeDesktopAgentDockLayout(agentDockLayout),
		AppCatalogChannel:                           appCatalogChannel,
		BrowserUseConnectionMode:                    browserUseConnectionMode,
		DefaultAgentProvider:                        defaultAgentProvider,
		DockIconStyle:                               dockIconStyle,
		DockPlacement:                               dockPlacement,
		FileDefaultOpenersByExtension:               fileDefaultOpeners,
		Initialized:                                 true,
		Locale:                                      locale,
		MinimizeAnimation:                           minimizeAnimation,
		SleepPreventionMode:                         sleepPreventionMode,
		ShowAppDeveloperSources:                     showAppDeveloperSources,
		ThemeSource:                                 themeSource,
		UpdateChannel:                               updateChannel,
		UpdatePolicy:                                updatePolicy,
		WindowSnappingEnabled:                       windowSnappingEnabled,
		WindowSnappingShortcutPreset:                windowSnappingShortcutPreset,
	}, nil
}

func (s *SQLiteStore) PutDesktopPreferences(ctx context.Context, preferences preferencesbiz.DesktopPreferences) (preferencesbiz.DesktopPreferences, error) {
	if s == nil || s.db == nil {
		return preferencesbiz.DesktopPreferences{}, errors.New("workspace database is not initialized")
	}

	now := unixMs(time.Now().UTC())
	agentComposerDefaultsJSON, err := encodeAgentComposerDefaultsByProvider(preferences.AgentComposerDefaultsByProvider)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("encode desktop preferences agent composer defaults: %w", err)
	}
	agentGUIConversationRailCollapsedJSON, err := encodeAgentGUIConversationRailCollapsedByProvider(preferences.AgentGUIConversationRailCollapsedByProvider)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("encode desktop preferences agent gui conversation rail: %w", err)
	}
	fileDefaultOpenersJSON, err := encodeFileDefaultOpenersByExtension(preferences.FileDefaultOpenersByExtension)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("encode desktop preferences file default openers: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO desktop_preferences (
  id,
  default_agent_provider,
  agent_conversation_detail_mode,
  agent_dock_layout,
  dock_icon_style,
  dock_placement,
  locale,
  theme_source,
  sleep_prevention_mode,
  update_channel,
  update_policy,
  agent_composer_defaults_by_provider_json,
  agent_gui_conversation_rail_collapsed_by_provider_json,
  file_default_openers_by_extension_json,
  app_catalog_channel,
  browser_use_connection_mode,
  minimize_animation,
  show_app_developer_sources,
  workbench_window_snapping_enabled,
  workbench_window_snapping_shortcut_preset,
  updated_at_unix_ms
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  default_agent_provider = excluded.default_agent_provider,
  agent_conversation_detail_mode = excluded.agent_conversation_detail_mode,
  agent_dock_layout = excluded.agent_dock_layout,
  dock_icon_style = excluded.dock_icon_style,
  dock_placement = excluded.dock_placement,
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
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, desktopPreferencesRowID, preferences.DefaultAgentProvider, preferencesbiz.NormalizeDesktopAgentConversationDetailMode(preferences.AgentConversationDetailMode), preferencesbiz.NormalizeDesktopAgentDockLayout(preferences.AgentDockLayout), preferences.DockIconStyle, preferences.DockPlacement, preferences.Locale, preferences.ThemeSource, preferences.SleepPreventionMode, preferences.UpdateChannel, preferences.UpdatePolicy, agentComposerDefaultsJSON, agentGUIConversationRailCollapsedJSON, fileDefaultOpenersJSON, preferences.AppCatalogChannel, preferences.BrowserUseConnectionMode, preferences.MinimizeAnimation, preferences.ShowAppDeveloperSources, preferences.WindowSnappingEnabled, preferences.WindowSnappingShortcutPreset, now)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("put desktop preferences: %w", err)
	}

	return preferencesbiz.DesktopPreferences{
		AgentComposerDefaultsByProvider:             preferences.AgentComposerDefaultsByProvider,
		AgentGUIConversationRailCollapsedByProvider: preferences.AgentGUIConversationRailCollapsedByProvider,
		AgentConversationDetailMode:                 preferencesbiz.NormalizeDesktopAgentConversationDetailMode(preferences.AgentConversationDetailMode),
		AgentDockLayout:                             preferencesbiz.NormalizeDesktopAgentDockLayout(preferences.AgentDockLayout),
		AppCatalogChannel:                           preferences.AppCatalogChannel,
		BrowserUseConnectionMode:                    preferences.BrowserUseConnectionMode,
		DefaultAgentProvider:                        preferences.DefaultAgentProvider,
		DockIconStyle:                               preferences.DockIconStyle,
		DockPlacement:                               preferences.DockPlacement,
		FileDefaultOpenersByExtension:               preferences.FileDefaultOpenersByExtension,
		Initialized:                                 true,
		Locale:                                      preferences.Locale,
		MinimizeAnimation:                           preferences.MinimizeAnimation,
		SleepPreventionMode:                         preferences.SleepPreventionMode,
		ShowAppDeveloperSources:                     preferences.ShowAppDeveloperSources,
		ThemeSource:                                 preferences.ThemeSource,
		UpdateChannel:                               preferences.UpdateChannel,
		UpdatePolicy:                                preferences.UpdatePolicy,
		WindowSnappingEnabled:                       preferences.WindowSnappingEnabled,
		WindowSnappingShortcutPreset:                preferences.WindowSnappingShortcutPreset,
	}, nil
}

func decodeFileDefaultOpenersByExtension(raw string) (map[string]string, error) {
	if raw == "" {
		return preferencesbiz.DefaultDesktopPreferences().FileDefaultOpenersByExtension, nil
	}
	var decoded map[string]string
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, err
	}
	if decoded == nil {
		return preferencesbiz.DefaultDesktopPreferences().FileDefaultOpenersByExtension, nil
	}
	return decoded, nil
}

func encodeFileDefaultOpenersByExtension(value map[string]string) (string, error) {
	if value == nil {
		value = preferencesbiz.DefaultDesktopPreferences().FileDefaultOpenersByExtension
	}
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func decodeAgentGUIConversationRailCollapsedByProvider(raw string) (map[string]bool, error) {
	if raw == "" {
		return map[string]bool{}, nil
	}
	var decoded map[string]bool
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, err
	}
	if decoded == nil {
		return map[string]bool{}, nil
	}
	return decoded, nil
}

func encodeAgentGUIConversationRailCollapsedByProvider(value map[string]bool) (string, error) {
	if value == nil {
		value = map[string]bool{}
	}
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func decodeAgentComposerDefaultsByProvider(raw string) (map[string]preferencesbiz.AgentComposerDefaults, error) {
	if raw == "" {
		return map[string]preferencesbiz.AgentComposerDefaults{}, nil
	}
	var decoded map[string]preferencesbiz.AgentComposerDefaults
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, err
	}
	if decoded == nil {
		return map[string]preferencesbiz.AgentComposerDefaults{}, nil
	}
	return decoded, nil
}

func encodeAgentComposerDefaultsByProvider(value map[string]preferencesbiz.AgentComposerDefaults) (string, error) {
	if value == nil {
		value = map[string]preferencesbiz.AgentComposerDefaults{}
	}
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(data), nil
}
