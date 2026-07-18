package workspace

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
)

func TestSQLiteStoreCreatesWorkspaceWorkflowProposalAtomically(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createWorkflowTestWorkspace(t, store, "ws-workflow")
	now := time.UnixMilli(1_700_000_000_000).UTC()

	aggregate := workflowbiz.ProposalAggregate{
		Workflow: workflowbiz.Workflow{
			ID:                "workflow-1",
			WorkspaceID:       "ws-workflow",
			Type:              workflowbiz.WorkflowTypeTuttiModePlan,
			Owner:             workflowbiz.WorkflowOwnerTutti,
			TriggerKind:       workflowbiz.TriggerKindAgentCLI,
			SourceSessionID:   "agent-session-not-owned-by-workspace-store",
			SourceTurnID:      "turn-1",
			SourceToolCallID:  "tool-call-1",
			Status:            workflowbiz.WorkflowStatusPendingReview,
			CurrentRevisionID: "revision-1",
			CreatedAt:         now,
			UpdatedAt:         now,
		},
		Plan: workflowbiz.TuttiModePlan{WorkflowID: "workflow-1"},
		Revision: workflowbiz.PlanRevision{
			ID:               "revision-1",
			WorkflowID:       "workflow-1",
			Sequence:         1,
			SchemaVersion:    "tutti-mode-plan/v1",
			DocumentPath:     "workflow-plans/workflow-1/revision-1.md",
			SHA256:           "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			ProducedByTurnID: "turn-1",
			CreatedAt:        now,
		},
		Checkpoint: workflowbiz.WorkflowCheckpoint{
			ID:         "checkpoint-1",
			WorkflowID: "workflow-1",
			Kind:       workflowbiz.CheckpointKindConfigurationReview,
			RevisionID: "revision-1",
			Status:     workflowbiz.CheckpointStatusPending,
			CreatedAt:  now,
			UpdatedAt:  now,
		},
		TurnLinks: []workflowbiz.WorkflowTurnLink{{
			WorkflowID: "workflow-1",
			TurnID:     "turn-1",
			Relation:   workflowbiz.TurnRelationSource,
			CreatedAt:  now,
		}},
	}
	if err := store.CreateWorkspaceWorkflowProposal(ctx, aggregate); err != nil {
		t.Fatalf("CreateWorkspaceWorkflowProposal() error = %v", err)
	}

	snapshot, err := store.GetWorkspaceWorkflowSnapshot(ctx, "ws-workflow", "workflow-1")
	if err != nil {
		t.Fatalf("GetWorkspaceWorkflowSnapshot() error = %v", err)
	}
	if snapshot.Workflow != aggregate.Workflow {
		t.Fatalf("workflow = %#v, want %#v", snapshot.Workflow, aggregate.Workflow)
	}
	if len(snapshot.Revisions) != 1 || snapshot.Revisions[0] != aggregate.Revision {
		t.Fatalf("revisions = %#v, want initial revision", snapshot.Revisions)
	}
	if len(snapshot.Checkpoints) != 1 || !reflect.DeepEqual(snapshot.Checkpoints[0], aggregate.Checkpoint) {
		t.Fatalf("checkpoints = %#v, want initial checkpoint", snapshot.Checkpoints)
	}
	if len(snapshot.TurnLinks) != 1 || snapshot.TurnLinks[0] != aggregate.TurnLinks[0] {
		t.Fatalf("turn links = %#v, want source link", snapshot.TurnLinks)
	}

	pending, err := store.ListPendingWorkflowCheckpointsBySourceSession(
		ctx,
		"ws-workflow",
		"agent-session-not-owned-by-workspace-store",
	)
	if err != nil {
		t.Fatalf("ListPendingWorkflowCheckpointsBySourceSession() error = %v", err)
	}
	if len(pending) != 1 || pending[0].Checkpoint.ID != "checkpoint-1" || pending[0].Workflow.ID != "workflow-1" {
		t.Fatalf("pending = %#v, want checkpoint-1 projection", pending)
	}

	workflows, err := store.ListWorkflowsBySourceSession(
		ctx,
		"ws-workflow",
		"agent-session-not-owned-by-workspace-store",
	)
	if err != nil {
		t.Fatalf("ListWorkflowsBySourceSession() error = %v", err)
	}
	if len(workflows) != 1 || workflows[0] != aggregate.Workflow {
		t.Fatalf("workflows = %#v, want workflow-1 projection", workflows)
	}
}

