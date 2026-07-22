package tuttimodeplan

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

var ErrIssueMaterializationConflict = errors.New("tutti mode plan Issue materialization conflicts with an existing Issue")

// WorkspaceIssueMaterializer is the explicit integration adapter from an
// accepted Tutti Mode Plan revision to the Workspace Issue execution domain.
// The composition root only injects the Issue Manager; mapping and retry
// policy remain local to the workflow capability that owns the handoff.
type WorkspaceIssueTarget interface {
	CreateIssueFromPlan(context.Context, string, workspaceservice.CreateIssueManagerIssueFromPlanInput) (workspaceissues.IssueDetail, error)
	GetIssueDetail(context.Context, string, string) (workspaceissues.IssueDetail, error)
}

type WorkspaceIssueMaterializer struct {
	Issues WorkspaceIssueTarget
}

func (materializer WorkspaceIssueMaterializer) MaterializeIssue(
	ctx context.Context,
	input MaterializeIssueInput,
) (string, error) {
	if materializer.Issues == nil {
		return "", ErrServiceUnavailable
	}
	issueID, ok := workflowbiz.TuttiModePlanIssueID(input.WorkflowID)
	if !ok || strings.TrimSpace(input.RevisionID) == "" || strings.TrimSpace(input.SourceSessionID) == "" {
		return "", ErrInvalidInput
	}
	if !actionableItemsHaveCanonicalOrder(input.ActionableItems) {
		return "", ErrInvalidInput
	}
	tasks := make([]workspaceservice.CreateIssueManagerTaskItemInput, 0, len(input.ActionableItems))
	for _, item := range input.ActionableItems {
		tasks = append(tasks, workspaceservice.CreateIssueManagerTaskItemInput{
			TaskID:             item.Task.ID,
			Title:              item.Task.Title,
			Content:            item.Task.Content,
			Priority:           item.Task.Priority,
			AgentTargetID:      item.Task.AgentTargetID,
			ModelPlanID:        item.Task.ModelPlanID,
			Model:              item.Task.Model,
			PermissionModeID:   item.Task.PermissionModeID,
			ReasoningEffort:    item.Task.ReasoningEffort,
			ExecutionDirectory: item.Task.ExecutionDirectory,
			DependencyTaskIDs:  append([]string(nil), item.Task.DependsOn...),
			Parallelizable:     item.Task.Parallelizable,
			AutoAccept:         item.Task.AutoAccept,
		})
	}
	detail, err := materializer.Issues.CreateIssueFromPlan(ctx, input.WorkspaceID, workspaceservice.CreateIssueManagerIssueFromPlanInput{
		Issue: workspaceservice.CreateIssueManagerIssueInput{
			IssueID:             issueID,
			TopicID:             input.TopicID,
			Title:               input.Title,
			Content:             input.Content,
			PlanningSource:      string(workspaceissues.PlanningSourceTuttiModePlan),
			SourceSessionID:     input.SourceSessionID,
			SequentialExecution: input.Execution.Mode == "sequential",
			ParallelExecution:   input.Execution.Mode == "parallel",
			ExecutionProfile: workspaceissues.ExecutionProfile{
				ReasoningIntensity:     input.Execution.ReasoningIntensity,
				OrchestrationIntensity: input.Execution.OrchestrationIntensity,
			},
			HasExecutionProfile: true,
			Budget: workspaceissues.Budget{
				Mode:                  workspaceissues.BudgetMode(input.Budget.Mode),
				TokenLimit:            input.Budget.TokenLimit,
				QuotaWaterlinePercent: input.Budget.QuotaWaterlinePercent,
			},
			HasBudget:              true,
			TuttiModeWorkflowOwned: true,
		},
		Tasks: tasks,
	})
	if err == nil {
		return detail.Issue.IssueID, nil
	}
	if !errors.Is(err, workspaceissues.ErrIssueAlreadyExists) {
		return "", err
	}
	existing, getErr := materializer.Issues.GetIssueDetail(ctx, input.WorkspaceID, issueID)
	if getErr != nil {
		return "", getErr
	}
	if !materializedIssueMatches(existing, input, issueID) {
		return "", fmt.Errorf("%w: %q", ErrIssueMaterializationConflict, issueID)
	}
	return existing.Issue.IssueID, nil
}

