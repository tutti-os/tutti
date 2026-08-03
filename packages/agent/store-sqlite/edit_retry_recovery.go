package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// AbandonEditRetry is a safe terminal disposition, not the production kill
// switch quarantine. It allows only evidence that rollback never happened
// (`prepared`), was already durably confirmed before replacement dispatch, or
// has a durably recorded authoritative replacement non-dispatch receipt. An
// unknown dispatched rollback or replacement can never be abandoned. A
// prepared operation may be abandoned directly with its exact CAS version;
// a leased operation still requires its fence owner. No provider mutation is
// performed by this terminal transition.
// Confirmed rollback leaves the original Turn retracted rather than
// manufacturing an old-history restoration.
func (s *Store) AbandonEditRetry(ctx context.Context, input AbandonEditRetryInput) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID, input.OperationID, input.LeaseOwner, input.ClientActionID = strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.OperationID), strings.TrimSpace(input.LeaseOwner), strings.TrimSpace(input.ClientActionID)
	if input.WorkspaceID == "" || input.OperationID == "" || input.ClientActionID == "" || input.ExpectedOperationVersion <= 0 || input.ExpectedHistoryRevision < 0 || input.NowUnixMS <= 0 {
		return RuntimeOperation{}, false, errors.New("valid safe edit retry abandon input is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("begin abandon edit retry: %w", err)
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
	if found && op.Status == RuntimeOperationStatusCompleted && op.Result == RuntimeOperationResultAbandoned {
		return op, false, nil
	}
	preparedCAS := found && op.Status == RuntimeOperationStatusPrepared && op.Version == input.ExpectedOperationVersion
	leasedOwner := validEditRetryLease(op, found, input.LeaseOwner, input.NowUnixMS) && op.Version == input.ExpectedOperationVersion
	if !preparedCAS && !leasedOwner {
		return op, false, ErrRuntimeOperationLeaseLost
	}
	payload, err := DecodeEditRetryOperationPayload(op.Payload)
	if err != nil {
		return op, false, err
	}
	safeReplacementNonDispatch := payload.Checkpoint == EditRetryCheckpointReplacementDispatched && payload.ReplacementNotDispatched
	if payload.Checkpoint != EditRetryCheckpointPrepared &&
		payload.Checkpoint != EditRetryCheckpointRollbackConfirmed &&
		!safeReplacementNonDispatch {
		return op, false, ErrRuntimeOperationSubjectState
	}
	var revision int64
	var state, fenceOperationID string
	if err := tx.QueryRowContext(ctx, `SELECT history_revision, recovery_state, operation_id FROM workspace_agent_session_history WHERE workspace_id = ? AND agent_session_id = ?`, op.WorkspaceID, op.AgentSessionID).Scan(&revision, &state, &fenceOperationID); err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("read edit retry abandon history: %w", err)
	}
	if revision != input.ExpectedHistoryRevision {
		return op, false, ErrRuntimeOperationSubjectState
	}
	actionIdentity := fmt.Sprintf("abandon:%d:%d", input.ExpectedOperationVersion, input.ExpectedHistoryRevision)
	var recordedIdentity string
	actionErr := tx.QueryRowContext(ctx, `SELECT action_identity FROM workspace_agent_runtime_operation_recovery_actions WHERE workspace_id = ? AND operation_id = ? AND client_action_id = ?`, op.WorkspaceID, op.OperationID, input.ClientActionID).Scan(&recordedIdentity)
	if actionErr != nil && !errors.Is(actionErr, sql.ErrNoRows) {
		return RuntimeOperation{}, false, fmt.Errorf("read edit retry abandon action: %w", actionErr)
	}
	if actionErr == nil {
		if recordedIdentity != actionIdentity {
			return op, false, ErrRuntimeOperationActionConflict
		}
		if _, err := s.commitTransaction(ctx, tx, op.WorkspaceID, nil); err != nil {
			return RuntimeOperation{}, false, fmt.Errorf("commit duplicate edit retry abandon action: %w", err)
		}
		committed = true
		return op, false, nil
	}
	if payload.Checkpoint != EditRetryCheckpointPrepared && (fenceOperationID != op.OperationID || state == SessionHistoryRecoveryReady) {
		return op, false, ErrRuntimeOperationSubjectState
	}
	if fenceOperationID == op.OperationID && state != SessionHistoryRecoveryReady {
		if _, err := tx.ExecContext(ctx, `UPDATE workspace_agent_session_history SET recovery_state = 'ready', operation_id = '', updated_at_unix_ms = ? WHERE workspace_id = ? AND agent_session_id = ? AND operation_id = ?`, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID, op.OperationID); err != nil {
			return RuntimeOperation{}, false, fmt.Errorf("release abandoned edit retry fence: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO workspace_agent_runtime_operation_recovery_actions (workspace_id, operation_id, client_action_id, action_kind, action_identity, created_at_unix_ms) VALUES (?, ?, ?, 'abandon', ?, ?)`, op.WorkspaceID, op.OperationID, input.ClientActionID, actionIdentity, input.NowUnixMS); err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("record edit retry abandon action: %w", err)
	}
	completionSQL := `UPDATE workspace_agent_runtime_operations SET status = 'completed', result = 'abandoned', lease_owner = NULL, lease_expires_at_unix_ms = NULL, next_attempt_at_unix_ms = NULL, version = version + 1, last_error = 'abandoned', updated_at_unix_ms = ?, completed_at_unix_ms = ? WHERE workspace_id = ? AND operation_id = ? AND status = 'leased' AND lease_owner = ? AND version = ?`
	completionArgs := []any{input.NowUnixMS, input.NowUnixMS, op.WorkspaceID, op.OperationID, input.LeaseOwner, input.ExpectedOperationVersion}
	if preparedCAS {
		completionSQL = `UPDATE workspace_agent_runtime_operations SET status = 'completed', result = 'abandoned', lease_owner = NULL, lease_expires_at_unix_ms = NULL, next_attempt_at_unix_ms = NULL, version = version + 1, last_error = 'abandoned', updated_at_unix_ms = ?, completed_at_unix_ms = ? WHERE workspace_id = ? AND operation_id = ? AND status = 'prepared' AND version = ?`
		completionArgs = []any{input.NowUnixMS, input.NowUnixMS, op.WorkspaceID, op.OperationID, input.ExpectedOperationVersion}
	}
	result, err := tx.ExecContext(ctx, completionSQL, completionArgs...)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("complete abandoned edit retry: %w", err)
	}
	if changed, err := rowsWereAffected(result, "complete abandoned edit retry"); err != nil || !changed {
		return RuntimeOperation{}, false, ErrRuntimeOperationLeaseLost
	}
	event, err := insertRuntimeOperationEventTx(ctx, tx, op, RuntimeOperationEventEditRetryAbandoned, map[string]any{"turnId": op.TurnID, "clientActionId": input.ClientActionID, "actionIdentity": actionIdentity, "historyRevision": revision}, input.NowUnixMS)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	op, _, err = getRuntimeOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	delta, err := s.commitTransaction(ctx, tx, op.WorkspaceID, []TransactionMutation{transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntitySession, op.AgentSessionID, "history_edit_retry_abandoned", revision), transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeOperation, op.OperationID, "abandon", op.Version), transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeEvent, fmt.Sprint(event.ID), "insert", event.ID)})
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("commit abandon edit retry: %w", err)
	}
	committed = true
	op.CommitTransactionID, op.CommitDelta = delta.TransactionID, delta
	return op, true, nil
}

