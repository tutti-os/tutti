package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

func (s *Store) ListEffectiveSessionTurns(ctx context.Context, workspaceID, agentSessionID string) ([]Turn, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	workspaceID, agentSessionID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx, agentTurnSelectSQL+`
WHERE workspace_id = ? AND agent_session_id = ?
  AND EXISTS (
    SELECT 1 FROM workspace_agent_turn_history AS history
    WHERE history.workspace_id = workspace_agent_turns.workspace_id
      AND history.agent_session_id = workspace_agent_turns.agent_session_id
      AND history.turn_id = workspace_agent_turns.turn_id
      AND history.history_state = 'effective'
  )
ORDER BY started_at_unix_ms ASC, turn_id ASC
`, workspaceID, agentSessionID)
	if err != nil {
		return nil, fmt.Errorf("list effective workspace agent turns: %w", err)
	}
	defer rows.Close()
	result := make([]Turn, 0)
	for rows.Next() {
		turn, err := scanAgentTurn(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, turn)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate effective workspace agent turns: %w", err)
	}
	return result, nil
}

func (s *Store) MarkEditRetryRollbackDispatched(ctx context.Context, input MarkEditRetryRollbackDispatchedInput) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.OperationID = strings.TrimSpace(input.OperationID)
	input.LeaseOwner = strings.TrimSpace(input.LeaseOwner)
	if input.WorkspaceID == "" || input.OperationID == "" || input.LeaseOwner == "" || input.NowUnixMS <= 0 {
		return RuntimeOperation{}, false, errors.New("workspace, operation, owner, and rollback dispatch time are required")
	}
	if input.Payload.Checkpoint != EditRetryCheckpointRollbackDispatched {
		return RuntimeOperation{}, false, ErrRuntimeOperationSubjectState
	}
	payload, err := editRetryPayloadMap(input.OperationID, input.Payload)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	payloadJSON, err := marshalJSONMap(payload)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("begin edit retry rollback dispatch: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	op, found, err := getRuntimeOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	if !validEditRetryLease(op, found, input.LeaseOwner, input.NowUnixMS) {
		return op, false, ErrRuntimeOperationLeaseLost
	}
	current, err := DecodeEditRetryOperationPayload(op.Payload)
	if err != nil {
		return op, false, err
	}
	if !editRetryIdentityEqual(current, input.Payload) {
		return op, false, ErrRuntimeOperationSubjectState
	}
	if current.Checkpoint == EditRetryCheckpointRollbackDispatched {
		if _, err := s.commitTransaction(ctx, tx, input.WorkspaceID, nil); err != nil {
			return RuntimeOperation{}, false, err
		}
		committed = true
		return op, false, nil
	}
	if current.Checkpoint != EditRetryCheckpointPrepared {
		return op, false, ErrRuntimeOperationSubjectState
	}
	// The pre-effect provider snapshot is a separate durable checkpoint. Do not
	// let callers smuggle it into rollback intent: doing so would reintroduce a
	// path from an unrecorded provider read to a mutation-qualified operation.
	if len(current.BeforeProviderIDs) == 0 || current.ProviderSessionID == "" ||
		!equalStringValues(current.BeforeProviderIDs, input.Payload.BeforeProviderIDs) ||
		current.ProviderSessionID != input.Payload.ProviderSessionID {
		return op, false, ErrRuntimeOperationSubjectState
	}
	update, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_history
SET recovery_state = 'rollback_pending', operation_id = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ?
  AND history_revision = ?
  AND ((recovery_state = 'ready')
    OR (recovery_state = 'rollback_pending' AND operation_id = ?))
