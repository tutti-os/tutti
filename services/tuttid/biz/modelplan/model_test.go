package modelplan

import "testing"

func TestNormalizeModelsPreservesNormalizedPricingAndCloneIsIndependent(t *testing.T) {
	models := NormalizeModels([]Model{{
		ID:   " model-1 ",
		Name: " Model One ",
		Pricing: &ModelPricing{
			Currency:                   " usd ",
			InputMicrosPerMillion:      100,
			OutputMicrosPerMillion:     200,
			CacheReadMicrosPerMillion:  30,
			CacheWriteMicrosPerMillion: 40,
		},
	}})
	if len(models) != 1 || models[0].Pricing == nil || models[0].Pricing.Currency != "USD" {
		t.Fatalf("NormalizeModels() = %#v, want one model with USD pricing", models)
	}

	cloned := CloneModels(models)
	cloned[0].Pricing.InputMicrosPerMillion = 999
	if models[0].Pricing.InputMicrosPerMillion != 100 {
		t.Fatalf("CloneModels() shared pricing pointer; original = %#v", models[0].Pricing)
	}
}

func TestNormalizeModelPricingRejectsInvalidUnitPrice(t *testing.T) {
	if got := NormalizeModelPricing(&ModelPricing{Currency: "USD", InputMicrosPerMillion: -1}); got != nil {
		t.Fatalf("NormalizeModelPricing() = %#v, want nil for negative price", got)
	}
}

func TestNormalizeModelsDefaultsAndPreservesTier(t *testing.T) {
	models := NormalizeModels([]Model{
		{ID: "default"},
		{ID: "frontier", Tier: ModelTierFlagship},
		{ID: "cheap", Tier: ModelTier(" ECONOMY ")},
	})
	if models[0].Tier != ModelTierStandard || models[1].Tier != ModelTierFlagship || models[2].Tier != ModelTierEconomy {
		t.Fatalf("NormalizeModels() tiers = %#v", models)
	}
}

func TestSubscriptionBillingModeStripsMonetaryPricing(t *testing.T) {
	plan, err := Normalize(Plan{
		ID:           "plan-subscription",
		WorkspaceID:  "workspace-1",
		Name:         "Subscription",
		TemplateKind: TemplateCodingPlan,
		Protocol:     ProtocolAnthropic,
		Models: []Model{{
			ID:      "model-1",
			Pricing: &ModelPricing{Currency: "USD", InputMicrosPerMillion: 100},
		}},
	})
	if err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if plan.TemplateKind.BillingMode() != BillingSubscriptionQuota || plan.Models[0].Pricing != nil {
		t.Fatalf("Normalize() subscription = %#v, want quota billing without pricing", plan)
	}

	legacy := plan
	legacy.Models[0].Pricing = &ModelPricing{Currency: "USD", InputMicrosPerMillion: 100}
	public := Public(legacy)
	if public.BillingMode != BillingSubscriptionQuota || public.Models[0].Pricing != nil {
		t.Fatalf("Public() subscription = %#v, want fail-safe redaction", public)
	}
	if legacy.Models[0].Pricing == nil {
		t.Fatal("Public() mutated the durable model list")
	}
}
