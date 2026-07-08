package agent

import (
	"path/filepath"
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
	tuttiAgent := composerProviderCapabilities("tutti-agent")
	if !slices.Contains(tuttiAgent, "planMode") || !slices.Contains(tuttiAgent, "compact") || !slices.Contains(tuttiAgent, "skills") {
		t.Fatalf("tutti-agent defaults = %v", tuttiAgent)
	}
	// Browser use is delivered as a default MCP server to every provider, so it
	// is advertised by default alongside the per-provider capabilities.
	for _, provider := range []string{"claude-code", "codex", "tutti-agent", "gemini", "openclaw"} {
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
	if got := composerProviderCapabilities("opencode"); !slices.Contains(got, "imageInput") || !slices.Contains(got, "interrupt") {
		t.Fatalf("opencode defaults = %v, missing imageInput or interrupt", got)
	}
	if got := composerProviderCapabilities("opencode"); !slices.Contains(got, "planMode") {
		t.Fatalf("opencode defaults = %v, missing planMode", got)
	}
	if got := composerProviderCapabilities("cursor"); !slices.Contains(got, "imageInput") || !slices.Contains(got, "interrupt") {
		t.Fatalf("cursor defaults = %v, missing imageInput or interrupt", got)
	}
	if got := composerProviderCapabilities("unknown"); got != nil {
		t.Fatalf("unknown provider defaults = %v, want nil", got)
	}
}

func TestComposerProviderCapabilitiesOmitUnavailableComputerUse(t *testing.T) {
	t.Setenv("TUTTI_COMPUTER_USE", "")
	t.Setenv("TUTTI_COMPUTER_MCP_COMMAND", filepath.Join(t.TempDir(), "missing-cua-driver"))

	for _, provider := range []string{"claude-code", "codex", "tutti-agent", "gemini", "openclaw"} {
		if got := composerProviderCapabilities(provider); slices.Contains(got, "computerUse") {
			t.Fatalf("%s defaults = %v, want no computerUse when cua-driver is unavailable", provider, got)
		}
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
	for _, provider := range []string{"claude-code", "codex", "tutti-agent", "opencode"} {
		got := normalizeComposerSettingsForProvider(provider, ComposerSettings{PlanMode: true})
		if !got.PlanMode {
			t.Fatalf("%s planMode clamped, want preserved", provider)
		}
	}
	cursor := normalizeComposerSettingsForProvider("cursor", ComposerSettings{PlanMode: true})
	if !cursor.PlanMode {
		t.Fatal("cursor planMode clamped, want preserved")
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
	tuttiAgent := normalizeComposerSettingsForProvider("tutti-agent", ComposerSettings{
		Model:           "gpt-5.4",
		ReasoningEffort: "high",
	})
	if tuttiAgent.Model != "gpt-5.4" || tuttiAgent.ReasoningEffort != "high" {
		t.Fatalf("tutti-agent settings clamped unexpectedly: %+v", tuttiAgent)
	}
	opencode := normalizeComposerSettingsForProvider("opencode", ComposerSettings{
		Model:           "openai/gpt-5.3-codex-spark",
		ReasoningEffort: "none",
	})
	if opencode.Model != "openai/gpt-5.3-codex-spark" || opencode.ReasoningEffort != "high" {
		t.Fatalf("opencode settings normalized unexpectedly: %+v", opencode)
	}
	claude := normalizeComposerSettingsForProvider("claude-code", ComposerSettings{
		Model: "opus",
	})
	if claude.Model != "default" {
		t.Fatalf("claude legacy opus model = %q, want default", claude.Model)
	}
}

func TestComposerPermissionConfigForCursor(t *testing.T) {
	t.Parallel()
	config := composerPermissionConfig("cursor", "", "en")
	if !config.Configurable {
		t.Fatal("cursor permission config must be configurable")
	}
	if config.DefaultValue != "agent" {
		t.Fatalf("cursor default permission mode = %q, want agent", config.DefaultValue)
	}
	ids := make([]string, 0, len(config.Modes))
	for _, mode := range config.Modes {
		ids = append(ids, mode.ID)
	}
	if !slices.Equal(ids, []string{"read-only", "agent", "full-access"}) {
		t.Fatalf("cursor permission mode ids = %v, want [read-only agent full-access]", ids)
	}
	if got := normalizePermissionModeIDForProvider("cursor", "yolo"); got != "agent" {
		t.Fatalf("normalizePermissionModeIDForProvider(cursor, yolo) = %q, want agent", got)
	}
	// Pre-tier execution-mode ids persisted by earlier sessions fall back to
	// the default tier instead of leaking through.
	if got := normalizePermissionModeIDForProvider("cursor", "plan"); got != "agent" {
		t.Fatalf("normalizePermissionModeIDForProvider(cursor, plan) = %q, want agent fallback", got)
	}
	if got := normalizePermissionModeIDForProvider("cursor", "full-access"); got != "full-access" {
		t.Fatalf("normalizePermissionModeIDForProvider(cursor, full-access) = %q, want full-access", got)
	}
}

func TestComposerConfigConfigurableTruthTable(t *testing.T) {
	t.Parallel()
	// Pins the backend configurable flags so the GUI can derive support from
	// data instead of provider names.
	cases := []struct {
		provider   string
		model      bool
		reasoning  bool
		permission bool
	}{
		{"claude-code", false, true, true},
		{"codex", true, true, true},
		{"tutti-agent", true, true, true},
		{"cursor", true, false, true},
		{"gemini", true, true, false},
		{"hermes", false, false, false},
		{"nexight", false, false, true},
		{"openclaw", false, false, false},
	}
	for _, tc := range cases {
		model := composerModelConfig(tc.provider, "", nil)
		reasoning := composerReasoningConfig(tc.provider, "", "en")
		permission := composerPermissionConfig(tc.provider, "", "en")
		if model.Configurable != tc.model {
			t.Fatalf("%s modelConfig.configurable = %v, want %v", tc.provider, model.Configurable, tc.model)
		}
		if reasoning.Configurable != tc.reasoning {
			t.Fatalf("%s reasoningConfig.configurable = %v, want %v", tc.provider, reasoning.Configurable, tc.reasoning)
		}
		if permission.Configurable != tc.permission {
			t.Fatalf("%s permissionConfig.configurable = %v, want %v", tc.provider, permission.Configurable, tc.permission)
		}
	}
}