`, op.OperationID, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID, current.ExpectedRevision, op.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("fence edit retry rollback dispatch: %w", err)
	}
	if changed, err := rowsWereAffected(update, "fence edit retry rollback dispatch"); err != nil || !changed {
		return RuntimeOperation{}, false, ErrRuntimeOperationSubjectState
	}
	update, err = tx.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET payload_json = ?, version = version + 1, updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND status = ? AND lease_owner = ?
`, payloadJSON, input.NowUnixMS, op.WorkspaceID, op.OperationID, RuntimeOperationStatusLeased, input.LeaseOwner)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("checkpoint edit retry rollback dispatch: %w", err)
	}
	if changed, err := rowsWereAffected(update, "checkpoint edit retry rollback dispatch"); err != nil || !changed {
		return RuntimeOperation{}, false, ErrRuntimeOperationLeaseLost
	}
	op.Payload = payload
	event, err := insertRuntimeOperationEventTx(ctx, tx, op, RuntimeOperationEventEditRetryPending, map[string]any{
		"turnId": op.TurnID, "historyRevision": current.ExpectedRevision,
	}, input.NowUnixMS)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	op, _, err = getRuntimeOperationTx(ctx, tx, op.WorkspaceID, op.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	delta, err := s.commitTransaction(ctx, tx, op.WorkspaceID, []TransactionMutation{
		transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntitySession, op.AgentSessionID, "history_rollback_pending", current.ExpectedRevision),
		transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeOperation, op.OperationID, "checkpoint", op.Version),
		transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeEvent, fmt.Sprint(event.ID), "insert", event.ID),
	})
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("commit edit retry rollback dispatch: %w", err)
	}
	committed = true
	op.CommitTransactionID, op.CommitDelta = delta.TransactionID, delta
	return op, true, nil
}

func (s *Store) ConfirmEditRetryRollback(ctx context.Context, input ConfirmEditRetryRollbackInput) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.OperationID = strings.TrimSpace(input.OperationID)
	input.LeaseOwner = strings.TrimSpace(input.LeaseOwner)
	if input.WorkspaceID == "" || input.OperationID == "" || input.LeaseOwner == "" || input.NowUnixMS <= 0 {
		return RuntimeOperation{}, false, errors.New("workspace, operation, owner, and rollback confirmation time are required")
	}
	if input.Payload.Checkpoint != EditRetryCheckpointRollbackConfirmed {
		return RuntimeOperation{}, false, ErrRuntimeOperationSubjectState
	}
	payload, err := editRetryPayloadMap(input.OperationID, input.Payload)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	payloadJSON, err := marshalJSONMap(payload)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("begin edit retry rollback confirmation: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	op, found, err := getRuntimeOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	if !validEditRetryLease(op, found, input.LeaseOwner, input.NowUnixMS) {
		return op, false, ErrRuntimeOperationLeaseLost
	}
	current, err := DecodeEditRetryOperationPayload(op.Payload)
	if err != nil {
		return op, false, err
	}
	if !editRetryIdentityEqual(current, input.Payload) {
		return op, false, ErrRuntimeOperationSubjectState
	}
	if current.Checkpoint == EditRetryCheckpointRollbackConfirmed {
		if _, err := s.commitTransaction(ctx, tx, input.WorkspaceID, nil); err != nil {
			return RuntimeOperation{}, false, err
		}
		committed = true
		return op, false, nil
	}
	if current.Checkpoint != EditRetryCheckpointRollbackDispatched ||
		len(current.BeforeProviderIDs) == 0 ||
		!equalStringValues(current.BeforeProviderIDs[:len(current.BeforeProviderIDs)-1], input.ProviderTurnIDs) {
		return op, false, ErrRuntimeOperationSubjectState
	}
	turn, found, err := getAgentTurnTx(ctx, tx, op.WorkspaceID, op.AgentSessionID, op.TurnID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	if !found || strings.TrimSpace(turn.RootProviderTurnID) != current.BeforeProviderIDs[len(current.BeforeProviderIDs)-1] {
		return op, false, ErrRuntimeOperationSubjectState
	}
	update, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turn_history
SET history_state = 'retracted', retracted_by_operation_id = ?,
    replacement_turn_id = '', updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
  AND history_state = 'effective'
`, op.OperationID, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID, op.TurnID)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("retract edit retry turn: %w", err)
	}
	if changed, err := rowsWereAffected(update, "retract edit retry turn"); err != nil || !changed {
		return RuntimeOperation{}, false, ErrRuntimeOperationSubjectState
	}
	update, err = tx.ExecContext(ctx, `
UPDATE workspace_agent_session_history
SET history_revision = history_revision + 1, recovery_state = 'resend_pending',
    operation_id = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ?
  AND history_revision = ? AND recovery_state = 'rollback_pending'
  AND operation_id = ?
`, op.OperationID, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID, current.ExpectedRevision, op.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("advance edit retry history revision: %w", err)
	}
	if changed, err := rowsWereAffected(update, "advance edit retry history revision"); err != nil || !changed {
		return RuntimeOperation{}, false, ErrRuntimeOperationSubjectState
	}
	update, err = tx.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET payload_json = ?, version = version + 1, updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND status = ? AND lease_owner = ?
`, payloadJSON, input.NowUnixMS, op.WorkspaceID, op.OperationID, RuntimeOperationStatusLeased, input.LeaseOwner)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("checkpoint confirmed edit retry rollback: %w", err)
	}
	if changed, err := rowsWereAffected(update, "checkpoint confirmed edit retry rollback"); err != nil || !changed {
		return RuntimeOperation{}, false, ErrRuntimeOperationLeaseLost
	}
	op.Payload = payload
	event, err := insertRuntimeOperationEventTx(ctx, tx, op, RuntimeOperationEventEditRetryRollback, map[string]any{
		"turnId": op.TurnID, "historyRevision": current.ExpectedRevision + 1,
		"providerTurnIds": append([]string(nil), input.ProviderTurnIDs...),
	}, input.NowUnixMS)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	op, _, err = getRuntimeOperationTx(ctx, tx, op.WorkspaceID, op.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	delta, err := s.commitTransaction(ctx, tx, op.WorkspaceID, []TransactionMutation{
		transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityTurn, op.TurnID, "retract", input.NowUnixMS),
		transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntitySession, op.AgentSessionID, "history_replace", current.ExpectedRevision+1),
		transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeOperation, op.OperationID, "checkpoint", op.Version),
		transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeEvent, fmt.Sprint(event.ID), "insert", event.ID),
	})
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("commit edit retry rollback confirmation: %w", err)
	}
	committed = true
	op.CommitTransactionID, op.CommitDelta = delta.TransactionID, delta
	return op, true, nil
}

