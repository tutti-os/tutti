package modelplan

import (
	"sort"
	"strings"
)

const (
	defaultRecommendationLimit = 10
	maximumRecommendationLimit = 100
)

// RecommendInput describes one model-routing query. Required capabilities use
// the same vocabulary stored on Model.Capabilities.
type RecommendInput struct {
	RequiredCapabilities []string
	PreferredPlanID      string
	Limit                int
}

// Recommendation is one credential-redacted, explainable model route.
type Recommendation struct {
	PlanID       string
	PlanName     string
	BillingMode  BillingMode
	ModelID      string
	ModelName    string
	Tier         ModelTier
	Capabilities []string
	Pricing      *ModelPricing
	Status       PlanStatus
	Rank         int
	Reasons      []string
}

type recommendationCandidate struct {
	Recommendation
	healthRank int
	preferred  bool
	priced     bool
	currency   string
	price      int64
}

// RecommendModels filters models by required capabilities and ranks the
// enabled routes deterministically. Detection health wins over preference so
// a preferred but failed route cannot displace a ready route. Price is only a
// tie-breaker between routes that publish the same currency.
func RecommendModels(plans []PublicPlan, input RecommendInput) []Recommendation {
	required := normalizeRecommendationCapabilities(input.RequiredCapabilities)
	preferredPlanID := strings.TrimSpace(input.PreferredPlanID)
	limit := input.Limit
	if limit <= 0 {
		limit = defaultRecommendationLimit
	}
	if limit > maximumRecommendationLimit {
		limit = maximumRecommendationLimit
	}

	candidates := make([]recommendationCandidate, 0)
	for _, plan := range plans {
		if !plan.Enabled || plan.Status == StatusDisabled {
			continue
		}
		for _, model := range plan.Models {
			if !modelHasCapabilities(model, required) {
				continue
			}
			pricing := NormalizeModelPricing(model.Pricing)
			candidate := recommendationCandidate{
				Recommendation: Recommendation{
					PlanID:       plan.ID,
					PlanName:     plan.Name,
					BillingMode:  plan.BillingMode,
					ModelID:      model.ID,
					ModelName:    model.Name,
					Tier:         NormalizeModelTier(model.Tier),
					Capabilities: append([]string(nil), model.Capabilities...),
					Pricing:      pricing,
					Status:       plan.Status,
					Reasons:      recommendationReasons(plan, model, required, preferredPlanID, pricing),
				},
				healthRank: recommendationHealthRank(plan.Status),
				preferred:  preferredPlanID != "" && plan.ID == preferredPlanID,
			}
			if pricing != nil {
				candidate.priced = true
				candidate.currency = pricing.Currency
				candidate.price = pricing.InputMicrosPerMillion + pricing.OutputMicrosPerMillion +
					pricing.CacheReadMicrosPerMillion + pricing.CacheWriteMicrosPerMillion
			}
			candidates = append(candidates, candidate)
		}
	}

	sort.SliceStable(candidates, func(leftIndex int, rightIndex int) bool {
		left, right := candidates[leftIndex], candidates[rightIndex]
		if left.healthRank != right.healthRank {
			return left.healthRank < right.healthRank
		}
		if left.preferred != right.preferred {
			return left.preferred
		}
		if left.priced != right.priced {
			return left.priced
		}
		if left.priced && right.priced && left.currency == right.currency && left.price != right.price {
			return left.price < right.price
		}
		if left.PlanID != right.PlanID {
			return left.PlanID < right.PlanID
		}
		return left.ModelID < right.ModelID
	})

	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	result := make([]Recommendation, 0, len(candidates))
	for index := range candidates {
		candidate := candidates[index].Recommendation
		candidate.Rank = index + 1
		result = append(result, candidate)
	}
	return result
}

func normalizeRecommendationCapabilities(values []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func modelHasCapabilities(model Model, required []string) bool {
	if len(required) == 0 {
		return true
	}
	available := map[string]bool{}
	for _, capability := range model.Capabilities {
		available[strings.ToLower(strings.TrimSpace(capability))] = true
	}
	for _, capability := range required {
		if !available[capability] {
			return false
		}
	}
	return true
}

func recommendationHealthRank(status PlanStatus) int {
	switch status {
	case StatusReady:
		return 0
	case StatusPendingFirstUse:
		return 1
	case StatusUndetected:
		return 2
	case StatusDetectionFailed:
		return 3
	default:
		return 4
	}
}

func recommendationReasons(plan PublicPlan, model Model, required []string, preferredPlanID string, pricing *ModelPricing) []string {
	reasons := []string{"status:" + string(plan.Status)}
	if preferredPlanID != "" && plan.ID == preferredPlanID {
		reasons = append(reasons, "preferred_plan")
	}
	if model.ID == plan.DefaultModel {
		reasons = append(reasons, "default_model")
	}
	reasons = append(reasons, "tier:"+string(NormalizeModelTier(model.Tier)))
	for _, capability := range required {
		reasons = append(reasons, "capability:"+capability)
	}
	if pricing != nil {
		reasons = append(reasons, "priced:"+pricing.Currency)
	}
	return reasons
}
