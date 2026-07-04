package workspace

import (
	"context"
	"testing"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

func TestSQLiteStoreGetDesktopPreferencesDefaultsWhenUnset(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)

	preferences, err := store.GetDesktopPreferences(context.Background())
	if err != nil {
		t.Fatalf("GetDesktopPreferences() error = %v", err)
	}
	if preferences.Initialized {
		t.Fatal("GetDesktopPreferences() initialized = true, want false")
	}
	if preferences.Locale != "en" {
		t.Fatalf("GetDesktopPreferences() locale = %q, want en", preferences.Locale)
	}
	if preferences.DockPlacement != "bottom" {
		t.Fatalf("GetDesktopPreferences() dockPlacement = %q, want bottom", preferences.DockPlacement)
	}
	if preferences.DockIconStyle != "default" {
		t.Fatalf("GetDesktopPreferences() dockIconStyle = %q, want default", preferences.DockIconStyle)
	}
	if preferences.DefaultAgentProvider != "codex" {
		t.Fatalf("GetDesktopPreferences() defaultAgentProvider = %q, want codex", preferences.DefaultAgentProvider)
	}
	if preferences.AgentConversationDetailMode != "coding" {
		t.Fatalf("GetDesktopPreferences() agentConversationDetailMode = %q, want coding", preferences.AgentConversationDetailMode)
	}
	if preferences.AgentDockLayout != "legacySplit" {
		t.Fatalf("GetDesktopPreferences() agentDockLayout = %q, want legacySplit", preferences.AgentDockLayout)
	}
	if preferences.ThemeSource != "dark" {
		t.Fatalf("GetDesktopPreferences() themeSource = %q, want dark", preferences.ThemeSource)
	}
	if preferences.SleepPreventionMode != "never" {
		t.Fatalf("GetDesktopPreferences() sleepPreventionMode = %q, want never", preferences.SleepPreventionMode)
	}
	if preferences.BrowserUseConnectionMode != "isolated" {
		t.Fatalf("GetDesktopPreferences() browserUseConnectionMode = %q, want isolated", preferences.BrowserUseConnectionMode)
	}
	if preferences.AppCatalogChannel != "production" {
		t.Fatalf("GetDesktopPreferences() appCatalogChannel = %q, want production", preferences.AppCatalogChannel)
	}
	if preferences.FileDefaultOpenersByExtension["html"] != "appBrowser" {
		t.Fatalf("GetDesktopPreferences() html opener = %q, want appBrowser", preferences.FileDefaultOpenersByExtension["html"])
	}
	if len(preferences.AgentGUIConversationRailCollapsedByProvider) != 0 {
		t.Fatalf("GetDesktopPreferences() rail collapsed preferences = %#v, want empty", preferences.AgentGUIConversationRailCollapsedByProvider)
	}
	if preferences.UpdatePolicy != "prompt" {
		t.Fatalf("GetDesktopPreferences() updatePolicy = %q, want prompt", preferences.UpdatePolicy)
	}
	if preferences.UpdateChannel != "rc" {
		t.Fatalf("GetDesktopPreferences() updateChannel = %q, want rc", preferences.UpdateChannel)
	}
}

