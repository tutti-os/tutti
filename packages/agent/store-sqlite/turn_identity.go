package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

var ErrTurnIdentityAnchorConflict = errors.New("workspace agent turn identity anchor conflicts with canonical state")

// bindTurnIdentityAnchorTx gives one canonical Turn the already-established
// external identity of another Turn in the same Session. The stored value is
// always flattened to an ultimate anchor so consumers need only one lookup.
// updatedAtUnixMS may be zero for migration repair that must preserve the
// historical lifecycle timestamp.
func bindTurnIdentityAnchorTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID, agentSessionID, turnID, requestedAnchorTurnID string,
	updatedAtUnixMS int64,
) (Turn, bool, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	turnID = strings.TrimSpace(turnID)
	requestedAnchorTurnID = strings.TrimSpace(requestedAnchorTurnID)
	if tx == nil || workspaceID == "" || agentSessionID == "" || turnID == "" || requestedAnchorTurnID == "" || turnID == requestedAnchorTurnID {
		return Turn{}, false, ErrTurnIdentityAnchorConflict
	}

	turn, found, err := getAgentTurnTx(ctx, tx, workspaceID, agentSessionID, turnID)
	if err != nil {
		return Turn{}, false, err
	}
	if !found {
		return Turn{}, false, ErrTurnIdentityAnchorConflict
	}
	requestedAnchor, found, err := getAgentTurnTx(ctx, tx, workspaceID, agentSessionID, requestedAnchorTurnID)
	if err != nil {
		return Turn{}, false, err
	}
	if !found {
		return Turn{}, false, ErrTurnIdentityAnchorConflict
	}

	anchorTurnID := requestedAnchor.TurnID
	if inherited := strings.TrimSpace(requestedAnchor.IdentityAnchorTurnID); inherited != "" {
		anchorTurnID = inherited
		ultimate, ultimateFound, ultimateErr := getAgentTurnTx(ctx, tx, workspaceID, agentSessionID, anchorTurnID)
		if ultimateErr != nil {
			return Turn{}, false, ultimateErr
		}
		if !ultimateFound || strings.TrimSpace(ultimate.IdentityAnchorTurnID) != "" {
			return Turn{}, false, ErrTurnIdentityAnchorConflict
		}
	}
	if anchorTurnID == turnID {
		return Turn{}, false, ErrTurnIdentityAnchorConflict
	}

	if current := strings.TrimSpace(turn.IdentityAnchorTurnID); current != "" {
		if current != anchorTurnID {
			return Turn{}, false, ErrTurnIdentityAnchorConflict
		}
		return turn, false, nil
	}

	query := `
UPDATE workspace_agent_turns
SET identity_anchor_turn_id = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
  AND identity_anchor_turn_id IS NULL`
	args := []any{anchorTurnID, workspaceID, agentSessionID, turnID}
	if updatedAtUnixMS > 0 {
		query = `
UPDATE workspace_agent_turns
SET identity_anchor_turn_id = ?, updated_at_unix_ms = MAX(updated_at_unix_ms, ?)
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
  AND identity_anchor_turn_id IS NULL`
		args = []any{anchorTurnID, updatedAtUnixMS, workspaceID, agentSessionID, turnID}
	}
	result, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return Turn{}, false, fmt.Errorf("bind workspace agent turn identity anchor: %w", err)
	}
	changed, err := rowsWereAffected(result, "bind workspace agent turn identity anchor")
	if err != nil {
		return Turn{}, false, err
	}
	if !changed {
		return Turn{}, false, ErrTurnIdentityAnchorConflict
	}
	stored, found, err := getAgentTurnTx(ctx, tx, workspaceID, agentSessionID, turnID)
	if err != nil {
		return Turn{}, false, err
	}
	if !found {
		return Turn{}, false, ErrTurnIdentityAnchorConflict
	}
	return stored, true, nil
}
