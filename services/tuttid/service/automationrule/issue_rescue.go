package automationrule

import (
	"context"

	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
)

// IssueRescueInput describes a failure-triggered Agent launch before the
// target Session exists. A coordinator may attach it to a new Run of the same
// Issue Task, keeping retry execution and user acceptance in one workflow.
type IssueRescueInput struct {
	WorkspaceID         string
	RuleID              string
	SourceSessionID     string
	TargetSessionID     string
	TargetAgentTargetID string
	ModelPlanID         string
	Model               string
	ExecutionDirectory  string
}

type IssueRescuePreparation struct {
	Associated             bool
	AutomationRuleOverride *automationrulebiz.SessionOverride
	ReasoningIntensity     *int
}

type IssueRescueFailureInput struct {
	WorkspaceID     string
	TargetSessionID string
	ErrorMessage    string
}

// IssueRescueCoordinator is optional because ordinary workspace automation
// also runs outside Issue execution. Associated rescues must be prepared
// before the target Session starts and failed explicitly if a later launch
// boundary rejects the request.
type IssueRescueCoordinator interface {
	BeginAutomationIssueRescue(context.Context, IssueRescueInput) (IssueRescuePreparation, error)
	FailAutomationIssueRescue(context.Context, IssueRescueFailureInput) error
}
