package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

const (
	defaultPurgeSessionLimit = 25
	maximumPurgeSessionLimit = 100
	defaultPurgePayloadBytes = int64(32 << 20)
)

// PurgeDeletedSessions permanently removes a bounded set of tombstoned
// sessions. It never considers a live row and fences every candidate by its
// exact deleted_at value before removing any dependent data.
func (s *Store) PurgeDeletedSessions(
	ctx context.Context,
	input PurgeDeletedSessionsInput,
) (PurgeDeletedSessionsResult, error) {
	if s == nil || s.db == nil {
		return PurgeDeletedSessionsResult{}, errors.New("workspace database is not initialized")
	}
	if input.CutoffUnixMS <= 0 {
		return PurgeDeletedSessionsResult{}, nil
	}
	limit := input.MaxSessions
	if limit <= 0 {
		limit = defaultPurgeSessionLimit
	}
	if limit > maximumPurgeSessionLimit {
		limit = maximumPurgeSessionLimit
	}
	maxPayloadBytes := input.MaxPayloadBytes
	if maxPayloadBytes <= 0 {
		maxPayloadBytes = defaultPurgePayloadBytes
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PurgeDeletedSessionsResult{}, fmt.Errorf("begin purge deleted agent sessions: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	candidates, hasMore, err := listDeletedSessionPurgeCandidatesTx(
		ctx, tx, input.CutoffUnixMS, limit, maxPayloadBytes,
	)
	if err != nil {
		return PurgeDeletedSessionsResult{}, err
	}
	result := PurgeDeletedSessionsResult{Sessions: make([]PurgedSession, 0, len(candidates)), HasMore: hasMore}
	for _, candidate := range candidates {
		removedMessages, removed, err := purgeDeletedSessionTx(ctx, tx, candidate)
		if err != nil {
			return PurgeDeletedSessionsResult{}, err
		}
		if !removed {
			continue
		}
		result.Sessions = append(result.Sessions, candidate)
		result.RemovedMessages += removedMessages
		result.PayloadBytes += candidate.PayloadBytes
	}
	if len(result.Sessions) > 0 {
		var anotherEligibleLeaf bool
		if err := tx.QueryRowContext(ctx, `
SELECT EXISTS (
  SELECT 1
  FROM workspace_agent_sessions s
  WHERE s.deleted_at_unix_ms > 0 AND s.deleted_at_unix_ms <= ?
    AND NOT EXISTS (
      SELECT 1
      FROM workspace_agent_sessions descendant
      WHERE descendant.workspace_id = s.workspace_id
        AND descendant.agent_session_id <> s.agent_session_id
        AND (
          descendant.root_agent_session_id = s.agent_session_id OR
          descendant.parent_agent_session_id = s.agent_session_id
        )
    )
)
`, input.CutoffUnixMS).Scan(&anotherEligibleLeaf); err != nil {
			return PurgeDeletedSessionsResult{}, fmt.Errorf("check for remaining deleted agent sessions: %w", err)
		}
		result.HasMore = result.HasMore || anotherEligibleLeaf
	}
	if err := tx.Commit(); err != nil {
		return PurgeDeletedSessionsResult{}, fmt.Errorf("commit purge deleted agent sessions: %w", err)
	}
	committed = true
	return result, nil
}

func listDeletedSessionPurgeCandidatesTx(
	ctx context.Context,
	tx *sql.Tx,
	cutoffUnixMS int64,
	limit int,
	maxPayloadBytes int64,
) ([]PurgedSession, bool, error) {
	rows, err := tx.QueryContext(ctx, `
SELECT s.workspace_id, s.agent_session_id, s.deleted_at_unix_ms,
       COALESCE((
         SELECT SUM(
           length(CAST(m.payload_json AS BLOB)) +
           length(CAST(m.semantics_json AS BLOB))
         )
         FROM workspace_agent_messages m
         WHERE m.workspace_id = s.workspace_id
           AND m.agent_session_id = s.agent_session_id
       ), 0) AS payload_bytes
FROM workspace_agent_sessions s
WHERE s.deleted_at_unix_ms > 0 AND s.deleted_at_unix_ms <= ?
  AND NOT EXISTS (
    SELECT 1
    FROM workspace_agent_sessions descendant
    WHERE descendant.workspace_id = s.workspace_id
      AND descendant.agent_session_id <> s.agent_session_id
      AND (
        descendant.root_agent_session_id = s.agent_session_id OR
        descendant.parent_agent_session_id = s.agent_session_id
      )
  )
ORDER BY s.deleted_at_unix_ms ASC, s.workspace_id ASC, s.agent_session_id ASC
LIMIT ?
`, cutoffUnixMS, limit+1)
	if err != nil {
		return nil, false, fmt.Errorf("list deleted agent session purge candidates: %w", err)
	}
	defer rows.Close()

	candidates := make([]PurgedSession, 0, limit)
	var payloadBytes int64
	hasMore := false
	for rows.Next() {
		var candidate PurgedSession
		if err := rows.Scan(
			&candidate.WorkspaceID,
			&candidate.AgentSessionID,
			&candidate.DeletedAtUnixMS,
			&candidate.PayloadBytes,
		); err != nil {
			return nil, false, fmt.Errorf("scan deleted agent session purge candidate: %w", err)
		}
		candidate.WorkspaceID = strings.TrimSpace(candidate.WorkspaceID)
		candidate.AgentSessionID = strings.TrimSpace(candidate.AgentSessionID)
		if len(candidates) >= limit || (len(candidates) > 0 && payloadBytes+candidate.PayloadBytes > maxPayloadBytes) {
			hasMore = true
			break
		}
		candidates = append(candidates, candidate)
		payloadBytes += candidate.PayloadBytes
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("iterate deleted agent session purge candidates: %w", err)
	}
	return candidates, hasMore, nil
}

func purgeDeletedSessionTx(
	ctx context.Context,
	tx *sql.Tx,
	candidate PurgedSession,
) (int, bool, error) {
	var hasDescendants bool
	if err := tx.QueryRowContext(ctx, `
SELECT EXISTS (
  SELECT 1
  FROM workspace_agent_sessions
  WHERE workspace_id = ?
    AND agent_session_id <> ?
    AND (root_agent_session_id = ? OR parent_agent_session_id = ?)
)
`, candidate.WorkspaceID, candidate.AgentSessionID, candidate.AgentSessionID, candidate.AgentSessionID).Scan(&hasDescendants); err != nil {
		return 0, false, fmt.Errorf("check deleted agent session descendants: %w", err)
	}
	if hasDescendants {
		return 0, false, nil
	}

	// This no-op update acquires the write lock and proves the exact tombstone
	// still exists before any dependent row is removed.
	fence, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET deleted_at_unix_ms = deleted_at_unix_ms
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = ?
`, candidate.WorkspaceID, candidate.AgentSessionID, candidate.DeletedAtUnixMS)
	if err != nil {
		return 0, false, fmt.Errorf("fence deleted agent session purge: %w", err)
	}
	fenced, err := rowsWereAffected(fence, "fence deleted agent session purge")
	if err != nil || !fenced {
		return 0, false, err
	}

	for _, statement := range []struct {
		name  string
		query string
	}{
		{"submit claims", `DELETE FROM workspace_agent_submit_claims WHERE workspace_id = ? AND agent_session_id = ?`},
		{"runtime operation events", `DELETE FROM workspace_agent_runtime_operation_events WHERE workspace_id = ? AND agent_session_id = ?`},
		{"runtime operations", `DELETE FROM workspace_agent_runtime_operations WHERE workspace_id = ? AND agent_session_id = ?`},
		{"goal provenance", `DELETE FROM workspace_agent_goal_provenance_ledger WHERE workspace_id = ? AND agent_session_id = ?`},
		{"goal reconcile inbox", `DELETE FROM workspace_agent_goal_reconcile_inbox WHERE workspace_id = ? AND agent_session_id = ?`},
		{"goal repair incidents", `DELETE FROM workspace_agent_goal_repair_incidents WHERE workspace_id = ? AND agent_session_id = ?`},
		{"goal operations", `DELETE FROM workspace_agent_goal_control_operations WHERE workspace_id = ? AND agent_session_id = ?`},
		{"goal state", `DELETE FROM workspace_agent_session_goals WHERE workspace_id = ? AND agent_session_id = ?`},
		{"interactions", `DELETE FROM workspace_agent_interactions WHERE workspace_id = ? AND agent_session_id = ?`},
	} {
		if _, err := tx.ExecContext(ctx, statement.query, candidate.WorkspaceID, candidate.AgentSessionID); err != nil {
			return 0, false, fmt.Errorf("purge deleted agent session %s: %w", statement.name, err)
		}
	}
	messageResult, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_messages WHERE workspace_id = ? AND agent_session_id = ?`, candidate.WorkspaceID, candidate.AgentSessionID)
	if err != nil {
		return 0, false, fmt.Errorf("purge deleted agent session messages: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_turns WHERE workspace_id = ? AND agent_session_id = ?`, candidate.WorkspaceID, candidate.AgentSessionID); err != nil {
		return 0, false, fmt.Errorf("purge deleted agent session turns: %w", err)
	}
	sessionResult, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_sessions WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = ?`, candidate.WorkspaceID, candidate.AgentSessionID, candidate.DeletedAtUnixMS)
	if err != nil {
		return 0, false, fmt.Errorf("purge deleted agent session: %w", err)
	}
	removed, err := rowsWereAffected(sessionResult, "purge deleted agent session")
	if err != nil || !removed {
		return 0, false, err
	}
	removedMessages, err := messageResult.RowsAffected()
	if err != nil {
		return 0, false, fmt.Errorf("purge deleted agent session messages rows affected: %w", err)
	}
	return int(removedMessages), true, nil
}