// AbortEditRetryRollback closes an edit-retry before any provider mutation is
// known to have happened. For rollback_dispatched, the caller must provide an
// authoritative unchanged-history proof. For prepared, an empty provider
// proof is sufficient because the durable checkpoint proves that rollback
// intent was never published to the provider. Both paths atomically restore
// the session fence and make the operation terminal, so a local pre-effect
// error cannot strand the session in rollback_pending.
func (s *Store) AbortEditRetryRollback(ctx context.Context, input AbortEditRetryRollbackInput) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.OperationID = strings.TrimSpace(input.OperationID)
	input.LeaseOwner = strings.TrimSpace(input.LeaseOwner)
	reason, err := editRetryReason(input.ReasonCode, input.Reason)
	if err != nil || input.WorkspaceID == "" || input.OperationID == "" ||
		input.LeaseOwner == "" || input.NowUnixMS <= 0 {
		return RuntimeOperation{}, false, errors.New("valid edit retry rollback abort input is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("begin edit retry rollback abort: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	op, found, err := getRuntimeOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	if !validEditRetryLease(op, found, input.LeaseOwner, input.NowUnixMS) {
		return op, false, ErrRuntimeOperationLeaseLost
	}
	payload, err := DecodeEditRetryOperationPayload(op.Payload)
	if err != nil {
		return op, false, err
	}
	if payload.Checkpoint != EditRetryCheckpointRollbackDispatched &&
		payload.Checkpoint != EditRetryCheckpointPrepared {
		return op, false, ErrRuntimeOperationSubjectState
	}
	if payload.Checkpoint == EditRetryCheckpointRollbackDispatched {
		if len(input.ProviderTurnIDs) == 0 || !equalStringValues(payload.BeforeProviderIDs, input.ProviderTurnIDs) {
			return op, false, ErrRuntimeOperationSubjectState
		}
	} else if len(input.ProviderTurnIDs) != 0 {
		return op, false, ErrRuntimeOperationSubjectState
	}
	update, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_history
SET recovery_state = 'ready', operation_id = '', updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ?
  AND history_revision = ? AND recovery_state = 'rollback_pending'
  AND operation_id = ?
`, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID, payload.ExpectedRevision, op.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("restore edit retry history after rejected rollback: %w", err)
	}
	if changed, err := rowsWereAffected(update, "restore edit retry history after rejected rollback"); err != nil || !changed {
		return RuntimeOperation{}, false, ErrRuntimeOperationSubjectState
	}
	payload.Checkpoint = EditRetryCheckpointRollbackAborted
	payloadMap, err := EncodeEditRetryOperationPayload(payload)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	payloadJSON, err := marshalJSONMap(payloadMap)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	update, err = tx.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET status = 'failed', result = 'failed', payload_json = ?,
    lease_owner = NULL, lease_expires_at_unix_ms = NULL,
    next_attempt_at_unix_ms = NULL, version = version + 1,
    last_error = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ?
  AND status = 'leased' AND lease_owner = ?
`, payloadJSON, string(reason), input.NowUnixMS, op.WorkspaceID, op.OperationID, input.LeaseOwner)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("fail rejected edit retry rollback: %w", err)
	}
	if changed, err := rowsWereAffected(update, "fail rejected edit retry rollback"); err != nil || !changed {
		return RuntimeOperation{}, false, ErrRuntimeOperationLeaseLost
	}
	op, _, err = getRuntimeOperationTx(ctx, tx, op.WorkspaceID, op.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	delta, err := s.commitTransaction(ctx, tx, op.WorkspaceID, []TransactionMutation{
		transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntitySession, op.AgentSessionID, "history_rollback_aborted", payload.ExpectedRevision),
		transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeOperation, op.OperationID, "fail", op.Version),
	})
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("commit edit retry rollback abort: %w", err)
	}
	committed = true
	op.CommitTransactionID, op.CommitDelta = delta.TransactionID, delta
	return op, true, nil
}