func TestSQLiteStorePutDesktopPreferencesPersistsValue(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	saved, err := store.PutDesktopPreferences(ctx, preferencesbiz.DesktopPreferences{
		AgentComposerDefaultsByProvider: map[string]preferencesbiz.AgentComposerDefaults{
			"codex": {
				Model:            "gpt-5",
				PermissionModeID: "full-access",
				ReasoningEffort:  "high",
			},
		},
		AgentGUIConversationRailCollapsedByProvider: map[string]bool{
			"codex":       true,
			"claude-code": false,
		},
		AgentConversationDetailMode: "general",
		AgentDockLayout:             "unified",
		DefaultAgentProvider:        "claude-code",

		BrowserUseConnectionMode: "autoConnect",
		AppCatalogChannel:        "staging",
		DockIconStyle:            "default",
		DockPlacement:            "left",
		FileDefaultOpenersByExtension: map[string]string{
			"html": "fileViewer",
			"pdf":  "defaultBrowser",
		},
		Initialized:         true,
		Locale:              "zh-CN",
		MinimizeAnimation:   "scale",
		SleepPreventionMode: "whileAgentRunning",
		ThemeSource:         "dark",
		UpdateChannel:       "rc",
		UpdatePolicy:        "auto",
	})
	if err != nil {
		t.Fatalf("PutDesktopPreferences() error = %v", err)
	}
	if !saved.Initialized {
		t.Fatal("PutDesktopPreferences() initialized = false, want true")
	}

	reloaded, err := store.GetDesktopPreferences(ctx)
	if err != nil {
		t.Fatalf("GetDesktopPreferences() error = %v", err)
	}
	if !reloaded.Initialized {
		t.Fatal("GetDesktopPreferences() initialized = false, want true")
	}
	if reloaded.Locale != "zh-CN" {
		t.Fatalf("GetDesktopPreferences() locale = %q, want zh-CN", reloaded.Locale)
	}
	if reloaded.DockPlacement != "left" {
		t.Fatalf("GetDesktopPreferences() dockPlacement = %q, want left", reloaded.DockPlacement)
	}
	if reloaded.DefaultAgentProvider != "claude-code" {
		t.Fatalf("GetDesktopPreferences() defaultAgentProvider = %q, want claude-code", reloaded.DefaultAgentProvider)
	}
	if reloaded.AgentConversationDetailMode != "general" {
		t.Fatalf("GetDesktopPreferences() agentConversationDetailMode = %q, want general", reloaded.AgentConversationDetailMode)
	}
	if reloaded.AgentDockLayout != "unified" {
		t.Fatalf("GetDesktopPreferences() agentDockLayout = %q, want unified", reloaded.AgentDockLayout)
	}
	if reloaded.ThemeSource != "dark" {
		t.Fatalf("GetDesktopPreferences() themeSource = %q, want dark", reloaded.ThemeSource)
	}
	if reloaded.SleepPreventionMode != "whileAgentRunning" {
		t.Fatalf("GetDesktopPreferences() sleepPreventionMode = %q, want whileAgentRunning", reloaded.SleepPreventionMode)
	}
	if reloaded.BrowserUseConnectionMode != "autoConnect" {
		t.Fatalf("GetDesktopPreferences() browserUseConnectionMode = %q, want autoConnect", reloaded.BrowserUseConnectionMode)
	}
	if reloaded.AppCatalogChannel != "staging" {
		t.Fatalf("GetDesktopPreferences() appCatalogChannel = %q, want staging", reloaded.AppCatalogChannel)
	}
	if reloaded.FileDefaultOpenersByExtension["html"] != "fileViewer" || reloaded.FileDefaultOpenersByExtension["pdf"] != "defaultBrowser" {
		t.Fatalf("GetDesktopPreferences() file default openers = %#v, want html/pdf", reloaded.FileDefaultOpenersByExtension)
	}
	if !reloaded.AgentGUIConversationRailCollapsedByProvider["codex"] {
		t.Fatalf("GetDesktopPreferences() codex rail collapsed = false, want true")
	}
	if collapsed, ok := reloaded.AgentGUIConversationRailCollapsedByProvider["claude-code"]; !ok || collapsed {
		t.Fatalf("GetDesktopPreferences() claude rail collapsed = %v/%v, want present false", collapsed, ok)
	}
	if reloaded.UpdatePolicy != "auto" {
		t.Fatalf("GetDesktopPreferences() updatePolicy = %q, want auto", reloaded.UpdatePolicy)
	}
	if reloaded.UpdateChannel != "rc" {
		t.Fatalf("GetDesktopPreferences() updateChannel = %q, want rc", reloaded.UpdateChannel)
	}
	codexDefaults := reloaded.AgentComposerDefaultsByProvider["codex"]
	if codexDefaults.Model != "gpt-5" ||
		codexDefaults.PermissionModeID != "full-access" ||
		codexDefaults.ReasoningEffort != "high" {
		t.Fatalf("GetDesktopPreferences() codex composer defaults = %#v, want gpt-5/full-access/high", codexDefaults)
	}
}

func TestSQLiteStoreDesktopPreferencesAgentConversationDetailModeMigrationAndNormalize(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	hasAgentConversationDetailMode, err := store.hasColumn(ctx, "desktop_preferences", "agent_conversation_detail_mode")
	if err != nil {
		t.Fatalf("hasColumn() error = %v", err)
	}
	if !hasAgentConversationDetailMode {
		t.Fatal("desktop_preferences.agent_conversation_detail_mode column missing after migration")
	}

	_, err = store.db.ExecContext(ctx, `
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
) VALUES (
  'desktop',
  'codex',
  'daily',
  'sideBySide',
  'default',
  'bottom',
  'en',
  'dark',
  'never',
  'rc',
  'prompt',
  '{}',
  '{}',
  '{}',
  'production',
  'isolated',
  'scale',
  0,
  0,
  'commandArrows',
  1
)`)
	if err != nil {
		t.Fatalf("insert desktop preferences with invalid conversation detail mode: %v", err)
	}

	preferences, err := store.GetDesktopPreferences(ctx)
	if err != nil {
		t.Fatalf("GetDesktopPreferences() error = %v", err)
	}
	if preferences.AgentConversationDetailMode != "coding" {
		t.Fatalf("GetDesktopPreferences() agentConversationDetailMode = %q, want coding", preferences.AgentConversationDetailMode)
	}
	if preferences.AgentDockLayout != "legacySplit" {
		t.Fatalf("GetDesktopPreferences() agentDockLayout = %q, want legacySplit", preferences.AgentDockLayout)
	}
}
