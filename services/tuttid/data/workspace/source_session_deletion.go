package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
)

// SourceSessionDeletionCommand is an explicit transaction command. The
// calling service owns every lifecycle decision; this data-layer command only
// applies the supplied state transitions together with session-owned cleanup.
type SourceSessionDeletionCommand struct {
	WorkspaceID          string
	SessionIDs           []string
	ClearWorkspace       bool
	WorkflowCancellation WorkspaceWorkflowCancellationCommand
}

type WorkspaceWorkflowCancellationCommand struct {
	AllowedWorkflowStatuses   []workflowbiz.WorkflowStatus
	AllowedCheckpointStatuses []workflowbiz.CheckpointStatus
	AllowedOperationStatuses  []workflowbiz.OperationStatus
	WorkflowStatus            workflowbiz.WorkflowStatus
	CheckpointStatus          workflowbiz.CheckpointStatus
	OperationStatus           workflowbiz.OperationStatus
	DecidedBy                 string
	DecisionReason            string
	ChangedAt                 time.Time
}

type SourceSessionWorkflowUpdate struct {
	WorkspaceID       string
	WorkflowID        string
	SourceSessionID   string
	CheckpointID      string
	CheckpointChanged bool
	OperationChanged  bool
}

type SourceSessionDeletionResult struct {
	RemovedMessages   int
	RemovedSessions   int
	RemovedSessionIDs []string
	WorkflowUpdates   []SourceSessionWorkflowUpdate
}

type sourceSessionWorkflowCandidate struct {
	workflowID      string
	sourceSessionID string
	checkpointID    string
}

var _ interface {
	ExecuteSourceSessionDeletion(context.Context, SourceSessionDeletionCommand) (SourceSessionDeletionResult, error)
} = (*SQLiteStore)(nil)

