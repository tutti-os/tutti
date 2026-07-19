package storesqlite

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

const maxSessionTurnSummaryPageSize = 100

const sessionTurnSummarySelectSQL = `
SELECT turn_id,
       phase,
       COALESCE(outcome, ''),
       CAST(COALESCE(json_extract(completed_command_json, '$.finalAssistantMessageId'), '') AS TEXT),
       started_at_unix_ms,
       COALESCE(settled_at_unix_ms, 0),
       turn_origin
FROM workspace_agent_turns INDEXED BY idx_workspace_agent_turns_session_started_desc`

// ListSessionTurnSummaries returns a descending, metadata-only page. The
// query reads one extra row to compute HasMore without counting or loading the
// remaining history.
func (s *Store) ListSessionTurnSummaries(ctx context.Context, input ListSessionTurnSummariesInput) (SessionTurnSummaryPage, error) {
	if s == nil || s.db == nil {
		return SessionTurnSummaryPage{}, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	if input.WorkspaceID == "" || input.AgentSessionID == "" {
		return SessionTurnSummaryPage{}, nil
	}
	if input.Limit < 1 || input.Limit > maxSessionTurnSummaryPageSize {
		return SessionTurnSummaryPage{}, fmt.Errorf("list workspace agent session turn summaries: limit must be between 1 and %d", maxSessionTurnSummaryPageSize)
	}

	query := sessionTurnSummarySelectSQL + `
WHERE workspace_id = ? AND agent_session_id = ?`
	args := []any{input.WorkspaceID, input.AgentSessionID}
	if input.Before != nil {
		turnID := strings.TrimSpace(input.Before.TurnID)
		if turnID == "" {
			return SessionTurnSummaryPage{}, errors.New("list workspace agent session turn summaries: before turn id is required")
		}
		query += `
  AND (started_at_unix_ms < ? OR (started_at_unix_ms = ? AND turn_id < ?))`
		args = append(args, input.Before.StartedAtUnixMS, input.Before.StartedAtUnixMS, turnID)
	}
	query += `
ORDER BY started_at_unix_ms DESC, turn_id DESC
LIMIT ?`
	args = append(args, input.Limit+1)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return SessionTurnSummaryPage{}, fmt.Errorf("list workspace agent session turn summaries: %w", err)
	}
	defer rows.Close()

	turns := make([]SessionTurnSummary, 0, input.Limit+1)
	for rows.Next() {
		var turn SessionTurnSummary
		if err := rows.Scan(
			&turn.TurnID,
			&turn.Phase,
			&turn.Outcome,
			&turn.FinalAssistantMessageID,
			&turn.StartedAtUnixMS,
			&turn.SettledAtUnixMS,
			&turn.Origin,
		); err != nil {
			return SessionTurnSummaryPage{}, fmt.Errorf("scan workspace agent session turn summary: %w", err)
		}
		turns = append(turns, turn)
	}
	if err := rows.Err(); err != nil {
		return SessionTurnSummaryPage{}, fmt.Errorf("iterate workspace agent session turn summaries: %w", err)
	}
	hasMore := len(turns) > input.Limit
	if hasMore {
		turns = turns[:input.Limit]
	}
	return SessionTurnSummaryPage{Turns: turns, HasMore: hasMore}, nil
}
