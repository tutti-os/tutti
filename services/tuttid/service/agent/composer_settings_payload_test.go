package agent

import (
	"reflect"
	"testing"
)

func TestComposerSettingsPayloadRoundTrip(t *testing.T) {
	falseValue := false
	trueValue := true
	cases := []ComposerSettings{
		{},
		{
			Model:            "gpt-5",
			PermissionModeID: "auto",
			PlanMode:         true,
			ReasoningEffort:  "high",
		},
		{
			BrowserUse: &falseValue,
		},
		{
			BrowserUse: &trueValue,
			Model:      "claude-sonnet",
		},
	}
	for _, settings := range cases {
		payload := composerSettingsToPayload(settings)
		got := composerSettingsFromPayload(payload)
		if !reflect.DeepEqual(settings, got) {
			t.Fatalf("round-trip mismatch: input=%#v payload=%#v got=%#v", settings, payload, got)
		}
	}
}

func TestComposerSettingsFromPayloadBrowserUseTriState(t *testing.T) {
	falseValue := false
	trueValue := true

	if got := composerSettingsFromPayload(map[string]any{"browserUse": false}); got.BrowserUse == nil || *got.BrowserUse {
		t.Fatalf("expected explicit false, got %#v", got.BrowserUse)
	}
	if got := composerSettingsFromPayload(map[string]any{"browserUse": true}); got.BrowserUse == nil || !*got.BrowserUse {
		t.Fatalf("expected explicit true, got %#v", got.BrowserUse)
	}
	if got := composerSettingsFromPayload(nil); got.BrowserUse != nil {
		t.Fatalf("expected nil browserUse, got %#v", got.BrowserUse)
	}

	payload := composerSettingsToPayload(ComposerSettings{BrowserUse: &falseValue})
	if payload["browserUse"] != false {
		t.Fatalf("payload browserUse = %#v, want false", payload["browserUse"])
	}
	payload = composerSettingsToPayload(ComposerSettings{BrowserUse: &trueValue})
	if payload["browserUse"] != true {
		t.Fatalf("payload browserUse = %#v, want true", payload["browserUse"])
	}
	payload = composerSettingsToPayload(ComposerSettings{})
	if _, ok := payload["browserUse"]; ok {
		t.Fatalf("expected browserUse omitted for unset default, payload=%#v", payload)
	}
}

func TestCreateSessionInputFromPersistedPreservesBrowserUse(t *testing.T) {
	falseValue := false
	input := createSessionInputFromPersisted(PersistedSession{
		ID:       "session-1",
		Provider: "codex",
		Settings: ComposerSettings{
			BrowserUse: &falseValue,
			Model:      "gpt-5",
		},
	})
	if input.BrowserUse == nil || *input.BrowserUse {
		t.Fatalf("BrowserUse = %#v, want explicit false", input.BrowserUse)
	}
	if input.Model == nil || *input.Model != "gpt-5" {
		t.Fatalf("Model = %#v, want gpt-5", input.Model)
	}
}
