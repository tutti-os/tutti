// Package automationrule defines optional workspace automation that reacts to
// agent-session lifecycle events. A triggered rule has exactly one behavior:
// it launches a new target-Agent session whose first message carries the rule
// prompt, a source-session mention, and a short event note. The retired
// consult/fork/delegate/handoff action split no longer exists in this domain;
// model access belongs to ModelPlan and runtime identity belongs to
// WorkspaceAgent or the built-in Harness catalog.
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

// TargetKind is retained for the durable schema; every rule targets a
// launchable Agent. The legacy "model" kind was retired with the consult
// action and is rejected on write and normalization.
type TargetKind string

const (
	TargetAgent TargetKind = "agent"
)

// Target is the rule launch destination. WorkspaceAgentID accepts either a
// WorkspaceAgent id or a built-in Harness AgentTarget id; the launched
// session inherits that Agent's validated model configuration. The remaining
// fields are retired consult-era columns kept dormant for schema
// compatibility and must stay empty.
type Target struct {
	Kind                 TargetKind `json:"kind"`
	WorkspaceAgentID     string     `json:"workspaceAgentId,omitempty"`
	ModelPlanID          string     `json:"modelPlanId,omitempty"`
	Model                string     `json:"model,omitempty"`
	RequiredCapabilities []string   `json:"requiredCapabilities,omitempty"`
}

// PermissionPolicy controls the authority granted to the automatically
// launched target session.
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

// ExecutionStatus is the terminal launch fact for one automation execution.
type ExecutionStatus string

const (
	ExecutionLaunched     ExecutionStatus = "launched"
	ExecutionLaunchFailed ExecutionStatus = "launch_failed"
)

// Execution is one durable automation launch attempt. It anchors trigger
// dedup across daemon restarts and accumulates the target session's recorded
// token usage for the per-source-session budget guard.
type Execution struct {
	WorkspaceID     string
	RuleID          string
	SourceSessionID string
	TriggerID       string
	TargetSessionID string
	Status          ExecutionStatus
	FailureReason   string
	TotalTokens     int64
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// NormalizeExecution validates the identity fields required for durable
// dedup and defaults the status to launched.
func NormalizeExecution(execution Execution) (Execution, error) {
	execution.WorkspaceID = strings.TrimSpace(execution.WorkspaceID)
	execution.RuleID = strings.TrimSpace(execution.RuleID)
	execution.SourceSessionID = strings.TrimSpace(execution.SourceSessionID)
	execution.TriggerID = strings.TrimSpace(execution.TriggerID)
	execution.TargetSessionID = strings.TrimSpace(execution.TargetSessionID)
	execution.FailureReason = strings.TrimSpace(execution.FailureReason)
	if execution.Status == "" {
		execution.Status = ExecutionLaunched
	}
	if execution.WorkspaceID == "" || execution.RuleID == "" || execution.SourceSessionID == "" ||
		execution.TriggerID == "" || execution.TargetSessionID == "" {
		return Execution{}, fmt.Errorf("%w: execution identity fields are required", ErrInvalidRule)
	}
	return execution, nil
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
// stores. Service-level validation resolves the referenced agents.
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
	if rule.Budget.MaxRunsPerSession < 0 || rule.Budget.MaxTotalTokensPerSession < 0 {
		return Rule{}, fmt.Errorf("%w: budget values must not be negative", ErrInvalidRule)
	}
	if rule.Target.Kind == "" {
		rule.Target.Kind = TargetAgent
	}
	if rule.Target.Kind != TargetAgent || rule.Target.WorkspaceAgentID == "" {
		return Rule{}, fmt.Errorf("%w: a target agent is required", ErrInvalidRule)
	}
	if rule.Target.ModelPlanID != "" || rule.Target.Model != "" {
		return Rule{}, fmt.Errorf("%w: automation launches inherit the target agent model configuration", ErrInvalidRule)
	}
	if len(rule.Target.RequiredCapabilities) > 0 {
		return Rule{}, fmt.Errorf("%w: automation launches inherit the target agent capabilities", ErrInvalidRule)
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
// its migrated rule. The opaque hash keeps arbitrary legacy ids out of HTTP
// path segments while making the migration idempotent.
func LegacyPolicyRuleID(workspaceID string, policyID string, sourceAgentID string) string {
	digest := sha256.Sum256([]byte(strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(policyID) + "\x00" + strings.TrimSpace(sourceAgentID)))
	return fmt.Sprintf("automation-rule:legacy:%x", digest[:12])
}
