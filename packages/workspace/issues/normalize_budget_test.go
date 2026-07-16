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
