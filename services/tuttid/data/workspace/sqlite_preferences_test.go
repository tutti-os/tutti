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
	if preferences.ThemeSource != "dark" {
		t.Fatalf("GetDesktopPreferences() themeSource = %q, want dark", preferences.ThemeSource)
	}
	if preferences.SleepPreventionMode != "never" {
		t.Fatalf("GetDesktopPreferences() sleepPreventionMode = %q, want never", preferences.SleepPreventionMode)
	}
	if preferences.BrowserUseConnectionMode != "isolated" {
		t.Fatalf("GetDesktopPreferences() browserUseConnectionMode = %q, want isolated", preferences.BrowserUseConnectionMode)
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
		DefaultAgentProvider: "claude-code",

		BrowserUseConnectionMode: "autoConnect",
		DockIconStyle:            "default",
		DockPlacement:            "left",
		Initialized:              true,
		Locale:                   "zh-CN",
		SleepPreventionMode:      "whileAgentRunning",
		ThemeSource:              "dark",
		UpdateChannel:            "rc",
		UpdatePolicy:             "auto",
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
	if reloaded.ThemeSource != "dark" {
		t.Fatalf("GetDesktopPreferences() themeSource = %q, want dark", reloaded.ThemeSource)
	}
	if reloaded.SleepPreventionMode != "whileAgentRunning" {
		t.Fatalf("GetDesktopPreferences() sleepPreventionMode = %q, want whileAgentRunning", reloaded.SleepPreventionMode)
	}
	if reloaded.BrowserUseConnectionMode != "autoConnect" {
		t.Fatalf("GetDesktopPreferences() browserUseConnectionMode = %q, want autoConnect", reloaded.BrowserUseConnectionMode)
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
