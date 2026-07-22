package storesqlite

import (
	"context"
	"encoding/json"
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
		input.IncludedSessionIDs,
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
	indexName := "idx_workspace_agent_sessions_rail_section_page"
	targetPredicate := ""
	args := []any{workspaceID, sectionKey}
	if agentTargetID != "" {
		indexName = "idx_workspace_agent_sessions_rail_section_target_page"
		targetPredicate = "AND agent_target_id = ?"
		args = append(args, agentTargetID)
	}
	includedPredicate, includedArgs, err := includedSessionIDsPredicate("agent_session_id", input.IncludedSessionIDs)
	if err != nil {
		return SessionSectionPage{}, false, err
	}
	args = append(args, includedArgs...)
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
           NULLIF(workspace_agent_sessions.started_at_unix_ms, 0),
           workspace_agent_sessions.created_at_unix_ms
         ) AS conversation_sort_time_unix_ms
  FROM workspace_agent_sessions INDEXED BY ` + indexName + `
  WHERE workspace_id = ?
    AND session_kind = 'root'
    AND rail_section_key = ?
    AND pinned_at_unix_ms = 0
    ` + targetPredicate + `
    ` + includedPredicate + `
    AND deleted_at_unix_ms = 0
    AND json_extract(session_metadata_json, '$.visible') IS NOT 0
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
FROM section_sessions
WHERE (? = '' OR conversation_sort_time_unix_ms < ? OR (conversation_sort_time_unix_ms = ? AND agent_session_id > ?))
ORDER BY conversation_sort_time_unix_ms DESC, agent_session_id ASC`
	args = append(args,
		strings.TrimSpace(input.CursorSessionID),
		input.CursorSortTimeUnixMS,
		input.CursorSortTimeUnixMS,
		strings.TrimSpace(input.CursorSessionID),
	)
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

// ListSessionSections loads the first page and total for every requested rail
// section with one SQLite query. Pinned sessions are assigned exclusively to
// the synthetic pinned page; ordinary project and Chats pages exclude them.
func (s *Store) ListSessionSections(
	ctx context.Context,
	input ListSessionSectionsInput,
) (SessionSectionsPage, bool, error) {
	if s == nil || s.db == nil {
		return SessionSectionsPage{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	sectionKeys := normalizeSessionSectionKeys(input.SectionKeys)
	if workspaceID == "" || len(sectionKeys) == 0 || input.LimitPerSection <= 0 {
		return SessionSectionsPage{}, false, nil
	}
	query, args, err := buildListSessionSectionsQuery(ListSessionSectionsInput{
		WorkspaceID:        workspaceID,
		SectionKeys:        sectionKeys,
		AgentTargetID:      strings.TrimSpace(input.AgentTargetID),
		IncludedSessionIDs: input.IncludedSessionIDs,
		LimitPerSection:    input.LimitPerSection,
	})
	if err != nil {
		return SessionSectionsPage{}, false, err
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return SessionSectionsPage{}, false, fmt.Errorf("list workspace agent session sections: %w", err)
	}
	defer rows.Close()

	type sectionAccumulator struct {
		page      SessionSectionPage
		sortTimes []int64
	}
	accumulators := make(map[string]*sectionAccumulator, len(sectionKeys))
	for _, sectionKey := range sectionKeys {
		accumulators[sectionKey] = &sectionAccumulator{page: SessionSectionPage{
			WorkspaceID: workspaceID,
			SectionKey:  sectionKey,
			Sessions:    []Session{},
		}}
	}
	for rows.Next() {
		var sectionKey string
		var sortTimeUnixMS int64
		var totalCount int
		session, err := scanAgentSessionWithTrailingValues(
			rows,
			&sectionKey,
			&sortTimeUnixMS,
			&totalCount,
		)
		if err != nil {
			return SessionSectionsPage{}, false, err
		}
		sectionKey = strings.TrimSpace(sectionKey)
		accumulator := accumulators[sectionKey]
		if accumulator == nil {
			return SessionSectionsPage{}, false, fmt.Errorf("list workspace agent session sections: unexpected section %q", sectionKey)
		}
		accumulator.page.Sessions = append(accumulator.page.Sessions, session)
		accumulator.page.TotalCount = totalCount
		accumulator.sortTimes = append(accumulator.sortTimes, sortTimeUnixMS)
	}
	if err := rows.Err(); err != nil {
		return SessionSectionsPage{}, false, fmt.Errorf("iterate workspace agent session sections: %w", err)
	}

	sections := make([]SessionSectionPage, 0, len(sectionKeys))
	for _, sectionKey := range sectionKeys {
		accumulator := accumulators[sectionKey]
		accumulator.page.HasMore = accumulator.page.TotalCount > len(accumulator.page.Sessions)
		if accumulator.page.HasMore && len(accumulator.page.Sessions) > 0 {
			lastIndex := len(accumulator.page.Sessions) - 1
			accumulator.page.NextCursor = strconv.FormatInt(accumulator.sortTimes[lastIndex], 10) + "|" + strings.TrimSpace(accumulator.page.Sessions[lastIndex].ID)
		}
		sections = append(sections, accumulator.page)
	}
	return SessionSectionsPage{
		WorkspaceID: workspaceID,
		Sections:    sections,
	}, true, nil
}

func buildListSessionSectionsQuery(input ListSessionSectionsInput) (string, []any, error) {
	sectionKeysJSON, err := json.Marshal(input.SectionKeys)
	if err != nil {
		return "", nil, fmt.Errorf("encode workspace agent session section keys: %w", err)
	}
	pinnedIndex := "idx_workspace_agent_sessions_pinned_page"
	ordinaryIndex := "idx_workspace_agent_sessions_rail_section_page"
	targetPredicate := ""
	if input.AgentTargetID != "" {
		pinnedIndex = "idx_workspace_agent_sessions_pinned_target_page"
		ordinaryIndex = "idx_workspace_agent_sessions_rail_section_target_page"
		targetPredicate = "AND sessions.agent_target_id = ?"
	}
	includedPredicate, includedArgs, err := includedSessionIDsPredicate("sessions.agent_session_id", input.IncludedSessionIDs)
	if err != nil {
		return "", nil, err
	}
	query := `