// ExecuteSourceSessionDeletion is the single atomic persistence boundary for
// deleting agent sessions, their Tutti mode activation state, and transitions
// authorized by the Tutti mode plan service.
func (s *SQLiteStore) ExecuteSourceSessionDeletion(
	ctx context.Context,
	command SourceSessionDeletionCommand,
) (SourceSessionDeletionResult, error) {
	if s == nil || s.writeDB == nil {
		return SourceSessionDeletionResult{}, errors.New("workspace database is not initialized")
	}
	command, err := normalizeSourceSessionDeletionCommand(command)
	if err != nil {
		return SourceSessionDeletionResult{}, err
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return SourceSessionDeletionResult{}, fmt.Errorf("begin source session deletion: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var deletion agentactivitybiz.DeleteSessionsBatchResult
	var workflowSessionIDs []string
	if command.ClearWorkspace {
		cleared, clearErr := s.agentStore().ClearSessionsTx(ctx, tx, command.WorkspaceID)
		if clearErr != nil {
			return SourceSessionDeletionResult{}, clearErr
		}
		deletion = agentactivitybiz.DeleteSessionsBatchResult(cleared)
		if err := deleteTuttiModeWorkspaceSessionStateTx(ctx, tx, command.WorkspaceID); err != nil {
			return SourceSessionDeletionResult{}, err
		}
	} else {
		deleted, deleteErr := s.agentStore().DeleteSessionsBatchTx(ctx, tx, agentactivitybiz.DeleteSessionsBatchInput{
			WorkspaceID: command.WorkspaceID,
			SessionIDs:  command.SessionIDs,
		})
		if deleteErr != nil {
			return SourceSessionDeletionResult{}, deleteErr
		}
		deletion = deleted
		workflowSessionIDs = normalizedSourceSessionIDs(append(append([]string{}, command.SessionIDs...), deleted.RemovedSessionIDs...))
		if err := deleteTuttiModeSessionStatesTx(ctx, tx, command.WorkspaceID, workflowSessionIDs); err != nil {
			return SourceSessionDeletionResult{}, err
		}
	}

	updates, err := executeAuthorizedWorkflowCancellationTx(
		ctx,
		tx,
		command.WorkspaceID,
		workflowSessionIDs,
		command.WorkflowCancellation,
	)
	if err != nil {
		return SourceSessionDeletionResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return SourceSessionDeletionResult{}, fmt.Errorf("commit source session deletion: %w", err)
	}
	return SourceSessionDeletionResult{
		RemovedMessages:   deletion.RemovedMessages,
		RemovedSessions:   deletion.RemovedSessions,
		RemovedSessionIDs: deletion.RemovedSessionIDs,
		WorkflowUpdates:   updates,
	}, nil
}

func executeAuthorizedWorkflowCancellationTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	sessionIDs []string,
	command WorkspaceWorkflowCancellationCommand,
) ([]SourceSessionWorkflowUpdate, error) {
	candidates, err := listSourceSessionWorkflowCandidatesTx(
		ctx,
		tx,
		workspaceID,
		sessionIDs,
		command.AllowedWorkflowStatuses,
	)
	if err != nil || len(candidates) == 0 {
		return nil, err
	}
	workflowIDs := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		workflowIDs = append(workflowIDs, candidate.workflowID)
	}
	checkpointChanges, err := listWorkflowIDsWithCheckpointStatusesTx(
		ctx,
		tx,
		workspaceID,
		workflowIDs,
		command.AllowedCheckpointStatuses,
	)
	if err != nil {
		return nil, err
	}
	operationChanges, err := listWorkflowIDsWithOperationStatusesTx(
		ctx,
		tx,
		workspaceID,
		workflowIDs,
		command.AllowedOperationStatuses,
	)
	if err != nil {
		return nil, err
	}

	changedAt := unixMs(command.ChangedAt)
	workflowPlaceholders := sourceSessionSQLPlaceholders(len(workflowIDs))
	checkpointStatusPlaceholders := sourceSessionSQLPlaceholders(len(command.AllowedCheckpointStatuses))
	checkpointArgs := []any{
		string(command.CheckpointStatus),
		command.DecidedBy,
		command.DecisionReason,
		changedAt,
		changedAt,
		workspaceID,
	}
	checkpointArgs = appendSourceSessionStrings(checkpointArgs, workflowIDs)
	checkpointArgs = appendCheckpointStatuses(checkpointArgs, command.AllowedCheckpointStatuses)
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_workflow_checkpoints
SET status = ?, decided_by = ?, decision_reason = ?,
    updated_at_unix_ms = ?, decided_at_unix_ms = ?
WHERE workspace_id = ?
  AND workflow_id IN (`+workflowPlaceholders+`)
  AND status IN (`+checkpointStatusPlaceholders+`)
`, checkpointArgs...); err != nil {
		return nil, fmt.Errorf("apply authorized workflow checkpoint cancellation: %w", err)
	}

	operationStatusPlaceholders := sourceSessionSQLPlaceholders(len(command.AllowedOperationStatuses))
	operationArgs := []any{string(command.OperationStatus), changedAt, changedAt, workspaceID}
	operationArgs = appendSourceSessionStrings(operationArgs, workflowIDs)
	operationArgs = appendOperationStatuses(operationArgs, command.AllowedOperationStatuses)
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_workflow_operations
SET status = ?, updated_at_unix_ms = ?, completed_at_unix_ms = ?
WHERE workspace_id = ?
  AND workflow_id IN (`+workflowPlaceholders+`)
  AND status IN (`+operationStatusPlaceholders+`)
`, operationArgs...); err != nil {
		return nil, fmt.Errorf("apply authorized workflow operation cancellation: %w", err)
	}

	workflowArgs := []any{string(command.WorkflowStatus), changedAt, workspaceID}
	workflowArgs = appendSourceSessionStrings(workflowArgs, workflowIDs)
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_workflows
SET status = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND workflow_id IN (`+workflowPlaceholders+`)
`, workflowArgs...); err != nil {
		return nil, fmt.Errorf("apply authorized workflow cancellation: %w", err)
	}

	updates := make([]SourceSessionWorkflowUpdate, 0, len(candidates))
	for _, candidate := range candidates {
		updates = append(updates, SourceSessionWorkflowUpdate{
			WorkspaceID:       workspaceID,
			WorkflowID:        candidate.workflowID,
			SourceSessionID:   candidate.sourceSessionID,
			CheckpointID:      candidate.checkpointID,
			CheckpointChanged: checkpointChanges[candidate.workflowID],
			OperationChanged:  operationChanges[candidate.workflowID],
		})
	}
	return updates, nil
}

func listSourceSessionWorkflowCandidatesTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	sessionIDs []string,
	statuses []workflowbiz.WorkflowStatus,
) ([]sourceSessionWorkflowCandidate, error) {
	args := []any{workspaceID}
	args = appendWorkflowStatuses(args, statuses)
	sessionFilter := ""
	if sessionIDs != nil {
		sessionFilter = " AND w.source_session_id IN (" + sourceSessionSQLPlaceholders(len(sessionIDs)) + ")"
		args = appendSourceSessionStrings(args, sessionIDs)
	}
	rows, err := tx.QueryContext(ctx, `
