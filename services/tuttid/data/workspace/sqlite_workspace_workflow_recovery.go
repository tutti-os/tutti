package workspace

import (
	"context"
	"errors"
	"fmt"
	"time"
)

func (s *SQLiteStore) ListRecoverableCreateIssueOperations(ctx context.Context) ([]RecoverableCreateIssueOperation, error) {
	if s == nil || s.writeDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	rows, err := s.writeDB.QueryContext(ctx, `
SELECT
  o.workspace_id, o.workflow_id, w.source_session_id,
  c.checkpoint_id, c.kind, c.revision_id, c.status, c.decided_by,
  c.decision_reason, c.created_at_unix_ms, c.updated_at_unix_ms, c.decided_at_unix_ms,
  o.operation_id, o.kind, o.status, o.revision_id, o.issue_id,
  o.error_code, o.error_message, o.created_at_unix_ms, o.updated_at_unix_ms,
  o.started_at_unix_ms, o.completed_at_unix_ms
FROM workspace_workflow_operations o
JOIN workspace_workflows w
  ON w.workspace_id = o.workspace_id AND w.workflow_id = o.workflow_id
JOIN workspace_workflow_checkpoints c
  ON c.workspace_id = o.workspace_id AND c.workflow_id = o.workflow_id
 AND c.revision_id = o.revision_id
WHERE w.status = 'accepted'
  AND c.kind = 'task_review' AND c.status = 'accepted'
  AND o.kind = 'create_issue' AND o.status IN ('pending', 'failed')
ORDER BY o.created_at_unix_ms ASC, o.workspace_id ASC, o.workflow_id ASC, o.operation_id ASC
`)
	if err != nil {
		return nil, fmt.Errorf("list recoverable create_issue operations: %w", err)
	}
	defer rows.Close()

	result := make([]RecoverableCreateIssueOperation, 0)
	for rows.Next() {
		var item RecoverableCreateIssueOperation
		var checkpointCreated, checkpointUpdated, checkpointDecided int64
		var operationCreated, operationUpdated, operationStarted, operationCompleted int64
		if err := rows.Scan(
			&item.WorkspaceID, &item.Operation.WorkflowID, &item.SourceSessionID,
			&item.Checkpoint.ID, &item.Checkpoint.Kind, &item.Checkpoint.RevisionID,
			&item.Checkpoint.Status, &item.Checkpoint.DecidedBy, &item.Checkpoint.DecisionReason,
			&checkpointCreated, &checkpointUpdated, &checkpointDecided,
			&item.Operation.ID, &item.Operation.Kind, &item.Operation.Status,
			&item.Operation.RevisionID, &item.Operation.IssueID, &item.Operation.ErrorCode,
			&item.Operation.ErrorMessage, &operationCreated, &operationUpdated,
			&operationStarted, &operationCompleted,
		); err != nil {
			return nil, fmt.Errorf("scan recoverable create_issue operation: %w", err)
		}
		item.Checkpoint.WorkflowID = item.Operation.WorkflowID
		item.Checkpoint.CreatedAt = time.UnixMilli(checkpointCreated).UTC()
		item.Checkpoint.UpdatedAt = time.UnixMilli(checkpointUpdated).UTC()
		item.Checkpoint.DecidedAt = optionalUnixMs(checkpointDecided)
		item.Operation.CreatedAt = time.UnixMilli(operationCreated).UTC()
		item.Operation.UpdatedAt = time.UnixMilli(operationUpdated).UTC()
		item.Operation.StartedAt = optionalUnixMs(operationStarted)
		item.Operation.CompletedAt = optionalUnixMs(operationCompleted)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate recoverable create_issue operations: %w", err)
	}
	return result, nil
}
