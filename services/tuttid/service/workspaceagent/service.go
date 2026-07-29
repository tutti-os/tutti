// Package workspaceagent orchestrates workspace-scoped Agent configuration
// CRUD, reference validation, public Harness projection, and strict runtime
// resolution.
package workspaceagent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

var (
	ErrInvalidInput                = errors.New("invalid workspace agent input")
	ErrHarnessUnavailable          = errors.New("workspace agent harness is unavailable")
	ErrHarnessDisabled             = errors.New("workspace agent harness is disabled")
	ErrPlanNotUsable               = errors.New("workspace agent model plan is not usable")
	ErrModelNotInPlan              = errors.New("workspace agent default model is not in the model plan")
	ErrHarnessPlanProtocolMismatch = errors.New("workspace agent harness does not support the model plan protocol")
)

type Store interface {
	DeleteWorkspaceAgent(context.Context, string, string) error
	GetWorkspaceAgent(context.Context, string, string) (workspaceagentbiz.Agent, error)
	ListWorkspaceAgents(context.Context, string) ([]workspaceagentbiz.Agent, error)
	ListWorkspaceAgentsByModelPlan(context.Context, string, string) ([]workspaceagentbiz.Agent, error)
	PutWorkspaceAgent(context.Context, workspaceagentbiz.Agent) error
}

type TargetResolver interface {
	GetAgentTarget(context.Context, string) (agenttargetbiz.Target, error)
}

type PlanResolver interface {
	GetModelPlan(context.Context, string, string) (modelplanbiz.Plan, error)
}

type WorkspaceResolver interface {
	Get(context.Context, string) (workspacebiz.Summary, error)
}

type ConfigurationChangePublisher interface {
	PublishAgentModelConfigurationChanged(context.Context, string, []string, map[string]string, bool) error
}

// Service owns the WorkspaceAgent aggregate. Resolve is intentionally a
// strict runtime boundary, while List/Get remain repair-friendly when a
// referenced Harness target has disappeared.
type Service struct {
	Store      Store
	Targets    TargetResolver
	Plans      PlanResolver
	Workspaces WorkspaceResolver
	Publisher  ConfigurationChangePublisher
	Now        func() time.Time
	NewID      func() string
}

type PutInput struct {
	WorkspaceID          string
	AgentID              string
	Name                 string
	Description          string
	HarnessAgentTargetID string
	ModelPlanID          string
	DefaultModel         string
	ModelFallbacks       []workspaceagentbiz.ModelRef
	Instructions         string
	CallConditions       []string
	CapabilitiesExplicit *bool
	Skills               []string
	Tools                []string
}

