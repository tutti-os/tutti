package tuttimodeplan

import (
	"context"
	"fmt"
	"strings"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

// RecoverCreateIssueOperations performs the daemon-startup one-shot recovery
// for accepted task graphs whose deterministic create_issue operation did not
// finish before the prior process exited. It intentionally does not start a
// background worker; successful operations disappear from the next scan.
func (s *Service) RecoverCreateIssueOperations(ctx context.Context) error {
	if err := s.ready(); err != nil {
		return err
	}
	operations, err := s.Store.ListRecoverableCreateIssueOperations(ctx)
	if err != nil {
		return err
	}
	for _, item := range operations {
		if recoverErr := s.recoverCreateIssueOperation(ctx, item); recoverErr != nil {
			if durableErr := s.recordCreateIssueRecoveryFailure(ctx, item, recoverErr); durableErr != nil {
				return fmt.Errorf("record create_issue recovery failure for %q: %w", item.Operation.ID, durableErr)
			}
		}
	}
	return nil
}

func (s *Service) recoverCreateIssueOperation(ctx context.Context, item workspacedata.RecoverableCreateIssueOperation) error {
	snapshot, err := s.Get(ctx, GetInput{
		WorkspaceID: item.WorkspaceID,
		WorkflowID:  item.Operation.WorkflowID,
	})
	if err != nil {
		return err
	}
	if strings.TrimSpace(snapshot.Workflow.SourceSessionID) != strings.TrimSpace(item.SourceSessionID) ||
		snapshot.Workflow.Status != workflowbiz.WorkflowStatusAccepted ||
		snapshot.Workflow.CurrentRevisionID != item.Operation.RevisionID ||
		item.Checkpoint.Status != workflowbiz.CheckpointStatusAccepted ||
		item.Checkpoint.Kind != workflowbiz.CheckpointKindTaskReview ||
		item.Checkpoint.RevisionID != item.Operation.RevisionID ||
		item.Operation.Kind != workflowbiz.OperationKindCreateIssue {
		return fmt.Errorf("%w: invalid recoverable create_issue operation %q", ErrInvalidTransition, item.Operation.ID)
	}
	operation := item.Operation
	_, err = s.executeDecisionOperation(ctx, item.WorkspaceID, snapshot, item.Checkpoint, &operation)
	return err
}

func (s *Service) recordCreateIssueRecoveryFailure(
	ctx context.Context,
	item workspacedata.RecoverableCreateIssueOperation,
	recoveryErr error,
) error {
	expectedStatuses := []workflowbiz.OperationStatus{item.Operation.Status}
	if item.Operation.Status != workflowbiz.OperationStatusPending {
		expectedStatuses = append(expectedStatuses, workflowbiz.OperationStatusPending)
	}
	for _, expectedStatus := range expectedStatuses {
		completed, _, err := s.Store.CompleteWorkspaceWorkflowOperation(ctx, workspacedata.CompleteWorkspaceWorkflowOperationInput{
			WorkspaceID:    item.WorkspaceID,
			WorkflowID:     item.Operation.WorkflowID,
			OperationID:    item.Operation.ID,
			ExpectedStatus: expectedStatus,
			Status:         workflowbiz.OperationStatusFailed,
			ErrorCode:      "startup_recovery_failed",
			ErrorMessage:   recoveryErr.Error(),
			CompletedAt:    s.now(),
		})
		if err != nil {
			return err
		}
		if completed.Status == workflowbiz.OperationStatusSucceeded {
			return nil
		}
		if completed.Status == workflowbiz.OperationStatusFailed {
			s.publish(ctx, workflowbiz.Update{
				WorkspaceID: item.WorkspaceID, WorkflowID: item.Operation.WorkflowID,
				SourceSessionID: item.SourceSessionID, CheckpointID: item.Checkpoint.ID,
				ChangeKind: workflowbiz.ChangeKindOperationUpdated,
			})
			return nil
		}
	}
	return fmt.Errorf("%w: create_issue recovery outcome could not be made durable", ErrInvalidTransition)
}