WITH requested_sections(section_key) AS MATERIALIZED (
  SELECT TRIM(CAST(value AS TEXT))
  FROM json_each(?)
), section_pages AS MATERIALIZED (
  SELECT requested_sections.section_key AS requested_section_key,
         CASE requested_sections.section_key
           WHEN 'pinned' THEN (
             SELECT COUNT(1)
             FROM workspace_agent_sessions AS sessions INDEXED BY {{PINNED_INDEX}}
             WHERE sessions.workspace_id = ?
               AND sessions.session_kind = 'root'
               AND sessions.pinned_at_unix_ms > 0
               {{TARGET_PREDICATE}}
               {{INCLUDED_PREDICATE}}
               AND sessions.deleted_at_unix_ms = 0
               AND json_extract(sessions.session_metadata_json, '$.visible') IS NOT 0
           )
           ELSE (
             SELECT COUNT(1)
             FROM workspace_agent_sessions AS sessions INDEXED BY {{ORDINARY_INDEX}}
             WHERE sessions.workspace_id = ?
               AND sessions.session_kind = 'root'
               AND sessions.rail_section_key = requested_sections.section_key
               AND sessions.pinned_at_unix_ms = 0
               {{TARGET_PREDICATE}}
               {{INCLUDED_PREDICATE}}
               AND sessions.deleted_at_unix_ms = 0
               AND json_extract(sessions.session_metadata_json, '$.visible') IS NOT 0
           )
         END AS total_count,
         CASE requested_sections.section_key
           WHEN 'pinned' THEN (
             SELECT json_group_array(json_array(
               pinned_page.agent_session_id,
               pinned_page.conversation_sort_time_unix_ms
             ))
             FROM (
               SELECT sessions.agent_session_id,
                      sessions.pinned_at_unix_ms AS conversation_sort_time_unix_ms
               FROM workspace_agent_sessions AS sessions INDEXED BY {{PINNED_INDEX}}
               WHERE sessions.workspace_id = ?
                 AND sessions.session_kind = 'root'
                 AND sessions.pinned_at_unix_ms > 0
                 {{TARGET_PREDICATE}}
                 {{INCLUDED_PREDICATE}}
                 AND sessions.deleted_at_unix_ms = 0
                 AND json_extract(sessions.session_metadata_json, '$.visible') IS NOT 0
               ORDER BY sessions.pinned_at_unix_ms DESC, sessions.agent_session_id ASC
               LIMIT ?
             ) AS pinned_page
           )
           ELSE (
             SELECT json_group_array(json_array(
               ordinary_page.agent_session_id,
               ordinary_page.conversation_sort_time_unix_ms
             ))
             FROM (
               SELECT sessions.agent_session_id,
                      COALESCE(
                        NULLIF((
                          SELECT latest.started_at_unix_ms
                          FROM workspace_agent_turns AS latest INDEXED BY idx_workspace_agent_turns_session_latest
                          WHERE latest.workspace_id = sessions.workspace_id
                            AND latest.agent_session_id = sessions.agent_session_id
                          ORDER BY latest.updated_at_unix_ms DESC, latest.created_at_unix_ms DESC,
                                   latest.started_at_unix_ms DESC, latest.turn_id DESC
                          LIMIT 1
                        ), 0),
                        NULLIF(sessions.started_at_unix_ms, 0),
                        sessions.created_at_unix_ms
                      ) AS conversation_sort_time_unix_ms
               FROM workspace_agent_sessions AS sessions INDEXED BY {{ORDINARY_INDEX}}
               WHERE sessions.workspace_id = ?
                 AND sessions.session_kind = 'root'
                 AND sessions.rail_section_key = requested_sections.section_key
                 AND sessions.pinned_at_unix_ms = 0
                 {{TARGET_PREDICATE}}
                 {{INCLUDED_PREDICATE}}
                 AND sessions.deleted_at_unix_ms = 0
                 AND json_extract(sessions.session_metadata_json, '$.visible') IS NOT 0
               ORDER BY conversation_sort_time_unix_ms DESC, sessions.agent_session_id ASC
               LIMIT ?
             ) AS ordinary_page
           )
         END AS page_ids_json
  FROM requested_sections
), page_session_ids AS MATERIALIZED (
  SELECT section_pages.requested_section_key,
         CAST(json_extract(page_ids.value, '$[0]') AS TEXT) AS agent_session_id,
         CAST(json_extract(page_ids.value, '$[1]') AS INTEGER) AS conversation_sort_time_unix_ms,
         section_pages.total_count
  FROM section_pages
  CROSS JOIN json_each(section_pages.page_ids_json) AS page_ids
)
SELECT sessions.workspace_id, sessions.agent_session_id, sessions.session_kind,
       sessions.root_agent_session_id, sessions.root_turn_id,
       sessions.parent_agent_session_id, sessions.parent_turn_id, sessions.parent_tool_call_id,
       sessions.origin,
       sessions.agent_target_id, sessions.provider, sessions.provider_session_id, sessions.model,
       sessions.user_id, sessions.settings_json, sessions.session_metadata_json,
       sessions.internal_runtime_context_json, sessions.cwd,
       sessions.rail_section_key,
       sessions.title, sessions.message_version, sessions.last_event_at_unix_ms,
       sessions.started_at_unix_ms, sessions.ended_at_unix_ms, sessions.pinned_at_unix_ms,
       sessions.created_at_unix_ms, sessions.updated_at_unix_ms, sessions.active_turn_id,
       page_session_ids.requested_section_key,
       page_session_ids.conversation_sort_time_unix_ms,
       page_session_ids.total_count