func (s *Service) List(ctx context.Context, workspaceID string) ([]workspaceagentbiz.View, error) {
	if s.Store == nil {
		return nil, errors.New("workspace agent store is not configured")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil, fmt.Errorf("%w: workspace id is required", ErrInvalidInput)
	}
	agents, err := s.Store.ListWorkspaceAgents(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	views := make([]workspaceagentbiz.View, 0, len(agents))
	for _, agent := range agents {
		view, err := s.view(ctx, agent)
		if err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	return views, nil
}

func (s *Service) Get(ctx context.Context, workspaceID string, agentID string) (workspaceagentbiz.View, error) {
	agent, err := s.get(ctx, workspaceID, agentID)
	if err != nil {
		return workspaceagentbiz.View{}, err
	}
	return s.view(ctx, agent)
}

func (s *Service) Create(ctx context.Context, input PutInput) (workspaceagentbiz.View, error) {
	if s.Store == nil {
		return workspaceagentbiz.View{}, errors.New("workspace agent store is not configured")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if err := s.ensureWorkspace(ctx, workspaceID); err != nil {
		return workspaceagentbiz.View{}, err
	}
	now := s.now()
	capabilitiesExplicit := putCapabilitiesExplicit(input, false)
	skills, tools := putCapabilitySelections(input, capabilitiesExplicit)
	agent := workspaceagentbiz.Agent{
		ID:                   s.newID(),
		WorkspaceID:          workspaceID,
		Name:                 input.Name,
		Description:          input.Description,
		HarnessAgentTargetID: input.HarnessAgentTargetID,
		ModelPlanID:          input.ModelPlanID,
		DefaultModel:         input.DefaultModel,
		ModelFallbacks:       input.ModelFallbacks,
		Instructions:         input.Instructions,
		CallConditions:       input.CallConditions,
		CapabilitiesExplicit: capabilitiesExplicit,
		Skills:               skills,
		Tools:                tools,
		Source:               workspaceagentbiz.SourceUser,
		Revision:             1,
		CreatedAt:            now,
		UpdatedAt:            now,
	}
	normalized, err := workspaceagentbiz.Normalize(agent)
	if err != nil {
		return workspaceagentbiz.View{}, fmt.Errorf("%w: %w", ErrInvalidInput, err)
	}
	if err := s.validateReferences(ctx, normalized); err != nil {
		return workspaceagentbiz.View{}, err
	}
	if err := s.Store.PutWorkspaceAgent(ctx, normalized); err != nil {
		return workspaceagentbiz.View{}, err
	}
	logWorkspaceAgentLifecycle("created", normalized)
	s.publishConfigurationChanged(ctx, normalized, s.configurationDefaultModel(ctx, normalized), true)
	return s.view(ctx, normalized)
}

func (s *Service) Update(ctx context.Context, input PutInput) (workspaceagentbiz.View, error) {
	existing, err := s.get(ctx, input.WorkspaceID, input.AgentID)
	if err != nil {
		return workspaceagentbiz.View{}, err
	}
	updated := existing
	updated.Name = input.Name
	updated.Description = input.Description
	updated.HarnessAgentTargetID = input.HarnessAgentTargetID
	updated.ModelPlanID = input.ModelPlanID
	updated.DefaultModel = input.DefaultModel
	updated.ModelFallbacks = input.ModelFallbacks
	updated.Instructions = input.Instructions
	updated.CallConditions = input.CallConditions
	updated.CapabilitiesExplicit = putCapabilitiesExplicit(input, existing.CapabilitiesExplicit)
	updated.Skills, updated.Tools = putCapabilitySelections(input, updated.CapabilitiesExplicit)
	updated.Revision++
	updated.UpdatedAt = s.now()
	normalized, err := workspaceagentbiz.Normalize(updated)
	if err != nil {
		return workspaceagentbiz.View{}, fmt.Errorf("%w: %w", ErrInvalidInput, err)
	}
	if err := s.validateReferences(ctx, normalized); err != nil {
		return workspaceagentbiz.View{}, err
	}
	if err := s.Store.PutWorkspaceAgent(ctx, normalized); err != nil {
		return workspaceagentbiz.View{}, err
	}
	logWorkspaceAgentLifecycle("updated", normalized)
	resetComposerModel := existing.HarnessAgentTargetID != normalized.HarnessAgentTargetID ||
		existing.ModelPlanID != normalized.ModelPlanID ||
		existing.DefaultModel != normalized.DefaultModel ||
		!slices.Equal(existing.ModelFallbacks, normalized.ModelFallbacks)
	s.publishConfigurationChanged(ctx, normalized, s.configurationDefaultModel(ctx, normalized), resetComposerModel)
	return s.view(ctx, normalized)
}

func putCapabilitiesExplicit(input PutInput, current bool) bool {
	if input.CapabilitiesExplicit != nil {
		return *input.CapabilitiesExplicit
	}
	// Before this field existed, any non-empty selection was an explicit
	// allowlist. Preserve that behavior for rolling desktop/daemon upgrades.
	if len(workspaceagentbiz.NormalizeStringList(input.Skills)) > 0 ||
		len(workspaceagentbiz.NormalizeStringList(input.Tools)) > 0 {
		return true
	}
	return current
}

func putCapabilitySelections(input PutInput, explicit bool) ([]string, []string) {
	if !explicit {
		return nil, nil
	}
	return input.Skills, input.Tools
}

func (s *Service) Delete(ctx context.Context, workspaceID string, agentID string) error {
	existing, err := s.get(ctx, workspaceID, agentID)
	if err != nil {
		return err
	}
	if err := s.Store.DeleteWorkspaceAgent(ctx, existing.WorkspaceID, existing.ID); err != nil {
		return err
	}
	// Deletion is deliberately not blocked by existing session references:
	// stale ids degrade gracefully in the GUI (composer options settle into a
	// recoverable error, and session ingestion drops the dangling reference
	// with a diagnostic). This audit event is what ties those later
	// "agent_target_id.dropped" ingestion warnings back to a user action, so
	// it logs the full pre-delete configuration rather than a zero-value row.
	logWorkspaceAgentLifecycle("deleted", existing)
	s.publishConfigurationChanged(ctx, existing, "", true)
	return nil
}

// Resolve returns the exact WorkspaceAgent-owned runtime configuration. It is
// strict: missing/disabled Harnesses and disabled plans are rejected before a
// process starts.
func (s *Service) Resolve(ctx context.Context, workspaceID string, agentID string) (workspaceagentbiz.Resolved, error) {
	agent, err := s.get(ctx, workspaceID, agentID)
	if err != nil {
		return workspaceagentbiz.Resolved{}, err
	}
	if s.Targets == nil {
		return workspaceagentbiz.Resolved{}, errors.New("workspace agent target resolver is not configured")
	}
	target, err := s.Targets.GetAgentTarget(ctx, agent.HarnessAgentTargetID)
	if err != nil {
		if errors.Is(err, workspacedata.ErrAgentTargetNotFound) {
			return workspaceagentbiz.Resolved{}, fmt.Errorf("%w: %s", ErrHarnessUnavailable, agent.HarnessAgentTargetID)
		}
		return workspaceagentbiz.Resolved{}, err
	}
	target, err = agenttargetbiz.NormalizeTarget(target)
	if err != nil {
		return workspaceagentbiz.Resolved{}, fmt.Errorf("%w: invalid harness target: %v", ErrHarnessUnavailable, err)
	}
	if !target.Enabled {
		return workspaceagentbiz.Resolved{}, ErrHarnessDisabled
	}
	resolved := workspaceagentbiz.Resolved{
		Agent:         workspaceagentbiz.Clone(agent),
		HarnessTarget: target,
	}
	if agent.ModelPlanID == "" {
		return resolved, nil
	}
	if s.Plans == nil {
		return workspaceagentbiz.Resolved{}, errors.New("workspace agent model plan resolver is not configured")
	}
	plan, model, err := s.resolveModelRoute(ctx, agent, target)
	if err != nil {
		return workspaceagentbiz.Resolved{}, err
	}
	resolved.ModelPlan = &plan
	resolved.EffectiveModel = model
	return resolved, nil
}

// ListModelPlanReferences blocks deletion while a WorkspaceAgent still uses a
// plan and gives callers the named impact list.
func (s *Service) ListModelPlanReferences(ctx context.Context, workspaceID string, planID string) ([]modelplanbiz.Reference, error) {
	if s.Store == nil {
		return nil, errors.New("workspace agent store is not configured")
	}
	agents, err := s.Store.ListWorkspaceAgentsByModelPlan(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(planID))
	if err != nil {
		return nil, err
	}
	references := make([]modelplanbiz.Reference, 0, len(agents))
	for _, agent := range agents {
		role := "fallback"
		if agent.ModelPlanID == strings.TrimSpace(planID) {
			role = "default"
		}
		references = append(references, modelplanbiz.Reference{
			Kind: modelplanbiz.ReferenceWorkspaceAgent,
			ID:   agent.ID,
			Name: agent.Name,
			Role: role,
		})
	}
	return references, nil
}

// ResolveBoundAgentTargetDefaultModels reports the effective default model for
// each WorkspaceAgent using one plan. It participates in the same
// configuration-change fan-out as legacy fixed-target bindings.
func (s *Service) ResolveBoundAgentTargetDefaultModels(ctx context.Context, workspaceID string, planID string) (map[string]string, error) {
	if s.Store == nil {
		return nil, errors.New("workspace agent store is not configured")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	planID = strings.TrimSpace(planID)
	agents, err := s.Store.ListWorkspaceAgentsByModelPlan(ctx, workspaceID, planID)
	if err != nil {
		return nil, err
	}
	result := make(map[string]string, len(agents))
	if len(agents) == 0 {
		return result, nil
	}
	if s.Plans == nil {
		return nil, errors.New("workspace agent model plan resolver is not configured")
	}
	for _, agent := range agents {
		defaultModel := ""
		if s.Targets != nil {
			target, targetErr := s.Targets.GetAgentTarget(ctx, agent.HarnessAgentTargetID)
			if targetErr == nil {
				_, defaultModel, _ = s.resolveModelRoute(ctx, agent, target)
			}
		}
		result[agent.ID] = defaultModel
	}
	return result, nil
}

// ValidateAutomationAgentReference is the strict AutomationRule reference
// boundary. A rule cannot target an unlaunchable Agent.
func (s *Service) ValidateAutomationAgentReference(ctx context.Context, workspaceID string, agentID string) error {
	_, err := s.Resolve(ctx, workspaceID, agentID)
	return err
}

func (s *Service) get(ctx context.Context, workspaceID string, agentID string) (workspaceagentbiz.Agent, error) {
	if s.Store == nil {
		return workspaceagentbiz.Agent{}, errors.New("workspace agent store is not configured")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentID = strings.TrimSpace(agentID)
	if workspaceID == "" || agentID == "" {
		return workspaceagentbiz.Agent{}, fmt.Errorf("%w: workspace id and agent id are required", ErrInvalidInput)
	}
	return s.Store.GetWorkspaceAgent(ctx, workspaceID, agentID)
}

func (s *Service) ensureWorkspace(ctx context.Context, workspaceID string) error {
	if workspaceID == "" {
		return fmt.Errorf("%w: workspace id is required", ErrInvalidInput)
	}
	if s.Workspaces == nil {
		return nil
	}
	_, err := s.Workspaces.Get(ctx, workspaceID)
	return err
}

func (s *Service) validateReferences(ctx context.Context, agent workspaceagentbiz.Agent) error {
	if s.Targets == nil {
		return errors.New("workspace agent target resolver is not configured")
	}
	target, err := s.Targets.GetAgentTarget(ctx, agent.HarnessAgentTargetID)
	if err != nil {
		return err
	}
	target, err = agenttargetbiz.NormalizeTarget(target)
	if err != nil {
		return fmt.Errorf("%w: invalid harness target: %v", ErrHarnessUnavailable, err)
	}
	if !target.Enabled {
		return ErrHarnessDisabled
	}
	if agent.ModelPlanID == "" {
		return nil
	}
	if s.Plans == nil {
		return errors.New("workspace agent model plan resolver is not configured")
	}
	refs := agentModelRefs(agent)
	for index, ref := range refs {
		plan, err := s.Plans.GetModelPlan(ctx, agent.WorkspaceID, ref.ModelPlanID)
		if err != nil {
			return err
		}
		if !plan.Enabled {
			return fmt.Errorf("%w: model plan %s is disabled", ErrPlanNotUsable, ref.ModelPlanID)
		}
		if err := validateHarnessPlan(target, plan, ref.Model); err != nil {
			return err
		}
		if index > 0 && ref.ModelPlanID == agent.ModelPlanID && ref.Model == agent.DefaultModel {
			return fmt.Errorf("%w: fallback duplicates the primary model route", ErrInvalidInput)
		}
	}
	return nil
}

func (s *Service) view(ctx context.Context, agent workspaceagentbiz.Agent) (workspaceagentbiz.View, error) {
	view := workspaceagentbiz.View{
		Agent: workspaceagentbiz.Clone(agent),
		Harness: workspaceagentbiz.Harness{
			AgentTargetID: agent.HarnessAgentTargetID,
		},
	}
	if s.Targets == nil {
		return view, nil
	}
	target, err := s.Targets.GetAgentTarget(ctx, agent.HarnessAgentTargetID)
	if err != nil {
		if errors.Is(err, workspacedata.ErrAgentTargetNotFound) {
			return view, nil
		}
		return workspaceagentbiz.View{}, err
	}
	view.Harness.Available = true
	view.Harness.Provider = target.Provider
	view.Harness.Name = target.Name
	view.Harness.IconKey = target.IconKey
	view.Harness.Enabled = target.Enabled
	return view, nil
}

func validateHarnessPlan(target agenttargetbiz.Target, plan modelplanbiz.Plan, defaultModel string) error {
	requiredProtocol, supported := modelPlanProtocolForProvider(target.Provider)
	if !supported || plan.Protocol != requiredProtocol {
		return fmt.Errorf("%w: harness provider %s requires %s, plan uses %s", ErrHarnessPlanProtocolMismatch, target.Provider, requiredProtocol, plan.Protocol)
	}
	defaultModel = strings.TrimSpace(defaultModel)
	if defaultModel != "" && !modelplanbiz.ModelsContain(plan.Models, defaultModel) {
		return ErrModelNotInPlan
	}
	return nil
}

func modelPlanProtocolForProvider(provider string) (modelplanbiz.Protocol, bool) {
	protocol, ok := agentproviderbiz.ModelPlanProtocol(provider)
	return modelplanbiz.Protocol(protocol), ok
}

func effectiveModel(configured string, plan modelplanbiz.Plan) string {
	configured = strings.TrimSpace(configured)
	if configured != "" {
		return configured
	}
	if plan.DefaultModel != "" {
		return plan.DefaultModel
	}
	if len(plan.Models) > 0 {
		return plan.Models[0].ID
	}
	return ""
}

func (s *Service) configurationDefaultModel(ctx context.Context, agent workspaceagentbiz.Agent) string {
	if s.Plans == nil || strings.TrimSpace(agent.ModelPlanID) == "" {
		return ""
	}
	if s.Targets == nil {
		return ""
	}
	target, err := s.Targets.GetAgentTarget(ctx, agent.HarnessAgentTargetID)
	if err != nil {
		return ""
	}
	_, model, err := s.resolveModelRoute(ctx, agent, target)
	if err != nil {
		return ""
	}
	return model
}

func (s *Service) resolveModelRoute(ctx context.Context, agent workspaceagentbiz.Agent, target agenttargetbiz.Target) (modelplanbiz.Plan, string, error) {
	var firstErr error
	for _, ref := range agentModelRefs(agent) {
		plan, err := s.Plans.GetModelPlan(ctx, agent.WorkspaceID, ref.ModelPlanID)
		if err != nil {
			if errors.Is(err, workspacedata.ErrModelPlanNotFound) {
				err = fmt.Errorf("%w: model plan %s not found", ErrPlanNotUsable, ref.ModelPlanID)
			}
		} else if !plan.Enabled {
			err = fmt.Errorf("%w: model plan %s is disabled", ErrPlanNotUsable, ref.ModelPlanID)
		} else if validationErr := validateHarnessPlan(target, plan, ref.Model); validationErr != nil {
			err = validationErr
		}
		if err == nil {
			return plan, effectiveModel(ref.Model, plan), nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	if firstErr == nil {
		firstErr = fmt.Errorf("%w: no model route is configured", ErrPlanNotUsable)
	}
	return modelplanbiz.Plan{}, "", firstErr
}

func agentModelRefs(agent workspaceagentbiz.Agent) []workspaceagentbiz.ModelRef {
	refs := make([]workspaceagentbiz.ModelRef, 0, 1+len(agent.ModelFallbacks))
	if strings.TrimSpace(agent.ModelPlanID) != "" {
		refs = append(refs, workspaceagentbiz.ModelRef{ModelPlanID: agent.ModelPlanID, Model: agent.DefaultModel})
	}
	return append(refs, agent.ModelFallbacks...)
}

// logWorkspaceAgentLifecycle emits the CRUD audit trail. Session records may
// reference a WorkspaceAgent long after it changed or disappeared; these
// events are the anchor that makes later ingestion-side reference drops
// attributable to a concrete configuration action.
func logWorkspaceAgentLifecycle(action string, agent workspaceagentbiz.Agent) {
	slog.Info("workspace agent "+action,
		"event", "workspace_agent."+action,
		"workspace_id", agent.WorkspaceID,
		"workspace_agent_id", agent.ID,
		"harness_agent_target_id", agent.HarnessAgentTargetID,
		"model_plan_id", agent.ModelPlanID,
		"revision", agent.Revision,
	)
}

func (s *Service) publishConfigurationChanged(ctx context.Context, agent workspaceagentbiz.Agent, defaultModel string, resetComposerModel bool) {
	if s.Publisher == nil || agent.WorkspaceID == "" || agent.ID == "" {
		return
	}
	if err := s.Publisher.PublishAgentModelConfigurationChanged(
		ctx,
		agent.WorkspaceID,
		[]string{agent.ID},
		map[string]string{agent.ID: defaultModel},
		resetComposerModel,
	); err != nil {
		slog.Warn("workspace agent configuration publish failed",
			"event", "workspace_agent.configuration_changed_publish_failed",
			"workspaceId", agent.WorkspaceID,
			"workspaceAgentId", agent.ID,
			"error", err,
		)
	}
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) newID() string {
	if s.NewID != nil {
		return workspaceAgentID(s.NewID())
	}
	return workspaceAgentID(uuid.NewString())
}

func workspaceAgentID(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, workspaceagentbiz.IDPrefix) {
		return value
	}
	return workspaceagentbiz.IDPrefix + value
}
