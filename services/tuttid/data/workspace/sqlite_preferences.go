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
SELECT agent_cli_update_check_enabled, default_agent_provider, agent_conversation_detail_mode, agent_dock_layout, dock_icon_style, dock_placement, deleted_agent_conversation_retention_days, locale, theme_source, sleep_prevention_mode, update_channel, update_policy, agent_composer_defaults_by_provider_json, agent_composer_defaults_by_agent_target_json, agent_gui_conversation_rail_collapsed_by_provider_json, agent_session_launch_modes_by_workspace_json, browser_use_connection_mode, file_default_openers_by_extension_json, app_catalog_channel, minimize_animation, show_app_developer_sources, workbench_window_snapping_enabled, workbench_window_snapping_shortcut_preset, feature_flags_json, workbench_shortcuts_json
FROM desktop_preferences
WHERE id = ?
`, desktopPreferencesRowID)

	var agentCLIUpdateCheckEnabled bool
	var defaultAgentProvider string
	var agentConversationDetailMode string
	var agentDockLayout string
	var appCatalogChannel string
	var browserUseConnectionMode string
	var dockIconStyle string
	var dockPlacement string
	var deletedAgentConversationRetentionDays int
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
	var agentSessionLaunchModesJSON string
	var fileDefaultOpenersJSON string
	if err := row.Scan(&agentCLIUpdateCheckEnabled, &defaultAgentProvider, &agentConversationDetailMode, &agentDockLayout, &dockIconStyle, &dockPlacement, &deletedAgentConversationRetentionDays, &locale, &themeSource, &sleepPreventionMode, &updateChannel, &updatePolicy, &agentComposerDefaultsJSON, &agentComposerDefaultsByAgentTargetJSON, &agentGUIConversationRailCollapsedJSON, &agentSessionLaunchModesJSON, &browserUseConnectionMode, &fileDefaultOpenersJSON, &appCatalogChannel, &minimizeAnimation, &showAppDeveloperSources, &windowSnappingEnabled, &windowSnappingShortcutPreset, &featureFlagsJSON, &workbenchShortcutsJSON); err != nil {
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
	agentSessionLaunchModes, err := decodeAgentSessionLaunchModesByWorkspace(agentSessionLaunchModesJSON)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("decode desktop preferences Agent Session launch modes: %w", err)
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
		AgentCLIUpdateCheckEnabled:                  agentCLIUpdateCheckEnabled,
		AgentComposerDefaultsByProvider:             agentComposerDefaults,
		AgentComposerDefaultsByAgentTarget:          agentComposerDefaultsByAgentTarget,
		AgentGUIConversationRailCollapsedByProvider: agentGUIConversationRailCollapsed,
		AgentSessionLaunchModesByWorkspace:          agentSessionLaunchModes,
		AgentConversationDetailMode:                 preferencesbiz.NormalizeDesktopAgentConversationDetailMode(agentConversationDetailMode),
		AgentDockLayout:                             preferencesbiz.NormalizeDesktopAgentDockLayout(agentDockLayout),
		AppCatalogChannel:                           appCatalogChannel,
		BrowserUseConnectionMode:                    browserUseConnectionMode,
		DefaultAgentProvider:                        defaultAgentProvider,
		DockIconStyle:                               dockIconStyle,
		DockPlacement:                               dockPlacement,
		DeletedAgentConversationRetentionDays:       preferencesbiz.NormalizeDeletedAgentConversationRetentionDays(deletedAgentConversationRetentionDays),
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

	var raw string
	if err := tx.QueryRowContext(ctx, `
