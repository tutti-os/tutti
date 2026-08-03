package storesqlite

import (
	"context"
	"errors"
	"fmt"
)

// ListActiveEditRetryDegradations derives current recovery degradation
// from durable operations and their exact session fence. It never reads a
// provider and deliberately keeps inconsistent rows observable instead of
// silently treating them as healthy.
func (s *Store) ListActiveEditRetryDegradations(ctx context.Context, limit int) ([]ActiveEditRetryDegradation, int64, bool, error) {
	if s == nil || s.db == nil {
		return nil, 0, false, errors.New("workspace database is not initialized")
	}
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	const activeRuntimeOperationDegradations = `
WITH active AS (
  SELECT o.operation_id, o.workspace_id, o.agent_session_id, o.kind, o.status,
         COALESCE(o.result, '') AS result, o.turn_id, COALESCE(o.request_id, '') AS request_id, o.payload_json,
         COALESCE(o.lease_owner, '') AS lease_owner, COALESCE(o.lease_expires_at_unix_ms, 0) AS lease_expires_at_unix_ms,
         COALESCE(o.next_attempt_at_unix_ms, 0) AS next_attempt_at_unix_ms, o.attempt, o.version, o.last_error,
         o.created_at_unix_ms, o.updated_at_unix_ms, COALESCE(o.completed_at_unix_ms, 0) AS completed_at_unix_ms,
         COALESCE(h.history_revision, 0) AS history_revision, COALESCE(h.recovery_state, '') AS recovery_state,
         COALESCE(h.operation_id, '') AS history_operation_id, COALESCE(h.updated_at_unix_ms, 0) AS history_updated_at_unix_ms, 0 AS orphan_fence
  FROM workspace_agent_runtime_operations AS o
  JOIN workspace_agent_sessions AS s
    ON s.workspace_id = o.workspace_id AND s.agent_session_id = o.agent_session_id
   AND s.deleted_at_unix_ms = 0
  LEFT JOIN workspace_agent_session_history AS h
    ON h.workspace_id = o.workspace_id AND h.agent_session_id = o.agent_session_id
  WHERE o.kind = 'edit_retry' AND (
    o.status IN ('prepared', 'leased', 'blocked') OR
    (h.recovery_state <> 'ready' AND h.operation_id = o.operation_id)
  )
  UNION ALL
  SELECT h.operation_id, h.workspace_id, h.agent_session_id, 'edit_retry', 'blocked',
         '', '', '', '{}', '', 0, 0, 0, 0, '', h.updated_at_unix_ms,
         h.updated_at_unix_ms, 0, h.history_revision, h.recovery_state,
         h.operation_id, h.updated_at_unix_ms, 1 AS orphan_fence
  FROM workspace_agent_session_history AS h
  JOIN workspace_agent_sessions AS s
    ON s.workspace_id = h.workspace_id AND s.agent_session_id = h.agent_session_id
   AND s.deleted_at_unix_ms = 0
  LEFT JOIN workspace_agent_runtime_operations AS o
    ON o.workspace_id = h.workspace_id AND o.agent_session_id = h.agent_session_id
    AND o.operation_id = h.operation_id
  WHERE h.recovery_state <> 'ready' AND (o.operation_id IS NULL OR o.kind <> 'edit_retry')
)
`
	var count int64
	if err := s.db.QueryRowContext(ctx, activeRuntimeOperationDegradations+`SELECT COUNT(*) FROM active`).Scan(&count); err != nil {
		return nil, 0, false, fmt.Errorf("count active runtime operation degradations: %w", err)
	}
	rows, err := s.db.QueryContext(ctx, activeRuntimeOperationDegradations+`
SELECT operation_id, workspace_id, agent_session_id, kind, status, result, turn_id,
       request_id, payload_json, lease_owner, lease_expires_at_unix_ms,
       next_attempt_at_unix_ms, attempt, version, last_error, created_at_unix_ms, updated_at_unix_ms,
       completed_at_unix_ms, history_revision, recovery_state, history_operation_id,
       history_updated_at_unix_ms, orphan_fence
FROM active
ORDER BY updated_at_unix_ms DESC, operation_id ASC LIMIT ?`, limit)
	if err != nil {
		return nil, 0, false, fmt.Errorf("list active runtime operation degradations: %w", err)
	}
	defer rows.Close()
	result := make([]ActiveEditRetryDegradation, 0, limit)
	for rows.Next() {
		var item ActiveEditRetryDegradation
		var payload string
		var orphan int
		if err := rows.Scan(&item.Operation.OperationID, &item.Operation.WorkspaceID, &item.Operation.AgentSessionID, &item.Operation.Kind, &item.Operation.Status, &item.Operation.Result, &item.Operation.TurnID, &item.Operation.RequestID, &payload, &item.Operation.LeaseOwner, &item.Operation.LeaseExpiresAtMS, &item.Operation.NextAttemptAtMS, &item.Operation.Attempt, &item.Operation.Version, &item.Operation.LastError, &item.Operation.CreatedAtUnixMS, &item.Operation.UpdatedAtUnixMS, &item.Operation.CompletedAtUnixMS, &item.History.Revision, &item.History.RecoveryState, &item.History.OperationID, &item.History.UpdatedAtUnixMS, &orphan); err != nil {
			return nil, 0, false, err
		}
		item.History.WorkspaceID, item.History.AgentSessionID = item.Operation.WorkspaceID, item.Operation.AgentSessionID
		var decodeErr error
		item.Operation.Payload, decodeErr = unmarshalJSONMap(payload)
		if decodeErr != nil {
			// A legacy malformed payload is itself durable recovery evidence. Keep
			// the incident visible without letting one bad row make the health
			// endpoint unavailable or leak its raw database/JSON diagnostic.
			item.Operation.Payload = map[string]any{}
		}
		item.OrphanFence = orphan != 0
		// A non-ready fence may never be owned by a terminal operation. Keep it
		// visible as recovery_required instead of deriving actions from a row
		// that can no longer safely clear or advance that fence.
		terminalOwner := (item.Operation.Status == RuntimeOperationStatusCompleted || item.Operation.Status == RuntimeOperationStatusFailed) && item.History.RecoveryState != SessionHistoryRecoveryReady
		item.Invariant = decodeErr != nil || item.OrphanFence || terminalOwner || item.History.OperationID != item.Operation.OperationID || item.History.RecoveryState == ""
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, false, fmt.Errorf("iterate active runtime operation degradations: %w", err)
	}
	return result, count, count > int64(limit), nil
}
