package storesqlite

import (
	"context"
	"fmt"
	"strings"
)

// RollbackRuntimeSessionInitialization removes only an empty runtime-created
// session shell. It is a create-command compensation primitive, not a user
// deletion API: any turn, message, child, or tombstone makes it a no-op.
func (s *Store) RollbackRuntimeSessionInitialization(ctx context.Context, workspaceID, agentSessionID string) (bool, error) {
	workspaceID, agentSessionID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID)
	if s == nil || s.db == nil || workspaceID == "" || agentSessionID == "" {
		return false, nil
	}
	result, err := s.db.ExecContext(ctx, `
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
	return rowsWereAffected(result, "rollback runtime session initialization")
}
