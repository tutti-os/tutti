package workspace

import (
	"context"
	"math"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

// historicalTaskTokenEstimate averages the observed token usage of completed
// runs comparable to a proposed task. Tasks without an explicit assignment
// match nothing; the model plan narrows the comparison first, the model only
// when set.
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
