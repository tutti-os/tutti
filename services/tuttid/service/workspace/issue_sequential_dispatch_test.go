package workspace

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	collabrunservice "github.com/tutti-os/tutti/services/tuttid/service/collabrun"
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
	collaborationCounter := 0
	collaborations := &collabrunservice.Service{
		Store: store,
		Now:   func() time.Time { return time.UnixMilli(1700000000000).UTC() },
		NewID: func() string {
			collaborationCounter++
			return fmt.Sprintf("collaboration-%d", collaborationCounter)
		},
	}
	service := IssueManagerService{
		AgentSessionCreator: creator,
		CollaborationRuns:   collaborations,
		Store:               store,
		AgentTargetReader:   store,
	}
	detail, err := service.CreateIssueFromPlan(ctx, "workspace-sequential", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-sequential",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Sequential issue",
			PlanningSource:      string(workspaceissues.PlanningSourceUltraPlan),
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
	initialCollaborations, err := collaborations.ListRuns(ctx, "workspace-sequential", "planning-session", 0)
	if err != nil {
		t.Fatalf("ListRuns(initial) error = %v", err)
	}
	if len(initialCollaborations) != 1 || initialCollaborations[0].Mode != collabrunbiz.ModeDelegate || initialCollaborations[0].Status != collabrunbiz.StatusRunning || initialCollaborations[0].TargetSessionID != creator.inputs[0].AgentSessionID {
		t.Fatalf("initial collaborations = %#v", initialCollaborations)
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
	allCollaborations, err := collaborations.ListRuns(ctx, "workspace-sequential", "planning-session", 0)
	if err != nil {
		t.Fatalf("ListRuns(all) error = %v", err)
	}
	if len(allCollaborations) != 2 || allCollaborations[0].TargetSessionID != creator.inputs[1].AgentSessionID {
		t.Fatalf("all collaborations = %#v", allCollaborations)
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
			PlanningSource:    string(workspaceissues.PlanningSourceUltraPlan),
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
			PlanningSource: string(workspaceissues.PlanningSourceUltraPlan), ParallelExecution: true,
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
			PlanningSource:    string(workspaceissues.PlanningSourceUltraPlan),
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
			PlanningSource:      string(workspaceissues.PlanningSourceUltraPlan),
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
			PlanningSource:      string(workspaceissues.PlanningSourceUltraPlan),
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
			PlanningSource:      string(workspaceissues.PlanningSourceUltraPlan),
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
			PlanningSource:      string(workspaceissues.PlanningSourceUltraPlan),
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