SELECT agent_composer_defaults_by_agent_target_json
FROM desktop_preferences
WHERE id = ?
`, desktopPreferencesRowID).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("read agent composer defaults for patch: %w", ErrDesktopPreferencesNotInitialized)
		}
		return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("read agent composer defaults for patch: %w", err)
	}
	defaultsByTarget, err := decodeAgentComposerDefaultsByProvider(raw)
	if err != nil {
		return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("decode agent composer defaults for patch: %w", err)
	}
	defaults := defaultsByTarget[agentTargetID]
	for field, value := range patch {
		switch field {
		case preferencesbiz.AgentComposerDefaultsFieldCodexSaverMode:
			next, ok := value.(bool)
			if !ok {
				return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("agent composer defaults field %q must be boolean", field)
			}
			defaults.CodexSaverMode = next
		case preferencesbiz.AgentComposerDefaultsFieldModel:
			defaults.Model, err = agentComposerDefaultsTextPatchValue(value)
		case preferencesbiz.AgentComposerDefaultsFieldPermissionModeID:
			defaults.PermissionModeID, err = agentComposerDefaultsTextPatchValue(value)
		case preferencesbiz.AgentComposerDefaultsFieldReasoningEffort:
			defaults.ReasoningEffort, err = agentComposerDefaultsTextPatchValue(value)
		case preferencesbiz.AgentComposerDefaultsFieldSpeed:
			defaults.Speed, err = agentComposerDefaultsTextPatchValue(value)
		default:
			return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("unsupported agent composer defaults field %q", field)
		}
		if err != nil {
			return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("agent composer defaults field %q: %w", field, err)
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
		return preferencesbiz.AgentComposerDefaults{}, ErrDesktopPreferencesNotInitialized
	}
	if err := tx.Commit(); err != nil {
		return preferencesbiz.AgentComposerDefaults{}, fmt.Errorf("commit agent composer defaults patch: %w", err)
	}
	return defaults, nil
}

func (s *SQLiteStore) PatchAgentSessionLaunchMode(
	ctx context.Context,
	workspaceID string,
	projectSectionKey string,
	mode string,
) (preferencesbiz.DesktopPreferences, error) {
	if s == nil || s.writeDB == nil {
		return preferencesbiz.DesktopPreferences{}, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	projectSectionKey = strings.TrimSpace(projectSectionKey)
	mode = strings.TrimSpace(mode)
	if workspaceID == "" || projectSectionKey == "" || (mode != "local" && mode != "worktree") {
		return preferencesbiz.DesktopPreferences{}, errors.New("agent session launch mode patch is invalid")
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("begin agent session launch mode patch: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var raw string
	if err := tx.QueryRowContext(ctx, `
SELECT agent_session_launch_modes_by_workspace_json
FROM desktop_preferences
WHERE id = ?
`, desktopPreferencesRowID).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return preferencesbiz.DesktopPreferences{}, fmt.Errorf("read agent session launch modes for patch: %w", ErrDesktopPreferencesNotInitialized)
		}
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("read agent session launch modes for patch: %w", err)
	}
	modesByWorkspace, err := decodeAgentSessionLaunchModesByWorkspace(raw)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("decode agent session launch modes for patch: %w", err)
	}
	if modesByWorkspace == nil {
		modesByWorkspace = map[string]map[string]string{}
	}
	modesByProject := modesByWorkspace[workspaceID]
	if modesByProject == nil {
		modesByProject = map[string]string{}
	}
	modesByProject[projectSectionKey] = mode
	modesByWorkspace[workspaceID] = modesByProject
	encoded, err := encodeAgentSessionLaunchModesByWorkspace(modesByWorkspace)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("encode agent session launch modes patch: %w", err)
	}
	result, err := tx.ExecContext(ctx, `
UPDATE desktop_preferences
SET agent_session_launch_modes_by_workspace_json = ?, updated_at_unix_ms = ?
WHERE id = ?
`, encoded, unixMs(time.Now().UTC()), desktopPreferencesRowID)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("write agent session launch mode patch: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("count agent session launch mode patch rows: %w", err)
	}
	if rows != 1 {
		return preferencesbiz.DesktopPreferences{}, ErrDesktopPreferencesNotInitialized
	}
	if err := tx.Commit(); err != nil {
		return preferencesbiz.DesktopPreferences{}, fmt.Errorf("commit agent session launch mode patch: %w", err)
	}
	return s.GetDesktopPreferences(ctx)
}

func agentComposerDefaultsTextPatchValue(value any) (string, error) {
	if value == nil {
		return "", nil
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed), nil
	case *string:
		if typed != nil {
			return strings.TrimSpace(*typed), nil
		}
		return "", nil
	}
	return "", fmt.Errorf("must be a string or null")
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

func decodeAgentSessionLaunchModesByWorkspace(raw string) (map[string]map[string]string, error) {
	if raw == "" {
		return map[string]map[string]string{}, nil
	}
	var decoded map[string]map[string]string
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, err
	}
	if decoded == nil {
		return map[string]map[string]string{}, nil
	}
	return decoded, nil
}

func encodeAgentSessionLaunchModesByWorkspace(value map[string]map[string]string) (string, error) {
	if value == nil {
		value = map[string]map[string]string{}
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
		CaptureScreenshot    *string `json:"captureScreenshot"`
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
		CaptureScreenshot:    deref(decoded.CaptureScreenshot),
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
		CaptureScreenshot    *string `json:"captureScreenshot,omitempty"`
	}{ptr(n.NewAgentConversation), ptr(n.NewSameTypeWindow), ptr(n.CaptureScreenshot)})
	if err != nil {
		return "", err
	}
	return string(data), nil
}