FROM page_session_ids
CROSS JOIN workspace_agent_sessions AS sessions
WHERE sessions.workspace_id = ?
  AND sessions.agent_session_id = page_session_ids.agent_session_id
ORDER BY page_session_ids.requested_section_key ASC,
         page_session_ids.conversation_sort_time_unix_ms DESC,
         page_session_ids.agent_session_id ASC
`
	query = strings.ReplaceAll(query, "{{PINNED_INDEX}}", pinnedIndex)
	query = strings.ReplaceAll(query, "{{ORDINARY_INDEX}}", ordinaryIndex)
	query = strings.ReplaceAll(query, "{{TARGET_PREDICATE}}", targetPredicate)
	query = strings.ReplaceAll(query, "{{INCLUDED_PREDICATE}}", includedPredicate)
	args := []any{string(sectionKeysJSON), input.WorkspaceID}
	if input.AgentTargetID != "" {
		args = append(args, input.AgentTargetID)
	}
	args = append(args, includedArgs...)
	args = append(args, input.WorkspaceID)
	if input.AgentTargetID != "" {
		args = append(args, input.AgentTargetID)
	}
	args = append(args, includedArgs...)
	args = append(args, input.WorkspaceID)
	if input.AgentTargetID != "" {
		args = append(args, input.AgentTargetID)
	}
	args = append(args, includedArgs...)
	args = append(args, input.LimitPerSection, input.WorkspaceID)
	if input.AgentTargetID != "" {
		args = append(args, input.AgentTargetID)
	}
	args = append(args, includedArgs...)
	args = append(args, input.LimitPerSection, input.WorkspaceID)
	return query, args, nil
}

func normalizeSessionSectionKeys(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		sectionKey := strings.TrimSpace(value)
		if sectionKey == "" {
			continue
		}
		if _, exists := seen[sectionKey]; exists {
			continue
		}
		seen[sectionKey] = struct{}{}
		result = append(result, sectionKey)
	}
	return result
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
	includedPredicate, includedArgs, err := includedSessionIDsPredicate("agent_session_id", input.IncludedSessionIDs)
	if err != nil {
		return SessionSectionDeletionCandidates{}, false, err
	}
	query := `