func materializedIssueMatches(existing workspaceissues.IssueDetail, input MaterializeIssueInput, issueID string) bool {
	issue := existing.Issue
	if strings.TrimSpace(issue.IssueID) != issueID ||
		issue.PlanningSource != workspaceissues.PlanningSourceTuttiModePlan ||
		strings.TrimSpace(issue.SourceSessionID) != strings.TrimSpace(input.SourceSessionID) ||
		strings.TrimSpace(issue.TopicID) != strings.TrimSpace(input.TopicID) ||
		strings.TrimSpace(issue.Title) != strings.TrimSpace(input.Title) ||
		strings.TrimSpace(issue.Content) != strings.TrimSpace(input.Content) ||
		issue.SequentialExecution != (input.Execution.Mode == "sequential") ||
		issue.ParallelExecution != (input.Execution.Mode == "parallel") ||
		issue.ExecutionProfile.ReasoningIntensity != input.Execution.ReasoningIntensity ||
		issue.ExecutionProfile.OrchestrationIntensity != input.Execution.OrchestrationIntensity ||
		issue.Budget.Mode != workspaceissues.BudgetMode(input.Budget.Mode) ||
		issue.Budget.QuotaWaterlinePercent != input.Budget.QuotaWaterlinePercent ||
		issue.Budget.Mode == workspaceissues.BudgetModeFixed && issue.Budget.TokenLimit != input.Budget.TokenLimit {
		return false
	}
	if len(existing.Tasks) != len(input.ActionableItems) {
		return false
	}
	existingByID := make(map[string]workspaceissues.Task, len(existing.Tasks))
	for _, task := range existing.Tasks {
		taskID := strings.TrimSpace(task.TaskID)
		if taskID == "" {
			return false
		}
		existingByID[taskID] = task
	}
	if len(existingByID) != len(existing.Tasks) {
		return false
	}
	expectedIDs := make(map[string]struct{}, len(input.ActionableItems))
	for index, item := range input.ActionableItems {
		if item.Ordinal != index+1 {
			return false
		}
		expected := item.Task
		expectedID := strings.TrimSpace(expected.ID)
		if expectedID == "" {
			return false
		}
		if _, duplicate := expectedIDs[expectedID]; duplicate {
			return false
		}
		expectedIDs[expectedID] = struct{}{}
		actual, found := existingByID[expectedID]
		if !found ||
			actual.SortIndex != item.Ordinal ||
			strings.TrimSpace(actual.Title) != strings.TrimSpace(expected.Title) ||
			strings.TrimSpace(actual.Content) != strings.TrimSpace(expected.Content) ||
			actual.Priority != workspaceissues.NormalizePriority(expected.Priority) ||
			strings.TrimSpace(actual.AgentTargetID) != strings.TrimSpace(expected.AgentTargetID) ||
			strings.TrimSpace(actual.ModelPlanID) != strings.TrimSpace(expected.ModelPlanID) ||
			strings.TrimSpace(actual.Model) != strings.TrimSpace(expected.Model) ||
			strings.TrimSpace(actual.PermissionModeID) != strings.TrimSpace(expected.PermissionModeID) ||
			strings.TrimSpace(actual.ReasoningEffort) != strings.TrimSpace(expected.ReasoningEffort) ||
			strings.TrimSpace(actual.ExecutionDirectory) != strings.TrimSpace(expected.ExecutionDirectory) ||
			actual.Parallelizable != expected.Parallelizable ||
			actual.AutoAccept != expected.AutoAccept ||
			!slices.Equal(actual.DependencyTaskIDs, workspaceissues.NormalizeDependencyTaskIDs(expected.DependsOn)) {
			return false
		}
	}
	return true
}

func actionableItemsHaveCanonicalOrder(items []ActionableItem) bool {
	for index, item := range items {
		if item.Ordinal != index+1 {
			return false
		}
	}
	return true
}
