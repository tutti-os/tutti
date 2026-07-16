package tuttimodeplan

import (
	"context"
	"errors"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

func TestDeleteSourceSessionsOwnsCancellationPolicyAndPublishesAfterCommit(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_700_000_100_000).UTC()
	publisher := &recordingWorkflowPublisher{}
	store := &recordingSourceSessionDeletionStore{
		publishedCount: func() int { return len(publisher.updates) },
		result: workspacedata.SourceSessionDeletionResult{
			RemovedSessions:   1,
			RemovedSessionIDs: []string{"session-1"},
			WorkflowUpdates: []workspacedata.SourceSessionWorkflowUpdate{{
				WorkspaceID:       "workspace-1",
				WorkflowID:        "workflow-1",
				SourceSessionID:   "session-1",
				CheckpointID:      "checkpoint-1",
				CheckpointChanged: true,
				OperationChanged:  true,
			}},
		},
	}
	service := &Service{
		SourceSessionDeletions: store,
		Publisher:              publisher,
		Now:                    func() time.Time { return now },
	}

	result, err := service.DeleteSourceSessionsBatch(context.Background(), agentactivitybiz.DeleteSessionsBatchInput{
		WorkspaceID: " workspace-1 ",
		SessionIDs:  []string{" session-1 "},
	})
	if err != nil {
		t.Fatalf("DeleteSourceSessionsBatch() error = %v", err)
	}
	if result.RemovedSessions != 1 || len(result.RemovedSessionIDs) != 1 {
		t.Fatalf("result = %#v", result)
	}
	command := store.command
	if command.WorkspaceID != "workspace-1" || len(command.SessionIDs) != 1 || command.SessionIDs[0] != "session-1" || command.ClearWorkspace {
		t.Fatalf("command scope = %#v", command)
	}
	policy := command.WorkflowCancellation
	if !equalWorkflowStatuses(policy.AllowedWorkflowStatuses, []workflowbiz.WorkflowStatus{workflowbiz.WorkflowStatusPendingReview, workflowbiz.WorkflowStatusInProgress}) ||
		!equalCheckpointStatuses(policy.AllowedCheckpointStatuses, []workflowbiz.CheckpointStatus{workflowbiz.CheckpointStatusPending}) ||
		!equalOperationStatuses(policy.AllowedOperationStatuses, []workflowbiz.OperationStatus{workflowbiz.OperationStatusPending, workflowbiz.OperationStatusRunning}) ||
		policy.WorkflowStatus != workflowbiz.WorkflowStatusCanceled || policy.CheckpointStatus != workflowbiz.CheckpointStatusCanceled || policy.OperationStatus != workflowbiz.OperationStatusCanceled ||
		policy.DecidedBy != "tutti" || policy.DecisionReason != "source_session_deleted" || !policy.ChangedAt.Equal(now) {
		t.Fatalf("cancellation policy = %#v", policy)
	}
	if store.publisherCallsDuringCommit != 0 {
		t.Fatalf("publisher calls during transaction = %d, want zero", store.publisherCallsDuringCommit)
	}
	if len(publisher.updates) != 2 || publisher.updates[0].ChangeKind != workflowbiz.ChangeKindCheckpointDecided || publisher.updates[1].ChangeKind != workflowbiz.ChangeKindOperationUpdated {
		t.Fatalf("published updates = %#v", publisher.updates)
	}
}

func TestDeleteSourceSessionsDoesNotPublishWhenAtomicCommandFails(t *testing.T) {
	t.Parallel()

	wantErr := errors.New("commit failed")
	publisher := &recordingWorkflowPublisher{}
	service := &Service{
		SourceSessionDeletions: &recordingSourceSessionDeletionStore{err: wantErr},
		Publisher:              publisher,
	}
	_, err := service.DeleteSourceSession(context.Background(), "workspace-1", "session-1")
	if !errors.Is(err, wantErr) {
		t.Fatalf("DeleteSourceSession() error = %v, want %v", err, wantErr)
	}
	if len(publisher.updates) != 0 {
		t.Fatalf("published updates = %#v, want none", publisher.updates)
	}
}

type recordingSourceSessionDeletionStore struct {
	command                    workspacedata.SourceSessionDeletionCommand
	result                     workspacedata.SourceSessionDeletionResult
	err                        error
	publishedCount             func() int
	publisherCallsDuringCommit int
}

func (store *recordingSourceSessionDeletionStore) ExecuteSourceSessionDeletion(
	_ context.Context,
	command workspacedata.SourceSessionDeletionCommand,
) (workspacedata.SourceSessionDeletionResult, error) {
	store.command = command
	if store.publishedCount != nil {
		store.publisherCallsDuringCommit = store.publishedCount()
	}
	return store.result, store.err
}

func equalWorkflowStatuses(left, right []workflowbiz.WorkflowStatus) bool {
	return equalComparable(left, right)
}

func equalCheckpointStatuses(left, right []workflowbiz.CheckpointStatus) bool {
	return equalComparable(left, right)
}

func equalOperationStatuses(left, right []workflowbiz.OperationStatus) bool {
	return equalComparable(left, right)
}

func equalComparable[T comparable](left, right []T) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
