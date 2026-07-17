package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type sequentialSessionCreatorRecorder struct {
	inputs []agentservice.CreateSessionInput
}

func (r *sequentialSessionCreatorRecorder) Create(_ context.Context, _ string, input agentservice.CreateSessionInput) (agentservice.Session, error) {
	r.inputs = append(r.inputs, input)
	return agentservice.Session{ID: input.AgentSessionID, AgentTargetID: input.AgentTargetID, Provider: "codex"}, nil
}

func TestIssueSequentialExecutionDispatchesSuccessorOnlyAfterUserAcceptance(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-sequential", Name: "Sequential"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatalf("PutAgentTarget(%q) error = %v", target.ID, err)
		}
	}
	creator := &sequentialSessionCreatorRecorder{}
	service := IssueManagerService{
		AgentSessionCreator: creator,
		Store:               store,
		AgentTargetReader:   store,
	}
	detail, err := service.CreateIssueFromPlan(ctx, "workspace-sequential", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-sequential",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Sequential issue",
			PlanningSource:      string(workspaceissues.PlanningSourceTraditionalPlan),
			SourceSessionID:     "planning-session",
			SequentialExecution: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{
			{TaskID: "task-1", Title: "First", AgentTargetID: agenttargetbiz.IDLocalCodex},
			{TaskID: "task-2", Title: "Second", AgentTargetID: agenttargetbiz.IDLocalCodex, DependencyTaskIDs: []string{"task-1"}},
		},
	})
	if err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	if len(creator.inputs) != 1 || creator.inputs[0].AgentSessionID == "" {
		t.Fatalf("initial dispatches = %#v, want one durable session launch", creator.inputs)
	}
	if creator.inputs[0].ReasoningIntensity == nil || *creator.inputs[0].ReasoningIntensity != workspaceissues.DefaultReasoningIntensity {
		t.Fatalf("initial reasoning intensity = %#v, want Issue default", creator.inputs[0].ReasoningIntensity)
	}
	first := detail.Tasks[0]
	if first.Status != workspaceissues.StatusRunning || first.LatestRunID == "" {
		t.Fatalf("first task = %#v, want running with run", first)
	}
	if _, err := service.CompleteRun(ctx, "workspace-sequential", detail.Issue.IssueID, first.TaskID, first.LatestRunID, CompleteIssueManagerRunInput{
		Status: string(workspaceissues.StatusCompleted),
	}); err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}
	if len(creator.inputs) != 1 {
		t.Fatalf("dispatches before acceptance = %d, want 1", len(creator.inputs))
	}
	if _, err := service.UpdateTask(ctx, "workspace-sequential", detail.Issue.IssueID, first.TaskID, UpdateIssueManagerTaskInput{
		Status:    string(workspaceissues.StatusCompleted),
		HasStatus: true,
	}); err != nil {
		t.Fatalf("UpdateTask(accept) error = %v", err)
	}
	if len(creator.inputs) != 2 {
		t.Fatalf("dispatches after acceptance = %d, want 2", len(creator.inputs))
	}
	updated, err := service.GetIssueDetail(ctx, "workspace-sequential", detail.Issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if updated.Tasks[1].Status != workspaceissues.StatusRunning {
		t.Fatalf("second task status = %q, want running", updated.Tasks[1].Status)
	}
}

func TestIssueParallelExecutionDispatchesIndependentRootsAndWaitsForAcceptedDependencies(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-parallel", Name: "Parallel"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatalf("PutAgentTarget(%q) error = %v", target.ID, err)
		}
	}
	creator := &sequentialSessionCreatorRecorder{}
	service := IssueManagerService{
		AgentSessionCreator: creator,
		Store:               store,
		AgentTargetReader:   store,
	}
	detail, err := service.CreateIssueFromPlan(ctx, "workspace-parallel", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:           "issue-parallel",
			TopicID:           workspaceissues.DefaultTopicID,
			Title:             "Parallel issue",
			PlanningSource:    string(workspaceissues.PlanningSourceTraditionalPlan),
			ParallelExecution: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{
			{TaskID: "task-1", Title: "First root", AgentTargetID: agenttargetbiz.IDLocalCodex, ExecutionDirectory: "/worktrees/task-1"},
			{TaskID: "task-2", Title: "Second root", AgentTargetID: agenttargetbiz.IDLocalCodex, ExecutionDirectory: "/worktrees/task-2"},
			{TaskID: "task-3", Title: "Dependent", AgentTargetID: agenttargetbiz.IDLocalCodex, ExecutionDirectory: "/worktrees/task-3", DependencyTaskIDs: []string{"task-1"}},
		},
	})
	if err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	if len(creator.inputs) != 2 {
		t.Fatalf("initial parallel dispatches = %d, want 2", len(creator.inputs))
	}
	if detail.Tasks[0].Status != workspaceissues.StatusRunning || detail.Tasks[1].Status != workspaceissues.StatusRunning || detail.Tasks[2].Status != workspaceissues.StatusNotStarted {
		t.Fatalf("initial task states = %#v", detail.Tasks)
	}
	first := detail.Tasks[0]
	if _, err := service.CompleteRun(ctx, "workspace-parallel", detail.Issue.IssueID, first.TaskID, first.LatestRunID, CompleteIssueManagerRunInput{
		Status: string(workspaceissues.StatusCompleted),
	}); err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}
	if len(creator.inputs) != 2 {
		t.Fatalf("dispatches before acceptance = %d, want 2", len(creator.inputs))
	}
	if _, err := service.UpdateTask(ctx, "workspace-parallel", detail.Issue.IssueID, first.TaskID, UpdateIssueManagerTaskInput{
		Status:    string(workspaceissues.StatusCompleted),
		HasStatus: true,
	}); err != nil {
		t.Fatalf("UpdateTask(accept) error = %v", err)
	}
	if len(creator.inputs) != 3 {
		t.Fatalf("dispatches after acceptance = %d, want 3", len(creator.inputs))
	}
	updated, err := service.GetIssueDetail(ctx, "workspace-parallel", detail.Issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if updated.Tasks[2].Status != workspaceissues.StatusRunning {
		t.Fatalf("dependent task status = %q, want running", updated.Tasks[2].Status)
	}
}

