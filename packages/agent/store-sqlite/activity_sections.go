package storesqlite

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

func (s *Store) ListSessionSection(
	ctx context.Context,
	input ListSessionSectionInput,
) (SessionSectionPage, bool, error) {
	if s == nil || s.db == nil {
		return SessionSectionPage{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	sectionKey := strings.TrimSpace(input.SectionKey)
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	if workspaceID == "" || sectionKey == "" {
		return SessionSectionPage{}, false, nil
	}
	limit := input.Limit
	queryLimit := 0
	if limit > 0 {
		queryLimit = limit + 1
	}
	if sectionKey == PinnedSessionPageKey {
		return s.listPinnedSessionPage(ctx, input, workspaceID, agentTargetID, limit, queryLimit)
	}
	query := `
SELECT workspace_id, agent_session_id, origin, agent_target_id, provider, provider_session_id, model,
       user_id, settings_json, session_metadata_json, internal_runtime_context_json, cwd,
	       title, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, pinned_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms, active_turn_id
FROM workspace_agent_sessions
WHERE workspace_id = ?
  AND rail_section_key = ?
  AND (? = '' OR agent_target_id = ?)
  AND deleted_at_unix_ms = 0
  AND json_extract(session_metadata_json, '$.visible') IS NOT 0
  AND (? = '' OR updated_at_unix_ms < ? OR (updated_at_unix_ms = ? AND agent_session_id > ?))
ORDER BY updated_at_unix_ms DESC, agent_session_id ASC`
	args := []any{
		workspaceID,
		sectionKey,
		agentTargetID,
		agentTargetID,
		strings.TrimSpace(input.CursorSessionID),
		input.CursorUpdatedAtMS,
		input.CursorUpdatedAtMS,
		strings.TrimSpace(input.CursorSessionID),
	}
	if queryLimit > 0 {
		query += "\nLIMIT ?"
		args = append(args, queryLimit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return SessionSectionPage{}, false, fmt.Errorf("list workspace agent session section: %w", err)
	}
	defer rows.Close()

	sessions := make([]Session, 0)
	for rows.Next() {
		session, err := scanAgentSession(rows)
		if err != nil {
			return SessionSectionPage{}, false, err
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return SessionSectionPage{}, false, fmt.Errorf("iterate workspace agent session section: %w", err)
	}

	hasMore := false
	if limit > 0 && len(sessions) > limit {
		hasMore = true
		sessions = sessions[:limit]
	}
	nextCursor := ""
	if hasMore && len(sessions) > 0 {
		last := sessions[len(sessions)-1]
		nextCursor = strconv.FormatInt(last.UpdatedAtUnixMS, 10) + "|" + strings.TrimSpace(last.ID)
	}
	return SessionSectionPage{
		WorkspaceID: workspaceID,
		SectionKey:  sectionKey,
		Sessions:    sessions,
		HasMore:     hasMore,
		NextCursor:  nextCursor,
	}, true, nil
}

func (s *Store) listPinnedSessionPage(
	ctx context.Context,
	input ListSessionSectionInput,
	workspaceID string,
	agentTargetID string,
	limit int,
	queryLimit int,
) (SessionSectionPage, bool, error) {
	query := `
SELECT workspace_id, agent_session_id, origin, agent_target_id, provider, provider_session_id, model,
       user_id, settings_json, session_metadata_json, internal_runtime_context_json, cwd,
	       title, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, pinned_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms, active_turn_id
FROM workspace_agent_sessions
WHERE workspace_id = ?
  AND pinned_at_unix_ms > 0
  AND (? = '' OR agent_target_id = ?)
  AND deleted_at_unix_ms = 0
  AND json_extract(session_metadata_json, '$.visible') IS NOT 0
  AND (? = '' OR pinned_at_unix_ms < ? OR (pinned_at_unix_ms = ? AND agent_session_id > ?))
ORDER BY pinned_at_unix_ms DESC, agent_session_id ASC`
	args := []any{
		workspaceID,
		agentTargetID,
		agentTargetID,
		strings.TrimSpace(input.CursorSessionID),
		input.CursorUpdatedAtMS,
		input.CursorUpdatedAtMS,
		strings.TrimSpace(input.CursorSessionID),
	}
	if queryLimit > 0 {
		query += "\nLIMIT ?"
		args = append(args, queryLimit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return SessionSectionPage{}, false, fmt.Errorf("list pinned workspace agent sessions: %w", err)
	}
	defer rows.Close()

	sessions := make([]Session, 0)
	for rows.Next() {
		session, err := scanAgentSession(rows)
		if err != nil {
			return SessionSectionPage{}, false, err
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return SessionSectionPage{}, false, fmt.Errorf("iterate pinned workspace agent sessions: %w", err)
	}

	hasMore := false
	if limit > 0 && len(sessions) > limit {
		hasMore = true
		sessions = sessions[:limit]
	}
	nextCursor := ""
	if hasMore && len(sessions) > 0 {
		last := sessions[len(sessions)-1]
		nextCursor = strconv.FormatInt(last.PinnedAtUnixMS, 10) + "|" + strings.TrimSpace(last.ID)
	}
	return SessionSectionPage{
		WorkspaceID: workspaceID,
		SectionKey:  PinnedSessionPageKey,
		Sessions:    sessions,
		HasMore:     hasMore,
		NextCursor:  nextCursor,
	}, true, nil
}
