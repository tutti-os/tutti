package agent

import (
	"context"
	"crypto/sha256"
	"strings"
	"testing"

	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

type staticBindingSource struct {
	binding modelbindingbiz.Binding
	err     error
}

func (s staticBindingSource) GetAgentModelBinding(context.Context, string, string) (modelbindingbiz.Binding, error) {
	return s.binding, s.err
}

type staticPlanSource struct {
	plan modelplanbiz.Plan
	err  error
}

func TestApplyRequestedModelPlanOverridesAgentDefault(t *testing.T) {
	requested := modelplanbiz.Plan{
		ID:          "plan-requested",
		WorkspaceID: "ws",
		Revision:    9,
		Enabled:     true,
		Protocol:    modelplanbiz.ProtocolOpenAI,
	}
	service := &Service{}
	service.ConfigureModelPlanBinding(nil, staticPlanSource{plan: requested})
	requestedPlanID := "plan-requested"
	input := CreateSessionInput{
		ModelPlanID:       &requestedPlanID,
		ResolvedModelPlan: &modelplanbiz.Plan{ID: "plan-default"},
	}

	if err := service.applyRequestedModelPlan(context.Background(), "ws", &input); err != nil {
		t.Fatalf("applyRequestedModelPlan() error = %v", err)
	}
	if input.ResolvedModelPlan == nil || input.ResolvedModelPlan.ID != requested.ID || input.ResolvedModelPlan.Revision != requested.Revision {
		t.Fatalf("ResolvedModelPlan = %#v, want requested plan", input.ResolvedModelPlan)
	}
}

func (s staticPlanSource) GetModelPlan(context.Context, string, string) (modelplanbiz.Plan, error) {
	return s.plan, s.err
}

type recordingModelCatalog struct {
	calls int
}

func (r *recordingModelCatalog) ListModels(context.Context, AgentModelCatalogInput) (AgentModelCatalogResult, error) {
	r.calls++
	return AgentModelCatalogResult{
		Provider: "codex",
		Source:   "codex-cli",
		Models: []AgentModelOption{{
			ID:          "gpt-native",
			DisplayName: "GPT Native",
			IsDefault:   true,
		}},
	}, nil
}

func newPlanBoundService(protocol modelplanbiz.Protocol, enabled bool) *Service {
	service := &Service{}
	service.ConfigureModelPlanBinding(
		staticBindingSource{binding: modelbindingbiz.Binding{
			WorkspaceID:   "ws",
			AgentTargetID: "local:codex",
			ModelPlanID:   "mp-1",
			DefaultModel:  "plan-default",
		}},
		staticPlanSource{plan: modelplanbiz.Plan{
			ID:          "mp-1",
			WorkspaceID: "ws",
			Revision:    7,
			Name:        "Volc Coding Plan",
			Protocol:    protocol,
			APIKey:      "sk-plan",
			BaseURL:     "https://relay.example/v1",
			Enabled:     enabled,
			Models: []modelplanbiz.Model{
				{ID: "plan-default", Name: "Plan Default"},
				{ID: "plan-alt", Name: "Plan Alt"},
			},
		}},
	)
	return service
}

func TestResolveModelPlanEndpointMatchesProviderProtocol(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := newPlanBoundService(modelplanbiz.ProtocolOpenAI, true)

	endpoint, models := service.resolveModelPlanEndpoint(ctx, "ws", "local:codex", "codex", "")
	if endpoint == nil {
		t.Fatalf("resolveModelPlanEndpoint() = nil, want endpoint")
	}
	if endpoint.Model != "plan-default" || endpoint.APIKey != "sk-plan" || endpoint.Protocol != "openai" {
		t.Fatalf("endpoint = %#v", endpoint)
	}
	if len(models) != 2 {
		t.Fatalf("plan models = %#v", models)
	}

	// Requested model inside the plan wins over the binding default.
	endpoint, _ = service.resolveModelPlanEndpoint(ctx, "ws", "local:codex", "codex", "plan-alt")
	if endpoint == nil || endpoint.Model != "plan-alt" {
		t.Fatalf("endpoint with requested model = %#v", endpoint)
	}

	// Anthropic-protocol plans do not bind onto codex.
	anthropicService := newPlanBoundService(modelplanbiz.ProtocolAnthropic, true)
	if endpoint, _ := anthropicService.resolveModelPlanEndpoint(ctx, "ws", "local:codex", "codex", ""); endpoint != nil {
		t.Fatalf("protocol mismatch should not bind: %#v", endpoint)
	}
	// But they do bind onto claude-code.
	if endpoint, _ := anthropicService.resolveModelPlanEndpoint(ctx, "ws", "local:claude-code", "claude-code", ""); endpoint == nil {
		t.Fatalf("anthropic plan should bind claude-code")
	}

	// Disabled plans never bind.
	disabledService := newPlanBoundService(modelplanbiz.ProtocolOpenAI, false)
	if endpoint, _ := disabledService.resolveModelPlanEndpoint(ctx, "ws", "local:codex", "codex", ""); endpoint != nil {
		t.Fatalf("disabled plan should not bind: %#v", endpoint)
	}

	// Providers without an endpoint-injection adapter keep native credentials.
	if endpoint, _ := service.resolveModelPlanEndpoint(ctx, "ws", "local:cursor", "cursor", ""); endpoint != nil {
		t.Fatalf("cursor should not receive a plan endpoint yet: %#v", endpoint)
	}
}

func TestResolveModelPlanReportsAuthoritativeConfiguration(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := newPlanBoundService(modelplanbiz.ProtocolOpenAI, true)
	resolution := service.resolveModelPlan(ctx, "ws", "local:codex", "codex", "plan-alt")
	if resolution.Endpoint == nil || resolution.Endpoint.Model != "plan-alt" {
		t.Fatalf("requested model resolution = %#v, want plan-alt endpoint", resolution.Endpoint)
	}
	configuration := resolution.ModelConfiguration
	if configuration.AgentTargetID != "local:codex" || configuration.Source != modelConfigurationSourceModelPlan {
		t.Fatalf("model configuration = %#v", configuration)
	}
	if configuration.DefaultModel != "plan-default" {
		t.Fatalf("default model = %q, want plan-default independent of requested model", configuration.DefaultModel)
	}
	if !strings.HasPrefix(configuration.Fingerprint, "sha256:") || len(configuration.Fingerprint) != len("sha256:")+sha256.Size*2 {
		t.Fatalf("fingerprint = %q, want sha256 fingerprint", configuration.Fingerprint)
	}

	// Endpoint secrets and URLs never participate in the redaction-safe
	// fingerprint. At the same immutable revision presentation-only changes do
	// not churn it; a real configuration write advances Revision instead.
	rotated := &Service{}
	rotated.ConfigureModelPlanBinding(
		staticBindingSource{binding: modelbindingbiz.Binding{
			WorkspaceID:   "ws",
			AgentTargetID: "local:codex",
			ModelPlanID:   "mp-1",
			DefaultModel:  "plan-default",
		}},
		staticPlanSource{plan: modelplanbiz.Plan{
			ID:           "mp-1",
			WorkspaceID:  "ws",
			Revision:     7,
			Name:         "Renamed plan",
			Protocol:     modelplanbiz.ProtocolOpenAI,
			APIKey:       "a-different-secret",
			BaseURL:      "https://other-relay.example/v1?token=secret",
			Enabled:      true,
			DefaultModel: "",
			Models: []modelplanbiz.Model{
				{ID: "plan-default", Name: "Different display name"},
				{ID: "plan-alt", Name: "Another display name"},
			},
		}},
	)
	rotatedResolution := rotated.resolveModelPlan(ctx, "ws", "local:codex", "codex", "plan-alt")
	if rotatedResolution.ModelConfiguration.Fingerprint != configuration.Fingerprint {
		t.Fatalf("fingerprint changed for secrets or presentation-only fields: got %q want %q", rotatedResolution.ModelConfiguration.Fingerprint, configuration.Fingerprint)
	}
}

func TestResolveModelPlanFallsBackToProviderNativeConfiguration(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	disabledService := newPlanBoundService(modelplanbiz.ProtocolOpenAI, false)
	mismatchService := newPlanBoundService(modelplanbiz.ProtocolAnthropic, true)
	unsupportedService := newPlanBoundService(modelplanbiz.ProtocolOpenAI, true)
	tests := []struct {
		name     string
		service  *Service
		provider string
		targetID string
	}{
		{
			name:     "unbound",
			service:  &Service{},
			provider: "codex",
			targetID: "local:codex",
		},
		{
			name:     "disabled",
			service:  disabledService,
			provider: "codex",
			targetID: "local:codex",
		},
		{
			name:     "protocol mismatch",
			service:  mismatchService,
			provider: "codex",
			targetID: "local:codex",
		},
		{
			name:     "unsupported provider",
			service:  unsupportedService,
			provider: "cursor",
			targetID: "local:cursor",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			resolution := test.service.resolveModelPlan(ctx, "ws", test.targetID, test.provider, "stale-model")
			if resolution.Endpoint != nil || len(resolution.Models) != 0 {
				t.Fatalf("native resolution = %#v, want no plan endpoint/models", resolution)
			}
			configuration := resolution.ModelConfiguration
			if configuration.AgentTargetID != test.targetID || configuration.Source != modelConfigurationSourceProviderNative {
				t.Fatalf("native model configuration = %#v", configuration)
			}
			if configuration.DefaultModel != "" {
				t.Fatalf("native default model = %q, want empty/null", configuration.DefaultModel)
			}
			if configuration.Fingerprint == "" {
				t.Fatal("native fingerprint is empty")
			}
		})
	}
}