func (s *Store) CompleteEditRetryRuntimeOperation(ctx context.Context, input CompleteEditRetryRuntimeOperationInput) (RuntimeOperationCompletion, bool, error) {
	input.ReplacementTurnID = strings.TrimSpace(input.ReplacementTurnID)
	input.ProviderTurnID = strings.TrimSpace(input.ProviderTurnID)
	if input.ReplacementTurnID == "" || input.ProviderTurnID == "" {
		return RuntimeOperationCompletion{}, false, errors.New("edit retry replacement turn and provider turn are required")
	}
	return s.completeRuntimeOperation(ctx, input.WorkspaceID, input.OperationID, input.LeaseOwner, input.NowUnixMS,
		func(tx *sql.Tx, op RuntimeOperation) (string, string, map[string]any, error) {
			payload, err := DecodeEditRetryOperationPayload(op.Payload)
			if err != nil {
				return "", "", nil, err
			}
			if op.Kind != RuntimeOperationKindEditRetry ||
				payload.Checkpoint != EditRetryCheckpointReplacementDispatched ||
				payload.ReplacementTurnID != input.ReplacementTurnID {
				return "", "", nil, ErrRuntimeOperationSubjectState
			}
			replacement, found, err := getAgentTurnTx(ctx, tx, op.WorkspaceID, op.AgentSessionID, input.ReplacementTurnID)
			if err != nil {
				return "", "", nil, err
			}
			// The canonical provider receipt and accepted submit claim are both
			// required; neither one alone proves the replacement was delivered.
			if !found || replacement.TurnID == op.TurnID ||
				strings.TrimSpace(replacement.RootProviderTurnID) != input.ProviderTurnID {
				return "", "", nil, ErrRuntimeOperationSubjectState
			}
			var submissionClientSubmitID string
			if err := tx.QueryRowContext(ctx, `
SELECT client_submit_id FROM workspace_agent_turn_submissions
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, op.WorkspaceID, op.AgentSessionID, replacement.TurnID).Scan(&submissionClientSubmitID); err != nil {
				return "", "", nil, fmt.Errorf("read edit retry replacement submission: %w", err)
			}
			if strings.TrimSpace(submissionClientSubmitID) != payload.ClientSubmitID {
				return "", "", nil, ErrRuntimeOperationSubjectState
			}
			var claimStatus string
			var claimCanonicalTurnID, claimTurnID sql.NullString
			if err := tx.QueryRowContext(ctx, `
SELECT status, canonical_turn_id, turn_id
FROM workspace_agent_submit_claims
WHERE workspace_id = ? AND agent_session_id = ? AND client_submit_id = ?
`, op.WorkspaceID, op.AgentSessionID, payload.ClientSubmitID).Scan(
				&claimStatus, &claimCanonicalTurnID, &claimTurnID,
			); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return "", "", nil, ErrRuntimeOperationSubjectState
				}
				return "", "", nil, fmt.Errorf("read edit retry replacement submit claim: %w", err)
			}
			if claimStatus != "accepted" ||
				!claimCanonicalTurnID.Valid || strings.TrimSpace(claimCanonicalTurnID.String) != replacement.TurnID ||
				!claimTurnID.Valid || strings.TrimSpace(claimTurnID.String) != replacement.TurnID {
				return "", "", nil, ErrRuntimeOperationSubjectState
			}
			update, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turn_history
SET replacement_turn_id = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
  AND history_state = 'retracted' AND retracted_by_operation_id = ?
`, replacement.TurnID, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID, op.TurnID, op.OperationID)
			if err != nil {
				return "", "", nil, fmt.Errorf("link edit retry replacement turn: %w", err)
			}
			if changed, err := rowsWereAffected(update, "link edit retry replacement turn"); err != nil || !changed {
				return "", "", nil, ErrRuntimeOperationSubjectState
			}
			update, err = tx.ExecContext(ctx, `
UPDATE workspace_agent_session_history
SET history_revision = history_revision + 1, recovery_state = 'ready',
    operation_id = '', updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ?
  AND history_revision = ? AND recovery_state = 'resend_pending' AND operation_id = ?
`, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID, payload.ExpectedRevision+1, op.OperationID)
			if err != nil {
				return "", "", nil, fmt.Errorf("complete edit retry session history: %w", err)
			}
			if changed, err := rowsWereAffected(update, "complete edit retry session history"); err != nil || !changed {
				return "", "", nil, ErrRuntimeOperationSubjectState
			}
			return RuntimeOperationResultApplied, RuntimeOperationEventEditRetryCompleted, map[string]any{
				"turnId": op.TurnID, "replacementTurnId": replacement.TurnID,
				"providerTurnId":  input.ProviderTurnID,
				"historyRevision": payload.ExpectedRevision + 2,
			}, nil
		})
}

