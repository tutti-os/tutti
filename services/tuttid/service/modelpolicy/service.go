// Package modelpolicy orchestrates workspace model usage policies, their
// per-session overrides, the session acceptance ladder, and the fixed
// automated review rule.
package modelpolicy

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	modelpolicybiz "github.com/tutti-os/tutti/services/tuttid/biz/modelpolicy"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

var (
	ErrInvalidPolicyInput              = errors.New("invalid model usage policy input")
	ErrInvalidAcceptanceState          = errors.New("invalid acceptance state")
	ErrPolicyReferenced                = errors.New("model usage policy is still referenced")
	ErrPolicyReferenceCheckUnavailable = errors.New("model usage policy reference check is unavailable")
)

// BindingReferenceReader lists agent bindings that reference a policy so
// deletion can be blocked while consumers remain. It is a narrow read over biz
// types so deletion never takes a modelpolicy -> modelbinding service
// dependency.
type BindingReferenceReader interface {
	ListAgentModelBindingsByModelPolicy(ctx context.Context, workspaceID string, policyID string) ([]modelbindingbiz.Binding, error)
}

// Store is the persistence surface for policies, overrides, and acceptance.
// *workspacedata.SQLiteStore satisfies it.
type Store interface {
	ListModelPolicies(ctx context.Context, workspaceID string) ([]modelpolicybiz.Policy, error)
	GetModelPolicy(ctx context.Context, workspaceID string, policyID string) (modelpolicybiz.Policy, error)
	PutModelPolicy(ctx context.Context, policy modelpolicybiz.Policy) error
	DeleteModelPolicy(ctx context.Context, workspaceID string, policyID string) error
	ListModelPoliciesByPlan(ctx context.Context, workspaceID string, planID string) ([]modelpolicybiz.Policy, error)
	GetModelPolicySessionOverride(ctx context.Context, workspaceID string, agentSessionID string) (modelpolicybiz.SessionOverride, error)
	PutModelPolicySessionOverride(ctx context.Context, override modelpolicybiz.SessionOverride) error
	GetAgentSessionAcceptance(ctx context.Context, workspaceID string, agentSessionID string) (modelpolicybiz.Acceptance, error)
	PutAgentSessionAcceptance(ctx context.Context, acceptance modelpolicybiz.Acceptance) error
}

type Service struct {
	Store Store
	Now   func() time.Time
	NewID func() string

	// BindingReferences guards policy deletion against live agent bindings.
	BindingReferences BindingReferenceReader

	// Review automation collaborators; see ConfigureReviewAutomation.
	Bindings BindingSource
	Sessions SessionTargetResolver
	Runner   ReviewConsultRunner
	Budget   ReviewBudgetReader

	engine reviewEngine
}

type PutPolicyInput struct {
	WorkspaceID string
	PolicyID    string
	Name        string
	Execution   modelpolicybiz.PlanModelRef
	Planning    modelpolicybiz.PlanModelRef
	Review      modelpolicybiz.PlanModelRef
	ReviewRule  modelpolicybiz.ReviewRule
}

func (s *Service) ListPolicies(ctx context.Context, workspaceID string) ([]modelpolicybiz.Policy, error) {
	policies, err := s.Store.ListModelPolicies(ctx, strings.TrimSpace(workspaceID))
	if err != nil {
		return nil, err
	}
	if policies == nil {
		policies = []modelpolicybiz.Policy{}
	}
	return policies, nil
}

func (s *Service) GetPolicy(ctx context.Context, workspaceID string, policyID string) (modelpolicybiz.Policy, error) {
	return s.Store.GetModelPolicy(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(policyID))
}

func (s *Service) PutPolicy(ctx context.Context, input PutPolicyInput) (modelpolicybiz.Policy, error) {
	now := s.now()
	policyID := strings.TrimSpace(input.PolicyID)
	createdAt := now
	if policyID == "" {
		policyID = s.newID()
	} else if existing, err := s.Store.GetModelPolicy(ctx, strings.TrimSpace(input.WorkspaceID), policyID); err == nil {
		createdAt = existing.CreatedAt
	}
	policy, err := modelpolicybiz.Normalize(modelpolicybiz.Policy{
		ID:          policyID,
		WorkspaceID: input.WorkspaceID,
		Name:        input.Name,
		Execution:   input.Execution,
		Planning:    input.Planning,
		Review:      input.Review,
		ReviewRule:  input.ReviewRule,
		CreatedAt:   createdAt,
		UpdatedAt:   now,
	})
	if err != nil {
		return modelpolicybiz.Policy{}, fmt.Errorf("%w: %w", ErrInvalidPolicyInput, err)
	}
	if err := s.Store.PutModelPolicy(ctx, policy); err != nil {
		return modelpolicybiz.Policy{}, err
	}
	return policy, nil
}

