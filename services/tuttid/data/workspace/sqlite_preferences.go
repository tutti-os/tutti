package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

const desktopPreferencesRowID = "desktop"

func (s *SQLiteStore) GetDesktopPreferences(ctx context.Context) (preferencesbiz.DesktopPreferences, error) {
	if s == nil || s.writeDB == nil {
		return preferencesbiz.DesktopPreferences{}, errors.New("workspace database is not initialized")
	}

	row := s.readDB.QueryRowContext(ctx, `
SELECT default_agent_provider, agent_conversation_detail_mode, agent_dock_layout, dock_icon_style, dock_placement, locale, theme_source, sleep_prevention_mode, update_channel, update_policy, agent_composer_defaults_by_provider_json, agent_composer_defaults_by_agent_target_json, agent_gui_conversation_rail_collapsed_by_provider_json, browser_use_connection_mode, file_default_openers_by_extension_json, app_catalog_channel, minimize_animation, show_app_developer_sources, workbench_window_snapping_enabled, workbench_window_snapping_shortcut_preset, feature_flags_json, workbench_shortcuts_json
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
	var featureFlagsJSON sql.NullString
	var workbenchShortcutsJSON sql.NullString
	var themeSource string
	var sleepPreventionMode string
	var updateChannel string
	var updatePolicy string
	var agentComposerDefaultsJSON string
	var agentComposerDefaultsByAgentTargetJSON string
	var agentGUIConversationRailCollapsedJSON string
	var fileDefaultOpenersJSON string
	if err := row.Scan(&defaultAgentProvider, &agentConversationDetailMode, &agentDockLayout, &dockIconStyle, &dockPlacement, &locale, &themeSource, &sleepPreventionMode, &updateChannel, &updatePolicy, &agentComposerDefaultsJSON, &agentComposerDefaultsByAgentTargetJSON, &agentGUIConversationRailCollapsedJSON, &browserUseConnectionMode, &fileDefaultOpenersJSON, &appCatalogChannel, &minimizeAnimation, &showAppDeveloperSources, &windowSnappingEnabled, &windowSnappingShortcutPreset, &featureFlagsJSON, &workbenchShortcutsJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return preferencesbiz.DefaultDesktopPreferences(), nil
		}
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("get desktop preferences: %w", err)
	}
	agentComposerDefaults, err := decodeAgentComposerDefaultsByProvider(agentComposerDefaultsJSON)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("decode desktop preferences agent composer defaults: %w", err)
	}
	agentComposerDefaultsByAgentTarget, err := decodeAgentComposerDefaultsByProvider(agentComposerDefaultsByAgentTargetJSON)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("decode desktop preferences agent composer defaults by agent target: %w", err)
	}
	agentGUIConversationRailCollapsed, err := decodeAgentGUIConversationRailCollapsedByProvider(agentGUIConversationRailCollapsedJSON)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("decode desktop preferences agent gui conversation rail: %w", err)
	}
	fileDefaultOpeners, err := decodeFileDefaultOpenersByExtension(fileDefaultOpenersJSON)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("decode desktop preferences file default openers: %w", err)
	}
	featureFlags, err := decodeFeatureFlags(featureFlagsJSON.String)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("decode desktop preferences feature flags: %w", err)
	}
	workbenchShortcuts := decodeWorkbenchShortcuts(workbenchShortcutsJSON.String)

	return preferencesbiz.DesktopPreferences{
		AgentComposerDefaultsByProvider:             agentComposerDefaults,
		AgentComposerDefaultsByAgentTarget:          agentComposerDefaultsByAgentTarget,
		AgentGUIConversationRailCollapsedByProvider: agentGUIConversationRailCollapsed,
		AgentConversationDetailMode:                 preferencesbiz.NormalizeDesktopAgentConversationDetailMode(agentConversationDetailMode),
		AgentDockLayout:                             preferencesbiz.NormalizeDesktopAgentDockLayout(agentDockLayout),
		AppCatalogChannel:                           appCatalogChannel,
		BrowserUseConnectionMode:                    browserUseConnectionMode,
		DefaultAgentProvider:                        defaultAgentProvider,
		DockIconStyle:                               dockIconStyle,
		DockPlacement:                               dockPlacement,
		FeatureFlags:                                featureFlags,
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
		WorkbenchShortcuts:                          workbenchShortcuts,
	}, nil
}

func (s *SQLiteStore) PutDesktopPreferences(ctx context.Context, preferences preferencesbiz.DesktopPreferences) (preferencesbiz.DesktopPreferences, error) {
	if s == nil || s.writeDB == nil {
		return preferencesbiz.DesktopPreferences{}, errors.New("workspace database is not initialized")
	}

	now := unixMs(time.Now().UTC())
	agentComposerDefaultsJSON, err := encodeAgentComposerDefaultsByProvider(preferences.AgentComposerDefaultsByProvider)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("encode desktop preferences agent composer defaults: %w", err)
	}
	agentComposerDefaultsByAgentTargetJSON, err := encodeAgentComposerDefaultsByProvider(preferences.AgentComposerDefaultsByAgentTarget)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("encode desktop preferences agent composer defaults by agent target: %w", err)
	}
	agentGUIConversationRailCollapsedJSON, err := encodeAgentGUIConversationRailCollapsedByProvider(preferences.AgentGUIConversationRailCollapsedByProvider)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("encode desktop preferences agent gui conversation rail: %w", err)
	}
	fileDefaultOpenersJSON, err := encodeFileDefaultOpenersByExtension(preferences.FileDefaultOpenersByExtension)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("encode desktop preferences file default openers: %w", err)
	}
	featureFlagsJSON, err := encodeFeatureFlags(preferences.FeatureFlags)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("encode desktop preferences feature flags: %w", err)
	}
	workbenchShortcutsJSON, err := encodeWorkbenchShortcuts(preferences.WorkbenchShortcuts)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("encode desktop preferences workbench shortcuts: %w", err)
	}
	_, err = s.writeDB.ExecContext(ctx, `
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
  agent_composer_defaults_by_agent_target_json,
  agent_gui_conversation_rail_collapsed_by_provider_json,
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
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  feature_flags_json = excluded.feature_flags_json,
  workbench_shortcuts_json = excluded.workbench_shortcuts_json,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, desktopPreferencesRowID, preferences.DefaultAgentProvider, preferencesbiz.NormalizeDesktopAgentConversationDetailMode(preferences.AgentConversationDetailMode), preferencesbiz.NormalizeDesktopAgentDockLayout(preferences.AgentDockLayout), preferences.DockIconStyle, preferences.DockPlacement, preferences.Locale, preferences.ThemeSource, preferences.SleepPreventionMode, preferences.UpdateChannel, preferences.UpdatePolicy, agentComposerDefaultsJSON, agentComposerDefaultsByAgentTargetJSON, agentGUIConversationRailCollapsedJSON, fileDefaultOpenersJSON, preferences.AppCatalogChannel, preferences.BrowserUseConnectionMode, preferences.MinimizeAnimation, preferences.ShowAppDeveloperSources, preferences.WindowSnappingEnabled, preferences.WindowSnappingShortcutPreset, featureFlagsJSON, workbenchShortcutsJSON, now)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("put desktop preferences: %w", err)
	}

	// Re-read after the write because the dedicated target-defaults patch may
	// have committed between a full preferences caller's read and this update.
	// The conflict clause deliberately preserves that column, so returning the
	// input object here would publish a stale defaults snapshot.
	return s.GetDesktopPreferences(ctx)
}

