package workspace

import (
	"context"
	"errors"
	"reflect"
	"testing"

	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
)

type issueAutomationRuleReaderStub struct {
	rules []automationrulebiz.Rule
	err   error
}

func (s issueAutomationRuleReaderStub) ListRules(context.Context, string) ([]automationrulebiz.Rule, error) {
	return s.rules, s.err
}

func TestIssueAutomationRuleOverrideCompilesOrchestrationIntensity(t *testing.T) {
	review := automationrulebiz.Rule{
		ID:      "review",
		Enabled: true,
		Trigger: automationrulebiz.TriggerOnTaskComplete,
		Action:  automationrulebiz.ActionConsult,
		Target:  automationrulebiz.Target{Kind: automationrulebiz.TargetModel},
		Prompt:  "Return a final line of VERDICT: PASS or VERDICT: FAIL",
	}
	rescue := automationrulebiz.Rule{
		ID:      "rescue",
		Enabled: true,
		Trigger: automationrulebiz.TriggerOnTaskFailed,
		Action:  automationrulebiz.ActionDelegate,
		Target:  automationrulebiz.Target{Kind: automationrulebiz.TargetAgent},
	}
	ordinaryCompletion := automationrulebiz.Rule{
		ID:      "ordinary-completion",
		Enabled: true,
		Trigger: automationrulebiz.TriggerOnTaskComplete,
		Action:  automationrulebiz.ActionConsult,
		Target:  automationrulebiz.Target{Kind: automationrulebiz.TargetModel},
		Prompt:  "Summarize the result",
	}
	disabledRescue := rescue
	disabledRescue.ID = "disabled-rescue"
	disabledRescue.Enabled = false
	service := IssueManagerService{AutomationRules: issueAutomationRuleReaderStub{rules: []automationrulebiz.Rule{
		rescue,
		ordinaryCompletion,
		disabledRescue,
		review,
	}}}

	tests := []struct {
		name      string
		intensity int
		disabled  bool
		ruleIDs   []string
	}{
		{name: "minimal", intensity: 33, disabled: true},
		{name: "review", intensity: 34, ruleIDs: []string{"review"}},
		{name: "rescue", intensity: 67, ruleIDs: []string{"rescue", "review"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			override := service.issueAutomationRuleOverride(context.Background(), "workspace-1", "session-1", test.intensity)
			if override.Disabled != test.disabled || !reflect.DeepEqual(override.RuleIDs, test.ruleIDs) {
				t.Fatalf("override = %#v, want disabled=%v ruleIDs=%v", override, test.disabled, test.ruleIDs)
			}
		})
	}
}

func TestIssueAutomationRuleOverrideFailsClosed(t *testing.T) {
	service := IssueManagerService{AutomationRules: issueAutomationRuleReaderStub{err: errors.New("unavailable")}}
	override := service.issueAutomationRuleOverride(context.Background(), "workspace-1", "session-1", 100)
	if !override.Disabled || len(override.RuleIDs) != 0 {
		t.Fatalf("override = %#v, want automation disabled", override)
	}
}
