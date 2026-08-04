package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// RollbackRuntimeSessionInitialization removes only a runtime-created session
// still owned by a failed create command: either an empty shell or the strict
// hidden submitted/failed-Turn shape checked below. It is not a user deletion
// API; observable/provider-accepted activity, children, or tombstones make it
// a no-op.
func (s *Store) RollbackRuntimeSessionInitialization(ctx context.Context, workspaceID, agentSessionID string) (bool, error) {
	workspaceID, agentSessionID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID)
	if s == nil || s.db == nil || workspaceID == "" || agentSessionID == "" {
		return false, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin rollback runtime session initialization: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	mutations, err := sessionDeleteMutationsTx(ctx, tx, workspaceID, []string{agentSessionID}, 0)
	if err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
  AND origin = 'WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME'
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_turns t
    WHERE t.workspace_id = workspace_agent_sessions.workspace_id
      AND t.agent_session_id = workspace_agent_sessions.agent_session_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_messages m
    WHERE m.workspace_id = workspace_agent_sessions.workspace_id
      AND m.agent_session_id = workspace_agent_sessions.agent_session_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_sessions child
    WHERE child.workspace_id = workspace_agent_sessions.workspace_id
      AND child.parent_agent_session_id = workspace_agent_sessions.agent_session_id
  )`, workspaceID, agentSessionID)
	if err != nil {
		return false, fmt.Errorf("rollback runtime session initialization: %w", err)
	}
	removed, err := rowsWereAffected(result, "rollback runtime session initialization")
	if err != nil {
		return false, err
	}
	if !removed {
		removed, err = rollbackProvisionalRuntimeSubmissionTx(
			ctx,
			tx,
			workspaceID,
			agentSessionID,
		)
		if err != nil {
			return false, err
		}
	}
	if removed {
		if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_session_history
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, agentSessionID); err != nil {
			return false, fmt.Errorf("rollback runtime session history initialization: %w", err)
		}
	}
	if !removed {
		mutations = nil
	}
	if _, err := s.commitTransaction(ctx, tx, workspaceID, mutations); err != nil {
		return false, fmt.Errorf("commit rollback runtime session initialization: %w", err)
	}
	committed = true
	return removed, nil
}

// rollbackProvisionalRuntimeSubmissionTx compensates the only non-empty shape
// that CreateSession may still own after provider rejection: one hidden,
// submitted or failed user Turn with no provider identity, message,
// interaction, child, or durable submission envelope. Anything observable or
// provider-accepted remains outside this rollback primitive.
func rollbackProvisionalRuntimeSubmissionTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
) (bool, error) {
	var eligible int
	if err := tx.QueryRowContext(ctx, `
SELECT CASE WHEN
  s.origin = 'WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME'
  AND s.deleted_at_unix_ms = 0
  AND json_extract(s.session_metadata_json, '$.visible') = 0
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_sessions child
    WHERE child.workspace_id = s.workspace_id
      AND child.parent_agent_session_id = s.agent_session_id
      AND child.deleted_at_unix_ms = 0
  )
  AND 1 = (
    SELECT COUNT(*) FROM workspace_agent_turns t
    WHERE t.workspace_id = s.workspace_id
      AND t.agent_session_id = s.agent_session_id
      AND (
        (t.phase = 'submitted' AND t.outcome IS NULL)
        OR (t.phase = 'settled' AND t.outcome = 'failed')
      )
      AND (t.root_provider_turn_id IS NULL OR length(trim(t.root_provider_turn_id)) = 0)
      AND t.provider_turn_binding_json = '{}'
  )
  AND 1 = (
    SELECT COUNT(*) FROM workspace_agent_turns t
    WHERE t.workspace_id = s.workspace_id
      AND t.agent_session_id = s.agent_session_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_messages m
    WHERE m.workspace_id = s.workspace_id
      AND m.agent_session_id = s.agent_session_id
      AND m.deleted_at_unix_ms = 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_interactions i
    WHERE i.workspace_id = s.workspace_id
      AND i.agent_session_id = s.agent_session_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_turn_submissions sub
    WHERE sub.workspace_id = s.workspace_id
      AND sub.agent_session_id = s.agent_session_id
  )
THEN 1 ELSE 0 END
FROM workspace_agent_sessions s
WHERE s.workspace_id = ? AND s.agent_session_id = ?
`, workspaceID, agentSessionID).Scan(&eligible); err != nil {
		if err == sql.ErrNoRows {
			return false, nil
		}
		return false, fmt.Errorf("inspect provisional runtime submission rollback: %w", err)
	}
	if eligible != 1 {
		return false, nil
	}
	for _, statement := range []struct {
		name string
		sql  string
	}{
		{name: "turn history", sql: `DELETE FROM workspace_agent_turn_history WHERE workspace_id = ? AND agent_session_id = ?`},
		{name: "turns", sql: `DELETE FROM workspace_agent_turns WHERE workspace_id = ? AND agent_session_id = ?`},
	} {
		if _, err := tx.ExecContext(ctx, statement.sql, workspaceID, agentSessionID); err != nil {
			return false, fmt.Errorf("rollback provisional runtime submission %s: %w", statement.name, err)
		}
	}
	result, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, agentSessionID)
	if err != nil {
		return false, fmt.Errorf("rollback provisional runtime submission session: %w", err)
	}
	return rowsWereAffected(result, "rollback provisional runtime submission session")
}
