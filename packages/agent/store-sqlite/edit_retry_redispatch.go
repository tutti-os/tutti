package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// PrepareEditRetryReplacementRedispatch atomically consumes a durable
// provider-absence proof and grants one resend attempt for the same canonical
// replacement identity. A failed local placeholder is deleted, never revived.
func (s *Store) PrepareEditRetryReplacementRedispatch(
	ctx context.Context,
	input PrepareEditRetryReplacementRedispatchInput,
) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.OperationID = strings.TrimSpace(input.OperationID)
	input.LeaseOwner = strings.TrimSpace(input.LeaseOwner)
	input.ReplacementTurnID = strings.TrimSpace(input.ReplacementTurnID)
	if input.WorkspaceID == "" || input.OperationID == "" ||
		input.LeaseOwner == "" || input.ReplacementTurnID == "" || input.NowUnixMS <= 0 {
		return RuntimeOperation{}, false, errors.New("valid edit retry redispatch input is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("begin edit retry replacement redispatch: %w", err)
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
	if err := validateEditRetryRedispatchProof(payload, input.ReplacementTurnID); err != nil {
		return op, false, err
	}
	var recoveryState, historyOperationID string
	if err := tx.QueryRowContext(ctx, `
SELECT recovery_state, operation_id
FROM workspace_agent_session_history
WHERE workspace_id = ? AND agent_session_id = ?
`, op.WorkspaceID, op.AgentSessionID).Scan(&recoveryState, &historyOperationID); err != nil {
		return op, false, fmt.Errorf("read edit retry redispatch history fence: %w", err)
	}
	if recoveryState != SessionHistoryRecoveryResendPending ||
		strings.TrimSpace(historyOperationID) != op.OperationID {
		return op, false, ErrRuntimeOperationSubjectState
	}
	if payload.RedispatchReadyAt == payload.RedispatchProofAt {
		if _, err := s.commitTransaction(ctx, tx, op.WorkspaceID, nil); err != nil {
			return RuntimeOperation{}, false, err
		}
		committed = true
		return op, false, nil
	}

	turn, turnFound, err := getAgentTurnTx(ctx, tx, op.WorkspaceID, op.AgentSessionID, input.ReplacementTurnID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	discardedMessages := int64(0)
	if turnFound {
		if err := validateDiscardableEditRetryReplacementTx(ctx, tx, op, payload, turn); err != nil {
			return op, false, err
		}
		result, deleteErr := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_messages
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, op.WorkspaceID, op.AgentSessionID, turn.TurnID)
		if deleteErr != nil {
			return RuntimeOperation{}, false, fmt.Errorf("delete failed edit retry messages: %w", deleteErr)
		}
		discardedMessages, err = result.RowsAffected()
		if err != nil {
			return RuntimeOperation{}, false, fmt.Errorf("count failed edit retry messages: %w", err)
		}
		for label, statement := range map[string]string{
			"interactions": `DELETE FROM workspace_agent_interactions
				WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?`,
			"submission": `DELETE FROM workspace_agent_turn_submissions
				WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?`,
			"history": `DELETE FROM workspace_agent_turn_history
				WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?`,
		} {
			if _, err := tx.ExecContext(ctx, statement, op.WorkspaceID, op.AgentSessionID, turn.TurnID); err != nil {
				return RuntimeOperation{}, false, fmt.Errorf("delete failed edit retry %s: %w", label, err)
			}
		}
		if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_turns
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, op.WorkspaceID, op.AgentSessionID, turn.TurnID); err != nil {
			return RuntimeOperation{}, false, fmt.Errorf("delete failed edit retry turn: %w", err)
		}
		// The accepted claim is part of the failed local placeholder. Leaving
		// it behind would make the stable clientSubmitId resolve to the deleted
		// Turn and prevent the authorized redispatch from entering the runtime.
		if err := deleteEditRetryReplacementClaimTx(ctx, tx, op, payload); err != nil {
			return RuntimeOperation{}, false, err
		}
	} else if err := validatePreparedEditRetryReplacementClaimTx(ctx, tx, op, payload); err != nil {
		// A definitively not-dispatched request has no local Turn and retains
		// the original prepared claim. Reusing that stable claim is the safe
		// redispatch path after authoritative provider absence is proven.
		return RuntimeOperation{}, false, err
	}

	payload.RedispatchReadyAt = payload.RedispatchProofAt
	if payload.DispatchAttempt < 1 {
		payload.DispatchAttempt = 1
	}
	payload.DispatchAttempt++
	payload.DiscardedMessages = discardedMessages
	if turnFound {
		payload.DiscardedOutcome = turn.Outcome
		payload.DiscardedError = turn.ErrorMessage
	}
	payloadMap, err := EncodeEditRetryOperationPayload(payload)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	payloadJSON, err := marshalJSONMap(payloadMap)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	update, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET payload_json = ?, version = version + 1, updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ?
  AND status = 'leased' AND lease_owner = ?
`, payloadJSON, input.NowUnixMS, op.WorkspaceID, op.OperationID, input.LeaseOwner)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("checkpoint edit retry redispatch preparation: %w", err)
	}
	if changed, err := rowsWereAffected(update, "checkpoint edit retry redispatch preparation"); err != nil || !changed {
		return RuntimeOperation{}, false, ErrRuntimeOperationLeaseLost
	}
	op, _, err = getRuntimeOperationTx(ctx, tx, op.WorkspaceID, op.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	mutations := []TransactionMutation{
		transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeOperation, op.OperationID, "checkpoint", op.Version),
	}
	if turnFound {
		mutations = append(mutations, transactionMutation(
			op.WorkspaceID, op.AgentSessionID, MutationEntityTurn,
			turn.TurnID, "delete_failed_replacement", input.NowUnixMS,
		))
	}
	delta, err := s.commitTransaction(ctx, tx, op.WorkspaceID, mutations)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("commit edit retry redispatch preparation: %w", err)
	}
	committed = true
	op.CommitTransactionID, op.CommitDelta = delta.TransactionID, delta
	return op, true, nil
}

func validateEditRetryRedispatchProof(payload EditRetryOperationPayload, replacementTurnID string) error {
	if !payload.RedispatchAllowed ||
		payload.Checkpoint != EditRetryCheckpointReplacementDispatched ||
		payload.ReplacementTurnID != replacementTurnID ||
		len(payload.BeforeProviderIDs) == 0 ||
		!equalStringValues(payload.BeforeProviderIDs[:len(payload.BeforeProviderIDs)-1], payload.RedispatchProofIDs) ||
		strings.TrimSpace(payload.ProviderSessionID) == "" ||
		payload.ProviderSessionID != payload.RedispatchProofSID ||
		payload.RedispatchProofAt <= 0 {
		return ErrRuntimeOperationSubjectState
	}
	return nil
}

func validateDiscardableEditRetryReplacementTx(
	ctx context.Context,
	tx *sql.Tx,
	op RuntimeOperation,
	payload EditRetryOperationPayload,
	turn Turn,
) error {
	if turn.TurnID == op.TurnID ||
		turn.Phase != TurnPhaseSettled ||
		(turn.Outcome != TurnOutcomeFailed && turn.Outcome != TurnOutcomeInterrupted) ||
		turn.Origin != TurnOriginUserPrompt ||
		strings.TrimSpace(turn.RootProviderTurnID) != "" ||
		strings.TrimSpace(turn.RootProviderTurnPhase) != "" ||
		strings.TrimSpace(turn.RootProviderTurnOutcome) != "" ||
		strings.TrimSpace(turn.RootProviderTurnErrorMessage) != "" ||
		strings.TrimSpace(turn.RootProviderTurnErrorCode) != "" ||
		strings.TrimSpace(turn.RootProviderTurnCompletedCommandKind) != "" ||
		strings.TrimSpace(turn.RootProviderTurnCompletedCommandStatus) != "" ||
		turn.RootProviderTurnUpdatedAtUnixMS != 0 ||
		len(turn.FileChanges) != 0 ||
		strings.TrimSpace(turn.CompletedCommandKind) != "" ||
		strings.TrimSpace(turn.CompletedCommandStatus) != "" ||
		strings.TrimSpace(turn.FinalAssistantMessageID) != "" {
		return ErrRuntimeOperationSubjectState
	}
	var submissionClientSubmitID string
	if err := tx.QueryRowContext(ctx, `
SELECT client_submit_id
FROM workspace_agent_turn_submissions
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, op.WorkspaceID, op.AgentSessionID, turn.TurnID).Scan(&submissionClientSubmitID); err != nil ||
		strings.TrimSpace(submissionClientSubmitID) != payload.ClientSubmitID {
		return ErrRuntimeOperationSubjectState
	}
	var claimStatus string
	var canonicalTurnID, acceptedTurnID sql.NullString
	if err := tx.QueryRowContext(ctx, `
SELECT status, canonical_turn_id, turn_id
FROM workspace_agent_submit_claims
WHERE workspace_id = ? AND agent_session_id = ? AND client_submit_id = ?
`, op.WorkspaceID, op.AgentSessionID, payload.ClientSubmitID).Scan(
		&claimStatus, &canonicalTurnID, &acceptedTurnID,
	); err != nil ||
		claimStatus != "accepted" || !canonicalTurnID.Valid || !acceptedTurnID.Valid ||
		strings.TrimSpace(canonicalTurnID.String) != turn.TurnID ||
		strings.TrimSpace(acceptedTurnID.String) != turn.TurnID {
		return ErrRuntimeOperationSubjectState
	}
	var activeTurnID sql.NullString
	if err := tx.QueryRowContext(ctx, `
SELECT active_turn_id FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ?
`, op.WorkspaceID, op.AgentSessionID).Scan(&activeTurnID); err != nil ||
		(activeTurnID.Valid && strings.TrimSpace(activeTurnID.String) != "") {
		return ErrRuntimeOperationSubjectState
	}
	if err := requireEditRetryRedispatchCount(ctx, tx, `
SELECT COUNT(*) FROM workspace_agent_turn_history
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
  AND history_state = 'effective'
`, 1, op.WorkspaceID, op.AgentSessionID, turn.TurnID); err != nil {
		return err
	}
	for _, query := range []string{
		`SELECT COUNT(*) FROM workspace_agent_messages
		 WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
		   AND lower(trim(role)) != 'user'`,
		`SELECT COUNT(*) FROM workspace_agent_interactions
		 WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?`,
		`SELECT COUNT(*) FROM workspace_agent_sessions
		 WHERE workspace_id = ? AND
		   ((root_agent_session_id = ? AND root_turn_id = ?) OR
		    (parent_agent_session_id = ? AND parent_turn_id = ?))`,
		`SELECT COUNT(*) FROM workspace_agent_runtime_operations
		 WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?`,
	} {
		args := []any{op.WorkspaceID, op.AgentSessionID, turn.TurnID}
		if strings.Contains(query, "root_agent_session_id") {
			args = []any{op.WorkspaceID, op.AgentSessionID, turn.TurnID, op.AgentSessionID, turn.TurnID}
		}
		if err := requireEditRetryRedispatchCount(ctx, tx, query, 0, args...); err != nil {
			return err
		}
	}
	return nil
}

