package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

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

// AgentModelPlanRevisionSource resolves an immutable historical plan revision.
// The concrete workspace store implements this optional extension; keeping it
// separate preserves compatibility for tests and integrations that only need
// current-plan reads.
type AgentModelPlanRevisionSource interface {
	GetModelPlanRevision(ctx context.Context, workspaceID string, planID string, revision uint64) (modelplanbiz.Plan, error)
}

// modelPlanBindingRuntime holds the optional model plan integration wiring.
type modelPlanBindingRuntime struct {
	Bindings AgentModelBindingSource
	Plans    AgentModelPlanSource
}

const (
	modelConfigurationSourceModelPlan      = "model-plan"
	modelConfigurationSourceProviderNative = "provider-native"
)

// modelConfigurationRuntimeContext is the redaction-safe, authoritative
// description of the model source currently effective for one agent target.
// It deliberately excludes endpoint URLs and credentials.
type modelConfigurationRuntimeContext struct {
	AgentTargetID     string
	Source            string
	Fingerprint       string
	DefaultModel      string
	ModelPlanID       string
	ModelPlanRevision uint64
}

func (configuration modelConfigurationRuntimeContext) runtimeContext() map[string]any {
	result := map[string]any{
		"agentTargetId": strings.TrimSpace(configuration.AgentTargetID),
		"source":        configuration.Source,
		"fingerprint":   configuration.Fingerprint,
		"defaultModel":  nullableString(configuration.DefaultModel),
	}
	if strings.TrimSpace(configuration.ModelPlanID) != "" {
		result["modelPlanId"] = strings.TrimSpace(configuration.ModelPlanID)
		result["modelPlanRevision"] = configuration.ModelPlanRevision
	}
	return result
}

// modelPlanResolution keeps endpoint selection and the redaction-safe
// composer configuration derived from the same binding/plan read.
type modelPlanResolution struct {
	Endpoint           *runtimeprep.ModelEndpointConfig
	Models             []modelplanbiz.Model
	ModelConfiguration modelConfigurationRuntimeContext
}

// applyRequestedModelPlan makes an explicit task/run assignment authoritative
// over the Agent's default Plan. Credentials remain daemon-owned, and the
// ordinary Plan resolution path below still validates protocol, enabled state,
// revision, and the selected model before runtime launch.
func (s *Service) applyRequestedModelPlan(
	ctx context.Context,
	workspaceID string,
	input *CreateSessionInput,
) error {
	if input == nil {
		return ErrInvalidArgument
	}
	planID := strings.TrimSpace(value(input.ModelPlanID))
	if planID == "" {
		return nil
	}
	runtime := s.modelPlanRuntime()
	if runtime.Plans == nil {
		return fmt.Errorf("%w: model plan resolver is unavailable", ErrInvalidArgument)
	}
	plan, err := runtime.Plans.GetModelPlan(
		ctx,
		strings.TrimSpace(workspaceID),
		planID,
	)
	if err != nil {
		return fmt.Errorf("%w: resolve requested model plan: %v", ErrInvalidArgument, err)
	}
	input.ResolvedModelPlan = &plan
	return nil
}

type modelConfigurationFingerprintPayload struct {
	Provider            string   `json:"provider"`
	AgentTargetID       string   `json:"agentTargetId"`
	Source              string   `json:"source"`
	ModelPlanID         string   `json:"modelPlanId,omitempty"`
	ModelPlanRevision   uint64   `json:"modelPlanRevision,omitempty"`
	Protocol            string   `json:"protocol,omitempty"`
	BindingDefaultModel string   `json:"bindingDefaultModel,omitempty"`
	PlanDefaultModel    string   `json:"planDefaultModel,omitempty"`
	ModelIDs            []string `json:"modelIds,omitempty"`
}

func newProviderNativeModelConfiguration(provider string, agentTargetID string) modelConfigurationRuntimeContext {
	payload := modelConfigurationFingerprintPayload{
		Provider:      agentprovider.Normalize(provider),
		AgentTargetID: strings.TrimSpace(agentTargetID),
		Source:        modelConfigurationSourceProviderNative,
	}
	return modelConfigurationRuntimeContext{
		AgentTargetID: payload.AgentTargetID,
		Source:        payload.Source,
		Fingerprint:   fingerprintModelConfiguration(payload),
	}
}

