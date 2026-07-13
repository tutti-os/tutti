package workspace

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

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
