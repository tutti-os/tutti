package workspace

import (
	"context"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	activationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
)

func TestSQLiteStoreDeletingSourceSessionDoesNotChooseWorkflowCancellationPolicy(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createWorkflowTestWorkspace(t, store, "ws-workflow-session-delete")
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-workflow-session-delete",
		AgentSessionID:   "source-session",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Status:           "completed",
		OccurredAtUnixMS: 1_700_000_000_000,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	now := time.UnixMilli(1_700_000_000_000).UTC()
	createWorkflowProposalFixture(t, store, "ws-workflow-session-delete", "workflow-1", now)
	if err := store.RecordWorkspaceWorkflowOperation(ctx, "ws-workflow-session-delete", workflowbiz.WorkflowOperation{
		ID:         "operation-1",
		WorkflowID: "workflow-1",
		Kind:       workflowbiz.OperationKindGenerateTaskGraph,
		Status:     workflowbiz.OperationStatusPending,
		RevisionID: "revision-1",
		CreatedAt:  now,
		UpdatedAt:  now,
	}); err != nil {
		t.Fatalf("RecordWorkspaceWorkflowOperation() error = %v", err)
	}

	removed, err := store.DeleteSession(ctx, "ws-workflow-session-delete", "source-session")
	if err != nil || !removed {
		t.Fatalf("DeleteSession() removed=%v error=%v", removed, err)
	}
	snapshot, err := store.GetWorkspaceWorkflowSnapshot(ctx, "ws-workflow-session-delete", "workflow-1")
	if err != nil {
		t.Fatalf("GetWorkspaceWorkflowSnapshot() error = %v", err)
	}
	if snapshot.Workflow.Status != workflowbiz.WorkflowStatusPendingReview {
		t.Fatalf("workflow status = %q, want data-layer delete to leave workflow policy untouched", snapshot.Workflow.Status)
	}
	if len(snapshot.Checkpoints) != 1 || snapshot.Checkpoints[0].Status != workflowbiz.CheckpointStatusPending {
		t.Fatalf("checkpoints = %#v, want pending checkpoint unchanged", snapshot.Checkpoints)
	}
	if len(snapshot.Operations) != 1 || snapshot.Operations[0].Status != workflowbiz.OperationStatusPending {
		t.Fatalf("operations = %#v, want pending operation unchanged", snapshot.Operations)
	}
}

func TestSQLiteStoreExecutesAuthorizedSourceSessionDeletionAtomically(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	workspaceID := "ws-authorized-source-session-delete"
	createWorkflowTestWorkspace(t, store, workspaceID)
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      workspaceID,
		AgentSessionID:   "source-session",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Status:           "completed",
		OccurredAtUnixMS: 1_700_000_000_000,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	now := time.UnixMilli(1_700_000_000_000).UTC()
	createWorkflowProposalFixture(t, store, workspaceID, "workflow-1", now)
	if err := store.RecordWorkspaceWorkflowOperation(ctx, workspaceID, workflowbiz.WorkflowOperation{
		ID:         "operation-1",
		WorkflowID: "workflow-1",
		Kind:       workflowbiz.OperationKindGenerateTaskGraph,
		Status:     workflowbiz.OperationStatusPending,
		RevisionID: "revision-1",
		CreatedAt:  now,
		UpdatedAt:  now,
	}); err != nil {
		t.Fatalf("RecordWorkspaceWorkflowOperation() error = %v", err)
	}

	result, err := store.ExecuteSourceSessionDeletion(ctx, SourceSessionDeletionCommand{
		WorkspaceID: workspaceID,
		SessionIDs:  []string{"source-session"},
		WorkflowCancellation: WorkspaceWorkflowCancellationCommand{
			AllowedWorkflowStatuses:   []workflowbiz.WorkflowStatus{workflowbiz.WorkflowStatusPendingReview},
			AllowedCheckpointStatuses: []workflowbiz.CheckpointStatus{workflowbiz.CheckpointStatusPending},
			AllowedOperationStatuses:  []workflowbiz.OperationStatus{workflowbiz.OperationStatusPending},
			WorkflowStatus:            workflowbiz.WorkflowStatusCanceled,
			CheckpointStatus:          workflowbiz.CheckpointStatusCanceled,
			OperationStatus:           workflowbiz.OperationStatusCanceled,
			DecidedBy:                 "tutti",
			DecisionReason:            "source_session_deleted",
			ChangedAt:                 now.Add(time.Minute),
		},
	})
	if err != nil {
		t.Fatalf("ExecuteSourceSessionDeletion() error = %v", err)
	}
	if result.RemovedSessions != 1 || len(result.RemovedSessionIDs) != 1 || result.RemovedSessionIDs[0] != "source-session" {
		t.Fatalf("deletion result = %#v", result)
	}
	if len(result.WorkflowUpdates) != 1 {
		t.Fatalf("workflow updates = %#v, want one canonical identity", result.WorkflowUpdates)
	}
	update := result.WorkflowUpdates[0]
	if update.WorkflowID != "workflow-1" || update.SourceSessionID != "source-session" || update.CheckpointID != "checkpoint-1" || !update.CheckpointChanged || !update.OperationChanged {
		t.Fatalf("workflow update = %#v", update)
	}

	snapshot, err := store.GetWorkspaceWorkflowSnapshot(ctx, workspaceID, "workflow-1")
	if err != nil {
		t.Fatalf("GetWorkspaceWorkflowSnapshot() error = %v", err)
	}
	if snapshot.Workflow.Status != workflowbiz.WorkflowStatusCanceled || snapshot.Checkpoints[0].Status != workflowbiz.CheckpointStatusCanceled || snapshot.Operations[0].Status != workflowbiz.OperationStatusCanceled {
		t.Fatalf("canceled snapshot = %#v", snapshot)
	}
	if _, ok, err := store.GetSession(ctx, workspaceID, "source-session"); err != nil || ok {
		t.Fatalf("GetSession() ok=%v error=%v, want atomically removed", ok, err)
	}
}