func TestSQLiteStoreAppendPlanRevisionSupersedesPendingCheckpoint(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createWorkflowTestWorkspace(t, store, "ws-revision")
	createdAt := time.UnixMilli(1_700_000_000_000).UTC()
	createWorkflowProposalFixture(t, store, "ws-revision", "workflow-revision", createdAt)

	updatedAt := createdAt.Add(time.Minute)
	appendInput := AppendWorkspaceWorkflowPlanRevisionInput{
		WorkspaceID:               "ws-revision",
		WorkflowID:                "workflow-revision",
		ExpectedSourceSessionID:   "source-session",
		ExpectedCurrentRevisionID: "revision-1",
		ExpectedWorkflowStatus:    workflowbiz.WorkflowStatusPendingReview,
		ExpectedCheckpointID:      "checkpoint-1",
		ExpectedCheckpointStatus:  workflowbiz.CheckpointStatusPending,
		Revision: workflowbiz.PlanRevision{
			ID:               "revision-2",
			WorkflowID:       "workflow-revision",
			Sequence:         2,
			SchemaVersion:    "tutti-mode-plan/v1",
			DocumentPath:     "workflow-plans/workflow-revision/revision-2.md",
			SHA256:           "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
			ProducedByTurnID: "turn-2",
			CreatedAt:        updatedAt,
		},
		Checkpoint: workflowbiz.WorkflowCheckpoint{
			ID:         "checkpoint-2",
			WorkflowID: "workflow-revision",
			Kind:       workflowbiz.CheckpointKindTaskReview,
			RevisionID: "revision-2",
			Status:     workflowbiz.CheckpointStatusPending,
			CreatedAt:  updatedAt,
			UpdatedAt:  updatedAt,
		},
		TurnLinks: []workflowbiz.WorkflowTurnLink{{
			WorkflowID: "workflow-revision",
			TurnID:     "turn-2",
			Relation:   workflowbiz.TurnRelationRevision,
			CreatedAt:  updatedAt,
		}},
		UpdatedAt: updatedAt,
	}
	if err := store.AppendWorkspaceWorkflowPlanRevision(ctx, appendInput); err != nil {
		t.Fatalf("AppendWorkspaceWorkflowPlanRevision() error = %v", err)
	}

	snapshot, err := store.GetWorkspaceWorkflowSnapshot(ctx, "ws-revision", "workflow-revision")
	if err != nil {
		t.Fatalf("GetWorkspaceWorkflowSnapshot() error = %v", err)
	}
	if snapshot.Workflow.CurrentRevisionID != "revision-2" {
		t.Fatalf("current revision = %q, want revision-2", snapshot.Workflow.CurrentRevisionID)
	}
	if len(snapshot.Revisions) != 2 || snapshot.Revisions[0].ID != "revision-1" || snapshot.Revisions[1].ID != "revision-2" {
		t.Fatalf("revisions = %#v, want immutable ordered history", snapshot.Revisions)
	}
	if len(snapshot.Checkpoints) != 2 || snapshot.Checkpoints[0].Status != workflowbiz.CheckpointStatusSuperseded || snapshot.Checkpoints[1].Status != workflowbiz.CheckpointStatusPending {
		t.Fatalf("checkpoints = %#v, want superseded then pending", snapshot.Checkpoints)
	}

	appendInput.Checkpoint.ID = "checkpoint-duplicate"
	appendInput.Checkpoint.RevisionID = "revision-2"
	if err := store.AppendWorkspaceWorkflowPlanRevision(ctx, appendInput); !errors.Is(err, ErrWorkflowRevisionConflict) {
		t.Fatalf("duplicate append error = %v, want ErrWorkflowRevisionConflict", err)
	}
	unchanged, err := store.GetWorkspaceWorkflowSnapshot(ctx, "ws-revision", "workflow-revision")
	if err != nil {
		t.Fatalf("GetWorkspaceWorkflowSnapshot(after duplicate) error = %v", err)
	}
	if len(unchanged.Revisions) != 2 || len(unchanged.Checkpoints) != 2 {
		t.Fatalf("duplicate append was not atomic: revisions=%d checkpoints=%d", len(unchanged.Revisions), len(unchanged.Checkpoints))
	}
}