func TestWorkspaceAgentPlanFingerprintDoesNotChangeWithSessionModelChoice(t *testing.T) {
	plan := modelplanbiz.Plan{
		ID: "plan-1", WorkspaceID: "ws", Name: "Plan", Revision: 2,
		Protocol: modelplanbiz.ProtocolOpenAI, Enabled: true, DefaultModel: "model-a",
		Models: []modelplanbiz.Model{{ID: "model-a"}, {ID: "model-b"}},
	}
	first, err := resolveProvidedModelPlan("codex", "workspace-agent:one", plan, "model-a", "model-a")
	if err != nil {
		t.Fatalf("resolveProvidedModelPlan(first) error = %v", err)
	}
	second, err := resolveProvidedModelPlan("codex", "workspace-agent:one", plan, "model-a", "model-b")
	if err != nil {
		t.Fatalf("resolveProvidedModelPlan(second) error = %v", err)
	}
	if first.ModelConfiguration.Fingerprint != second.ModelConfiguration.Fingerprint {
		t.Fatalf("fingerprints differ by session model: %q vs %q", first.ModelConfiguration.Fingerprint, second.ModelConfiguration.Fingerprint)
	}
	if first.Endpoint.Model != "model-a" || second.Endpoint.Model != "model-b" {
		t.Fatalf("endpoint models = %q/%q", first.Endpoint.Model, second.Endpoint.Model)
	}
}

