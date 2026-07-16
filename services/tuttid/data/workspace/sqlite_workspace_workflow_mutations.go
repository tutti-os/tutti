package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
)

type workflowMutationSQL interface {
	workflowSQLExecutor
	workflowSQLQueryer
}

func (s *SQLiteStore) GetWorkspaceWorkflowMutation(
	ctx context.Context,
	input GetWorkspaceWorkflowMutationInput,
) (workflowbiz.WorkflowMutation, bool, error) {
	if s == nil || s.writeDB == nil {
		return workflowbiz.WorkflowMutation{}, false, errors.New("workspace database is not initialized")
	}
	if err := normalizeWorkflowMutationLookup(&input); err != nil {
		return workflowbiz.WorkflowMutation{}, false, err
	}
	return getWorkspaceWorkflowMutation(ctx, s.writeDB, input)
}

func claimWorkspaceWorkflowMutation(
	ctx context.Context,
	db workflowMutationSQL,
	mutation workflowbiz.WorkflowMutation,
) (workflowbiz.WorkflowMutation, bool, error) {
	normalized, err := workflowbiz.NormalizeMutation(mutation)
	if err != nil {
		return workflowbiz.WorkflowMutation{}, false, err
	}
	result, err := db.ExecContext(ctx, `
INSERT INTO workspace_workflow_mutations (
  workspace_id, source_session_id, mutation_kind, workflow_scope_id,
  request_id, input_sha256, workflow_id, revision_id, checkpoint_id,
  created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (workspace_id, source_session_id, mutation_kind, workflow_scope_id, request_id)
DO NOTHING
`, normalized.WorkspaceID, normalized.SourceSessionID, normalized.Kind, normalized.ScopeID,
		normalized.RequestID, normalized.InputSHA256, normalized.WorkflowID, normalized.RevisionID,
		normalized.CheckpointID, unixMs(normalized.CreatedAt))
	if err != nil {
		return workflowbiz.WorkflowMutation{}, false, fmt.Errorf("claim workspace workflow mutation: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return workflowbiz.WorkflowMutation{}, false, fmt.Errorf("read workflow mutation claim rows affected: %w", err)
	}
	if changed == 1 {
		return normalized, true, nil
	}
	existing, found, err := getWorkspaceWorkflowMutation(ctx, db, GetWorkspaceWorkflowMutationInput{
		WorkspaceID:     normalized.WorkspaceID,
		SourceSessionID: normalized.SourceSessionID,
		Kind:            normalized.Kind,
		ScopeID:         normalized.ScopeID,
		RequestID:       normalized.RequestID,
	})
	if err != nil {
		return workflowbiz.WorkflowMutation{}, false, err
	}
	if !found {
		return workflowbiz.WorkflowMutation{}, false, fmt.Errorf("read claimed workspace workflow mutation: %w", sql.ErrNoRows)
	}
	if existing.InputSHA256 != normalized.InputSHA256 {
		return existing, false, ErrWorkflowMutationConflict
	}
	return existing, false, nil
}

func getWorkspaceWorkflowMutation(
	ctx context.Context,
	db workflowSQLQueryer,
	input GetWorkspaceWorkflowMutationInput,
) (workflowbiz.WorkflowMutation, bool, error) {
	row := db.QueryRowContext(ctx, `
SELECT input_sha256, workflow_id, revision_id, checkpoint_id, created_at_unix_ms
FROM workspace_workflow_mutations
WHERE workspace_id = ? AND source_session_id = ? AND mutation_kind = ?
  AND workflow_scope_id = ? AND request_id = ?
`, input.WorkspaceID, input.SourceSessionID, input.Kind, input.ScopeID, input.RequestID)
	mutation := workflowbiz.WorkflowMutation{
		WorkspaceID:     input.WorkspaceID,
		SourceSessionID: input.SourceSessionID,
		Kind:            input.Kind,
		ScopeID:         input.ScopeID,
		RequestID:       input.RequestID,
	}
	var createdAt int64
	if err := row.Scan(&mutation.InputSHA256, &mutation.WorkflowID, &mutation.RevisionID, &mutation.CheckpointID, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workflowbiz.WorkflowMutation{}, false, nil
		}
		return workflowbiz.WorkflowMutation{}, false, fmt.Errorf("get workspace workflow mutation: %w", err)
	}
	mutation.CreatedAt = time.UnixMilli(createdAt).UTC()
	return mutation, true, nil
}

func normalizeWorkflowMutationLookup(input *GetWorkspaceWorkflowMutationInput) error {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.SourceSessionID = strings.TrimSpace(input.SourceSessionID)
	input.ScopeID = strings.TrimSpace(input.ScopeID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	if input.WorkspaceID == "" || input.SourceSessionID == "" || input.RequestID == "" || !workflowbiz.IsMutationKind(input.Kind) {
		return errors.New("workspace, source session, mutation kind, and request id are required")
	}
	if input.Kind == workflowbiz.MutationKindPropose && input.ScopeID != "" {
		return errors.New("propose mutation scope must be empty")
	}
	if input.Kind == workflowbiz.MutationKindRevise && input.ScopeID == "" {
		return errors.New("revise mutation scope is required")
	}
	return nil
}
