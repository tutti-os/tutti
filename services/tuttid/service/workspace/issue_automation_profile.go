package workspace

import (
	"context"
	"sort"

	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
)

const (
	issueOrchestrationReviewThreshold = 34
	issueOrchestrationRescueThreshold = 67
)

// IssueAutomationRuleReader supplies the workspace rules that may be compiled
// into an Issue-run Session. The Issue execution profile is authoritative:
// low intensity disables automatic collaboration, medium intensity enables
// fixed acceptance Review rules, and high intensity additionally enables
// bounded failure-rescue rules.
type IssueAutomationRuleReader interface {
	ListRules(context.Context, string) ([]automationrulebiz.Rule, error)
}

func (s IssueManagerService) issueAutomationRuleOverride(
	ctx context.Context,
	issueWorkspaceID string,
	agentSessionID string,
	orchestrationIntensity int,
) *automationrulebiz.SessionOverride {
	override := &automationrulebiz.SessionOverride{
		WorkspaceID:    issueWorkspaceID,
		AgentSessionID: agentSessionID,
		Disabled:       true,
	}
	if orchestrationIntensity < issueOrchestrationReviewThreshold || s.AutomationRules == nil {
		return override
	}
	rules, err := s.AutomationRules.ListRules(ctx, issueWorkspaceID)
	if err != nil {
		return override
	}
	for _, rule := range rules {
		if !rule.Enabled {
			continue
		}
		if automationrulebiz.IsAcceptanceReview(rule) ||
			orchestrationIntensity >= issueOrchestrationRescueThreshold && rule.Trigger == automationrulebiz.TriggerOnTaskFailed {
			override.RuleIDs = append(override.RuleIDs, rule.ID)
		}
	}
	if len(override.RuleIDs) == 0 {
		return override
	}
	sort.Strings(override.RuleIDs)
	override.Disabled = false
	return override
}