// BlockEditRetry atomically preserves the session fence and marks an
// edit-retry operation blocked when provider evidence is insufficient to make
// another mutation safe. Unlike a terminal failure it is excluded from claim
// queries but remains owned by the affected session for an explicit, safe
// recovery action.
func (s *Store) BlockEditRetry(ctx context.Context, input BlockEditRetryInput) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.OperationID = strings.TrimSpace(input.OperationID)
	input.LeaseOwner = strings.TrimSpace(input.LeaseOwner)
	reason, err := editRetryReason(input.ReasonCode, input.Reason)
	if err != nil || input.WorkspaceID == "" || input.OperationID == "" ||
		input.LeaseOwner == "" || input.NowUnixMS <= 0 {
		return RuntimeOperation{}, false, errors.New("valid edit retry recovery failure input is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("begin edit retry recovery failure: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	op, found, err := getRuntimeOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	if !validEditRetryLease(op, found, input.LeaseOwner, input.NowUnixMS) {
		return op, false, ErrRuntimeOperationLeaseLost
	}
	var revision int64
	var recoveryState string
	var fenceOperationID sql.NullString
	if err := tx.QueryRowContext(ctx, `
SELECT history_revision, recovery_state, operation_id
FROM workspace_agent_session_history
WHERE workspace_id = ? AND agent_session_id = ?
`, op.WorkspaceID, op.AgentSessionID).Scan(&revision, &recoveryState, &fenceOperationID); err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("read edit retry recovery history revision: %w", err)
	}
	owner := strings.TrimSpace(fenceOperationID.String)
	// A session fence has one durable owner. A stale operation may become
	// blocked, but it must never replace or clear another operation's fence.
	// The mismatch stays locally visible through its blocked invariant row and
	// has no recovery action because it cannot safely affect the session.
	// Recovery state alone is not ownership. Historical rows can carry a stale
	// owner even while marked ready; only an absent/NULL owner or this exact op
	// may install/advance the fence.
	ownerMismatch := owner != "" && owner != op.OperationID
	operationReason := reason
	if ownerMismatch {
		operationReason = EditRetryReasonRecoveryRequired
	}
	payloadJSON := ""
	if input.Payload != nil {
		// A negative provider receipt is meaningful only for the replacement
		// dispatch checkpoint and only for the exact leased operation. Validate
		// both identities here, inside the same transaction that blocks the row,
		// so a stale caller cannot attach evidence to another operation.
		if (operationReason != EditRetryReasonProviderRejected && operationReason != EditRetryReasonReplacementNotProvenAbsent) || op.Kind != RuntimeOperationKindEditRetry {
			return op, false, ErrRuntimeOperationSubjectState
		}
		currentPayload, err := DecodeEditRetryOperationPayload(op.Payload)
		if err != nil {
			return op, false, err
		}
		if currentPayload.Checkpoint != EditRetryCheckpointReplacementDispatched ||
			!input.Payload.ReplacementNotDispatched ||
			!editRetryIdentityEqual(currentPayload, *input.Payload) {
			return op, false, ErrRuntimeOperationSubjectState
		}
		encoded, err := editRetryPayloadMap(op.OperationID, *input.Payload)
		if err != nil {
			return op, false, err
		}
		payloadJSON, err = marshalJSONMap(encoded)
		if err != nil {
			return op, false, err
		}
		// A provider rejection is a terminal no-redispatch fence. Keep the
		// rejected claim in this transaction as well; if the recovery event
		// insert later fails, the claim must not silently return to prepared and
		// permit another provider call after lease expiry. A local
		// not-dispatched receipt deliberately keeps the claim prepared so an
		// explicit, CAS-bound retry can still consume it safely.
		if operationReason == EditRetryReasonProviderRejected {
			claimUpdate, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_submit_claims
SET status = 'rejected', turn_id = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND client_submit_id = ?
  AND status = 'prepared' AND canonical_turn_id = ?
`, input.Payload.ReplacementTurnID, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID,
				input.Payload.ClientSubmitID, input.Payload.ReplacementTurnID)
			if err != nil {
				return op, false, fmt.Errorf("reject edit retry submit claim: %w", err)
			}
			if changed, err := rowsWereAffected(claimUpdate, "reject edit retry submit claim"); err != nil {
				return op, false, err
			} else if !changed {
				claim, found, readErr := getSubmitClaimTx(ctx, tx, op.WorkspaceID, op.AgentSessionID, input.Payload.ClientSubmitID)
				if readErr != nil {
					return op, false, readErr
				}
				if !found || claim.Status != "rejected" || claim.TurnID != input.Payload.ReplacementTurnID {
					return op, false, ErrRuntimeOperationSubjectState
				}
			}
		}
	}
	targetRecoveryState := SessionHistoryRecoveryRequired
	if operationReason == EditRetryReasonReplacementNotProvenAbsent {
		targetRecoveryState = SessionHistoryRecoveryResendPending
	}
	if !ownerMismatch {
		update, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_history
SET recovery_state = ?, operation_id = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ?
  AND (operation_id IS NULL OR operation_id = '' OR operation_id = ?)
	`, targetRecoveryState, op.OperationID, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID, op.OperationID)
		if err != nil {
			return RuntimeOperation{}, false, fmt.Errorf("mark edit retry session recovery required: %w", err)
		}
		if changed, err := rowsWereAffected(update, "mark edit retry session recovery required"); err != nil || !changed {
			return RuntimeOperation{}, false, ErrRuntimeOperationSubjectState
		}
	}
	operationUpdate := `
UPDATE workspace_agent_runtime_operations
SET status = 'blocked', result = NULL, lease_owner = NULL,
    lease_expires_at_unix_ms = NULL, next_attempt_at_unix_ms = NULL,
    version = version + 1, last_error = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND status = 'leased' AND lease_owner = ?
`
	operationArgs := []any{string(operationReason), input.NowUnixMS, op.WorkspaceID, op.OperationID, input.LeaseOwner}
	if payloadJSON != "" {
		operationUpdate = `
UPDATE workspace_agent_runtime_operations
SET status = 'blocked', result = NULL, payload_json = ?, lease_owner = NULL,
    lease_expires_at_unix_ms = NULL, next_attempt_at_unix_ms = NULL,
    version = version + 1, last_error = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND status = 'leased' AND lease_owner = ?
`
		operationArgs = []any{payloadJSON, string(operationReason), input.NowUnixMS, op.WorkspaceID, op.OperationID, input.LeaseOwner}
	}
	update, err := tx.ExecContext(ctx, operationUpdate, operationArgs...)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("fail edit retry recovery operation: %w", err)
	}
	if changed, err := rowsWereAffected(update, "fail edit retry recovery operation"); err != nil || !changed {
		return RuntimeOperation{}, false, ErrRuntimeOperationLeaseLost
	}
	eventPayload := map[string]any{
		"turnId": op.TurnID, "reasonCode": string(operationReason), "historyRevision": revision,
		"actionIdentity": "block:" + string(operationReason),
	}
	if input.Payload != nil {
		eventPayload["checkpoint"] = string(input.Payload.Checkpoint)
		eventPayload["replacementNotDispatched"] = true
	}
	event, err := insertRuntimeOperationEventTx(ctx, tx, op, RuntimeOperationEventEditRetryRecovery, eventPayload, input.NowUnixMS)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	op, _, err = getRuntimeOperationTx(ctx, tx, op.WorkspaceID, op.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	mutations := []TransactionMutation{
		transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeOperation, op.OperationID, "block", op.Version),
		transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeEvent, fmt.Sprint(event.ID), "insert", event.ID),
	}
	if !ownerMismatch {
		mutations = append(mutations, transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntitySession, op.AgentSessionID, "history_recovery_required", revision))
	}
	delta, err := s.commitTransaction(ctx, tx, op.WorkspaceID, mutations)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("commit edit retry recovery failure: %w", err)
	}
	committed = true
	op.CommitTransactionID, op.CommitDelta = delta.TransactionID, delta
	return op, true, nil
}