func TestSQLiteStoreCheckpointAndOperationCompareAndSet(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createWorkflowTestWorkspace(t, store, "ws-cas")
	createdAt := time.UnixMilli(1_700_000_000_000).UTC()
	createWorkflowProposalFixture(t, store, "ws-cas", "workflow-cas", createdAt)

	decidedAt := createdAt.Add(time.Second)
	checkpoint, changed, err := store.DecideWorkspaceWorkflowCheckpoint(ctx, DecideWorkspaceWorkflowCheckpointInput{
		WorkspaceID:               "ws-cas",
		WorkflowID:                "workflow-cas",
		CheckpointID:              "checkpoint-1",
		ExpectedStatus:            workflowbiz.CheckpointStatusPending,
		ExpectedCurrentRevisionID: "revision-1",
		ExpectedWorkflowStatus:    workflowbiz.WorkflowStatusPendingReview,
		Decision:                  workflowbiz.CheckpointStatusAccepted,
		DecidedBy:                 "user",
		DecisionReason:            "approved",
		DecidedAt:                 decidedAt,
		WorkflowStatus:            workflowbiz.WorkflowStatusInProgress,
	})
	if err != nil || !changed {
		t.Fatalf("DecideWorkspaceWorkflowCheckpoint() changed=%v error=%v", changed, err)
	}
	if checkpoint.Status != workflowbiz.CheckpointStatusAccepted || checkpoint.DecidedAt != decidedAt {
		t.Fatalf("checkpoint = %#v, want accepted", checkpoint)
	}
	_, changed, err = store.DecideWorkspaceWorkflowCheckpoint(ctx, DecideWorkspaceWorkflowCheckpointInput{
		WorkspaceID:               "ws-cas",
		WorkflowID:                "workflow-cas",
		CheckpointID:              "checkpoint-1",
		ExpectedStatus:            workflowbiz.CheckpointStatusPending,
		ExpectedCurrentRevisionID: "revision-1",
		ExpectedWorkflowStatus:    workflowbiz.WorkflowStatusPendingReview,
		Decision:                  workflowbiz.CheckpointStatusRejected,
		DecidedAt:                 decidedAt.Add(time.Second),
		WorkflowStatus:            workflowbiz.WorkflowStatusInProgress,
	})
	if err != nil || changed {
		t.Fatalf("second decision changed=%v error=%v, want unchanged", changed, err)
	}

	operation := workflowbiz.WorkflowOperation{
		ID:         "operation-1",
		WorkflowID: "workflow-cas",
		Kind:       workflowbiz.OperationKindGenerateTaskGraph,
		Status:     workflowbiz.OperationStatusRunning,
		RevisionID: "revision-1",
		CreatedAt:  decidedAt,
		UpdatedAt:  decidedAt,
		StartedAt:  decidedAt,
	}
	if err := store.RecordWorkspaceWorkflowOperation(ctx, "ws-cas", operation); err != nil {
		t.Fatalf("RecordWorkspaceWorkflowOperation() error = %v", err)
	}
	failedAt := decidedAt.Add(2 * time.Second)
	failed, changed, err := store.CompleteWorkspaceWorkflowOperation(ctx, CompleteWorkspaceWorkflowOperationInput{
		WorkspaceID:    "ws-cas",
		WorkflowID:     "workflow-cas",
		OperationID:    "operation-1",
		ExpectedStatus: workflowbiz.OperationStatusRunning,
		Status:         workflowbiz.OperationStatusFailed,
		ErrorCode:      "temporary_failure",
		ErrorMessage:   "retry me",
		CompletedAt:    failedAt,
	})
	if err != nil || !changed {
		t.Fatalf("CompleteWorkspaceWorkflowOperation() changed=%v error=%v", changed, err)
	}
	if failed.Status != workflowbiz.OperationStatusFailed || failed.ErrorCode != "temporary_failure" || failed.CompletedAt != failedAt {
		t.Fatalf("failed operation = %#v", failed)
	}
	retriedAt := failedAt.Add(time.Second)
	retried, changed, err := store.RetryWorkspaceWorkflowOperation(ctx, RetryWorkspaceWorkflowOperationInput{
		WorkspaceID: "ws-cas",
		WorkflowID:  "workflow-cas",
		OperationID: "operation-1",
		RetriedAt:   retriedAt,
	})
	if err != nil || !changed {
		t.Fatalf("RetryWorkspaceWorkflowOperation() changed=%v error=%v", changed, err)
	}
	if retried.Status != workflowbiz.OperationStatusPending || retried.ErrorCode != "" || !retried.CompletedAt.IsZero() || retried.UpdatedAt != retriedAt {
		t.Fatalf("retried operation = %#v", retried)
	}
	_, changed, err = store.RetryWorkspaceWorkflowOperation(ctx, RetryWorkspaceWorkflowOperationInput{
		WorkspaceID: "ws-cas",
		WorkflowID:  "workflow-cas",
		OperationID: "operation-1",
		RetriedAt:   retriedAt.Add(time.Second),
	})
	if err != nil || changed {
		t.Fatalf("second retry changed=%v error=%v, want unchanged", changed, err)
	}
	completedAt := retriedAt.Add(2 * time.Second)
	completed, changed, err := store.CompleteWorkspaceWorkflowOperation(ctx, CompleteWorkspaceWorkflowOperationInput{
		WorkspaceID:    "ws-cas",
		WorkflowID:     "workflow-cas",
		OperationID:    "operation-1",
		ExpectedStatus: workflowbiz.OperationStatusPending,
		Status:         workflowbiz.OperationStatusSucceeded,
		IssueID:        "issue-1",
		CompletedAt:    completedAt,
	})
	if err != nil || !changed {
		t.Fatalf("completion after retry changed=%v error=%v", changed, err)
	}
	if completed.Status != workflowbiz.OperationStatusSucceeded || completed.IssueID != "issue-1" || completed.CompletedAt != completedAt {
		t.Fatalf("completed operation = %#v", completed)
	}

	racingOperation := workflowbiz.WorkflowOperation{
		ID:         "operation-race",
		WorkflowID: "workflow-cas",
		Kind:       workflowbiz.OperationKindCreateIssue,
		Status:     workflowbiz.OperationStatusPending,
		RevisionID: "revision-1",
		CreatedAt:  completedAt,
		UpdatedAt:  completedAt,
	}
	if err := store.RecordWorkspaceWorkflowOperation(ctx, "ws-cas", racingOperation); err != nil {
		t.Fatalf("record racing operation: %v", err)
	}
	if _, changed, err := store.CompleteWorkspaceWorkflowOperation(ctx, CompleteWorkspaceWorkflowOperationInput{
		WorkspaceID:    "ws-cas",
		WorkflowID:     "workflow-cas",
		OperationID:    "operation-race",
		ExpectedStatus: workflowbiz.OperationStatusPending,
		Status:         workflowbiz.OperationStatusFailed,
		ErrorCode:      "temporary_failure",
		CompletedAt:    completedAt.Add(time.Second),
	}); err != nil || !changed {
		t.Fatalf("fail racing operation changed=%v error=%v", changed, err)
	}
	converged, changed, err := store.CompleteWorkspaceWorkflowOperation(ctx, CompleteWorkspaceWorkflowOperationInput{
		WorkspaceID:    "ws-cas",
		WorkflowID:     "workflow-cas",
		OperationID:    "operation-race",
		ExpectedStatus: workflowbiz.OperationStatusPending,
		Status:         workflowbiz.OperationStatusSucceeded,
		IssueID:        "issue-race",
		CompletedAt:    completedAt.Add(2 * time.Second),
	})
	if err != nil || !changed || converged.Status != workflowbiz.OperationStatusSucceeded || converged.IssueID != "issue-race" {
		t.Fatalf("success-dominant completion = %#v changed=%v error=%v", converged, changed, err)
	}

	snapshot, err := store.GetWorkspaceWorkflowSnapshot(ctx, "ws-cas", "workflow-cas")
	if err != nil {
		t.Fatalf("GetWorkspaceWorkflowSnapshot() error = %v", err)
	}
	if snapshot.Workflow.Status != workflowbiz.WorkflowStatusInProgress {
		t.Fatalf("workflow status = %q, want in_progress", snapshot.Workflow.Status)
	}
	if len(snapshot.Operations) != 2 || snapshot.Operations[0].Status != workflowbiz.OperationStatusSucceeded || snapshot.Operations[1].Status != workflowbiz.OperationStatusSucceeded {
		t.Fatalf("operations = %#v, want succeeded operation", snapshot.Operations)
	}
}

