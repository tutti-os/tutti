package workspace

import (
	"context"
	"errors"
	"math"
	"path/filepath"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

func TestIssueManagerRejectsNonFiniteBudgetBeforePersistence(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-nonfinite", Name: "Nonfinite"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	service := IssueManagerService{Store: store}
	_, err := service.CreateIssue(ctx, "workspace-nonfinite", CreateIssueManagerIssueInput{
		IssueID: "issue-nonfinite", TopicID: workspaceissues.DefaultTopicID, Title: "Invalid budget",
		HasBudget: true,
		Budget: workspaceissues.Budget{
			Mode: workspaceissues.BudgetModeAuto, QuotaWaterlinePercent: math.NaN(),
		},
	})
	if !errors.Is(err, workspaceissues.ErrInvalidArgument) {
		t.Fatalf("CreateIssue() error = %v, want ErrInvalidArgument", err)
	}
	if _, err := store.GetIssue(ctx, "workspace-nonfinite", "issue-nonfinite"); !errors.Is(err, workspaceissues.ErrIssueNotFound) {
		t.Fatalf("GetIssue() error = %v, want no persisted invalid issue", err)
	}
}

func TestIssueManagerReservesTuttiModePlanIssueIDsForWorkflowMaterialization(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openIssueServiceStore(t)
	const workspaceID = "workspace-reserved-tutti-issue"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Reserved Tutti Issue"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	service := IssueManagerService{Store: store}
	task := []CreateIssueManagerTaskItemInput{{TaskID: "task-1", Title: "Implement"}}

	if _, err := service.CreateIssue(ctx, workspaceID, CreateIssueManagerIssueInput{
		IssueID: workflowbiz.TuttiModePlanIssueIDPrefix + "manual",
		TopicID: workspaceissues.DefaultTopicID,
		Title:   "Manual preemption",
	}); !errors.Is(err, workspaceissues.ErrInvalidArgument) {
		t.Fatalf("CreateIssue() error = %v, want ErrInvalidArgument", err)
	}
	if _, err := service.CreateIssue(ctx, workspaceID, CreateIssueManagerIssueInput{
		IssueID:         "ordinary-forged-tutti",
		TopicID:         workspaceissues.DefaultTopicID,
		Title:           "Forged Tutti provenance",
		PlanningSource:  string(workspaceissues.PlanningSourceTuttiModePlan),
		SourceSessionID: "session-1",
	}); !errors.Is(err, workspaceissues.ErrInvalidArgument) {
		t.Fatalf("CreateIssue(forged Tutti provenance) error = %v, want ErrInvalidArgument", err)
	}

	for name, issue := range map[string]CreateIssueManagerIssueInput{
		"traditional plan cannot use reserved id": {
			IssueID:        workflowbiz.TuttiModePlanIssueIDPrefix + "traditional",
			TopicID:        workspaceissues.DefaultTopicID,
			Title:          "Traditional preemption",
			PlanningSource: string(workspaceissues.PlanningSourceTraditionalPlan),
		},
		"untrusted tutti source cannot use reserved id": {
			IssueID:         workflowbiz.TuttiModePlanIssueIDPrefix + "untrusted-tutti",
			TopicID:         workspaceissues.DefaultTopicID,
			Title:           "Untrusted Tutti preemption",
			PlanningSource:  string(workspaceissues.PlanningSourceTuttiModePlan),
			SourceSessionID: "session-1",
		},
		"workflow authority cannot escape reserved namespace": {
			IssueID:                "ordinary-issue",
			TopicID:                workspaceissues.DefaultTopicID,
			Title:                  "Invalid workflow authority",
			PlanningSource:         string(workspaceissues.PlanningSourceTuttiModePlan),
			SourceSessionID:        "session-1",
			TuttiModeWorkflowOwned: true,
		},
		"ordinary id cannot forge tutti provenance": {
			IssueID:         "ordinary-forged-tutti-plan",
			TopicID:         workspaceissues.DefaultTopicID,
			Title:           "Forged Tutti plan provenance",
			PlanningSource:  string(workspaceissues.PlanningSourceTuttiModePlan),
			SourceSessionID: "session-1",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := service.CreateIssueFromPlan(ctx, workspaceID, CreateIssueManagerIssueFromPlanInput{
				Issue: issue,
				Tasks: task,
			}); !errors.Is(err, workspaceissues.ErrInvalidArgument) {
				t.Fatalf("CreateIssueFromPlan() error = %v, want ErrInvalidArgument", err)
			}
		})
	}

	reservedID := workflowbiz.TuttiModePlanIssueIDPrefix + "workflow-1"
	detail, err := service.CreateIssueFromPlan(ctx, workspaceID, CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:                reservedID,
			TopicID:                workspaceissues.DefaultTopicID,
			Title:                  "Accepted Tutti workflow",
			PlanningSource:         string(workspaceissues.PlanningSourceTuttiModePlan),
			SourceSessionID:        "session-1",
			TuttiModeWorkflowOwned: true,
		},
		Tasks: task,
	})
	if err != nil {
		t.Fatalf("CreateIssueFromPlan(workflow-owned) error = %v", err)
	}
	if detail.Issue.IssueID != reservedID || detail.Issue.PlanningSource != workspaceissues.PlanningSourceTuttiModePlan {
		t.Fatalf("materialized detail = %#v", detail)
	}
}

