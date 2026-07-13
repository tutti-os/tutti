package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (s *Store) DeleteSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (bool, error) {
	if s == nil || s.db == nil {
		return false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return false, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin delete workspace agent session: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	now := unixMs(time.Now().UTC())
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET deleted_at_unix_ms = ?,
    updated_at_unix_ms = ?,
    active_turn_id = NULL
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, now, now, workspaceID, agentSessionID)
	if err != nil {
		return false, fmt.Errorf("delete workspace agent session: %w", err)
	}
	removed, err := rowsWereAffected(result, "delete workspace agent session")
	if err != nil {
		return false, err
	}
	if removed {
		if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_submit_claims WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
			return false, fmt.Errorf("delete workspace agent submit claims: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_messages
SET deleted_at_unix_ms = ?,
    updated_at_unix_ms = ?,
    turn_id = NULL
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, now, now, workspaceID, agentSessionID); err != nil {
			return false, fmt.Errorf("delete workspace agent session messages: %w", err)
		}
		// Turn and interaction rows are hard-deleted with the session so
		// startup reconciliation never settles turns of deleted sessions.
		if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_interactions
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, agentSessionID); err != nil {
			return false, fmt.Errorf("delete workspace agent session interactions: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_turns
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, agentSessionID); err != nil {
			return false, fmt.Errorf("delete workspace agent session turns: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit delete workspace agent session: %w", err)
	}
	committed = true
	return removed, nil
}

func (s *Store) CountSessionSection(
	ctx context.Context,
	input CountSessionSectionInput,
) (SessionSectionCount, bool, error) {
	if s == nil || s.db == nil {
		return SessionSectionCount{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	sectionKey := strings.TrimSpace(input.SectionKey)
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	if workspaceID == "" || sectionKey == "" || sectionKey == PinnedSessionPageKey {
		return SessionSectionCount{}, false, nil
	}
	var count int
	if err := s.db.QueryRowContext(ctx, `
SELECT COUNT(1)
FROM workspace_agent_sessions
WHERE workspace_id = ?
  AND rail_section_key = ?
  AND (? = '' OR agent_target_id = ?)
  AND deleted_at_unix_ms = 0
  AND json_extract(session_metadata_json, '$.visible') IS NOT 0
`, workspaceID, sectionKey, agentTargetID, agentTargetID).Scan(&count); err != nil {
		return SessionSectionCount{}, false, fmt.Errorf("count workspace agent session section: %w", err)
	}
	return SessionSectionCount{
		WorkspaceID:   workspaceID,
		SectionKey:    sectionKey,
		AgentTargetID: agentTargetID,
		Count:         count,
	}, true, nil
}

func (s *Store) DeleteSessionSection(
	ctx context.Context,
	input DeleteSessionSectionInput,
) (DeleteSessionSectionResult, bool, error) {
	if s == nil || s.db == nil {
		return DeleteSessionSectionResult{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	sectionKey := strings.TrimSpace(input.SectionKey)
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	if workspaceID == "" || sectionKey == "" || sectionKey == PinnedSessionPageKey {
		return DeleteSessionSectionResult{}, false, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DeleteSessionSectionResult{}, false, fmt.Errorf("begin delete workspace agent session section: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	removedSessionIDs, err := listAgentSessionSectionIDsTx(ctx, tx, workspaceID, sectionKey, agentTargetID)
	if err != nil {
		return DeleteSessionSectionResult{}, false, err
	}
	now := unixMs(time.Now().UTC())
	removedMessages := int64(0)
	for _, agentSessionID := range removedSessionIDs {
		if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_submit_claims WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
			return DeleteSessionSectionResult{}, false, fmt.Errorf("delete workspace agent session section submit claims: %w", err)
		}
		messageResult, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_messages
SET deleted_at_unix_ms = ?,
    updated_at_unix_ms = ?,
    turn_id = NULL
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, now, now, workspaceID, agentSessionID)
		if err != nil {
			return DeleteSessionSectionResult{}, false, fmt.Errorf("delete workspace agent session section messages: %w", err)
		}
		messageCount, err := messageResult.RowsAffected()
		if err != nil {
			return DeleteSessionSectionResult{}, false, fmt.Errorf("delete workspace agent session section messages rows affected: %w", err)
		}
		removedMessages += messageCount
		if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_interactions WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
			return DeleteSessionSectionResult{}, false, fmt.Errorf("delete workspace agent session section interactions: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_turns WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
			return DeleteSessionSectionResult{}, false, fmt.Errorf("delete workspace agent session section turns: %w", err)
		}
	}

	sessionResult, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET deleted_at_unix_ms = ?,
    updated_at_unix_ms = ?,
    active_turn_id = NULL
WHERE workspace_id = ?
  AND rail_section_key = ?
  AND (? = '' OR agent_target_id = ?)
  AND deleted_at_unix_ms = 0
  AND json_extract(session_metadata_json, '$.visible') IS NOT 0
`, now, now, workspaceID, sectionKey, agentTargetID, agentTargetID)
	if err != nil {
		return DeleteSessionSectionResult{}, false, fmt.Errorf("delete workspace agent session section: %w", err)
	}
	removedSessions, err := sessionResult.RowsAffected()
	if err != nil {
		return DeleteSessionSectionResult{}, false, fmt.Errorf("delete workspace agent session section rows affected: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return DeleteSessionSectionResult{}, false, fmt.Errorf("commit delete workspace agent session section: %w", err)
	}
	committed = true
	return DeleteSessionSectionResult{
		WorkspaceID:       workspaceID,
		SectionKey:        sectionKey,
		AgentTargetID:     agentTargetID,
		RemovedMessages:   int(removedMessages),
		RemovedSessions:   int(removedSessions),
		RemovedSessionIDs: removedSessionIDs,
	}, true, nil
}

func (s *Store) ClearSessions(
	ctx context.Context,
	workspaceID string,
) (ClearSessionsResult, error) {
	if s == nil || s.db == nil {
		return ClearSessionsResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return ClearSessionsResult{}, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("begin clear workspace agent sessions: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	result, err := s.ClearSessionsTx(ctx, tx, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("commit clear workspace agent sessions: %w", err)
	}
	committed = true
	return result, nil
}

// ClearSessionsTx hard-deletes a workspace's sessions and messages within
// the caller's transaction. Hosts that delete a workspace of their own and
// need the agent-row cascade to be atomic with that deletion should run
// both through one transaction via this method; the caller owns commit and
// rollback.
func (s *Store) ClearSessionsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
) (ClearSessionsResult, error) {
	if s == nil || tx == nil {
		return ClearSessionsResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return ClearSessionsResult{}, nil
	}

	removedSessionIDs, err := listAgentSessionIDsTx(ctx, tx, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, err
	}
	messageResult, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_messages
WHERE workspace_id = ?
`, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent messages: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_submit_claims WHERE workspace_id = ?`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent submit claims: %w", err)
	}
	// Explicit deletes rather than FK cascades: SQLite only cascades with
	// PRAGMA foreign_keys enabled, which hosts do not guarantee.
	if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_interactions
WHERE workspace_id = ?
`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent interactions: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_turns
WHERE workspace_id = ?
`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent turns: %w", err)
	}
	sessionResult, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_sessions
WHERE workspace_id = ?
`, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent sessions: %w", err)
	}
	removedMessages, err := messageResult.RowsAffected()
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent messages rows affected: %w", err)
	}
	removedSessions, err := sessionResult.RowsAffected()
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent sessions rows affected: %w", err)
	}
	return ClearSessionsResult{
		RemovedMessages:   int(removedMessages),
		RemovedSessions:   int(removedSessions),
		RemovedSessionIDs: removedSessionIDs,
	}, nil
}

func listAgentSessionIDsTx(ctx context.Context, tx *sql.Tx, workspaceID string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `
SELECT agent_session_id
FROM workspace_agent_sessions
WHERE workspace_id = ?
ORDER BY updated_at_unix_ms DESC, agent_session_id ASC
`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list workspace agent sessions for clear: %w", err)
	}
	defer rows.Close()

	sessionIDs := make([]string, 0)
	for rows.Next() {
		var sessionID string
		if err := rows.Scan(&sessionID); err != nil {
			return nil, fmt.Errorf("scan workspace agent session id for clear: %w", err)
		}
		sessionID = strings.TrimSpace(sessionID)
		if sessionID != "" {
			sessionIDs = append(sessionIDs, sessionID)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace agent session ids for clear: %w", err)
	}
	return sessionIDs, nil
}

func listAgentSessionSectionIDsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	sectionKey string,
	agentTargetID string,
) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `
SELECT agent_session_id
FROM workspace_agent_sessions
WHERE workspace_id = ?
  AND rail_section_key = ?
  AND (? = '' OR agent_target_id = ?)
  AND deleted_at_unix_ms = 0
  AND json_extract(session_metadata_json, '$.visible') IS NOT 0
ORDER BY updated_at_unix_ms DESC, agent_session_id ASC
`, workspaceID, sectionKey, agentTargetID, agentTargetID)
	if err != nil {
		return nil, fmt.Errorf("list workspace agent session section ids: %w", err)
	}
	defer rows.Close()

	sessionIDs := make([]string, 0)
	for rows.Next() {
		var sessionID string
		if err := rows.Scan(&sessionID); err != nil {
			return nil, fmt.Errorf("scan workspace agent session section id: %w", err)
		}
		if sessionID = strings.TrimSpace(sessionID); sessionID != "" {
			sessionIDs = append(sessionIDs, sessionID)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace agent session section ids: %w", err)
	}
	return sessionIDs, nil
}