func TestIssueParallelExecutionHonorsWorkspaceConcurrencyAndRefillsSlots(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-parallel-limit", Name: "Parallel limit"}); err != nil {
		t.Fatal(err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatal(err)
		}
	}
	creator := &sequentialSessionCreatorRecorder{}
	service := IssueManagerService{AgentSessionCreator: creator, Store: store, AgentTargetReader: store}
	tasks := make([]CreateIssueManagerTaskItemInput, 0, maxWorkspaceParallelIssueRuns+1)
	for index := 0; index < maxWorkspaceParallelIssueRuns+1; index++ {
		tasks = append(tasks, CreateIssueManagerTaskItemInput{
			TaskID:             fmt.Sprintf("task-limit-%d", index),
			Title:              fmt.Sprintf("Parallel %d", index),
			AgentTargetID:      agenttargetbiz.IDLocalCodex,
			ExecutionDirectory: fmt.Sprintf("/worktrees/limit-%d", index),
		})
	}
	detail, err := service.CreateIssueFromPlan(ctx, "workspace-parallel-limit", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID: "issue-parallel-limit", TopicID: workspaceissues.DefaultTopicID, Title: "Bounded parallel",
			PlanningSource: string(workspaceissues.PlanningSourceTraditionalPlan), ParallelExecution: true,
		},
		Tasks: tasks,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(creator.inputs) != maxWorkspaceParallelIssueRuns {
		t.Fatalf("initial parallel dispatches = %d, want %d", len(creator.inputs), maxWorkspaceParallelIssueRuns)
	}
	first := detail.Tasks[0]
	if _, err := service.CompleteRun(ctx, "workspace-parallel-limit", detail.Issue.IssueID, first.TaskID, first.LatestRunID, CompleteIssueManagerRunInput{Status: string(workspaceissues.StatusCompleted)}); err != nil {
		t.Fatal(err)
	}
	if len(creator.inputs) != maxWorkspaceParallelIssueRuns+1 {
		t.Fatalf("dispatches after slot refill = %d, want %d", len(creator.inputs), maxWorkspaceParallelIssueRuns+1)
	}
}

func TestIssueParallelExecutionRejectsSharedExecutionDirectory(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-parallel-unsafe", Name: "Parallel unsafe"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	service := IssueManagerService{Store: store}
	_, err := service.CreateIssueFromPlan(ctx, "workspace-parallel-unsafe", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			TopicID:           workspaceissues.DefaultTopicID,
			Title:             "Unsafe parallel issue",
			PlanningSource:    string(workspaceissues.PlanningSourceTraditionalPlan),
			ParallelExecution: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{
			{Title: "One", AgentTargetID: agenttargetbiz.IDLocalCodex, ExecutionDirectory: "/shared"},
			{Title: "Two", AgentTargetID: agenttargetbiz.IDLocalCodex, ExecutionDirectory: "/shared"},
		},
	})
	if !errors.Is(err, workspaceissues.ErrInvalidArgument) {
		t.Fatalf("CreateIssueFromPlan() error = %v, want ErrInvalidArgument", err)
	}
}

func TestIssueAgentSessionSettlementCompletesRunWithUsageAndAgentClaim(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-settlement", Name: "Settlement"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatalf("PutAgentTarget(%q) error = %v", target.ID, err)
		}
	}
	creator := &sequentialSessionCreatorRecorder{}
	service := IssueManagerService{
		AgentSessionCreator: creator,
		Store:               store,
		AgentTargetReader:   store,
	}
	detail, err := service.CreateIssueFromPlan(ctx, "workspace-settlement", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-settlement",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Settle from Agent state",
			PlanningSource:      string(workspaceissues.PlanningSourceTraditionalPlan),
			SequentialExecution: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{{
			TaskID:        "task-settlement",
			Title:         "Execute",
			AgentTargetID: agenttargetbiz.IDLocalCodex,
		}},
	})
	if err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	outcome := "completed"
	service.ObserveAgentSessionState(ctx, agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    "workspace-settlement",
		AgentSessionID: creator.inputs[0].AgentSessionID,
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			TurnLifecycle: &agentsessionstore.WorkspaceAgentTurnLifecycle{Phase: "settled", Outcome: &outcome},
			RuntimeContext: map[string]any{
				"usage": map[string]any{
					"inputTokens":      int64(100),
					"outputTokens":     int64(20),
					"cacheReadTokens":  int64(30),
					"cacheWriteTokens": int64(40),
					"quotas": []map[string]any{{
						"quotaType":        "weekly",
						"percentRemaining": float64(25),
					}},
				},
			},
		},
	}, agentsessionstore.ReportSessionStateReply{})

	settled, err := service.GetIssueDetail(ctx, "workspace-settlement", detail.Issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	task := settled.Tasks[0]
	if task.Status != workspaceissues.StatusPendingAcceptance || task.AcceptanceState != workspaceissues.AcceptanceAgentClaimed {
		t.Fatalf("settled task = %#v, want pending acceptance with Agent claim", task)
	}
	if settled.LatestRun == nil || settled.LatestRun.Status != workspaceissues.StatusCompleted || settled.LatestRun.Usage.Total() != 190 {
		t.Fatalf("latest run = %#v, want completed with all usage categories", settled.LatestRun)
	}
	if settled.Issue.Budget.ConsumedTokens != 190 || !settled.Issue.Budget.HasRemainingQuota || settled.Issue.Budget.RemainingQuotaPercent != 25 {
		t.Fatalf("settled Issue budget = %#v", settled.Issue.Budget)
	}
	if err := service.RecordAutomationReviewOutcome(ctx, "workspace-settlement", creator.inputs[0].AgentSessionID, "All checks passed.\nVERDICT: PASS", true, true); err != nil {
		t.Fatalf("RecordAutomationReviewOutcome() error = %v", err)
	}
	reviewed, err := service.GetIssueDetail(ctx, "workspace-settlement", detail.Issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail(reviewed) error = %v", err)
	}
	if reviewed.Tasks[0].AcceptanceState != workspaceissues.AcceptanceAutoChecked || !strings.Contains(reviewed.Tasks[0].AcceptanceSummary, "VERDICT: PASS") {
		t.Fatalf("reviewed task = %#v, want auto_checked with review evidence", reviewed.Tasks[0])
	}
}

