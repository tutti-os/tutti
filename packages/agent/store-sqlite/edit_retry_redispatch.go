package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// AuthorizeEditRetryReplacementRetry is the durable command boundary for a
// retry-replacement action. It deliberately does not lease or call a provider:
// the Host has already read authoritative history and supplies its exact proof.
// If the caller dies after this commit, the prepared checkpoint is reconciled
// on restart instead of being automatically resent.
func (s *Store) AuthorizeEditRetryReplacementRetry(
	ctx context.Context,
	input AuthorizeEditRetryReplacementRetryInput,
) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID, input.OperationID = strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.OperationID)
	input.ClientActionID, input.ActionIdentity = strings.TrimSpace(input.ClientActionID), strings.TrimSpace(input.ActionIdentity)
	input.ReplacementTurnID, input.ProviderSessionID = strings.TrimSpace(input.ReplacementTurnID), strings.TrimSpace(input.ProviderSessionID)
	if input.WorkspaceID == "" || input.OperationID == "" || input.ClientActionID == "" || input.ActionIdentity == "" || input.ReplacementTurnID == "" || input.ProviderSessionID == "" || input.ExpectedOperationVersion <= 0 || input.ExpectedHistoryRevision < 0 || input.ProofAtUnixMS <= 0 || input.NowUnixMS <= 0 {
		return RuntimeOperation{}, false, errors.New("valid edit retry replacement authorization input is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("begin edit retry replacement authorization: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	op, found, err := getRuntimeOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil || !found {
		return op, false, err
	}
	var recorded string
	err = tx.QueryRowContext(ctx, `SELECT action_identity FROM workspace_agent_runtime_operation_recovery_actions WHERE workspace_id=? AND operation_id=? AND client_action_id=?`, op.WorkspaceID, op.OperationID, input.ClientActionID).Scan(&recorded)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return op, false, fmt.Errorf("read replacement retry action: %w", err)
	}
	if err == nil {
		if recorded != input.ActionIdentity {
			return op, false, ErrRuntimeOperationActionConflict
		}
		if err := s.commitAuthorizationTx(ctx, tx, op, nil); err != nil {
			return RuntimeOperation{}, false, err
		}
		committed = true
		return op, false, nil
	}
	if op.Kind != RuntimeOperationKindEditRetry ||
		(op.Status != RuntimeOperationStatusPrepared && op.Status != RuntimeOperationStatusBlocked) ||
		op.Version != input.ExpectedOperationVersion {
		return op, false, ErrRuntimeOperationSubjectState
	}
	payload, err := DecodeEditRetryOperationPayload(op.Payload)
	if err != nil {
		return op, false, err
	}
	if payload.Checkpoint != EditRetryCheckpointReplacementDispatched || payload.ReplacementTurnID != input.ReplacementTurnID || payload.ProviderSessionID != input.ProviderSessionID || len(payload.BeforeProviderIDs) == 0 || !equalStringValues(payload.BeforeProviderIDs[:len(payload.BeforeProviderIDs)-1], input.ProviderTurnIDs) {
		return op, false, ErrRuntimeOperationSubjectState
	}
	var revision int64
	var state, fence string
	if err := tx.QueryRowContext(ctx, `SELECT history_revision,recovery_state,operation_id FROM workspace_agent_session_history WHERE workspace_id=? AND agent_session_id=?`, op.WorkspaceID, op.AgentSessionID).Scan(&revision, &state, &fence); err != nil {
		return op, false, fmt.Errorf("read replacement retry fence: %w", err)
	}
	if revision != input.ExpectedHistoryRevision || state != SessionHistoryRecoveryResendPending || strings.TrimSpace(fence) != op.OperationID {
		return op, false, ErrRuntimeOperationSubjectState
	}
	// A proof is single-use. A later attempt requires a strictly newer
	// authoritative proof; a stale token cannot be consumed twice.
	if payload.RedispatchProofAt != 0 && input.ProofAtUnixMS <= payload.RedispatchProofAt {
		return op, false, ErrRuntimeOperationSubjectState
	}
	turn, turnFound, err := getAgentTurnTx(ctx, tx, op.WorkspaceID, op.AgentSessionID, input.ReplacementTurnID)
	if err != nil {
		return op, false, err
	}
	discardedMessages := int64(0)
	if turnFound {
		if err := validateDiscardableEditRetryReplacementTx(ctx, tx, op, payload, turn); err != nil {
			return op, false, err
		}
		deleted, deleteErr := tx.ExecContext(ctx, `DELETE FROM workspace_agent_messages WHERE workspace_id=? AND agent_session_id=? AND turn_id=?`, op.WorkspaceID, op.AgentSessionID, turn.TurnID)
		if deleteErr != nil {
			return op, false, fmt.Errorf("delete failed edit retry messages: %w", deleteErr)
		}
		discardedMessages, err = deleted.RowsAffected()
		if err != nil {
			return op, false, err
		}
		for _, statement := range []string{
			`DELETE FROM workspace_agent_interactions WHERE workspace_id=? AND agent_session_id=? AND turn_id=?`,
			`DELETE FROM workspace_agent_turn_submissions WHERE workspace_id=? AND agent_session_id=? AND turn_id=?`,
			`DELETE FROM workspace_agent_turn_history WHERE workspace_id=? AND agent_session_id=? AND turn_id=?`,
		} {
			if _, err := tx.ExecContext(ctx, statement, op.WorkspaceID, op.AgentSessionID, turn.TurnID); err != nil {
				return op, false, fmt.Errorf("delete failed edit retry replacement state: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_turns WHERE workspace_id=? AND agent_session_id=? AND turn_id=?`, op.WorkspaceID, op.AgentSessionID, turn.TurnID); err != nil {
			return op, false, fmt.Errorf("delete failed edit retry turn: %w", err)
		}
		if err := deleteEditRetryReplacementClaimTx(ctx, tx, op, payload); err != nil {
			return op, false, err
		}
	} else if err := validatePreparedEditRetryReplacementClaimTx(ctx, tx, op, payload); err != nil {
		return op, false, err
	}
	payload.RedispatchProofIDs = append([]string(nil), input.ProviderTurnIDs...)
	payload.RedispatchProofSID, payload.RedispatchProofAt = input.ProviderSessionID, input.ProofAtUnixMS
	payload.ReplacementNotDispatched = false
	if payload.DispatchAttempt < 1 {
		payload.DispatchAttempt = 1
	}
	payload.DispatchAttempt++
	payload.DiscardedMessages = discardedMessages
	if turnFound {
		payload.DiscardedOutcome, payload.DiscardedError = turn.Outcome, turn.ErrorMessage
	}
	payloadMap, err := EncodeEditRetryOperationPayload(payload)
	if err != nil {
		return op, false, err
	}
	payloadJSON, err := marshalJSONMap(payloadMap)
	if err != nil {
		return op, false, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE workspace_agent_runtime_operations SET status='prepared',payload_json=?,next_attempt_at_unix_ms=?,version=version+1,updated_at_unix_ms=? WHERE workspace_id=? AND operation_id=? AND status IN ('prepared','blocked') AND version=?`, payloadJSON, input.NowUnixMS, input.NowUnixMS, op.WorkspaceID, op.OperationID, input.ExpectedOperationVersion)
	if err != nil {
		return op, false, fmt.Errorf("authorize edit retry replacement: %w", err)
	}
	if changed, err := rowsWereAffected(result, "authorize edit retry replacement"); err != nil || !changed {
		return op, false, ErrRuntimeOperationSubjectState
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO workspace_agent_runtime_operation_recovery_actions (workspace_id,operation_id,client_action_id,action_kind,action_identity,created_at_unix_ms) VALUES (?,?,?,'retry_replacement',?,?)`, op.WorkspaceID, op.OperationID, input.ClientActionID, input.ActionIdentity, input.NowUnixMS); err != nil {
		return op, false, fmt.Errorf("record replacement retry action: %w", err)
	}
	op, _, err = getRuntimeOperationTx(ctx, tx, op.WorkspaceID, op.OperationID)
	if err != nil {
		return op, false, err
	}
	// Authorization is a separate durable fact from wake. The unique
	// (operation_id, kind) event identity must not let an earlier published wake
	// swallow the later replacement authorization.
	eventPayload := map[string]any{"clientActionId": input.ClientActionID, "actionIdentity": input.ActionIdentity, "historyRevision": revision, "proofAt": input.ProofAtUnixMS}
	event, eventFound, err := getRuntimeOperationEventByOccurrenceTx(ctx, tx, op.OperationID, RuntimeOperationEventEditRetryReplacementAuthorized, input.ActionIdentity)
	if err != nil {
		return op, false, err
	}
	if !eventFound {
		event, err = insertRuntimeOperationEventTx(ctx, tx, op, RuntimeOperationEventEditRetryReplacementAuthorized, eventPayload, input.NowUnixMS)
	}
	if err != nil {
		return op, false, err
	}
	mutations := []TransactionMutation{transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeOperation, op.OperationID, "retry_replacement", op.Version)}
	if turnFound {
		mutations = append(mutations, transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityTurn, turn.TurnID, "delete_failed_replacement", input.NowUnixMS))
	}
	if !eventFound {
		mutations = append(mutations, transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeEvent, fmt.Sprint(event.ID), "insert", event.ID))
	}
	if err := s.commitAuthorizationTx(ctx, tx, op, mutations); err != nil {
		return RuntimeOperation{}, false, err
	}
	committed = true
	return op, true, nil
}

func (s *Store) commitAuthorizationTx(ctx context.Context, tx *sql.Tx, op RuntimeOperation, mutations []TransactionMutation) error {
	_, err := s.commitTransaction(ctx, tx, op.WorkspaceID, mutations)
	if err != nil {
		return fmt.Errorf("commit edit retry replacement authorization: %w", err)
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
		HasPersistedProviderTurnBinding(turn) ||
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
