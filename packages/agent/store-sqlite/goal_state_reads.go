package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// ListSessionGoalStates returns the durable Goal state for the requested
// Sessions in one bounded read. Missing rows are omitted from the result.
func (s *Store) ListSessionGoalStates(ctx context.Context, workspaceID string, agentSessionIDs []string) (map[string]SessionGoalState, error) {
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
		return map[string]SessionGoalState{}, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids)+1)
	args = append(args, workspaceID)
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, sessionGoalStateSelectSQL+`
WHERE workspace_id = ? AND agent_session_id IN (`+placeholders+`)
ORDER BY agent_session_id ASC
`, args...)
	if err != nil {
		return nil, fmt.Errorf("list workspace agent session Goal states: %w", err)
	}
	defer rows.Close()
	result := make(map[string]SessionGoalState, len(ids))
	for rows.Next() {
		state, found, err := scanSessionGoalStateRows(rows)
		if err != nil {
			return nil, err
		}
		if found {
			result[state.AgentSessionID] = state
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace agent session Goal states: %w", err)
	}
	return result, nil
}

func scanSessionGoalStateRows(row rowScanner) (SessionGoalState, bool, error) {
	var state SessionGoalState
	var desiredJSON, observedJSON sql.NullString
	var evidenceJSON string
	var tombstoned, executionPending int
	if err := row.Scan(&state.WorkspaceID, &state.AgentSessionID, &desiredJSON, &observedJSON,
		&state.Revision, &tombstoned, &state.SyncStatus, &state.PendingOperationID,
		&executionPending, &evidenceJSON, &state.LastError, &state.ObservedAtUnixMS,
		&state.CreatedAtUnixMS, &state.UpdatedAtUnixMS); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SessionGoalState{}, false, nil
		}
		return SessionGoalState{}, false, err
	}
	state.Tombstoned = tombstoned != 0
	state.ExecutionPending = executionPending != 0
	state.Desired = unmarshalNullableJSONMap(desiredJSON)
	state.Observed = unmarshalNullableJSONMap(observedJSON)
	state.LastEvidence, _ = unmarshalJSONMap(evidenceJSON)
	return state, true, nil
}
