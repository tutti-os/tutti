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

func TestDefaultDesktopPreferencesHasEmptyFlags(t *testing.T) {
	d := DefaultDesktopPreferences()
	if len(d.FeatureFlags) != 0 {
		t.Fatalf("want empty flags, got %v", d.FeatureFlags)
	}
}
