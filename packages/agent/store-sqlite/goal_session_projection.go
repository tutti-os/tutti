package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
)

func projectEffectiveGoalMutationTx(
	ctx context.Context,
	tx *sql.Tx,
	state SessionGoalState,
	occurredAt int64,
) (*TransactionMutation, error) {
	current, err := readProjectedSessionGoalTx(ctx, tx, state.WorkspaceID, state.AgentSessionID)
	if err != nil {
		return nil, err
	}
	if effective := ProjectEffectiveSessionGoal(state); jsonMapsEqual(current, effective) {
		return nil, nil
	}
	version, err := projectEffectiveGoalToSessionTx(ctx, tx, state, occurredAt)
	if err != nil {
		return nil, err
	}
	mutation := transactionMutation(
		state.WorkspaceID,
		state.AgentSessionID,
		MutationEntitySession,
		state.AgentSessionID,
		"upsert",
		version,
	)
	return &mutation, nil
}

func readProjectedSessionGoalTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
) (map[string]any, error) {
	var metadataJSON string
	if err := tx.QueryRowContext(ctx, `
SELECT session_metadata_json
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, agentSessionID).Scan(&metadataJSON); err != nil {
		return nil, err
	}
	metadata, err := unmarshalJSONMap(metadataJSON)
	if err != nil {
		return nil, err
	}
	goal, _ := metadata["goal"].(map[string]any)
	return canonicalSessionGoalMap(goal), nil
}

// projectEffectiveGoalToSessionTx publishes Host-owned Goal state through the
// canonical Session row in the same transaction as the Goal observation.
func projectEffectiveGoalToSessionTx(
	ctx context.Context,
	tx *sql.Tx,
	state SessionGoalState,
	occurredAt int64,
) (int64, error) {
	goal := ProjectEffectiveSessionGoal(state)
	var result sql.Result
	var err error
	if len(goal) == 0 {
		result, err = tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET session_metadata_json = json_remove(session_metadata_json, '$.goal'),
    updated_at_unix_ms = CASE
      WHEN ? > updated_at_unix_ms THEN ?
      ELSE updated_at_unix_ms + 1
    END
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, occurredAt, occurredAt, state.WorkspaceID, state.AgentSessionID)
	} else {
		encoded, encodeErr := marshalJSONMap(goal)
		if encodeErr != nil {
			return 0, encodeErr
		}
		result, err = tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET session_metadata_json = json_set(session_metadata_json, '$.goal', json(?)),
    updated_at_unix_ms = CASE
      WHEN ? > updated_at_unix_ms THEN ?
      ELSE updated_at_unix_ms + 1
    END
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, encoded, occurredAt, occurredAt, state.WorkspaceID, state.AgentSessionID)
	}
	if err != nil {
		return 0, fmt.Errorf("project effective Goal to Session: %w", err)
	}
	updated, err := rowsWereAffected(result, "project effective Goal to Session")
	if err != nil {
		return 0, err
	}
	if !updated {
		return 0, sql.ErrNoRows
	}
	var version int64
	if err := tx.QueryRowContext(ctx, `
SELECT updated_at_unix_ms
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, state.WorkspaceID, state.AgentSessionID).Scan(&version); err != nil {
		return 0, err
	}
	return version, nil
}
