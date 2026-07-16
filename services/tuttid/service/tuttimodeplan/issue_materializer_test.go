package tuttimodeplan

import (
	"context"
	"errors"
	"testing"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

type recordingWorkspaceIssueTarget struct {
	workspaceID string
	input       workspaceservice.CreateIssueManagerIssueFromPlanInput
	createErr   error
	existing    workspaceissues.IssueDetail
	getErr      error
}

func (target *recordingWorkspaceIssueTarget) CreateIssueFromPlan(
	_ context.Context,
	workspaceID string,
	input workspaceservice.CreateIssueManagerIssueFromPlanInput,
) (workspaceissues.IssueDetail, error) {
	target.workspaceID = workspaceID
	target.input = input
	if target.createErr != nil {
		return workspaceissues.IssueDetail{}, target.createErr
	}
	return workspaceissues.IssueDetail{Issue: workspaceissues.Issue{IssueID: input.Issue.IssueID}}, nil
}

func (target *recordingWorkspaceIssueTarget) GetIssueDetail(
	_ context.Context,
	_ string,
	issueID string,
) (workspaceissues.IssueDetail, error) {
	if target.getErr != nil {
		return workspaceissues.IssueDetail{}, target.getErr
	}
	if target.existing.Issue.IssueID != "" {
		return target.existing, nil
	}
	return workspaceissues.IssueDetail{Issue: workspaceissues.Issue{IssueID: issueID}}, nil
}

func TestWorkspaceIssueMaterializerMapsAcceptedProjectionIntoIssueDomain(t *testing.T) {
	t.Parallel()
	target := &recordingWorkspaceIssueTarget{}
	materializer := WorkspaceIssueMaterializer{Issues: target}

	issueID, err := materializer.MaterializeIssue(context.Background(), MaterializeIssueInput{
		WorkspaceID:     "workspace-1",
		WorkflowID:      "workflow-1",
		RevisionID:      "revision-1",
		SourceSessionID: "session-1",
		Title:           "Ship workflow",
		Content:         "Plan body",
		TopicID:         "topic-1",
		Execution: PlanExecution{
			Mode:                   "parallel",
			ReasoningIntensity:     70,
			OrchestrationIntensity: 80,
		},
		Budget: PlanBudget{Mode: "fixed", TokenLimit: 120_000, QuotaWaterlinePercent: 10},
		ActionableItems: []ActionableItem{{
			Ordinal: 1,
			Task: PlanTask{
				ID:                 "task-1",
				Title:              "Implement",
				Content:            "Build it",
				Priority:           "high",
				AgentTargetID:      "local:codex",
				ModelPlanID:        "plan-1",
				Model:              "gpt-5.4",
				ExecutionDirectory: "/workspace/task-1",
				DependsOn:          []string{"task-0"},
			},
		}},
	})
	if err != nil {
		t.Fatalf("MaterializeIssue() error = %v", err)
	}
	if issueID != "tutti-mode-plan-workflow-1" || target.workspaceID != "workspace-1" {
		t.Fatalf("MaterializeIssue() issueID=%q workspaceID=%q", issueID, target.workspaceID)
	}
	issue := target.input.Issue
	if issue.PlanningSource != string(workspaceissues.PlanningSourceTuttiModePlan) || !issue.ParallelExecution || issue.SequentialExecution {
		t.Fatalf("materialized issue execution/provenance = %#v", issue)
	}
	if !issue.TuttiModeWorkflowOwned {
		t.Fatal("materialized issue did not carry internal workflow authority")
	}
	if issue.SourceSessionID != "session-1" || issue.ExecutionProfile.ReasoningIntensity != 70 || issue.Budget.TokenLimit != 120_000 {
		t.Fatalf("materialized issue settings = %#v", issue)
	}
	if len(target.input.Tasks) != 1 || target.input.Tasks[0].TaskID != "task-1" || len(target.input.Tasks[0].DependencyTaskIDs) != 1 {
		t.Fatalf("materialized tasks = %#v", target.input.Tasks)
	}
}

func TestWorkspaceIssueMaterializerRejectsReservedIDPreemption(t *testing.T) {
	t.Parallel()
	input := materializeIssueFixture()
	target := &recordingWorkspaceIssueTarget{
		createErr: workspaceissues.ErrIssueAlreadyExists,
		existing: workspaceissues.IssueDetail{Issue: workspaceissues.Issue{
			IssueID:         "tutti-mode-plan-workflow-1",
			TopicID:         input.TopicID,
			Title:           input.Title,
			Content:         input.Content,
			PlanningSource:  workspaceissues.PlanningSourceManual,
			SourceSessionID: input.SourceSessionID,
		}},
	}

	if _, err := (WorkspaceIssueMaterializer{Issues: target}).MaterializeIssue(context.Background(), input); !errors.Is(err, ErrIssueMaterializationConflict) {
		t.Fatalf("MaterializeIssue() error = %v, want ErrIssueMaterializationConflict", err)
	}
}

func TestWorkspaceIssueMaterializerAcceptsOnlyStrictlyMatchingRetry(t *testing.T) {
	t.Parallel()
	input := materializeIssueFixture()
	existing := materializedIssueDetailFixture(input)
	target := &recordingWorkspaceIssueTarget{createErr: workspaceissues.ErrIssueAlreadyExists, existing: existing}

	issueID, err := (WorkspaceIssueMaterializer{Issues: target}).MaterializeIssue(context.Background(), input)
	if err != nil || issueID != "tutti-mode-plan-workflow-1" {
		t.Fatalf("MaterializeIssue() issueID=%q error=%v", issueID, err)
	}

	target.existing.Tasks[0].Content = "preempted content"
	if _, err := (WorkspaceIssueMaterializer{Issues: target}).MaterializeIssue(context.Background(), input); !errors.Is(err, ErrIssueMaterializationConflict) {
		t.Fatalf("MaterializeIssue() mismatched retry error = %v, want ErrIssueMaterializationConflict", err)
	}
}

func TestWorkspaceIssueMaterializerRejectsRetryWithDifferentTaskOrder(t *testing.T) {
	t.Parallel()
	input := materializeIssueFixture()
	input.ActionableItems = append(input.ActionableItems, ActionableItem{
		Ordinal: 2,
		Task: PlanTask{
			ID:        "task-2",
			Title:     "Verify",
			Content:   "Test it",
			Priority:  "medium",
			DependsOn: []string{"task-1"},
		},
	})
	existing := materializedIssueDetailFixture(input)
	existing.Tasks[0].SortIndex = 2
	existing.Tasks = append(existing.Tasks, workspaceissues.Task{
		TaskID:            "task-2",
		Title:             "Verify",
		Content:           "Test it",
		Priority:          workspaceissues.PriorityMedium,
		DependencyTaskIDs: []string{"task-1"},
		SortIndex:         1,
	})
	target := &recordingWorkspaceIssueTarget{createErr: workspaceissues.ErrIssueAlreadyExists, existing: existing}

	if _, err := (WorkspaceIssueMaterializer{Issues: target}).MaterializeIssue(context.Background(), input); !errors.Is(err, ErrIssueMaterializationConflict) {
		t.Fatalf("MaterializeIssue() reordered retry error = %v, want ErrIssueMaterializationConflict", err)
	}
}

func TestWorkspaceIssueMaterializerRejectsNonCanonicalActionableOrdinals(t *testing.T) {
	t.Parallel()
	input := materializeIssueFixture()
	input.ActionableItems[0].Ordinal = 0

	if _, err := (WorkspaceIssueMaterializer{Issues: &recordingWorkspaceIssueTarget{}}).MaterializeIssue(context.Background(), input); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("MaterializeIssue() invalid ordinal error = %v, want ErrInvalidInput", err)
	}
}

