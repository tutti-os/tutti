package workspace

import (
	"context"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestIssueManagerServiceEstimatesCompletedRunCostFromModelPlanPricing(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-cost", Name: "Cost Workspace"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatalf("PutAgentTarget(%q) error = %v", target.ID, err)
		}
	}
	if err := store.PutModelPlan(ctx, modelplanbiz.Plan{
		ID:           "plan-cost",
		WorkspaceID:  "workspace-cost",
		Name:         "Priced Plan",
		TemplateKind: modelplanbiz.TemplateCustom,
		Protocol:     modelplanbiz.ProtocolOpenAI,
		Models: []modelplanbiz.Model{{
			ID: "model-cost",
			Pricing: &modelplanbiz.ModelPricing{
				Currency:                   "USD",
				InputMicrosPerMillion:      100,
				OutputMicrosPerMillion:     200,
				CacheReadMicrosPerMillion:  300,
				CacheWriteMicrosPerMillion: 400,
			},
		}},
		DefaultModel: "model-cost",
		Enabled:      true,
		Detection: modelplanbiz.DetectionSnapshot{Stages: []modelplanbiz.StageResult{
			{Stage: modelplanbiz.StageNetwork, Status: modelplanbiz.StagePassed},
			{Stage: modelplanbiz.StageAuth, Status: modelplanbiz.StagePassed},
			{Stage: modelplanbiz.StageModelDiscovery, Status: modelplanbiz.StagePassed},
			{Stage: modelplanbiz.StageInference, Status: modelplanbiz.StagePassed},
		}},
		FirstUse: modelplanbiz.FirstUse{Status: modelplanbiz.FirstUsePending},
	}); err != nil {
		t.Fatalf("PutModelPlan() error = %v", err)
	}
	if err := store.PutModelPlan(ctx, modelplanbiz.Plan{
		ID:           "plan-subscription",
		WorkspaceID:  "workspace-cost",
		Name:         "Subscription Plan",
		TemplateKind: modelplanbiz.TemplateCodingPlan,
		Protocol:     modelplanbiz.ProtocolOpenAI,
		Models: []modelplanbiz.Model{{
			ID:      "model-cost",
			Pricing: &modelplanbiz.ModelPricing{Currency: "USD", InputMicrosPerMillion: 100},
		}},
		DefaultModel: "model-cost",
		Enabled:      true,
	}); err != nil {
		t.Fatalf("PutModelPlan(subscription) error = %v", err)
	}

	service := IssueManagerService{Store: store, AgentTargetReader: store, ModelPlanReader: store}
	if pricing, ok := service.modelPricing(ctx, "workspace-cost", "plan-subscription", "model-cost"); ok {
		t.Fatalf("modelPricing(subscription) = %#v, want unavailable monetary cost", pricing)
	}
	if _, err := service.CreateIssue(ctx, "workspace-cost", CreateIssueManagerIssueInput{
		IssueID: "issue-cost",
		TopicID: workspaceissues.DefaultTopicID,
		Title:   "Cost Issue",
	}); err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	if _, err := service.CreateTask(ctx, "workspace-cost", "issue-cost", CreateIssueManagerTaskInput{
		TaskID:        "task-cost",
		Title:         "Cost Task",
		AgentTargetID: "local:codex",
		ModelPlanID:   "plan-cost",
		Model:         "model-cost",
	}); err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	run, err := service.CreateRun(ctx, "workspace-cost", "issue-cost", "task-cost", CreateIssueManagerRunInput{
		RunID:         "run-cost",
		AgentTargetID: "local:codex",
		AgentProvider: "codex",
		ModelPlanID:   "plan-cost",
		Model:         "model-cost",
	})
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}
	detail, err := service.CompleteRun(ctx, "workspace-cost", "issue-cost", "task-cost", run.RunID, CompleteIssueManagerRunInput{
		Status: string(workspaceissues.StatusCompleted),
		Usage: workspaceissues.TokenUsage{
			InputTokens:      1_000_000,
			OutputTokens:     2_000_000,
			CacheReadTokens:  3_000_000,
			CacheWriteTokens: 4_000_000,
		},
		Cost: workspaceissues.Cost{ActualMicros: 2_500},
	})
	if err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}
	if detail.Run.Cost.Currency != "USD" || detail.Run.Cost.EstimatedMicros != 3_000 || detail.Run.Cost.ActualMicros != 2_500 {
		t.Fatalf("CompleteRun() cost = %#v, want USD estimated 3000 actual 2500", detail.Run.Cost)
	}
	if hint := service.historicalAutoTokenBudgetHint(ctx, "workspace-cost", []CreateIssueManagerTaskItemInput{{
		AgentTargetID: "local:codex",
		ModelPlanID:   "plan-cost",
		Model:         "model-cost",
	}}); hint != 10_000_000 {
		t.Fatalf("historicalAutoTokenBudgetHint() = %d, want 10000000", hint)
	}
	estimate, err := service.EstimateAutoTokenBudget(ctx, "workspace-cost", EstimateIssueManagerAutoTokenBudgetInput{
		ExecutionProfile: workspaceissues.ExecutionProfile{ReasoningIntensity: 50, OrchestrationIntensity: 50},
		Tasks: []CreateIssueManagerTaskItemInput{{
			AgentTargetID: "local:codex",
			ModelPlanID:   "plan-cost",
			Model:         "model-cost",
		}},
	})
	if err != nil {
		t.Fatalf("EstimateAutoTokenBudget() error = %v", err)
	}
	if estimate.DeterministicTokenLimit != 64_000 || estimate.HistoricalTokenEstimate != 10_000_000 || estimate.MatchedHistoricalTaskCount != 1 || estimate.TokenLimit != 1_032_000 {
		t.Fatalf("EstimateAutoTokenBudget() = %#v", estimate)
	}
}

func TestEstimateTokenCostMicrosRoundsToNearestMicro(t *testing.T) {
	t.Parallel()
	if got := estimateTokenCostMicros(500_000, 3); got != 2 {
		t.Fatalf("estimateTokenCostMicros() = %d, want 2", got)
	}
}

func TestHistoricalTaskTokenEstimateUsesComparableCompletedRuns(t *testing.T) {
	t.Parallel()
	task := workspaceissues.Task{ModelPlanID: "plan-a", Model: "model-a"}
	runs := []workspaceissues.Run{
		{
			Status:      workspaceissues.StatusCompleted,
			ModelPlanID: "plan-a",
			Model:       "model-a",
			Usage:       workspaceissues.TokenUsage{InputTokens: 1_000, OutputTokens: 500},
		},
		{
			Status:      workspaceissues.StatusCompleted,
			ModelPlanID: "plan-a",
			Model:       "model-a",
			Usage:       workspaceissues.TokenUsage{InputTokens: 2_000, OutputTokens: 1_000},
		},
		{
			Status:      workspaceissues.StatusCompleted,
			ModelPlanID: "plan-b",
			Model:       "model-a",
			Usage:       workspaceissues.TokenUsage{InputTokens: 9_000},
		},
	}
	if got := historicalTaskTokenEstimate(runs, task); got != 2_250 {
		t.Fatalf("historicalTaskTokenEstimate() = %d, want 2250", got)
	}
	if got := historicalTaskTokenEstimate(runs, workspaceissues.Task{}); got != 0 {
		t.Fatalf("historicalTaskTokenEstimate(unassigned) = %d, want 0", got)
	}
}