func TestIssueManagerServiceValidatesTaskModelPlanAssignmentAtSave(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatalf("PutAgentTarget(%q) error = %v", target.ID, err)
		}
	}
	putIssueAssignmentPlan(t, store, issueAssignmentPlan("workspace-1", "openai-ready", modelplanbiz.ProtocolOpenAI, true, true))
	putIssueAssignmentPlan(t, store, issueAssignmentPlan("workspace-1", "anthropic-ready", modelplanbiz.ProtocolAnthropic, true, true))
	putIssueAssignmentPlan(t, store, issueAssignmentPlan("workspace-1", "openai-undetected", modelplanbiz.ProtocolOpenAI, true, false))

	service := IssueManagerService{
		Store:             store,
		AgentTargetReader: store,
		ModelPlanReader:   store,
	}
	if _, err := service.CreateIssue(ctx, "workspace-1", CreateIssueManagerIssueInput{
		IssueID: "issue-1",
		TopicID: workspaceissues.DefaultTopicID,
		Title:   "Issue One",
	}); err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	created, err := service.CreateTask(ctx, "workspace-1", "issue-1", CreateIssueManagerTaskInput{
		TaskID:        "task-valid",
		Title:         "Valid task",
		AgentTargetID: agenttargetbiz.IDLocalCodex,
		ModelPlanID:   "openai-ready",
		Model:         "model-a",
	})
	if err != nil {
		t.Fatalf("CreateTask(valid) error = %v", err)
	}
	if created.ModelPlanID != "openai-ready" || created.Model != "model-a" {
		t.Fatalf("created assignment = %#v", created)
	}

	for name, input := range map[string]CreateIssueManagerTaskInput{
		"missing plan": {
			TaskID: "task-missing", Title: "Missing", AgentTargetID: agenttargetbiz.IDLocalCodex, ModelPlanID: "missing",
		},
		"protocol mismatch": {
			TaskID: "task-protocol", Title: "Protocol", AgentTargetID: agenttargetbiz.IDLocalCodex, ModelPlanID: "anthropic-ready",
		},
		"undetected plan": {
			TaskID: "task-undetected", Title: "Undetected", AgentTargetID: agenttargetbiz.IDLocalCodex, ModelPlanID: "openai-undetected",
		},
		"unknown model": {
			TaskID: "task-model", Title: "Model", AgentTargetID: agenttargetbiz.IDLocalCodex, ModelPlanID: "openai-ready", Model: "unknown",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := service.CreateTask(ctx, "workspace-1", "issue-1", input); !errors.Is(err, workspaceissues.ErrInvalidArgument) {
				t.Fatalf("CreateTask() error = %v, want ErrInvalidArgument", err)
			}
		})
	}

	if _, err := service.UpdateTask(ctx, "workspace-1", "issue-1", "task-valid", UpdateIssueManagerTaskInput{
		Model:    "unknown",
		HasModel: true,
	}); !errors.Is(err, workspaceissues.ErrInvalidArgument) {
		t.Fatalf("UpdateTask() error = %v, want ErrInvalidArgument", err)
	}
}

