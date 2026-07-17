package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
)

func (s *SQLiteStore) CreateWorkspaceWorkflowProposal(ctx context.Context, aggregate workflowbiz.ProposalAggregate) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	normalized, err := workflowbiz.NormalizeProposalAggregate(aggregate)
	if err != nil {
		return err
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin create workspace workflow proposal: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := insertWorkspaceWorkflowProposal(ctx, tx, normalized); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit create workspace workflow proposal: %w", err)
	}
	return nil
}

func (s *SQLiteStore) CreateWorkspaceWorkflowProposalWithMutation(
	ctx context.Context,
	input CreateWorkspaceWorkflowProposalMutationInput,
) (workflowbiz.WorkflowMutation, bool, error) {
	if s == nil || s.writeDB == nil {
		return workflowbiz.WorkflowMutation{}, false, errors.New("workspace database is not initialized")
	}
	aggregate, err := workflowbiz.NormalizeProposalAggregate(input.Aggregate)
	if err != nil {
		return workflowbiz.WorkflowMutation{}, false, err
	}
	mutation, err := workflowbiz.NormalizeMutation(input.Mutation)
	if err != nil {
		return workflowbiz.WorkflowMutation{}, false, err
	}
	if mutation.Kind != workflowbiz.MutationKindPropose || mutation.WorkspaceID != aggregate.Workflow.WorkspaceID ||
		mutation.SourceSessionID != aggregate.Workflow.SourceSessionID || mutation.WorkflowID != aggregate.Workflow.ID ||
		mutation.RevisionID != aggregate.Revision.ID || mutation.CheckpointID != aggregate.Checkpoint.ID {
		return workflowbiz.WorkflowMutation{}, false, fmt.Errorf("%w: proposal mutation must bind its aggregate", workflowbiz.ErrInvalidWorkflow)
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return workflowbiz.WorkflowMutation{}, false, fmt.Errorf("begin create workspace workflow proposal mutation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	claimed, created, err := claimWorkspaceWorkflowMutation(ctx, tx, mutation)
	if err != nil || !created {
		return claimed, false, err
	}
	if err := insertWorkspaceWorkflowProposal(ctx, tx, aggregate); err != nil {
		return workflowbiz.WorkflowMutation{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return workflowbiz.WorkflowMutation{}, false, fmt.Errorf("commit create workspace workflow proposal mutation: %w", err)
	}
	return claimed, true, nil
}

func insertWorkspaceWorkflowProposal(ctx context.Context, tx *sql.Tx, normalized workflowbiz.ProposalAggregate) error {

	workflow := normalized.Workflow
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_workflows (
  workspace_id, workflow_id, workflow_type, owner, trigger_kind,
  source_session_id, source_turn_id, source_tool_call_id, status,
  current_revision_id, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, workflow.WorkspaceID, workflow.ID, workflow.Type, workflow.Owner, workflow.TriggerKind,
		workflow.SourceSessionID, workflow.SourceTurnID, workflow.SourceToolCallID, workflow.Status,
		workflow.CurrentRevisionID, unixMs(workflow.CreatedAt), unixMs(workflow.UpdatedAt)); err != nil {
		return fmt.Errorf("insert workspace workflow: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tutti_mode_plans (workspace_id, workflow_id) VALUES (?, ?)
`, workflow.WorkspaceID, workflow.ID); err != nil {
		return fmt.Errorf("insert tutti mode plan: %w", err)
	}
	if err := insertWorkflowPlanRevision(ctx, tx, workflow.WorkspaceID, normalized.Revision); err != nil {
		return err
	}
	if err := insertWorkflowCheckpoint(ctx, tx, workflow.WorkspaceID, normalized.Checkpoint); err != nil {
		return err
	}
	for _, link := range normalized.TurnLinks {
		if err := insertWorkflowTurnLink(ctx, tx, workflow.WorkspaceID, link); err != nil {
			return err
		}
	}
	return nil
}

func (s *SQLiteStore) GetWorkspaceWorkflowSnapshot(ctx context.Context, workspaceID string, workflowID string) (workflowbiz.Snapshot, error) {
	if s == nil || s.writeDB == nil {
		return workflowbiz.Snapshot{}, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	workflowID = strings.TrimSpace(workflowID)
	if workspaceID == "" || workflowID == "" {
		return workflowbiz.Snapshot{}, errors.New("workspace id and workflow id are required")
	}

	workflow, err := getWorkspaceWorkflow(ctx, s.writeDB, workspaceID, workflowID)
	if err != nil {
		return workflowbiz.Snapshot{}, err
	}
	snapshot := workflowbiz.Snapshot{
		Workflow:    workflow,
		Plan:        workflowbiz.TuttiModePlan{WorkflowID: workflowID},
		Revisions:   make([]workflowbiz.PlanRevision, 0),
		Checkpoints: make([]workflowbiz.WorkflowCheckpoint, 0),
		TurnLinks:   make([]workflowbiz.WorkflowTurnLink, 0),
		Operations:  make([]workflowbiz.WorkflowOperation, 0),
	}
	if snapshot.Revisions, err = listWorkflowPlanRevisions(ctx, s.writeDB, workspaceID, workflowID); err != nil {
		return workflowbiz.Snapshot{}, err
	}
	if snapshot.Checkpoints, err = listWorkflowCheckpoints(ctx, s.writeDB, workspaceID, workflowID); err != nil {
		return workflowbiz.Snapshot{}, err
	}
	if snapshot.TurnLinks, err = listWorkflowTurnLinks(ctx, s.writeDB, workspaceID, workflowID); err != nil {
		return workflowbiz.Snapshot{}, err
	}
	if snapshot.Operations, err = listWorkflowOperations(ctx, s.writeDB, workspaceID, workflowID); err != nil {
		return workflowbiz.Snapshot{}, err
	}
	return snapshot, nil
}

func (s *SQLiteStore) ListPendingWorkflowCheckpointsBySourceSession(
	ctx context.Context,
	workspaceID string,
	sourceSessionID string,
) ([]workflowbiz.PendingCheckpoint, error) {
	if s == nil || s.writeDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	sourceSessionID = strings.TrimSpace(sourceSessionID)
	if workspaceID == "" || sourceSessionID == "" {
		return nil, errors.New("workspace id and source session id are required")
	}

	rows, err := s.writeDB.QueryContext(ctx, `
SELECT
  w.workflow_id, w.workflow_type, w.owner, w.trigger_kind,
  w.source_turn_id, w.source_tool_call_id, w.status, w.current_revision_id,
  w.created_at_unix_ms, w.updated_at_unix_ms,
  c.checkpoint_id, c.kind, c.revision_id, c.status, c.decided_by,
  c.decision_reason, c.task_assignments, c.created_at_unix_ms, c.updated_at_unix_ms, c.decided_at_unix_ms,
  r.revision_sequence, r.schema_version, r.document_path, r.sha256,
  r.produced_by_turn_id, r.created_at_unix_ms
FROM workspace_workflows w
JOIN workspace_workflow_checkpoints c
  ON c.workspace_id = w.workspace_id AND c.workflow_id = w.workflow_id
JOIN workspace_workflow_plan_revisions r
  ON r.workspace_id = c.workspace_id
 AND r.workflow_id = c.workflow_id
 AND r.revision_id = c.revision_id
WHERE w.workspace_id = ? AND w.source_session_id = ? AND c.status = 'pending'
ORDER BY c.created_at_unix_ms ASC, c.checkpoint_id ASC
`, workspaceID, sourceSessionID)
	if err != nil {
		return nil, fmt.Errorf("list pending workflow checkpoints by source session: %w", err)
	}
	defer rows.Close()

	result := make([]workflowbiz.PendingCheckpoint, 0)
	for rows.Next() {
		var item workflowbiz.PendingCheckpoint
		var workflowCreated, workflowUpdated int64
		var checkpointCreated, checkpointUpdated, checkpointDecided int64
		var revisionCreated int64
		var encodedAssignments string
		item.Workflow.WorkspaceID = workspaceID
		item.Workflow.SourceSessionID = sourceSessionID
		if err := rows.Scan(
			&item.Workflow.ID, &item.Workflow.Type, &item.Workflow.Owner, &item.Workflow.TriggerKind,
			&item.Workflow.SourceTurnID, &item.Workflow.SourceToolCallID, &item.Workflow.Status, &item.Workflow.CurrentRevisionID,
			&workflowCreated, &workflowUpdated,
			&item.Checkpoint.ID, &item.Checkpoint.Kind, &item.Checkpoint.RevisionID, &item.Checkpoint.Status,
			&item.Checkpoint.DecidedBy, &item.Checkpoint.DecisionReason, &encodedAssignments,
			&checkpointCreated, &checkpointUpdated, &checkpointDecided,
			&item.Revision.Sequence, &item.Revision.SchemaVersion, &item.Revision.DocumentPath,
			&item.Revision.SHA256, &item.Revision.ProducedByTurnID, &revisionCreated,
		); err != nil {
			return nil, fmt.Errorf("scan pending workflow checkpoint: %w", err)
		}
		if item.Checkpoint.TaskAssignments, err = decodeWorkflowTaskAssignments(encodedAssignments); err != nil {
			return nil, err
		}
		item.Workflow.CreatedAt = time.UnixMilli(workflowCreated).UTC()
		item.Workflow.UpdatedAt = time.UnixMilli(workflowUpdated).UTC()
		item.Checkpoint.WorkflowID = item.Workflow.ID
		item.Checkpoint.CreatedAt = time.UnixMilli(checkpointCreated).UTC()
		item.Checkpoint.UpdatedAt = time.UnixMilli(checkpointUpdated).UTC()
		item.Checkpoint.DecidedAt = optionalUnixMs(checkpointDecided)
		item.Revision.ID = item.Checkpoint.RevisionID
		item.Revision.WorkflowID = item.Workflow.ID
		item.Revision.CreatedAt = time.UnixMilli(revisionCreated).UTC()
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate pending workflow checkpoints: %w", err)
	}
	return result, nil
}

func (s *SQLiteStore) AppendWorkspaceWorkflowTurnLink(ctx context.Context, workspaceID string, link workflowbiz.WorkflowTurnLink) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	normalized, err := workflowbiz.NormalizeTurnLink(link)
	if err != nil {
		return err
	}
	if workspaceID == "" {
		return errors.New("workspace id is required")
	}
	return insertWorkflowTurnLink(ctx, s.writeDB, workspaceID, normalized)
}

func (s *SQLiteStore) RecordWorkspaceWorkflowOperation(ctx context.Context, workspaceID string, operation workflowbiz.WorkflowOperation) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	normalized, err := workflowbiz.NormalizeOperation(operation)
	if err != nil {
		return err
	}
	if workspaceID == "" {
		return errors.New("workspace id is required")
	}
	return insertWorkflowOperation(ctx, s.writeDB, workspaceID, normalized)
}

func (s *SQLiteStore) CompleteWorkspaceWorkflowOperation(
	ctx context.Context,
	input CompleteWorkspaceWorkflowOperationInput,
) (workflowbiz.WorkflowOperation, bool, error) {
	if s == nil || s.writeDB == nil {
		return workflowbiz.WorkflowOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.WorkflowID = strings.TrimSpace(input.WorkflowID)
	input.OperationID = strings.TrimSpace(input.OperationID)
	input.IssueID = strings.TrimSpace(input.IssueID)
	input.ErrorCode = strings.TrimSpace(input.ErrorCode)
	input.ErrorMessage = strings.TrimSpace(input.ErrorMessage)
	if input.WorkspaceID == "" || input.WorkflowID == "" || input.OperationID == "" || input.CompletedAt.IsZero() {
		return workflowbiz.WorkflowOperation{}, false, errors.New("workspace, workflow, operation, and completion time are required")
	}
	if !workflowbiz.IsOperationStatus(input.ExpectedStatus) || !workflowbiz.IsTerminalOperationStatus(input.Status) {
		return workflowbiz.WorkflowOperation{}, false, fmt.Errorf("%w: invalid operation compare-and-set transition", workflowbiz.ErrInvalidWorkflow)
	}
	input.CompletedAt = input.CompletedAt.UTC()
	query := `
UPDATE workspace_workflow_operations
SET status = ?, issue_id = ?, error_code = ?, error_message = ?,
    updated_at_unix_ms = ?, completed_at_unix_ms = ?
WHERE workspace_id = ? AND workflow_id = ? AND operation_id = ? AND status = ?
`
	args := []any{input.Status, input.IssueID, input.ErrorCode, input.ErrorMessage,
		unixMs(input.CompletedAt), unixMs(input.CompletedAt), input.WorkspaceID, input.WorkflowID,
		input.OperationID, input.ExpectedStatus}
	if input.Status == workflowbiz.OperationStatusSucceeded {
		query = `
UPDATE workspace_workflow_operations
SET status = ?, issue_id = ?, error_code = ?, error_message = ?,
    updated_at_unix_ms = ?, completed_at_unix_ms = ?
WHERE workspace_id = ? AND workflow_id = ? AND operation_id = ?
  AND status IN (?, ?)
`
		args = append(args, workflowbiz.OperationStatusFailed)
	}
	result, err := s.writeDB.ExecContext(ctx, query, args...)
	if err != nil {
		return workflowbiz.WorkflowOperation{}, false, fmt.Errorf("complete workspace workflow operation: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return workflowbiz.WorkflowOperation{}, false, fmt.Errorf("read workflow operation completion rows affected: %w", err)
	}
	operation, err := getWorkflowOperation(ctx, s.writeDB, input.WorkspaceID, input.WorkflowID, input.OperationID)
	if err != nil {
		return workflowbiz.WorkflowOperation{}, false, err
	}
	return operation, changed != 0, nil
}

func (s *SQLiteStore) RetryWorkspaceWorkflowOperation(
	ctx context.Context,
	input RetryWorkspaceWorkflowOperationInput,
) (workflowbiz.WorkflowOperation, bool, error) {
	if s == nil || s.writeDB == nil {
		return workflowbiz.WorkflowOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.WorkflowID = strings.TrimSpace(input.WorkflowID)
	input.OperationID = strings.TrimSpace(input.OperationID)
	if input.WorkspaceID == "" || input.WorkflowID == "" || input.OperationID == "" || input.RetriedAt.IsZero() {
		return workflowbiz.WorkflowOperation{}, false, errors.New("workspace, workflow, operation, and retry time are required")
	}
	input.RetriedAt = input.RetriedAt.UTC()
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_workflow_operations
SET status = ?, issue_id = '', error_code = '', error_message = '',
    updated_at_unix_ms = ?, started_at_unix_ms = 0, completed_at_unix_ms = 0
WHERE workspace_id = ? AND workflow_id = ? AND operation_id = ? AND status = ?
`, workflowbiz.OperationStatusPending, unixMs(input.RetriedAt), input.WorkspaceID,
		input.WorkflowID, input.OperationID, workflowbiz.OperationStatusFailed)
	if err != nil {
		return workflowbiz.WorkflowOperation{}, false, fmt.Errorf("retry workspace workflow operation: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return workflowbiz.WorkflowOperation{}, false, fmt.Errorf("read workflow operation retry rows affected: %w", err)
	}
	operation, err := getWorkflowOperation(ctx, s.writeDB, input.WorkspaceID, input.WorkflowID, input.OperationID)
	if err != nil {
		return workflowbiz.WorkflowOperation{}, false, err
	}
	return operation, changed != 0, nil
}

type workflowSQLExecutor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

type workflowSQLQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func insertWorkflowPlanRevision(ctx context.Context, executor workflowSQLExecutor, workspaceID string, revision workflowbiz.PlanRevision) error {
	_, err := executor.ExecContext(ctx, `
INSERT INTO workspace_workflow_plan_revisions (
  workspace_id, workflow_id, revision_id, revision_sequence, schema_version,
  document_path, sha256, produced_by_turn_id, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`, workspaceID, revision.WorkflowID, revision.ID, revision.Sequence, revision.SchemaVersion,
		revision.DocumentPath, revision.SHA256, revision.ProducedByTurnID, unixMs(revision.CreatedAt))
	if err != nil {
		return fmt.Errorf("insert workspace workflow plan revision: %w", err)
	}
	return nil
}

func insertWorkflowCheckpoint(ctx context.Context, executor workflowSQLExecutor, workspaceID string, checkpoint workflowbiz.WorkflowCheckpoint) error {
	encodedAssignments, err := encodeWorkflowTaskAssignments(checkpoint.TaskAssignments)
	if err != nil {
		return err
	}
	_, err = executor.ExecContext(ctx, `
INSERT INTO workspace_workflow_checkpoints (
  workspace_id, workflow_id, checkpoint_id, kind, revision_id, status,
  decided_by, decision_reason, task_assignments, created_at_unix_ms, updated_at_unix_ms, decided_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, workspaceID, checkpoint.WorkflowID, checkpoint.ID, checkpoint.Kind, checkpoint.RevisionID,
		checkpoint.Status, checkpoint.DecidedBy, checkpoint.DecisionReason, encodedAssignments,
		unixMs(checkpoint.CreatedAt), unixMs(checkpoint.UpdatedAt), unixMsOrZero(checkpoint.DecidedAt))
	if err != nil {
		return fmt.Errorf("insert workspace workflow checkpoint: %w", err)
	}
	return nil
}

// workflowTaskAssignmentRecord is the durable JSON shape for one per-task
// assignment override. Pointer fields keep the null-versus-empty distinction.
type workflowTaskAssignmentRecord struct {
	TaskID           string  `json:"taskId"`
	AgentTargetID    *string `json:"agentTargetId,omitempty"`
	ModelPlanID      *string `json:"modelPlanId,omitempty"`
	Model            *string `json:"model,omitempty"`
	PermissionModeID *string `json:"permissionModeId,omitempty"`
	ReasoningEffort  *string `json:"reasoningEffort,omitempty"`
}

func encodeWorkflowTaskAssignments(values []workflowbiz.TaskAssignment) (string, error) {
	normalized, err := workflowbiz.NormalizeTaskAssignments(values)
	if err != nil {
		return "", err
	}
	if len(normalized) == 0 {
		return "", nil
	}
	records := make([]workflowTaskAssignmentRecord, 0, len(normalized))
	for _, value := range normalized {
		records = append(records, workflowTaskAssignmentRecord{
			TaskID:           value.TaskID,
			AgentTargetID:    value.AgentTargetID,
			ModelPlanID:      value.ModelPlanID,
			Model:            value.Model,
			PermissionModeID: value.PermissionModeID,
			ReasoningEffort:  value.ReasoningEffort,
		})
	}
	encoded, err := json.Marshal(records)
	if err != nil {
		return "", fmt.Errorf("encode workflow task assignments: %w", err)
	}
	return string(encoded), nil
}

func decodeWorkflowTaskAssignments(encoded string) ([]workflowbiz.TaskAssignment, error) {
	encoded = strings.TrimSpace(encoded)
	if encoded == "" {
		return nil, nil
	}
	var records []workflowTaskAssignmentRecord
	if err := json.Unmarshal([]byte(encoded), &records); err != nil {
		return nil, fmt.Errorf("decode workflow task assignments: %w", err)
	}
	values := make([]workflowbiz.TaskAssignment, 0, len(records))
	for _, record := range records {
		values = append(values, workflowbiz.TaskAssignment{
			TaskID:           record.TaskID,
			AgentTargetID:    record.AgentTargetID,
			ModelPlanID:      record.ModelPlanID,
			Model:            record.Model,
			PermissionModeID: record.PermissionModeID,
			ReasoningEffort:  record.ReasoningEffort,
		})
	}
	return workflowbiz.NormalizeTaskAssignments(values)
}

func insertWorkflowTurnLink(ctx context.Context, executor workflowSQLExecutor, workspaceID string, link workflowbiz.WorkflowTurnLink) error {
	_, err := executor.ExecContext(ctx, `
INSERT INTO workspace_workflow_turn_links (
  workspace_id, workflow_id, turn_id, relation, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?)
`, workspaceID, link.WorkflowID, link.TurnID, link.Relation, unixMs(link.CreatedAt))
	if err != nil {
		return fmt.Errorf("insert workspace workflow turn link: %w", err)
	}
	return nil
}

func insertWorkflowOperation(ctx context.Context, executor workflowSQLExecutor, workspaceID string, operation workflowbiz.WorkflowOperation) error {
	_, err := executor.ExecContext(ctx, `
INSERT INTO workspace_workflow_operations (
  workspace_id, workflow_id, operation_id, kind, status, revision_id,
  issue_id, error_code, error_message, created_at_unix_ms, updated_at_unix_ms,
  started_at_unix_ms, completed_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, workspaceID, operation.WorkflowID, operation.ID, operation.Kind, operation.Status,
		nullableText(operation.RevisionID), operation.IssueID, operation.ErrorCode, operation.ErrorMessage,
		unixMs(operation.CreatedAt), unixMs(operation.UpdatedAt), unixMsOrZero(operation.StartedAt), unixMsOrZero(operation.CompletedAt))
	if err != nil {
		return fmt.Errorf("record workspace workflow operation: %w", err)
	}
	return nil
}

func getWorkspaceWorkflow(ctx context.Context, queryer workflowSQLQueryer, workspaceID string, workflowID string) (workflowbiz.Workflow, error) {
	row := queryer.QueryRowContext(ctx, `
SELECT workflow_type, owner, trigger_kind, source_session_id, source_turn_id,
       source_tool_call_id, status, current_revision_id, created_at_unix_ms, updated_at_unix_ms
FROM workspace_workflows
WHERE workspace_id = ? AND workflow_id = ?
`, workspaceID, workflowID)
	var workflow workflowbiz.Workflow
	var createdAt, updatedAt int64
	workflow.ID = workflowID
	workflow.WorkspaceID = workspaceID
	if err := row.Scan(&workflow.Type, &workflow.Owner, &workflow.TriggerKind, &workflow.SourceSessionID,
		&workflow.SourceTurnID, &workflow.SourceToolCallID, &workflow.Status, &workflow.CurrentRevisionID,
		&createdAt, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workflowbiz.Workflow{}, ErrWorkspaceWorkflowNotFound
		}
		return workflowbiz.Workflow{}, fmt.Errorf("get workspace workflow: %w", err)
	}
	workflow.CreatedAt = time.UnixMilli(createdAt).UTC()
	workflow.UpdatedAt = time.UnixMilli(updatedAt).UTC()
	return workflow, nil
}

func listWorkflowPlanRevisions(ctx context.Context, queryer workflowSQLQueryer, workspaceID string, workflowID string) ([]workflowbiz.PlanRevision, error) {
	rows, err := queryer.QueryContext(ctx, `
SELECT revision_id, revision_sequence, schema_version, document_path, sha256,
       produced_by_turn_id, created_at_unix_ms
FROM workspace_workflow_plan_revisions
WHERE workspace_id = ? AND workflow_id = ?
ORDER BY revision_sequence ASC
`, workspaceID, workflowID)
	if err != nil {
		return nil, fmt.Errorf("list workspace workflow plan revisions: %w", err)
	}
	defer rows.Close()
	result := make([]workflowbiz.PlanRevision, 0)
	for rows.Next() {
		var revision workflowbiz.PlanRevision
		var createdAt int64
		revision.WorkflowID = workflowID
		if err := rows.Scan(&revision.ID, &revision.Sequence, &revision.SchemaVersion, &revision.DocumentPath,
			&revision.SHA256, &revision.ProducedByTurnID, &createdAt); err != nil {
			return nil, fmt.Errorf("scan workspace workflow plan revision: %w", err)
		}
		revision.CreatedAt = time.UnixMilli(createdAt).UTC()
		result = append(result, revision)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace workflow plan revisions: %w", err)
	}
	return result, nil
}

func listWorkflowCheckpoints(ctx context.Context, queryer workflowSQLQueryer, workspaceID string, workflowID string) ([]workflowbiz.WorkflowCheckpoint, error) {
	rows, err := queryer.QueryContext(ctx, `
SELECT checkpoint_id, kind, revision_id, status, decided_by, decision_reason, task_assignments,
       created_at_unix_ms, updated_at_unix_ms, decided_at_unix_ms
FROM workspace_workflow_checkpoints
WHERE workspace_id = ? AND workflow_id = ?
ORDER BY created_at_unix_ms ASC, checkpoint_id ASC
`, workspaceID, workflowID)
	if err != nil {
		return nil, fmt.Errorf("list workspace workflow checkpoints: %w", err)
	}
	defer rows.Close()
	result := make([]workflowbiz.WorkflowCheckpoint, 0)
	for rows.Next() {
		checkpoint, scanErr := scanWorkflowCheckpoint(rows, workflowID)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, checkpoint)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace workflow checkpoints: %w", err)
	}
	return result, nil
}

func listWorkflowTurnLinks(ctx context.Context, queryer workflowSQLQueryer, workspaceID string, workflowID string) ([]workflowbiz.WorkflowTurnLink, error) {
	rows, err := queryer.QueryContext(ctx, `
SELECT turn_id, relation, created_at_unix_ms
FROM workspace_workflow_turn_links
WHERE workspace_id = ? AND workflow_id = ?
ORDER BY created_at_unix_ms ASC, turn_id ASC, relation ASC
`, workspaceID, workflowID)
	if err != nil {
		return nil, fmt.Errorf("list workspace workflow turn links: %w", err)
	}
	defer rows.Close()
	result := make([]workflowbiz.WorkflowTurnLink, 0)
	for rows.Next() {
		var link workflowbiz.WorkflowTurnLink
		var createdAt int64
		link.WorkflowID = workflowID
		if err := rows.Scan(&link.TurnID, &link.Relation, &createdAt); err != nil {
			return nil, fmt.Errorf("scan workspace workflow turn link: %w", err)
		}
		link.CreatedAt = time.UnixMilli(createdAt).UTC()
		result = append(result, link)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace workflow turn links: %w", err)
	}
	return result, nil
}

func listWorkflowOperations(ctx context.Context, queryer workflowSQLQueryer, workspaceID string, workflowID string) ([]workflowbiz.WorkflowOperation, error) {
	rows, err := queryer.QueryContext(ctx, `
SELECT operation_id, kind, status, revision_id, issue_id, error_code, error_message,
       created_at_unix_ms, updated_at_unix_ms, started_at_unix_ms, completed_at_unix_ms
FROM workspace_workflow_operations
WHERE workspace_id = ? AND workflow_id = ?
ORDER BY created_at_unix_ms ASC, operation_id ASC
`, workspaceID, workflowID)
	if err != nil {
		return nil, fmt.Errorf("list workspace workflow operations: %w", err)
	}
	defer rows.Close()
	result := make([]workflowbiz.WorkflowOperation, 0)
	for rows.Next() {
		operation, scanErr := scanWorkflowOperation(rows, workflowID)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, operation)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace workflow operations: %w", err)
	}
	return result, nil
}

type workflowRowScanner interface {
	Scan(...any) error
}

func getWorkflowCheckpoint(ctx context.Context, queryer workflowSQLQueryer, workspaceID string, workflowID string, checkpointID string) (workflowbiz.WorkflowCheckpoint, error) {
	row := queryer.QueryRowContext(ctx, `
SELECT checkpoint_id, kind, revision_id, status, decided_by, decision_reason, task_assignments,
       created_at_unix_ms, updated_at_unix_ms, decided_at_unix_ms
FROM workspace_workflow_checkpoints
WHERE workspace_id = ? AND workflow_id = ? AND checkpoint_id = ?
`, workspaceID, workflowID, checkpointID)
	checkpoint, err := scanWorkflowCheckpoint(row, workflowID)
	if errors.Is(err, sql.ErrNoRows) {
		return workflowbiz.WorkflowCheckpoint{}, ErrWorkflowCheckpointNotFound
	}
	return checkpoint, err
}

func scanWorkflowCheckpoint(scanner workflowRowScanner, workflowID string) (workflowbiz.WorkflowCheckpoint, error) {
	var checkpoint workflowbiz.WorkflowCheckpoint
	var createdAt, updatedAt, decidedAt int64
	var encodedAssignments string
	checkpoint.WorkflowID = workflowID
	if err := scanner.Scan(&checkpoint.ID, &checkpoint.Kind, &checkpoint.RevisionID, &checkpoint.Status,
		&checkpoint.DecidedBy, &checkpoint.DecisionReason, &encodedAssignments, &createdAt, &updatedAt, &decidedAt); err != nil {
		return workflowbiz.WorkflowCheckpoint{}, err
	}
	assignments, err := decodeWorkflowTaskAssignments(encodedAssignments)
	if err != nil {
		return workflowbiz.WorkflowCheckpoint{}, err
	}
	checkpoint.TaskAssignments = assignments
	checkpoint.CreatedAt = time.UnixMilli(createdAt).UTC()
	checkpoint.UpdatedAt = time.UnixMilli(updatedAt).UTC()
	checkpoint.DecidedAt = optionalUnixMs(decidedAt)
	return checkpoint, nil
}

func getWorkflowOperation(ctx context.Context, queryer workflowSQLQueryer, workspaceID string, workflowID string, operationID string) (workflowbiz.WorkflowOperation, error) {
	row := queryer.QueryRowContext(ctx, `
SELECT operation_id, kind, status, revision_id, issue_id, error_code, error_message,
       created_at_unix_ms, updated_at_unix_ms, started_at_unix_ms, completed_at_unix_ms
FROM workspace_workflow_operations
WHERE workspace_id = ? AND workflow_id = ? AND operation_id = ?
`, workspaceID, workflowID, operationID)
	operation, err := scanWorkflowOperation(row, workflowID)
	if errors.Is(err, sql.ErrNoRows) {
		return workflowbiz.WorkflowOperation{}, ErrWorkflowOperationNotFound
	}
	return operation, err
}

func scanWorkflowOperation(scanner workflowRowScanner, workflowID string) (workflowbiz.WorkflowOperation, error) {
	var operation workflowbiz.WorkflowOperation
	var revisionID sql.NullString
	var createdAt, updatedAt, startedAt, completedAt int64
	operation.WorkflowID = workflowID
	if err := scanner.Scan(&operation.ID, &operation.Kind, &operation.Status, &revisionID, &operation.IssueID,
		&operation.ErrorCode, &operation.ErrorMessage, &createdAt, &updatedAt, &startedAt, &completedAt); err != nil {
		return workflowbiz.WorkflowOperation{}, err
	}
	operation.RevisionID = revisionID.String
	operation.CreatedAt = time.UnixMilli(createdAt).UTC()
	operation.UpdatedAt = time.UnixMilli(updatedAt).UTC()
	operation.StartedAt = optionalUnixMs(startedAt)
	operation.CompletedAt = optionalUnixMs(completedAt)
	return operation, nil
}

func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func optionalUnixMs(value int64) time.Time {
	if value == 0 {
		return time.Time{}
	}
	return time.UnixMilli(value).UTC()
}