func TestValidateModelAgainstPlanRejectsUnknownModel(t *testing.T) {
	t.Parallel()

	models := []modelplanbiz.Model{{ID: "plan-default", Name: "Plan Default"}}
	if err := validateModelAgainstPlan("codex", "", models); err != nil {
		t.Fatalf("empty request should pass: %v", err)
	}
	if err := validateModelAgainstPlan("codex", "plan-default", models); err != nil {
		t.Fatalf("plan model should pass: %v", err)
	}
	err := validateModelAgainstPlan("codex", "gpt-external", models)
	invalid, ok := err.(*InvalidModelError)
	if !ok {
		t.Fatalf("error = %v, want InvalidModelError", err)
	}
	if len(invalid.AvailableModels) != 1 || invalid.AvailableModels[0] != "plan-default" {
		t.Fatalf("available models = %#v", invalid.AvailableModels)
	}
}

func TestApplyModelPlanComposerOverlayReplacesModelOptions(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := newPlanBoundService(modelplanbiz.ProtocolOpenAI, true)
	options := ComposerOptions{
		Provider: "codex",
		ModelConfig: ComposerConfigOption{
			Configurable: true,
			CurrentValue: "gpt-native",
			Options:      []ComposerConfigOptionValue{{ID: "gpt-native", Value: "gpt-native"}},
		},
		RuntimeContext: map[string]any{},
	}
	overlaid := service.applyModelPlanComposerOverlay(ctx, ComposerOptionsInput{
		WorkspaceID:   "ws",
		AgentTargetID: "local:codex",
		Provider:      "codex",
	}, options)
	if len(overlaid.ModelConfig.Options) != 2 || overlaid.ModelConfig.Options[0].ID != "plan-default" {
		t.Fatalf("model options = %#v", overlaid.ModelConfig.Options)
	}
	if overlaid.ModelConfig.Options[0].Description != "Volc Coding Plan" {
		t.Fatalf("model option should carry source plan name: %#v", overlaid.ModelConfig.Options[0])
	}
	if overlaid.EffectiveSettings.Model != "plan-default" {
		t.Fatalf("effective model = %q", overlaid.EffectiveSettings.Model)
	}
	plan, ok := overlaid.RuntimeContext["modelPlan"].(map[string]any)
	if !ok || plan["id"] != "mp-1" || plan["name"] != "Volc Coding Plan" {
		t.Fatalf("runtimeContext modelPlan = %#v", overlaid.RuntimeContext["modelPlan"])
	}

	// Unbound targets keep native options.
	cursorOptions := options
	cursorOptions.Provider = "cursor"
	unbound := service.applyModelPlanComposerOverlay(ctx, ComposerOptionsInput{
		WorkspaceID:   "ws",
		AgentTargetID: "local:cursor",
		Provider:      "cursor",
	}, cursorOptions)
	if len(unbound.ModelConfig.Options) != 1 || unbound.ModelConfig.Options[0].ID != "gpt-native" {
		t.Fatalf("unbound options = %#v", unbound.ModelConfig.Options)
	}
}

