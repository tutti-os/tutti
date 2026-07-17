package workspace

import (
	"context"
	"sort"

	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
)

const issueOrchestrationRescueThreshold = 67

// IssueAutomationRuleReader supplies the workspace rules that may be compiled
// into an Issue-run Session. The Issue execution profile is authoritative:
// only high orchestration intensity enables bounded failure-rescue rules.
// The consult-based acceptance-review tier retired together with the
// automation action split, so lower intensities disable automation entirely.
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
	if orchestrationIntensity < issueOrchestrationRescueThreshold || s.AutomationRules == nil {
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
		if rule.Trigger == automationrulebiz.TriggerOnTaskFailed {
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