func deleteEditRetryReplacementClaimTx(
	ctx context.Context,
	tx *sql.Tx,
	op RuntimeOperation,
	payload EditRetryOperationPayload,
) error {
	result, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_submit_claims
WHERE workspace_id = ? AND agent_session_id = ? AND client_submit_id = ?
  AND status = 'accepted' AND canonical_turn_id = ? AND turn_id = ?
`, op.WorkspaceID, op.AgentSessionID, payload.ClientSubmitID,
		payload.ReplacementTurnID, payload.ReplacementTurnID)
	if err != nil {
		return fmt.Errorf("delete failed edit retry submit claim: %w", err)
	}
	changed, err := rowsWereAffected(result, "delete failed edit retry submit claim")
	if err != nil {
		return err
	}
	if !changed {
		return ErrRuntimeOperationSubjectState
	}
	return nil
}

func validatePreparedEditRetryReplacementClaimTx(
	ctx context.Context,
	tx *sql.Tx,
	op RuntimeOperation,
	payload EditRetryOperationPayload,
) error {
	var claimStatus string
	var canonicalTurnID, acceptedTurnID sql.NullString
	if err := tx.QueryRowContext(ctx, `
SELECT status, canonical_turn_id, turn_id
FROM workspace_agent_submit_claims
WHERE workspace_id = ? AND agent_session_id = ? AND client_submit_id = ?
`, op.WorkspaceID, op.AgentSessionID, payload.ClientSubmitID).Scan(
		&claimStatus, &canonicalTurnID, &acceptedTurnID,
	); err != nil ||
		claimStatus != "prepared" || !canonicalTurnID.Valid || acceptedTurnID.Valid ||
		strings.TrimSpace(canonicalTurnID.String) != payload.ReplacementTurnID {
		return ErrRuntimeOperationSubjectState
	}
	for _, query := range []string{
		`SELECT COUNT(*) FROM workspace_agent_messages
		 WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?`,
		`SELECT COUNT(*) FROM workspace_agent_interactions
		 WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?`,
		`SELECT COUNT(*) FROM workspace_agent_turn_submissions
		 WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?`,
		`SELECT COUNT(*) FROM workspace_agent_turn_history
		 WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?`,
	} {
		if err := requireEditRetryRedispatchCount(
			ctx, tx, query, 0, op.WorkspaceID, op.AgentSessionID, payload.ReplacementTurnID,
		); err != nil {
			return err
		}
	}
	return nil
}

func requireEditRetryRedispatchCount(ctx context.Context, tx *sql.Tx, query string, expected int64, args ...any) error {
	var count int64
	if err := tx.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return err
	}
	if count != expected {
		return ErrRuntimeOperationSubjectState
	}
	return nil
}
