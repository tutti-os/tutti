package preferences

import "testing"

func TestNormalizeDesktopFeatureFlagsDropsBlankKeys(t *testing.T) {
	in := map[string]bool{"lab.enabled": true, "  ": true, "": false}
	got := NormalizeDesktopFeatureFlags(in)
	if len(got) != 1 || !got["lab.enabled"] {
		t.Fatalf("got %v, want {lab.enabled:true}", got)
	}
}

func TestNormalizeDesktopShortcutBindingClampsLongValues(t *testing.T) {
	long := ""
	for i := 0; i < 90; i++ {
		long += "a"
	}
	if NormalizeDesktopShortcutBinding(long) != "" {
		t.Fatalf("want empty for >80 chars")
	}
	if NormalizeDesktopShortcutBinding("  Meta+K  ") != "Meta+K" {
		t.Fatalf("want trimmed Meta+K")
	}
}

func TestDefaultDesktopPreferencesStartsNewProfilesInAgentMode(t *testing.T) {
	d := DefaultDesktopPreferences()
	if !d.AgentCLIUpdateCheckEnabled {
		t.Fatal("want agent CLI update checks enabled by default")
	}
	if !d.FeatureFlags[DesktopStandaloneAgentModeFeatureFlag] {
		t.Fatalf("want standalone Agent mode enabled, got %v", d.FeatureFlags)
	}
	if d.UpdateChannel != "stable" {
		t.Fatalf("want stable desktop updates by default, got %q", d.UpdateChannel)
	}
}

func TestNormalizeDeletedAgentConversationRetentionDays(t *testing.T) {
	for _, test := range []struct {
		input int
		want  int
	}{{15, 15}, {30, 30}, {0, 30}, {7, 30}, {90, 30}} {
		if got := NormalizeDeletedAgentConversationRetentionDays(test.input); got != test.want {
			t.Fatalf("NormalizeDeletedAgentConversationRetentionDays(%d) = %d, want %d", test.input, got, test.want)
		}
	}
}