func TestIssueBudgetRecoveryUpdateResumesEligibleDispatch(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-budget-recovery", Name: "Budget recovery"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatalf("PutAgentTarget(%q) error = %v", target.ID, err)
		}
	}
	creator := &sequentialSessionCreatorRecorder{}
	service := IssueManagerService{
		AgentSessionCreator: creator,
		Store:               store,
		AgentTargetReader:   store,
	}
	detail, err := service.CreateIssueFromPlan(ctx, "workspace-budget-recovery", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-budget-recovery",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Recover budget",
			PlanningSource:      string(workspaceissues.PlanningSourceTraditionalPlan),
			SequentialExecution: true,
			HasBudget:           true,
			Budget: workspaceissues.Budget{
				Mode:                  workspaceissues.BudgetModeFixed,
				TokenLimit:            60_000,
				QuotaWaterlinePercent: workspaceissues.DefaultQuotaWaterlinePercent,
			},
		},
		Tasks: []CreateIssueManagerTaskItemInput{
			{TaskID: "task-budget-1", Title: "First", AgentTargetID: agenttargetbiz.IDLocalCodex},
			{TaskID: "task-budget-2", Title: "Second", AgentTargetID: agenttargetbiz.IDLocalCodex, DependencyTaskIDs: []string{"task-budget-1"}},
		},
	})
	if err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	first := detail.Tasks[0]
	if _, err := service.CompleteRun(ctx, "workspace-budget-recovery", detail.Issue.IssueID, first.TaskID, first.LatestRunID, CompleteIssueManagerRunInput{
		Status: string(workspaceissues.StatusCompleted),
		Usage:  workspaceissues.TokenUsage{InputTokens: 30_000},
	}); err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}
	if _, err := service.UpdateTask(ctx, "workspace-budget-recovery", detail.Issue.IssueID, first.TaskID, UpdateIssueManagerTaskInput{
		Status:    string(workspaceissues.StatusCompleted),
		HasStatus: true,
	}); err != nil {
		t.Fatalf("UpdateTask(accept) error = %v", err)
	}
	if len(creator.inputs) != 1 {
		t.Fatalf("dispatches while soft limited = %d, want 1", len(creator.inputs))
	}
	if _, err := service.UpdateIssue(ctx, "workspace-budget-recovery", detail.Issue.IssueID, UpdateIssueManagerIssueInput{
		HasBudget: true,
		Budget: workspaceissues.Budget{
			Mode:                  workspaceissues.BudgetModeFixed,
			TokenLimit:            100_000,
			QuotaWaterlinePercent: workspaceissues.DefaultQuotaWaterlinePercent,
		},
	}); err != nil {
		t.Fatalf("UpdateIssue(add budget) error = %v", err)
	}
	if len(creator.inputs) != 2 {
		t.Fatalf("dispatches after budget recovery = %d, want 2", len(creator.inputs))
	}
}