func TestSQLiteStoreDecisionAndOperationCommitAtomically(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createWorkflowTestWorkspace(t, store, "ws-decision-operation")
	createdAt := time.UnixMilli(1_700_000_000_000).UTC()
	createWorkflowProposalFixture(t, store, "ws-decision-operation", "workflow-decision-operation", createdAt)
	operation := workflowbiz.WorkflowOperation{
		ID:         "operation-decision",
		WorkflowID: "workflow-decision-operation",
		Kind:       workflowbiz.OperationKindGenerateTaskGraph,
		Status:     workflowbiz.OperationStatusPending,
		RevisionID: "revision-1",
		CreatedAt:  createdAt.Add(time.Second),
		UpdatedAt:  createdAt.Add(time.Second),
	}

	checkpoint, changed, err := store.DecideWorkspaceWorkflowCheckpoint(ctx, DecideWorkspaceWorkflowCheckpointInput{
		WorkspaceID:               "ws-decision-operation",
		WorkflowID:                "workflow-decision-operation",
		CheckpointID:              "checkpoint-1",
		ExpectedStatus:            workflowbiz.CheckpointStatusPending,
		ExpectedCurrentRevisionID: "revision-1",
		ExpectedWorkflowStatus:    workflowbiz.WorkflowStatusPendingReview,
		Decision:                  workflowbiz.CheckpointStatusAccepted,
		DecidedBy:                 "user",
		DecidedAt:                 createdAt.Add(time.Second),
		WorkflowStatus:            workflowbiz.WorkflowStatusInProgress,
		Operation:                 &operation,
	})
	if err != nil || !changed || checkpoint.Status != workflowbiz.CheckpointStatusAccepted {
		t.Fatalf("decision changed=%v checkpoint=%#v error=%v", changed, checkpoint, err)
	}
	snapshot, err := store.GetWorkspaceWorkflowSnapshot(ctx, "ws-decision-operation", "workflow-decision-operation")
	if err != nil {
		t.Fatalf("GetWorkspaceWorkflowSnapshot() error = %v", err)
	}
	if len(snapshot.Operations) != 1 || snapshot.Operations[0] != operation {
		t.Fatalf("operations = %#v, want atomic operation %#v", snapshot.Operations, operation)
	}

	createWorkflowProposalFixture(t, store, "ws-decision-operation", "workflow-rollback", createdAt)
	conflict := operation
	conflict.WorkflowID = "workflow-rollback"
	conflict.ID = "operation-conflict"
	if err := store.RecordWorkspaceWorkflowOperation(ctx, "ws-decision-operation", conflict); err != nil {
		t.Fatalf("seed conflicting operation: %v", err)
	}
	_, changed, err = store.DecideWorkspaceWorkflowCheckpoint(ctx, DecideWorkspaceWorkflowCheckpointInput{
		WorkspaceID:               "ws-decision-operation",
		WorkflowID:                "workflow-rollback",
		CheckpointID:              "checkpoint-1",
		ExpectedStatus:            workflowbiz.CheckpointStatusPending,
		ExpectedCurrentRevisionID: "revision-1",
		ExpectedWorkflowStatus:    workflowbiz.WorkflowStatusPendingReview,
		Decision:                  workflowbiz.CheckpointStatusAccepted,
		DecidedBy:                 "user",
		DecidedAt:                 createdAt.Add(2 * time.Second),
		WorkflowStatus:            workflowbiz.WorkflowStatusInProgress,
		Operation:                 &conflict,
	})
	if err == nil || changed {
		t.Fatalf("conflicting operation decision changed=%v error=%v, want atomic rollback", changed, err)
	}
	rolledBack, err := store.GetWorkspaceWorkflowSnapshot(ctx, "ws-decision-operation", "workflow-rollback")
	if err != nil {
		t.Fatalf("GetWorkspaceWorkflowSnapshot(rollback) error = %v", err)
	}
	if rolledBack.Workflow.Status != workflowbiz.WorkflowStatusPendingReview || rolledBack.Checkpoints[0].Status != workflowbiz.CheckpointStatusPending {
		t.Fatalf("decision escaped failed transaction: %#v", rolledBack)
	}
}

func TestSQLiteStoreRevisionAndDecisionCASPreventStaleTransitions(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createWorkflowTestWorkspace(t, store, "ws-workflow-race")
	createdAt := time.UnixMilli(1_700_000_000_000).UTC()
	createWorkflowProposalFixture(t, store, "ws-workflow-race", "workflow-decide-first", createdAt)
	operation := workflowbiz.WorkflowOperation{
		ID:         "operation-generate",
		WorkflowID: "workflow-decide-first",
		Kind:       workflowbiz.OperationKindGenerateTaskGraph,
		Status:     workflowbiz.OperationStatusPending,
		RevisionID: "revision-1",
		CreatedAt:  createdAt.Add(time.Second),
		UpdatedAt:  createdAt.Add(time.Second),
	}
	if _, changed, err := store.DecideWorkspaceWorkflowCheckpoint(ctx, DecideWorkspaceWorkflowCheckpointInput{
		WorkspaceID:               "ws-workflow-race",
		WorkflowID:                "workflow-decide-first",
		CheckpointID:              "checkpoint-1",
		ExpectedStatus:            workflowbiz.CheckpointStatusPending,
		ExpectedCurrentRevisionID: "revision-1",
		ExpectedWorkflowStatus:    workflowbiz.WorkflowStatusPendingReview,
		Decision:                  workflowbiz.CheckpointStatusAccepted,
		DecidedBy:                 "user",
		DecidedAt:                 createdAt.Add(time.Second),
		WorkflowStatus:            workflowbiz.WorkflowStatusInProgress,
		Operation:                 &operation,
	}); err != nil || !changed {
		t.Fatalf("decide first changed=%v error=%v", changed, err)
	}
	staleAppend := workflowAppendFixture("ws-workflow-race", "workflow-decide-first", createdAt.Add(2*time.Second))
	staleAppend.ExpectedWorkflowStatus = workflowbiz.WorkflowStatusPendingReview
	staleAppend.ExpectedCheckpointStatus = workflowbiz.CheckpointStatusPending
	if err := store.AppendWorkspaceWorkflowPlanRevision(ctx, staleAppend); !errors.Is(err, ErrWorkflowRevisionConflict) {
		t.Fatalf("stale append error = %v, want ErrWorkflowRevisionConflict", err)
	}
	afterDecision, err := store.GetWorkspaceWorkflowSnapshot(ctx, "ws-workflow-race", "workflow-decide-first")
	if err != nil {
		t.Fatalf("GetWorkspaceWorkflowSnapshot(decide first) error = %v", err)
	}
	if afterDecision.Workflow.CurrentRevisionID != "revision-1" || afterDecision.Workflow.Status != workflowbiz.WorkflowStatusInProgress || len(afterDecision.Revisions) != 1 {
		t.Fatalf("stale append changed decided workflow: %#v", afterDecision)
	}

	createWorkflowProposalFixture(t, store, "ws-workflow-race", "workflow-revise-first", createdAt)
	reviseFirst := workflowAppendFixture("ws-workflow-race", "workflow-revise-first", createdAt.Add(time.Second))
	if err := store.AppendWorkspaceWorkflowPlanRevision(ctx, reviseFirst); err != nil {
		t.Fatalf("append first error = %v", err)
	}
	_, changed, err := store.DecideWorkspaceWorkflowCheckpoint(ctx, DecideWorkspaceWorkflowCheckpointInput{
		WorkspaceID:               "ws-workflow-race",
		WorkflowID:                "workflow-revise-first",
		CheckpointID:              "checkpoint-1",
		ExpectedStatus:            workflowbiz.CheckpointStatusPending,
		ExpectedCurrentRevisionID: "revision-1",
		ExpectedWorkflowStatus:    workflowbiz.WorkflowStatusPendingReview,
		Decision:                  workflowbiz.CheckpointStatusAccepted,
		DecidedBy:                 "user",
		DecidedAt:                 createdAt.Add(2 * time.Second),
		WorkflowStatus:            workflowbiz.WorkflowStatusInProgress,
	})
	if err != nil || changed {
		t.Fatalf("stale decision changed=%v error=%v, want unchanged", changed, err)
	}
	afterRevision, err := store.GetWorkspaceWorkflowSnapshot(ctx, "ws-workflow-race", "workflow-revise-first")
	if err != nil {
		t.Fatalf("GetWorkspaceWorkflowSnapshot(revise first) error = %v", err)
	}
	if afterRevision.Workflow.CurrentRevisionID != "revision-2" || afterRevision.Workflow.Status != workflowbiz.WorkflowStatusPendingReview || afterRevision.Checkpoints[0].Status != workflowbiz.CheckpointStatusSuperseded {
		t.Fatalf("stale decision changed revised workflow: %#v", afterRevision)
	}
}

