package modelcatalog

import (
	"testing"
)

func TestCodexChatGPTFallbackModelOptionsArePickerReady(t *testing.T) {
	t.Parallel()

	options := CodexChatGPTFallbackModelOptions()
	if len(options) == 0 {
		t.Fatal("CodexChatGPTFallbackModelOptions() returned no models")
	}
	defaults := 0
	for _, option := range options {
		if option.ID == "" {
			t.Fatalf("fallback model missing id: %#v", option)
		}
		if !option.ReasoningEffortsAdvertised || len(option.SupportedReasoningEfforts) == 0 {
			t.Fatalf("fallback model %q missing reasoning efforts", option.ID)
		}
		if option.IsDefault {
			defaults++
		}
	}
	if defaults != 1 {
		t.Fatalf("default models = %d, want 1", defaults)
	}

	raw := CodexChatGPTFallbackAppServerModels()
	if len(raw) != len(options) {
		t.Fatalf("app-server fallback count = %d, want %d", len(raw), len(options))
	}
	if CodexChatGPTFallbackSource != "codex-fallback" {
		t.Fatalf("CodexChatGPTFallbackSource = %q", CodexChatGPTFallbackSource)
	}
}