func materializeIssueFixture() MaterializeIssueInput {
	return MaterializeIssueInput{
		WorkspaceID:     "workspace-1",
		WorkflowID:      "workflow-1",
		RevisionID:      "revision-1",
		SourceSessionID: "session-1",
		Title:           "Ship workflow",
		Content:         "Plan body",
		TopicID:         "topic-1",
		Execution: PlanExecution{
			Mode:                   "parallel",
			ReasoningIntensity:     70,
			OrchestrationIntensity: 80,
		},
		Budget: PlanBudget{Mode: "fixed", TokenLimit: 120_000, QuotaWaterlinePercent: 10},
		ActionableItems: []ActionableItem{{Ordinal: 1, Task: PlanTask{
			ID:                 "task-1",
			Title:              "Implement",
			Content:            "Build it",
			Priority:           "high",
			AgentTargetID:      "local:codex",
			ModelPlanID:        "plan-1",
			Model:              "gpt-5.4",
			ExecutionDirectory: "/workspace/task-1",
			DependsOn:          []string{"task-0"},
		}}},
	}
}

func materializedIssueDetailFixture(input MaterializeIssueInput) workspaceissues.IssueDetail {
	return workspaceissues.IssueDetail{
		Issue: workspaceissues.Issue{
			IssueID:             "tutti-mode-plan-" + input.WorkflowID,
			TopicID:             input.TopicID,
			Title:               input.Title,
			Content:             input.Content,
			PlanningSource:      workspaceissues.PlanningSourceTuttiModePlan,
			SourceSessionID:     input.SourceSessionID,
			SequentialExecution: input.Execution.Mode == "sequential",
			ParallelExecution:   input.Execution.Mode == "parallel",
			ExecutionProfile: workspaceissues.ExecutionProfile{
				ReasoningIntensity:     input.Execution.ReasoningIntensity,
				OrchestrationIntensity: input.Execution.OrchestrationIntensity,
			},
			Budget: workspaceissues.Budget{
				Mode:                  workspaceissues.BudgetMode(input.Budget.Mode),
				TokenLimit:            input.Budget.TokenLimit,
				QuotaWaterlinePercent: input.Budget.QuotaWaterlinePercent,
				Status:                workspaceissues.BudgetStatusActive,
			},
		},
		Tasks: []workspaceissues.Task{{
			TaskID:             input.ActionableItems[0].Task.ID,
			Title:              input.ActionableItems[0].Task.Title,
			Content:            input.ActionableItems[0].Task.Content,
			Priority:           workspaceissues.Priority(input.ActionableItems[0].Task.Priority),
			AgentTargetID:      input.ActionableItems[0].Task.AgentTargetID,
			ModelPlanID:        input.ActionableItems[0].Task.ModelPlanID,
			Model:              input.ActionableItems[0].Task.Model,
			ExecutionDirectory: input.ActionableItems[0].Task.ExecutionDirectory,
			DependencyTaskIDs:  append([]string(nil), input.ActionableItems[0].Task.DependsOn...),
			SortIndex:          input.ActionableItems[0].Ordinal,
		}},
	}
}