func TestSQLiteStoreRevisionAppendHidesSourceSessionMismatch(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createWorkflowTestWorkspace(t, store, "ws-workflow-scope")
	createdAt := time.UnixMilli(1_700_000_000_000).UTC()
	createWorkflowProposalFixture(t, store, "ws-workflow-scope", "workflow-scope", createdAt)
	appendInput := workflowAppendFixture("ws-workflow-scope", "workflow-scope", createdAt.Add(time.Second))
	appendInput.ExpectedSourceSessionID = "another-session"

	if err := store.AppendWorkspaceWorkflowPlanRevision(ctx, appendInput); !errors.Is(err, ErrWorkspaceWorkflowNotFound) {
		t.Fatalf("source mismatch error = %v, want ErrWorkspaceWorkflowNotFound", err)
	}
	snapshot, err := store.GetWorkspaceWorkflowSnapshot(ctx, "ws-workflow-scope", "workflow-scope")
	if err != nil {
		t.Fatalf("GetWorkspaceWorkflowSnapshot() error = %v", err)
	}
	if snapshot.Workflow.CurrentRevisionID != "revision-1" || len(snapshot.Revisions) != 1 || len(snapshot.Checkpoints) != 1 {
		t.Fatalf("source mismatch mutated workflow: %#v", snapshot)
	}
}

func TestSQLiteStoreRevisionCompletesExactPendingDecisionOperation(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createWorkflowTestWorkspace(t, store, "ws-operation-lifecycle")
	createdAt := time.UnixMilli(1_700_000_000_000).UTC()
	createWorkflowProposalFixture(t, store, "ws-operation-lifecycle", "workflow-operation-lifecycle", createdAt)
	operation := workflowbiz.WorkflowOperation{
		ID:         "operation-generate",
		WorkflowID: "workflow-operation-lifecycle",
		Kind:       workflowbiz.OperationKindGenerateTaskGraph,
		Status:     workflowbiz.OperationStatusPending,
		RevisionID: "revision-1",
		CreatedAt:  createdAt.Add(time.Second),
		UpdatedAt:  createdAt.Add(time.Second),
	}
	if _, changed, err := store.DecideWorkspaceWorkflowCheckpoint(ctx, DecideWorkspaceWorkflowCheckpointInput{
		WorkspaceID:               "ws-operation-lifecycle",
		WorkflowID:                "workflow-operation-lifecycle",
		CheckpointID:              "checkpoint-1",
		ExpectedStatus:            workflowbiz.CheckpointStatusPending,
		ExpectedCurrentRevisionID: "revision-1",
		ExpectedWorkflowStatus:    workflowbiz.WorkflowStatusPendingReview,
		Decision:                  workflowbiz.CheckpointStatusAccepted,
		DecidedBy:                 "user",
		DecidedAt:                 createdAt.Add(time.Second),
		WorkflowStatus:            workflowbiz.WorkflowStatusInProgress,
		Operation:                 &operation,
	}); err != nil || !changed {
		t.Fatalf("decision changed=%v error=%v", changed, err)
	}
	appendInput := workflowAppendFixture("ws-operation-lifecycle", "workflow-operation-lifecycle", createdAt.Add(2*time.Second))
	appendInput.ExpectedWorkflowStatus = workflowbiz.WorkflowStatusInProgress
	appendInput.ExpectedCheckpointStatus = workflowbiz.CheckpointStatusAccepted
	appendInput.CompleteOperation = &AppendWorkspaceWorkflowOperationCompletion{
		OperationID:    operation.ID,
		Kind:           operation.Kind,
		RevisionID:     operation.RevisionID,
		ExpectedStatus: workflowbiz.OperationStatusPending,
	}
	if err := store.AppendWorkspaceWorkflowPlanRevision(ctx, appendInput); err != nil {
		t.Fatalf("AppendWorkspaceWorkflowPlanRevision() error = %v", err)
	}
	snapshot, err := store.GetWorkspaceWorkflowSnapshot(ctx, "ws-operation-lifecycle", "workflow-operation-lifecycle")
	if err != nil {
		t.Fatalf("GetWorkspaceWorkflowSnapshot() error = %v", err)
	}
	if len(snapshot.Operations) != 1 || snapshot.Operations[0].Status != workflowbiz.OperationStatusSucceeded || snapshot.Operations[0].CompletedAt != appendInput.UpdatedAt {
		t.Fatalf("operation lifecycle = %#v, want exact operation succeeded", snapshot.Operations)
	}
}

