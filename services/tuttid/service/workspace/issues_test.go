package workspace

import (
	"context"
	"errors"
	"math"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

type issueLookupFailingStore struct {
	workspaceissues.Store
	err error
}

type notFoundRunSessionCanceller struct{}

func (notFoundRunSessionCanceller) RequestRunCancellation(
	context.Context,
	IssueRunCancellationRequest,
) (IssueRunCancelResult, error) {
	return IssueRunCancelResult{State: IssueRunCancelNotFound}, nil
}

func (store issueLookupFailingStore) GetIssue(
	context.Context,
	string,
	string,
) (workspaceissues.Issue, error) {
	return workspaceissues.Issue{}, store.err
}

func TestCompleteRunFailsClosedWhenIssueOwnershipCannotBeRead(t *testing.T) {
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{
		ID: "workspace-ownership-fence", Name: "Ownership fence",
	}); err != nil {
		t.Fatal(err)
	}
	service := IssueManagerService{Store: store}
	if _, err := service.CreateIssue(ctx, "workspace-ownership-fence", CreateIssueManagerIssueInput{
		IssueID: "issue-ownership-fence", TopicID: workspaceissues.DefaultTopicID,
		Title: "Ownership fence",
	}); err != nil {
		t.Fatal(err)
	}
	run, err := service.CreateRun(
		ctx, "workspace-ownership-fence", "issue-ownership-fence", "",
		CreateIssueManagerRunInput{RunID: "run-ownership-fence", AgentProvider: "codex"},
	)
	if err != nil {
		t.Fatal(err)
	}
	lookupErr := errors.New("injected Issue ownership lookup failure")
	service.Store = issueLookupFailingStore{Store: store, err: lookupErr}
	if _, err := service.CompleteRun(
		ctx, run.WorkspaceID, run.IssueID, run.TaskID, run.RunID,
		CompleteIssueManagerRunInput{Status: string(workspaceissues.StatusCompleted)},
	); !errors.Is(err, lookupErr) {
		t.Fatalf("CompleteRun() error = %v, want ownership lookup failure", err)
	}
	persisted, err := store.GetRun(ctx, run.WorkspaceID, run.IssueID, run.TaskID, run.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Status != workspaceissues.StatusRunning {
		t.Fatalf("Run status = %q, want running after fail-closed ownership lookup", persisted.Status)
	}
}

func TestCancelIssueExecutionRejectsGenericMutationOfManagedIssue(t *testing.T) {
	ctx := context.Background()
	store := openIssueServiceStore(t)
	const workspaceID = "workspace-managed-cancel"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Managed cancel"}); err != nil {
		t.Fatal(err)
	}
	issue, err := store.CreateIssue(ctx, workspaceissues.Issue{
		IssueID: "issue-managed", WorkspaceID: workspaceID,
		TopicID: workspaceissues.DefaultTopicID, Title: "Managed",
		PlanningSource:  workspaceissues.PlanningSourceTuttiModePlan,
		SourceSessionID: "source-session",
		Budget:          workspaceissues.DefaultBudget(),
	})
	if err != nil {
		t.Fatal(err)
	}
	service := IssueManagerService{Store: store, MutationLocks: NewIssueMutationLocks()}
	coordinator := IssueExecutionCoordinator{Issues: &service}
	if _, err := coordinator.CancelIssueExecution(ctx, workspaceID, issue.IssueID); !errors.Is(err, workspaceissues.ErrManagedIssueMutation) {
		t.Fatalf("CancelIssueExecution() error = %v, want managed mutation conflict", err)
	}
	persisted, err := store.GetIssue(ctx, workspaceID, issue.IssueID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.DispatchPaused {
		t.Fatal("managed Issue was paused by rejected generic cancellation")
	}
}

func TestResumeTuttiModeIssueExecutionIsSourceScopedAndIdempotent(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	const (
		workspaceID = "workspace-managed-resume"
		issueID     = "issue-managed-resume"
		sourceID    = "source-managed-resume"
	)
	if err := store.Create(ctx, workspacebiz.Summary{
		ID: workspaceID, Name: "Managed resume",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateIssue(ctx, workspaceissues.Issue{
		IssueID: issueID, WorkspaceID: workspaceID,
		TopicID: workspaceissues.DefaultTopicID, Title: "Managed",
		PlanningSource:  workspaceissues.PlanningSourceTuttiModePlan,
		SourceSessionID: sourceID,
		DispatchPaused:  true,
		Budget:          workspaceissues.DefaultBudget(),
	}); err != nil {
		t.Fatal(err)
	}
	service := IssueManagerService{
		Store: store, MutationLocks: NewIssueMutationLocks(),
	}
	_, err := service.ResumeTuttiModeIssueExecution(
		ctx, workspaceID, issueID, "other-source",
	)
	reason, _, ok := executionbiz.RejectionDetails(err)
	if !ok || reason != executionbiz.RejectionWrongSourceSession {
		t.Fatalf("wrong-source resume error = %v, reason = %q", err, reason)
	}
	paused, err := store.GetIssue(ctx, workspaceID, issueID)
	if err != nil || !paused.DispatchPaused {
		t.Fatalf("wrong-source resume changed Issue = %#v, error = %v", paused, err)
	}

	resumed, err := service.ResumeTuttiModeIssueExecution(
		ctx, workspaceID, issueID, sourceID,
	)
	if err != nil || resumed.DispatchPaused {
		t.Fatalf("ResumeTuttiModeIssueExecution() = %#v, error = %v", resumed, err)
	}
	replayed, err := service.ResumeTuttiModeIssueExecution(
		ctx, workspaceID, issueID, sourceID,
	)
	if err != nil || replayed.DispatchPaused {
		t.Fatalf("replayed ResumeTuttiModeIssueExecution() = %#v, error = %v", replayed, err)
	}
}

func TestCancelIssueExecutionSettlesPreparedRunWithoutCanonicalTurn(t *testing.T) {
	ctx := context.Background()
	store := openIssueServiceStore(t)
	const workspaceID = "workspace-cancel-prepared-run"
	if err := store.Create(ctx, workspacebiz.Summary{
		ID: workspaceID, Name: "Cancel prepared Run",
	}); err != nil {
		t.Fatal(err)
	}
	service := IssueManagerService{
		Store: store, MutationLocks: NewIssueMutationLocks(),
	}
	issue, err := service.CreateIssue(
		ctx, workspaceID,
		CreateIssueManagerIssueInput{
			IssueID: "issue-cancel-prepared-run",
			TopicID: workspaceissues.DefaultTopicID,
			Title:   "Cancel prepared Run",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	run, err := service.CreateRun(
		ctx, workspaceID, issue.IssueID, "",
		CreateIssueManagerRunInput{
			RunID: "run-cancel-prepared", AgentProvider: "codex",
			AgentSessionID: "session-cancel-prepared",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	coordinator := IssueExecutionCoordinator{
		Issues: &service, RunSessionCanceller: notFoundRunSessionCanceller{},
	}
	canceled, err := coordinator.CancelIssueExecution(ctx, workspaceID, issue.IssueID)
	if err != nil || canceled != 1 {
		t.Fatalf("CancelIssueExecution() canceled=%d error=%v", canceled, err)
	}
	persisted, err := store.GetRun(
		ctx, workspaceID, issue.IssueID, run.TaskID, run.RunID,
	)
	if err != nil || persisted.Status != workspaceissues.StatusCanceled {
		t.Fatalf("prepared Run after Stop=%#v error=%v", persisted, err)
	}
}

func TestCancelIssueExecutionForSourceSessionRequiresDurableTuttiService(t *testing.T) {
	ctx := context.Background()
	store := openIssueServiceStore(t)
	const (
		workspaceID     = "workspace-managed-source-cancel"
		issueID         = "tutti-mode-plan-managed-source-cancel"
		sourceSessionID = "source-session"
	)
	if err := store.Create(ctx, workspacebiz.Summary{
		ID: workspaceID, Name: "Managed source cancel",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateIssue(ctx, workspaceissues.Issue{
		IssueID: issueID, WorkspaceID: workspaceID,
		TopicID: workspaceissues.DefaultTopicID, Title: "Managed",
		PlanningSource:  workspaceissues.PlanningSourceTuttiModePlan,
		SourceSessionID: sourceSessionID,
		Budget:          workspaceissues.DefaultBudget(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateRun(ctx, workspaceissues.Run{
		RunID:           "run-managed-source-cancel",
		IssueID:         issueID,
		WorkspaceID:     workspaceID,
		AgentSessionID:  "task-session",
		AgentProvider:   "codex",
		Status:          workspaceissues.StatusRunning,
		CreatedAtUnixMS: 1,
		StartedAtUnixMS: 1,
		UpdatedAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}

	service := IssueManagerService{
		Store:         store,
		MutationLocks: NewIssueMutationLocks(),
	}
	coordinator := IssueExecutionCoordinator{Issues: &service}
	if _, err := coordinator.CancelIssueExecutionForSourceSession(
		ctx, workspaceID, sourceSessionID,
	); !errors.Is(err, workspaceissues.ErrInvalidArgument) {
		t.Fatalf("CancelIssueExecutionForSourceSession() error = %v, want durable service requirement", err)
	}
	persisted, err := store.GetIssue(ctx, workspaceID, issueID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.DispatchPaused {
		t.Fatal("managed Tutti Issue was partially stopped without the durable execution service")
	}
}

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
	now := time.UnixMilli(1_700_000_000_000).UTC()
	createIssueManagerTuttiWorkflowFixture(t, store, workspaceID, "workflow-1", "session-1", now)
	service.TuttiModeExecutions = &tuttimodeexecutionservice.Service{
		Store: store,
		Clock: func() time.Time { return now },
	}
	mismatchedID := workflowbiz.TuttiModePlanIssueIDPrefix + "different-workflow"
	if _, err := service.CreateIssueFromPlan(ctx, workspaceID, CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:                mismatchedID,
			TopicID:                workspaceissues.DefaultTopicID,
			Title:                  "Mismatched workflow identity",
			PlanningSource:         string(workspaceissues.PlanningSourceTuttiModePlan),
			SourceSessionID:        "session-1",
			TuttiModeWorkflowOwned: true,
			TuttiModeWorkflowID:    "workflow-1",
		},
		Tasks: task,
	}); !errors.Is(err, workspaceissues.ErrInvalidArgument) {
		t.Errorf("CreateIssueFromPlan(mismatched workflow identity) error = %v, want ErrInvalidArgument", err)
	}
	if _, err := store.GetIssue(ctx, workspaceID, mismatchedID); !errors.Is(err, workspaceissues.ErrIssueNotFound) {
		t.Errorf("GetIssue(mismatched workflow identity) error = %v, want ErrIssueNotFound", err)
	}
	if _, err := service.TuttiModeExecutions.GetByIssue(ctx, workspaceID, mismatchedID); !errors.Is(err, executionbiz.ErrExecutionNotFound) {
		t.Errorf("GetByIssue(mismatched workflow identity) error = %v, want ErrExecutionNotFound", err)
	}
	detail, err := service.CreateIssueFromPlan(ctx, workspaceID, CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:                reservedID,
			TopicID:                workspaceissues.DefaultTopicID,
			Title:                  "Accepted Tutti workflow",
			PlanningSource:         string(workspaceissues.PlanningSourceTuttiModePlan),
			SourceSessionID:        "session-1",
			TuttiModeWorkflowOwned: true,
			TuttiModeWorkflowID:    "workflow-1",
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

func createIssueManagerTuttiWorkflowFixture(
	t *testing.T,
	store *workspacedata.SQLiteStore,
	workspaceID string,
	workflowID string,
	sourceSessionID string,
	now time.Time,
) {
	t.Helper()
	revisionID := "revision-" + workflowID
	err := store.CreateWorkspaceWorkflowProposal(context.Background(), workflowbiz.ProposalAggregate{
		Workflow: workflowbiz.Workflow{
			ID:                workflowID,
			WorkspaceID:       workspaceID,
			Type:              workflowbiz.WorkflowTypeTuttiModePlan,
			Owner:             workflowbiz.WorkflowOwnerTutti,
			TriggerKind:       workflowbiz.TriggerKindAgentCLI,
			SourceSessionID:   sourceSessionID,
			Status:            workflowbiz.WorkflowStatusPendingReview,
			CurrentRevisionID: revisionID,
			CreatedAt:         now,
			UpdatedAt:         now,
		},
		Plan: workflowbiz.TuttiModePlan{WorkflowID: workflowID},
		Revision: workflowbiz.PlanRevision{
			ID:            revisionID,
			WorkflowID:    workflowID,
			Sequence:      1,
			SchemaVersion: "tutti-mode-plan/v1",
			DocumentPath:  "plans/" + revisionID + ".md",
			SHA256:        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			CreatedAt:     now,
		},
		Checkpoint: workflowbiz.WorkflowCheckpoint{
			ID:         "review-" + workflowID,
			WorkflowID: workflowID,
			Kind:       workflowbiz.CheckpointKindTaskReview,
			RevisionID: revisionID,
			Status:     workflowbiz.CheckpointStatusPending,
			CreatedAt:  now,
			UpdatedAt:  now,
		},
	})
	if err != nil {
		t.Fatalf("CreateWorkspaceWorkflowProposal() error = %v", err)
	}
}

type issueEventPublisherRecorder struct {
	updates []eventstreamservice.WorkspaceIssueUpdate
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

func TestIssueRunReconcileCompletionFailsOnlyAtProductTimeout(t *testing.T) {
	now := time.Now().UnixMilli()
	run := workspaceissues.Run{
		RunID:           "run-1",
		Status:          workspaceissues.StatusRunning,
		AgentSessionID:  "session-1",
		CreatedAtUnixMS: now,
		StartedAtUnixMS: now,
		UpdatedAtUnixMS: now,
	}
	if _, _, ok := issueRunReconcileCompletion(run, now+defaultIssueRunMaxDuration.Milliseconds()-1); ok {
		t.Fatal("completion before product timeout = true, want false")
	}
	status, message, ok := issueRunReconcileCompletion(run, now+defaultIssueRunMaxDuration.Milliseconds())
	if !ok || status != workspaceissues.StatusFailed || message != "Issue run timed out." {
		t.Fatalf("completion at product timeout = %q %q %v", status, message, ok)
	}
}

func TestIssueRunReconcileCompletionDoesNotInferAgentStateFromProjectionSilence(t *testing.T) {
	now := time.Now().UnixMilli()
	run := workspaceissues.Run{
		RunID:           "run-1",
		Status:          workspaceissues.StatusRunning,
		AgentSessionID:  "session-1",
		CreatedAtUnixMS: now,
		StartedAtUnixMS: now,
		UpdatedAtUnixMS: now,
	}
	if status, message, ok := issueRunReconcileCompletion(run, now+30*time.Second.Milliseconds()); ok {
		t.Fatalf("projection silence inferred completion = %q %q, want no completion", status, message)
	}
}

func TestWorkspaceExecutionRecoveryQueueRetriesTransientErrors(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	completed := make(chan struct{})
	var calls int
	var mu sync.Mutex
	queue := NewWorkspaceExecutionRecoveryQueue(WorkspaceExecutionRecoveryQueueOptions{
		Context:  ctx,
		Delay:    time.Millisecond,
		Interval: time.Millisecond,
		Reconcile: func(context.Context, string) (WorkspaceExecutionRecoveryResult, error) {
			mu.Lock()
			defer mu.Unlock()
			calls++
			if calls == 1 {
				return WorkspaceExecutionRecoveryResult{}, errors.New("temporary read failure")
			}
			close(completed)
			return WorkspaceExecutionRecoveryResult{}, nil
		},
	})
	queue.Enqueue("workspace-1")
	select {
	case <-completed:
	case <-time.After(time.Second):
		t.Fatal("reconcile queue did not retry a transient error")
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 2 {
		t.Fatalf("reconcile calls = %d, want 2", calls)
	}
}

func TestWorkspaceExecutionRecoveryQueueRetriesExplicitPendingRecovery(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	completed := make(chan struct{})
	var calls int
	var mu sync.Mutex
	queue := NewWorkspaceExecutionRecoveryQueue(WorkspaceExecutionRecoveryQueueOptions{
		Context:  ctx,
		Delay:    time.Millisecond,
		Interval: time.Millisecond,
		Reconcile: func(context.Context, string) (WorkspaceExecutionRecoveryResult, error) {
			mu.Lock()
			defer mu.Unlock()
			calls++
			if calls == 1 {
				return WorkspaceExecutionRecoveryResult{Pending: true}, nil
			}
			close(completed)
			return WorkspaceExecutionRecoveryResult{}, nil
		},
	})
	queue.Enqueue("workspace-1")
	select {
	case <-completed:
	case <-time.After(time.Second):
		t.Fatal("reconcile queue did not retry an explicit pending outcome")
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 2 {
		t.Fatalf("reconcile calls = %d, want 2", calls)
	}
}

type issueRunSettlementReaderStub struct {
	settlementByRunID map[string]IssueRunSettlement
}

func (r issueRunSettlementReaderStub) ReadRunSettlement(_ context.Context, _ string, _ string, clientSubmitID string) (IssueRunSettlement, bool, error) {
	runID := strings.TrimPrefix(clientSubmitID, "issue-run:")
	settlement, ok := r.settlementByRunID[runID]
	return settlement, ok, nil
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
