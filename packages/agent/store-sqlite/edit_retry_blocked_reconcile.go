package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// ReconcileBlockedEditRetry records a Host-classified, read-only provider
// observation. It never creates a provider dispatch capability: absence is
// surfaced as an explicit retry action and terminal source-present evidence is
// safely abandoned. The fence, action ledger and outbox event commit together.
func (s *Store) ReconcileBlockedEditRetry(ctx context.Context, input ReconcileBlockedEditRetryInput) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID, input.OperationID = strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.OperationID)
	input.ClientActionID, input.ActionIdentity = strings.TrimSpace(input.ClientActionID), strings.TrimSpace(input.ActionIdentity)
	if input.WorkspaceID == "" || input.OperationID == "" || input.ClientActionID == "" || input.ActionIdentity == "" || input.ExpectedOperationVersion <= 0 || input.ExpectedHistoryRevision < 0 || input.NowUnixMS <= 0 {
		return RuntimeOperation{}, false, errors.New("valid blocked edit retry reconciliation input is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("begin blocked edit retry reconciliation: %w", err)
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
	if err == nil {
		if recorded != input.ActionIdentity {
			return op, false, ErrRuntimeOperationActionConflict
		}
		if _, err := s.commitTransaction(ctx, tx, op.WorkspaceID, nil); err != nil {
			return op, false, err
		}
		committed = true
		return op, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return op, false, err
	}
	if op.Kind != RuntimeOperationKindEditRetry || op.Status != RuntimeOperationStatusBlocked || op.Version != input.ExpectedOperationVersion {
		return op, false, ErrRuntimeOperationSubjectState
	}
	payload, err := DecodeEditRetryOperationPayload(op.Payload)
	if err != nil || len(payload.BeforeProviderIDs) == 0 {
		return op, false, ErrRuntimeOperationSubjectState
	}
	var revision int64
	var state, fence string
	if err := tx.QueryRowContext(ctx, `SELECT history_revision,recovery_state,operation_id FROM workspace_agent_session_history WHERE workspace_id=? AND agent_session_id=?`, op.WorkspaceID, op.AgentSessionID).Scan(&revision, &state, &fence); err != nil {
		return op, false, err
	}
	if revision != input.ExpectedHistoryRevision || state != SessionHistoryRecoveryRequired || strings.TrimSpace(fence) != op.OperationID {
		return op, false, ErrRuntimeOperationSubjectState
	}
	if input.Disposition != BlockedEditRetryReconcileUnknown && strings.TrimSpace(input.ProviderSessionID) != payload.ProviderSessionID {
		return op, false, ErrRuntimeOperationSubjectState
	}
	if input.Disposition == BlockedEditRetryReconcileSourcePresent && !equalStringValues(input.ProviderTurnIDs, payload.BeforeProviderIDs) {
		return op, false, ErrRuntimeOperationSubjectState
	}
	if input.Disposition == BlockedEditRetryReconcileReplacementAbsent && !equalStringValues(input.ProviderTurnIDs, payload.BeforeProviderIDs[:len(payload.BeforeProviderIDs)-1]) {
		return op, false, ErrRuntimeOperationSubjectState
	}
	if input.Disposition == BlockedEditRetryReconcileReplacementPresent &&
		(len(input.ProviderTurnIDs) != len(payload.BeforeProviderIDs) ||
			!equalStringValues(input.ProviderTurnIDs[:len(input.ProviderTurnIDs)-1], payload.BeforeProviderIDs[:len(payload.BeforeProviderIDs)-1]) ||
			strings.TrimSpace(input.ProviderTurnID) == "" || input.ProviderTurnIDs[len(input.ProviderTurnIDs)-1] != input.ProviderTurnID) {
		return op, false, ErrRuntimeOperationSubjectState
	}
	var sourceHistoryState, sourceRetractedBy string
	if input.Disposition == BlockedEditRetryReconcileSourcePresent || input.Disposition == BlockedEditRetryReconcileReplacementAbsent || input.Disposition == BlockedEditRetryReconcileReplacementPresent {
		if err := tx.QueryRowContext(ctx, `
SELECT history_state, retracted_by_operation_id
FROM workspace_agent_turn_history
WHERE workspace_id=? AND agent_session_id=? AND turn_id=?`,
			op.WorkspaceID, op.AgentSessionID, op.TurnID,
		).Scan(&sourceHistoryState, &sourceRetractedBy); err != nil {
			return op, false, ErrRuntimeOperationSubjectState
		}
	}
	// A provider read is never enough by itself to rewrite canonical history.
	// Source-present evidence can safely release a fence only before a rollback
	// was dispatched and while the local source turn is still effective. Once a
	// source was retracted, treating a reappearing provider turn as restoration
	// would split canonical and provider history, so that combination is
	// deliberately rejected for the Host to record as unknown instead.
	if input.Disposition == BlockedEditRetryReconcileSourcePresent &&
		(payload.Checkpoint != EditRetryCheckpointPrepared || sourceHistoryState != TurnHistoryStateEffective || strings.TrimSpace(sourceRetractedBy) != "") {
		return op, false, ErrRuntimeOperationSubjectState
	}
	// Absence can create an explicit retry opportunity only after a confirmed
	// rollback, and only when this operation already owns the local retraction.
	// This transition advances the checkpoint to the exact state consumed by the
	// CAS+ledger replacement authorization; it never dispatches a replacement.
	if input.Disposition == BlockedEditRetryReconcileReplacementAbsent &&
		(payload.Checkpoint != EditRetryCheckpointRollbackConfirmed && payload.Checkpoint != EditRetryCheckpointReplacementDispatched ||
			sourceHistoryState != TurnHistoryStateRetracted || strings.TrimSpace(sourceRetractedBy) != op.OperationID) {
		return op, false, ErrRuntimeOperationSubjectState
	}
	if input.Disposition == BlockedEditRetryReconcileReplacementPresent &&
		(payload.Checkpoint != EditRetryCheckpointReplacementDispatched || sourceHistoryState != TurnHistoryStateRetracted || strings.TrimSpace(sourceRetractedBy) != op.OperationID) {
		return op, false, ErrRuntimeOperationSubjectState
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO workspace_agent_runtime_operation_recovery_actions (workspace_id,operation_id,client_action_id,action_kind,action_identity,created_at_unix_ms) VALUES (?,?,?,'reconcile',?,?)`, op.WorkspaceID, op.OperationID, input.ClientActionID, input.ActionIdentity, input.NowUnixMS); err != nil {
		return op, false, err
	}
	result := ""
	eventKind := RuntimeOperationEventEditRetryRecovery
	eventPayload := map[string]any{"turnId": op.TurnID, "clientActionId": input.ClientActionID, "actionIdentity": input.ActionIdentity, "historyRevision": revision}
	switch input.Disposition {
	case BlockedEditRetryReconcileSourcePresent:
		result = `UPDATE workspace_agent_session_history SET recovery_state='ready',operation_id='',updated_at_unix_ms=? WHERE workspace_id=? AND agent_session_id=? AND operation_id=?`
		if _, err := tx.ExecContext(ctx, result, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID, op.OperationID); err != nil {
			return op, false, err
		}
		result = `UPDATE workspace_agent_runtime_operations SET status='completed',result='abandoned',lease_owner=NULL,lease_expires_at_unix_ms=NULL,next_attempt_at_unix_ms=NULL,version=version+1,last_error='abandoned',updated_at_unix_ms=?,completed_at_unix_ms=? WHERE workspace_id=? AND operation_id=? AND status='blocked' AND version=?`
		if changed, err := tx.ExecContext(ctx, result, input.NowUnixMS, input.NowUnixMS, op.WorkspaceID, op.OperationID, input.ExpectedOperationVersion); err != nil {
			return op, false, err
		} else if ok, _ := rowsWereAffected(changed, "complete source-present blocked edit retry"); !ok {
			return op, false, ErrRuntimeOperationSubjectState
		}
		eventKind = RuntimeOperationEventEditRetryAbandoned
	case BlockedEditRetryReconcileReplacementAbsent:
		payload.Checkpoint = EditRetryCheckpointReplacementDispatched
		payload.ReplacementNotDispatched = true
		encoded, err := EncodeEditRetryOperationPayload(payload)
		if err != nil {
			return op, false, err
		}
		payloadJSON, err := marshalJSONMap(encoded)
		if err != nil {
			return op, false, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE workspace_agent_session_history SET recovery_state='resend_pending',updated_at_unix_ms=? WHERE workspace_id=? AND agent_session_id=? AND operation_id=?`, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID, op.OperationID); err != nil {
			return op, false, err
		}
		if changed, err := tx.ExecContext(ctx, `UPDATE workspace_agent_runtime_operations SET payload_json=?,version=version+1,last_error='',updated_at_unix_ms=? WHERE workspace_id=? AND operation_id=? AND status='blocked' AND version=?`, payloadJSON, input.NowUnixMS, op.WorkspaceID, op.OperationID, input.ExpectedOperationVersion); err != nil {
			return op, false, err
		} else if ok, _ := rowsWereAffected(changed, "record blocked replacement absence"); !ok {
			return op, false, ErrRuntimeOperationSubjectState
		}
		eventKind = RuntimeOperationEventEditRetryWake
	case BlockedEditRetryReconcileReplacementPresent:
		replacement, found, err := getAgentTurnTx(ctx, tx, op.WorkspaceID, op.AgentSessionID, payload.ReplacementTurnID)
		if err != nil || !found || strings.TrimSpace(replacement.RootProviderTurnID) != strings.TrimSpace(input.ProviderTurnID) {
			return op, false, ErrRuntimeOperationSubjectState
		}
		var replacementHistoryState, replacementRetractedBy, replacementOf string
		if err := tx.QueryRowContext(ctx, `SELECT history_state,retracted_by_operation_id,replacement_turn_id FROM workspace_agent_turn_history WHERE workspace_id=? AND agent_session_id=? AND turn_id=?`, op.WorkspaceID, op.AgentSessionID, replacement.TurnID).Scan(&replacementHistoryState, &replacementRetractedBy, &replacementOf); err != nil || replacementHistoryState != TurnHistoryStateEffective || strings.TrimSpace(replacementRetractedBy) != "" || strings.TrimSpace(replacementOf) != "" {
			return op, false, ErrRuntimeOperationSubjectState
		}
		var submissionID, claimStatus string
		var canonicalTurnID, claimTurnID sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT client_submit_id FROM workspace_agent_turn_submissions WHERE workspace_id=? AND agent_session_id=? AND turn_id=?`, op.WorkspaceID, op.AgentSessionID, replacement.TurnID).Scan(&submissionID); err != nil || strings.TrimSpace(submissionID) != payload.ClientSubmitID {
			return op, false, ErrRuntimeOperationSubjectState
		}
		if err := tx.QueryRowContext(ctx, `SELECT status,canonical_turn_id,turn_id FROM workspace_agent_submit_claims WHERE workspace_id=? AND agent_session_id=? AND client_submit_id=?`, op.WorkspaceID, op.AgentSessionID, payload.ClientSubmitID).Scan(&claimStatus, &canonicalTurnID, &claimTurnID); err != nil || claimStatus != "accepted" || !canonicalTurnID.Valid || !claimTurnID.Valid || strings.TrimSpace(canonicalTurnID.String) != replacement.TurnID || strings.TrimSpace(claimTurnID.String) != replacement.TurnID {
			return op, false, ErrRuntimeOperationSubjectState
		}
		if changed, err := tx.ExecContext(ctx, `UPDATE workspace_agent_turn_history SET replacement_turn_id=?,updated_at_unix_ms=? WHERE workspace_id=? AND agent_session_id=? AND turn_id=? AND history_state='retracted' AND retracted_by_operation_id=?`, replacement.TurnID, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID, op.TurnID, op.OperationID); err != nil {
			return op, false, err
		} else if ok, _ := rowsWereAffected(changed, "link observed replacement"); !ok {
			return op, false, ErrRuntimeOperationSubjectState
		}
		if changed, err := tx.ExecContext(ctx, `UPDATE workspace_agent_session_history SET history_revision=history_revision+1,recovery_state='ready',operation_id='',updated_at_unix_ms=? WHERE workspace_id=? AND agent_session_id=? AND history_revision=? AND recovery_state='recovery_required' AND operation_id=?`, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID, input.ExpectedHistoryRevision, op.OperationID); err != nil {
			return op, false, err
		} else if ok, _ := rowsWereAffected(changed, "complete observed replacement history"); !ok {
			return op, false, ErrRuntimeOperationSubjectState
		}
		if changed, err := tx.ExecContext(ctx, `UPDATE workspace_agent_runtime_operations SET status='completed',result='applied',lease_owner=NULL,lease_expires_at_unix_ms=NULL,next_attempt_at_unix_ms=NULL,version=version+1,last_error='',updated_at_unix_ms=?,completed_at_unix_ms=? WHERE workspace_id=? AND operation_id=? AND status='blocked' AND version=?`, input.NowUnixMS, input.NowUnixMS, op.WorkspaceID, op.OperationID, input.ExpectedOperationVersion); err != nil {
			return op, false, err
		} else if ok, _ := rowsWereAffected(changed, "complete observed replacement operation"); !ok {
			return op, false, ErrRuntimeOperationSubjectState
		}
		eventKind = RuntimeOperationEventEditRetryCompleted
		eventPayload["replacementTurnId"] = replacement.TurnID
		eventPayload["providerTurnId"] = input.ProviderTurnID
	default:
		if changed, err := tx.ExecContext(ctx, `UPDATE workspace_agent_runtime_operations SET version=version+1,last_error=?,updated_at_unix_ms=? WHERE workspace_id=? AND operation_id=? AND status='blocked' AND version=?`, string(EditRetryReasonProviderOutcomeUnknown), input.NowUnixMS, op.WorkspaceID, op.OperationID, input.ExpectedOperationVersion); err != nil {
			return op, false, err
		} else if ok, _ := rowsWereAffected(changed, "record blocked unknown reconciliation"); !ok {
			return op, false, ErrRuntimeOperationSubjectState
		}
	}
	op, _, err = getRuntimeOperationTx(ctx, tx, op.WorkspaceID, op.OperationID)
	if err != nil {
		return op, false, err
	}
	event, found, err := getRuntimeOperationEventByOccurrenceTx(ctx, tx, op.OperationID, eventKind, input.ActionIdentity)
	if err != nil {
		return op, false, err
	}
	if !found {
		event, err = insertRuntimeOperationEventTx(ctx, tx, op, eventKind, eventPayload, input.NowUnixMS)
	}
	if err != nil {
		return op, false, err
	}
	mutations := []TransactionMutation{transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeOperation, op.OperationID, "reconcile", op.Version)}
	if !found {
		mutations = append(mutations, transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeEvent, fmt.Sprint(event.ID), "insert", event.ID))
	}
	if _, err := s.commitTransaction(ctx, tx, op.WorkspaceID, mutations); err != nil {
		return op, false, err
	}
	committed = true
	return op, true, nil
}
