package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

func (s *Store) GetSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (Session, bool, error) {
	if s == nil || s.db == nil {
		return Session{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return Session{}, false, nil
	}
	row := s.db.QueryRowContext(ctx, `
SELECT workspace_id, agent_session_id, session_kind, root_agent_session_id, root_turn_id,
       parent_agent_session_id, parent_turn_id, parent_tool_call_id,
       origin, agent_target_id, provider, provider_session_id, model,
       user_id, settings_json, session_metadata_json, internal_runtime_context_json, cwd,
       rail_section_key,
       title, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, pinned_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms, active_turn_id
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, agentSessionID)
	session, err := scanAgentSession(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Session{}, false, nil
		}
		return Session{}, false, fmt.Errorf("get workspace agent session: %w", err)
	}
	railSection, found, err := s.getAgentSessionRailSection(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, false, err
	}
	if !found {
		return Session{}, false, fmt.Errorf(
			"workspace agent session %q has no rail section",
			agentSessionID,
		)
	}
	session.RailSectionKind = railSection.Kind
	session.RailProjectPath = railSection.ProjectPath
	session.RailSectionKey = railSection.Key
	return session, true, nil
}

func (s *Store) SessionDeleted(
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
	var deletedAtUnixMS int64
	err := s.db.QueryRowContext(ctx, `
SELECT deleted_at_unix_ms
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, agentSessionID).Scan(&deletedAtUnixMS)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("read workspace agent session tombstone: %w", err)
	}
	return deletedAtUnixMS > 0, nil
}

func (s *Store) ListSessions(
	ctx context.Context,
	workspaceID string,
) ([]Session, bool, error) {
	if s == nil || s.db == nil {
		return nil, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil, false, nil
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT workspace_id, agent_session_id, session_kind, root_agent_session_id, root_turn_id,
       parent_agent_session_id, parent_turn_id, parent_tool_call_id,
       origin, agent_target_id, provider, provider_session_id, model,
       user_id, settings_json, session_metadata_json, internal_runtime_context_json, cwd,
       rail_section_key,
       title, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, pinned_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms, active_turn_id
FROM workspace_agent_sessions
WHERE workspace_id = ? AND session_kind = 'root' AND deleted_at_unix_ms = 0
ORDER BY updated_at_unix_ms DESC, agent_session_id ASC
`, workspaceID)
	if err != nil {
		return nil, false, fmt.Errorf("list workspace agent sessions: %w", err)
	}
	defer rows.Close()

	sessions := make([]Session, 0)
	for rows.Next() {
		session, err := scanAgentSession(rows)
		if err != nil {
			return nil, false, err
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("iterate workspace agent sessions: %w", err)
	}
	return sessions, true, nil
}

func (s *Store) ListChildSessions(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) ([]Session, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return []Session{}, nil
	}
	rows, err := s.db.QueryContext(ctx, `
WITH RECURSIVE child_session_ids(agent_session_id) AS (
  SELECT agent_session_id
  FROM workspace_agent_sessions
  WHERE workspace_id = ? AND parent_agent_session_id = ?
    AND session_kind = 'child' AND deleted_at_unix_ms = 0
  UNION ALL
  SELECT child.agent_session_id
  FROM workspace_agent_sessions child
  INNER JOIN child_session_ids parent
    ON child.parent_agent_session_id = parent.agent_session_id
  WHERE child.workspace_id = ? AND child.session_kind = 'child'
    AND child.deleted_at_unix_ms = 0
)
SELECT session.workspace_id, session.agent_session_id, session.session_kind,
       session.root_agent_session_id, session.root_turn_id,
       session.parent_agent_session_id, session.parent_turn_id, session.parent_tool_call_id,
       session.origin, session.agent_target_id, session.provider, session.provider_session_id, session.model,
       session.user_id, session.settings_json, session.session_metadata_json,
       session.internal_runtime_context_json, session.cwd, session.rail_section_key,
       session.title, session.message_version,
       session.last_event_at_unix_ms, session.started_at_unix_ms, session.ended_at_unix_ms,
       session.pinned_at_unix_ms, session.created_at_unix_ms, session.updated_at_unix_ms,
       session.active_turn_id
FROM workspace_agent_sessions session
INNER JOIN child_session_ids child ON child.agent_session_id = session.agent_session_id
WHERE session.workspace_id = ?
ORDER BY session.created_at_unix_ms ASC, session.agent_session_id ASC
`, workspaceID, agentSessionID, workspaceID, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list child workspace agent sessions: %w", err)
	}
	defer rows.Close()
	sessions := make([]Session, 0)
	for rows.Next() {
		session, err := scanAgentSession(rows)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate child workspace agent sessions: %w", err)
	}
	return sessions, nil
}
