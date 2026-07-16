package modelplan

import "testing"

func TestRecommendModelsFiltersCapabilitiesAndPrefersHealthBeforePreference(t *testing.T) {
	plans := []PublicPlan{
		{
			ID: "preferred-failed", Name: "Preferred", Enabled: true, Status: StatusDetectionFailed,
			Models: []Model{{ID: "vision-expensive", Name: "Vision", Capabilities: []string{"vision"}}},
		},
		{
			ID: "ready", Name: "Ready", Enabled: true, Status: StatusReady, DefaultModel: "vision-cheap",
			Models: []Model{
				{ID: "text", Name: "Text"},
				{ID: "vision-cheap", Name: "Vision Cheap", Capabilities: []string{"Vision"}, Pricing: &ModelPricing{Currency: "usd", InputMicrosPerMillion: 10}},
			},
		},
		{ID: "disabled", Enabled: false, Status: StatusDisabled, Models: []Model{{ID: "vision", Capabilities: []string{"vision"}}}},
	}

	result := RecommendModels(plans, RecommendInput{
		RequiredCapabilities: []string{" vision ", "VISION"},
		PreferredPlanID:      "preferred-failed",
	})

	if len(result) != 2 {
		t.Fatalf("len(result) = %d, want 2: %#v", len(result), result)
	}
	if result[0].PlanID != "ready" || result[0].ModelID != "vision-cheap" || result[0].Rank != 1 {
		t.Fatalf("first recommendation = %#v", result[0])
	}
	if result[1].PlanID != "preferred-failed" || result[1].Rank != 2 {
		t.Fatalf("second recommendation = %#v", result[1])
	}
	if result[0].Pricing == nil || result[0].Pricing.Currency != "USD" {
		t.Fatalf("normalized pricing = %#v", result[0].Pricing)
	}
	if result[0].Tier != ModelTierStandard || !containsReason(result[0].Reasons, "tier:standard") {
		t.Fatalf("tier recommendation = %#v", result[0])
	}
}

func containsReason(reasons []string, target string) bool {
	for _, reason := range reasons {
		if reason == target {
			return true
		}
	}
	return false
}

func TestRecommendModelsUsesPreferenceAndSameCurrencyPriceAsTieBreakers(t *testing.T) {
	plans := []PublicPlan{
		{ID: "a", Name: "A", Enabled: true, Status: StatusReady, Models: []Model{
			{ID: "high", Name: "High", Pricing: &ModelPricing{Currency: "USD", InputMicrosPerMillion: 100}},
			{ID: "low", Name: "Low", Pricing: &ModelPricing{Currency: "USD", InputMicrosPerMillion: 10}},
		}},
		{ID: "b", Name: "B", Enabled: true, Status: StatusReady, Models: []Model{{ID: "preferred", Name: "Preferred"}}},
	}

	result := RecommendModels(plans, RecommendInput{PreferredPlanID: "b", Limit: 2})
	if len(result) != 2 || result[0].PlanID != "b" || result[1].ModelID != "low" {
		t.Fatalf("recommendations = %#v", result)
	}
	if result[0].Reasons[1] != "preferred_plan" {
		t.Fatalf("preferred reasons = %#v", result[0].Reasons)
	}
}
