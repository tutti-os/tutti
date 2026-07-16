// Package modelbinding orchestrates per-workspace agent target model
// bindings: which model access plan, default model, and model usage policy an
// agent target uses for new sessions. It also resolves plan references so
// plan mutations can show impact and deletion stays guarded.
package modelbinding

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

var (
	ErrInvalidBindingInput = errors.New("invalid agent model binding input")
	ErrPlanNotUsable       = errors.New("model plan is not usable for binding")
	ErrModelNotInPlan      = errors.New("model is not part of the referenced plan")
)

// TargetResolver confirms an agent target id exists before binding it and
// supplies display names for reference impact listings.
type TargetResolver interface {
	GetAgentTarget(ctx context.Context, id string) (agenttargetbiz.Target, error)
}

// ConfigurationChangePublisher notifies workspace clients that model
// composer options for one or more agent targets are stale.
type ConfigurationChangePublisher interface {
	PublishAgentModelConfigurationChanged(ctx context.Context, workspaceID string, agentTargetIDs []string, defaultModels map[string]string, resetComposerModel bool) error
}

type Service struct {
	Store                  workspacedata.AgentModelBindingsStore
	Plans                  workspacedata.ModelPlansStore
	Targets                TargetResolver
	ConfigurationPublisher ConfigurationChangePublisher
	Now                    func() time.Time
}

type SetBindingInput struct {
	WorkspaceID   string
	AgentTargetID string
	ModelPlanID   string
	DefaultModel  string
	ModelPolicyID string
}

// SetBinding stores or clears one agent target binding. An all-empty input
// removes the binding. Changes affect only sessions that have not started.
func (s *Service) SetBinding(ctx context.Context, input SetBindingInput) (modelbindingbiz.Binding, error) {
	binding, err := modelbindingbiz.Normalize(modelbindingbiz.Binding{
		WorkspaceID:   input.WorkspaceID,
		AgentTargetID: input.AgentTargetID,
		ModelPlanID:   input.ModelPlanID,
		DefaultModel:  input.DefaultModel,
		ModelPolicyID: input.ModelPolicyID,
		UpdatedAt:     s.now(),
	})
	if err != nil {
		return modelbindingbiz.Binding{}, fmt.Errorf("%w: %w", ErrInvalidBindingInput, err)
	}
	var target *agenttargetbiz.Target
	if s.Targets != nil {
		resolvedTarget, err := s.Targets.GetAgentTarget(ctx, binding.AgentTargetID)
		if err != nil {
			return modelbindingbiz.Binding{}, err
		}
		target = &resolvedTarget
	}
	if binding.IsZero() {
		if err := s.Store.DeleteAgentModelBinding(ctx, binding.WorkspaceID, binding.AgentTargetID); err != nil && !errors.Is(err, workspacedata.ErrAgentModelBindingNotFound) {
			return modelbindingbiz.Binding{}, err
		}
		s.publishConfigurationChanged(ctx, binding.WorkspaceID, []string{binding.AgentTargetID}, map[string]string{binding.AgentTargetID: ""}, true)
		return binding, nil
	}
	effectiveDefaultModel := ""
	if binding.ModelPlanID != "" {
		plan, err := s.Plans.GetModelPlan(ctx, binding.WorkspaceID, binding.ModelPlanID)
		if err != nil {
			if errors.Is(err, workspacedata.ErrModelPlanNotFound) {
				return modelbindingbiz.Binding{}, fmt.Errorf("%w: plan not found", ErrPlanNotUsable)
			}
			return modelbindingbiz.Binding{}, err
		}
		if binding.DefaultModel != "" && !modelplanbiz.ModelsContain(plan.Models, binding.DefaultModel) {
			return modelbindingbiz.Binding{}, ErrModelNotInPlan
		}
		effectiveDefaultModel = resolveEffectiveDefaultModelForTarget(binding, plan, target)
	}
	if err := s.Store.PutAgentModelBinding(ctx, binding); err != nil {
		return modelbindingbiz.Binding{}, err
	}
	s.publishConfigurationChanged(
		ctx,
		binding.WorkspaceID,
		[]string{binding.AgentTargetID},
		map[string]string{binding.AgentTargetID: effectiveDefaultModel},
		true,
	)
	return binding, nil
}