func TestGetComposerOptionsBoundPlanSkipsProviderNativeModelCatalog(t *testing.T) {
	t.Parallel()

	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	service.ConfigureModelPlanBinding(
		staticBindingSource{binding: modelbindingbiz.Binding{
			WorkspaceID:   "ws",
			AgentTargetID: "local:codex",
			ModelPlanID:   "mp-1",
			DefaultModel:  "plan-default",
		}},
		staticPlanSource{plan: modelplanbiz.Plan{
			ID:           "mp-1",
			WorkspaceID:  "ws",
			Name:         "Volc Coding Plan",
			Protocol:     modelplanbiz.ProtocolOpenAI,
			APIKey:       "sk-plan",
			BaseURL:      "https://relay.example/v1",
			Enabled:      true,
			DefaultModel: "plan-default",
			Models: []modelplanbiz.Model{
				{ID: "plan-default", Name: "Plan Default"},
				{ID: "plan-alt", Name: "Plan Alt"},
			},
		}},
	)
	catalog := &recordingModelCatalog{}
	service.ModelCatalog = catalog
	includeCapabilityCatalog := false

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		WorkspaceID:              "ws",
		AgentTargetID:            "local:codex",
		IncludeCapabilityCatalog: &includeCapabilityCatalog,
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if catalog.calls != 0 {
		t.Fatalf("provider-native model catalog calls = %d, want 0 for a bound plan", catalog.calls)
	}
	if options.EffectiveSettings.Model != "plan-default" {
		t.Fatalf("effective model = %q, want plan-default", options.EffectiveSettings.Model)
	}
	if len(options.ModelConfig.Options) != 2 || options.ModelConfig.Options[0].ID != "plan-default" {
		t.Fatalf("model options = %#v, want bound plan models", options.ModelConfig.Options)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("runtime config options = %#v", options.RuntimeContext["configOptions"])
	}
	runtimeModelOptions, ok := configOptions[0]["options"].([]map[string]any)
	if !ok || len(runtimeModelOptions) != 2 || runtimeModelOptions[0]["value"] != "plan-default" {
		t.Fatalf("runtime model options = %#v, want bound plan models", configOptions[0]["options"])
	}
	if _, ok := options.RuntimeContext["modelCatalogSource"]; ok {
		t.Fatalf("modelCatalogSource = %#v, want no provider-native source", options.RuntimeContext["modelCatalogSource"])
	}
	configuration, ok := options.RuntimeContext["modelConfiguration"].(map[string]any)
	if !ok || configuration["agentTargetId"] != "local:codex" || configuration["source"] != modelConfigurationSourceModelPlan {
		t.Fatalf("runtime model configuration = %#v", options.RuntimeContext["modelConfiguration"])
	}
	if configuration["defaultModel"] != "plan-default" || configuration["fingerprint"] == "" {
		t.Fatalf("runtime model configuration = %#v, want plan default and fingerprint", configuration)
	}

	selected, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		WorkspaceID:              "ws",
		AgentTargetID:            "local:codex",
		IncludeCapabilityCatalog: &includeCapabilityCatalog,
		Settings: ComposerSettings{
			Model: "plan-alt",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions with selected plan model returned error: %v", err)
	}
	if catalog.calls != 0 {
		t.Fatalf("provider-native model catalog calls = %d after selection, want 0", catalog.calls)
	}
	if selected.EffectiveSettings.Model != "plan-alt" || selected.ModelConfig.CurrentValue != "plan-alt" {
		t.Fatalf("selected plan model = %#v, want plan-alt", selected.ModelConfig)
	}
	selectedConfiguration, ok := selected.RuntimeContext["modelConfiguration"].(map[string]any)
	if !ok || selectedConfiguration["defaultModel"] != "plan-default" {
		t.Fatalf("selected runtime model configuration = %#v, want plan-default independent of selected model", selected.RuntimeContext["modelConfiguration"])
	}
	if selectedConfiguration["fingerprint"] != configuration["fingerprint"] {
		t.Fatalf("selected model changed configuration fingerprint: got %q want %q", selectedConfiguration["fingerprint"], configuration["fingerprint"])
	}
}