func TestIssueLowerIntensityRecoveryReleasesPreDispatchBudgetGate(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-intensity-recovery", Name: "Intensity recovery"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatalf("PutAgentTarget(%q) error = %v", target.ID, err)
		}
	}
	creator := &sequentialSessionCreatorRecorder{}
	service := IssueManagerService{
		AgentSessionCreator: creator,
		Store:               store,
		AgentTargetReader:   store,
	}
	detail, err := service.CreateIssueFromPlan(ctx, "workspace-intensity-recovery", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-intensity-recovery",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Lower intensity",
			PlanningSource:      string(workspaceissues.PlanningSourceTraditionalPlan),
			SequentialExecution: true,
			HasBudget:           true,
			Budget: workspaceissues.Budget{
				Mode:                  workspaceissues.BudgetModeFixed,
				TokenLimit:            60_000,
				QuotaWaterlinePercent: workspaceissues.DefaultQuotaWaterlinePercent,
			},
		},
		Tasks: []CreateIssueManagerTaskItemInput{
			{TaskID: "task-intensity-1", Title: "First", AgentTargetID: agenttargetbiz.IDLocalCodex},
			{TaskID: "task-intensity-2", Title: "Second", AgentTargetID: agenttargetbiz.IDLocalCodex, DependencyTaskIDs: []string{"task-intensity-1"}},
		},
	})
	if err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	first := detail.Tasks[0]
	if _, err := service.CompleteRun(ctx, "workspace-intensity-recovery", detail.Issue.IssueID, first.TaskID, first.LatestRunID, CompleteIssueManagerRunInput{
		Status: string(workspaceissues.StatusCompleted),
		Usage:  workspaceissues.TokenUsage{InputTokens: 30_000},
	}); err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}
	if _, err := service.UpdateTask(ctx, "workspace-intensity-recovery", detail.Issue.IssueID, first.TaskID, UpdateIssueManagerTaskInput{
		Status:    string(workspaceissues.StatusCompleted),
		HasStatus: true,
	}); err != nil {
		t.Fatalf("UpdateTask(accept) error = %v", err)
	}
	if len(creator.inputs) != 1 {
		t.Fatalf("dispatches before intensity recovery = %d, want 1", len(creator.inputs))
	}
	softLimited, err := service.GetIssueDetail(ctx, "workspace-intensity-recovery", detail.Issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if softLimited.Issue.Budget.Status != workspaceissues.BudgetStatusSoftLimited {
		t.Fatalf("budget status = %q, want soft_limited", softLimited.Issue.Budget.Status)
	}
	if _, err := service.UpdateIssue(ctx, "workspace-intensity-recovery", detail.Issue.IssueID, UpdateIssueManagerIssueInput{
		ExecutionProfile:    workspaceissues.ExecutionProfile{},
		HasExecutionProfile: true,
		HasBudget:           true,
		Budget: workspaceissues.Budget{
			Mode:                  workspaceissues.BudgetModeFixed,
			TokenLimit:            60_000,
			QuotaWaterlinePercent: workspaceissues.DefaultQuotaWaterlinePercent,
		},
	}); err != nil {
		t.Fatalf("UpdateIssue(lower intensity) error = %v", err)
	}
	if len(creator.inputs) != 2 {
		t.Fatalf("dispatches after intensity recovery = %d, want 2", len(creator.inputs))
	}
}

func TestIssueExplicitPauseBlocksOnlyFutureDispatchAndResumeContinues(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-dispatch-pause", Name: "Dispatch pause"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatalf("PutAgentTarget(%q) error = %v", target.ID, err)
		}
	}
	creator := &sequentialSessionCreatorRecorder{}
	service := IssueManagerService{
		AgentSessionCreator: creator,
		Store:               store,
		AgentTargetReader:   store,
	}
	detail, err := service.CreateIssueFromPlan(ctx, "workspace-dispatch-pause", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-dispatch-pause",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Pause dispatch",
			PlanningSource:      string(workspaceissues.PlanningSourceTraditionalPlan),
			SequentialExecution: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{
			{TaskID: "task-pause-1", Title: "First", AgentTargetID: agenttargetbiz.IDLocalCodex},
			{TaskID: "task-pause-2", Title: "Second", AgentTargetID: agenttargetbiz.IDLocalCodex, DependencyTaskIDs: []string{"task-pause-1"}},
		},
	})
	if err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	if len(creator.inputs) != 1 {
		t.Fatalf("initial dispatches = %d, want 1", len(creator.inputs))
	}
	paused, err := service.UpdateIssue(ctx, "workspace-dispatch-pause", detail.Issue.IssueID, UpdateIssueManagerIssueInput{
		DispatchPaused:    true,
		HasDispatchPaused: true,
	})
	if err != nil {
		t.Fatalf("UpdateIssue(pause) error = %v", err)
	}
	if !paused.DispatchPaused {
		t.Fatalf("DispatchPaused = false after durable pause")
	}
	first := detail.Tasks[0]
	if _, err := service.CompleteRun(ctx, "workspace-dispatch-pause", detail.Issue.IssueID, first.TaskID, first.LatestRunID, CompleteIssueManagerRunInput{Status: string(workspaceissues.StatusCompleted)}); err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}
	if _, err := service.UpdateTask(ctx, "workspace-dispatch-pause", detail.Issue.IssueID, first.TaskID, UpdateIssueManagerTaskInput{Status: string(workspaceissues.StatusCompleted), HasStatus: true}); err != nil {
		t.Fatalf("UpdateTask(accept) error = %v", err)
	}
	if len(creator.inputs) != 1 {
		t.Fatalf("dispatches while explicitly paused = %d, want 1", len(creator.inputs))
	}
	resumed, err := service.UpdateIssue(ctx, "workspace-dispatch-pause", detail.Issue.IssueID, UpdateIssueManagerIssueInput{
		DispatchPaused:    false,
		HasDispatchPaused: true,
	})
	if err != nil {
		t.Fatalf("UpdateIssue(resume) error = %v", err)
	}
	if resumed.DispatchPaused {
		t.Fatalf("DispatchPaused = true after resume")
	}
	if len(creator.inputs) != 2 {
		t.Fatalf("dispatches after resume = %d, want 2", len(creator.inputs))
	}
}

type strictPermissionSessionCreator struct {
	inputs         []agentservice.CreateSessionInput
	supportedModes map[string]struct{}
}

func (r *strictPermissionSessionCreator) Create(_ context.Context, _ string, input agentservice.CreateSessionInput) (agentservice.Session, error) {
	r.inputs = append(r.inputs, input)
	if input.StrictPermissionMode && input.PermissionModeID != nil {
		if _, ok := r.supportedModes[*input.PermissionModeID]; !ok {
			return agentservice.Session{}, fmt.Errorf("unsupported permission mode %q", *input.PermissionModeID)
		}
	}
	return agentservice.Session{ID: input.AgentSessionID, AgentTargetID: input.AgentTargetID, Provider: "codex"}, nil
}

