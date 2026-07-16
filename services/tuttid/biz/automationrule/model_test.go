package automationrule

import (
	"errors"
	"reflect"
	"testing"
)

func TestNormalizeConsultRule(t *testing.T) {
	rule, err := Normalize(Rule{
		ID:          " rule-1 ",
		WorkspaceID: " ws ",
		Name:        " Review ",
		Action:      ActionConsult,
		Target: Target{
			ModelPlanID:          " plan-1 ",
			RequiredCapabilities: []string{" reasoning ", "reasoning", ""},
		},
		Permissions: PermissionPolicy{PermissionModeID: "full", AllowedTools: []string{"shell"}},
	})
	if err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if rule.Trigger != TriggerOnTaskComplete || rule.Target.Kind != TargetModel {
		t.Fatalf("normalized trigger/target = %q/%q", rule.Trigger, rule.Target.Kind)
	}
	if !reflect.DeepEqual(rule.Target.RequiredCapabilities, []string{"reasoning"}) {
		t.Fatalf("required capabilities = %#v", rule.Target.RequiredCapabilities)
	}
	if !reflect.DeepEqual(rule.Permissions, PermissionPolicy{}) {
		t.Fatalf("consult permissions = %#v, want empty", rule.Permissions)
	}
}

func TestNormalizeAgentActionRequiresAgentTarget(t *testing.T) {
	_, err := Normalize(Rule{
		ID:          "rule-1",
		WorkspaceID: "ws",
		Name:        "Delegate",
		Action:      ActionDelegate,
		Target:      Target{Kind: TargetAgent},
	})
	if !errors.Is(err, ErrInvalidRule) {
		t.Fatalf("Normalize() error = %v, want ErrInvalidRule", err)
	}
}

func TestNormalizeAgentActionRejectsPlanOverride(t *testing.T) {
	_, err := Normalize(Rule{
		ID:          "rule-1",
		WorkspaceID: "ws",
		Name:        "Fork",
		Action:      ActionFork,
		Target: Target{
			WorkspaceAgentID: "workspace-agent:one",
			ModelPlanID:      "plan-override",
		},
	})
	if !errors.Is(err, ErrInvalidRule) {
		t.Fatalf("Normalize() error = %v, want ErrInvalidRule", err)
	}
}

func TestNormalizeAgentActionRejectsCapabilityOverride(t *testing.T) {
	_, err := Normalize(Rule{
		ID:          "rule-1",
		WorkspaceID: "ws",
		Name:        "Delegate",
		Action:      ActionDelegate,
		Target: Target{
			WorkspaceAgentID:     "workspace-agent:one",
			RequiredCapabilities: []string{"reasoning"},
		},
	})
	if !errors.Is(err, ErrInvalidRule) {
		t.Fatalf("Normalize() error = %v, want ErrInvalidRule", err)
	}
}

func TestBudgetDefaults(t *testing.T) {
	budget := Budget{}
	if budget.EffectiveMaxRuns() != DefaultMaxRunsPerSession {
		t.Fatalf("EffectiveMaxRuns() = %d", budget.EffectiveMaxRuns())
	}
	if budget.EffectiveMaxTotalTokens() != DefaultMaxTotalTokensPerSession {
		t.Fatalf("EffectiveMaxTotalTokens() = %d", budget.EffectiveMaxTotalTokens())
	}
}

func TestAcceptanceReviewProtocolRequiresExplicitFinalVerdict(t *testing.T) {
	rule := Rule{
		Trigger: TriggerOnTaskComplete,
		Action:  ActionConsult,
		Target:  Target{Kind: TargetModel},
		Prompt:  "Review the result and end with VERDICT: PASS or VERDICT: FAIL.",
	}
	if !IsAcceptanceReview(rule) {
		t.Fatal("fixed verdict consult was not recognized as an acceptance review")
	}
	if passed, valid := ParseReviewVerdict("Looks good.\nVERDICT: PASS"); !passed || !valid {
		t.Fatalf("PASS verdict = (%v, %v)", passed, valid)
	}
	if passed, valid := ParseReviewVerdict("Problems found.\nVERDICT: FAIL"); passed || !valid {
		t.Fatalf("FAIL verdict = (%v, %v)", passed, valid)
	}
	for _, malformed := range []string{
		"VERDICT: PASS\nextra text",
		"I think it passes",
		"VERDICT: PASS OR VERDICT: FAIL",
	} {
		if passed, valid := ParseReviewVerdict(malformed); passed || valid {
			t.Fatalf("malformed verdict %q = (%v, %v), want invalid", malformed, passed, valid)
		}
	}
}
