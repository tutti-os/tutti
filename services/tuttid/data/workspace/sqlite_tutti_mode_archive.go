package workspace

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

func (s *SQLiteStore) RequestTuttiModeArchive(
	ctx context.Context,
	request executionbiz.ArchiveRequest,
) (executionbiz.ArchiveOperation, bool, error) {
	request.WorkspaceID = strings.TrimSpace(request.WorkspaceID)
	request.IssueID = strings.TrimSpace(request.IssueID)
	request.RequestID = strings.TrimSpace(request.RequestID)
	request.RequestedBy = strings.TrimSpace(request.RequestedBy)
	request.Reason = strings.TrimSpace(request.Reason)
	request.Now = request.Now.UTC()
	if s == nil || s.writeDB == nil || request.WorkspaceID == "" || request.IssueID == "" ||
		request.RequestID == "" || request.RequestedBy == "" || request.Reason == "" || request.Now.IsZero() {
		return executionbiz.ArchiveOperation{}, false, executionbiz.ErrInvalidExecution
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return executionbiz.ArchiveOperation{}, false, fmt.Errorf("begin Tutti archive request: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	execution, err := getTuttiArchiveExecutionTx(ctx, tx, request.WorkspaceID, request.IssueID)
	if err != nil {
		return executionbiz.ArchiveOperation{}, false, err
	}
	operation, found, err := getTuttiArchiveOperationByRequestTx(
		ctx, tx, request.WorkspaceID, execution.ID, request.RequestID,
	)
	if err != nil {
		return executionbiz.ArchiveOperation{}, false, err
	}
	if found {
		if operation.RequestedBy != request.RequestedBy || operation.Reason != request.Reason {
			return executionbiz.ArchiveOperation{}, false, executionbiz.ErrExecutionConflict
		}
		return operation, true, nil
	}
	if execution.Status == executionbiz.StatusArchiving {
		return currentTuttiArchiveOperationTx(ctx, tx, request.WorkspaceID, execution.ID)
	}
	if execution.Status == executionbiz.StatusArchived {
		return latestCompletedTuttiArchiveOperationTx(ctx, tx, request.WorkspaceID, execution.ID)
	}

	operation = executionbiz.ArchiveOperation{
		WorkspaceID: request.WorkspaceID, ExecutionID: execution.ID, IssueID: request.IssueID,
		OperationID: "archive:" + execution.ID + ":" + request.RequestID,
		RequestID:   request.RequestID, Status: executionbiz.ArchiveStatusCancelingRuns,
		RequestedBy: request.RequestedBy, Reason: request.Reason,
		CreatedAt: request.Now, UpdatedAt: request.Now,
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_tutti_archive_operations (
  workspace_id, execution_id, operation_id, request_id, status,
  requested_by, reason, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`, operation.WorkspaceID, operation.ExecutionID, operation.OperationID, operation.RequestID,
		string(operation.Status), operation.RequestedBy, operation.Reason,
		unixMs(operation.CreatedAt), unixMs(operation.UpdatedAt)); err != nil {
		return executionbiz.ArchiveOperation{}, false, fmt.Errorf("create Tutti archive operation: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_executions
SET status = 'archiving', updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND status <> 'archived'
`, unixMs(request.Now), request.WorkspaceID, execution.ID); err != nil {
		return executionbiz.ArchiveOperation{}, false, fmt.Errorf("fence Tutti execution for archive: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_issues SET dispatch_paused = 1, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ?
`, unixMs(request.Now), request.WorkspaceID, request.IssueID); err != nil {
		return executionbiz.ArchiveOperation{}, false, fmt.Errorf("pause Tutti Issue for archive: %w", err)
	}
	if err := cancelTuttiArchiveOperationsTx(ctx, tx, operation, request.Now); err != nil {
		return executionbiz.ArchiveOperation{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return executionbiz.ArchiveOperation{}, false, fmt.Errorf("commit Tutti archive request: %w", err)
	}
	return operation, false, nil
}

func (s *SQLiteStore) GetTuttiModeArchiveOperation(
	ctx context.Context, workspaceID, operationID string,
) (executionbiz.ArchiveOperation, error) {
	row := s.readDB.QueryRowContext(ctx, archiveOperationSelect+`
WHERE o.workspace_id = ? AND o.operation_id = ?
`, strings.TrimSpace(workspaceID), strings.TrimSpace(operationID))
	operation, err := scanTuttiArchiveOperation(row)
	if errors.Is(err, sql.ErrNoRows) {
		return executionbiz.ArchiveOperation{}, executionbiz.ErrExecutionNotFound
	}
	return operation, err
}

func (s *SQLiteStore) FailTuttiModeArchive(
	ctx context.Context, workspaceID, operationID, message string, now time.Time,
) (executionbiz.ArchiveOperation, error) {
	_, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_archive_operations
SET status = 'failed', attempt_count = attempt_count + 1, last_error = ?,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND status <> 'completed'
`, strings.TrimSpace(message), unixMs(now.UTC()), strings.TrimSpace(workspaceID), strings.TrimSpace(operationID))
	if err != nil {
		return executionbiz.ArchiveOperation{}, fmt.Errorf("fail Tutti archive operation: %w", err)
	}
	return s.GetTuttiModeArchiveOperation(ctx, workspaceID, operationID)
}

func (s *SQLiteStore) CompleteTuttiModeArchiveIfSettled(
	ctx context.Context, workspaceID, operationID string, now time.Time,
) (executionbiz.ArchiveOperation, bool, error) {
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return executionbiz.ArchiveOperation{}, false, fmt.Errorf("begin Tutti archive completion: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	operation, err := scanTuttiArchiveOperation(tx.QueryRowContext(ctx, archiveOperationSelect+`
WHERE o.workspace_id = ? AND o.operation_id = ?
`, strings.TrimSpace(workspaceID), strings.TrimSpace(operationID)))
	if err != nil {
		return executionbiz.ArchiveOperation{}, false, err
	}
	if operation.Status == executionbiz.ArchiveStatusCompleted {
		return operation, true, nil
	}
	var running int
	if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*) FROM workspace_issue_runs
WHERE workspace_id = ? AND issue_id = ? AND status = 'running'
`, operation.WorkspaceID, operation.IssueID).Scan(&running); err != nil {
		return executionbiz.ArchiveOperation{}, false, fmt.Errorf("count archive running Runs: %w", err)
	}
	if running > 0 {
		_, err = tx.ExecContext(ctx, `
UPDATE workspace_tutti_archive_operations
SET status = 'archiving', last_error = '', updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ?
`, unixMs(now.UTC()), operation.WorkspaceID, operation.OperationID)
		if err != nil {
			return executionbiz.ArchiveOperation{}, false, err
		}
		if err := tx.Commit(); err != nil {
			return executionbiz.ArchiveOperation{}, false, err
		}
		operation.Status = executionbiz.ArchiveStatusArchiving
		operation.LastError = ""
		operation.UpdatedAt = now.UTC()
		return operation, false, nil
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_executions
SET status = 'archived', archived_at_unix_ms = ?, archived_by = ?,
    archive_reason = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND status = 'archiving'
`, unixMs(now.UTC()), operation.RequestedBy, operation.Reason, unixMs(now.UTC()),
		operation.WorkspaceID, operation.ExecutionID)
	if err != nil {
		return executionbiz.ArchiveOperation{}, false, fmt.Errorf("seal archived Tutti execution: %w", err)
	}
	if err := requireRowsAffected(
		result,
		executionbiz.ErrExecutionConflict,
		"seal archived Tutti execution",
	); err != nil {
		return executionbiz.ArchiveOperation{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_archive_operations
SET status = 'completed', last_error = '', updated_at_unix_ms = ?, completed_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ?
`, unixMs(now.UTC()), unixMs(now.UTC()), operation.WorkspaceID, operation.OperationID); err != nil {
		return executionbiz.ArchiveOperation{}, false, fmt.Errorf("complete Tutti archive operation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return executionbiz.ArchiveOperation{}, false, fmt.Errorf("commit Tutti archive completion: %w", err)
	}
	operation.Status = executionbiz.ArchiveStatusCompleted
	operation.LastError = ""
	operation.UpdatedAt = now.UTC()
	operation.CompletedAt = now.UTC()
	return operation, true, nil
}

func (s *SQLiteStore) ListRecoverableTuttiModeArchives(
	ctx context.Context, workspaceID string,
) ([]executionbiz.ArchiveOperation, error) {
	rows, err := s.readDB.QueryContext(ctx, archiveOperationSelect+`
WHERE o.workspace_id = ? AND o.status IN ('requested', 'canceling_runs', 'archiving', 'failed')
ORDER BY o.created_at_unix_ms, o.operation_id
`, strings.TrimSpace(workspaceID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []executionbiz.ArchiveOperation
	for rows.Next() {
		operation, scanErr := scanTuttiArchiveOperation(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, operation)
	}
	return result, rows.Err()
}

func (s *SQLiteStore) AdmitSourceSessionDeletion(
	ctx context.Context, input executionbiz.SourceSessionDeletionAdmission,
) (executionbiz.SourceSessionDeletionAdmission, error) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.SessionIDs = normalizedSourceSessionIDs(input.SessionIDs)
	slices.Sort(input.SessionIDs)
	input.Now = input.Now.UTC()
	if input.WorkspaceID == "" || len(input.SessionIDs) == 0 || input.Now.IsZero() {
		return executionbiz.SourceSessionDeletionAdmission{}, errors.New("source session deletion admission is incomplete")
	}
	closureJSON, _ := json.Marshal(input.SessionIDs)
	sum := sha256.Sum256(closureJSON)
	input.AdmissionID = "source-delete:" + hex.EncodeToString(sum[:])
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return executionbiz.SourceSessionDeletionAdmission{}, err
	}
	defer func() { _ = tx.Rollback() }()
	protected, err := listProtectedTuttiSourcesTx(ctx, tx, input.WorkspaceID, input.SessionIDs)
	if err != nil {
		return executionbiz.SourceSessionDeletionAdmission{}, err
	}
	if len(protected) > 0 {
		return executionbiz.SourceSessionDeletionAdmission{}, &executionbiz.ProtectedSourceError{
			WorkspaceID: input.WorkspaceID, Issues: protected,
		}
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_source_session_deletion_admissions (
  workspace_id, admission_id, closure_sha256, closure_json, status,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, 'admitted', ?, ?)
ON CONFLICT(workspace_id, closure_sha256) DO UPDATE SET
  admission_id = excluded.admission_id, closure_json = excluded.closure_json,
  status = 'admitted', updated_at_unix_ms = excluded.updated_at_unix_ms,
  finalized_at_unix_ms = 0
`, input.WorkspaceID, input.AdmissionID, hex.EncodeToString(sum[:]), string(closureJSON),
		unixMs(input.Now), unixMs(input.Now))
	if err != nil {
		return executionbiz.SourceSessionDeletionAdmission{}, fmt.Errorf("record source deletion admission: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return executionbiz.SourceSessionDeletionAdmission{}, err
	}
	return input, nil
}

func (s *SQLiteStore) ReportSourceSessionDeletion(
	ctx context.Context, input executionbiz.SourceSessionDeletionAdmission, succeeded bool, now time.Time,
) error {
	if strings.TrimSpace(input.AdmissionID) == "" {
		sessionIDs := normalizedSourceSessionIDs(input.SessionIDs)
		slices.Sort(sessionIDs)
		closureJSON, _ := json.Marshal(sessionIDs)
		sum := sha256.Sum256(closureJSON)
		input.AdmissionID = "source-delete:" + hex.EncodeToString(sum[:])
	}
	status := "superseded"
	finalized := int64(0)
	if succeeded {
		status = "finalized"
		finalized = unixMs(now.UTC())
	}
	_, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_source_session_deletion_admissions
SET status = ?, updated_at_unix_ms = ?, finalized_at_unix_ms = ?
WHERE workspace_id = ? AND admission_id = ?
`, status, unixMs(now.UTC()), finalized, strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.AdmissionID))
	return err
}

func (s *SQLiteStore) ReconcileSourceSessionDeletionAdmissions(
	ctx context.Context, now time.Time,
) error {
	if s == nil || s.writeDB == nil || now.IsZero() {
		return errors.New("source session deletion admission recovery is incomplete")
	}
	_, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_source_session_deletion_admissions
SET status = 'superseded', updated_at_unix_ms = ?
WHERE status = 'admitted'
`, unixMs(now.UTC()))
	if err != nil {
		return fmt.Errorf("release abandoned source deletion admissions: %w", err)
	}
	return nil
}

func ensureSourceSessionNotDeletionFencedTx(
	ctx context.Context, tx *sql.Tx, workspaceID, sourceSessionID string,
) error {
	var count int
	err := tx.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM workspace_source_session_deletion_admissions a, json_each(a.closure_json) c
WHERE a.workspace_id = ? AND a.status = 'admitted' AND c.value = ?
`, workspaceID, sourceSessionID).Scan(&count)
	if err != nil {
		return fmt.Errorf("check source deletion materialization fence: %w", err)
	}
	if count > 0 {
		return executionbiz.ErrSourceDeletionFenced
	}
	return nil
}

func cancelTuttiArchiveOperationsTx(
	ctx context.Context, tx *sql.Tx, operation executionbiz.ArchiveOperation, now time.Time,
) error {
	updates := []struct {
		statement string
		ownerID   string
	}{
		{statement: `UPDATE workspace_tutti_execution_checkpoints SET status = 'canceled', updated_at_unix_ms = ?
		  WHERE workspace_id = ? AND execution_id = ? AND status IN ('pending', 'active')`,
			ownerID: operation.ExecutionID},
		{statement: `UPDATE workspace_tutti_execution_wakes SET status = 'canceled', lease_owner = '',
		  lease_expires_at_unix_ms = 0, updated_at_unix_ms = ?
		  WHERE workspace_id = ? AND execution_id = ?
		    AND status IN ('prepared', 'leased', 'dispatched', 'turn_settled')`,
			ownerID: operation.ExecutionID},
		{statement: `UPDATE workspace_tutti_goal_reviews SET status = 'canceled', updated_at_unix_ms = ?
		  WHERE workspace_id = ? AND execution_id = ? AND status IN ('prepared', 'dispatched')`,
			ownerID: operation.ExecutionID},
		{statement: `UPDATE workspace_issue_run_launch_intents SET status = 'canceled', lease_owner = '',
		  lease_expires_at_unix_ms = 0, updated_at_unix_ms = ?
		  WHERE workspace_id = ? AND issue_id = ? AND status = 'prepared'`,
			ownerID: operation.IssueID},
	}
	for _, update := range updates {
		if _, err := tx.ExecContext(
			ctx, update.statement, unixMs(now), operation.WorkspaceID, update.ownerID,
		); err != nil {
			return fmt.Errorf("fence Tutti archive child operation: %w", err)
		}
	}
	return nil
}

func getTuttiArchiveExecutionTx(
	ctx context.Context, tx *sql.Tx, workspaceID, issueID string,
) (executionbiz.Execution, error) {
	var execution executionbiz.Execution
	var status string
	err := tx.QueryRowContext(ctx, `
SELECT execution_id, source_session_id, status
FROM workspace_tutti_executions WHERE workspace_id = ? AND issue_id = ?
`, workspaceID, issueID).Scan(&execution.ID, &execution.SourceSessionID, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return execution, executionbiz.ErrExecutionNotFound
	}
	execution.WorkspaceID, execution.IssueID, execution.Status = workspaceID, issueID, executionbiz.Status(status)
	return execution, err
}

func getTuttiArchiveOperationByRequestTx(
	ctx context.Context, tx *sql.Tx, workspaceID, executionID, requestID string,
) (executionbiz.ArchiveOperation, bool, error) {
	operation, err := scanTuttiArchiveOperation(tx.QueryRowContext(ctx, archiveOperationSelect+`
WHERE o.workspace_id = ? AND o.execution_id = ? AND o.request_id = ?
`, workspaceID, executionID, requestID))
	if errors.Is(err, sql.ErrNoRows) {
		return executionbiz.ArchiveOperation{}, false, nil
	}
	return operation, err == nil, err
}

func latestCompletedTuttiArchiveOperationTx(
	ctx context.Context, tx *sql.Tx, workspaceID, executionID string,
) (executionbiz.ArchiveOperation, bool, error) {
	operation, err := scanTuttiArchiveOperation(tx.QueryRowContext(ctx, archiveOperationSelect+`
WHERE o.workspace_id = ? AND o.execution_id = ? AND o.status = 'completed'
ORDER BY o.completed_at_unix_ms DESC LIMIT 1
`, workspaceID, executionID))
	return operation, true, err
}

func currentTuttiArchiveOperationTx(
	ctx context.Context, tx *sql.Tx, workspaceID, executionID string,
) (executionbiz.ArchiveOperation, bool, error) {
	operation, err := scanTuttiArchiveOperation(tx.QueryRowContext(ctx, archiveOperationSelect+`
WHERE o.workspace_id = ? AND o.execution_id = ?
  AND o.status IN ('requested', 'canceling_runs', 'archiving', 'failed')
ORDER BY o.created_at_unix_ms, o.operation_id LIMIT 1
`, workspaceID, executionID))
	return operation, true, err
}

const archiveOperationSelect = `
SELECT o.workspace_id, o.execution_id, e.issue_id, o.operation_id, o.request_id,
       o.status, o.requested_by, o.reason, o.attempt_count, o.last_error,
       o.created_at_unix_ms, o.updated_at_unix_ms, o.completed_at_unix_ms
FROM workspace_tutti_archive_operations o
JOIN workspace_tutti_executions e
  ON e.workspace_id = o.workspace_id AND e.execution_id = o.execution_id
`

type archiveOperationScanner interface{ Scan(...any) error }

func scanTuttiArchiveOperation(scanner archiveOperationScanner) (executionbiz.ArchiveOperation, error) {
	var operation executionbiz.ArchiveOperation
	var status string
	var created, updated, completed int64
	err := scanner.Scan(
		&operation.WorkspaceID, &operation.ExecutionID, &operation.IssueID,
		&operation.OperationID, &operation.RequestID, &status, &operation.RequestedBy,
		&operation.Reason, &operation.AttemptCount, &operation.LastError,
		&created, &updated, &completed,
	)
	operation.Status = executionbiz.ArchiveStatus(status)
	operation.CreatedAt = optionalTuttiModeExecutionTime(created)
	operation.UpdatedAt = optionalTuttiModeExecutionTime(updated)
	operation.CompletedAt = optionalTuttiModeExecutionTime(completed)
	return operation, err
}

func listProtectedTuttiSourcesTx(
	ctx context.Context, tx *sql.Tx, workspaceID string, sessionIDs []string,
) ([]executionbiz.ProtectedIssue, error) {
	args := []any{workspaceID}
	args = appendSourceSessionStrings(args, sessionIDs)
	rows, err := tx.QueryContext(ctx, `
SELECT issue_id, execution_id, source_session_id, status
FROM workspace_tutti_executions
WHERE workspace_id = ? AND source_session_id IN (`+sourceSessionSQLPlaceholders(len(sessionIDs))+`)
  AND status NOT IN ('completed', 'archived')
ORDER BY issue_id
`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []executionbiz.ProtectedIssue
	for rows.Next() {
		var item executionbiz.ProtectedIssue
		var status string
		if err := rows.Scan(&item.IssueID, &item.ExecutionID, &item.SourceSessionID, &status); err != nil {
			return nil, err
		}
		item.Status = executionbiz.Status(status)
		result = append(result, item)
	}
	return result, rows.Err()
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
