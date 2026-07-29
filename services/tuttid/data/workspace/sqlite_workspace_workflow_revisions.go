package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
)

// AppendWorkspaceWorkflowPlanRevision commits a new immutable revision only
// while the source session, current revision, workflow status, and checkpoint
// still match the service snapshot that authorized the transition.
func (s *SQLiteStore) AppendWorkspaceWorkflowPlanRevision(ctx context.Context, input AppendWorkspaceWorkflowPlanRevisionInput) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	revision, checkpoint, err := normalizeWorkflowRevisionAppend(&input)
	if err != nil {
		return err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin append workspace workflow plan revision: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := appendWorkspaceWorkflowPlanRevision(ctx, tx, input, revision, checkpoint); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit append workspace workflow plan revision: %w", err)
	}
	return nil
}

func (s *SQLiteStore) AppendWorkspaceWorkflowPlanRevisionWithMutation(
	ctx context.Context,
	input AppendWorkspaceWorkflowPlanRevisionMutationInput,
) (workflowbiz.WorkflowMutation, bool, error) {
	if s == nil || s.writeDB == nil {
		return workflowbiz.WorkflowMutation{}, false, errors.New("workspace database is not initialized")
	}
	appendInput := input.Append
	revision, checkpoint, err := normalizeWorkflowRevisionAppend(&appendInput)
	if err != nil {
		return workflowbiz.WorkflowMutation{}, false, err
	}
	mutation, err := workflowbiz.NormalizeMutation(input.Mutation)
	if err != nil {
		return workflowbiz.WorkflowMutation{}, false, err
	}
	if mutation.Kind != workflowbiz.MutationKindRevise || mutation.WorkspaceID != appendInput.WorkspaceID ||
		mutation.SourceSessionID != appendInput.ExpectedSourceSessionID || mutation.ScopeID != appendInput.WorkflowID ||
		mutation.WorkflowID != appendInput.WorkflowID || mutation.RevisionID != revision.ID ||
		mutation.CheckpointID != checkpoint.ID {
		return workflowbiz.WorkflowMutation{}, false, fmt.Errorf("%w: revision mutation must bind its append", workflowbiz.ErrInvalidWorkflow)
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return workflowbiz.WorkflowMutation{}, false, fmt.Errorf("begin append workspace workflow plan revision mutation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	claimed, created, err := claimWorkspaceWorkflowMutation(ctx, tx, mutation)
	if err != nil || !created {
		return claimed, false, err
	}
	if err := appendWorkspaceWorkflowPlanRevision(ctx, tx, appendInput, revision, checkpoint); err != nil {
		return workflowbiz.WorkflowMutation{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return workflowbiz.WorkflowMutation{}, false, fmt.Errorf("commit append workspace workflow plan revision mutation: %w", err)
	}
	return claimed, true, nil
}

func appendWorkspaceWorkflowPlanRevision(
	ctx context.Context,
	tx *sql.Tx,
	input AppendWorkspaceWorkflowPlanRevisionInput,
	revision workflowbiz.PlanRevision,
	checkpoint workflowbiz.WorkflowCheckpoint,
) error {

	if err := authorizeWorkflowRevisionAppend(ctx, tx, input); err != nil {
		return err
	}
	if err := verifyWorkflowRevisionIdentity(ctx, tx, input, revision); err != nil {
		return err
	}
	if err := insertWorkflowPlanRevision(ctx, tx, input.WorkspaceID, revision); err != nil {
		return err
	}
	if err := insertWorkflowCheckpoint(ctx, tx, input.WorkspaceID, checkpoint); err != nil {
		return err
	}
	for _, link := range input.TurnLinks {
		if err := insertWorkflowTurnLink(ctx, tx, input.WorkspaceID, link); err != nil {
			return err
		}
	}
	if err := compareAndAdvanceWorkflowRevision(ctx, tx, input, revision.ID); err != nil {
		return err
	}
	if err := supersedeExpectedPendingCheckpoint(ctx, tx, input); err != nil {
		return err
	}
	return completeExpectedRevisionOperation(ctx, tx, input)
}

func normalizeWorkflowRevisionAppend(input *AppendWorkspaceWorkflowPlanRevisionInput) (workflowbiz.PlanRevision, workflowbiz.WorkflowCheckpoint, error) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.WorkflowID = strings.TrimSpace(input.WorkflowID)
	input.ExpectedSourceSessionID = strings.TrimSpace(input.ExpectedSourceSessionID)
	input.ExpectedCurrentRevisionID = strings.TrimSpace(input.ExpectedCurrentRevisionID)
	input.ExpectedCheckpointID = strings.TrimSpace(input.ExpectedCheckpointID)
	if input.WorkspaceID == "" || input.WorkflowID == "" || input.ExpectedSourceSessionID == "" ||
		input.ExpectedCurrentRevisionID == "" || input.ExpectedCheckpointID == "" || input.UpdatedAt.IsZero() {
		return workflowbiz.PlanRevision{}, workflowbiz.WorkflowCheckpoint{}, errors.New("workspace, workflow, expected source/current checkpoint state, and updated at are required")
	}
	if !workflowbiz.IsWorkflowStatus(input.ExpectedWorkflowStatus) || !workflowbiz.IsCheckpointStatus(input.ExpectedCheckpointStatus) {
		return workflowbiz.PlanRevision{}, workflowbiz.WorkflowCheckpoint{}, fmt.Errorf("%w: invalid workflow revision expectations", workflowbiz.ErrInvalidWorkflow)
	}
	revision, err := workflowbiz.NormalizePlanRevision(input.Revision)
	if err != nil {
		return workflowbiz.PlanRevision{}, workflowbiz.WorkflowCheckpoint{}, err
	}
	checkpoint, err := workflowbiz.NormalizeCheckpoint(input.Checkpoint)
	if err != nil {
		return workflowbiz.PlanRevision{}, workflowbiz.WorkflowCheckpoint{}, err
	}
	if revision.WorkflowID != input.WorkflowID || checkpoint.WorkflowID != input.WorkflowID || checkpoint.RevisionID != revision.ID || checkpoint.Status != workflowbiz.CheckpointStatusPending {
		return workflowbiz.PlanRevision{}, workflowbiz.WorkflowCheckpoint{}, fmt.Errorf("%w: appended checkpoint must bind the appended revision", workflowbiz.ErrInvalidWorkflow)
	}
	for index, link := range input.TurnLinks {
		normalized, normalizeErr := workflowbiz.NormalizeTurnLink(link)
		if normalizeErr != nil {
			return workflowbiz.PlanRevision{}, workflowbiz.WorkflowCheckpoint{}, normalizeErr
		}
		if normalized.WorkflowID != input.WorkflowID {
			return workflowbiz.PlanRevision{}, workflowbiz.WorkflowCheckpoint{}, fmt.Errorf("%w: turn link workflow id must match workflow", workflowbiz.ErrInvalidWorkflow)
		}
		input.TurnLinks[index] = normalized
	}
	if completion := input.CompleteOperation; completion != nil {
		completion.OperationID = strings.TrimSpace(completion.OperationID)
		completion.RevisionID = strings.TrimSpace(completion.RevisionID)
		if completion.OperationID == "" || completion.RevisionID != input.ExpectedCurrentRevisionID ||
			!isRevisionProducingOperation(completion.Kind) || completion.ExpectedStatus != workflowbiz.OperationStatusPending {
			return workflowbiz.PlanRevision{}, workflowbiz.WorkflowCheckpoint{}, fmt.Errorf("%w: invalid prior operation completion", workflowbiz.ErrInvalidWorkflow)
		}
	}
	input.UpdatedAt = input.UpdatedAt.UTC()
	return revision, checkpoint, nil
}

func isRevisionProducingOperation(kind workflowbiz.OperationKind) bool {
	return kind == workflowbiz.OperationKindGenerateTaskGraph || kind == workflowbiz.OperationKindCreateRevision
}

func authorizeWorkflowRevisionAppend(ctx context.Context, tx *sql.Tx, input AppendWorkspaceWorkflowPlanRevisionInput) error {
	var sourceSessionID string
	err := tx.QueryRowContext(ctx, `
SELECT source_session_id FROM workspace_workflows
WHERE workspace_id = ? AND workflow_id = ?
`, input.WorkspaceID, input.WorkflowID).Scan(&sourceSessionID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && sourceSessionID != input.ExpectedSourceSessionID) {
		return ErrWorkspaceWorkflowNotFound
	}
	if err != nil {
		return fmt.Errorf("read workspace workflow source before append: %w", err)
	}
	return nil
}

func verifyWorkflowRevisionIdentity(ctx context.Context, tx *sql.Tx, input AppendWorkspaceWorkflowPlanRevisionInput, revision workflowbiz.PlanRevision) error {
	var nextSequence int
	if err := tx.QueryRowContext(ctx, `
SELECT COALESCE(MAX(revision_sequence), 0) + 1
FROM workspace_workflow_plan_revisions
WHERE workspace_id = ? AND workflow_id = ?
`, input.WorkspaceID, input.WorkflowID).Scan(&nextSequence); err != nil {
		return fmt.Errorf("read next workspace workflow revision sequence: %w", err)
	}
	if revision.Sequence != nextSequence {
		return ErrWorkflowRevisionConflict
	}
	var duplicate int
	if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*) FROM workspace_workflow_plan_revisions
WHERE workspace_id = ? AND workflow_id = ? AND revision_id = ?
`, input.WorkspaceID, input.WorkflowID, revision.ID).Scan(&duplicate); err != nil {
		return fmt.Errorf("check workspace workflow revision conflict: %w", err)
	}
	if duplicate != 0 {
		return ErrWorkflowRevisionConflict
	}
	return nil
}

func compareAndAdvanceWorkflowRevision(ctx context.Context, tx *sql.Tx, input AppendWorkspaceWorkflowPlanRevisionInput, revisionID string) error {
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_workflows
SET current_revision_id = ?, status = 'pending_review', updated_at_unix_ms = ?
WHERE workspace_id = ? AND workflow_id = ? AND source_session_id = ?
  AND current_revision_id = ? AND status = ?
  AND EXISTS (
    SELECT 1 FROM workspace_workflow_checkpoints
    WHERE workspace_id = ? AND workflow_id = ? AND checkpoint_id = ?
      AND revision_id = ? AND status = ?
  )
`, revisionID, unixMs(input.UpdatedAt), input.WorkspaceID, input.WorkflowID, input.ExpectedSourceSessionID,
		input.ExpectedCurrentRevisionID, input.ExpectedWorkflowStatus,
		input.WorkspaceID, input.WorkflowID, input.ExpectedCheckpointID,
		input.ExpectedCurrentRevisionID, input.ExpectedCheckpointStatus)
	if err != nil {
		return fmt.Errorf("advance workspace workflow current revision: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read workspace workflow append rows affected: %w", err)
	}
	if changed == 0 {
		return ErrWorkflowRevisionConflict
	}
	return nil
}

