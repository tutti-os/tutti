// Package modelbinding orchestrates per-workspace agent target model
// bindings: which model access plan, default model, and model usage policy an
// agent target uses for new sessions. It also resolves plan references so
// plan mutations can show impact and deletion stays guarded.
package modelbinding

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	modelpolicybiz "github.com/tutti-os/tutti/services/tuttid/biz/modelpolicy"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

var (
	ErrInvalidBindingInput = errors.New("invalid agent model binding input")
	ErrPlanNotUsable       = errors.New("model plan is not usable for binding")
	ErrModelNotInPlan      = errors.New("model is not part of the referenced plan")
	ErrPolicyNotUsable     = errors.New("model usage policy is not usable for binding")
	// ErrBindingReferenceUnusable reports that a referenced plan or policy
	// became unusable between validation and commit (the store's foreign keys
	// reject the write). SQLite does not identify which reference failed, so the
	// message stays neutral rather than claiming a specific one.
	ErrBindingReferenceUnusable = errors.New("agent model binding reference became unusable")
)

// TargetResolver confirms an agent target id exists before binding it and
// supplies display names for reference impact listings.
type TargetResolver interface {
	GetAgentTarget(ctx context.Context, id string) (agenttargetbiz.Target, error)
}

// PolicyLookup confirms a model usage policy exists in the workspace before a
// binding may reference it. It is a narrow read over biz types so binding
// validation never takes a modelbinding -> modelpolicy service dependency.
type PolicyLookup interface {
	GetModelPolicy(ctx context.Context, workspaceID string, policyID string) (modelpolicybiz.Policy, error)
}

type Service struct {
	Store    workspacedata.AgentModelBindingsStore
	Plans    workspacedata.ModelPlansStore
	Targets  TargetResolver
	Policies PolicyLookup
	Now      func() time.Time
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
	var target agenttargetbiz.Target
	if s.Targets != nil {
		var err error
		target, err = s.Targets.GetAgentTarget(ctx, binding.AgentTargetID)
		if err != nil {
			return modelbindingbiz.Binding{}, err
		}
	}
	if binding.IsZero() {
		if err := s.Store.DeleteAgentModelBinding(ctx, binding.WorkspaceID, binding.AgentTargetID); err != nil && !errors.Is(err, workspacedata.ErrAgentModelBindingNotFound) {
			return modelbindingbiz.Binding{}, err
		}
		return binding, nil
	}
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
		if s.Targets != nil {
			protocol, ok := agentproviderbiz.ModelPlanProtocol(target.Provider)
			if !ok {
				return modelbindingbiz.Binding{}, fmt.Errorf("%w: agent provider %q does not support model plan bindings", ErrPlanNotUsable, target.Provider)
			}
			if protocol != string(plan.Protocol) {
				return modelbindingbiz.Binding{}, fmt.Errorf("%w: agent provider %q requires %s protocol, plan uses %s", ErrPlanNotUsable, target.Provider, protocol, plan.Protocol)
			}
		}
	}
	if binding.ModelPolicyID != "" {
		if s.Policies == nil {
			// Fail closed: never persist a policy link that cannot be validated.
			return modelbindingbiz.Binding{}, errors.New("model usage policy validation is unavailable")
		}
		if _, err := s.Policies.GetModelPolicy(ctx, binding.WorkspaceID, binding.ModelPolicyID); err != nil {
			if errors.Is(err, workspacedata.ErrModelPolicyNotFound) {
				return modelbindingbiz.Binding{}, fmt.Errorf("%w: policy not found", ErrPolicyNotUsable)
			}
			return modelbindingbiz.Binding{}, err
		}
	}
	if err := s.Store.PutAgentModelBinding(ctx, binding); err != nil {
		if errors.Is(err, workspacedata.ErrAgentModelBindingReferenceInvalid) {
			// A plan or policy referenced by this binding disappeared between the
			// pre-validation above and the write; the store cannot say which, so
			// surface a neutral, stable error rather than blaming the plan.
			return modelbindingbiz.Binding{}, ErrBindingReferenceUnusable
		}
		return modelbindingbiz.Binding{}, err
	}
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
