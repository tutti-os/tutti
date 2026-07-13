package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

const runtimeOperationEventSelectSQL = `
SELECT id, operation_id, workspace_id, agent_session_id, kind, payload_json,
       created_at_unix_ms, COALESCE(published_at_unix_ms, 0)
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

func (s *Store) MarkRuntimeOperationEventPublished(ctx context.Context, workspaceID string, eventID int64, publishedAtUnixMS int64) (bool, error) {
	if s == nil || s.db == nil {
		return false, errors.New("workspace database is not initialized")
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operation_events SET published_at_unix_ms = ?
WHERE workspace_id = ? AND id = ? AND published_at_unix_ms IS NULL
`, publishedAtUnixMS, strings.TrimSpace(workspaceID), eventID)
	if err != nil {
		return false, fmt.Errorf("mark runtime operation event published: %w", err)
	}
	return rowsWereAffected(result, "mark runtime operation event published")
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
		&event.Kind, &payloadJSON, &event.CreatedAtUnixMS, &event.PublishedAtUnixMS); err != nil {
		return RuntimeOperationEvent{}, err
	}
	payload, err := unmarshalJSONMap(payloadJSON)
	if err != nil {
		return RuntimeOperationEvent{}, fmt.Errorf("decode runtime operation event payload: %w", err)
	}
	event.Payload = payload
	return event, nil
}
