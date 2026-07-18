package agent

import (
	"context"
	"errors"
	"slices"
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

func TestGetComposerOptionsUsesTargetDefaultsAndSparseRequestOverrides(t *testing.T) {
	service := newTestService(newFakeRuntime())
	service.AgentComposerDefaultsReader = fakeAgentComposerDefaultsReader{
		agenttargetbiz.IDLocalCodex: {
			Model:            "gpt-5",
			PermissionModeID: "full-access",
			ReasoningEffort:  "high",
			Speed:            "fast",
		},
	}
	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		AgentTargetID: agenttargetbiz.IDLocalCodex,
		Provider:      "codex",
		Settings: ComposerSettings{
			Model: "gpt-5-codex",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions() error = %v", err)
	}
	if options.EffectiveSettings.Model != "gpt-5-codex" ||
		options.EffectiveSettings.PermissionModeID != "full-access" ||
		options.EffectiveSettings.ReasoningEffort != "high" ||
		options.EffectiveSettings.Speed != "fast" {
		t.Fatalf("effective settings = %#v", options.EffectiveSettings)
	}
}

func TestValidateAgentComposerDefaultsPatchRejectsUnknownTargetAndValue(t *testing.T) {
	service := newTestService(newFakeRuntime())
	unsupported := "not-a-permission"
	err := service.ValidateAgentComposerDefaultsPatch(context.Background(), agenttargetbiz.IDLocalCodex, preferencesbiz.AgentComposerDefaultsPatch{
		preferencesbiz.AgentComposerDefaultsFieldPermissionModeID: &unsupported,
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("unsupported permission error = %v", err)
	}
	model := "gpt-5"
	err = service.ValidateAgentComposerDefaultsPatch(context.Background(), "missing-target", preferencesbiz.AgentComposerDefaultsPatch{
		preferencesbiz.AgentComposerDefaultsFieldModel: &model,
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("missing target error = %v", err)
	}
}

func TestComposerProviderCapabilitiesDefaults(t *testing.T) {
	t.Parallel()
	claude := composerProviderCapabilities("claude-code", true)
	for _, want := range []string{"imageInput", "skills", "compact", "tokenUsage", "rateLimits", "planMode", "interrupt", "activeTurnGuidance"} {
		if !slices.Contains(claude, want) {
			t.Fatalf("claude defaults = %v, missing %q", claude, want)
		}
	}
	codex := composerProviderCapabilities("codex", true)
	if !slices.Contains(codex, "planMode") {
		t.Fatalf("codex defaults must include planMode (re-negotiated at session start): %v", codex)
	}
	if !slices.Contains(codex, "compact") || !slices.Contains(codex, "skills") {
		t.Fatalf("codex defaults = %v", codex)
	}
	if !slices.Contains(codex, "activeTurnGuidance") {
		t.Fatalf("codex defaults = %v, missing native active-turn guidance", codex)
	}
	tuttiAgent := composerProviderCapabilities("tutti-agent", true)
	if !slices.Contains(tuttiAgent, "planMode") || !slices.Contains(tuttiAgent, "compact") || !slices.Contains(tuttiAgent, "skills") {
		t.Fatalf("tutti-agent defaults = %v", tuttiAgent)
	}
	// Browser use is delivered as a default MCP server to every provider, so it
	// is advertised by default alongside the per-provider capabilities.
	for _, provider := range []string{"claude-code", "codex", "cursor", "opencode", "tutti-agent", "openclaw"} {
		if got := composerProviderCapabilities(provider, true); !slices.Contains(got, "browserUse") {
			t.Fatalf("%s defaults = %v, missing browserUse", provider, got)
		}
	}
	if got := composerProviderCapabilities("openclaw", true); !slices.Contains(got, "interrupt") {
		t.Fatalf("openclaw defaults = %v, missing interrupt", got)
	}
	if got := composerProviderCapabilities("opencode", true); !slices.Contains(got, "imageInput") || !slices.Contains(got, "interrupt") {
		t.Fatalf("opencode defaults = %v, missing imageInput or interrupt", got)
	}
	if got := composerProviderCapabilities("opencode", true); !slices.Contains(got, "planMode") {
		t.Fatalf("opencode defaults = %v, missing planMode", got)
	}
	if got := composerProviderCapabilities("opencode", true); slices.Contains(got, "activeTurnGuidance") {
		t.Fatalf("opencode defaults = %v, must use cancel-then-send", got)
	}
	if got := composerProviderCapabilities("cursor", true); !slices.Contains(got, "imageInput") || !slices.Contains(got, "interrupt") || !slices.Contains(got, "planMode") {
		t.Fatalf("cursor defaults = %v, missing imageInput, interrupt, or planMode", got)
	}
	if got := composerProviderCapabilities("unknown", true); got != nil {
		t.Fatalf("unknown provider defaults = %v, want nil", got)
	}
}

func TestComposerProviderCapabilitiesOmitUnavailableComputerUse(t *testing.T) {
	for _, provider := range []string{"claude-code", "codex", "tutti-agent", "openclaw"} {
		if got := composerProviderCapabilities(provider, false); slices.Contains(got, "computerUse") {
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
	for _, provider := range []string{"hermes", "nexight", "openclaw"} {
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
	if opencode.Model != "openai/gpt-5.3-codex-spark" || opencode.ReasoningEffort != "none" {
		t.Fatalf("opencode settings normalized unexpectedly: %+v", opencode)
	}
	claude := normalizeComposerSettingsForProvider("claude-code", ComposerSettings{
		Model: "opus",
	})
	if claude.Model != "opus" {
		t.Fatalf("claude model = %q, want opus", claude.Model)
	}
}

func TestResolveCreateSessionModelPreservesClaudeAliases(t *testing.T) {
	t.Parallel()
	service := &Service{}
	for _, want := range []string{"opus", "opusplan"} {
		got := service.resolveCreateSessionModel(context.Background(), "claude-code", nil, "", stringPointer(want))
		if got == nil {
			t.Fatalf("resolveCreateSessionModel(%q) = nil, want %q", want, want)
		}
		if *got != want {
			t.Fatalf("resolveCreateSessionModel(%q) = %q, want %q", want, *got, want)
		}
	}
}

func TestResolveCreateSessionModelPropagatesWorkspaceCwd(t *testing.T) {
	t.Parallel()
	inputs := []AgentModelCatalogInput{}
	service := &Service{ModelCatalog: fakeModelCatalog{
		inputs: &inputs,
		result: AgentModelCatalogResult{Models: []AgentModelOption{{
			ID:        "openai/gpt-5.4",
			IsDefault: true,
		}}},
	}}

	got := service.resolveCreateSessionModel(context.Background(), "opencode", nil, "/workspace/project", nil)
	if got == nil || *got != "openai/gpt-5.4" {
		t.Fatalf("resolveCreateSessionModel() = %v, want openai/gpt-5.4", got)
	}
	if len(inputs) != 1 || inputs[0] != (AgentModelCatalogInput{Provider: "opencode", Cwd: "/workspace/project"}) {
		t.Fatalf("model catalog inputs = %+v, want workspace-scoped OpenCode lookup", inputs)
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

func TestComposerPermissionConfigForOpenCodeIsIndependentFromPlanMode(t *testing.T) {
	t.Parallel()
	config := composerPermissionConfig("opencode", "", "en")
	if !config.Configurable {
		t.Fatal("opencode permission config must be configurable")
	}
	if config.DefaultValue != "ask" {
		t.Fatalf("opencode default permission mode = %q, want ask", config.DefaultValue)
	}
	ids := make([]string, 0, len(config.Modes))
	for _, mode := range config.Modes {
		ids = append(ids, mode.ID)
	}
	if !slices.Equal(ids, []string{"read-only", "ask", "full-access"}) {
		t.Fatalf("opencode permission mode ids = %v, want [read-only ask full-access]", ids)
	}
	if got := normalizePermissionModeIDForProvider("opencode", "plan"); got != "ask" {
		t.Fatalf("OpenCode workflow mode leaked into permission mode: %q", got)
	}
	settings := normalizeComposerSettingsForProvider("opencode", ComposerSettings{
		PermissionModeID: "full-access",
		PlanMode:         true,
	})
	if settings.PermissionModeID != "full-access" || !settings.PlanMode {
		t.Fatalf("OpenCode permission/plan settings are not independent: %#v", settings)
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
		{"opencode", true, false, true},
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

func TestComposerModelReasoningOptionsByModelPreservesCatalogOptions(t *testing.T) {
	t.Parallel()
	for _, provider := range []string{"codex", "tutti-agent"} {
		t.Run(provider, func(t *testing.T) {
			profiles := composerModelReasoningOptionsByModel(
				provider,
				"en",
				map[string]composerModelReasoningProfile{
					"model-1": {
						DefaultReasoningEffort: "ultra",
						ReasoningEfforts: []AgentModelReasoningEffortOption{
							{Value: "high"},
							{Value: "ultra"},
						},
					},
				},
			)
			modelOptions, ok := profiles["model-1"]
			if !ok || modelOptions.DefaultValue != "ultra" {
				t.Fatalf("model options = %#v", profiles["model-1"])
			}
			options := modelOptions.Options
			if len(options) != 2 {
				t.Fatalf("reasoning options = %#v", options)
			}
			if options[1].Value != "ultra" {
				t.Fatalf("reasoning options = %#v, want runtime-advertised ultra preserved", options)
			}
		})
	}
}

func TestNormalizeObservedComposerSettingsUsesProviderReasoningPolicy(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		provider string
		selected string
		want     string
	}{
		{provider: "codex", selected: "none", want: "none"},
		{provider: "tutti-agent", selected: "minimal", want: "minimal"},
		{provider: "opencode", selected: "none", want: "none"},
	} {
		t.Run(tc.provider, func(t *testing.T) {
			got := normalizeComposerSettingsPointerForProvider(
				tc.provider,
				&ComposerSettings{ReasoningEffort: tc.selected},
			)
			if got == nil || got.ReasoningEffort != tc.want {
				t.Fatalf("normalized settings = %#v, want reasoning %q", got, tc.want)
			}
		})
	}
}

func TestResolveAdvertisedReasoningEffortPreservesAuthoritativeMinimalDefault(t *testing.T) {
	advertised := []AgentModelReasoningEffortOption{{Value: "minimal"}}
	if got := resolveAdvertisedReasoningEffort("codex", "", "minimal", advertised); got != "minimal" {
		t.Fatalf("resolveAdvertisedReasoningEffort = %q, want minimal", got)
	}
	options := composerAdvertisedReasoningOptionValues("codex", "minimal", "en", advertised)
	if len(options) != 1 || options[0].Value != "minimal" {
		t.Fatalf("composer advertised options = %#v, want only minimal", options)
	}
}

func TestComposerAdvertisedReasoningOptionValuesLocalizesNone(t *testing.T) {
	advertised := []AgentModelReasoningEffortOption{{Value: "none"}}
	english := composerAdvertisedReasoningOptionValues("opencode", "none", "en", advertised)
	if len(english) != 1 || english[0].Label != "Off" || english[0].Description == "" {
		t.Fatalf("English none option = %#v", english)
	}
	chinese := composerAdvertisedReasoningOptionValues("opencode", "none", "zh-CN", advertised)
	if len(chinese) != 1 || chinese[0].Label != "关闭" || chinese[0].Description == "" {
		t.Fatalf("Chinese none option = %#v", chinese)
	}
}
