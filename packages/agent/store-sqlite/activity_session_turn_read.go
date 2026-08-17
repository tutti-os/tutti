package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// GetSessionAndTurn reads the canonical Session and Turn from one SQLite
// snapshot. A live turn transition updates both rows in one transaction, so
// consumers that publish a cross-entity projection must not compose two
// independent reads across that commit boundary.
func (s *Store) GetSessionAndTurn(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turnID string,
) (Session, Turn, bool, error) {
	if s == nil || s.db == nil {
		return Session{}, Turn{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	turnID = strings.TrimSpace(turnID)
	if workspaceID == "" || agentSessionID == "" || turnID == "" {
		return Session{}, Turn{}, false, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Session{}, Turn{}, false, fmt.Errorf("begin workspace agent session and turn read: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	sessionRow := tx.QueryRowContext(ctx, `
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
	session, err := scanAgentSession(sessionRow)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Session{}, Turn{}, false, nil
		}
		return Session{}, Turn{}, false, fmt.Errorf("get workspace agent session and turn session: %w", err)
	}

	railRow := tx.QueryRowContext(ctx, `
SELECT rail_section_kind, rail_project_path, rail_section_key
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, agentSessionID)
	var rail RailSection
	if err := railRow.Scan(&rail.Kind, &rail.ProjectPath, &rail.Key); err != nil {
		return Session{}, Turn{}, false, fmt.Errorf("get workspace agent session and turn rail section: %w", err)
	}
	rail = normalizeAgentSessionRailSection(rail)
	if !isValidAgentSessionRailSection(rail) {
		return Session{}, Turn{}, false, fmt.Errorf(
			"workspace agent session %q has an invalid rail section",
			agentSessionID,
		)
	}
	session.RailSectionKind = rail.Kind
	session.RailProjectPath = rail.ProjectPath
	session.RailSectionKey = rail.Key

	turn, found, err := getAgentTurnTx(ctx, tx, workspaceID, agentSessionID, turnID)
	if err != nil {
		return Session{}, Turn{}, false, fmt.Errorf("get workspace agent session and turn turn: %w", err)
	}
	if !found {
		return session, Turn{}, false, nil
	}
	return session, turn, true, nil
}