func (s *Service) DeletePolicy(ctx context.Context, workspaceID string, policyID string) error {
	workspaceID = strings.TrimSpace(workspaceID)
	policyID = strings.TrimSpace(policyID)
	// Fail closed: the reference reader must be wired. Deletion integrity is
	// ultimately enforced atomically by the store's ON DELETE RESTRICT foreign
	// key, but a missing reader signals a wiring fault, so refuse rather than
	// delete blind.
	if s.BindingReferences == nil {
		return ErrPolicyReferenceCheckUnavailable
	}
	// Fast path: a precise, count-bearing error for the common referenced case.
	bindings, err := s.BindingReferences.ListAgentModelBindingsByModelPolicy(ctx, workspaceID, policyID)
	if err != nil {
		return err
	}
	if len(bindings) > 0 {
		return fmt.Errorf("%w: %d agent bindings", ErrPolicyReferenced, len(bindings))
	}
	// Atomic backstop: a binding created between the check above and here
	// (TOCTOU) is rejected by the bindings ON DELETE RESTRICT foreign key.
	if err := s.Store.DeleteModelPolicy(ctx, workspaceID, policyID); err != nil {
		if errors.Is(err, workspacedata.ErrModelPolicyReferenced) {
			return ErrPolicyReferenced
		}
		return err
	}
	return nil
}

// ListModelPlanReferences reports policies referencing a plan through any
// role, implementing the plan reference contract for policies.
func (s *Service) ListModelPlanReferences(ctx context.Context, workspaceID string, planID string) ([]modelplanbiz.Reference, error) {
	policies, err := s.Store.ListModelPoliciesByPlan(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(planID))
	if err != nil {
		return nil, err
	}
	planID = strings.TrimSpace(planID)
	references := make([]modelplanbiz.Reference, 0, len(policies))
	for _, policy := range policies {
		role := ""
		switch planID {
		case policy.Execution.ModelPlanID:
			role = "execution"
		case policy.Planning.ModelPlanID:
			role = "planning"
		case policy.Review.ModelPlanID:
			role = "review"
		}
		references = append(references, modelplanbiz.Reference{
			Kind: modelplanbiz.ReferenceModelPolicy,
			ID:   policy.ID,
			Name: policy.Name,
			Role: role,
		})
	}
	return references, nil
}

// SetSessionOverride disables or replaces the policy for one session; the
// change affects only calls that have not started yet.
func (s *Service) SetSessionOverride(ctx context.Context, override modelpolicybiz.SessionOverride) (modelpolicybiz.SessionOverride, error) {
	override.WorkspaceID = strings.TrimSpace(override.WorkspaceID)
	override.AgentSessionID = strings.TrimSpace(override.AgentSessionID)
	override.ModelPolicyID = strings.TrimSpace(override.ModelPolicyID)
	if override.WorkspaceID == "" || override.AgentSessionID == "" {
		return modelpolicybiz.SessionOverride{}, ErrInvalidPolicyInput
	}
	if override.ModelPolicyID != "" {
		if _, err := s.Store.GetModelPolicy(ctx, override.WorkspaceID, override.ModelPolicyID); err != nil {
			return modelpolicybiz.SessionOverride{}, err
		}
	}
	override.UpdatedAt = s.now()
	if err := s.Store.PutModelPolicySessionOverride(ctx, override); err != nil {
		return modelpolicybiz.SessionOverride{}, err
	}
	return override, nil
}

func (s *Service) GetSessionOverride(ctx context.Context, workspaceID string, agentSessionID string) (modelpolicybiz.SessionOverride, bool, error) {
	override, err := s.Store.GetModelPolicySessionOverride(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return modelpolicybiz.SessionOverride{}, false, nil
		}
		return modelpolicybiz.SessionOverride{}, false, err
	}
	return override, true, nil
}

// GetAcceptance reports the session's acceptance ladder position; sessions
// without a record have not been claimed complete yet.
func (s *Service) GetAcceptance(ctx context.Context, workspaceID string, agentSessionID string) (modelpolicybiz.Acceptance, bool, error) {
	acceptance, err := s.Store.GetAgentSessionAcceptance(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return modelpolicybiz.Acceptance{}, false, nil
		}
		return modelpolicybiz.Acceptance{}, false, err
	}
	return acceptance, true, nil
}

// MarkUserAccepted records the explicit user acceptance that alone may close
// work. Automated review can never produce this state.
func (s *Service) MarkUserAccepted(ctx context.Context, workspaceID string, agentSessionID string) (modelpolicybiz.Acceptance, error) {
	acceptance := modelpolicybiz.Acceptance{
		WorkspaceID:    strings.TrimSpace(workspaceID),
		AgentSessionID: strings.TrimSpace(agentSessionID),
		State:          modelpolicybiz.AcceptanceUserAccepted,
		UpdatedAt:      s.now(),
	}
	if acceptance.WorkspaceID == "" || acceptance.AgentSessionID == "" {
		return modelpolicybiz.Acceptance{}, ErrInvalidPolicyInput
	}
	if existing, ok, err := s.GetAcceptance(ctx, acceptance.WorkspaceID, acceptance.AgentSessionID); err != nil {
		return modelpolicybiz.Acceptance{}, err
	} else if ok {
		acceptance.ReviewRunID = existing.ReviewRunID
	}
	if err := s.Store.PutAgentSessionAcceptance(ctx, acceptance); err != nil {
		return modelpolicybiz.Acceptance{}, err
	}
	return acceptance, nil
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
	return "pol-" + base64.RawURLEncoding.EncodeToString(buf)
}