func TestIssueManagerServiceValidatesWorkspaceAgentAssignmentThroughOwner(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-agent-assignment", Name: "Agent Assignment"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	targets := agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli())
	if len(targets) == 0 {
		t.Fatal("expected default system targets")
	}
	plan := issueAssignmentPlan("workspace-agent-assignment", "openai-ready", modelplanbiz.ProtocolOpenAI, true, true)
	putIssueAssignmentPlan(t, store, plan)
	service := IssueManagerService{
		Store:           store,
		ModelPlanReader: store,
		WorkspaceAgents: staticIssueWorkspaceAgentResolver{resolved: workspaceagentbiz.Resolved{
			Agent: workspaceagentbiz.Agent{
				ID:                   "workspace-agent:writer",
				WorkspaceID:          "workspace-agent-assignment",
				Name:                 "Writer",
				HarnessAgentTargetID: targets[0].ID,
				Enabled:              true,
				Source:               workspaceagentbiz.SourceUser,
				Revision:             1,
			},
			HarnessTarget:  targets[0],
			ModelPlan:      &plan,
			EffectiveModel: "model-a",
		}},
	}
	if _, err := service.CreateIssue(ctx, "workspace-agent-assignment", CreateIssueManagerIssueInput{
		IssueID: "issue-agent",
		TopicID: workspaceissues.DefaultTopicID,
		Title:   "Issue Agent",
	}); err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	if _, err := service.CreateTask(ctx, "workspace-agent-assignment", "issue-agent", CreateIssueManagerTaskInput{
		TaskID:        "task-agent",
		Title:         "Workspace Agent task",
		AgentTargetID: "workspace-agent:writer",
		ModelPlanID:   "openai-ready",
		Model:         "model-a",
	}); err != nil {
		t.Fatalf("CreateTask(workspace agent) error = %v", err)
	}
	if _, err := service.CreateTask(ctx, "workspace-agent-assignment", "issue-agent", CreateIssueManagerTaskInput{
		TaskID:        "task-agent-invalid-model",
		Title:         "Invalid workspace Agent model",
		AgentTargetID: "workspace-agent:writer",
		Model:         "unknown",
	}); !errors.Is(err, workspaceissues.ErrInvalidArgument) {
		t.Fatalf("CreateTask(invalid workspace agent model) error = %v, want ErrInvalidArgument", err)
	}
}

type staticIssueWorkspaceAgentResolver struct {
	resolved workspaceagentbiz.Resolved
	err      error
}

func (s staticIssueWorkspaceAgentResolver) Resolve(context.Context, string, string) (workspaceagentbiz.Resolved, error) {
	return s.resolved, s.err
}

func issueAssignmentPlan(workspaceID string, id string, protocol modelplanbiz.Protocol, enabled bool, detected bool) modelplanbiz.Plan {
	plan := modelplanbiz.Plan{
		ID:           id,
		WorkspaceID:  workspaceID,
		Name:         id,
		Protocol:     protocol,
		TemplateKind: modelplanbiz.TemplateCustom,
		Models:       []modelplanbiz.Model{{ID: "model-a", Name: "Model A"}},
		DefaultModel: "model-a",
		Enabled:      enabled,
		FirstUse:     modelplanbiz.FirstUse{Status: modelplanbiz.FirstUsePending},
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}
	if detected {
		for _, stage := range []modelplanbiz.DetectionStage{
			modelplanbiz.StageNetwork,
			modelplanbiz.StageAuth,
			modelplanbiz.StageModelDiscovery,
			modelplanbiz.StageInference,
		} {
			plan.Detection.Stages = append(plan.Detection.Stages, modelplanbiz.StageResult{
				Stage: stage, Status: modelplanbiz.StagePassed,
			})
		}
	}
	return plan
}

func putIssueAssignmentPlan(t *testing.T, store *workspacedata.SQLiteStore, plan modelplanbiz.Plan) {
	t.Helper()
	normalized, err := modelplanbiz.Normalize(plan)
	if err != nil {
		t.Fatalf("Normalize(plan) error = %v", err)
	}
	if err := store.PutModelPlan(context.Background(), normalized); err != nil {
		t.Fatalf("PutModelPlan(%q) error = %v", normalized.ID, err)
	}
}

type issueEventPublisherRecorder struct {
	updates []eventstreamservice.WorkspaceIssueUpdate
}

type issuePlanningTimelineRecorder struct {
	workspaceID string
	sessionID   string
	issueID     string
	topicID     string
	title       string
}

func (r *issuePlanningTimelineRecorder) ReportIssuePlanningLink(
	_ context.Context,
	workspaceID string,
	sessionID string,
	issueID string,
	topicID string,
	title string,
	_ time.Time,
) {
	r.workspaceID = workspaceID
	r.sessionID = sessionID
	r.issueID = issueID
	r.topicID = topicID
	r.title = title
}

func TestIssueManagerServiceReportsPlanIssueReverseLink(t *testing.T) {
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	reporter := &issuePlanningTimelineRecorder{}
	service := IssueManagerService{Store: store, PlanningTimeline: reporter}
	if _, err := service.CreateIssueFromPlan(ctx, "workspace-1", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID: "issue-1", TopicID: workspaceissues.DefaultTopicID, Title: "Plan migration",
			PlanningSource: string(workspaceissues.PlanningSourceTraditionalPlan), SourceSessionID: "session-1",
		},
		Tasks: []CreateIssueManagerTaskItemInput{{TaskID: "task-1", Title: "Implement", Priority: string(workspaceissues.PriorityMedium)}},
	}); err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	if reporter.workspaceID != "workspace-1" || reporter.sessionID != "session-1" ||
		reporter.issueID != "issue-1" || reporter.topicID != workspaceissues.DefaultTopicID || reporter.title != "Plan migration" {
		t.Fatalf("planning timeline report = %#v", reporter)
	}
}

