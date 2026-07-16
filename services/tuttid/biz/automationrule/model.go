// Package automationrule defines optional workspace automation that reacts to
// agent-session lifecycle events and starts a collaboration action. Rules are
// intentionally action-centric: model access belongs to ModelPlan and runtime
// identity belongs to WorkspaceAgent; there are no execution/planning/review
// model roles in this domain.
package automationrule

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

var ErrInvalidRule = errors.New("invalid automation rule")

// Trigger identifies the lifecycle event that evaluates a rule.
type Trigger string

const (
	TriggerOnTaskComplete Trigger = "on_task_complete"
	TriggerOnTaskFailed   Trigger = "on_task_failed"
)

// Action identifies the collaboration operation started by a rule.
type Action string

const (
	ActionConsult  Action = "consult"
	ActionFork     Action = "fork"
	ActionDelegate Action = "delegate"
	ActionHandoff  Action = "handoff"
)

func IsAction(value string) bool {
	switch Action(strings.TrimSpace(value)) {
	case ActionConsult, ActionFork, ActionDelegate, ActionHandoff:
		return true
	default:
		return false
	}
}

// IsAcceptanceReview reports whether a consult rule opts into the fixed
// acceptance-review protocol. Requiring both verdict literals keeps ordinary
// advisory consults from changing completion state.
func IsAcceptanceReview(rule Rule) bool {
	prompt := strings.ToUpper(strings.TrimSpace(rule.Prompt))
	return rule.Trigger == TriggerOnTaskComplete &&
		rule.Action == ActionConsult &&
		rule.Target.Kind == TargetModel &&
		strings.Contains(prompt, "VERDICT: PASS") &&
		strings.Contains(prompt, "VERDICT: FAIL")
}

// ParseReviewVerdict accepts only the fixed final-line protocol. Missing,
// ambiguous, or non-final verdict text is invalid and can never auto-check
// work.
func ParseReviewVerdict(resultText string) (passed bool, valid bool) {
	lines := strings.Split(strings.TrimSpace(resultText), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		line := strings.ToUpper(strings.TrimSpace(lines[index]))
		if line == "" {
			continue
		}
		switch line {
		case "VERDICT: PASS":
			return true, true
		case "VERDICT: FAIL":
			return false, true
		default:
			return false, false
		}
	}
	return false, false
}

// TargetKind distinguishes a direct model capability target from a runnable
// WorkspaceAgent target. Consult is model-targeted and tool-free; fork,
// delegate, and handoff target a WorkspaceAgent.
type TargetKind string

const (
	TargetModel TargetKind = "model"
	TargetAgent TargetKind = "agent"
)

// Target is the rule action destination. RequiredCapabilities constrain a
// direct model target; WorkspaceAgent targets inherit their already validated
// model configuration and may not declare a second capability contract.
type Target struct {
	Kind                 TargetKind `json:"kind"`
	WorkspaceAgentID     string     `json:"workspaceAgentId,omitempty"`
	ModelPlanID          string     `json:"modelPlanId,omitempty"`
	Model                string     `json:"model,omitempty"`
	RequiredCapabilities []string   `json:"requiredCapabilities,omitempty"`
}

// PermissionPolicy controls the authority granted to an automatically
// launched WorkspaceAgent. Consult actions never receive tools and therefore
// ignore these fields.
type PermissionPolicy struct {
	PermissionModeID string   `json:"permissionModeId,omitempty"`
	AllowedTools     []string `json:"allowedTools,omitempty"`
}

// Budget bounds one rule independently for each source session. Zero values
// use the service defaults rather than meaning unlimited.
type Budget struct {
	MaxRunsPerSession        int   `json:"maxRunsPerSession,omitempty"`
	MaxTotalTokensPerSession int64 `json:"maxTotalTokensPerSession,omitempty"`
}

const (
	DefaultMaxRunsPerSession        = 3
	DefaultMaxTotalTokensPerSession = int64(200_000)
)

func (b Budget) EffectiveMaxRuns() int {
	if b.MaxRunsPerSession > 0 {
		return b.MaxRunsPerSession
	}
	return DefaultMaxRunsPerSession
}

func (b Budget) EffectiveMaxTotalTokens() int64 {
	if b.MaxTotalTokensPerSession > 0 {
		return b.MaxTotalTokensPerSession
	}
	return DefaultMaxTotalTokensPerSession
}

// Rule is one durable workspace automation rule.
type Rule struct {
	ID          string
	WorkspaceID string
	Name        string
	Enabled     bool
	Trigger     Trigger
	Action      Action
	// SourceWorkspaceAgentID scopes the rule to sessions created from one
	// WorkspaceAgent. Empty means every non-automation-origin session.
	SourceWorkspaceAgentID string
	Target                 Target
	Permissions            PermissionPolicy
	Budget                 Budget
	Prompt                 string
	CreatedAt              time.Time
	UpdatedAt              time.Time
}

