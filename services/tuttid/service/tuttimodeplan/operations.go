package tuttimodeplan

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

func (s *Service) ensureAndExecuteDecisionOperation(
	ctx context.Context,
	workspaceID string,
	snapshot workflowbiz.Snapshot,
	checkpoint workflowbiz.WorkflowCheckpoint,
	kind workflowbiz.OperationKind,
) (*workflowbiz.WorkflowOperation, error) {
	operation, err := s.ensureDecisionOperation(ctx, workspaceID, snapshot, checkpoint, kind)
	if err != nil {
		return operation, err
	}
	return s.executeDecisionOperation(ctx, workspaceID, snapshot, checkpoint, operation)
}

func (s *Service) executeDecisionOperation(
	ctx context.Context,
	workspaceID string,
	snapshot workflowbiz.Snapshot,
	checkpoint workflowbiz.WorkflowCheckpoint,
	operation *workflowbiz.WorkflowOperation,
) (*workflowbiz.WorkflowOperation, error) {
	if operation == nil || operation.Kind != workflowbiz.OperationKindCreateIssue || s.IssueMaterializer == nil {
		return operation, nil
	}
	if operation.Status == workflowbiz.OperationStatusFailed {
		retried, _, retryErr := s.Store.RetryWorkspaceWorkflowOperation(ctx, workspacedata.RetryWorkspaceWorkflowOperationInput{
			WorkspaceID: workspaceID,
			WorkflowID:  snapshot.Workflow.ID,
			OperationID: operation.ID,
			RetriedAt:   s.now(),
		})
		if retryErr != nil {
			return operation, retryErr
		}
		operation = &retried
	}
	if operation.Status != workflowbiz.OperationStatusPending {
		return operation, nil
	}

	view, err := s.GetView(ctx, GetInput{WorkspaceID: workspaceID, WorkflowID: snapshot.Workflow.ID})
	if err != nil {
		return operation, err
	}
	if len(view.ActionableItems) == 0 {
		return operation, fmt.Errorf("%w: accepted task graph has no actionable items", ErrInvalidTransition)
	}
	current, ok := currentRevisionView(view)
	if !ok {
		return operation, fmt.Errorf("%w: current revision is unavailable", ErrInvalidTransition)
	}
	issueID, materializeErr := s.IssueMaterializer.MaterializeIssue(ctx, MaterializeIssueInput{
		WorkspaceID:     workspaceID,
		WorkflowID:      view.Workflow.ID,
		RevisionID:      current.Revision.ID,
		SourceSessionID: view.Workflow.SourceSessionID,
		Title:           current.Document.Title,
		Content:         current.Document.Body,
		TopicID:         current.Document.TopicID,
		Execution:       current.Document.Execution,
		Budget:          current.Document.Budget,
		ActionableItems: append([]ActionableItem(nil), view.ActionableItems...),
	})
	now := s.now()
	completion := workspacedata.CompleteWorkspaceWorkflowOperationInput{
		WorkspaceID:    workspaceID,
		WorkflowID:     view.Workflow.ID,
		OperationID:    operation.ID,
		ExpectedStatus: workflowbiz.OperationStatusPending,
		Status:         workflowbiz.OperationStatusSucceeded,
		IssueID:        issueID,
		CompletedAt:    now,
	}
	if materializeErr != nil {
		completion.Status = workflowbiz.OperationStatusFailed
		completion.ErrorCode = "issue_materialization_failed"
		completion.ErrorMessage = materializeErr.Error()
	}
	completed, _, completeErr := s.Store.CompleteWorkspaceWorkflowOperation(ctx, completion)
	if completeErr != nil {
		return operation, completeErr
	}
	s.publish(ctx, workflowbiz.Update{
		WorkspaceID:     workspaceID,
		WorkflowID:      view.Workflow.ID,
		SourceSessionID: view.Workflow.SourceSessionID,
		CheckpointID:    checkpoint.ID,
		ChangeKind:      workflowbiz.ChangeKindOperationUpdated,
	})
	if completed.Status == workflowbiz.OperationStatusSucceeded {
		return &completed, nil
	}
	if completed.Status == workflowbiz.OperationStatusFailed && materializeErr != nil {
		// The user decision is already committed and the downstream failure is
		// durably observable/retryable through the operation. Returning it as a
		// failed approval would misrepresent the committed decision boundary.
		return &completed, nil
	}
	return &completed, fmt.Errorf("%w: create_issue operation did not converge to success", ErrInvalidTransition)
}

