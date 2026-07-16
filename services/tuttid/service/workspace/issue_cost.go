package workspace

import (
	"context"
	"math"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

func (s IssueManagerService) estimateRunCost(ctx context.Context, run workspaceissues.Run, usage workspaceissues.TokenUsage) (workspaceissues.Cost, bool) {
	pricing, ok := s.modelPricing(ctx, run.WorkspaceID, run.ModelPlanID, run.Model)
	if !ok {
		return workspaceissues.Cost{}, false
	}
	return workspaceissues.Cost{
		Currency: pricing.Currency,
		EstimatedMicros: estimateTokenCostMicros(usage.InputTokens, pricing.InputMicrosPerMillion) +
			estimateTokenCostMicros(usage.OutputTokens, pricing.OutputMicrosPerMillion) +
			estimateTokenCostMicros(usage.CacheReadTokens, pricing.CacheReadMicrosPerMillion) +
			estimateTokenCostMicros(usage.CacheWriteTokens, pricing.CacheWriteMicrosPerMillion),
	}, true
}

func (s IssueManagerService) refreshIssueCostEstimateBestEffort(ctx context.Context, workspaceID string, issueID string) {
	store := s.Store
	if store == nil {
		return
	}
	issue, err := store.GetIssue(ctx, workspaceID, issueID)
	if err != nil {
		return
	}
	tasks, err := store.ListTasks(ctx, workspaceissues.TaskListFilter{WorkspaceID: workspaceID, IssueID: issueID, ReturnAll: true})
	if err != nil {
		return
	}
	runs, err := store.ListRuns(ctx, workspaceID, issueID, "")
	if err != nil {
		return
	}
	historyRuns, err := store.ListRuns(ctx, workspaceID, "", "")
	if err != nil {
		return
	}
	currency := issue.Cost.Currency
	if currency == "" {
		currency = "USD"
	}
	historicalEstimate := int64(0)
	for _, run := range runs {
		if run.Cost.Currency == "" || run.Cost.Currency == currency {
			historicalEstimate += run.Cost.EstimatedMicros
		}
	}
	if collaborationStore, ok := s.Store.(workspacedata.IssueCollaborationUsageStore); ok {
		if totals, totalsErr := collaborationStore.GetIssueCollaborationUsageTotals(ctx, workspaceID, issueID, currency); totalsErr == nil {
			historicalEstimate += totals.Cost.EstimatedMicros
		}
	}
	remainingTokens := maxInt64Value(issue.Budget.TokenLimit-issue.Budget.ConsumedTokens, 0)
	unfinished := make([]workspaceissues.Task, 0, len(tasks.Items))
	for _, task := range tasks.Items {
		if task.AcceptanceState != workspaceissues.AcceptanceUserAccepted {
			unfinished = append(unfinished, task)
		}
	}
	remainingEstimate := int64(0)
	if remainingTokens > 0 && len(unfinished) > 0 {
		perTask := remainingTokens / int64(len(unfinished))
		for _, task := range unfinished {
			pricing, ok := s.modelPricing(ctx, workspaceID, task.ModelPlanID, task.Model)
			if !ok || pricing.Currency != currency {
				continue
			}
			maxRate := maxInt64Value(
				maxInt64Value(pricing.InputMicrosPerMillion, pricing.OutputMicrosPerMillion),
				maxInt64Value(pricing.CacheReadMicrosPerMillion, pricing.CacheWriteMicrosPerMillion),
			)
			tokenEstimate := historicalTaskTokenEstimate(historyRuns, task)
			if tokenEstimate <= 0 {
				tokenEstimate = perTask
			}
			remainingEstimate += estimateTokenCostMicros(tokenEstimate, maxRate)
		}
	}
	issue.Cost.Currency = currency
	issue.Cost.EstimatedMicros = historicalEstimate + remainingEstimate
	_, _ = store.UpdateIssue(ctx, issue)
}

// historicalTaskTokenEstimate calibrates a remaining task from completed
// workspace runs with the same explicit model assignment. It purposely falls
// back to the Issue budget when no comparable history exists, keeping an
// estimate available on a newly created workspace.
func historicalTaskTokenEstimate(runs []workspaceissues.Run, task workspaceissues.Task) int64 {
	if strings.TrimSpace(task.ModelPlanID) == "" {
		return 0
	}
	var total int64
	var count int64
	for _, run := range runs {
		if run.Status != workspaceissues.StatusCompleted || run.Usage.Total() <= 0 {
			continue
		}
		if task.ModelPlanID != "" && run.ModelPlanID != task.ModelPlanID {
			continue
		}
		if task.Model != "" && run.Model != task.Model {
			continue
		}
		total += run.Usage.Total()
		count++
	}
	if count == 0 {
		return 0
	}
	return total / count
}

func (s IssueManagerService) historicalAutoTokenBudgetHint(ctx context.Context, workspaceID string, tasks []CreateIssueManagerTaskItemInput) int64 {
	total, _ := s.historicalAutoTokenBudgetEstimate(ctx, workspaceID, tasks)
	return total
}

func (s IssueManagerService) historicalAutoTokenBudgetEstimate(ctx context.Context, workspaceID string, tasks []CreateIssueManagerTaskItemInput) (int64, int) {
	if s.Store == nil || len(tasks) == 0 {
		return 0, 0
	}
	runs, err := s.Store.ListRuns(ctx, workspaceID, "", "")
	if err != nil {
		return 0, 0
	}
	var total int64
	matched := 0
	for _, task := range tasks {
		estimate := historicalTaskTokenEstimate(runs, workspaceissues.Task{
			AgentTargetID: task.AgentTargetID,
			ModelPlanID:   task.ModelPlanID,
			Model:         task.Model,
		})
		if estimate <= 0 {
			continue
		}
		if total > math.MaxInt64-estimate {
			return math.MaxInt64, matched + 1
		}
		total += estimate
		matched++
	}
	return total, matched
}

func (s IssueManagerService) modelPricing(ctx context.Context, workspaceID string, planID string, modelID string) (modelplanbiz.ModelPricing, bool) {
	if s.ModelPlanReader == nil || strings.TrimSpace(planID) == "" {
		return modelplanbiz.ModelPricing{}, false
	}
	plan, err := s.ModelPlanReader.GetModelPlan(ctx, workspaceID, planID)
	if err != nil {
		return modelplanbiz.ModelPricing{}, false
	}
	if plan.TemplateKind.BillingMode() != modelplanbiz.BillingAPIMetered {
		return modelplanbiz.ModelPricing{}, false
	}
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		modelID = plan.DefaultModel
	}
	for _, model := range plan.Models {
		if model.ID == modelID && model.Pricing != nil {
			return *model.Pricing, true
		}
	}
	return modelplanbiz.ModelPricing{}, false
}

func estimateTokenCostMicros(tokens int64, microsPerMillion int64) int64 {
	if tokens <= 0 || microsPerMillion <= 0 {
		return 0
	}
	estimated := math.Round(float64(tokens) * float64(microsPerMillion) / 1_000_000)
	if estimated >= math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(estimated)
}

func maxInt64Value(left int64, right int64) int64 {
	if left > right {
		return left
	}
	return right
}
