package workspace

import (
	"context"
	"errors"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	executionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

func TestRequestTuttiModeArchiveFencesExecutionAndIsIdempotent(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_001_000_000).UTC()
	prepareTuttiModeExecutionWorkspace(t, store, "workspace-archive", "workflow-archive", "source-archive", now)
	issues := workspaceissues.Service{Store: store, Clock: func() time.Time { return now }}
	issue, tasks := prepareTuttiModeIssueGraph(t, issues, "workspace-archive", "workflow-archive", "source-archive")
	executions := executionservice.Service{Store: store, Clock: func() time.Time { return now }}
	_, _, _, err := executions.Materialize(ctx, executionservice.MaterializeInput{
		Issue: issue, Tasks: tasks, WorkflowID: "workflow-archive",
	})
	if err != nil {
		t.Fatalf("Materialize() error = %v", err)
	}

	request := executionbiz.ArchiveRequest{
		WorkspaceID: issue.WorkspaceID, IssueID: issue.IssueID,
		RequestID: "archive-request", RequestedBy: "local-user",
		Reason: "stop requested", Now: now.Add(time.Minute),
	}
	first, replayed, err := store.RequestTuttiModeArchive(ctx, request)
	if err != nil {
		t.Fatalf("RequestTuttiModeArchive() error = %v", err)
	}
	second, replayedSecond, err := store.RequestTuttiModeArchive(ctx, request)
	if err != nil {
		t.Fatalf("RequestTuttiModeArchive(replay) error = %v", err)
	}
	if replayed || !replayedSecond || first.OperationID != second.OperationID {
		t.Fatalf("archive replay first=%#v/%v second=%#v/%v", first, replayed, second, replayedSecond)
	}
	competingRequest := request
	competingRequest.RequestID = "competing-archive-request"
	competingRequest.RequestedBy = "another-local-user"
	competingRequest.Reason = "different stop request"
	competing, replayedCompeting, err := store.RequestTuttiModeArchive(ctx, competingRequest)
	if err != nil {
		t.Fatalf("RequestTuttiModeArchive(competing request) error = %v", err)
	}
	if !replayedCompeting || competing.OperationID != first.OperationID ||
		competing.RequestID != first.RequestID || competing.RequestedBy != first.RequestedBy ||
		competing.Reason != first.Reason {
		t.Fatalf("competing archive request did not preserve active operation: %#v", competing)
	}
	if second.Status != executionbiz.ArchiveStatusCancelingRuns {
		t.Fatalf("archive status = %q", second.Status)
	}

	var executionStatus string
	var dispatchPaused int
	var activeWakes int
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT
  (SELECT status FROM workspace_tutti_executions WHERE workspace_id = ? AND issue_id = ?),
  (SELECT dispatch_paused FROM workspace_issues WHERE workspace_id = ? AND issue_id = ?),
  (SELECT COUNT(*) FROM workspace_tutti_execution_wakes
    WHERE workspace_id = ? AND execution_id = ? AND status NOT IN ('acknowledged', 'failed', 'canceled'))
`, issue.WorkspaceID, issue.IssueID,
		issue.WorkspaceID, issue.IssueID,
		issue.WorkspaceID, first.ExecutionID,
	).Scan(&executionStatus, &dispatchPaused, &activeWakes); err != nil {
		t.Fatalf("read archive fence state: %v", err)
	}
	if executionStatus != string(executionbiz.StatusArchiving) || dispatchPaused != 1 || activeWakes != 0 {
		t.Fatalf("archive fence execution=%q paused=%d activeWakes=%d", executionStatus, dispatchPaused, activeWakes)
	}
}

func TestCompleteTuttiModeArchiveIsIdempotentAndPreservesAuditTimestamp(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_001_050_000).UTC()
	prepareTuttiModeExecutionWorkspace(t, store, "workspace-archive-complete", "workflow-archive-complete", "source-archive-complete", now)
	issues := workspaceissues.Service{Store: store, Clock: func() time.Time { return now }}
	issue, tasks := prepareTuttiModeIssueGraph(t, issues, "workspace-archive-complete", "workflow-archive-complete", "source-archive-complete")
	executions := executionservice.Service{Store: store, Clock: func() time.Time { return now }}
	if _, _, _, err := executions.Materialize(ctx, executionservice.MaterializeInput{
		Issue: issue, Tasks: tasks, WorkflowID: "workflow-archive-complete",
	}); err != nil {
		t.Fatalf("Materialize() error = %v", err)
	}
	operation, _, err := store.RequestTuttiModeArchive(ctx, executionbiz.ArchiveRequest{
		WorkspaceID: issue.WorkspaceID, IssueID: issue.IssueID,
		RequestID: "archive-complete-request", RequestedBy: "local-user",
		Reason: "stop requested", Now: now.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("RequestTuttiModeArchive() error = %v", err)
	}
	first, completed, err := store.CompleteTuttiModeArchiveIfSettled(
		ctx, issue.WorkspaceID, operation.OperationID, now.Add(2*time.Minute),
	)
	if err != nil || !completed {
		t.Fatalf("CompleteTuttiModeArchiveIfSettled() completed=%v error=%v", completed, err)
	}
	second, replayed, err := store.CompleteTuttiModeArchiveIfSettled(
		ctx, issue.WorkspaceID, operation.OperationID, now.Add(3*time.Minute),
	)
	if err != nil || !replayed {
		t.Fatalf("CompleteTuttiModeArchiveIfSettled(replay) completed=%v error=%v", replayed, err)
	}
	if !second.CompletedAt.Equal(first.CompletedAt) || !second.UpdatedAt.Equal(first.UpdatedAt) {
		t.Fatalf("completion replay rewrote audit timestamps: first=%#v second=%#v", first, second)
	}
}

func TestSourceSessionDeletionAdmissionRejectsWholeClosureAndFencesMaterialization(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_001_100_000).UTC()
	prepareTuttiModeExecutionWorkspace(t, store, "workspace-delete-fence", "workflow-delete-fence", "protected-source", now)
	issues := workspaceissues.Service{Store: store, Clock: func() time.Time { return now }}
	issue, tasks := prepareTuttiModeIssueGraph(t, issues, "workspace-delete-fence", "workflow-delete-fence", "protected-source")
	executions := executionservice.Service{Store: store, Clock: func() time.Time { return now }}
	if _, _, _, err := executions.Materialize(ctx, executionservice.MaterializeInput{
		Issue: issue, Tasks: tasks, WorkflowID: "workflow-delete-fence",
	}); err != nil {
		t.Fatalf("Materialize() error = %v", err)
	}

	_, err := store.AdmitSourceSessionDeletion(ctx, executionbiz.SourceSessionDeletionAdmission{
		WorkspaceID: issue.WorkspaceID,
		SessionIDs:  []string{"unprotected-source", "protected-source"},
		Now:         now.Add(time.Minute),
	})
	var protected *executionbiz.ProtectedSourceError
	if !errors.As(err, &protected) || len(protected.Issues) != 1 || protected.Issues[0].IssueID != issue.IssueID {
		t.Fatalf("admission error = %#v, want complete protected Issue details", err)
	}

	admission, err := store.AdmitSourceSessionDeletion(ctx, executionbiz.SourceSessionDeletionAdmission{
		WorkspaceID: issue.WorkspaceID,
		SessionIDs:  []string{"new-source"},
		Now:         now.Add(2 * time.Minute),
	})
	if err != nil {
		t.Fatalf("AdmitSourceSessionDeletion(unprotected) error = %v", err)
	}
	prepareTuttiModeExecutionWorkspace(t, store, issue.WorkspaceID, "workflow-new-source", "new-source", now.Add(3*time.Minute))
	newIssue, newTasks := prepareTuttiModeIssueGraph(t, issues, issue.WorkspaceID, "workflow-new-source", "new-source")
	if _, _, _, err := executions.Materialize(ctx, executionservice.MaterializeInput{
		Issue: newIssue, Tasks: newTasks, WorkflowID: "workflow-new-source",
	}); !errors.Is(err, executionbiz.ErrSourceDeletionFenced) {
		t.Fatalf("Materialize() error = %v, want ErrSourceDeletionFenced", err)
	}
	if err := store.ReportSourceSessionDeletion(ctx, admission, true, now.Add(4*time.Minute)); err != nil {
		t.Fatalf("ReportSourceSessionDeletion() error = %v", err)
	}
}

func TestStartupReleasesAbandonedSourceDeletionAdmission(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_001_200_000).UTC()
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-abandoned-admission", Name: "Abandoned"}); err != nil {
		t.Fatalf("Create() workspace error=%v", err)
	}
	admission, err := store.AdmitSourceSessionDeletion(ctx, executionbiz.SourceSessionDeletionAdmission{
		WorkspaceID: "workspace-abandoned-admission", SessionIDs: []string{"source-1"}, Now: now,
	})
	if err != nil {
		t.Fatalf("AdmitSourceSessionDeletion() error=%v", err)
	}
	if err := store.ReconcileSourceSessionDeletionAdmissions(ctx, now.Add(time.Minute)); err != nil {
		t.Fatalf("ReconcileSourceSessionDeletionAdmissions() error=%v", err)
	}
	var status string
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT status FROM workspace_source_session_deletion_admissions
WHERE workspace_id = ? AND admission_id = ?
`, admission.WorkspaceID, admission.AdmissionID).Scan(&status); err != nil {
		t.Fatalf("read reconciled admission error=%v", err)
	}
	if status != "superseded" {
		t.Fatalf("reconciled admission status=%q", status)
	}
}
