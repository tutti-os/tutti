// Package modelplan orchestrates workspace model access plans: CRUD with
// reference protection, staged connection detection, and the pending-first-use
// lifecycle that completes on the first real agent-runtime call.
package modelplan

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
)

var (
	ErrInvalidPlanInput = errors.New("invalid model plan input")
	ErrPlanReferenced   = errors.New("model plan is still referenced")
)

// ReferenceResolver reports the agent targets currently referencing a plan.
type ReferenceResolver interface {
	ListModelPlanReferences(ctx context.Context, workspaceID string, planID string) ([]modelplanbiz.Reference, error)
}

// ChangePublisher lets the service broadcast plan catalog changes.
type ChangePublisher interface {
	PublishModelPlansChanged(workspaceID string)
}

type Service struct {
	Store      workspacedata.ModelPlansStore
	References ReferenceResolver
	Publisher  ChangePublisher
	Now        func() time.Time
	HTTPClient *http.Client
	NewID      func() string
}

type PutPlanInput struct {
	WorkspaceID  string
	PlanID       string
	Name         string
	TemplateKind string
	Protocol     string
	// APIKey nil preserves the stored key; a value replaces it.
	APIKey       *string
	BaseURL      string
	Models       []modelplanbiz.Model
	DefaultModel string
	Enabled      bool
}

func (s *Service) ListPlans(ctx context.Context, workspaceID string) ([]modelplanbiz.PublicPlan, error) {
	plans, err := s.Store.ListModelPlans(ctx, strings.TrimSpace(workspaceID))
	if err != nil {
		return nil, err
	}
	public := make([]modelplanbiz.PublicPlan, 0, len(plans))
	for _, plan := range plans {
		public = append(public, modelplanbiz.Public(plan))
	}
	return public, nil
}

func (s *Service) GetPlan(ctx context.Context, workspaceID string, planID string) (modelplanbiz.PublicPlan, error) {
	plan, err := s.Store.GetModelPlan(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(planID))
	if err != nil {
		return modelplanbiz.PublicPlan{}, err
	}
	return modelplanbiz.Public(plan), nil
}