func TestGetComposerOptionsAlwaysReportsProviderNativeModelConfiguration(t *testing.T) {
	t.Parallel()

	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	service.ModelCatalog = &recordingModelCatalog{}
	includeCapabilityCatalog := false
	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		WorkspaceID:              "ws",
		AgentTargetID:            "local:codex",
		IncludeCapabilityCatalog: &includeCapabilityCatalog,
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	configuration, ok := options.RuntimeContext["modelConfiguration"].(map[string]any)
	if !ok {
		t.Fatalf("runtime model configuration = %#v", options.RuntimeContext["modelConfiguration"])
	}
	if configuration["agentTargetId"] != "local:codex" || configuration["source"] != modelConfigurationSourceProviderNative {
		t.Fatalf("runtime model configuration = %#v", configuration)
	}
	if configuration["defaultModel"] != nil || configuration["fingerprint"] == "" {
		t.Fatalf("runtime model configuration = %#v, want null default and fingerprint", configuration)
	}
}

func TestResolveModelPlanNamespacesOpenCodeModelValues(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service := newPlanBoundService(modelplanbiz.ProtocolOpenAI, true)

	// OpenCode consumes openai plans; composer/settings values carry the
	// injected provider namespace while the endpoint catalog stays raw.
	endpoint, models := service.resolveModelPlanEndpoint(ctx, "ws", "local:opencode", "opencode", "")
	if endpoint == nil {
		t.Fatalf("resolveModelPlanEndpoint() = nil, want endpoint for opencode")
	}
	if endpoint.Model != "tutti-model-plan/plan-default" {
		t.Fatalf("endpoint model = %q, want namespaced plan default", endpoint.Model)
	}
	if len(models) != 2 || len(endpoint.Models) != 2 {
		t.Fatalf("plan models = %#v, endpoint models = %#v", models, endpoint.Models)
	}
	if endpoint.Models[0].ID != "plan-default" || endpoint.Models[1].ID != "plan-alt" {
		t.Fatalf("endpoint models must keep raw plan ids: %#v", endpoint.Models)
	}

	// Namespaced and raw requested values both resolve inside the plan.
	for _, requested := range []string{"tutti-model-plan/plan-alt", "plan-alt"} {
		endpoint, _ := service.resolveModelPlanEndpoint(ctx, "ws", "local:opencode", "opencode", requested)
		if endpoint == nil || endpoint.Model != "tutti-model-plan/plan-alt" {
			t.Fatalf("requested %q resolved endpoint = %#v", requested, endpoint)
		}
	}

	// Plan validation accepts namespaced values and still rejects unknown models.
	if err := validateModelAgainstPlan("opencode", "tutti-model-plan/plan-alt", modelplanbiz.CloneModels([]modelplanbiz.Model{{ID: "plan-alt"}})); err != nil {
		t.Fatalf("validateModelAgainstPlan(namespaced) = %v", err)
	}
	if err := validateModelAgainstPlan("opencode", "tutti-model-plan/unknown", modelplanbiz.CloneModels([]modelplanbiz.Model{{ID: "plan-alt"}})); err == nil {
		t.Fatalf("validateModelAgainstPlan(unknown) = nil, want error")
	}

	// The composer overlay surfaces namespaced option values for opencode.
	resolution := service.resolveModelPlan(ctx, "ws", "local:opencode", "opencode", "")
	options := applyResolvedModelPlanComposerOverlay(ComposerOptions{Provider: "opencode"}, resolution)
	if options.ModelConfig.CurrentValue != "tutti-model-plan/plan-default" {
		t.Fatalf("overlay current value = %q", options.ModelConfig.CurrentValue)
	}
	if len(options.ModelConfig.Options) != 2 ||
		options.ModelConfig.Options[0].Value != "tutti-model-plan/plan-default" ||
		options.ModelConfig.Options[1].Value != "tutti-model-plan/plan-alt" {
		t.Fatalf("overlay options = %#v", options.ModelConfig.Options)
	}

	// Codex keeps raw plan model values.
	codexResolution := service.resolveModelPlan(ctx, "ws", "local:codex", "codex", "")
	codexOptions := applyResolvedModelPlanComposerOverlay(ComposerOptions{Provider: "codex"}, codexResolution)
	if codexOptions.ModelConfig.CurrentValue != "plan-default" ||
		codexOptions.ModelConfig.Options[0].Value != "plan-default" {
		t.Fatalf("codex overlay = %#v", codexOptions.ModelConfig)
	}
}
