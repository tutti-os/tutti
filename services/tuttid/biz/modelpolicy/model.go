// Package modelpolicy defines workspace model usage policies: which model
// access plan and model each role (execution, planning, review) uses, plus
// the first fixed automation rule — run a review with a designated model
// after a task-completing turn — bounded by run-count and token budgets.
//
// Automated review never replaces user acceptance: acceptance states move
// from agent_claimed to auto_checked to user_accepted, and only the last one
// may close work.
package modelpolicy

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrInvalidPolicy = errors.New("invalid model usage policy")

// PlanModelRef points one policy role at a model inside a model access plan.
type PlanModelRef struct {
	ModelPlanID string `json:"modelPlanId"`
	Model       string `json:"model,omitempty"`
}

// IsZero reports whether the role is unset.
func (r PlanModelRef) IsZero() bool {
	return strings.TrimSpace(r.ModelPlanID) == "" && strings.TrimSpace(r.Model) == ""
}

// ReviewTrigger identifies when the fixed review rule fires. The first
// iteration supports exactly one trigger: a session turn settles with a
// completed outcome ("the agent claims the task is done").
type ReviewTrigger string

const ReviewTriggerOnTaskComplete ReviewTrigger = "on_task_complete"

// ReviewRule is the fixed persistable review automation rule.
type ReviewRule struct {
	Enabled bool          `json:"enabled"`
	Trigger ReviewTrigger `json:"trigger"`
	// MaxRunsPerSession caps policy-triggered review runs per source
	// session. Zero uses DefaultReviewMaxRunsPerSession.
	MaxRunsPerSession int `json:"maxRunsPerSession,omitempty"`
	// MaxTotalTokensPerSession caps the summed input+output tokens of
	// policy-triggered review runs per source session. Zero uses
	// DefaultReviewMaxTotalTokensPerSession.
	MaxTotalTokensPerSession int64 `json:"maxTotalTokensPerSession,omitempty"`
}

const (
	DefaultReviewMaxRunsPerSession        = 3
	DefaultReviewMaxTotalTokensPerSession = int64(200_000)
)

// EffectiveMaxRuns resolves the run cap with defaults applied.
func (r ReviewRule) EffectiveMaxRuns() int {
	if r.MaxRunsPerSession > 0 {
		return r.MaxRunsPerSession
	}
	return DefaultReviewMaxRunsPerSession
}

// EffectiveMaxTotalTokens resolves the token budget with defaults applied.
func (r ReviewRule) EffectiveMaxTotalTokens() int64 {
	if r.MaxTotalTokensPerSession > 0 {
		return r.MaxTotalTokensPerSession
	}
	return DefaultReviewMaxTotalTokensPerSession
}

// Policy is the durable model usage policy record.
type Policy struct {
	ID          string
	WorkspaceID string
	Name        string
	// Execution, Planning, and Review bind roles to plan models. Empty roles
	// fall back to the session's own configuration.
	Execution  PlanModelRef
	Planning   PlanModelRef
	Review     PlanModelRef
	ReviewRule ReviewRule
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// Normalize validates and canonicalizes a policy record.
func Normalize(policy Policy) (Policy, error) {
	policy.ID = strings.TrimSpace(policy.ID)
	policy.WorkspaceID = strings.TrimSpace(policy.WorkspaceID)
	policy.Name = strings.TrimSpace(policy.Name)
	policy.Execution = normalizeRef(policy.Execution)
	policy.Planning = normalizeRef(policy.Planning)
	policy.Review = normalizeRef(policy.Review)
	if policy.ID == "" {
		return Policy{}, fmt.Errorf("%w: id is required", ErrInvalidPolicy)
	}
	if policy.WorkspaceID == "" {
		return Policy{}, fmt.Errorf("%w: workspace id is required", ErrInvalidPolicy)
	}
	if policy.Name == "" {
		return Policy{}, fmt.Errorf("%w: name is required", ErrInvalidPolicy)
	}
	if policy.ReviewRule.Trigger == "" {
		policy.ReviewRule.Trigger = ReviewTriggerOnTaskComplete
	}
	if policy.ReviewRule.Trigger != ReviewTriggerOnTaskComplete {
		return Policy{}, fmt.Errorf("%w: unsupported review trigger", ErrInvalidPolicy)
	}
	if policy.ReviewRule.Enabled && policy.Review.IsZero() {
		return Policy{}, fmt.Errorf("%w: review rule requires a review role model", ErrInvalidPolicy)
	}
	if policy.ReviewRule.MaxRunsPerSession < 0 || policy.ReviewRule.MaxTotalTokensPerSession < 0 {
		return Policy{}, fmt.Errorf("%w: review limits must not be negative", ErrInvalidPolicy)
	}
	return policy, nil
}

func normalizeRef(ref PlanModelRef) PlanModelRef {
	ref.ModelPlanID = strings.TrimSpace(ref.ModelPlanID)
	ref.Model = strings.TrimSpace(ref.Model)
	return ref
}

// SessionOverride is the per-session policy adjustment: disable automation
// for this session or use a different policy than the binding default.
// Overrides affect only calls that have not started yet.
type SessionOverride struct {
	WorkspaceID    string    `json:"workspaceId"`
	AgentSessionID string    `json:"agentSessionId"`
	Disabled       bool      `json:"disabled"`
	ModelPolicyID  string    `json:"modelPolicyId,omitempty"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// AcceptanceState is the three-step completion ladder. Automated review can
// raise a session to auto_checked, but only an explicit user action reaches
// user_accepted, and only user_accepted may close work.
type AcceptanceState string

const (
	AcceptanceAgentClaimed AcceptanceState = "agent_claimed"
	AcceptanceAutoChecked  AcceptanceState = "auto_checked"
	AcceptanceUserAccepted AcceptanceState = "user_accepted"
)

// Acceptance records the session's completion ladder position.
type Acceptance struct {
	WorkspaceID    string          `json:"workspaceId"`
	AgentSessionID string          `json:"agentSessionId"`
	State          AcceptanceState `json:"state"`
	// ReviewRunID references the collaboration run whose review verdict
	// produced auto_checked, when applicable.
	ReviewRunID string    `json:"reviewRunId,omitempty"`
	UpdatedAt   time.Time `json:"updatedAt"`
}
