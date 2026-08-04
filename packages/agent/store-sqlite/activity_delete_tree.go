package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

func expandSessionTreeIDsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	seeds []string,
) ([]string, error) {
	result := make([]string, 0, len(seeds))
	seen := make(map[string]struct{}, len(seeds))
	for _, seed := range seeds {
		rows, err := tx.QueryContext(ctx, `
WITH RECURSIVE session_tree(agent_session_id, depth) AS (
  SELECT agent_session_id, 0
  FROM workspace_agent_sessions
  WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
  UNION ALL
  SELECT child.agent_session_id, parent.depth + 1
  FROM workspace_agent_sessions child
  INNER JOIN session_tree parent
    ON child.parent_agent_session_id = parent.agent_session_id
  WHERE child.workspace_id = ? AND child.session_kind = 'child'
    AND child.deleted_at_unix_ms = 0
)
SELECT agent_session_id
FROM session_tree
ORDER BY depth DESC, agent_session_id ASC
`, workspaceID, strings.TrimSpace(seed), workspaceID)
		if err != nil {
			return nil, fmt.Errorf("resolve workspace agent session tree: %w", err)
		}
		for rows.Next() {
			var sessionID string
			if err := rows.Scan(&sessionID); err != nil {
				rows.Close()
				return nil, fmt.Errorf("scan workspace agent session tree: %w", err)
			}
			sessionID = strings.TrimSpace(sessionID)
			if sessionID == "" {
				continue
			}
			if _, exists := seen[sessionID]; exists {
				continue
			}
			seen[sessionID] = struct{}{}
			result = append(result, sessionID)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, fmt.Errorf("iterate workspace agent session tree: %w", err)
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("close workspace agent session tree: %w", err)
		}
	}
	return result, nil
}

func deleteSessionTreeRowsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	sessionIDs []string,
	now int64,
) (int, int, error) {
	removedMessages := int64(0)
	removedSessions := int64(0)
	for _, agentSessionID := range sessionIDs {
		// A deleted session can never safely recover provider history. Clear only
		// its fence in this same deletion transaction; live unknown fences are
		// intentionally left untouched and are handled by the protocol migration.
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_history
SET recovery_state = 'ready', operation_id = '', updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND recovery_state <> 'ready'
`, now, workspaceID, agentSessionID); err != nil {
			return 0, 0, fmt.Errorf("clear deleted workspace agent session history fence: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_submit_claims WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
			return 0, 0, fmt.Errorf("delete workspace agent session tree submit claims: %w", err)
		}
		messageResult, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_messages
SET deleted_at_unix_ms = ?,
    updated_at_unix_ms = ?,
    turn_id = NULL
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, now, now, workspaceID, agentSessionID)
		if err != nil {
			return 0, 0, fmt.Errorf("delete workspace agent session tree messages: %w", err)
		}
		messageCount, err := messageResult.RowsAffected()
		if err != nil {
			return 0, 0, fmt.Errorf("delete workspace agent session tree messages rows affected: %w", err)
		}
		removedMessages += messageCount
		if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_interactions WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
			return 0, 0, fmt.Errorf("delete workspace agent session tree interactions: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_turn_submissions WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
			return 0, 0, fmt.Errorf("delete workspace agent session tree turn submissions: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_turn_history WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
			return 0, 0, fmt.Errorf("delete workspace agent session tree turn history: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_turns WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
			return 0, 0, fmt.Errorf("delete workspace agent session tree turns: %w", err)
		}
		sessionResult, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET deleted_at_unix_ms = ?,
    updated_at_unix_ms = ?,
    active_turn_id = NULL
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, now, now, workspaceID, agentSessionID)
		if err != nil {
			return 0, 0, fmt.Errorf("delete workspace agent session tree member: %w", err)
		}
		sessionCount, err := sessionResult.RowsAffected()
		if err != nil {
			return 0, 0, fmt.Errorf("delete workspace agent session tree rows affected: %w", err)
		}
		removedSessions += sessionCount
	}
	return int(removedMessages), int(removedSessions), nil
}
