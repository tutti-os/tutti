package storesqlite

import (
	"context"
	"fmt"
)

type historicalTurnIdentityAnchor struct {
	workspaceID    string
	agentSessionID string
	turnID         string
	anchorTurnID   string
}

type historicalTurnIdentityKey struct {
	workspaceID    string
	agentSessionID string
	turnID         string
}

func (anchor historicalTurnIdentityAnchor) turnKey() historicalTurnIdentityKey {
	return historicalTurnIdentityKey{
		workspaceID:    anchor.workspaceID,
		agentSessionID: anchor.agentSessionID,
		turnID:         anchor.turnID,
	}
}

func (anchor historicalTurnIdentityAnchor) anchorKey() historicalTurnIdentityKey {
	return historicalTurnIdentityKey{
		workspaceID:    anchor.workspaceID,
		agentSessionID: anchor.agentSessionID,
		turnID:         anchor.anchorTurnID,
	}
}

// orderHistoricalTurnIdentityAnchorRepairs puts every repair after any repair
// that establishes its requested anchor. This lets the binder flatten a
// continuation chain to its ultimate identity even when operation timestamps
// tie and their stable query order is not causal.
func orderHistoricalTurnIdentityAnchorRepairs(
	repairs []historicalTurnIdentityAnchor,
) ([]historicalTurnIdentityAnchor, error) {
	pendingByTurn := make(map[historicalTurnIdentityKey]int, len(repairs))
	for _, repair := range repairs {
		pendingByTurn[repair.turnKey()]++
	}

	waitingForTurn := make(map[historicalTurnIdentityKey][]int, len(repairs))
	ready := make([]int, 0, len(repairs))
	for index, repair := range repairs {
		anchorKey := repair.anchorKey()
		if pendingByTurn[anchorKey] == 0 {
			ready = append(ready, index)
			continue
		}
		waitingForTurn[anchorKey] = append(waitingForTurn[anchorKey], index)
	}

	ordered := make([]historicalTurnIdentityAnchor, 0, len(repairs))
	for len(ready) > 0 {
		index := ready[0]
		ready = ready[1:]
		repair := repairs[index]
		ordered = append(ordered, repair)

		turnKey := repair.turnKey()
		pendingByTurn[turnKey]--
		if pendingByTurn[turnKey] == 0 {
			ready = append(ready, waitingForTurn[turnKey]...)
		}
	}
	if len(ordered) != len(repairs) {
		return nil, fmt.Errorf("%w: historical repair dependencies contain a cycle", ErrTurnIdentityAnchorConflict)
	}
	return ordered, nil
}

// applyWorkspaceAgentTurnIdentityAnchorV1 adds the provider-neutral identity
// inheritance relation and repairs only historical plan continuations that
// still have complete canonical operation and submit-message proof. Rows with
// incomplete legacy evidence remain unclassified rather than being guessed.
func (s *Store) applyWorkspaceAgentTurnIdentityAnchorV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentTurnIdentityAnchorV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent turn identity anchor v1: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	hasColumn, err := hasColumnTx(ctx, tx, "workspace_agent_turns", "identity_anchor_turn_id")
	if err != nil {
		return err
	}
	if !hasColumn {
		if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_turns
ADD COLUMN identity_anchor_turn_id TEXT
  CHECK (identity_anchor_turn_id IS NULL OR
    (length(trim(identity_anchor_turn_id)) > 0 AND identity_anchor_turn_id != turn_id))`); err != nil {
			return fmt.Errorf("add workspace agent turn identity anchor: %w", err)
		}
	}

	rows, err := tx.QueryContext(ctx, `
SELECT operation.workspace_id,
       operation.agent_session_id,
       json_extract(operation.payload_json, '$.confirmedTurnId'),
       operation.turn_id
FROM workspace_agent_runtime_operations AS operation
JOIN workspace_agent_turns AS parent_turn
  ON parent_turn.workspace_id = operation.workspace_id
 AND parent_turn.agent_session_id = operation.agent_session_id
 AND parent_turn.turn_id = operation.turn_id
JOIN workspace_agent_turns AS child_turn
  ON child_turn.workspace_id = operation.workspace_id
 AND child_turn.agent_session_id = operation.agent_session_id
 AND child_turn.turn_id = json_extract(operation.payload_json, '$.confirmedTurnId')
JOIN workspace_agent_messages AS submit_message
  ON submit_message.workspace_id = operation.workspace_id
 AND submit_message.agent_session_id = operation.agent_session_id
 AND submit_message.turn_id = child_turn.turn_id
 AND submit_message.deleted_at_unix_ms = 0
 AND json_extract(submit_message.payload_json, '$.clientSubmitId') =
     json_extract(operation.payload_json, '$.clientSubmitId')
WHERE operation.kind = 'plan_decision'
  AND operation.status = 'completed'
  AND operation.result = 'applied'
  AND json_extract(operation.payload_json, '$.promptKind') = 'plan-implementation'
  AND json_extract(operation.payload_json, '$.action') = 'implement'
  AND json_extract(operation.payload_json, '$.step') = 'send_confirmed'
  AND length(json_extract(operation.payload_json, '$.confirmedTurnId')) > 0
  AND json_extract(operation.payload_json, '$.confirmedTurnId') != operation.turn_id
  AND json_extract(operation.payload_json, '$.clientSubmitId') = 'plan-decision:' || operation.operation_id
  AND child_turn.identity_anchor_turn_id IS NULL
ORDER BY operation.completed_at_unix_ms, operation.operation_id`)
	if err != nil {
		return fmt.Errorf("list historical workspace agent turn identity anchors: %w", err)
	}
	repairs := make([]historicalTurnIdentityAnchor, 0)
	for rows.Next() {
		var repair historicalTurnIdentityAnchor
		if err := rows.Scan(&repair.workspaceID, &repair.agentSessionID, &repair.turnID, &repair.anchorTurnID); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan historical workspace agent turn identity anchor: %w", err)
		}
		repairs = append(repairs, repair)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("iterate historical workspace agent turn identity anchors: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close historical workspace agent turn identity anchors: %w", err)
	}
	repairs, err = orderHistoricalTurnIdentityAnchorRepairs(repairs)
	if err != nil {
		return fmt.Errorf("order historical workspace agent turn identity anchors: %w", err)
	}
	for _, repair := range repairs {
		if _, _, err := bindTurnIdentityAnchorTx(
			ctx, tx, repair.workspaceID, repair.agentSessionID,
			repair.turnID, repair.anchorTurnID, 0,
		); err != nil {
			return fmt.Errorf("repair historical workspace agent turn identity anchor: %w", err)
		}
	}

	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentTurnIdentityAnchorV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent turn identity anchor v1: %w", err)
	}
	return nil
}
