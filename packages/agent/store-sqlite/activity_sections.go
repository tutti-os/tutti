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
	totalCount, err := s.countVisibleSessionSectionRows(
		ctx,
		workspaceID,
		sectionKey,
		agentTargetID,
		true,
	)
	if err != nil {
		return SessionSectionPage{}, false, err
	}
	limit := input.Limit
	queryLimit := 0
	if limit > 0 {
		queryLimit = limit + 1
	}
	if sectionKey == PinnedSessionPageKey {
		return s.listPinnedSessionPage(
			ctx,
			input,
			workspaceID,
			agentTargetID,
			limit,
			queryLimit,
			totalCount,
		)
	}
	query := `
WITH section_sessions AS (
  SELECT workspace_agent_sessions.*,
         COALESCE(
           NULLIF((
             SELECT latest.started_at_unix_ms
             FROM workspace_agent_turns latest
             WHERE latest.workspace_id = workspace_agent_sessions.workspace_id
               AND latest.agent_session_id = workspace_agent_sessions.agent_session_id
             ORDER BY latest.updated_at_unix_ms DESC, latest.created_at_unix_ms DESC,
                      latest.started_at_unix_ms DESC, latest.turn_id DESC
             LIMIT 1
           ), 0),
           workspace_agent_sessions.created_at_unix_ms
         ) AS conversation_sort_time_unix_ms
  FROM workspace_agent_sessions
  WHERE workspace_id = ?
    AND rail_section_key = ?
    AND pinned_at_unix_ms = 0
    AND (? = '' OR agent_target_id = ?)
    AND deleted_at_unix_ms = 0
    AND json_extract(session_metadata_json, '$.visible') IS NOT 0
)
SELECT workspace_id, agent_session_id, origin, agent_target_id, provider, provider_session_id, model,
       user_id, settings_json, session_metadata_json, internal_runtime_context_json, cwd,
	       title, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, pinned_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms, active_turn_id,
       conversation_sort_time_unix_ms
FROM section_sessions
WHERE (? = '' OR conversation_sort_time_unix_ms < ? OR (conversation_sort_time_unix_ms = ? AND agent_session_id > ?))
ORDER BY conversation_sort_time_unix_ms DESC, agent_session_id ASC`
	args := []any{
		workspaceID,
		sectionKey,
		agentTargetID,
		agentTargetID,
		strings.TrimSpace(input.CursorSessionID),
		input.CursorSortTimeUnixMS,
		input.CursorSortTimeUnixMS,
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
	sortTimesUnixMS := make([]int64, 0)
	for rows.Next() {
		session, sortTimeUnixMS, err := scanAgentSessionWithSortTime(rows)
		if err != nil {
			return SessionSectionPage{}, false, err
		}
		sessions = append(sessions, session)
		sortTimesUnixMS = append(sortTimesUnixMS, sortTimeUnixMS)
	}
	if err := rows.Err(); err != nil {
		return SessionSectionPage{}, false, fmt.Errorf("iterate workspace agent session section: %w", err)
	}

	hasMore := false
	if limit > 0 && len(sessions) > limit {
		hasMore = true
		sessions = sessions[:limit]
		sortTimesUnixMS = sortTimesUnixMS[:limit]
	}
	nextCursor := ""
	if hasMore && len(sessions) > 0 {
		last := sessions[len(sessions)-1]
		nextCursor = strconv.FormatInt(sortTimesUnixMS[len(sortTimesUnixMS)-1], 10) + "|" + strings.TrimSpace(last.ID)
	}
	return SessionSectionPage{
		WorkspaceID: workspaceID,
		SectionKey:  sectionKey,
		Sessions:    sessions,
		HasMore:     hasMore,
		TotalCount:  totalCount,
		NextCursor:  nextCursor,
	}, true, nil
}

func (s *Store) ListSessionSectionDeletionCandidates(
	ctx context.Context,
	input ListSessionSectionDeletionCandidatesInput,
) (SessionSectionDeletionCandidates, bool, error) {
	if s == nil || s.db == nil {
		return SessionSectionDeletionCandidates{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	sectionKey := strings.TrimSpace(input.SectionKey)
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	if workspaceID == "" || sectionKey == "" || sectionKey == PinnedSessionPageKey {
		return SessionSectionDeletionCandidates{}, false, nil
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT agent_session_id
FROM workspace_agent_sessions
WHERE workspace_id = ?
  AND rail_section_key = ?
  AND (? = '' OR agent_target_id = ?)
  AND (? = 0 OR pinned_at_unix_ms = 0)
  AND deleted_at_unix_ms = 0
  AND json_extract(session_metadata_json, '$.visible') IS NOT 0
ORDER BY updated_at_unix_ms DESC, agent_session_id ASC
`, workspaceID, sectionKey, agentTargetID, agentTargetID, input.ExcludePinned)
	if err != nil {
		return SessionSectionDeletionCandidates{}, false, fmt.Errorf("list workspace agent session section deletion candidates: %w", err)
	}
	defer rows.Close()

	sessionIDs := make([]string, 0)
	for rows.Next() {
		var sessionID string
		if err := rows.Scan(&sessionID); err != nil {
			return SessionSectionDeletionCandidates{}, false, fmt.Errorf("scan workspace agent session section deletion candidate: %w", err)
		}
		if sessionID = strings.TrimSpace(sessionID); sessionID != "" {
			sessionIDs = append(sessionIDs, sessionID)
		}
	}
	if err := rows.Err(); err != nil {
		return SessionSectionDeletionCandidates{}, false, fmt.Errorf("iterate workspace agent session section deletion candidates: %w", err)
	}
	return SessionSectionDeletionCandidates{
		WorkspaceID:   workspaceID,
		SectionKey:    sectionKey,
		AgentTargetID: agentTargetID,
		ExcludePinned: input.ExcludePinned,
		SessionIDs:    sessionIDs,
	}, true, nil
}

func (s *Store) listPinnedSessionPage(
	ctx context.Context,
	input ListSessionSectionInput,
	workspaceID string,
	agentTargetID string,
	limit int,
	queryLimit int,
	totalCount int,
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
		input.CursorSortTimeUnixMS,
		input.CursorSortTimeUnixMS,
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
		TotalCount:  totalCount,
		NextCursor:  nextCursor,
	}, true, nil
}

func (s *Store) countVisibleSessionSectionRows(
	ctx context.Context,
	workspaceID string,
	sectionKey string,
	agentTargetID string,
	excludePinned bool,
) (int, error) {
	sectionPredicate := "rail_section_key = ?"
	if sectionKey == PinnedSessionPageKey {
		sectionPredicate = "pinned_at_unix_ms > 0"
	} else if excludePinned {
		sectionPredicate += " AND pinned_at_unix_ms = 0"
	}
	query := `
SELECT COUNT(1)
FROM workspace_agent_sessions
WHERE workspace_id = ?
  AND ` + sectionPredicate + `
  AND (? = '' OR agent_target_id = ?)
  AND deleted_at_unix_ms = 0
  AND json_extract(session_metadata_json, '$.visible') IS NOT 0`
	args := []any{workspaceID}
	if sectionKey != PinnedSessionPageKey {
		args = append(args, sectionKey)
	}
	args = append(args, agentTargetID, agentTargetID)
	var count int
	if err := s.db.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return 0, fmt.Errorf("count workspace agent session section rows: %w", err)
	}
	return count, nil
}