func newModelPlanModelConfiguration(provider string, agentTargetID string, binding modelbindingbiz.Binding, plan modelplanbiz.Plan) modelConfigurationRuntimeContext {
	modelIDs := make([]string, 0, len(plan.Models))
	for _, model := range plan.Models {
		modelIDs = append(modelIDs, strings.TrimSpace(model.ID))
	}
	bindingDefaultModel := strings.TrimSpace(binding.DefaultModel)
	if !modelplanbiz.ModelsContain(plan.Models, bindingDefaultModel) {
		bindingDefaultModel = ""
	}
	payload := modelConfigurationFingerprintPayload{
		Provider:            agentprovider.Normalize(provider),
		AgentTargetID:       strings.TrimSpace(agentTargetID),
		Source:              modelConfigurationSourceModelPlan,
		ModelPlanID:         strings.TrimSpace(plan.ID),
		ModelPlanRevision:   plan.Revision,
		Protocol:            string(plan.Protocol),
		BindingDefaultModel: bindingDefaultModel,
		PlanDefaultModel:    strings.TrimSpace(plan.DefaultModel),
		ModelIDs:            modelIDs,
	}
	return modelConfigurationRuntimeContext{
		AgentTargetID:     payload.AgentTargetID,
		Source:            payload.Source,
		Fingerprint:       fingerprintModelConfiguration(payload),
		DefaultModel:      resolvePlanDefaultModel(plan, binding),
		ModelPlanID:       payload.ModelPlanID,
		ModelPlanRevision: payload.ModelPlanRevision,
	}
}

