package automationrule

import (
	"errors"
	"reflect"
	"testing"
)

func TestNormalizeLaunchRuleDefaultsAgentTargetKind(t *testing.T) {
	rule, err := Normalize(Rule{
		ID:          " rule-1 ",
		WorkspaceID: " ws ",
		Name:        " Follow up ",
		Target:      Target{WorkspaceAgentID: " workspace-agent:one "},
		Permissions: PermissionPolicy{
			PermissionModeID: " full ",
			AllowedTools:     []string{" terminal ", "terminal", ""},
		},
	})
	if err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if rule.Trigger != TriggerOnTaskComplete || rule.Target.Kind != TargetAgent {
		t.Fatalf("normalized trigger/target = %q/%q", rule.Trigger, rule.Target.Kind)
	}
	if rule.Target.WorkspaceAgentID != "workspace-agent:one" {
		t.Fatalf("target agent = %q", rule.Target.WorkspaceAgentID)
	}
	if !reflect.DeepEqual(rule.Permissions, PermissionPolicy{
		PermissionModeID: "full",
		AllowedTools:     []string{"terminal"},
	}) {
		t.Fatalf("permissions = %#v", rule.Permissions)
	}
}

func TestNormalizeAcceptsBuiltinHarnessTarget(t *testing.T) {
	rule, err := Normalize(Rule{
		ID:          "rule-1",
		WorkspaceID: "ws",
		Name:        "Escalate",
		Trigger:     TriggerOnTaskFailed,
		Target:      Target{WorkspaceAgentID: "local:claude-code"},
	})
	if err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if rule.Target.WorkspaceAgentID != "local:claude-code" {
		t.Fatalf("target agent = %q", rule.Target.WorkspaceAgentID)
	}
}

func TestNormalizeRequiresAgentTarget(t *testing.T) {
	_, err := Normalize(Rule{
		ID:          "rule-1",
		WorkspaceID: "ws",
		Name:        "Follow up",
		Target:      Target{Kind: TargetAgent},
	})
	if !errors.Is(err, ErrInvalidRule) {
		t.Fatalf("Normalize() error = %v, want ErrInvalidRule", err)
	}
}

func TestNormalizeRejectsRetiredModelTarget(t *testing.T) {
	_, err := Normalize(Rule{
		ID:          "rule-1",
		WorkspaceID: "ws",
		Name:        "Consult",
		Target:      Target{Kind: "model", ModelPlanID: "plan-1"},
	})
	if !errors.Is(err, ErrInvalidRule) {
		t.Fatalf("Normalize() error = %v, want ErrInvalidRule", err)
	}
}

func TestNormalizeRejectsPlanOverride(t *testing.T) {
	_, err := Normalize(Rule{
		ID:          "rule-1",
		WorkspaceID: "ws",
		Name:        "Follow up",
		Target: Target{
			WorkspaceAgentID: "workspace-agent:one",
			ModelPlanID:      "plan-override",
		},
	})
	if !errors.Is(err, ErrInvalidRule) {
		t.Fatalf("Normalize() error = %v, want ErrInvalidRule", err)
	}
}

func TestNormalizeRejectsCapabilityOverride(t *testing.T) {
	_, err := Normalize(Rule{
		ID:          "rule-1",
		WorkspaceID: "ws",
		Name:        "Follow up",
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

func TestNormalizeExecutionRequiresIdentity(t *testing.T) {
	execution, err := NormalizeExecution(Execution{
		WorkspaceID:     " ws ",
		RuleID:          " rule-1 ",
		SourceSessionID: " session-1 ",
		TriggerID:       " turn-1 ",
		TargetSessionID: " target-1 ",
	})
	if err != nil {
		t.Fatalf("NormalizeExecution() error = %v", err)
	}
	if execution.WorkspaceID != "ws" || execution.TriggerID != "turn-1" || execution.Status != ExecutionLaunched {
		t.Fatalf("execution = %#v", execution)
	}
	if _, err := NormalizeExecution(Execution{WorkspaceID: "ws"}); !errors.Is(err, ErrInvalidRule) {
		t.Fatalf("NormalizeExecution(missing) error = %v, want ErrInvalidRule", err)
	}
}