func TestIssueTaskLaunchAppliesTaskLevelOverridesWithStrictPermissionMode(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-strict-overrides", Name: "Strict overrides"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatalf("PutAgentTarget(%q) error = %v", target.ID, err)
		}
	}
	creator := &strictPermissionSessionCreator{supportedModes: map[string]struct{}{"acceptEdits": {}}}
	service := IssueManagerService{
		AgentSessionCreator: creator,
		Store:               store,
		AgentTargetReader:   store,
	}

	if _, err := service.CreateIssueFromPlan(ctx, "workspace-strict-overrides", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-with-overrides",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Task-level overrides",
			PlanningSource:      string(workspaceissues.PlanningSourceTraditionalPlan),
			SequentialExecution: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{{
			TaskID:           "task-with-overrides",
			Title:            "Overridden launch",
			AgentTargetID:    agenttargetbiz.IDLocalCodex,
			PermissionModeID: "acceptEdits",
			ReasoningEffort:  "high",
		}},
	}); err != nil {
		t.Fatalf("CreateIssueFromPlan(overrides) error = %v", err)
	}
	if len(creator.inputs) != 1 {
		t.Fatalf("dispatches = %d, want 1", len(creator.inputs))
	}
	launch := creator.inputs[0]
	if launch.PermissionModeID == nil || *launch.PermissionModeID != "acceptEdits" || !launch.StrictPermissionMode {
		t.Fatalf("launch permission mode = %#v strict=%v, want strict explicit acceptEdits", launch.PermissionModeID, launch.StrictPermissionMode)
	}
	if launch.ReasoningEffort == nil || *launch.ReasoningEffort != "high" {
		t.Fatalf("launch reasoning effort = %#v, want explicit high", launch.ReasoningEffort)
	}

	// A task without an explicit permission mode keeps the provider-default
	// resolution and must not opt into strict rejection.
	if _, err := service.CreateIssueFromPlan(ctx, "workspace-strict-overrides", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-without-overrides",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Default launch",
			PlanningSource:      string(workspaceissues.PlanningSourceTraditionalPlan),
			SequentialExecution: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{{
			TaskID:        "task-without-overrides",
			Title:         "Default launch",
			AgentTargetID: agenttargetbiz.IDLocalCodex,
		}},
	}); err != nil {
		t.Fatalf("CreateIssueFromPlan(defaults) error = %v", err)
	}
	if len(creator.inputs) != 2 {
		t.Fatalf("dispatches = %d, want 2", len(creator.inputs))
	}
	if creator.inputs[1].PermissionModeID != nil || creator.inputs[1].StrictPermissionMode {
		t.Fatalf("default launch = %#v strict=%v, want no explicit mode and no strict flag", creator.inputs[1].PermissionModeID, creator.inputs[1].StrictPermissionMode)
	}
}

func TestIssueTaskLaunchFailsClosedOnUnsupportedPermissionMode(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-strict-reject", Name: "Strict reject"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatalf("PutAgentTarget(%q) error = %v", target.ID, err)
		}
	}
	creator := &strictPermissionSessionCreator{supportedModes: map[string]struct{}{"acceptEdits": {}}}
	service := IssueManagerService{
		AgentSessionCreator: creator,
		Store:               store,
		AgentTargetReader:   store,
	}

	detail, err := service.CreateIssueFromPlan(ctx, "workspace-strict-reject", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-strict-reject",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Stale permission mode",
			PlanningSource:      string(workspaceissues.PlanningSourceTraditionalPlan),
			SequentialExecution: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{{
			TaskID:           "task-strict-reject",
			Title:            "Launch with stale mode",
			AgentTargetID:    agenttargetbiz.IDLocalCodex,
			PermissionModeID: "bogus-mode",
		}},
	})
	if err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	if len(creator.inputs) != 1 || !creator.inputs[0].StrictPermissionMode {
		t.Fatalf("launch inputs = %#v, want one strict launch attempt", creator.inputs)
	}

	settled, err := service.GetIssueDetail(ctx, "workspace-strict-reject", detail.Issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	task := settled.Tasks[0]
	if task.Status == workspaceissues.StatusRunning {
		t.Fatalf("task status = %q, want fail-closed launch instead of a silently downgraded running session", task.Status)
	}
	if settled.LatestRun == nil || settled.LatestRun.Status != workspaceissues.StatusFailed ||
		!strings.Contains(settled.LatestRun.ErrorMessage, "unsupported permission mode") {
		t.Fatalf("latest run = %#v, want failed run carrying the strict rejection", settled.LatestRun)
	}
}

func initIssueTaskGitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is unavailable in this environment")
	}
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "--initial-branch=main"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "Test"},
		{"commit", "--allow-empty", "-m", "init"},
	} {
		command := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v error = %v: %s", args, err, output)
		}
	}
	return dir
}

func newParallelizableDispatchService(t *testing.T, workspaceID string) (IssueManagerService, *sequentialSessionCreatorRecorder, string) {
	t.Helper()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Workspace"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatalf("PutAgentTarget(%q) error = %v", target.ID, err)
		}
	}
	creator := &sequentialSessionCreatorRecorder{}
	worktreeRoot := t.TempDir()
	service := IssueManagerService{
		AgentSessionCreator: creator,
		Store:               store,
		AgentTargetReader:   store,
		TaskWorktreeRoot:    worktreeRoot,
	}
	return service, creator, worktreeRoot
}