func TestSQLiteStoreRollsBackSourceSessionDeletionWhenWorkflowTransitionFails(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	workspaceID := "ws-source-session-delete-rollback"
	createWorkflowTestWorkspace(t, store, workspaceID)
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      workspaceID,
		AgentSessionID:   "source-session",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Status:           "completed",
		OccurredAtUnixMS: 1_700_000_000_000,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	now := time.UnixMilli(1_700_000_000_000).UTC()
	if _, changed, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: workspaceID, AgentSessionID: "source-session",
		ActivationID: "activation-1", RevisionID: "activation-revision-1",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand, ChangedAt: now,
	}); err != nil || !changed {
		t.Fatalf("SetTuttiModeActivation() changed=%v error=%v", changed, err)
	}
	createWorkflowProposalFixture(t, store, workspaceID, "workflow-1", now)
	if _, err := store.writeDB.ExecContext(ctx, `
CREATE TRIGGER fail_source_session_workflow_cancel
BEFORE UPDATE ON workspace_workflows
BEGIN
  SELECT RAISE(ABORT, 'forced workflow transition failure');
END;
`); err != nil {
		t.Fatalf("create failure trigger: %v", err)
	}

	_, err := store.ExecuteSourceSessionDeletion(ctx, SourceSessionDeletionCommand{
		WorkspaceID: workspaceID,
		SessionIDs:  []string{"source-session"},
		WorkflowCancellation: WorkspaceWorkflowCancellationCommand{
			AllowedWorkflowStatuses:   []workflowbiz.WorkflowStatus{workflowbiz.WorkflowStatusPendingReview},
			AllowedCheckpointStatuses: []workflowbiz.CheckpointStatus{workflowbiz.CheckpointStatusPending},
			AllowedOperationStatuses:  []workflowbiz.OperationStatus{workflowbiz.OperationStatusPending},
			WorkflowStatus:            workflowbiz.WorkflowStatusCanceled,
			CheckpointStatus:          workflowbiz.CheckpointStatusCanceled,
			OperationStatus:           workflowbiz.OperationStatusCanceled,
			DecidedBy:                 "tutti",
			DecisionReason:            "source_session_deleted",
			ChangedAt:                 now.Add(time.Minute),
		},
	})
	if err == nil {
		t.Fatal("ExecuteSourceSessionDeletion() error = nil, want forced transition failure")
	}
	if _, ok, getErr := store.GetSession(ctx, workspaceID, "source-session"); getErr != nil || !ok {
		t.Fatalf("GetSession() ok=%v error=%v, want rollback to preserve session", ok, getErr)
	}
	if _, ok, getErr := store.GetTuttiModeActivation(ctx, workspaceID, "source-session"); getErr != nil || !ok {
		t.Fatalf("GetTuttiModeActivation() ok=%v error=%v, want rollback to preserve activation", ok, getErr)
	}
	snapshot, getErr := store.GetWorkspaceWorkflowSnapshot(ctx, workspaceID, "workflow-1")
	if getErr != nil || snapshot.Workflow.Status != workflowbiz.WorkflowStatusPendingReview || snapshot.Checkpoints[0].Status != workflowbiz.CheckpointStatusPending {
		t.Fatalf("workflow after rollback = %#v error=%v", snapshot, getErr)
	}
}
