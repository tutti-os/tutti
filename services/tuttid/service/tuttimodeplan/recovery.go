package tuttimodeplan

import (
	"context"
	"errors"
	"fmt"
	"strings"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

// RetireConfigurationReviewWorkflows is the daemon-startup one-shot migration
// for the retired two-phase flow. Every non-terminal workflow whose current
// pending checkpoint is a legacy configuration review is canceled through the
// ordinary decision path, so events, operations, and idempotency behave like
// any user cancel. Dev-environment pending workflows are explicitly safe to
// cancel; the Agent observes NextActionCanceled through plan get/wait.
func (s *Service) RetireConfigurationReviewWorkflows(ctx context.Context) error {
	if err := s.ready(); err != nil {
		return err
	}
	items, err := s.Store.ListPendingConfigurationReviewCheckpoints(ctx)
	if err != nil {
		return err
	}
	var failures []error
	for _, item := range items {
		if _, decideErr := s.Decide(ctx, DecideInput{
			WorkspaceID:    item.WorkspaceID,
			WorkflowID:     item.WorkflowID,
			CheckpointID:   item.CheckpointID,
			Decision:       workflowbiz.CheckpointStatusCanceled,
			DecidedBy:      "tutti",
			DecisionReason: "configuration review retired by the single-review flow",
		}); decideErr != nil {
			failures = append(failures, fmt.Errorf("retire configuration review %s/%s: %w", item.WorkflowID, item.CheckpointID, decideErr))
		}
	}
	return errors.Join(failures...)
}

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
