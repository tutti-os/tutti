package agent

import (
	"slices"
	"testing"
)

func TestComposerProviderCapabilitiesDefaults(t *testing.T) {
	t.Parallel()
	claude := composerProviderCapabilities("claude-code")
	for _, want := range []string{"imageInput", "skills", "compact", "tokenUsage", "rateLimits", "planMode", "interrupt"} {
		if !slices.Contains(claude, want) {
			t.Fatalf("claude defaults = %v, missing %q", claude, want)
		}
	}
	codex := composerProviderCapabilities("codex")
	if !slices.Contains(codex, "planMode") {
		t.Fatalf("codex defaults must include planMode (re-negotiated at session start): %v", codex)
	}
	if !slices.Contains(codex, "compact") || !slices.Contains(codex, "skills") {
		t.Fatalf("codex defaults = %v", codex)
	}
	// Browser use is delivered as a default MCP server to every provider, so it
	// is advertised by default alongside the per-provider capabilities.
	for _, provider := range []string{"claude-code", "codex", "gemini", "openclaw"} {
		if got := composerProviderCapabilities(provider); !slices.Contains(got, "browserUse") {
			t.Fatalf("%s defaults = %v, missing browserUse", provider, got)
		}
	}
	if got := composerProviderCapabilities("gemini"); !slices.Contains(got, "interrupt") {
		t.Fatalf("gemini defaults = %v, missing interrupt", got)
	}
	if got := composerProviderCapabilities("openclaw"); !slices.Contains(got, "interrupt") {
		t.Fatalf("openclaw defaults = %v, missing interrupt", got)
	}
	if got := composerProviderCapabilities("unknown"); got != nil {
		t.Fatalf("unknown provider defaults = %v, want nil", got)
	}
}

func TestClampComposerBrowserUseForProvider(t *testing.T) {
	t.Parallel()
	truePtr := true
	falsePtr := false
	// Default (nil) resolves to on for a supported provider.
	if !clampComposerBrowserUseForProvider("claude-code", nil) {
		t.Fatal("claude-code nil browserUse should default on")
	}
	// Explicit opt-out is honored.
	if clampComposerBrowserUseForProvider("claude-code", &falsePtr) {
		t.Fatal("claude-code explicit false should be off")
	}
	// Explicit opt-in stays on.
	if !clampComposerBrowserUseForProvider("codex", &truePtr) {
		t.Fatal("codex explicit true should be on")
	}
	// Unknown provider (no advertised capability) is forced off even when requested.
	if clampComposerBrowserUseForProvider("unknown", &truePtr) {
		t.Fatal("unknown provider should clamp browserUse off")
	}
}

func TestNormalizeComposerSettingsClampsByProviderSupport(t *testing.T) {
	t.Parallel()
	// model/reasoning: providers without composer settings support must be cleared.
	for _, provider := range []string{"hermes", "nexight", "openclaw"} {
		got := normalizeComposerSettingsForProvider(provider, ComposerSettings{
			Model:           "some-model",
			ReasoningEffort: "high",
			PlanMode:        true,
		})
		if got.Model != "" {
			t.Fatalf("%s model = %q, want empty", provider, got.Model)
		}
		if got.ReasoningEffort != "" {
			t.Fatalf("%s reasoningEffort = %q, want empty", provider, got.ReasoningEffort)
		}
	}
	// planMode: only providers whose static capabilities include planMode keep it.
	for _, provider := range []string{"claude-code", "codex"} {
		got := normalizeComposerSettingsForProvider(provider, ComposerSettings{PlanMode: true})
		if !got.PlanMode {
			t.Fatalf("%s planMode clamped, want preserved", provider)
		}
	}
	for _, provider := range []string{"gemini", "hermes", "nexight", "openclaw"} {
		got := normalizeComposerSettingsForProvider(provider, ComposerSettings{PlanMode: true})
		if got.PlanMode {
			t.Fatalf("%s planMode = true, want clamped to false", provider)
		}
	}
	// providers with settings support keep their values.
	codex := normalizeComposerSettingsForProvider("codex", ComposerSettings{
		Model:           "gpt-5.3-codex",
		ReasoningEffort: "high",
	})
	if codex.Model != "gpt-5.3-codex" || codex.ReasoningEffort != "high" {
		t.Fatalf("codex settings clamped unexpectedly: %+v", codex)
	}
}

func TestComposerConfigConfigurableTruthTable(t *testing.T) {
	t.Parallel()
	// Pins the backend configurable flags to the legacy GUI hardcoded table so
	// the GUI can derive support from data instead of provider names.
	cases := []struct {
		provider   string
		model      bool
		permission bool
	}{
		{"claude-code", true, true},
		{"codex", true, true},
		{"gemini", true, false},
		{"hermes", false, false},
		{"nexight", false, true},
		{"openclaw", false, false},
	}
	for _, tc := range cases {
		model := composerModelConfig(tc.provider, "", nil)
		reasoning := composerReasoningConfig(tc.provider, "", "en")
		permission := composerPermissionConfig(tc.provider, "", "en")
		if model.Configurable != tc.model {
			t.Fatalf("%s modelConfig.configurable = %v, want %v", tc.provider, model.Configurable, tc.model)
		}
		if reasoning.Configurable != tc.model {
			t.Fatalf("%s reasoningConfig.configurable = %v, want %v", tc.provider, reasoning.Configurable, tc.model)
		}
		if permission.Configurable != tc.permission {
			t.Fatalf("%s permissionConfig.configurable = %v, want %v", tc.provider, permission.Configurable, tc.permission)
		}
	}
}