SELECT w.workflow_id, w.source_session_id,
       COALESCE((
         SELECT c.checkpoint_id
         FROM workspace_workflow_checkpoints c
         WHERE c.workspace_id = w.workspace_id
           AND c.workflow_id = w.workflow_id
           AND c.revision_id = w.current_revision_id
         ORDER BY c.created_at_unix_ms DESC, c.checkpoint_id ASC
         LIMIT 1
       ), '')
FROM workspace_workflows w
WHERE w.workspace_id = ?
  AND w.status IN (`+sourceSessionSQLPlaceholders(len(statuses))+`)`+sessionFilter+`
ORDER BY w.workflow_id ASC
`, args...)
	if err != nil {
		return nil, fmt.Errorf("list workflows for authorized source session deletion: %w", err)
	}
	defer rows.Close()

	candidates := make([]sourceSessionWorkflowCandidate, 0)
	for rows.Next() {
		var candidate sourceSessionWorkflowCandidate
		if err := rows.Scan(&candidate.workflowID, &candidate.sourceSessionID, &candidate.checkpointID); err != nil {
			return nil, fmt.Errorf("scan workflow for authorized source session deletion: %w", err)
		}
		candidate.workflowID = strings.TrimSpace(candidate.workflowID)
		candidate.sourceSessionID = strings.TrimSpace(candidate.sourceSessionID)
		candidate.checkpointID = strings.TrimSpace(candidate.checkpointID)
		if candidate.workflowID == "" || candidate.sourceSessionID == "" || candidate.checkpointID == "" {
			return nil, errors.New("authorized source session deletion found workflow without canonical identity")
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workflows for authorized source session deletion: %w", err)
	}
	return candidates, nil
}

func listWorkflowIDsWithCheckpointStatusesTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	workflowIDs []string,
	statuses []workflowbiz.CheckpointStatus,
) (map[string]bool, error) {
	args := []any{workspaceID}
	args = appendSourceSessionStrings(args, workflowIDs)
	args = appendCheckpointStatuses(args, statuses)
	return listChangedWorkflowIDsTx(ctx, tx, `
SELECT DISTINCT workflow_id
FROM workspace_workflow_checkpoints
WHERE workspace_id = ?
  AND workflow_id IN (`+sourceSessionSQLPlaceholders(len(workflowIDs))+`)
  AND status IN (`+sourceSessionSQLPlaceholders(len(statuses))+`)
`, args, "checkpoint")
}

func listWorkflowIDsWithOperationStatusesTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	workflowIDs []string,
	statuses []workflowbiz.OperationStatus,
) (map[string]bool, error) {
	args := []any{workspaceID}
	args = appendSourceSessionStrings(args, workflowIDs)
	args = appendOperationStatuses(args, statuses)
	return listChangedWorkflowIDsTx(ctx, tx, `
