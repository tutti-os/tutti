package sessionreplay

import "testing"

func TestComposerSettingsEqualIgnoresLiveOnlyDefaults(t *testing.T) {
	expected := map[string]any{
		"codexSaverMode":   false,
		"model":            "haiku",
		"permissionModeId": "default",
		"planMode":         false,
		"reasoningEffort":  "high",
	}
	actual := map[string]any{
		"codexSaverMode":   false,
		"futureDefaultOff": false,
		"model":            "haiku",
		"permissionModeId": "default",
		"planMode":         false,
		"reasoningEffort":  "high",
		"speed":            "standard",
	}
	if !composerSettingsEqual(actual, expected) {
		t.Fatal("live-only defaults must not fail settings.equal")
	}
	actual["reasoningEffort"] = "medium"
	if composerSettingsEqual(actual, expected) {
		t.Fatal("mismatched reasoningEffort must fail settings.equal")
	}
}

func TestComposerSettingsEqualAllowsDefaultsWhenRecordingHasNoSettings(t *testing.T) {
	actual := map[string]any{
		"permissionModeId": "default",
		"planMode":         false,
		"speed":            "standard",
	}
	if !composerSettingsEqual(actual, nil) {
		t.Fatal("live defaults must match an empty recorded settings object")
	}
}

func TestComposerSettingsEqualRequiresRecordedKeys(t *testing.T) {
	expected := map[string]any{
		"model":           "haiku",
		"reasoningEffort": "high",
	}
	actual := map[string]any{
		"model": "haiku",
	}
	if composerSettingsEqual(actual, expected) {
		t.Fatal("missing recorded reasoningEffort must fail settings.equal")
	}
}
