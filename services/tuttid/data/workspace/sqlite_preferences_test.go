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
	if preferences.AgentDockLayout != "unified" {
		t.Fatalf("GetDesktopPreferences() agentDockLayout = %q, want unified", preferences.AgentDockLayout)
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
	if preferences.AgentDockLayout != "unified" {
		t.Fatalf("GetDesktopPreferences() agentDockLayout = %q, want unified", preferences.AgentDockLayout)
	}
}

func TestSQLiteStorePutDesktopPreferencesPersistsAgentComposerDefaultsByAgentTarget(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)

	input := preferencesbiz.DefaultDesktopPreferences()
	input.AgentComposerDefaultsByProvider = map[string]preferencesbiz.AgentComposerDefaults{
		"codex": {Model: "gpt-5"},
	}
	input.AgentComposerDefaultsByAgentTarget = map[string]preferencesbiz.AgentComposerDefaults{
		"local:codex": {
			Model:            "gpt-5-codex",
			PermissionModeID: "full-access",
			ReasoningEffort:  "high",
			Speed:            "fast",
		},
	}
	if _, err := store.PutDesktopPreferences(context.Background(), input); err != nil {
		t.Fatalf("PutDesktopPreferences() error = %v", err)
	}

	preferences, err := store.GetDesktopPreferences(context.Background())
	if err != nil {
		t.Fatalf("GetDesktopPreferences() error = %v", err)
	}
	codexDefaults := preferences.AgentComposerDefaultsByAgentTarget["local:codex"]
	if codexDefaults.Model != "gpt-5-codex" ||
		codexDefaults.PermissionModeID != "full-access" ||
		codexDefaults.ReasoningEffort != "high" ||
		codexDefaults.Speed != "fast" {
		t.Fatalf("agent target defaults = %#v, want persisted round-trip", codexDefaults)
	}
	if preferences.AgentComposerDefaultsByProvider["codex"].Model != "gpt-5" {
		t.Fatalf("legacy provider defaults = %#v, want preserved", preferences.AgentComposerDefaultsByProvider)
	}
}

func TestSQLiteStoreMigrationBackfillsAgentComposerDefaultsByAgentTarget(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)

	// Simulate a pre-migration database: legacy provider-keyed defaults
	// exist, the agent-target column is empty, and the data migration marker
	// is absent.
	legacy := preferencesbiz.DefaultDesktopPreferences()
	legacy.AgentComposerDefaultsByProvider = map[string]preferencesbiz.AgentComposerDefaults{
		"codex":  {Model: "gpt-5", PermissionModeID: "full-access"},
		"gemini": {Model: "gemini-pro"},
	}
	if _, err := store.PutDesktopPreferences(context.Background(), legacy); err != nil {
		t.Fatalf("PutDesktopPreferences() error = %v", err)
	}
	if _, err := store.db.ExecContext(context.Background(), `
DELETE FROM tuttid_schema_migrations WHERE id = ?
`, schemaMigrationDesktopPreferencesAgentComposerDefaultsByAgentTargetV1); err != nil {
		t.Fatalf("reset migration marker: %v", err)
	}

	if err := store.applyDesktopPreferencesAgentComposerDefaultsByAgentTargetV1(context.Background()); err != nil {
		t.Fatalf("applyDesktopPreferencesAgentComposerDefaultsByAgentTargetV1() error = %v", err)
	}

	preferences, err := store.GetDesktopPreferences(context.Background())
	if err != nil {
		t.Fatalf("GetDesktopPreferences() error = %v", err)
	}
	codexDefaults := preferences.AgentComposerDefaultsByAgentTarget["local:codex"]
	if codexDefaults.Model != "gpt-5" || codexDefaults.PermissionModeID != "full-access" {
		t.Fatalf("backfilled codex defaults = %#v, want legacy values", codexDefaults)
	}
	geminiDefaults := preferences.AgentComposerDefaultsByAgentTarget["local:gemini"]
	if geminiDefaults.Model != "gemini-pro" {
		t.Fatalf("backfilled gemini defaults = %#v, want legacy values", geminiDefaults)
	}

	// Re-running the backfill must not clobber newer agent-target data.
	updated := preferences
	updated.AgentComposerDefaultsByAgentTarget = map[string]preferencesbiz.AgentComposerDefaults{
		"local:codex": {Model: "gpt-5-codex"},
	}
	if _, err := store.PutDesktopPreferences(context.Background(), updated); err != nil {
		t.Fatalf("PutDesktopPreferences() error = %v", err)
	}
	if err := store.backfillAgentComposerDefaultsByAgentTarget(context.Background()); err != nil {
		t.Fatalf("backfillAgentComposerDefaultsByAgentTarget() error = %v", err)
	}
	preferences, err = store.GetDesktopPreferences(context.Background())
	if err != nil {
		t.Fatalf("GetDesktopPreferences() error = %v", err)
	}
	if preferences.AgentComposerDefaultsByAgentTarget["local:codex"].Model != "gpt-5-codex" {
		t.Fatalf("agent target defaults = %#v, want newer data preserved", preferences.AgentComposerDefaultsByAgentTarget)
	}
}

func TestDesktopPreferencesFeatureFlagsRoundtrip(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	in := preferencesbiz.DefaultDesktopPreferences()
	in.FeatureFlags = map[string]bool{"lab.enabled": true, "lab.workbenchShortcuts": true}
	in.WorkbenchShortcuts = preferencesbiz.DesktopWorkbenchShortcuts{NewAgentConversation: "Meta+K"}
	if _, err := store.PutDesktopPreferences(ctx, in); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetDesktopPreferences(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !got.FeatureFlags["lab.enabled"] || !got.FeatureFlags["lab.workbenchShortcuts"] {
		t.Fatalf("flags not persisted: %v", got.FeatureFlags)
	}
	if got.WorkbenchShortcuts.NewAgentConversation != "Meta+K" || got.WorkbenchShortcuts.NewSameTypeWindow != "" {
		t.Fatalf("shortcuts wrong: %+v", got.WorkbenchShortcuts)
	}
}