// CreatePlan stores a new named plan. The plan starts undetected and pending
// first use regardless of the enabled flag.
func (s *Service) CreatePlan(ctx context.Context, input PutPlanInput) (modelplanbiz.PublicPlan, error) {
	now := s.now()
	plan := modelplanbiz.Plan{
		ID:           s.newID(),
		WorkspaceID:  strings.TrimSpace(input.WorkspaceID),
		Name:         input.Name,
		TemplateKind: modelplanbiz.TemplateKind(strings.TrimSpace(input.TemplateKind)),
		Protocol:     modelplanbiz.Protocol(strings.TrimSpace(input.Protocol)),
		APIKey:       strings.TrimSpace(derefString(input.APIKey)),
		BaseURL:      input.BaseURL,
		Models:       input.Models,
		DefaultModel: input.DefaultModel,
		Enabled:      input.Enabled,
		FirstUse:     modelplanbiz.FirstUse{Status: modelplanbiz.FirstUsePending},
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	normalized, err := modelplanbiz.Normalize(plan)
	if err != nil {
		return modelplanbiz.PublicPlan{}, fmt.Errorf("%w: %w", ErrInvalidPlanInput, err)
	}
	if err := s.Store.PutModelPlan(ctx, normalized); err != nil {
		return modelplanbiz.PublicPlan{}, err
	}
	s.publishChanged(normalized.WorkspaceID)
	return modelplanbiz.Public(normalized), nil
}

// UpdatePlan replaces the mutable fields of an existing plan. Changing the
// credential, base URL, or protocol resets detection and first-use state so
// the plan must be re-verified before it reads as usable.
func (s *Service) UpdatePlan(ctx context.Context, input PutPlanInput) (modelplanbiz.PublicPlan, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	existing, err := s.Store.GetModelPlan(ctx, workspaceID, strings.TrimSpace(input.PlanID))
	if err != nil {
		return modelplanbiz.PublicPlan{}, err
	}
	updated := existing
	updated.Name = input.Name
	updated.TemplateKind = modelplanbiz.TemplateKind(strings.TrimSpace(input.TemplateKind))
	updated.Protocol = modelplanbiz.Protocol(strings.TrimSpace(input.Protocol))
	updated.BaseURL = input.BaseURL
	updated.Models = input.Models
	updated.DefaultModel = input.DefaultModel
	updated.Enabled = input.Enabled
	if input.APIKey != nil {
		updated.APIKey = strings.TrimSpace(*input.APIKey)
	}
	updated.UpdatedAt = s.now()
	normalized, err := modelplanbiz.Normalize(updated)
	if err != nil {
		return modelplanbiz.PublicPlan{}, fmt.Errorf("%w: %w", ErrInvalidPlanInput, err)
	}
	if credentialChanged(existing, normalized) {
		normalized.Detection = modelplanbiz.DetectionSnapshot{}
		normalized.FirstUse = modelplanbiz.FirstUse{Status: modelplanbiz.FirstUsePending}
	}
	if err := s.Store.PutModelPlan(ctx, normalized); err != nil {
		return modelplanbiz.PublicPlan{}, err
	}
	s.publishChanged(normalized.WorkspaceID)
	return modelplanbiz.Public(normalized), nil
}

// DuplicatePlan clones an existing plan, including its credential, into a new
// disabled plan that must be re-detected before use.
func (s *Service) DuplicatePlan(ctx context.Context, workspaceID string, planID string, name string) (modelplanbiz.PublicPlan, error) {
	source, err := s.Store.GetModelPlan(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(planID))
	if err != nil {
		return modelplanbiz.PublicPlan{}, err
	}
	now := s.now()
	clone := source
	clone.ID = s.newID()
	clone.Name = strings.TrimSpace(name)
	if clone.Name == "" {
		clone.Name = source.Name + " copy"
	}
	clone.Enabled = false
	clone.Detection = modelplanbiz.DetectionSnapshot{}
	clone.FirstUse = modelplanbiz.FirstUse{Status: modelplanbiz.FirstUsePending}
	clone.CreatedAt = now
	clone.UpdatedAt = now
	normalized, err := modelplanbiz.Normalize(clone)
	if err != nil {
		return modelplanbiz.PublicPlan{}, fmt.Errorf("%w: %w", ErrInvalidPlanInput, err)
	}
	if err := s.Store.PutModelPlan(ctx, normalized); err != nil {
		return modelplanbiz.PublicPlan{}, err
	}
	s.publishChanged(normalized.WorkspaceID)
	return modelplanbiz.Public(normalized), nil
}

func (s *Service) SetPlanEnabled(ctx context.Context, workspaceID string, planID string, enabled bool) (modelplanbiz.PublicPlan, error) {
	plan, err := s.Store.GetModelPlan(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(planID))
	if err != nil {
		return modelplanbiz.PublicPlan{}, err
	}
	plan.Enabled = enabled
	plan.UpdatedAt = s.now()
	if err := s.Store.PutModelPlan(ctx, plan); err != nil {
		return modelplanbiz.PublicPlan{}, err
	}
	s.publishChanged(plan.WorkspaceID)
	return modelplanbiz.Public(plan), nil
}

// DeletePlan removes a plan. Deletion is blocked while any consumer still
// references the plan; callers must rebind or disable those consumers first.
func (s *Service) DeletePlan(ctx context.Context, workspaceID string, planID string) error {
	workspaceID = strings.TrimSpace(workspaceID)
	planID = strings.TrimSpace(planID)
	references, err := s.PlanReferences(ctx, workspaceID, planID)
	if err != nil {
		return err
	}
	if len(references) > 0 {
		return fmt.Errorf("%w: %d consumers", ErrPlanReferenced, len(references))
	}
	if err := s.Store.DeleteModelPlan(ctx, workspaceID, planID); err != nil {
		return err
	}
	s.publishChanged(workspaceID)
	return nil
}

// PlanReferences lists the consumers currently referencing a plan so the UI
// can show change/delete impact before the user commits.
func (s *Service) PlanReferences(ctx context.Context, workspaceID string, planID string) ([]modelplanbiz.Reference, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	planID = strings.TrimSpace(planID)
	if _, err := s.Store.GetModelPlan(ctx, workspaceID, planID); err != nil {
		return nil, err
	}
	if s.References == nil {
		return []modelplanbiz.Reference{}, nil
	}
	references, err := s.References.ListModelPlanReferences(ctx, workspaceID, planID)
	if err != nil {
		return nil, err
	}
	if references == nil {
		references = []modelplanbiz.Reference{}
	}
	return references, nil
}

// MarkFirstUse records the first successful agent-runtime call through the
// plan, settling the agent_runtime detection stage and completing the
// pending-first-use lifecycle.
func (s *Service) MarkFirstUse(ctx context.Context, workspaceID string, planID string, agentTargetID string, agentSessionID string, model string) error {
	plan, err := s.Store.GetModelPlan(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(planID))
	if err != nil {
		return err
	}
	if plan.FirstUse.Status == modelplanbiz.FirstUseCompleted {
		return nil
	}
	now := s.now()
	plan.FirstUse = modelplanbiz.FirstUse{
		Status:         modelplanbiz.FirstUseCompleted,
		AgentTargetID:  strings.TrimSpace(agentTargetID),
		AgentSessionID: strings.TrimSpace(agentSessionID),
		Model:          strings.TrimSpace(model),
		CompletedAt:    now,
	}
	plan.Detection = upsertStageResult(plan.Detection, modelplanbiz.StageResult{
		Stage:     modelplanbiz.StageAgentRuntime,
		Status:    modelplanbiz.StagePassed,
		Detail:    strings.TrimSpace(agentTargetID),
		CheckedAt: now,
	})
	plan.UpdatedAt = now
	if err := s.Store.PutModelPlan(ctx, plan); err != nil {
		return err
	}
	s.publishChanged(plan.WorkspaceID)
	return nil
}

func credentialChanged(before modelplanbiz.Plan, after modelplanbiz.Plan) bool {
	return before.APIKey != after.APIKey ||
		before.BaseURL != after.BaseURL ||
		before.Protocol != after.Protocol
}

func upsertStageResult(snapshot modelplanbiz.DetectionSnapshot, result modelplanbiz.StageResult) modelplanbiz.DetectionSnapshot {
	for index, stage := range snapshot.Stages {
		if stage.Stage == result.Stage {
			snapshot.Stages[index] = result
			return snapshot
		}
	}
	snapshot.Stages = append(snapshot.Stages, result)
	return snapshot
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) newID() string {
	if s.NewID != nil {
		return s.NewID()
	}
	buf := make([]byte, 12)
	_, _ = rand.Read(buf)
	return "mp-" + base64.RawURLEncoding.EncodeToString(buf)
}

func (s *Service) httpClient() *http.Client {
	if s.HTTPClient != nil {
		return s.HTTPClient
	}
	return httpx.NewClient(20 * time.Second)
}

func (s *Service) publishChanged(workspaceID string) {
	if s.Publisher != nil {
		s.Publisher.PublishModelPlansChanged(workspaceID)
	}
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