func acceptIssueTask(t *testing.T, service IssueManagerService, workspaceID string, issueID string, taskID string) {
	t.Helper()
	ctx := context.Background()
	detail, err := service.GetIssueDetail(ctx, workspaceID, issueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	for _, task := range detail.Tasks {
		if task.TaskID != taskID {
			continue
		}
		if _, err := service.CompleteRun(ctx, workspaceID, issueID, taskID, task.LatestRunID, CompleteIssueManagerRunInput{
			Status: string(workspaceissues.StatusCompleted),
		}); err != nil {
			t.Fatalf("CompleteRun(%q) error = %v", taskID, err)
		}
		if _, err := service.UpdateTask(ctx, workspaceID, issueID, taskID, UpdateIssueManagerTaskInput{
			Status:    string(workspaceissues.StatusCompleted),
			HasStatus: true,
		}); err != nil {
			t.Fatalf("UpdateTask(accept %q) error = %v", taskID, err)
		}
		return
	}
	t.Fatalf("task %q not found", taskID)
}

func TestSequentialIssueRunsParallelizableTasksInIsolatedWorktrees(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	repo := initIssueTaskGitRepo(t)
	service, creator, worktreeRoot := newParallelizableDispatchService(t, "ws-par-worktree")
	if _, err := service.CreateIssueFromPlan(ctx, "ws-par-worktree", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-worktree",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Worktree issue",
			PlanningSource:      string(workspaceissues.PlanningSourceTraditionalPlan),
			SequentialExecution: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{
			{TaskID: "p1", Title: "First parallel", AgentTargetID: agenttargetbiz.IDLocalCodex, ExecutionDirectory: repo, Parallelizable: true},
			{TaskID: "p2", Title: "Second parallel", AgentTargetID: agenttargetbiz.IDLocalCodex, ExecutionDirectory: repo, Parallelizable: true},
		},
	}); err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	if len(creator.inputs) != 2 {
		t.Fatalf("dispatches = %d, want both parallelizable tasks launched together", len(creator.inputs))
	}
	cwds := map[string]bool{}
	for _, input := range creator.inputs {
		if input.Cwd == nil || *input.Cwd == "" {
			t.Fatalf("launch cwd missing: %#v", input)
		}
		cwd := *input.Cwd
		if cwd == repo {
			t.Fatalf("launch reused the shared checkout %q instead of a worktree", cwd)
		}
		if !strings.HasPrefix(cwd, worktreeRoot) {
			t.Fatalf("worktree %q is outside the configured root %q", cwd, worktreeRoot)
		}
		if _, err := os.Stat(filepath.Join(cwd, ".git")); err != nil {
			t.Fatalf("worktree %q is not a linked checkout: %v", cwd, err)
		}
		cwds[cwd] = true
		prompt := creator.inputs[0].InitialContent[0].Text
		if !strings.Contains(prompt, "dedicated git worktree") || !strings.Contains(prompt, "Do not push") {
			t.Fatalf("prompt lacks worktree isolation contract: %q", prompt)
		}
	}
	if len(cwds) != 2 {
		t.Fatalf("worktree cwds = %v, want two distinct directories", cwds)
	}
}

func TestSequentialIssueDegradesSharedNonGitParallelizableTasksToExclusive(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	shared := t.TempDir()
	service, creator, _ := newParallelizableDispatchService(t, "ws-par-degrade")
	if _, err := service.CreateIssueFromPlan(ctx, "ws-par-degrade", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-degrade",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Degrade issue",
			PlanningSource:      string(workspaceissues.PlanningSourceTraditionalPlan),
			SequentialExecution: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{
			{TaskID: "p1", Title: "First", AgentTargetID: agenttargetbiz.IDLocalCodex, ExecutionDirectory: shared, Parallelizable: true},
			{TaskID: "p2", Title: "Second", AgentTargetID: agenttargetbiz.IDLocalCodex, ExecutionDirectory: shared, Parallelizable: true},
		},
	}); err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	if len(creator.inputs) != 1 {
		t.Fatalf("dispatches = %d, want exclusive degradation for a shared non-git directory", len(creator.inputs))
	}
	if creator.inputs[0].Cwd == nil || *creator.inputs[0].Cwd != shared {
		t.Fatalf("exclusive launch cwd = %#v, want the shared directory", creator.inputs[0].Cwd)
	}
	acceptIssueTask(t, service, "ws-par-degrade", "issue-degrade", "p1")
	if len(creator.inputs) != 2 {
		t.Fatalf("dispatches after acceptance = %d, want the successor", len(creator.inputs))
	}
}

func TestSequentialIssueExclusiveTaskWaitsForParallelizableBatch(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	repo := initIssueTaskGitRepo(t)
	service, creator, _ := newParallelizableDispatchService(t, "ws-par-barrier")
	if _, err := service.CreateIssueFromPlan(ctx, "ws-par-barrier", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-barrier",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Barrier issue",
			PlanningSource:      string(workspaceissues.PlanningSourceTraditionalPlan),
			SequentialExecution: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{
			{TaskID: "p1", Title: "First parallel", AgentTargetID: agenttargetbiz.IDLocalCodex, ExecutionDirectory: repo, Parallelizable: true},
			{TaskID: "p2", Title: "Second parallel", AgentTargetID: agenttargetbiz.IDLocalCodex, ExecutionDirectory: repo, Parallelizable: true},
			{TaskID: "s3", Title: "Exclusive", AgentTargetID: agenttargetbiz.IDLocalCodex, ExecutionDirectory: repo},
		},
	}); err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	if len(creator.inputs) != 2 {
		t.Fatalf("initial dispatches = %d, want only the parallelizable batch", len(creator.inputs))
	}
	acceptIssueTask(t, service, "ws-par-barrier", "issue-barrier", "p1")
	if len(creator.inputs) != 2 {
		t.Fatalf("dispatches with p2 still live = %d, exclusive task must wait", len(creator.inputs))
	}
	acceptIssueTask(t, service, "ws-par-barrier", "issue-barrier", "p2")
	if len(creator.inputs) != 3 {
		t.Fatalf("dispatches after batch drained = %d, want the exclusive task", len(creator.inputs))
	}
	exclusive := creator.inputs[2]
	if exclusive.Cwd == nil || *exclusive.Cwd != repo {
		t.Fatalf("exclusive launch cwd = %#v, want the base checkout", exclusive.Cwd)
	}
}