SELECT DISTINCT workflow_id
FROM workspace_workflow_operations
WHERE workspace_id = ?
  AND workflow_id IN (`+sourceSessionSQLPlaceholders(len(workflowIDs))+`)
  AND status IN (`+sourceSessionSQLPlaceholders(len(statuses))+`)
`, args, "operation")
}

func listChangedWorkflowIDsTx(
	ctx context.Context,
	tx *sql.Tx,
	query string,
	args []any,
	entity string,
) (map[string]bool, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list changed workflow %s identities: %w", entity, err)
	}
	defer rows.Close()
	changed := make(map[string]bool)
	for rows.Next() {
		var workflowID string
		if err := rows.Scan(&workflowID); err != nil {
			return nil, fmt.Errorf("scan changed workflow %s identity: %w", entity, err)
		}
		if workflowID = strings.TrimSpace(workflowID); workflowID != "" {
			changed[workflowID] = true
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate changed workflow %s identities: %w", entity, err)
	}
	return changed, nil
}

func normalizeSourceSessionDeletionCommand(command SourceSessionDeletionCommand) (SourceSessionDeletionCommand, error) {
	command.WorkspaceID = strings.TrimSpace(command.WorkspaceID)
	command.SessionIDs = normalizedSourceSessionIDs(command.SessionIDs)
	command.WorkflowCancellation.DecidedBy = strings.TrimSpace(command.WorkflowCancellation.DecidedBy)
	command.WorkflowCancellation.DecisionReason = strings.TrimSpace(command.WorkflowCancellation.DecisionReason)
	command.WorkflowCancellation.ChangedAt = command.WorkflowCancellation.ChangedAt.UTC()
	if command.WorkspaceID == "" || (!command.ClearWorkspace && len(command.SessionIDs) == 0) {
		return SourceSessionDeletionCommand{}, errors.New("source session deletion scope is required")
	}
	policy := command.WorkflowCancellation
	if len(policy.AllowedWorkflowStatuses) == 0 || len(policy.AllowedCheckpointStatuses) == 0 || len(policy.AllowedOperationStatuses) == 0 ||
		!workflowbiz.IsWorkflowStatus(policy.WorkflowStatus) || !workflowbiz.IsCheckpointStatus(policy.CheckpointStatus) || !workflowbiz.IsOperationStatus(policy.OperationStatus) ||
		policy.DecidedBy == "" || policy.DecisionReason == "" || policy.ChangedAt.IsZero() {
		return SourceSessionDeletionCommand{}, errors.New("source session deletion workflow command is incomplete")
	}
	for _, status := range policy.AllowedWorkflowStatuses {
		if !workflowbiz.IsWorkflowStatus(status) {
			return SourceSessionDeletionCommand{}, errors.New("source session deletion has an invalid allowed workflow status")
		}
	}
	for _, status := range policy.AllowedCheckpointStatuses {
		if !workflowbiz.IsCheckpointStatus(status) {
			return SourceSessionDeletionCommand{}, errors.New("source session deletion has an invalid allowed checkpoint status")
		}
	}
	for _, status := range policy.AllowedOperationStatuses {
		if !workflowbiz.IsOperationStatus(status) {
			return SourceSessionDeletionCommand{}, errors.New("source session deletion has an invalid allowed operation status")
		}
	}
	return command, nil
}

func normalizedSourceSessionIDs(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func sourceSessionSQLPlaceholders(count int) string {
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
}

func appendSourceSessionStrings(args []any, values []string) []any {
	for _, value := range values {
		args = append(args, value)
	}
	return args
}

func appendWorkflowStatuses(args []any, values []workflowbiz.WorkflowStatus) []any {
	for _, value := range values {
		args = append(args, string(value))
	}
	return args
}

func appendCheckpointStatuses(args []any, values []workflowbiz.CheckpointStatus) []any {
	for _, value := range values {
		args = append(args, string(value))
	}
	return args
}

func appendOperationStatuses(args []any, values []workflowbiz.OperationStatus) []any {
	for _, value := range values {
		args = append(args, string(value))
	}
	return args
}