// WakeDeferredEditRetry consumes an explicit recovery request without
// changing provider state. Its transaction binds the wake to the operation's
// current session fence, preventing another operation from accelerating it.
func (s *Store) WakeDeferredEditRetry(ctx context.Context, input WakeDeferredEditRetryInput) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.OperationID = strings.TrimSpace(input.OperationID)
	input.ClientActionID = strings.TrimSpace(input.ClientActionID)
	if input.WorkspaceID == "" || input.OperationID == "" || input.ClientActionID == "" || input.ExpectedOperationVersion <= 0 || input.ExpectedHistoryRevision < 0 || input.NowUnixMS <= 0 {
		return RuntimeOperation{}, false, errors.New("workspace, operation version, history revision, client action, and wake time are required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("begin wake deferred edit retry: %w", err)
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
	actionIdentity := strings.TrimSpace(input.ActionIdentity)
	if actionIdentity == "" {
		actionIdentity = fmt.Sprintf("wake:%d:%d", input.ExpectedOperationVersion, input.ExpectedHistoryRevision)
	}
	var recordedIdentity string
	actionErr := tx.QueryRowContext(ctx, `SELECT action_identity FROM workspace_agent_runtime_operation_recovery_actions WHERE workspace_id = ? AND operation_id = ? AND client_action_id = ?`, op.WorkspaceID, op.OperationID, input.ClientActionID).Scan(&recordedIdentity)
	if actionErr != nil && !errors.Is(actionErr, sql.ErrNoRows) {
		return RuntimeOperation{}, false, fmt.Errorf("read edit retry wake action: %w", actionErr)
	}
	if actionErr == nil {
		if recordedIdentity != actionIdentity {
			return op, false, ErrRuntimeOperationActionConflict
		}
		if _, err := s.commitTransaction(ctx, tx, op.WorkspaceID, nil); err != nil {
			return RuntimeOperation{}, false, fmt.Errorf("commit duplicate edit retry wake action: %w", err)
		}
		committed = true
		return op, false, nil
	}
	if op.Kind != RuntimeOperationKindEditRetry || op.Status != RuntimeOperationStatusPrepared {
		return op, false, ErrRuntimeOperationSubjectState
	}
	// A prior successful wake is already durable and therefore idempotent. It
	// remains safe even if a client retried after observing an older version.
	if op.NextAttemptAtMS <= input.NowUnixMS {
		if _, err := s.commitTransaction(ctx, tx, op.WorkspaceID, nil); err != nil {
			return RuntimeOperation{}, false, fmt.Errorf("commit duplicate edit retry wake: %w", err)
		}
		committed = true
		return op, false, nil
	}
	if op.Version != input.ExpectedOperationVersion {
		return op, false, ErrRuntimeOperationSubjectState
	}
	var historyRevision int64
	var recoveryState, fenceOperationID string
	if err := tx.QueryRowContext(ctx, `
SELECT history_revision, recovery_state, operation_id
FROM workspace_agent_session_history
WHERE workspace_id = ? AND agent_session_id = ?
`, op.WorkspaceID, op.AgentSessionID).Scan(&historyRevision, &recoveryState, &fenceOperationID); err != nil ||
		historyRevision != input.ExpectedHistoryRevision || strings.TrimSpace(fenceOperationID) != op.OperationID || strings.TrimSpace(recoveryState) == SessionHistoryRecoveryReady {
		return op, false, ErrRuntimeOperationSubjectState
	}
	changed := op.NextAttemptAtMS > input.NowUnixMS
	if changed {
		result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET next_attempt_at_unix_ms = ?, version = version + 1, updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND kind = ? AND status = ?
	  AND version = ?
`, input.NowUnixMS, input.NowUnixMS, op.WorkspaceID, op.OperationID,
			RuntimeOperationKindEditRetry, RuntimeOperationStatusPrepared, input.ExpectedOperationVersion)
		if err != nil {
			return RuntimeOperation{}, false, fmt.Errorf("wake deferred edit retry: %w", err)
		}
		if applied, err := rowsWereAffected(result, "wake deferred edit retry"); err != nil || !applied {
			return RuntimeOperation{}, false, ErrRuntimeOperationSubjectState
		}
	}
	op, _, err = getRuntimeOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	mutations := []TransactionMutation(nil)
	if changed {
		if _, err := tx.ExecContext(ctx, `INSERT INTO workspace_agent_runtime_operation_recovery_actions (workspace_id, operation_id, client_action_id, action_kind, action_identity, created_at_unix_ms) VALUES (?, ?, ?, 'wake', ?, ?)`, op.WorkspaceID, op.OperationID, input.ClientActionID, actionIdentity, input.NowUnixMS); err != nil {
			return RuntimeOperation{}, false, fmt.Errorf("record edit retry wake action: %w", err)
		}
		eventPayload := map[string]any{"clientActionId": input.ClientActionID, "actionIdentity": actionIdentity, "historyRevision": historyRevision}
		event, eventFound, eventErr := getRuntimeOperationEventByOccurrenceTx(ctx, tx, op.OperationID, RuntimeOperationEventEditRetryWake, actionIdentity)
		if eventErr != nil {
			return RuntimeOperation{}, false, eventErr
		}
		if !eventFound {
			event, eventErr = insertRuntimeOperationEventTx(ctx, tx, op, RuntimeOperationEventEditRetryWake, eventPayload, input.NowUnixMS)
			if eventErr != nil {
				return RuntimeOperation{}, false, eventErr
			}
		}
		mutations = append(mutations, transactionMutation(
			op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeOperation, op.OperationID, "wake", op.Version,
		))
		if !eventFound {
			mutations = append(mutations, transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeEvent, fmt.Sprint(event.ID), "insert", event.ID))
		}
	}
	delta, err := s.commitTransaction(ctx, tx, op.WorkspaceID, mutations)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("commit wake deferred edit retry: %w", err)
	}
	committed = true
	op.CommitTransactionID, op.CommitDelta = delta.TransactionID, delta
	return op, changed, nil
}

// GetRuntimeOperationRecoveryAction reads one recovery action ledger row. It
// is intentionally generic: Host uses it to recognize an already-durable
// command before applying a stale CAS check, without making edit-retry own a
// parallel idempotency system.
