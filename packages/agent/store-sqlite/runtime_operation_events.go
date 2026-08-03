package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

const runtimeOperationEventSelectSQL = `
SELECT id, operation_id, workspace_id, agent_session_id, kind, occurrence_key, payload_json,
       created_at_unix_ms, COALESCE(published_at_unix_ms, 0),
       COALESCE(publish_attempt, 0), COALESCE(next_attempt_at_unix_ms, 0),
       COALESCE(last_error_code, '')
FROM workspace_agent_runtime_operation_events
`

func (s *Store) ListPendingRuntimeOperationEvents(ctx context.Context, workspaceID string, limit int) ([]RuntimeOperationEvent, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	workspaceID = strings.TrimSpace(workspaceID)
	query := runtimeOperationEventSelectSQL + ` WHERE published_at_unix_ms IS NULL`
	args := make([]any, 0, 2)
	if workspaceID != "" {
		query += ` AND workspace_id = ?`
		args = append(args, workspaceID)
	}
	query += ` ORDER BY id ASC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list pending runtime operation events: %w", err)
	}
	defer rows.Close()
	result := make([]RuntimeOperationEvent, 0)
	for rows.Next() {
		event, err := scanRuntimeOperationEvent(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate pending runtime operation events: %w", err)
	}
	return result, nil
}

func (s *Store) ListReadyRuntimeOperationEvents(ctx context.Context, workspaceID string, nowUnixMS int64, limit int) ([]RuntimeOperationEvent, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if nowUnixMS <= 0 {
		return nil, errors.New("runtime operation event list time is required")
	}
	query := runtimeOperationEventSelectSQL + ` WHERE published_at_unix_ms IS NULL
AND (next_attempt_at_unix_ms IS NULL OR next_attempt_at_unix_ms <= ?)`
	args := []any{nowUnixMS}
	if workspaceID != "" {
		query += ` AND workspace_id = ?`
		args = append(args, workspaceID)
	}
	query += ` ORDER BY id ASC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list ready runtime operation events: %w", err)
	}
	defer rows.Close()
	result := make([]RuntimeOperationEvent, 0)
	for rows.Next() {
		event, err := scanRuntimeOperationEvent(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate ready runtime operation events: %w", err)
	}
	return result, nil
}

func (s *Store) DeferRuntimeOperationEventPublish(ctx context.Context, input DeferRuntimeOperationEventPublishInput) (bool, error) {
	if s == nil || s.db == nil || strings.TrimSpace(input.WorkspaceID) == "" || input.EventID <= 0 || input.NowUnixMS <= 0 || input.NextAttemptAtMS <= input.NowUnixMS || strings.TrimSpace(input.ReasonCode) == "" {
		return false, errors.New("valid runtime operation event defer input is required")
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operation_events
SET publish_attempt=publish_attempt+1, next_attempt_at_unix_ms=?, last_error_code=?
WHERE workspace_id=? AND id=? AND published_at_unix_ms IS NULL
`, input.NextAttemptAtMS, input.ReasonCode, strings.TrimSpace(input.WorkspaceID), input.EventID)
	if err != nil {
		return false, fmt.Errorf("defer runtime operation event publish: %w", err)
	}
	return rowsWereAffected(result, "defer runtime operation event publish")
}

func (s *Store) MarkRuntimeOperationEventPublished(ctx context.Context, workspaceID string, eventID int64, publishedAtUnixMS int64) (bool, error) {
	if s == nil || s.db == nil {
		return false, errors.New("workspace database is not initialized")
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operation_events
SET published_at_unix_ms = ?, next_attempt_at_unix_ms = NULL, last_error_code = ''
WHERE workspace_id = ? AND id = ? AND published_at_unix_ms IS NULL
`, publishedAtUnixMS, strings.TrimSpace(workspaceID), eventID)
	if err != nil {
		return false, fmt.Errorf("mark runtime operation event published: %w", err)
	}
	return rowsWereAffected(result, "mark runtime operation event published")
}

func getRuntimeOperationEventByOccurrenceTx(ctx context.Context, tx *sql.Tx, operationID, kind, occurrenceKey string) (RuntimeOperationEvent, bool, error) {
	event, err := scanRuntimeOperationEvent(tx.QueryRowContext(ctx, runtimeOperationEventSelectSQL+` WHERE operation_id = ? AND kind = ? AND occurrence_key = ? LIMIT 1`, operationID, kind, occurrenceKey))
	if errors.Is(err, sql.ErrNoRows) {
		return RuntimeOperationEvent{}, false, nil
	}
	return event, err == nil, err
}

func getRuntimeOperationEventTx(ctx context.Context, tx *sql.Tx, operationID string) (RuntimeOperationEvent, bool, error) {
	event, err := scanRuntimeOperationEvent(tx.QueryRowContext(ctx, runtimeOperationEventSelectSQL+` WHERE operation_id = ? ORDER BY id DESC LIMIT 1`, operationID))
	if errors.Is(err, sql.ErrNoRows) {
		return RuntimeOperationEvent{}, false, nil
	}
	return event, err == nil, err
}

func scanRuntimeOperationEvent(scanner rowScanner) (RuntimeOperationEvent, error) {
	var event RuntimeOperationEvent
	var payloadJSON string
	if err := scanner.Scan(&event.ID, &event.OperationID, &event.WorkspaceID, &event.AgentSessionID,
		&event.Kind, &event.OccurrenceKey, &payloadJSON, &event.CreatedAtUnixMS, &event.PublishedAtUnixMS,
		&event.PublishAttempt, &event.NextAttemptAtMS, &event.LastErrorCode); err != nil {
		return RuntimeOperationEvent{}, err
	}
	payload, err := unmarshalJSONMap(payloadJSON)
	if err != nil {
		return RuntimeOperationEvent{}, fmt.Errorf("decode runtime operation event payload: %w", err)
	}
	event.Payload = payload
	return event, nil
}
