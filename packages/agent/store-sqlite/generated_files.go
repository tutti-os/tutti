package storesqlite

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

const (
	workspaceGeneratedFileTurnCandidateLimit = 1000
	sectionGeneratedFileTurnLimit            = 100
)

type generatedFileChangesPayload struct {
	Files []struct {
		Path   string `json:"path"`
		Change string `json:"change"`
	} `json:"files"`
}

func (s *Store) ListWorkspaceGeneratedFileTurns(
	ctx context.Context,
	input ListWorkspaceGeneratedFileTurnsInput,
) (GeneratedFileTurnList, bool, error) {
	if s == nil || s.db == nil {
		return GeneratedFileTurnList{}, false, fmt.Errorf("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	sectionKey := strings.TrimSpace(input.SectionKey)
	if workspaceID == "" || sectionKey == "" || sectionKey == PinnedSessionPageKey {
		return GeneratedFileTurnList{}, false, nil
	}
	if err := s.ensureWorkspaceExists(ctx, workspaceID); err != nil {
		return GeneratedFileTurnList{}, false, err
	}

	// Keep file_changes_json out of the 1000-row workspace candidate CTE. A
	// canonical payload may contain large diffs, so fetch it only after section
	// filtering has reduced the result to at most 100 turns.
	rows, err := s.db.QueryContext(ctx, `
WITH recent_workspace_turns AS MATERIALIZED (
  SELECT agent_session_id,
         turn_id,
         settled_at_unix_ms
  FROM workspace_agent_turns INDEXED BY idx_workspace_agent_turns_workspace_settled_recent
  WHERE workspace_id = ?
    AND phase = 'settled'
    AND settled_at_unix_ms IS NOT NULL
  ORDER BY settled_at_unix_ms DESC,
           agent_session_id DESC,
           turn_id DESC
  LIMIT ?
),
scoped_turns AS MATERIALIZED (
  SELECT turns.agent_session_id,
         COALESCE(sessions.agent_target_id, '') AS agent_target_id,
         turns.turn_id,
         sessions.cwd,
         sessions.rail_section_kind,
         sessions.rail_project_path,
         turns.settled_at_unix_ms
  FROM recent_workspace_turns AS turns
  JOIN workspace_agent_sessions AS sessions
    ON sessions.workspace_id = ?
   AND sessions.agent_session_id = turns.agent_session_id
  WHERE sessions.rail_section_key = ?
    AND sessions.deleted_at_unix_ms = 0
  ORDER BY turns.settled_at_unix_ms DESC,
           turns.agent_session_id DESC,
           turns.turn_id DESC
  LIMIT ?
)
SELECT scoped.agent_session_id,
       scoped.agent_target_id,
       scoped.turn_id,
       scoped.cwd,
       scoped.rail_section_kind,
       scoped.rail_project_path,
       scoped.settled_at_unix_ms,
       source.file_changes_json
FROM scoped_turns AS scoped
JOIN workspace_agent_turns AS source
  ON source.workspace_id = ?
 AND source.agent_session_id = scoped.agent_session_id
 AND source.turn_id = scoped.turn_id
ORDER BY scoped.settled_at_unix_ms DESC,
         scoped.agent_session_id DESC,
         scoped.turn_id DESC
`, workspaceID, workspaceGeneratedFileTurnCandidateLimit, workspaceID, sectionKey, sectionGeneratedFileTurnLimit, workspaceID)
	if err != nil {
		return GeneratedFileTurnList{}, false, fmt.Errorf("list workspace agent generated file turn candidates: %w", err)
	}
	defer rows.Close()

	turns := make([]GeneratedFileTurn, 0, sectionGeneratedFileTurnLimit)
	for rows.Next() {
		var turn GeneratedFileTurn
		var fileChangesJSON *string
		if err := rows.Scan(
			&turn.AgentSessionID,
			&turn.AgentTargetID,
			&turn.TurnID,
			&turn.CWD,
			&turn.RailSectionKind,
			&turn.RailProjectPath,
			&turn.SettledAtUnixMS,
			&fileChangesJSON,
		); err != nil {
			return GeneratedFileTurnList{}, false, fmt.Errorf("scan workspace agent generated file turn candidate: %w", err)
		}
		if fileChangesJSON != nil && strings.TrimSpace(*fileChangesJSON) != "" {
			var payload generatedFileChangesPayload
			if err := json.Unmarshal([]byte(*fileChangesJSON), &payload); err == nil {
				turn.Changes = make([]GeneratedFileTurnChange, 0, len(payload.Files))
				for _, file := range payload.Files {
					turn.Changes = append(turn.Changes, GeneratedFileTurnChange{
						Path:   file.Path,
						Change: file.Change,
					})
				}
			}
		}
		turns = append(turns, turn)
	}
	if err := rows.Err(); err != nil {
		return GeneratedFileTurnList{}, false, fmt.Errorf("iterate workspace agent generated file turn candidates: %w", err)
	}
	return GeneratedFileTurnList{WorkspaceID: workspaceID, Turns: turns}, true, nil
}
