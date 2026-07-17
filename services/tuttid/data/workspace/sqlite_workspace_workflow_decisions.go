package workspace

import (
	"context"
	"errors"
	"fmt"
	"strings"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
)

// DecideWorkspaceWorkflowCheckpoint persists the user decision, resulting
// workflow status, and deterministic follow-up operation in one transaction.
func (s *SQLiteStore) DecideWorkspaceWorkflowCheckpoint(
	ctx context.Context,
	input DecideWorkspaceWorkflowCheckpointInput,
) (workflowbiz.WorkflowCheckpoint, bool, error) {
	if s == nil || s.writeDB == nil {
		return workflowbiz.WorkflowCheckpoint{}, false, errors.New("workspace database is not initialized")
	}
	operation, err := normalizeWorkflowDecision(&input)
	if err != nil {
		return workflowbiz.WorkflowCheckpoint{}, false, err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return workflowbiz.WorkflowCheckpoint{}, false, fmt.Errorf("begin decide workspace workflow checkpoint: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	encodedAssignments, err := encodeWorkflowTaskAssignments(input.TaskAssignments)
	if err != nil {
		return workflowbiz.WorkflowCheckpoint{}, false, err
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_workflow_checkpoints
SET status = ?, decided_by = ?, decision_reason = ?, task_assignments = ?, updated_at_unix_ms = ?, decided_at_unix_ms = ?
WHERE workspace_id = ? AND workflow_id = ? AND checkpoint_id = ?
  AND revision_id = ? AND status = ?
  AND EXISTS (
    SELECT 1 FROM workspace_workflows
    WHERE workspace_id = ? AND workflow_id = ?
      AND current_revision_id = ? AND status = ?
  )
`, input.Decision, input.DecidedBy, input.DecisionReason, encodedAssignments, unixMs(input.DecidedAt), unixMs(input.DecidedAt),
		input.WorkspaceID, input.WorkflowID, input.CheckpointID, input.ExpectedCurrentRevisionID, input.ExpectedStatus,
		input.WorkspaceID, input.WorkflowID, input.ExpectedCurrentRevisionID, input.ExpectedWorkflowStatus)
	if err != nil {
		return workflowbiz.WorkflowCheckpoint{}, false, fmt.Errorf("decide workspace workflow checkpoint: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return workflowbiz.WorkflowCheckpoint{}, false, fmt.Errorf("read checkpoint decision rows affected: %w", err)
	}
	checkpoint, err := getWorkflowCheckpoint(ctx, tx, input.WorkspaceID, input.WorkflowID, input.CheckpointID)
	if err != nil {
		return workflowbiz.WorkflowCheckpoint{}, false, err
	}
	if changed == 0 {
		return checkpoint, false, nil
	}
	if err := updateWorkflowAfterDecision(ctx, tx, input); err != nil {
		return workflowbiz.WorkflowCheckpoint{}, false, err
	}
	if operation != nil {
		if err := insertWorkflowOperation(ctx, tx, input.WorkspaceID, *operation); err != nil {
			return workflowbiz.WorkflowCheckpoint{}, false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return workflowbiz.WorkflowCheckpoint{}, false, fmt.Errorf("commit workspace workflow checkpoint decision: %w", err)
	}
	return checkpoint, true, nil
}

func normalizeWorkflowDecision(input *DecideWorkspaceWorkflowCheckpointInput) (*workflowbiz.WorkflowOperation, error) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.WorkflowID = strings.TrimSpace(input.WorkflowID)
	input.CheckpointID = strings.TrimSpace(input.CheckpointID)
	input.ExpectedCurrentRevisionID = strings.TrimSpace(input.ExpectedCurrentRevisionID)
	input.DecidedBy = strings.TrimSpace(input.DecidedBy)
	input.DecisionReason = strings.TrimSpace(input.DecisionReason)
	if input.WorkspaceID == "" || input.WorkflowID == "" || input.CheckpointID == "" ||
		input.ExpectedCurrentRevisionID == "" || input.DecidedAt.IsZero() {
		return nil, errors.New("workspace, workflow, checkpoint, expected revision, and decision time are required")
	}
	if !workflowbiz.IsCheckpointStatus(input.ExpectedStatus) || !workflowbiz.IsCheckpointDecision(input.Decision) ||
		!workflowbiz.IsWorkflowStatus(input.ExpectedWorkflowStatus) || !workflowbiz.IsWorkflowStatus(input.WorkflowStatus) {
		return nil, fmt.Errorf("%w: invalid checkpoint compare-and-set transition", workflowbiz.ErrInvalidWorkflow)
	}
	input.DecidedAt = input.DecidedAt.UTC()
	if input.Operation == nil {
		return nil, nil
	}
	operation, err := workflowbiz.NormalizeOperation(*input.Operation)
	if err != nil {
		return nil, err
	}
	if operation.WorkflowID != input.WorkflowID || operation.RevisionID != input.ExpectedCurrentRevisionID || operation.Status != workflowbiz.OperationStatusPending {
		return nil, fmt.Errorf("%w: decision operation must bind the expected current revision", workflowbiz.ErrInvalidWorkflow)
	}
	input.Operation = &operation
	return &operation, nil
}

func updateWorkflowAfterDecision(ctx context.Context, tx workflowSQLExecutor, input DecideWorkspaceWorkflowCheckpointInput) error {
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_workflows SET status = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND workflow_id = ?
  AND current_revision_id = ? AND status = ?
`, input.WorkflowStatus, unixMs(input.DecidedAt), input.WorkspaceID, input.WorkflowID,
		input.ExpectedCurrentRevisionID, input.ExpectedWorkflowStatus)
	if err != nil {
		return fmt.Errorf("update workflow after checkpoint decision: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read workflow decision rows affected: %w", err)
	}
	if changed != 1 {
		return ErrWorkflowRevisionConflict
	}
	return nil
}
