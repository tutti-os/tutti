package collabrun

import (
	"context"
	"strings"

	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

func (s *Service) estimateRunCost(ctx context.Context, run *collabrunbiz.Run) {
	if s == nil || s.Plans == nil || run == nil || strings.TrimSpace(run.ModelPlanID) == "" {
		return
	}
	plan, err := s.Plans.GetModelPlan(ctx, run.WorkspaceID, run.ModelPlanID)
	if err != nil || plan.TemplateKind.BillingMode() != modelplanbiz.BillingAPIMetered {
		return
	}
	modelID := strings.TrimSpace(run.Model)
	for _, model := range plan.Models {
		if strings.TrimSpace(model.ID) != modelID || model.Pricing == nil {
			continue
		}
		pricing := modelplanbiz.NormalizeModelPricing(model.Pricing)
		if pricing == nil || strings.TrimSpace(pricing.Currency) == "" {
			return
		}
		run.Cost = collabrunbiz.Cost{
			Currency: strings.ToUpper(strings.TrimSpace(pricing.Currency)),
			EstimatedMicros: tokenCostMicros(run.Usage.InputTokens, pricing.InputMicrosPerMillion) +
				tokenCostMicros(run.Usage.OutputTokens, pricing.OutputMicrosPerMillion) +
				tokenCostMicros(run.Usage.CacheReadTokens, pricing.CacheReadMicrosPerMillion) +
				tokenCostMicros(run.Usage.CacheWriteTokens, pricing.CacheWriteMicrosPerMillion),
		}
		return
	}
}

func tokenCostMicros(tokens int64, microsPerMillion int64) int64 {
	if tokens <= 0 || microsPerMillion <= 0 {
		return 0
	}
	whole := tokens / 1_000_000
	remainder := tokens % 1_000_000
	return whole*microsPerMillion + (remainder*microsPerMillion+500_000)/1_000_000
}