func (s *Service) GetBinding(ctx context.Context, workspaceID string, agentTargetID string) (modelbindingbiz.Binding, error) {
	return s.Store.GetAgentModelBinding(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(agentTargetID))
}

func (s *Service) ListBindings(ctx context.Context, workspaceID string) ([]modelbindingbiz.Binding, error) {
	bindings, err := s.Store.ListAgentModelBindings(ctx, strings.TrimSpace(workspaceID))
	if err != nil {
		return nil, err
	}
	if bindings == nil {
		bindings = []modelbindingbiz.Binding{}
	}
	return bindings, nil
}

// ResolveBoundAgentTargetDefaultModels reports the effective default model for
// every agent target currently backed by a model plan.
func (s *Service) ResolveBoundAgentTargetDefaultModels(ctx context.Context, workspaceID string, planID string) (map[string]string, error) {
	bindings, err := s.Store.ListAgentModelBindingsByPlan(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(planID))
	if err != nil {
		return nil, err
	}
	defaultModels := make(map[string]string, len(bindings))
	if len(bindings) == 0 {
		return defaultModels, nil
	}
	plan, err := s.Plans.GetModelPlan(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(planID))
	if err != nil {
		return nil, err
	}
	for _, binding := range bindings {
		targetID := strings.TrimSpace(binding.AgentTargetID)
		if targetID == "" {
			continue
		}
		var target *agenttargetbiz.Target
		if s.Targets != nil {
			resolvedTarget, err := s.Targets.GetAgentTarget(ctx, targetID)
			if err == nil {
				target = &resolvedTarget
			}
		}
		defaultModels[targetID] = resolveEffectiveDefaultModelForTarget(binding, plan, target)
	}
	return defaultModels, nil
}

// ListModelPlanReferences implements the model plan reference contract for
// agent target bindings.
func (s *Service) ListModelPlanReferences(ctx context.Context, workspaceID string, planID string) ([]modelplanbiz.Reference, error) {
	bindings, err := s.Store.ListAgentModelBindingsByPlan(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(planID))
	if err != nil {
		return nil, err
	}
	references := make([]modelplanbiz.Reference, 0, len(bindings))
	for _, binding := range bindings {
		reference := modelplanbiz.Reference{
			Kind: modelplanbiz.ReferenceAgentTarget,
			ID:   binding.AgentTargetID,
			Role: "default",
		}
		if s.Targets != nil {
			if target, err := s.Targets.GetAgentTarget(ctx, binding.AgentTargetID); err == nil {
				reference.Name = target.Name
			}
		}
		references = append(references, reference)
	}
	return references, nil
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func resolveEffectiveDefaultModel(binding modelbindingbiz.Binding, plan modelplanbiz.Plan) string {
	if !plan.Enabled {
		return ""
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
	return ""
}

func resolveEffectiveDefaultModelForTarget(binding modelbindingbiz.Binding, plan modelplanbiz.Plan, target *agenttargetbiz.Target) string {
	if target != nil {
		requiredProtocol, supported := modelPlanProtocolForAgentProvider(target.Provider)
		if !supported || plan.Protocol != requiredProtocol {
			return ""
		}
	}
	return resolveEffectiveDefaultModel(binding, plan)
}

func modelPlanProtocolForAgentProvider(provider string) (modelplanbiz.Protocol, bool) {
	protocol, ok := agentproviderbiz.ModelPlanProtocol(provider)
	return modelplanbiz.Protocol(protocol), ok
}

func (s *Service) publishConfigurationChanged(ctx context.Context, workspaceID string, agentTargetIDs []string, defaultModels map[string]string, resetComposerModel bool) {
	if s.ConfigurationPublisher == nil || len(agentTargetIDs) == 0 {
		return
	}
	if err := s.ConfigurationPublisher.PublishAgentModelConfigurationChanged(
		ctx,
		workspaceID,
		agentTargetIDs,
		defaultModels,
		resetComposerModel,
	); err != nil {
		slog.Warn("agent model binding configuration publish failed",
			"event", "agent.model_configuration.changed_publish_failed",
			"workspaceId", workspaceID,
			"agentTargetIds", agentTargetIDs,
			"error", err,
		)
	}
}
