package workspaceissues

import (
	"math"
	"testing"
)

func TestNormalizeBudgetRejectsNonFinitePercentages(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name   string
		budget Budget
	}{
		{name: "quota nan", budget: Budget{Mode: BudgetModeAuto, QuotaWaterlinePercent: math.NaN()}},
		{name: "quota positive infinity", budget: Budget{Mode: BudgetModeAuto, QuotaWaterlinePercent: math.Inf(1)}},
		{name: "quota negative infinity", budget: Budget{Mode: BudgetModeAuto, QuotaWaterlinePercent: math.Inf(-1)}},
		{name: "remaining nan", budget: Budget{Mode: BudgetModeAuto, HasRemainingQuota: true, RemainingQuotaPercent: math.NaN()}},
		{name: "remaining positive infinity", budget: Budget{Mode: BudgetModeAuto, HasRemainingQuota: true, RemainingQuotaPercent: math.Inf(1)}},
		{name: "remaining negative infinity", budget: Budget{Mode: BudgetModeAuto, HasRemainingQuota: true, RemainingQuotaPercent: math.Inf(-1)}},
		{name: "unobserved remaining nan", budget: Budget{Mode: BudgetModeAuto, RemainingQuotaPercent: math.NaN()}},
		{name: "unobserved remaining infinity", budget: Budget{Mode: BudgetModeAuto, RemainingQuotaPercent: math.Inf(1)}},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if normalized, ok := NormalizeBudget(test.budget); ok {
				t.Fatalf("NormalizeBudget(%s) = %#v, want rejection", test.name, normalized)
			}
		})
	}
}

func TestIssueAutomaticRunAdmissionSlotsCombinesWorkspaceAndIssueLimits(t *testing.T) {
	t.Parallel()

	issue := Issue{
		Budget: Budget{
			Status:     BudgetStatusActive,
			TokenLimit: CompileEstimatedRunTokenBudget(ExecutionProfile{}) * 4,
		},
	}
	if got := IssueAutomaticRunAdmissionSlots(issue, 3, 1); got != 1 {
		t.Fatalf("IssueAutomaticRunAdmissionSlots() = %d, want workspace-limited 1", got)
	}
	if got := IssueAutomaticRunAdmissionSlots(issue, 2, 2); got != 2 {
		t.Fatalf("IssueAutomaticRunAdmissionSlots() = %d, want budget-limited 2", got)
	}
}

func TestIssueTaskEligibleForRunRequiresAcceptedDependencies(t *testing.T) {
	t.Parallel()

	dependency := Task{
		TaskID:          "dependency",
		Status:          StatusCompleted,
		AcceptanceState: AcceptanceUserAccepted,
	}
	task := Task{
		TaskID:            "task",
		Status:            StatusNotStarted,
		AgentTargetID:     "local:codex",
		DependencyTaskIDs: []string{dependency.TaskID},
	}
	byID := map[string]Task{dependency.TaskID: dependency, task.TaskID: task}
	if !IssueTaskEligibleForRun(task, byID) {
		t.Fatal("IssueTaskEligibleForRun() = false, want accepted dependency eligible")
	}
	dependency.AcceptanceState = AcceptanceAgentClaimed
	byID[dependency.TaskID] = dependency
	if IssueTaskEligibleForRun(task, byID) {
		t.Fatal("IssueTaskEligibleForRun() = true, want unaccepted dependency rejected")
	}
	delete(byID, dependency.TaskID)
	if IssueTaskEligibleForRun(task, byID) {
		t.Fatal("IssueTaskEligibleForRun() = true, want missing dependency rejected")
	}
}
