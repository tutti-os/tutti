package workspace

import (
	"context"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
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