func TestSQLiteStoreProposalMutationLedgerConvergesConcurrentRetries(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createWorkflowTestWorkspace(t, store, "ws-proposal-mutation")
	now := time.UnixMilli(1_700_000_000_000).UTC()
	inputs := []CreateWorkspaceWorkflowProposalMutationInput{
		proposalMutationInput("ws-proposal-mutation", "workflow-a", "revision-a", "checkpoint-a", "request-1", strings64("a"), now),
		proposalMutationInput("ws-proposal-mutation", "workflow-b", "revision-b", "checkpoint-b", "request-1", strings64("a"), now),
	}
	type outcome struct {
		mutation workflowbiz.WorkflowMutation
		created  bool
		err      error
	}
	start := make(chan struct{})
	outcomes := make(chan outcome, len(inputs))
	for _, input := range inputs {
		input := input
		go func() {
			<-start
			mutation, created, err := store.CreateWorkspaceWorkflowProposalWithMutation(ctx, input)
			outcomes <- outcome{mutation: mutation, created: created, err: err}
		}()
	}
	close(start)
	first := <-outcomes
	second := <-outcomes
	if first.err != nil || second.err != nil {
		t.Fatalf("concurrent mutation errors = %v / %v", first.err, second.err)
	}
	if first.created == second.created || first.mutation.WorkflowID != second.mutation.WorkflowID {
		t.Fatalf("concurrent outcomes = %#v / %#v, want one creator and one replay", first, second)
	}
	winnerWorkflowID := first.mutation.WorkflowID
	loserWorkflowID := "workflow-a"
	if winnerWorkflowID == loserWorkflowID {
		loserWorkflowID = "workflow-b"
	}
	if _, err := store.GetWorkspaceWorkflowSnapshot(ctx, "ws-proposal-mutation", loserWorkflowID); !errors.Is(err, ErrWorkspaceWorkflowNotFound) {
		t.Fatalf("losing proposal workflow error = %v, want not found", err)
	}

	conflict := proposalMutationInput("ws-proposal-mutation", "workflow-conflict", "revision-conflict", "checkpoint-conflict", "request-1", strings64("b"), now)
	if _, _, err := store.CreateWorkspaceWorkflowProposalWithMutation(ctx, conflict); !errors.Is(err, ErrWorkflowMutationConflict) {
		t.Fatalf("digest conflict error = %v, want ErrWorkflowMutationConflict", err)
	}
	intentional := proposalMutationInput("ws-proposal-mutation", "workflow-intentional", "revision-intentional", "checkpoint-intentional", "request-2", strings64("a"), now)
	if mutation, created, err := store.CreateWorkspaceWorkflowProposalWithMutation(ctx, intentional); err != nil || !created || mutation.WorkflowID != "workflow-intentional" {
		t.Fatalf("intentional proposal mutation = %#v created=%v error=%v", mutation, created, err)
	}
}

func TestSQLiteStoreRevisionMutationReplaysByRequestAndAllowsSameContentWithNewRequest(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createWorkflowTestWorkspace(t, store, "ws-revision-mutation")
	now := time.UnixMilli(1_700_000_000_000).UTC()
	createWorkflowProposalFixture(t, store, "ws-revision-mutation", "workflow-revision-mutation", now)

	firstAppend := workflowAppendFixture("ws-revision-mutation", "workflow-revision-mutation", now.Add(time.Second))
	firstAppend.Revision.DocumentPath = "workflow-plans/workflow-revision-mutation/content-addressed.md"
	first := AppendWorkspaceWorkflowPlanRevisionMutationInput{
		Append: firstAppend,
		Mutation: workflowbiz.WorkflowMutation{
			WorkspaceID: "ws-revision-mutation", SourceSessionID: "source-session",
			Kind: workflowbiz.MutationKindRevise, ScopeID: "workflow-revision-mutation", RequestID: "request-1",
			InputSHA256: firstAppend.Revision.SHA256, WorkflowID: "workflow-revision-mutation",
			RevisionID: firstAppend.Revision.ID, CheckpointID: firstAppend.Checkpoint.ID, CreatedAt: firstAppend.UpdatedAt,
		},
	}
	committed, created, err := store.AppendWorkspaceWorkflowPlanRevisionWithMutation(ctx, first)
	if err != nil || !created {
		t.Fatalf("first revision mutation = %#v created=%v error=%v", committed, created, err)
	}

	replay := first
	replay.Append.Revision.ID = "revision-replay-candidate"
	replay.Append.Checkpoint.ID = "checkpoint-replay-candidate"
	replay.Append.Checkpoint.RevisionID = replay.Append.Revision.ID
	replay.Mutation.RevisionID = replay.Append.Revision.ID
	replay.Mutation.CheckpointID = replay.Append.Checkpoint.ID
	replayed, created, err := store.AppendWorkspaceWorkflowPlanRevisionWithMutation(ctx, replay)
	if err != nil || created || replayed.RevisionID != first.Append.Revision.ID {
		t.Fatalf("replayed revision mutation = %#v created=%v error=%v", replayed, created, err)
	}

	conflict := replay
	conflict.Mutation.InputSHA256 = strings64("c")
	if _, _, err := store.AppendWorkspaceWorkflowPlanRevisionWithMutation(ctx, conflict); !errors.Is(err, ErrWorkflowMutationConflict) {
		t.Fatalf("revision digest conflict error = %v, want ErrWorkflowMutationConflict", err)
	}

	intentionalAppend := firstAppend
	intentionalAppend.ExpectedCurrentRevisionID = "revision-2"
	intentionalAppend.ExpectedCheckpointID = "checkpoint-2"
	intentionalAppend.Revision.ID = "revision-3"
	intentionalAppend.Revision.Sequence = 3
	intentionalAppend.Revision.CreatedAt = now.Add(2 * time.Second)
	intentionalAppend.Checkpoint.ID = "checkpoint-3"
	intentionalAppend.Checkpoint.RevisionID = "revision-3"
	intentionalAppend.Checkpoint.CreatedAt = now.Add(2 * time.Second)
	intentionalAppend.Checkpoint.UpdatedAt = now.Add(2 * time.Second)
	intentionalAppend.UpdatedAt = now.Add(2 * time.Second)
	intentional := AppendWorkspaceWorkflowPlanRevisionMutationInput{
		Append: intentionalAppend,
		Mutation: workflowbiz.WorkflowMutation{
			WorkspaceID: "ws-revision-mutation", SourceSessionID: "source-session",
			Kind: workflowbiz.MutationKindRevise, ScopeID: "workflow-revision-mutation", RequestID: "request-2",
			InputSHA256: intentionalAppend.Revision.SHA256, WorkflowID: "workflow-revision-mutation",
			RevisionID: "revision-3", CheckpointID: "checkpoint-3", CreatedAt: intentionalAppend.UpdatedAt,
		},
	}
	if mutation, created, err := store.AppendWorkspaceWorkflowPlanRevisionWithMutation(ctx, intentional); err != nil || !created || mutation.RevisionID != "revision-3" {
		t.Fatalf("intentional same-content revision = %#v created=%v error=%v", mutation, created, err)
	}
	snapshot, err := store.GetWorkspaceWorkflowSnapshot(ctx, "ws-revision-mutation", "workflow-revision-mutation")
	if err != nil {
		t.Fatalf("GetWorkspaceWorkflowSnapshot() error = %v", err)
	}
	if len(snapshot.Revisions) != 3 || snapshot.Revisions[1].DocumentPath != snapshot.Revisions[2].DocumentPath || snapshot.Revisions[2].Sequence != 3 {
		t.Fatalf("same-content revision history = %#v", snapshot.Revisions)
	}
}