func nextActionAfterOperation(next NextAction, operation *workflowbiz.WorkflowOperation) NextAction {
	if next == NextActionCreateIssue && operation != nil && operation.Status == workflowbiz.OperationStatusSucceeded && strings.TrimSpace(operation.IssueID) != "" {
		return NextActionIssueCreated
	}
	return next
}

func currentRevisionView(view SnapshotView) (RevisionView, bool) {
	for _, revision := range view.Revisions {
		if revision.Revision.ID == view.Workflow.CurrentRevisionID {
			return revision, true
		}
	}
	return RevisionView{}, false
}

func (s *Service) ensureDecisionOperation(
	ctx context.Context,
	workspaceID string,
	snapshot workflowbiz.Snapshot,
	checkpoint workflowbiz.WorkflowCheckpoint,
	kind workflowbiz.OperationKind,
) (*workflowbiz.WorkflowOperation, error) {
	if kind == "" {
		return nil, nil
	}
	if operation := findDecisionOperation(snapshot.Operations, checkpoint.RevisionID, kind); operation != nil {
		return operation, nil
	}
	operation, err := newDecisionOperation(snapshot, checkpoint, kind, s.now())
	if err != nil {
		return nil, err
	}
	if err := s.Store.RecordWorkspaceWorkflowOperation(ctx, workspaceID, *operation); err != nil {
		// New decisions create their operation atomically. This path only repairs
		// legacy/idempotent decisions that predate that invariant; concurrent
		// repairers converge by re-reading the deterministic operation.
		latest, readErr := s.Store.GetWorkspaceWorkflowSnapshot(ctx, workspaceID, snapshot.Workflow.ID)
		if readErr == nil {
			if current := findDecisionOperation(latest.Operations, checkpoint.RevisionID, kind); current != nil {
				return current, nil
			}
		}
		return nil, err
	}
	return operation, nil
}

func newDecisionOperation(
	snapshot workflowbiz.Snapshot,
	checkpoint workflowbiz.WorkflowCheckpoint,
	kind workflowbiz.OperationKind,
	now time.Time,
) (*workflowbiz.WorkflowOperation, error) {
	if kind == "" {
		return nil, nil
	}
	operation := &workflowbiz.WorkflowOperation{
		ID:         operationIDForCheckpoint(checkpoint, kind),
		WorkflowID: snapshot.Workflow.ID,
		Kind:       kind,
		Status:     workflowbiz.OperationStatusPending,
		RevisionID: checkpoint.RevisionID,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if operation.ID == "" {
		return nil, fmt.Errorf("%w: generated operation id must not be empty", ErrInvalidInput)
	}
	return operation, nil
}

func (s *Service) revisionOperationCompletion(
	ctx context.Context,
	workspaceID string,
	snapshot workflowbiz.Snapshot,
	checkpoint workflowbiz.WorkflowCheckpoint,
) (*workspacedata.AppendWorkspaceWorkflowOperationCompletion, error) {
	if checkpoint.Status == workflowbiz.CheckpointStatusPending || checkpoint.Status == workflowbiz.CheckpointStatusSuperseded {
		return nil, nil
	}
	_, _, kind, err := decisionTransition(checkpoint.Kind, checkpoint.Status)
	if err != nil {
		return nil, err
	}
	if kind != workflowbiz.OperationKindGenerateTaskGraph && kind != workflowbiz.OperationKindCreateRevision {
		return nil, nil
	}
	operation, err := s.ensureDecisionOperation(ctx, workspaceID, snapshot, checkpoint, kind)
	if err != nil {
		return nil, err
	}
	if operation == nil || operation.Status != workflowbiz.OperationStatusPending {
		return nil, fmt.Errorf("%w: revision operation is not pending", ErrInvalidTransition)
	}
	return &workspacedata.AppendWorkspaceWorkflowOperationCompletion{
		OperationID:    operation.ID,
		Kind:           operation.Kind,
		RevisionID:     operation.RevisionID,
		ExpectedStatus: workflowbiz.OperationStatusPending,
	}, nil
}

func operationIDForCheckpoint(checkpoint workflowbiz.WorkflowCheckpoint, kind workflowbiz.OperationKind) string {
	identity := strings.Join([]string{
		"tutti-mode-plan-operation",
		checkpoint.WorkflowID,
		checkpoint.ID,
		string(kind),
	}, ":")
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(identity)).String()
}

func findDecisionOperation(operations []workflowbiz.WorkflowOperation, revisionID string, kind workflowbiz.OperationKind) *workflowbiz.WorkflowOperation {
	if kind == "" {
		return nil
	}
	for index := len(operations) - 1; index >= 0; index-- {
		if operations[index].RevisionID == revisionID && operations[index].Kind == kind {
			operation := operations[index]
			return &operation
		}
	}
	return nil
}