func TestAutoAcceptTaskCompletionAdvancesDispatchWithoutHumanGate(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-auto-accept", Name: "Auto accept"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatalf("PutAgentTarget(%q) error = %v", target.ID, err)
		}
	}
	creator := &sequentialSessionCreatorRecorder{}
	service := IssueManagerService{
		AgentSessionCreator: creator,
		Store:               store,
		AgentTargetReader:   store,
	}
	detail, err := service.CreateIssueFromPlan(ctx, "workspace-auto-accept", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-auto-accept",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Auto accept issue",
			PlanningSource:      string(workspaceissues.PlanningSourceTraditionalPlan),
			SourceSessionID:     "planning-session",
			SequentialExecution: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{
			{TaskID: "task-1", Title: "First", AgentTargetID: agenttargetbiz.IDLocalCodex, AutoAccept: true},
			{TaskID: "task-2", Title: "Second", AgentTargetID: agenttargetbiz.IDLocalCodex, DependencyTaskIDs: []string{"task-1"}},
		},
	})
	if err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	first := detail.Tasks[0]
	if _, err := service.CompleteRun(ctx, "workspace-auto-accept", detail.Issue.IssueID, first.TaskID, first.LatestRunID, CompleteIssueManagerRunInput{
		Status: string(workspaceissues.StatusCompleted),
	}); err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}
	if len(creator.inputs) != 2 {
		t.Fatalf("dispatches after auto-accepted completion = %d, want 2", len(creator.inputs))
	}
	updated, err := service.GetIssueDetail(ctx, "workspace-auto-accept", detail.Issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if updated.Tasks[0].Status != workspaceissues.StatusCompleted ||
		updated.Tasks[0].AcceptanceState != workspaceissues.AcceptanceUserAccepted {
		t.Fatalf("auto-accepted task = %#v, want completed and user_accepted", updated.Tasks[0])
	}
	if updated.Tasks[1].Status != workspaceissues.StatusRunning {
		t.Fatalf("second task status = %q, want running", updated.Tasks[1].Status)
	}
}

func TestReworkFromPendingAcceptanceRedispatchesSequentialHead(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-rework", Name: "Rework"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatalf("PutAgentTarget(%q) error = %v", target.ID, err)
		}
	}
	creator := &sequentialSessionCreatorRecorder{}
	service := IssueManagerService{
		AgentSessionCreator: creator,
		Store:               store,
		AgentTargetReader:   store,
	}
	detail, err := service.CreateIssueFromPlan(ctx, "workspace-rework", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-rework",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Rework issue",
			PlanningSource:      string(workspaceissues.PlanningSourceTraditionalPlan),
			SourceSessionID:     "planning-session",
			SequentialExecution: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{
			{TaskID: "task-1", Title: "Only", AgentTargetID: agenttargetbiz.IDLocalCodex},
		},
	})
	if err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	first := detail.Tasks[0]
	if _, err := service.CompleteRun(ctx, "workspace-rework", detail.Issue.IssueID, first.TaskID, first.LatestRunID, CompleteIssueManagerRunInput{
		Status: string(workspaceissues.StatusCompleted),
	}); err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}
	if len(creator.inputs) != 1 {
		t.Fatalf("dispatches while pending acceptance = %d, want 1", len(creator.inputs))
	}
	if _, err := service.UpdateTask(ctx, "workspace-rework", detail.Issue.IssueID, first.TaskID, UpdateIssueManagerTaskInput{
		Status:    string(workspaceissues.StatusNotStarted),
		HasStatus: true,
	}); err != nil {
		t.Fatalf("UpdateTask(rework) error = %v", err)
	}
	if len(creator.inputs) != 2 {
		t.Fatalf("dispatches after rework = %d, want 2", len(creator.inputs))
	}
	updated, err := service.GetIssueDetail(ctx, "workspace-rework", detail.Issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if updated.Tasks[0].Status != workspaceissues.StatusRunning {
		t.Fatalf("reworked task status = %q, want running", updated.Tasks[0].Status)
	}
}

type tuttiPlanNotifierRecorder struct {
	completedIssueIDs []string
	failedRunIDs      []string
}

func (r *tuttiPlanNotifierRecorder) NotifyTuttiPlanIssueCompleted(_ context.Context, _ string, issue workspaceissues.Issue, _ []workspaceissues.Task) {
	r.completedIssueIDs = append(r.completedIssueIDs, issue.IssueID)
}

func (r *tuttiPlanNotifierRecorder) NotifyTuttiPlanIssueTaskFailed(_ context.Context, _ string, _ workspaceissues.Issue, _ workspaceissues.Task, run workspaceissues.Run) {
	r.failedRunIDs = append(r.failedRunIDs, run.RunID)
}

