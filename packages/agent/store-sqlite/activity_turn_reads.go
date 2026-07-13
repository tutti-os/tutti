package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

func (s *Store) GetLatestTurn(ctx context.Context, workspaceID string, agentSessionID string) (Turn, bool, error) {
	if s == nil || s.db == nil {
		return Turn{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return Turn{}, false, nil
	}
	row := s.db.QueryRowContext(ctx, agentTurnSelectSQL+`
WHERE workspace_id = ? AND agent_session_id = ?
ORDER BY updated_at_unix_ms DESC, created_at_unix_ms DESC, started_at_unix_ms DESC, turn_id DESC
LIMIT 1
`, workspaceID, agentSessionID)
	turn, err := scanAgentTurn(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Turn{}, false, nil
		}
		return Turn{}, false, fmt.Errorf("get latest workspace agent turn: %w", err)
	}
	return turn, true, nil
}

func (s *Store) ListLatestTurns(ctx context.Context, workspaceID string, agentSessionIDs []string) (map[string]Turn, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	ids := make([]string, 0, len(agentSessionIDs))
	seen := make(map[string]struct{}, len(agentSessionIDs))
	for _, rawID := range agentSessionIDs {
		id := strings.TrimSpace(rawID)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if workspaceID == "" || len(ids) == 0 {
		return map[string]Turn{}, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids)+1)
	args = append(args, workspaceID)
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, agentTurnSelectSQL+`
WHERE workspace_id = ? AND agent_session_id IN (`+placeholders+`)
ORDER BY agent_session_id ASC, updated_at_unix_ms DESC, created_at_unix_ms DESC, started_at_unix_ms DESC, turn_id DESC
`, args...)
	if err != nil {
		return nil, fmt.Errorf("list latest workspace agent turns: %w", err)
	}
	defer rows.Close()
	result := make(map[string]Turn, len(ids))
	for rows.Next() {
		turn, err := scanAgentTurn(rows)
		if err != nil {
			return nil, err
		}
		if _, ok := result[turn.AgentSessionID]; !ok {
			result[turn.AgentSessionID] = turn
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate latest workspace agent turns: %w", err)
	}
	return result, nil
}

func (s *Store) ListTurnsBySession(ctx context.Context, workspaceID string, turnIDBySessionID map[string]string) (map[string]Turn, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	clauses := make([]string, 0, len(turnIDBySessionID))
	args := []any{workspaceID}
	for rawSessionID, rawTurnID := range turnIDBySessionID {
		sessionID := strings.TrimSpace(rawSessionID)
		turnID := strings.TrimSpace(rawTurnID)
		if sessionID == "" || turnID == "" {
			continue
		}
		clauses = append(clauses, "(agent_session_id = ? AND turn_id = ?)")
		args = append(args, sessionID, turnID)
	}
	if workspaceID == "" || len(clauses) == 0 {
		return map[string]Turn{}, nil
	}
	rows, err := s.db.QueryContext(ctx, agentTurnSelectSQL+`
WHERE workspace_id = ? AND (`+strings.Join(clauses, " OR ")+`)
`, args...)
	if err != nil {
		return nil, fmt.Errorf("list active workspace agent turns: %w", err)
	}
	defer rows.Close()
	result := make(map[string]Turn, len(clauses))
	for rows.Next() {
		turn, err := scanAgentTurn(rows)
		if err != nil {
			return nil, err
		}
		result[turn.AgentSessionID] = turn
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate active workspace agent turns: %w", err)
	}
	return result, nil
}

func (s *Store) ListPendingInteractionsBySession(ctx context.Context, workspaceID string, agentSessionIDs []string) (map[string][]Interaction, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	ids := make([]string, 0, len(agentSessionIDs))
	seen := make(map[string]struct{}, len(agentSessionIDs))
	for _, rawID := range agentSessionIDs {
		id := strings.TrimSpace(rawID)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if workspaceID == "" || len(ids) == 0 {
		return map[string][]Interaction{}, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids)+2)
	args = append(args, workspaceID)
	for _, id := range ids {
		args = append(args, id)
	}
	args = append(args, InteractionStatusPending)
	rows, err := s.db.QueryContext(ctx, agentInteractionSelectSQL+`
WHERE workspace_id = ? AND agent_session_id IN (`+placeholders+`) AND status = ?
ORDER BY agent_session_id ASC, created_at_unix_ms ASC, request_id ASC
`, args...)
	if err != nil {
		return nil, fmt.Errorf("list pending workspace agent interactions: %w", err)
	}
	defer rows.Close()
	result := make(map[string][]Interaction, len(ids))
	for rows.Next() {
		interaction, err := scanAgentInteraction(rows)
		if err != nil {
			return nil, err
		}
		result[interaction.AgentSessionID] = append(result[interaction.AgentSessionID], interaction)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate pending workspace agent interactions: %w", err)
	}
	return result, nil
}

func (s *Store) ListLatestTurnInteractions(ctx context.Context, workspaceID string, agentSessionIDs []string) (map[string][]Interaction, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	ids := uniqueNonBlankStrings(agentSessionIDs)
	if workspaceID == "" || len(ids) == 0 {
		return map[string][]Interaction{}, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids)+1)
	args = append(args, workspaceID)
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, agentInteractionSelectSQL+`
WHERE workspace_agent_interactions.workspace_id = ?
  AND workspace_agent_interactions.agent_session_id IN (`+placeholders+`)
  AND workspace_agent_interactions.turn_id = (
    SELECT latest.turn_id
    FROM workspace_agent_turns latest
    WHERE latest.workspace_id = workspace_agent_interactions.workspace_id
      AND latest.agent_session_id = workspace_agent_interactions.agent_session_id
    ORDER BY latest.updated_at_unix_ms DESC, latest.created_at_unix_ms DESC,
             latest.started_at_unix_ms DESC, latest.turn_id DESC
    LIMIT 1
  )
ORDER BY workspace_agent_interactions.agent_session_id ASC,
         workspace_agent_interactions.created_at_unix_ms ASC,
         workspace_agent_interactions.request_id ASC
`, args...)
	if err != nil {
		return nil, fmt.Errorf("list latest turn workspace agent interactions: %w", err)
	}
	defer rows.Close()
	result := make(map[string][]Interaction, len(ids))
	for rows.Next() {
		interaction, err := scanAgentInteraction(rows)
		if err != nil {
			return nil, err
		}
		result[interaction.AgentSessionID] = append(result[interaction.AgentSessionID], interaction)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate latest turn workspace agent interactions: %w", err)
	}
	return result, nil
}

func uniqueNonBlankStrings(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
