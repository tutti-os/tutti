package storesqlite

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// ListClaimableEditRetryOperations is the edit-retry-only recovery queue.
// It never changes the eligibility, ordering, or limit of ordinary runtime
// operations. Legacy, malformed, and future payloads fail closed here.
func (s *Store) ListClaimableEditRetryOperations(ctx context.Context, input ListClaimableRuntimeOperationsInput) ([]RuntimeOperation, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	limit := input.Limit
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	query := `WITH eligible AS (
SELECT o.*, COALESCE(NULLIF(TRIM(s.provider), ''), 'unknown:' || o.workspace_id || ':' || o.agent_session_id) AS provider_key,
 ROW_NUMBER() OVER (PARTITION BY COALESCE(NULLIF(TRIM(s.provider), ''), 'unknown:' || o.workspace_id || ':' || o.agent_session_id) ORDER BY o.created_at_unix_ms, o.operation_id) AS provider_rank,
 ROW_NUMBER() OVER (PARTITION BY o.workspace_id ORDER BY o.created_at_unix_ms, o.operation_id) AS workspace_rank
FROM workspace_agent_runtime_operations o
JOIN workspace_agent_sessions s ON s.workspace_id=o.workspace_id AND s.agent_session_id=o.agent_session_id AND COALESCE(s.deleted_at_unix_ms, 0)=0
WHERE o.kind=? AND ((o.status=? AND o.next_attempt_at_unix_ms<=?) OR (o.status=? AND o.lease_expires_at_unix_ms<=?))
 AND json_valid(o.payload_json) AND json_extract(o.payload_json, '$.sagaVersion')=?`
	args := []any{RuntimeOperationKindEditRetry, RuntimeOperationStatusPrepared, input.NowUnixMS, RuntimeOperationStatusLeased, input.NowUnixMS, EditRetrySagaVersionCurrent}
	if workspaceID := strings.TrimSpace(input.WorkspaceID); workspaceID != "" {
		query += ` AND o.workspace_id=?`
		args = append(args, workspaceID)
	}
	query += `) SELECT operation_id, workspace_id, agent_session_id, kind, status, COALESCE(result,''), turn_id, COALESCE(request_id,''), payload_json, COALESCE(lease_owner,''), COALESCE(lease_expires_at_unix_ms,0), COALESCE(next_attempt_at_unix_ms,0), attempt, version, last_error, created_at_unix_ms, updated_at_unix_ms, COALESCE(completed_at_unix_ms,0), provider_key FROM eligible WHERE provider_rank<=2 OR workspace_rank<=2 ORDER BY CASE WHEN provider_rank<workspace_rank THEN provider_rank ELSE workspace_rank END, provider_rank, workspace_rank, created_at_unix_ms, operation_id LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list claimable edit retry operations: %w", err)
	}
	defer rows.Close()
	result := make([]RuntimeOperation, 0)
	for rows.Next() {
		var op RuntimeOperation
		var payloadJSON string
		if err := rows.Scan(&op.OperationID, &op.WorkspaceID, &op.AgentSessionID, &op.Kind, &op.Status, &op.Result, &op.TurnID, &op.RequestID, &payloadJSON, &op.LeaseOwner, &op.LeaseExpiresAtMS, &op.NextAttemptAtMS, &op.Attempt, &op.Version, &op.LastError, &op.CreatedAtUnixMS, &op.UpdatedAtUnixMS, &op.CompletedAtUnixMS, &op.ProviderKey); err != nil {
			return nil, err
		}
		op.Payload, err = unmarshalJSONMap(payloadJSON)
		if err != nil {
			return nil, fmt.Errorf("decode edit retry payload: %w", err)
		}
		if err := validateEditRetryOperationPayload(op.OperationID, op.Payload); err != nil {
			return nil, fmt.Errorf("validate stored edit retry operation payload: %w", err)
		}
		result = append(result, op)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate claimable edit retry operations: %w", err)
	}
	return result, nil
}