SELECT agent_session_id
FROM workspace_agent_sessions INDEXED BY idx_workspace_agent_sessions_rail_section_page
WHERE workspace_id = ?
  AND session_kind = 'root'
  AND rail_section_key = ?
  AND (? = '' OR agent_target_id = ?)
  AND (? = 0 OR pinned_at_unix_ms = 0)
  ` + includedPredicate + `
  AND deleted_at_unix_ms = 0
  AND json_extract(session_metadata_json, '$.visible') IS NOT 0
ORDER BY updated_at_unix_ms DESC, agent_session_id ASC
`
	args := []any{workspaceID, sectionKey, agentTargetID, agentTargetID, input.ExcludePinned}
	args = append(args, includedArgs...)
	rows, err := s.db.QueryContext(ctx, query, args...)
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
	indexName := "idx_workspace_agent_sessions_pinned_page"
	targetPredicate := ""
	args := []any{workspaceID}
	if agentTargetID != "" {
		indexName = "idx_workspace_agent_sessions_pinned_target_page"
		targetPredicate = "AND agent_target_id = ?"
		args = append(args, agentTargetID)
	}
	includedPredicate, includedArgs, err := includedSessionIDsPredicate("agent_session_id", input.IncludedSessionIDs)
	if err != nil {
		return SessionSectionPage{}, false, err
	}
	args = append(args, includedArgs...)
	query := `
SELECT workspace_id, agent_session_id, session_kind, root_agent_session_id, root_turn_id,
       parent_agent_session_id, parent_turn_id, parent_tool_call_id,
       origin, agent_target_id, provider, provider_session_id, model,
       user_id, settings_json, session_metadata_json, internal_runtime_context_json, cwd,
       rail_section_key,
       title, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, pinned_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms, active_turn_id
FROM workspace_agent_sessions INDEXED BY ` + indexName + `
WHERE workspace_id = ?
  AND session_kind = 'root'
  AND pinned_at_unix_ms > 0
  ` + targetPredicate + `
  ` + includedPredicate + `
  AND deleted_at_unix_ms = 0
  AND json_extract(session_metadata_json, '$.visible') IS NOT 0
  AND (? = '' OR pinned_at_unix_ms < ? OR (pinned_at_unix_ms = ? AND agent_session_id > ?))
ORDER BY pinned_at_unix_ms DESC, agent_session_id ASC`
	args = append(args,
		strings.TrimSpace(input.CursorSessionID),
		input.CursorSortTimeUnixMS,
		input.CursorSortTimeUnixMS,
		strings.TrimSpace(input.CursorSessionID),
	)
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
	includedSessionIDs []string,
	excludePinned bool,
) (int, error) {
	sectionPredicate := "rail_section_key = ?"
	indexName := "idx_workspace_agent_sessions_rail_section_page"
	if sectionKey == PinnedSessionPageKey {
		sectionPredicate = "pinned_at_unix_ms > 0"
		indexName = "idx_workspace_agent_sessions_pinned_page"
	} else if excludePinned {
		sectionPredicate += " AND pinned_at_unix_ms = 0"
	}
	targetPredicate := ""
	if agentTargetID != "" {
		targetPredicate = "AND agent_target_id = ?"
		if sectionKey == PinnedSessionPageKey {
			indexName = "idx_workspace_agent_sessions_pinned_target_page"
		} else {
			indexName = "idx_workspace_agent_sessions_rail_section_target_page"
		}
	}
	includedPredicate, includedArgs, err := includedSessionIDsPredicate("agent_session_id", includedSessionIDs)
	if err != nil {
		return 0, err
	}
	query := `
SELECT COUNT(1)
FROM workspace_agent_sessions INDEXED BY ` + indexName + `
WHERE workspace_id = ?
  AND session_kind = 'root'
  AND ` + sectionPredicate + `
  ` + targetPredicate + `
  ` + includedPredicate + `
  AND deleted_at_unix_ms = 0
  AND json_extract(session_metadata_json, '$.visible') IS NOT 0`
	args := []any{workspaceID}
	if sectionKey != PinnedSessionPageKey {
		args = append(args, sectionKey)
	}
	if agentTargetID != "" {
		args = append(args, agentTargetID)
	}
	args = append(args, includedArgs...)
	var count int
	if err := s.db.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return 0, fmt.Errorf("count workspace agent session section rows: %w", err)
	}
	return count, nil
}