func TestFailedRunNotifiesPlanningConversationAndReworkRedispatches(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-fail-notify", Name: "Fail notify"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatalf("PutAgentTarget(%q) error = %v", target.ID, err)
		}
	}
	creator := &sequentialSessionCreatorRecorder{}
	notifier := &tuttiPlanNotifierRecorder{}
	service := IssueManagerService{
		AgentSessionCreator: creator,
		CompletionNotifier:  notifier,
		Store:               store,
		AgentTargetReader:   store,
	}
	detail, err := service.CreateIssueFromPlan(ctx, "workspace-fail-notify", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:                "tutti-mode-plan-fail-notify",
			TopicID:                workspaceissues.DefaultTopicID,
			Title:                  "Fail notify issue",
			PlanningSource:         string(workspaceissues.PlanningSourceTuttiModePlan),
			SourceSessionID:        "planning-session",
			SequentialExecution:    true,
			TuttiModeWorkflowOwned: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{
			{TaskID: "task-1", Title: "Only", AgentTargetID: agenttargetbiz.IDLocalCodex},
		},
	})
	if err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	first := detail.Tasks[0]
	if _, err := service.CompleteRun(ctx, "workspace-fail-notify", detail.Issue.IssueID, first.TaskID, first.LatestRunID, CompleteIssueManagerRunInput{
		Status:       string(workspaceissues.StatusFailed),
		ErrorMessage: "Agent session ended without reporting run completion.",
	}); err != nil {
		t.Fatalf("CompleteRun(failed) error = %v", err)
	}
	if len(notifier.failedRunIDs) != 1 || notifier.failedRunIDs[0] != first.LatestRunID {
		t.Fatalf("failure notifications = %#v, want the failed run reported once", notifier.failedRunIDs)
	}
	if len(notifier.completedIssueIDs) != 0 {
		t.Fatalf("completion notifications = %#v, want none", notifier.completedIssueIDs)
	}
	if _, err := service.UpdateTask(ctx, "workspace-fail-notify", detail.Issue.IssueID, first.TaskID, UpdateIssueManagerTaskInput{
		Status:    string(workspaceissues.StatusNotStarted),
		HasStatus: true,
	}); err != nil {
		t.Fatalf("UpdateTask(rework failed task) error = %v", err)
	}
	if len(creator.inputs) != 2 {
		t.Fatalf("dispatches after rework of failed task = %d, want 2", len(creator.inputs))
	}
	updated, err := service.GetIssueDetail(ctx, "workspace-fail-notify", detail.Issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if updated.Tasks[0].Status != workspaceissues.StatusRunning {
		t.Fatalf("reworked task status = %q, want running", updated.Tasks[0].Status)
	}
}

func TestChainedParallelizableFlagsNormalizeToDependencyOrder(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	service, _, _ := newParallelizableDispatchService(t, "ws-par-normalize")
	detail, err := service.CreateIssueFromPlan(ctx, "ws-par-normalize", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-normalize",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Normalize issue",
			PlanningSource:      string(workspaceissues.PlanningSourceTraditionalPlan),
			SequentialExecution: true,
		},
		// A chained "parallel" group: p2 depends on its neighbor p1, so its
		// flag is a lie the dispatcher would ignore; p3 depends on p2 (now
		// exclusive) and may honestly stay parallelizable for future siblings.
		Tasks: []CreateIssueManagerTaskItemInput{
			{TaskID: "p1", Title: "First", AgentTargetID: agenttargetbiz.IDLocalCodex, Parallelizable: true},
			{TaskID: "p2", Title: "Second", AgentTargetID: agenttargetbiz.IDLocalCodex, Parallelizable: true, DependencyTaskIDs: []string{"p1"}},
			{TaskID: "p3", Title: "Third", AgentTargetID: agenttargetbiz.IDLocalCodex, Parallelizable: true, DependencyTaskIDs: []string{"p2"}},
		},
	})
	if err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	flags := map[string]bool{}
	for _, task := range detail.Tasks {
		flags[task.TaskID] = task.Parallelizable
	}
	if !flags["p1"] || flags["p2"] || !flags["p3"] {
		t.Fatalf("normalized parallelizable flags = %v, want p1=true p2=false p3=true", flags)
	}
}

func TestIntegrationTaskPromptCarriesDependencyWorktreeBranches(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	repo := initIssueTaskGitRepo(t)
	service, creator, _ := newParallelizableDispatchService(t, "ws-par-integrate")
	if _, err := service.CreateIssueFromPlan(ctx, "ws-par-integrate", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-integrate",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Integrate issue",
			PlanningSource:      string(workspaceissues.PlanningSourceTraditionalPlan),
			SequentialExecution: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{
			{TaskID: "p1", Title: "First parallel", AgentTargetID: agenttargetbiz.IDLocalCodex, ExecutionDirectory: repo, Parallelizable: true},
			{TaskID: "p2", Title: "Second parallel", AgentTargetID: agenttargetbiz.IDLocalCodex, ExecutionDirectory: repo, Parallelizable: true},
			{TaskID: "integrate", Title: "Integrate", AgentTargetID: agenttargetbiz.IDLocalCodex, ExecutionDirectory: repo, DependencyTaskIDs: []string{"p1", "p2"}},
		},
	}); err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	if len(creator.inputs) != 2 {
		t.Fatalf("initial dispatches = %d, want the parallel pair", len(creator.inputs))
	}
	acceptIssueTask(t, service, "ws-par-integrate", "issue-integrate", "p1")
	acceptIssueTask(t, service, "ws-par-integrate", "issue-integrate", "p2")
	if len(creator.inputs) != 3 {
		t.Fatalf("dispatches after acceptance = %d, want the integration task", len(creator.inputs))
	}
	prompt := creator.inputs[2].InitialContent[0].Text
	if !strings.Contains(prompt, "Dependency outputs") ||
		!strings.Contains(prompt, "branch tutti/task/p1-") ||
		!strings.Contains(prompt, "branch tutti/task/p2-") ||
		!strings.Contains(prompt, "git merge") {
		t.Fatalf("integration prompt lacks dependency branch pointers: %q", prompt)
	}
}