func supersedeExpectedPendingCheckpoint(ctx context.Context, tx *sql.Tx, input AppendWorkspaceWorkflowPlanRevisionInput) error {
	if input.ExpectedCheckpointStatus != workflowbiz.CheckpointStatusPending {
		return nil
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_workflow_checkpoints
SET status = 'superseded', updated_at_unix_ms = ?, decided_at_unix_ms = ?
WHERE workspace_id = ? AND workflow_id = ? AND checkpoint_id = ?
  AND revision_id = ? AND status = 'pending'
`, unixMs(input.UpdatedAt), unixMs(input.UpdatedAt), input.WorkspaceID, input.WorkflowID,
		input.ExpectedCheckpointID, input.ExpectedCurrentRevisionID)
	if err != nil {
		return fmt.Errorf("supersede expected workspace workflow checkpoint: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read superseded checkpoint rows affected: %w", err)
	}
	if changed != 1 {
		return ErrWorkflowRevisionConflict
	}
	return nil
}

func completeExpectedRevisionOperation(ctx context.Context, tx *sql.Tx, input AppendWorkspaceWorkflowPlanRevisionInput) error {
	completion := input.CompleteOperation
	if completion == nil {
		return nil
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_workflow_operations
SET status = 'succeeded', error_code = '', error_message = '',
    updated_at_unix_ms = ?, completed_at_unix_ms = ?
WHERE workspace_id = ? AND workflow_id = ? AND operation_id = ?
  AND kind = ? AND revision_id = ? AND status = ?
`, unixMs(input.UpdatedAt), unixMs(input.UpdatedAt), input.WorkspaceID, input.WorkflowID,
		completion.OperationID, completion.Kind, completion.RevisionID, completion.ExpectedStatus)
	if err != nil {
		return fmt.Errorf("complete workspace workflow revision operation: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read revision operation completion rows affected: %w", err)
	}
	if changed != 1 {
		return ErrWorkflowRevisionConflict
	}
	return nil
}
