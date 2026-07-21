package agent

import (
	"context"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
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

func (s staticPlanSource) GetModelPlan(context.Context, string, string) (modelplanbiz.Plan, error) {
	return s.plan, s.err
}

type recordingFirstUse struct {
	calls      []string
	candidates map[string]modelplanbiz.FirstUseCandidate
}

func (r *recordingFirstUse) PrepareFirstUse(_ context.Context, candidate modelplanbiz.FirstUseCandidate) error {
	if r.candidates == nil {
		r.candidates = map[string]modelplanbiz.FirstUseCandidate{}
	}
	r.candidates[candidate.WorkspaceID+"/"+candidate.AgentSessionID] = candidate
	return nil
}

func (r *recordingFirstUse) CompleteFirstUse(_ context.Context, workspaceID string, agentSessionID string) error {
	key := workspaceID + "/" + agentSessionID
	candidate, ok := r.candidates[key]
	if !ok {
		return nil
	}
	r.calls = append(r.calls, workspaceID+"/"+candidate.PlanID+"/"+candidate.AgentTargetID+"/"+agentSessionID+"/"+candidate.Model)
	delete(r.candidates, key)
	return nil
}

func (r *recordingFirstUse) ListPendingFirstUses(context.Context) ([]modelplanbiz.FirstUseCandidate, error) {
	candidates := make([]modelplanbiz.FirstUseCandidate, 0, len(r.candidates))
	for _, candidate := range r.candidates {
		candidates = append(candidates, candidate)
	}
	return candidates, nil
}

func newPlanBoundService(protocol modelplanbiz.Protocol, enabled bool) (*Service, *recordingFirstUse) {
	service := &Service{}
	firstUse := &recordingFirstUse{}
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
		firstUse,
	)
	return service, firstUse
}

func TestResolveModelPlanEndpointMatchesProviderProtocol(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service, _ := newPlanBoundService(modelplanbiz.ProtocolOpenAI, true)

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
	anthropicService, _ := newPlanBoundService(modelplanbiz.ProtocolAnthropic, true)
	if endpoint, _ := anthropicService.resolveModelPlanEndpoint(ctx, "ws", "local:codex", "codex", ""); endpoint != nil {
		t.Fatalf("protocol mismatch should not bind: %#v", endpoint)
	}
	// But they do bind onto claude-code.
	if endpoint, _ := anthropicService.resolveModelPlanEndpoint(ctx, "ws", "local:claude-code", "claude-code", ""); endpoint == nil {
		t.Fatalf("anthropic plan should bind claude-code")
	}

	// Disabled plans never bind.
	disabledService, _ := newPlanBoundService(modelplanbiz.ProtocolOpenAI, false)
	if endpoint, _ := disabledService.resolveModelPlanEndpoint(ctx, "ws", "local:codex", "codex", ""); endpoint != nil {
		t.Fatalf("disabled plan should not bind: %#v", endpoint)
	}

	// Providers without an endpoint-injection adapter keep native credentials.
	if endpoint, _ := service.resolveModelPlanEndpoint(ctx, "ws", "local:cursor", "cursor", ""); endpoint != nil {
		t.Fatalf("cursor should not receive a plan endpoint yet: %#v", endpoint)
	}
	if endpoint, _ := service.resolveModelPlanEndpoint(ctx, "ws", "local:opencode", "opencode", ""); endpoint != nil {
		t.Fatalf("opencode should not receive a plan endpoint: %#v", endpoint)
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

func TestObserveAgentSessionStateMarksFirstUseOnCompletedTurn(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service, firstUse := newPlanBoundService(modelplanbiz.ProtocolOpenAI, true)
	endpoint, _ := service.resolveModelPlanEndpoint(ctx, "ws", "local:codex", "codex", "")
	if err := service.preparePlanFirstUse(ctx, "ws", "session-1", endpoint, "local:codex"); err != nil {
		t.Fatalf("preparePlanFirstUse() error = %v", err)
	}

	completed := "completed"
	failed := "failed"
	settledFailed := canonical.ReportSessionStateInput{
		WorkspaceID:    "ws",
		AgentSessionID: "session-1",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{Phase: "settled", Outcome: &failed},
		},
	}
	service.ObserveAgentSessionState(ctx, settledFailed, canonical.ReportSessionStateReply{})
	if len(firstUse.calls) != 0 {
		t.Fatalf("failed turn must not mark first use: %v", firstUse.calls)
	}

	settledCompleted := canonical.ReportSessionStateInput{
		WorkspaceID:    "ws",
		AgentSessionID: "session-1",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{Phase: "settled", Outcome: &completed},
		},
	}
	service.ObserveAgentSessionState(ctx, settledCompleted, canonical.ReportSessionStateReply{})
	if len(firstUse.calls) != 1 || firstUse.calls[0] != "ws/mp-1/local:codex/session-1/plan-default" {
		t.Fatalf("first use calls = %v", firstUse.calls)
	}

	// A second completed turn does not re-mark.
	service.ObserveAgentSessionState(ctx, settledCompleted, canonical.ReportSessionStateReply{})
	if len(firstUse.calls) != 1 {
		t.Fatalf("first use should mark once: %v", firstUse.calls)
	}
}

func TestApplyModelPlanComposerOverlayReplacesModelOptions(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	service, _ := newPlanBoundService(modelplanbiz.ProtocolOpenAI, true)
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