func (r *issueEventPublisherRecorder) PublishWorkspaceIssueUpdated(_ context.Context, update eventstreamservice.WorkspaceIssueUpdate) error {
	r.updates = append(r.updates, update)
	return nil
}

func TestIssueManagerServicePublishesIssueStatusUpdate(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "workspace-1",
		Name: "Workspace One",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	publisher := &issueEventPublisherRecorder{}
	service := IssueManagerService{
		Publisher: publisher,
		Store:     store,
	}
	if _, err := service.CreateIssue(ctx, "workspace-1", CreateIssueManagerIssueInput{
		IssueID: "issue-1",
		TopicID: workspaceissues.DefaultTopicID,
		Title:   "Issue One",
	}); err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	publisher.updates = nil

	if _, err := service.UpdateIssue(ctx, "workspace-1", "issue-1", UpdateIssueManagerIssueInput{
		Status:    string(workspaceissues.StatusCompleted),
		HasStatus: true,
	}); err != nil {
		t.Fatalf("UpdateIssue() error = %v", err)
	}

	if len(publisher.updates) != 1 {
		t.Fatalf("published updates = %d, want 1", len(publisher.updates))
	}
	update := publisher.updates[0]
	if update.WorkspaceID != "workspace-1" || update.IssueID != "issue-1" {
		t.Fatalf("published update target = %#v, want workspace-1/issue-1", update)
	}
	if update.ChangeKind != eventstreamservice.WorkspaceIssueChangeIssueUpdated {
		t.Fatalf("published change kind = %q, want %q", update.ChangeKind, eventstreamservice.WorkspaceIssueChangeIssueUpdated)
	}
}

func TestIssueManagerServicePublishesTaskStatusUpdate(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "workspace-1",
		Name: "Workspace One",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	publisher := &issueEventPublisherRecorder{}
	service := IssueManagerService{
		Publisher: publisher,
		Store:     store,
	}
	if _, err := service.CreateIssue(ctx, "workspace-1", CreateIssueManagerIssueInput{
		IssueID: "issue-1",
		TopicID: workspaceissues.DefaultTopicID,
		Title:   "Issue One",
	}); err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	if _, err := service.CreateTask(ctx, "workspace-1", "issue-1", CreateIssueManagerTaskInput{
		TaskID: "task-1",
		Title:  "Task One",
	}); err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	publisher.updates = nil

	if _, err := service.UpdateTask(ctx, "workspace-1", "issue-1", "task-1", UpdateIssueManagerTaskInput{
		Status:    string(workspaceissues.StatusCompleted),
		HasStatus: true,
	}); err != nil {
		t.Fatalf("UpdateTask() error = %v", err)
	}

	if len(publisher.updates) != 1 {
		t.Fatalf("published updates = %d, want 1", len(publisher.updates))
	}
	update := publisher.updates[0]
	if update.WorkspaceID != "workspace-1" || update.IssueID != "issue-1" || update.TaskID != "task-1" {
		t.Fatalf("published update target = %#v, want workspace-1/issue-1/task-1", update)
	}
	if update.ChangeKind != eventstreamservice.WorkspaceIssueChangeTaskUpdated {
		t.Fatalf("published change kind = %q, want %q", update.ChangeKind, eventstreamservice.WorkspaceIssueChangeTaskUpdated)
	}
}

