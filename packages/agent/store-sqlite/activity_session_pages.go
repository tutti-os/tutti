package storesqlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// ListSessionsPage reads the canonical root-session search projection with the
// same stable conversation cursor used by rail section pages. A non-nil
// IncludedSessionIDs slice lets a composing host constrain the query to its
// authorized session set without reimplementing search, ordering, or paging.
func (s *Store) ListSessionsPage(
	ctx context.Context,
	input ListSessionsPageInput,
) (SessionListPage, bool, error) {
	if s == nil || s.db == nil {
		return SessionListPage{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if workspaceID == "" {
		return SessionListPage{}, false, nil
	}

	predicates := []string{
		"workspace_id = ?",
		"session_kind = 'root'",
		"deleted_at_unix_ms = 0",
		"json_extract(session_metadata_json, '$.visible') IS NOT 0",
	}
	args := []any{workspaceID}
	if agentTargetID := strings.TrimSpace(input.AgentTargetID); agentTargetID != "" {
		predicates = append(predicates, "agent_target_id = ?")
		args = append(args, agentTargetID)
	}
	if includedPredicate, includedArgs, err := includedSessionIDsPredicate("agent_session_id", input.IncludedSessionIDs); err != nil {
		return SessionListPage{}, false, err
	} else if includedPredicate != "" {
		predicates = append(predicates, strings.TrimSpace(strings.TrimPrefix(includedPredicate, "AND ")))
		args = append(args, includedArgs...)
	}
	for _, token := range strings.Fields(strings.ToLower(input.SearchQuery)) {
		predicates = append(predicates, "LOWER(title) LIKE ? ESCAPE '\\'")
		args = append(args, "%"+escapeSessionSearchLikeToken(token)+"%")
	}

	query := `
WITH session_rows AS (
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
           NULLIF(workspace_agent_sessions.started_at_unix_ms, 0),
           workspace_agent_sessions.created_at_unix_ms
         ) AS conversation_sort_time_unix_ms
  FROM workspace_agent_sessions
  WHERE ` + strings.Join(predicates, "\n    AND ") + `
)
SELECT workspace_id, agent_session_id, session_kind, root_agent_session_id, root_turn_id,
       parent_agent_session_id, parent_turn_id, parent_tool_call_id,
       origin, agent_target_id, provider, provider_session_id, model,
       user_id, settings_json, session_metadata_json, internal_runtime_context_json, cwd,
       rail_section_key,
       title, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, pinned_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms, active_turn_id,
       conversation_sort_time_unix_ms
FROM session_rows
WHERE (? = '' OR conversation_sort_time_unix_ms < ? OR (conversation_sort_time_unix_ms = ? AND agent_session_id > ?))
ORDER BY conversation_sort_time_unix_ms DESC, agent_session_id ASC`
	cursorSessionID := strings.TrimSpace(input.CursorSessionID)
	args = append(args, cursorSessionID, input.CursorSortTimeUnixMS, input.CursorSortTimeUnixMS, cursorSessionID)
	queryLimit := 0
	if input.Limit > 0 {
		queryLimit = input.Limit + 1
		query += "\nLIMIT ?"
		args = append(args, queryLimit)
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return SessionListPage{}, false, fmt.Errorf("list workspace agent sessions page: %w", err)
	}
	defer rows.Close()

	sessions := make([]Session, 0)
	sortTimesUnixMS := make([]int64, 0)
	for rows.Next() {
		session, sortTimeUnixMS, err := scanAgentSessionWithSortTime(rows)
		if err != nil {
			return SessionListPage{}, false, err
		}
		sessions = append(sessions, session)
		sortTimesUnixMS = append(sortTimesUnixMS, sortTimeUnixMS)
	}
	if err := rows.Err(); err != nil {
		return SessionListPage{}, false, fmt.Errorf("iterate workspace agent sessions page: %w", err)
	}

	hasMore := false
	if input.Limit > 0 && len(sessions) > input.Limit {
		hasMore = true
		sessions = sessions[:input.Limit]
		sortTimesUnixMS = sortTimesUnixMS[:input.Limit]
	}
	nextCursor := ""
	if hasMore && len(sessions) > 0 {
		lastIndex := len(sessions) - 1
		nextCursor = strconv.FormatInt(sortTimesUnixMS[lastIndex], 10) + "|" + strings.TrimSpace(sessions[lastIndex].ID)
	}
	return SessionListPage{
		WorkspaceID: workspaceID,
		Sessions:    sessions,
		HasMore:     hasMore,
		NextCursor:  nextCursor,
	}, true, nil
}

func escapeSessionSearchLikeToken(value string) string {
	replacer := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_")
	return replacer.Replace(value)
}

func includedSessionIDsPredicate(column string, sessionIDs []string) (string, []any, error) {
	if sessionIDs == nil {
		return "", nil, nil
	}
	includedJSON, err := json.Marshal(normalizedSessionIDs(sessionIDs))
	if err != nil {
		return "", nil, fmt.Errorf("encode included workspace agent session ids: %w", err)
	}
	return "AND " + column + " IN (SELECT CAST(value AS TEXT) FROM json_each(?))", []any{string(includedJSON)}, nil
}
