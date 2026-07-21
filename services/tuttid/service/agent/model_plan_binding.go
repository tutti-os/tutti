package agent

import (
	"context"
	"log/slog"
	"strings"
	"sync"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

// AgentModelBindingSource resolves the per-workspace agent target binding.
type AgentModelBindingSource interface {
	GetAgentModelBinding(ctx context.Context, workspaceID string, agentTargetID string) (modelbindingbiz.Binding, error)
}

// AgentModelPlanSource resolves workspace model access plans with their
// stored credentials. Only the daemon runtime boundary may read the key.
type AgentModelPlanSource interface {
	GetModelPlan(ctx context.Context, workspaceID string, planID string) (modelplanbiz.Plan, error)
}

// ModelPlanFirstUseMarker completes a plan's pending-first-use lifecycle
// after the first successful agent turn through that plan.
type ModelPlanFirstUseMarker interface {
	MarkFirstUse(ctx context.Context, workspaceID string, planID string, agentTargetID string, agentSessionID string, model string) error
}

// modelPlanBindingRuntime holds the optional model plan integration wiring
// plus the pending first-use ledger keyed by workspace/session.
type modelPlanBindingRuntime struct {
	Bindings AgentModelBindingSource
	Plans    AgentModelPlanSource
	FirstUse ModelPlanFirstUseMarker
	mu       sync.Mutex
	pending  map[string]pendingPlanFirstUse
}

type pendingPlanFirstUse struct {
	PlanID        string
	AgentTargetID string
	Model         string
}

func (s *Service) modelPlanRuntime() *modelPlanBindingRuntime {
	return &s.modelPlanBinding
}

// ConfigureModelPlanBinding wires the optional model plan integration.
func (s *Service) ConfigureModelPlanBinding(bindings AgentModelBindingSource, plans AgentModelPlanSource, firstUse ModelPlanFirstUseMarker) {
	s.modelPlanBinding.Bindings = bindings
	s.modelPlanBinding.Plans = plans
	s.modelPlanBinding.FirstUse = firstUse
}

// modelPlanProtocolForProvider reads the endpoint-injection strategy declared
// by the canonical provider registry. Providers without that strategy keep
// their native credential source.
func modelPlanProtocolForProvider(provider string) (modelplanbiz.Protocol, bool) {
	protocol, ok := agentprovider.ModelPlanProtocol(provider)
	return modelplanbiz.Protocol(protocol), ok
}

// resolveModelPlanEndpoint resolves the injected endpoint for one session
// launch plus the plan's model list for validation. It returns nil when the
// target has no usable plan binding.
func (s *Service) resolveModelPlanEndpoint(ctx context.Context, workspaceID string, agentTargetID string, provider string, requestedModel string) (*runtimeprep.ModelEndpointConfig, []modelplanbiz.Model) {
	runtime := s.modelPlanRuntime()
	if runtime.Bindings == nil || runtime.Plans == nil {
		return nil, nil
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentTargetID = strings.TrimSpace(agentTargetID)
	if workspaceID == "" || agentTargetID == "" {
		return nil, nil
	}
	requiredProtocol, supported := modelPlanProtocolForProvider(provider)
	if !supported {
		return nil, nil
	}
	binding, err := runtime.Bindings.GetAgentModelBinding(ctx, workspaceID, agentTargetID)
	if err != nil || strings.TrimSpace(binding.ModelPlanID) == "" {
		return nil, nil
	}
	plan, err := runtime.Plans.GetModelPlan(ctx, workspaceID, binding.ModelPlanID)
	if err != nil {
		slog.Warn("agent model binding references missing plan",
			"event", "agent.model_plan.binding_plan_missing",
			"workspace_id", workspaceID,
			"agent_target_id", agentTargetID,
			"model_plan_id", binding.ModelPlanID,
		)
		return nil, nil
	}
	if !plan.Enabled {
		slog.Info("agent model binding plan is disabled; using provider-native credentials",
			"event", "agent.model_plan.binding_plan_disabled",
			"workspace_id", workspaceID,
			"agent_target_id", agentTargetID,
			"model_plan_id", plan.ID,
		)
		return nil, nil
	}
	if plan.Protocol != requiredProtocol {
		slog.Warn("agent model binding plan protocol does not match provider",
			"event", "agent.model_plan.binding_protocol_mismatch",
			"workspace_id", workspaceID,
			"agent_target_id", agentTargetID,
			"model_plan_id", plan.ID,
			"plan_protocol", string(plan.Protocol),
			"provider", provider,
		)
		return nil, nil
	}
	model := resolvePlanSessionModel(plan, binding, requestedModel)
	return &runtimeprep.ModelEndpointConfig{
		PlanID:   plan.ID,
		PlanName: plan.Name,
		Protocol: string(plan.Protocol),
		BaseURL:  plan.BaseURL,
		APIKey:   plan.APIKey,
		Model:    model,
	}, modelplanbiz.CloneModels(plan.Models)
}

// validateModelAgainstPlan rejects an explicitly requested model that the
// bound plan does not expose. An empty request always resolves to the plan
// default.
func validateModelAgainstPlan(provider string, requestedModel string, planModels []modelplanbiz.Model) error {
	requestedModel = strings.TrimSpace(requestedModel)
	if requestedModel == "" || modelplanbiz.ModelsContain(planModels, requestedModel) {
		return nil
	}
	available := make([]string, 0, len(planModels))
	for _, model := range planModels {
		available = append(available, model.ID)
	}
	return &InvalidModelError{
		Provider:        agentprovider.Normalize(provider),
		Model:           requestedModel,
		AvailableModels: available,
	}
}

func resolvePlanSessionModel(plan modelplanbiz.Plan, binding modelbindingbiz.Binding, requestedModel string) string {
	requestedModel = strings.TrimSpace(requestedModel)
	if requestedModel != "" && modelplanbiz.ModelsContain(plan.Models, requestedModel) {
		return requestedModel
	}
	if binding.DefaultModel != "" && modelplanbiz.ModelsContain(plan.Models, binding.DefaultModel) {
		return binding.DefaultModel
	}
	if plan.DefaultModel != "" {
		return plan.DefaultModel
	}
	if len(plan.Models) > 0 {
		return plan.Models[0].ID
	}
	return requestedModel
}

func (s *Service) registerPendingPlanFirstUse(workspaceID string, agentSessionID string, endpoint *runtimeprep.ModelEndpointConfig, agentTargetID string) {
	if endpoint == nil {
		return
	}
	runtime := s.modelPlanRuntime()
	if runtime.FirstUse == nil {
		return
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.pending == nil {
		runtime.pending = map[string]pendingPlanFirstUse{}
	}
	runtime.pending[pendingPlanFirstUseKey(workspaceID, agentSessionID)] = pendingPlanFirstUse{
		PlanID:        endpoint.PlanID,
		AgentTargetID: strings.TrimSpace(agentTargetID),
		Model:         endpoint.Model,
	}
}

func pendingPlanFirstUseKey(workspaceID string, agentSessionID string) string {
	return strings.TrimSpace(workspaceID) + "/" + strings.TrimSpace(agentSessionID)
}

// ObserveAgentSessionState completes pending plan first uses when a session's
// turn settles with a completed outcome: that is the first verified real
// agent-runtime call through the bound plan.
func (s *Service) ObserveAgentSessionState(ctx context.Context, input canonical.ReportSessionStateInput, _ canonical.ReportSessionStateReply) {
	if s == nil {
		return
	}
	lifecycle := input.State.TurnLifecycle
	if lifecycle == nil || strings.TrimSpace(lifecycle.Phase) != "settled" || lifecycle.Outcome == nil || strings.TrimSpace(*lifecycle.Outcome) != "completed" {
		return
	}
	runtime := s.modelPlanRuntime()
	if runtime.FirstUse == nil {
		return
	}
	key := pendingPlanFirstUseKey(input.WorkspaceID, input.AgentSessionID)
	runtime.mu.Lock()
	pending, ok := runtime.pending[key]
	if ok {
		delete(runtime.pending, key)
	}
	runtime.mu.Unlock()
	if !ok {
		return
	}
	if err := runtime.FirstUse.MarkFirstUse(ctx, strings.TrimSpace(input.WorkspaceID), pending.PlanID, pending.AgentTargetID, strings.TrimSpace(input.AgentSessionID), pending.Model); err != nil {
		slog.Warn("mark model plan first use failed",
			"event", "agent.model_plan.first_use_mark_failed",
			"workspace_id", strings.TrimSpace(input.WorkspaceID),
			"agent_session_id", strings.TrimSpace(input.AgentSessionID),
			"model_plan_id", pending.PlanID,
			"error", err,
		)
	}
}

// applyModelPlanComposerOverlay replaces the provider-native model options
// with the bound plan's models so the composer selector shows exactly what
// the plan authorizes, labeled with the source plan. Targets without an
// active plan binding keep their native options.
func (s *Service) applyModelPlanComposerOverlay(ctx context.Context, input ComposerOptionsInput, options ComposerOptions) ComposerOptions {
	endpoint, planModels := s.resolveModelPlanEndpoint(
		ctx,
		input.WorkspaceID,
		input.AgentTargetID,
		options.Provider,
		strings.TrimSpace(input.Settings.Model),
	)
	if endpoint == nil {
		return options
	}
	modelOptions := make([]ComposerConfigOptionValue, 0, len(planModels))
	for _, model := range planModels {
		modelOptions = append(modelOptions, ComposerConfigOptionValue{
			ID:          model.ID,
			Label:       model.Name,
			Value:       model.ID,
			Description: endpoint.PlanName,
		})
	}
	options.EffectiveSettings.Model = endpoint.Model
	options.ModelConfig = ComposerConfigOption{
		Configurable: len(modelOptions) > 0,
		CurrentValue: endpoint.Model,
		DefaultValue: endpoint.Model,
		Options:      modelOptions,
	}
	if options.RuntimeContext == nil {
		options.RuntimeContext = map[string]any{}
	}
	options.RuntimeContext["model"] = nullableString(endpoint.Model)
	options.RuntimeContext["modelPlan"] = map[string]any{
		"id":       endpoint.PlanID,
		"name":     endpoint.PlanName,
		"protocol": endpoint.Protocol,
	}
	return options
}

// SessionStateObservers fans one projection observer slot out to several
// observers.
type SessionStateObservers []SessionStateObserver

func (observers SessionStateObservers) ObserveAgentSessionState(ctx context.Context, input canonical.ReportSessionStateInput, reply canonical.ReportSessionStateReply) {
	for _, observer := range observers {
		if observer != nil {
			observer.ObserveAgentSessionState(ctx, input, reply)
		}
	}
}

// resolveCreateSessionModelForPlanOrProvider resolves and validates the
// session model for Create. A bound plan owns the model catalog: the request
// validates against the plan's model list and defaults to the plan-resolved
// model. Without a plan the provider-native resolution and validation apply.
func (s *Service) resolveCreateSessionModelForPlanOrProvider(ctx context.Context, workspaceID string, provider string, requestedModel string, input *CreateSessionInput) (*runtimeprep.ModelEndpointConfig, error) {
	planEndpoint, planModels := s.resolveModelPlanEndpoint(ctx, workspaceID, input.AgentTargetID, provider, requestedModel)
	if planEndpoint != nil {
		if err := validateModelAgainstPlan(provider, requestedModel, planModels); err != nil {
			return nil, err
		}
		if strings.TrimSpace(planEndpoint.Model) != "" {
			resolvedModel := planEndpoint.Model
			input.Model = &resolvedModel
		}
		return planEndpoint, nil
	}
	input.Model = s.resolveCreateSessionModel(ctx, provider, input.ProviderTargetRef, value(input.Cwd), input.Model)
	if providerTargetRefKind(input.ProviderTargetRef) != "agent_extension" {
		if err := s.validateComposerModelForCreate(ctx, provider, workspaceID, value(input.Cwd), requestedModel); err != nil {
			return nil, err
		}
	}
	return nil, nil
}
