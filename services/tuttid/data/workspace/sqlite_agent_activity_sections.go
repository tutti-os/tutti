package workspace

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func (s *SQLiteStore) ListSessionSection(
	ctx context.Context,
	input agentactivitybiz.ListSessionSectionInput,
) (agentactivitybiz.SessionSectionPage, bool, error) {
	if s == nil || s.db == nil {
		return agentactivitybiz.SessionSectionPage{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	sectionKey := strings.TrimSpace(input.SectionKey)
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	if workspaceID == "" || sectionKey == "" {
		return agentactivitybiz.SessionSectionPage{}, false, nil
	}
	limit := input.Limit
	queryLimit := 0
	if limit > 0 {
		queryLimit = limit + 1
	}
	query := `
SELECT workspace_id, agent_session_id, origin, agent_target_id, provider, provider_session_id, model,
       settings_json, runtime_context_json, cwd,
       title, status, current_phase, last_error, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, pinned_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_sessions
WHERE workspace_id = ?
  AND rail_section_key = ?
  AND (? = '' OR agent_target_id = ?)
  AND deleted_at_unix_ms = 0
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
		return agentactivitybiz.SessionSectionPage{}, false, fmt.Errorf("list workspace agent session section: %w", err)
	}
	defer rows.Close()

	sessions := make([]agentactivitybiz.Session, 0)
	for rows.Next() {
		session, err := scanAgentSession(rows)
		if err != nil {
			return agentactivitybiz.SessionSectionPage{}, false, err
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return agentactivitybiz.SessionSectionPage{}, false, fmt.Errorf("iterate workspace agent session section: %w", err)
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
	return agentactivitybiz.SessionSectionPage{
		WorkspaceID: workspaceID,
		SectionKey:  sectionKey,
		Sessions:    sessions,
		HasMore:     hasMore,
		NextCursor:  nextCursor,
	}, true, nil
}