func fingerprintModelConfiguration(payload modelConfigurationFingerprintPayload) string {
	// A struct (rather than a map) makes the serialized field order stable. All
	// fields are already redaction-safe; notably BaseURL and APIKey are absent.
	encoded, _ := json.Marshal(payload)
	sum := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func (s *Service) modelPlanRuntime() *modelPlanBindingRuntime {
	return &s.modelPlanBinding
}

// ConfigureModelPlanBinding wires the optional model plan integration.
func (s *Service) ConfigureModelPlanBinding(bindings AgentModelBindingSource, plans AgentModelPlanSource) {
	s.modelPlanBinding.Bindings = bindings
	s.modelPlanBinding.Plans = plans
}

// modelPlanProtocolForProvider reads the endpoint-injection strategy declared
// by the canonical provider registry. Providers without that strategy keep
// their native credential source.
func modelPlanProtocolForProvider(provider string) (modelplanbiz.Protocol, bool) {
	protocol, ok := agentprovider.ModelPlanProtocol(provider)
	return modelplanbiz.Protocol(protocol), ok
}

// planModelComposerValue renders a plan-domain model id as the composer and
// session-settings value for one provider, dispatching on the registry-declared
// model addressing strategy. Provider-prefixed runtimes (OpenCode) resolve
// models against the session-scoped provider config injected by runtimeprep,
// so their values carry the injected provider namespace; every other provider
// consumes raw plan model ids.
func planModelComposerValue(provider string, modelID string) string {
	if agentprovider.ModelPlanModelAddressingProviderPrefixed(provider) {
		return runtimeprep.OpenCodePlanModelValue(modelID)
	}
	return strings.TrimSpace(modelID)
}

// planModelIDFromComposerValue maps a composer/settings model value back to
// the plan-domain model id (inverse of planModelComposerValue). Values without
// the injected namespace pass through unchanged, so raw ids stay valid.
func planModelIDFromComposerValue(provider string, value string) string {
	if agentprovider.ModelPlanModelAddressingProviderPrefixed(provider) {
		return runtimeprep.OpenCodePlanModelID(value)
	}
	return strings.TrimSpace(value)
}

// modelEndpointModels projects the plan's model list into the redaction-safe
// endpoint DTO so provider preparers can materialize a full session catalog.
func modelEndpointModels(models []modelplanbiz.Model) []runtimeprep.ModelEndpointModel {
	if len(models) == 0 {
		return nil
	}
	endpointModels := make([]runtimeprep.ModelEndpointModel, 0, len(models))
	for _, model := range models {
		endpointModels = append(endpointModels, runtimeprep.ModelEndpointModel{
			ID:   model.ID,
			Name: model.Name,
		})
	}
	return endpointModels
}

// resolveModelPlanEndpoint resolves the injected endpoint for one session
// launch plus the plan's model list for validation. It returns nil when the
// target has no usable plan binding.
func (s *Service) resolveModelPlanEndpoint(ctx context.Context, workspaceID string, agentTargetID string, provider string, requestedModel string) (*runtimeprep.ModelEndpointConfig, []modelplanbiz.Model) {
	resolution := s.resolveModelPlan(ctx, workspaceID, agentTargetID, provider, requestedModel)
	return resolution.Endpoint, resolution.Models
}

// resolveModelPlan returns both the secret-bearing runtime endpoint (when a
// usable plan is bound) and a redaction-safe model configuration fingerprint
// for composer reconciliation. Unsupported, missing, disabled, and
// protocol-mismatched bindings all resolve to provider-native configuration.
func (s *Service) resolveModelPlan(ctx context.Context, workspaceID string, agentTargetID string, provider string, requestedModel string) modelPlanResolution {
	provider = agentprovider.Normalize(provider)
	agentTargetID = strings.TrimSpace(agentTargetID)
	providerNative := modelPlanResolution{
		ModelConfiguration: newProviderNativeModelConfiguration(provider, agentTargetID),
	}
	runtime := s.modelPlanRuntime()
	if runtime.Bindings == nil || runtime.Plans == nil {
		return providerNative
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" || agentTargetID == "" {
		return providerNative
	}
	requiredProtocol, supported := modelPlanProtocolForProvider(provider)
	if !supported {
		return providerNative
	}
	binding, err := runtime.Bindings.GetAgentModelBinding(ctx, workspaceID, agentTargetID)
	if err != nil || strings.TrimSpace(binding.ModelPlanID) == "" {
		return providerNative
	}
	plan, err := runtime.Plans.GetModelPlan(ctx, workspaceID, binding.ModelPlanID)
	if err != nil {
		slog.Warn("agent model binding references missing plan",
			"event", "agent.model_plan.binding_plan_missing",
			"workspace_id", workspaceID,
			"agent_target_id", agentTargetID,
			"model_plan_id", binding.ModelPlanID,
		)
		return providerNative
	}
	if !plan.Enabled {
		slog.Info("agent model binding plan is disabled; using provider-native credentials",
			"event", "agent.model_plan.binding_plan_disabled",
			"workspace_id", workspaceID,
			"agent_target_id", agentTargetID,
			"model_plan_id", plan.ID,
		)
		return providerNative
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
		return providerNative
	}
	model := resolvePlanSessionModel(plan, binding, planModelIDFromComposerValue(provider, requestedModel))
	return modelPlanResolution{
		Endpoint: &runtimeprep.ModelEndpointConfig{
			PlanID:              plan.ID,
			PlanName:            plan.Name,
			Protocol:            string(plan.Protocol),
			BaseURL:             plan.BaseURL,
			APIKey:              plan.APIKey,
			Model:               planModelComposerValue(provider, model),
			Models:              modelEndpointModels(plan.Models),
			PlanUpdatedAtUnixMS: plan.UpdatedAt.UnixMilli(),
		},
		Models:             modelplanbiz.CloneModels(plan.Models),
		ModelConfiguration: newModelPlanModelConfiguration(provider, agentTargetID, binding, plan),
	}
}

// validateModelAgainstPlan rejects an explicitly requested model that the
// bound plan does not expose. An empty request always resolves to the plan
// default.
func validateModelAgainstPlan(provider string, requestedModel string, planModels []modelplanbiz.Model) error {
	requestedModel = planModelIDFromComposerValue(provider, requestedModel)
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
	if defaultModel := resolvePlanDefaultModel(plan, binding); defaultModel != "" {
		return defaultModel
	}
	return requestedModel
}

func resolvePlanDefaultModel(plan modelplanbiz.Plan, binding modelbindingbiz.Binding) string {
	if binding.DefaultModel != "" && modelplanbiz.ModelsContain(plan.Models, binding.DefaultModel) {
		return strings.TrimSpace(binding.DefaultModel)
	}
	if plan.DefaultModel != "" {
		return strings.TrimSpace(plan.DefaultModel)
	}
	if len(plan.Models) > 0 {
		return strings.TrimSpace(plan.Models[0].ID)
	}
	return ""
}

// applyModelPlanComposerOverlay replaces the provider-native model options
// with the bound plan's models so the composer selector shows exactly what
// the plan authorizes, labeled with the source plan. Targets without an
// active plan binding keep their native options.
func (s *Service) applyModelPlanComposerOverlay(ctx context.Context, input ComposerOptionsInput, options ComposerOptions) ComposerOptions {
	resolution := s.resolveModelPlan(
		ctx,
		input.WorkspaceID,
		input.AgentTargetID,
		options.Provider,
		strings.TrimSpace(input.Settings.Model),
	)
	return applyResolvedModelPlanComposerOverlay(options, resolution)
}

func applyResolvedModelPlanComposerOverlay(options ComposerOptions, resolution modelPlanResolution) ComposerOptions {
	endpoint := resolution.Endpoint
	if endpoint == nil {
		return options
	}
	planModels := resolution.Models
	modelOptions := make([]ComposerConfigOptionValue, 0, len(planModels))
	for _, model := range planModels {
		value := planModelComposerValue(options.Provider, model.ID)
		modelOptions = append(modelOptions, ComposerConfigOptionValue{
			ID:          value,
			Label:       model.Name,
			Value:       value,
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
	options.RuntimeContext["configOptions"] = composerConfigOptions(
		options.Provider,
		options.EffectiveSettings,
		modelOptions,
		options.ReasoningConfig.Options,
		nil,
	)
	options.RuntimeContext["modelPlan"] = map[string]any{
		"id":       resolution.ModelConfiguration.ModelPlanID,
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
func (s *Service) resolveCreateSessionModelForPlanOrProvider(ctx context.Context, workspaceID string, provider string, requestedModel string, input *CreateSessionInput) (modelPlanResolution, error) {
	resolution := modelPlanResolution{}
	if input.IgnoreModelPlanBinding {
		resolution.ModelConfiguration = newProviderNativeModelConfiguration(provider, input.AgentTargetID)
	} else if input.ResolvedModelPlan != nil {
		var err error
		resolution, err = resolveProvidedModelPlan(provider, input.AgentTargetID, *input.ResolvedModelPlan, input.AgentDefaultModel, requestedModel)
		if err != nil {
			return modelPlanResolution{}, err
		}
	} else {
		resolution = s.resolveModelPlan(ctx, workspaceID, input.AgentTargetID, provider, requestedModel)
	}
	if resolution.Endpoint != nil {
		if err := validateModelAgainstPlan(provider, requestedModel, resolution.Models); err != nil {
			return modelPlanResolution{}, err
		}
		if strings.TrimSpace(resolution.Endpoint.Model) != "" {
			resolvedModel := resolution.Endpoint.Model
			input.Model = &resolvedModel
		}
		return resolution, nil
	}
	input.Model = s.resolveCreateSessionModel(ctx, provider, input.ProviderTargetRef, value(input.Cwd), input.Model)
	if providerTargetRefKind(input.ProviderTargetRef) != "agent_extension" {
		if err := s.validateComposerModelForCreate(ctx, provider, workspaceID, value(input.Cwd), requestedModel); err != nil {
			return modelPlanResolution{}, err
		}
	}
	return resolution, nil
}

// resolveProvidedModelPlan consumes the exact secret-bearing plan resolved by
// a WorkspaceAgent. It deliberately bypasses legacy AgentTarget bindings.
func resolveProvidedModelPlan(provider string, agentTargetID string, plan modelplanbiz.Plan, configuredDefaultModel string, requestedModel string) (modelPlanResolution, error) {
	if strings.TrimSpace(plan.ID) == "" {
		return modelPlanResolution{}, fmt.Errorf("%w: workspace agent model plan id is missing", ErrInvalidArgument)
	}
	requiredProtocol, supported := modelPlanProtocolForProvider(provider)
	if !supported || plan.Protocol != requiredProtocol {
		return modelPlanResolution{}, fmt.Errorf("%w: workspace agent model plan protocol does not match provider", ErrInvalidArgument)
	}
	if !plan.Enabled {
		return modelPlanResolution{}, fmt.Errorf("%w: workspace agent model plan is disabled", ErrInvalidArgument)
	}
	if plan.Revision == 0 {
		return modelPlanResolution{}, fmt.Errorf("%w: workspace agent model plan revision is missing", ErrInvalidArgument)
	}
	if err := validateModelAgainstPlan(provider, requestedModel, plan.Models); err != nil {
		return modelPlanResolution{}, err
	}
	binding := modelbindingbiz.Binding{DefaultModel: strings.TrimSpace(configuredDefaultModel)}
	model := resolvePlanSessionModel(plan, binding, planModelIDFromComposerValue(provider, requestedModel))
	return modelPlanResolution{
		Endpoint: &runtimeprep.ModelEndpointConfig{
			PlanID:              plan.ID,
			PlanName:            plan.Name,
			Protocol:            string(plan.Protocol),
			BaseURL:             plan.BaseURL,
			APIKey:              plan.APIKey,
			Model:               planModelComposerValue(provider, model),
			Models:              modelEndpointModels(plan.Models),
			PlanUpdatedAtUnixMS: plan.UpdatedAt.UnixMilli(),
		},
		Models:             modelplanbiz.CloneModels(plan.Models),
		ModelConfiguration: newModelPlanModelConfiguration(provider, agentTargetID, binding, plan),
	}, nil
}