func TestWorkspaceWorkflowRevisionPathReuseMigrationUpgradesLocalV1Schema(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createWorkflowTestWorkspace(t, store, "ws-revision-upgrade")
	now := time.UnixMilli(1_700_000_000_000).UTC()
	proposalInput := proposalMutationInput(
		"ws-revision-upgrade", "workflow-revision-upgrade", "revision-1", "checkpoint-1",
		"proposal-request-1", strings64("a"), now,
	)
	if _, created, err := store.CreateWorkspaceWorkflowProposalWithMutation(ctx, proposalInput); err != nil || !created {
		t.Fatalf("create legacy proposal mutation created=%v error=%v", created, err)
	}
	operation := workflowbiz.WorkflowOperation{
		ID: "operation-upgrade", WorkflowID: "workflow-revision-upgrade",
		Kind: workflowbiz.OperationKindGenerateTaskGraph, Status: workflowbiz.OperationStatusPending,
		RevisionID: "revision-1", CreatedAt: now, UpdatedAt: now,
	}
	if err := store.RecordWorkspaceWorkflowOperation(ctx, "ws-revision-upgrade", operation); err != nil {
		t.Fatalf("record legacy child operation: %v", err)
	}

	if _, err := store.writeDB.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		t.Fatalf("disable foreign keys: %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
CREATE TABLE workspace_workflow_plan_revisions_legacy (
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision_sequence INTEGER NOT NULL CHECK (revision_sequence > 0),
  schema_version TEXT NOT NULL,
  document_path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  produced_by_turn_id TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, workflow_id, revision_id),
  UNIQUE (workspace_id, workflow_id, revision_sequence),
  UNIQUE (workspace_id, workflow_id, document_path),
  FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES tutti_mode_plans(workspace_id, workflow_id) ON DELETE CASCADE
);
INSERT INTO workspace_workflow_plan_revisions_legacy SELECT * FROM workspace_workflow_plan_revisions;
DROP TABLE workspace_workflow_plan_revisions;
ALTER TABLE workspace_workflow_plan_revisions_legacy RENAME TO workspace_workflow_plan_revisions;
DELETE FROM tuttid_schema_migrations WHERE id = ?;
`, schemaMigrationWorkspaceWorkflowRevisionPathReuseV3); err != nil {
		t.Fatalf("install legacy V1 revision schema: %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("restore foreign keys: %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() legacy workflow schema error = %v", err)
	}
	preserved, err := store.GetWorkspaceWorkflowSnapshot(ctx, "ws-revision-upgrade", "workflow-revision-upgrade")
	if err != nil {
		t.Fatalf("GetWorkspaceWorkflowSnapshot() after migration error = %v", err)
	}
	if len(preserved.Revisions) != 1 || len(preserved.Checkpoints) != 1 || len(preserved.Operations) != 1 || preserved.Operations[0].ID != operation.ID {
		t.Fatalf("migration did not preserve revision children: %#v", preserved)
	}
	mutation, found, err := store.GetWorkspaceWorkflowMutation(ctx, GetWorkspaceWorkflowMutationInput{
		WorkspaceID: "ws-revision-upgrade", SourceSessionID: "source-session",
		Kind: workflowbiz.MutationKindPropose, RequestID: "proposal-request-1",
	})
	if err != nil || !found || mutation.RevisionID != "revision-1" || mutation.CheckpointID != "checkpoint-1" {
		t.Fatalf("preserved mutation = %#v found=%v error=%v", mutation, found, err)
	}
	foreignKeyRows, err := store.writeDB.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		t.Fatalf("foreign_key_check error = %v", err)
	}
	if foreignKeyRows.Next() {
		_ = foreignKeyRows.Close()
		t.Fatal("corrective migration left a foreign key violation")
	}
	if err := foreignKeyRows.Close(); err != nil {
		t.Fatalf("close foreign_key_check rows: %v", err)
	}
	appendInput := workflowAppendFixture("ws-revision-upgrade", "workflow-revision-upgrade", now.Add(time.Second))
	appendInput.Revision.DocumentPath = "workflow-plans/workflow-revision-upgrade/revision-1.md"
	if err := store.AppendWorkspaceWorkflowPlanRevision(ctx, appendInput); err != nil {
		t.Fatalf("same-path append after corrective migration error = %v", err)
	}
}

func TestSQLiteStoreListsOnlyRecoverableAcceptedCreateIssueOperations(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createWorkflowTestWorkspace(t, store, "ws-create-issue-recovery")
	now := time.UnixMilli(1_700_000_000_000).UTC()
	createWorkflowProposalFixture(t, store, "ws-create-issue-recovery", "workflow-recovery", now)
	appendInput := workflowAppendFixture("ws-create-issue-recovery", "workflow-recovery", now.Add(time.Second))
	if err := store.AppendWorkspaceWorkflowPlanRevision(ctx, appendInput); err != nil {
		t.Fatalf("AppendWorkspaceWorkflowPlanRevision() error = %v", err)
	}
	operation := workflowbiz.WorkflowOperation{
		ID: "operation-create-issue", WorkflowID: "workflow-recovery",
		Kind: workflowbiz.OperationKindCreateIssue, Status: workflowbiz.OperationStatusPending,
		RevisionID: "revision-2", CreatedAt: now.Add(2 * time.Second), UpdatedAt: now.Add(2 * time.Second),
	}
	if _, changed, err := store.DecideWorkspaceWorkflowCheckpoint(ctx, DecideWorkspaceWorkflowCheckpointInput{
		WorkspaceID: "ws-create-issue-recovery", WorkflowID: "workflow-recovery", CheckpointID: "checkpoint-2",
		ExpectedStatus: workflowbiz.CheckpointStatusPending, ExpectedCurrentRevisionID: "revision-2",
		ExpectedWorkflowStatus: workflowbiz.WorkflowStatusPendingReview,
		Decision:               workflowbiz.CheckpointStatusAccepted, DecidedBy: "user", DecidedAt: now.Add(2 * time.Second),
		WorkflowStatus: workflowbiz.WorkflowStatusAccepted, Operation: &operation,
	}); err != nil || !changed {
		t.Fatalf("accept task review changed=%v error=%v", changed, err)
	}

	recoverable, err := store.ListRecoverableCreateIssueOperations(ctx)
	if err != nil {
		t.Fatalf("ListRecoverableCreateIssueOperations() error = %v", err)
	}
	if len(recoverable) != 1 || recoverable[0].Operation.ID != operation.ID || recoverable[0].Checkpoint.ID != "checkpoint-2" || recoverable[0].SourceSessionID != "source-session" {
		t.Fatalf("recoverable pending operations = %#v", recoverable)
	}
	if _, changed, err := store.CompleteWorkspaceWorkflowOperation(ctx, CompleteWorkspaceWorkflowOperationInput{
		WorkspaceID: "ws-create-issue-recovery", WorkflowID: "workflow-recovery", OperationID: operation.ID,
		ExpectedStatus: workflowbiz.OperationStatusPending, Status: workflowbiz.OperationStatusFailed,
		ErrorCode: "temporary", ErrorMessage: "retry", CompletedAt: now.Add(3 * time.Second),
	}); err != nil || !changed {
		t.Fatalf("fail create_issue changed=%v error=%v", changed, err)
	}
	recoverable, err = store.ListRecoverableCreateIssueOperations(ctx)
	if err != nil || len(recoverable) != 1 || recoverable[0].Operation.Status != workflowbiz.OperationStatusFailed {
		t.Fatalf("recoverable failed operations = %#v error=%v", recoverable, err)
	}
}

func proposalMutationInput(
	workspaceID string,
	workflowID string,
	revisionID string,
	checkpointID string,
	requestID string,
	digest string,
	now time.Time,
) CreateWorkspaceWorkflowProposalMutationInput {
	aggregate := workflowProposalFixture(workspaceID, workflowID, revisionID, checkpointID, now)
	return CreateWorkspaceWorkflowProposalMutationInput{
		Aggregate: aggregate,
		Mutation: workflowbiz.WorkflowMutation{
			WorkspaceID: workspaceID, SourceSessionID: aggregate.Workflow.SourceSessionID,
			Kind: workflowbiz.MutationKindPropose, RequestID: requestID, InputSHA256: digest,
			WorkflowID: workflowID, RevisionID: revisionID, CheckpointID: checkpointID, CreatedAt: now,
		},
	}
}

func strings64(character string) string {
	return strings.Repeat(character, 64)
}

func workflowAppendFixture(workspaceID string, workflowID string, updatedAt time.Time) AppendWorkspaceWorkflowPlanRevisionInput {
	return AppendWorkspaceWorkflowPlanRevisionInput{
		WorkspaceID:               workspaceID,
		WorkflowID:                workflowID,
		ExpectedSourceSessionID:   "source-session",
		ExpectedCurrentRevisionID: "revision-1",
		ExpectedWorkflowStatus:    workflowbiz.WorkflowStatusPendingReview,
		ExpectedCheckpointID:      "checkpoint-1",
		ExpectedCheckpointStatus:  workflowbiz.CheckpointStatusPending,
		Revision: workflowbiz.PlanRevision{
			ID:            "revision-2",
			WorkflowID:    workflowID,
			Sequence:      2,
			SchemaVersion: "tutti-mode-plan/v1",
			DocumentPath:  "workflow-plans/" + workflowID + "/revision-2.md",
			SHA256:        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
			CreatedAt:     updatedAt,
		},
		Checkpoint: workflowbiz.WorkflowCheckpoint{
			ID:         "checkpoint-2",
			WorkflowID: workflowID,
			Kind:       workflowbiz.CheckpointKindTaskReview,
			RevisionID: "revision-2",
			Status:     workflowbiz.CheckpointStatusPending,
			CreatedAt:  updatedAt,
			UpdatedAt:  updatedAt,
		},
		UpdatedAt: updatedAt,
	}
}

func createWorkflowTestWorkspace(t *testing.T, store *SQLiteStore, workspaceID string) {
	t.Helper()
	if err := store.Create(context.Background(), workspacebiz.Summary{ID: workspaceID, Name: "Workflow Workspace"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
}

func createWorkflowProposalFixture(t *testing.T, store *SQLiteStore, workspaceID string, workflowID string, now time.Time) {
	t.Helper()
	if err := store.CreateWorkspaceWorkflowProposal(context.Background(), workflowProposalFixture(workspaceID, workflowID, "revision-1", "checkpoint-1", now)); err != nil {
		t.Fatalf("CreateWorkspaceWorkflowProposal() fixture error = %v", err)
	}
}

func workflowProposalFixture(workspaceID string, workflowID string, revisionID string, checkpointID string, now time.Time) workflowbiz.ProposalAggregate {
	return workflowbiz.ProposalAggregate{
		Workflow: workflowbiz.Workflow{
			ID:                workflowID,
			WorkspaceID:       workspaceID,
			Type:              workflowbiz.WorkflowTypeTuttiModePlan,
			Owner:             workflowbiz.WorkflowOwnerTutti,
			TriggerKind:       workflowbiz.TriggerKindAgentCLI,
			SourceSessionID:   "source-session",
			SourceTurnID:      "turn-1",
			SourceToolCallID:  "tool-call-1",
			Status:            workflowbiz.WorkflowStatusPendingReview,
			CurrentRevisionID: revisionID,
			CreatedAt:         now,
			UpdatedAt:         now,
		},
		Plan: workflowbiz.TuttiModePlan{WorkflowID: workflowID},
		Revision: workflowbiz.PlanRevision{
			ID:               revisionID,
			WorkflowID:       workflowID,
			Sequence:         1,
			SchemaVersion:    "tutti-mode-plan/v1",
			DocumentPath:     "workflow-plans/" + workflowID + "/" + revisionID + ".md",
			SHA256:           "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			ProducedByTurnID: "turn-1",
			CreatedAt:        now,
		},
		Checkpoint: workflowbiz.WorkflowCheckpoint{
			ID:         checkpointID,
			WorkflowID: workflowID,
			Kind:       workflowbiz.CheckpointKindConfigurationReview,
			RevisionID: revisionID,
			Status:     workflowbiz.CheckpointStatusPending,
			CreatedAt:  now,
			UpdatedAt:  now,
		},
	}
}