func (s *SQLiteStore) PatchAgentComposerDefaultsForTarget(
	ctx context.Context,
	agentTargetID string,
	patch preferencesbiz.AgentComposerDefaultsPatch,
) (preferencesbiz.AgentComposerDefaults, error) {
	if s == nil || s.writeDB == nil {
		return preferencesbiz.AgentComposerDefaults{}, errors.New("workspace database is not initialized")
	}
	agentTargetID = strings.TrimSpace(agentTargetID)
	if agentTargetID == "" || len(patch) == 0 {
		return preferencesbiz.AgentComposerDefaults{}, errors.New("agent composer defaults patch is empty")
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("begin agent composer defaults patch: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	defaultPreferences := preferencesbiz.DefaultDesktopPreferences()
	if _, err := tx.ExecContext(ctx, `
INSERT INTO desktop_preferences (
  id, locale, theme_source, dock_icon_style, updated_at_unix_ms
)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(id) DO NOTHING
`, desktopPreferencesRowID, defaultPreferences.Locale, defaultPreferences.ThemeSource, defaultPreferences.DockIconStyle, unixMs(time.Now().UTC())); err != nil {
		return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("initialize desktop preferences for agent composer defaults patch: %w", err)
	}

	var raw string
	if err := tx.QueryRowContext(ctx, `
SELECT agent_composer_defaults_by_agent_target_json
FROM desktop_preferences
WHERE id = ?
`, desktopPreferencesRowID).Scan(&raw); err != nil {
		return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("read agent composer defaults for patch: %w", err)
	}
	defaultsByTarget, err := decodeAgentComposerDefaultsByProvider(raw)
	if err != nil {
		return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("decode agent composer defaults for patch: %w", err)
	}
	defaults := defaultsByTarget[agentTargetID]
	for field, value := range patch {
		next := ""
		if value != nil {
			next = strings.TrimSpace(*value)
		}
		switch field {
		case preferencesbiz.AgentComposerDefaultsFieldModel:
			defaults.Model = next
		case preferencesbiz.AgentComposerDefaultsFieldPermissionModeID:
			defaults.PermissionModeID = next
		case preferencesbiz.AgentComposerDefaultsFieldReasoningEffort:
			defaults.ReasoningEffort = next
		case preferencesbiz.AgentComposerDefaultsFieldSpeed:
			defaults.Speed = next
		default:
			return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("unsupported agent composer defaults field %q", field)
		}
	}
	if defaults.IsZero() {
		delete(defaultsByTarget, agentTargetID)
	} else {
		defaultsByTarget[agentTargetID] = defaults
	}
	encoded, err := encodeAgentComposerDefaultsByProvider(defaultsByTarget)
	if err != nil {
		return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("encode agent composer defaults patch: %w", err)
	}
	result, err := tx.ExecContext(ctx, `
UPDATE desktop_preferences
SET agent_composer_defaults_by_agent_target_json = ?, updated_at_unix_ms = ?
WHERE id = ?
`, encoded, unixMs(time.Now().UTC()), desktopPreferencesRowID)
	if err != nil {
		return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("write agent composer defaults patch: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("count agent composer defaults patch rows: %w", err)
	}
	if rows != 1 {
		return preferencesbiz.AgentComposerDefaults{}, errors.New("desktop preferences row is not initialized")
	}
	if err := tx.Commit(); err != nil {
		return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("commit agent composer defaults patch: %w", err)
	}
	return defaults, nil
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

func decodeFeatureFlags(raw string) (map[string]bool, error) {
	if strings.TrimSpace(raw) == "" {
		return map[string]bool{}, nil
	}
	var decoded map[string]bool
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return map[string]bool{}, nil // tolerate corrupt JSON
	}
	return preferencesbiz.NormalizeDesktopFeatureFlags(decoded), nil
}

func encodeFeatureFlags(value map[string]bool) (string, error) {
	data, err := json.Marshal(preferencesbiz.NormalizeDesktopFeatureFlags(value))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func decodeWorkbenchShortcuts(raw string) preferencesbiz.DesktopWorkbenchShortcuts {
	if strings.TrimSpace(raw) == "" {
		return preferencesbiz.DesktopWorkbenchShortcuts{}
	}
	var decoded struct {
		NewAgentConversation *string `json:"newAgentConversation"`
		NewSameTypeWindow    *string `json:"newSameTypeWindow"`
	}
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return preferencesbiz.DesktopWorkbenchShortcuts{}
	}
	deref := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	return preferencesbiz.NormalizeDesktopWorkbenchShortcuts(preferencesbiz.DesktopWorkbenchShortcuts{
		NewAgentConversation: deref(decoded.NewAgentConversation),
		NewSameTypeWindow:    deref(decoded.NewSameTypeWindow),
	})
}

func encodeWorkbenchShortcuts(value preferencesbiz.DesktopWorkbenchShortcuts) (string, error) {
	n := preferencesbiz.NormalizeDesktopWorkbenchShortcuts(value)
	ptr := func(s string) *string {
		if s == "" {
			return nil
		}
		return &s
	}
	data, err := json.Marshal(struct {
		NewAgentConversation *string `json:"newAgentConversation"`
		NewSameTypeWindow    *string `json:"newSameTypeWindow"`
	}{ptr(n.NewAgentConversation), ptr(n.NewSameTypeWindow)})
	if err != nil {
		return "", err
	}
	return string(data), nil
}