// FailEditRetryRecovery is the legacy spelling retained for older rescue
// callers. Its durable semantics are blocked, not terminal failure.
func (s *Store) FailEditRetryRecovery(ctx context.Context, input FailEditRetryRecoveryInput) (RuntimeOperation, bool, error) {
	return s.BlockEditRetry(ctx, BlockEditRetryInput(input))
}

// DeferEditRetry is the only retry release transition for edit-retry. It keeps
// the owner fence intact, writes a provider-neutral reason code, and cannot set
// an immediately claimable retry time. Generic runtime-operation release is
// intentionally not used here because it cannot validate edit-retry history
// ownership.
func (s *Store) DeferEditRetry(ctx context.Context, input DeferEditRetryInput) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID, input.OperationID, input.LeaseOwner = strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.OperationID), strings.TrimSpace(input.LeaseOwner)
	if err := input.ReasonCode.Validate(); err != nil || input.WorkspaceID == "" || input.OperationID == "" || input.LeaseOwner == "" || input.NowUnixMS <= 0 || input.NextAttemptAtMS <= input.NowUnixMS {
		return RuntimeOperation{}, false, errors.New("valid future edit retry defer input is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("begin defer edit retry: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	op, found, err := getRuntimeOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	if !validEditRetryLease(op, found, input.LeaseOwner, input.NowUnixMS) {
		return op, false, ErrRuntimeOperationLeaseLost
	}
	var historyState, fenceOperationID string
	if err := tx.QueryRowContext(ctx, `SELECT recovery_state, operation_id FROM workspace_agent_session_history WHERE workspace_id = ? AND agent_session_id = ?`, op.WorkspaceID, op.AgentSessionID).Scan(&historyState, &fenceOperationID); err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("read edit retry defer history fence: %w", err)
	}
	payload, payloadErr := DecodeEditRetryOperationPayload(op.Payload)
	if payloadErr != nil {
		return op, false, payloadErr
	}
	// Before rollback dispatch there is no fence yet. Once a saga changes
	// history, only the owning operation may defer itself.
	if payload.Checkpoint != EditRetryCheckpointPrepared && (historyState == SessionHistoryRecoveryReady || fenceOperationID != op.OperationID) {
		return op, false, ErrRuntimeOperationSubjectState
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET status = 'prepared', result = NULL, lease_owner = NULL, lease_expires_at_unix_ms = NULL,
    next_attempt_at_unix_ms = ?, version = version + 1, last_error = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND status = 'leased' AND lease_owner = ?
`, input.NextAttemptAtMS, string(input.ReasonCode), input.NowUnixMS, op.WorkspaceID, op.OperationID, input.LeaseOwner)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("defer edit retry operation: %w", err)
	}
	if changed, err := rowsWereAffected(result, "defer edit retry operation"); err != nil || !changed {
		return RuntimeOperation{}, false, ErrRuntimeOperationLeaseLost
	}
	op, _, err = getRuntimeOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	delta, err := s.commitTransaction(ctx, tx, op.WorkspaceID, []TransactionMutation{transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeOperation, op.OperationID, "defer", op.Version)})
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("commit defer edit retry: %w", err)
	}
	committed = true
	op.CommitTransactionID, op.CommitDelta = delta.TransactionID, delta
	return op, true, nil
}

func (s *Store) GetRuntimeOperationRecoveryAction(
	ctx context.Context,
	workspaceID, operationID, clientActionID string,
) (RuntimeOperationRecoveryAction, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperationRecoveryAction{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID, operationID, clientActionID = strings.TrimSpace(workspaceID), strings.TrimSpace(operationID), strings.TrimSpace(clientActionID)
	if workspaceID == "" || operationID == "" || clientActionID == "" {
		return RuntimeOperationRecoveryAction{}, false, errors.New("workspace, operation, and client action are required")
	}
	var action RuntimeOperationRecoveryAction
	err := s.db.QueryRowContext(ctx, `
SELECT workspace_id, operation_id, client_action_id, action_kind, action_identity, created_at_unix_ms
FROM workspace_agent_runtime_operation_recovery_actions
WHERE workspace_id = ? AND operation_id = ? AND client_action_id = ?
`, workspaceID, operationID, clientActionID).Scan(
		&action.WorkspaceID, &action.OperationID, &action.ClientActionID,
		&action.ActionKind, &action.ActionIdentity, &action.CreatedAtMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return RuntimeOperationRecoveryAction{}, false, nil
	}
	if err != nil {
		return RuntimeOperationRecoveryAction{}, false, fmt.Errorf("read runtime operation recovery action: %w", err)
	}
	return action, true, nil
}

func validEditRetryLease(op RuntimeOperation, found bool, owner string, now int64) bool {
	return found && op.Kind == RuntimeOperationKindEditRetry &&
		op.Status == RuntimeOperationStatusLeased && op.LeaseOwner == owner &&
		op.LeaseExpiresAtMS > now
}

func editRetryIdentityEqual(left, right EditRetryOperationPayload) bool {
	return left.ClientOperationID == right.ClientOperationID &&
		left.EditedText == right.EditedText &&
		left.ReplacementTurnID == right.ReplacementTurnID &&
		left.ClientSubmitID == right.ClientSubmitID &&
		left.ExpectedRevision == right.ExpectedRevision
}

func equalStringValues(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != strings.TrimSpace(right[index]) {
			return false
		}
	}
	return true
}