func TestIssueManagerServiceHidesIssueRunTaskFromVisibleSubtaskCounts(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "workspace-1",
		Name: "Workspace One",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	service := IssueManagerService{Store: store}
	if _, err := service.CreateIssue(ctx, "workspace-1", CreateIssueManagerIssueInput{
		IssueID: "issue-1",
		TopicID: workspaceissues.DefaultTopicID,
		Title:   "Issue One",
	}); err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	run, err := service.CreateRun(ctx, "workspace-1", "issue-1", "", CreateIssueManagerRunInput{
		AgentProvider: "codex",
		RunID:         "run-1",
	})
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}
	if _, err := service.CompleteRun(ctx, "workspace-1", "issue-1", run.TaskID, run.RunID, CompleteIssueManagerRunInput{
		Status: string(workspaceissues.StatusCompleted),
	}); err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}

	detail, err := service.GetIssueDetail(ctx, "workspace-1", "issue-1")
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if detail.Issue.Status != workspaceissues.StatusPendingAcceptance {
		t.Fatalf("detail issue status = %q, want %q", detail.Issue.Status, workspaceissues.StatusPendingAcceptance)
	}
	if detail.Issue.TaskCount != 0 || detail.Issue.CompletedCount != 0 {
		t.Fatalf("detail issue visible subtask counts = %+v, want zero visible subtasks", detail.Issue)
	}

	list, err := service.ListIssues(ctx, "workspace-1", ListIssueManagerItemsInput{
		TopicID: workspaceissues.DefaultTopicID,
	})
	if err != nil {
		t.Fatalf("ListIssues() error = %v", err)
	}
	if len(list.Items) != 1 {
		t.Fatalf("list items len = %d, want 1", len(list.Items))
	}
	if list.Items[0].Status != workspaceissues.StatusPendingAcceptance {
		t.Fatalf("list issue status = %q, want %q", list.Items[0].Status, workspaceissues.StatusPendingAcceptance)
	}
	if list.Items[0].TaskCount != 0 || list.Items[0].CompletedCount != 0 {
		t.Fatalf("list issue visible subtask counts = %+v, want zero visible subtasks", list.Items[0])
	}
}

func TestIssueManagerServiceCountsPendingAcceptanceSubtasksAsCompletedProgress(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "workspace-1",
		Name: "Workspace One",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	service := IssueManagerService{Store: store}
	if _, err := service.CreateIssue(ctx, "workspace-1", CreateIssueManagerIssueInput{
		IssueID: "issue-1",
		TopicID: workspaceissues.DefaultTopicID,
		Title:   "Issue One",
	}); err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	if _, err := service.CreateTask(ctx, "workspace-1", "issue-1", CreateIssueManagerTaskInput{
		TaskID: "task-1",
		Title:  "Task One",
	}); err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	run, err := service.CreateRun(ctx, "workspace-1", "issue-1", "task-1", CreateIssueManagerRunInput{
		AgentProvider: "codex",
		RunID:         "run-1",
	})
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}
	if _, err := service.CompleteRun(ctx, "workspace-1", "issue-1", run.TaskID, run.RunID, CompleteIssueManagerRunInput{
		Status: string(workspaceissues.StatusCompleted),
	}); err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}

	detail, err := service.GetIssueDetail(ctx, "workspace-1", "issue-1")
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if detail.Issue.TaskCount != 1 || detail.Issue.PendingAcceptanceCount != 1 || detail.Issue.CompletedCount != 1 {
		t.Fatalf("detail issue visible subtask counts = %+v, want pending acceptance counted as completed progress", detail.Issue)
	}

	list, err := service.ListIssues(ctx, "workspace-1", ListIssueManagerItemsInput{
		TopicID: workspaceissues.DefaultTopicID,
	})
	if err != nil {
		t.Fatalf("ListIssues() error = %v", err)
	}
	if len(list.Items) != 1 {
		t.Fatalf("list items len = %d, want 1", len(list.Items))
	}
	if list.Items[0].TaskCount != 1 || list.Items[0].PendingAcceptanceCount != 1 || list.Items[0].CompletedCount != 1 {
		t.Fatalf("list issue visible subtask counts = %+v, want pending acceptance counted as completed progress", list.Items[0])
	}
}

func TestIssueRunReconcileCompletionWaitsGraceBeforeFailedSessionCompletion(t *testing.T) {
	now := time.Now().UnixMilli()
	run := workspaceissues.Run{
		RunID:           "run-1",
		Status:          workspaceissues.StatusRunning,
		AgentSessionID:  "session-1",
		CreatedAtUnixMS: now,
		StartedAtUnixMS: now,
		UpdatedAtUnixMS: now,
	}
	session := agentservice.PersistedSession{ID: "session-1"}
	if _, _, ok := issueRunReconcileCompletion(run, session, now+defaultIssueRunReconcileGrace.Milliseconds()-1); ok {
		t.Fatal("completion before grace = true, want false")
	}
	status, message, ok := issueRunReconcileCompletion(run, session, now+defaultIssueRunReconcileGrace.Milliseconds())
	if !ok || status != workspaceissues.StatusFailed || message != "Agent session ended without reporting run completion." {
		t.Fatalf("completion after grace = %q %q %v", status, message, ok)
	}
}

func openIssueServiceStore(t *testing.T) *workspacedata.SQLiteStore {
	t.Helper()

	store, err := workspacedata.OpenSQLiteStore(filepath.Join(t.TempDir(), "tutti.sqlite"))
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	return store
}