// SessionOverride applies only to future automation evaluations for one
// session. Disabled stops every rule; RuleIDs, when non-empty, replaces the
// workspace rule set with the listed rules.
type SessionOverride struct {
	WorkspaceID    string    `json:"workspaceId"`
	AgentSessionID string    `json:"agentSessionId"`
	Disabled       bool      `json:"disabled"`
	RuleIDs        []string  `json:"ruleIds,omitempty"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

func NormalizeSessionOverride(override SessionOverride) (SessionOverride, error) {
	override.WorkspaceID = strings.TrimSpace(override.WorkspaceID)
	override.AgentSessionID = strings.TrimSpace(override.AgentSessionID)
	override.RuleIDs = normalizeStrings(override.RuleIDs)
	if override.WorkspaceID == "" || override.AgentSessionID == "" {
		return SessionOverride{}, fmt.Errorf("%w: override workspace and session are required", ErrInvalidRule)
	}
	return override, nil
}

// Normalize validates and canonicalizes a rule without consulting external
// stores. Service-level validation resolves referenced plans and agents.
func Normalize(rule Rule) (Rule, error) {
	rule.ID = strings.TrimSpace(rule.ID)
	rule.WorkspaceID = strings.TrimSpace(rule.WorkspaceID)
	rule.Name = strings.TrimSpace(rule.Name)
	rule.SourceWorkspaceAgentID = strings.TrimSpace(rule.SourceWorkspaceAgentID)
	rule.Prompt = strings.TrimSpace(rule.Prompt)
	rule.Target.Kind = TargetKind(strings.TrimSpace(string(rule.Target.Kind)))
	rule.Target.WorkspaceAgentID = strings.TrimSpace(rule.Target.WorkspaceAgentID)
	rule.Target.ModelPlanID = strings.TrimSpace(rule.Target.ModelPlanID)
	rule.Target.Model = strings.TrimSpace(rule.Target.Model)
	rule.Target.RequiredCapabilities = normalizeStrings(rule.Target.RequiredCapabilities)
	rule.Permissions.PermissionModeID = strings.TrimSpace(rule.Permissions.PermissionModeID)
	rule.Permissions.AllowedTools = normalizeStrings(rule.Permissions.AllowedTools)

	if rule.ID == "" {
		return Rule{}, fmt.Errorf("%w: id is required", ErrInvalidRule)
	}
	if rule.WorkspaceID == "" {
		return Rule{}, fmt.Errorf("%w: workspace id is required", ErrInvalidRule)
	}
	if rule.Name == "" {
		return Rule{}, fmt.Errorf("%w: name is required", ErrInvalidRule)
	}
	if rule.Trigger == "" {
		rule.Trigger = TriggerOnTaskComplete
	}
	if rule.Trigger != TriggerOnTaskComplete && rule.Trigger != TriggerOnTaskFailed {
		return Rule{}, fmt.Errorf("%w: unsupported trigger", ErrInvalidRule)
	}
	if !IsAction(string(rule.Action)) {
		return Rule{}, fmt.Errorf("%w: unsupported action", ErrInvalidRule)
	}
	if rule.Budget.MaxRunsPerSession < 0 || rule.Budget.MaxTotalTokensPerSession < 0 {
		return Rule{}, fmt.Errorf("%w: budget values must not be negative", ErrInvalidRule)
	}

	switch rule.Action {
	case ActionConsult:
		if rule.Target.Kind == "" {
			rule.Target.Kind = TargetModel
		}
		if rule.Target.Kind != TargetModel || rule.Target.ModelPlanID == "" {
			return Rule{}, fmt.Errorf("%w: consult requires a model-plan target", ErrInvalidRule)
		}
		if rule.Target.WorkspaceAgentID != "" {
			return Rule{}, fmt.Errorf("%w: consult cannot target a workspace agent", ErrInvalidRule)
		}
		// Consult is deliberately tool-free.
		rule.Permissions = PermissionPolicy{}
	default:
		if rule.Target.Kind == "" {
			rule.Target.Kind = TargetAgent
		}
		if rule.Target.Kind != TargetAgent || rule.Target.WorkspaceAgentID == "" {
			return Rule{}, fmt.Errorf("%w: %s requires a workspace-agent target", ErrInvalidRule, rule.Action)
		}
		if rule.Target.ModelPlanID != "" || rule.Target.Model != "" {
			return Rule{}, fmt.Errorf("%w: agent actions inherit the target agent model configuration", ErrInvalidRule)
		}
		if len(rule.Target.RequiredCapabilities) > 0 {
			return Rule{}, fmt.Errorf("%w: agent actions inherit the target agent capabilities", ErrInvalidRule)
		}
	}
	return rule, nil
}

func normalizeStrings(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	slices.Sort(result)
	if len(result) == 0 {
		return nil
	}
	return result
}

// LegacyPolicyRuleID deterministically maps one legacy policy/binding pair to
// its migrated action rule. The opaque hash keeps arbitrary legacy ids out of
// HTTP path segments while making the migration idempotent.
func LegacyPolicyRuleID(workspaceID string, policyID string, sourceAgentID string) string {
	digest := sha256.Sum256([]byte(strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(policyID) + "\x00" + strings.TrimSpace(sourceAgentID)))
	return fmt.Sprintf("automation-rule:legacy:%x", digest[:12])
}
