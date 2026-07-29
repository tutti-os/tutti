package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

func (s *Store) ListRecoverableSessionForkOperations(ctx context.Context, limit int) ([]SessionForkOperation, error) {
	return s.ListRecoverableSessionForkOperationsPage(ctx, SessionForkRecoveryCursor{}, limit)
}

func (s *Store) ListRecoverableSessionForkOperationsPage(
	ctx context.Context,
	after SessionForkRecoveryCursor,
	limit int,
) ([]SessionForkOperation, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, sessionForkOperationSelectSQL+`
WHERE status IN (?, ?, ?, ?)
  AND (
    created_at_unix_ms > ?
    OR (created_at_unix_ms = ? AND operation_id > ?)
  )
ORDER BY created_at_unix_ms, operation_id
LIMIT ?`, SessionForkStatusPrepared, SessionForkStatusDispatching,
		SessionForkStatusProviderAccepted, SessionForkStatusUnknown, after.CreatedAtUnixMS,
		after.CreatedAtUnixMS, strings.TrimSpace(after.OperationID), limit)
	if err != nil {
		return nil, fmt.Errorf("list recoverable session fork operations: %w", err)
	}
	defer rows.Close()
	var result []SessionForkOperation
	for rows.Next() {
		op, err := scanSessionForkOperation(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, op)
	}
	return result, rows.Err()
}

func (s *Store) MarkSessionForkDispatching(ctx context.Context, workspaceID, operationID string, now int64) (SessionForkOperation, bool, error) {
	return s.transitionSessionFork(ctx, workspaceID, operationID, SessionForkStatusPrepared,
		SessionForkStatusDispatching, "", nil, "", "", "", now)
}

// RetryUnknownSessionFork reopens only the durable dispatch marker. Callers
// must first attest that the exact driver supports one deterministic target
// provider identity across repeated dispatches.
func (s *Store) RetryUnknownSessionFork(
	ctx context.Context,
	workspaceID, operationID string,
	now int64,
) (SessionForkOperation, bool, error) {
	return s.transitionSessionFork(
		ctx,
		workspaceID,
		operationID,
		SessionForkStatusUnknown,
		SessionForkStatusDispatching,
		"",
		nil,
		"",
		"",
		"",
		now,
	)
}

func (s *Store) FailPreparedSessionFork(
	ctx context.Context,
	workspaceID, operationID, lastError string,
	now int64,
) (SessionForkOperation, bool, error) {
	return s.transitionSessionFork(
		ctx,
		workspaceID,
		operationID,
		SessionForkStatusPrepared,
		SessionForkStatusFailed,
		"",
		nil,
		"",
		"",
		lastError,
		now,
	)
}

func (s *Store) RecordSessionForkProviderResult(ctx context.Context, input SessionForkProviderResult) (SessionForkOperation, bool, error) {
	input.WorkspaceID, input.OperationID = strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.OperationID)
	input.TargetProviderSessionID = strings.TrimSpace(input.TargetProviderSessionID)
	input.LastError = strings.TrimSpace(input.LastError)
	input.StateBindingMode = strings.TrimSpace(input.StateBindingMode)
	input.StateBindingReceipt = strings.TrimSpace(input.StateBindingReceipt)
	rawTargetProviderTurnCount := len(input.TargetProviderTurnIDs)
	input.TargetProviderTurnIDs = normalizedProviderIdentityList(input.TargetProviderTurnIDs)
	if rawTargetProviderTurnCount != len(input.TargetProviderTurnIDs) {
		return SessionForkOperation{}, false, errors.New(
			"session fork target provider turn identities are invalid",
		)
	}
	if input.StateBindingMode == "" && input.Status == SessionForkStatusProviderAccepted {
		input.StateBindingMode = "host_copy"
	}
	switch input.Status {
	case SessionForkStatusProviderAccepted:
		if input.TargetProviderSessionID == "" || input.StateBindingMode == "" {
			return SessionForkOperation{}, false, errors.New("accepted session fork requires target provider session id")
		}
		switch input.StateBindingMode {
		case "host_copy":
			if len(input.TargetProviderTurnIDs) != 0 ||
				input.StateBindingReceipt != "" {
				return SessionForkOperation{}, false, errors.New(
					"host-copy session fork contains provider-owned evidence",
				)
			}
		case "provider_owned":
			if len(input.TargetProviderTurnIDs) == 0 ||
				input.StateBindingReceipt == "" {
				return SessionForkOperation{}, false, errors.New(
					"provider-owned session fork requires mapping and receipt evidence",
				)
			}
		default:
			return SessionForkOperation{}, false, errors.New(
				"accepted session fork has invalid provider state binding mode",
			)
		}
	case SessionForkStatusFailed, SessionForkStatusUnknown:
	default:
		return SessionForkOperation{}, false, errors.New("invalid session fork provider result")
	}
	return s.transitionSessionFork(ctx, input.WorkspaceID, input.OperationID,
		SessionForkStatusDispatching, input.Status, input.TargetProviderSessionID,
		input.TargetProviderTurnIDs, input.StateBindingMode, input.StateBindingReceipt,
		input.LastError, input.OccurredAtUnixMS)
}

func (s *Store) CommitSessionFork(ctx context.Context, workspaceID, operationID string, now int64) (SessionForkCommitResult, error) {
	if s == nil || s.db == nil || strings.TrimSpace(workspaceID) == "" ||
		strings.TrimSpace(operationID) == "" || now <= 0 {
		return SessionForkCommitResult{}, errors.New("valid session fork commit input is required")
	}
	workspaceID, operationID = strings.TrimSpace(workspaceID), strings.TrimSpace(operationID)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SessionForkCommitResult{}, fmt.Errorf("begin commit session fork: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	op, found, snapshotJSON, err := getSessionForkOperationWithSnapshotTx(ctx, tx, workspaceID, operationID)
	if err != nil || !found {
		return SessionForkCommitResult{}, err
	}
	if hashSessionForkBytes([]byte(snapshotJSON)) != op.SnapshotHash {
		return SessionForkCommitResult{}, errors.New("agent session fork snapshot hash mismatch")
	}
	var snapshot sessionForkSnapshot
	if err := json.Unmarshal([]byte(snapshotJSON), &snapshot); err != nil {
		return SessionForkCommitResult{}, fmt.Errorf("decode session fork snapshot: %w", err)
	}
	if snapshot.Version != 1 && snapshot.Version != 2 {
		return SessionForkCommitResult{}, fmt.Errorf(
			"unsupported session fork snapshot version %d",
			snapshot.Version,
		)
	}
	if snapshot.BoundaryMessageID <= 0 || len(snapshot.Turns) == 0 ||
		snapshot.Turns[len(snapshot.Turns)-1].Turn.TurnID != op.SourceTurnID {
		return SessionForkCommitResult{}, ErrSessionForkTurnState
	}
	switch op.StateBindingMode {
	case "host_copy":
		if len(op.TargetProviderTurnIDs) != 0 || op.StateBindingReceipt != "" {
			return SessionForkCommitResult{}, errors.New(
				"host-copy session fork contains provider-owned identity evidence",
			)
		}
	case "provider_owned":
		if op.StateBindingReceipt == "" ||
			len(op.TargetProviderTurnIDs) != len(snapshot.Turns) {
			return SessionForkCommitResult{}, errors.New(
				"provider-owned session fork has incomplete provider identity mapping",
			)
		}
	default:
		return SessionForkCommitResult{}, errors.New(
			"session fork provider state binding mode is invalid",
		)
	}
	if op.Status == SessionForkStatusCommitted {
		materialized := materializeSessionForkSnapshot(snapshot)
		session := sessionForkResultSession(op, materialized, op.CompletedAtUnixMS)
		lineage := sessionForkResultLineage(op, op.CompletedAtUnixMS)
		if _, err := s.commitTransaction(ctx, tx, workspaceID, nil); err != nil {
			return SessionForkCommitResult{}, err
		}
		return SessionForkCommitResult{
			Operation: op,
			Session:   session,
			Lineage:   lineage,
		}, nil
	}
	if op.Status != SessionForkStatusProviderAccepted || op.TargetProviderSessionID == "" {
		return SessionForkCommitResult{}, ErrSessionForkTransition
	}
	currentSource, found, err := getSessionForkSourceTx(
		ctx, tx, workspaceID, op.SourceAgentSessionID,
	)
	if err != nil {
		return SessionForkCommitResult{}, err
	}
	if !found || currentSource.ProviderSessionID != op.SourceProviderSessionID {
		return SessionForkCommitResult{}, ErrSessionForkSourceState
	}
	var throughSequence int64
	var currentProviderTurnID string
	if err := tx.QueryRowContext(ctx, `
SELECT sequence.turn_sequence, COALESCE(turn.root_provider_turn_id, '')
FROM workspace_agent_turn_sequences sequence
JOIN workspace_agent_turns turn
  ON turn.workspace_id = sequence.workspace_id
 AND turn.agent_session_id = sequence.agent_session_id
 AND turn.turn_id = sequence.turn_id
WHERE sequence.workspace_id = ?
  AND sequence.agent_session_id = ?
  AND sequence.turn_id = ?
`, workspaceID, op.SourceAgentSessionID, op.SourceTurnID).
		Scan(&throughSequence, &currentProviderTurnID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SessionForkCommitResult{}, ErrSessionForkTurnState
		}
		return SessionForkCommitResult{}, fmt.Errorf("re-read session fork boundary: %w", err)
	}
	if currentProviderTurnID != op.SourceProviderTurnID {
		return SessionForkCommitResult{}, ErrSessionForkTurnState
	}
	identityMap, err := buildSessionForkCanonicalIdentityMap(op, snapshot)
	if err != nil {
		return SessionForkCommitResult{}, errors.Join(ErrSessionForkTurnState, err)
	}
	op.TargetTurnID = identityMap.TurnIDs[op.SourceTurnID]
	if strings.TrimSpace(op.TargetTurnID) == "" {
		return SessionForkCommitResult{}, ErrSessionForkTurnState
	}
	currentSnapshot, err := loadSessionForkSnapshotTx(
		ctx, tx, currentSource, throughSequence, snapshot.BoundaryMessageID,
	)
	if err != nil {
		return SessionForkCommitResult{}, err
	}
	// Session display/configuration fields are intentionally frozen at
	// prepare. Re-proof only the canonical prefix plus provider identity so a
	// harmless title/pin update does not invalidate the fork.
	currentSnapshot.Session = snapshot.Session
	currentSnapshot.TargetCwd = snapshot.TargetCwd
	currentSnapshot.TargetRuntimeContext = cloneJSONMap(snapshot.TargetRuntimeContext)
	currentSnapshot.TargetSettings = cloneJSONMap(snapshot.TargetSettings)
	currentSnapshot.TargetTitle = snapshot.TargetTitle
	currentSnapshot.Version = snapshot.Version
	currentSnapshotJSON, err := json.Marshal(currentSnapshot)
	if err != nil {
		return SessionForkCommitResult{}, fmt.Errorf("encode current session fork prefix: %w", err)
	}
	if hashSessionForkBytes(currentSnapshotJSON) != op.SnapshotHash {
		return SessionForkCommitResult{}, errors.New("agent session fork source prefix changed after prepare")
	}
	var reservationOperationID string
	if err := tx.QueryRowContext(ctx, `
SELECT operation_id
FROM workspace_agent_session_fork_target_reservations
WHERE workspace_id = ? AND target_agent_session_id = ?
`, workspaceID, op.TargetAgentSessionID).Scan(&reservationOperationID); err != nil {
		return SessionForkCommitResult{}, fmt.Errorf("read session fork target reservation: %w", err)
	}
	if reservationOperationID != op.OperationID {
		return SessionForkCommitResult{}, ErrSessionForkTargetReserved
	}
	materializedSnapshot := materializeSessionForkSnapshot(snapshot)
	if err := insertForkedSessionTx(ctx, tx, op, materializedSnapshot, now); err != nil {
		return SessionForkCommitResult{}, err
	}
	mutations := []TransactionMutation{
		transactionMutation(workspaceID, op.TargetAgentSessionID, MutationEntitySession, op.TargetAgentSessionID, "insert", now),
	}
	for index, item := range snapshot.Turns {
		turn, err := remapSessionForkTurn(item.Turn, identityMap)
		if err != nil {
			return SessionForkCommitResult{}, err
		}
		if len(op.TargetProviderTurnIDs) != 0 {
			turn.RootProviderTurnID = op.TargetProviderTurnIDs[index]
		}
		if err := insertForkedTurnTx(ctx, tx, workspaceID, op.TargetAgentSessionID, turn); err != nil {
			return SessionForkCommitResult{}, err
		}
		mutations = append(mutations, transactionMutation(workspaceID, op.TargetAgentSessionID, MutationEntityTurn, turn.TurnID, "insert", turn.UpdatedAtUnixMS))
	}
	for index, message := range snapshot.Messages {
		message, err = remapSessionForkMessage(message, identityMap)
		if err != nil {
			return SessionForkCommitResult{}, err
		}
		version := uint64(index + 1)
		if err := insertForkedMessageTx(ctx, tx, workspaceID, op.TargetAgentSessionID, message, version); err != nil {
			return SessionForkCommitResult{}, err
		}
		mutations = append(mutations, transactionMutation(workspaceID, op.TargetAgentSessionID, MutationEntityMessage, message.MessageID, "insert", int64(version)))
	}
	for _, interaction := range snapshot.Interactions {
		interaction, err = remapSessionForkInteraction(interaction, identityMap)
		if err != nil {
			return SessionForkCommitResult{}, err
		}
		if err := insertForkedInteractionTx(ctx, tx, workspaceID, op.TargetAgentSessionID, interaction); err != nil {
			return SessionForkCommitResult{}, err
		}
		mutations = append(mutations, transactionMutation(
			workspaceID,
			op.TargetAgentSessionID,
			MutationEntityInteraction,
			interactionMutationEntityID(interaction.TurnID, interaction.RequestID),
			"insert",
			interaction.UpdatedAtUnixMS,
		))
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET message_version = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ?
`, len(snapshot.Messages), now, workspaceID, op.TargetAgentSessionID); err != nil {
		return SessionForkCommitResult{}, fmt.Errorf("finalize forked session message version: %w", err)
	}
	targetSession, found, err := getSessionForkSourceTx(
		ctx, tx, workspaceID, op.TargetAgentSessionID,
	)
	if err != nil {
		return SessionForkCommitResult{}, err
	}
	if !found {
		return SessionForkCommitResult{}, errors.New(
			"forked workspace agent session was not readable after insert",
		)
	}
	lineage := sessionForkResultLineage(op, now)
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_session_forks (
  workspace_id, target_agent_session_id, source_agent_session_id,
  source_turn_id, target_turn_id, operation_id, forked_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?)
`, lineage.WorkspaceID, lineage.TargetAgentSessionID, lineage.SourceAgentSessionID,
		lineage.SourceTurnID, lineage.TargetTurnID, lineage.OperationID,
		lineage.ForkedAtUnixMS); err != nil {
		return SessionForkCommitResult{}, fmt.Errorf("insert session fork lineage: %w", err)
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_fork_operations
SET status = ?, target_turn_id = ?, completed_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND status = ?
`, SessionForkStatusCommitted, op.TargetTurnID, now, now, workspaceID, operationID,
		SessionForkStatusProviderAccepted)
	if err != nil {
		return SessionForkCommitResult{}, fmt.Errorf("complete session fork operation: %w", err)
	}
	changed, err := rowsWereAffected(result, "complete session fork operation")
	if err != nil || !changed {
		return SessionForkCommitResult{}, errors.Join(err, ErrSessionForkTransition)
	}
	mutations = append(mutations,
		transactionMutation(workspaceID, op.SourceAgentSessionID, MutationEntitySessionForkOperation, op.OperationID, "complete", now),
	)
	delta, err := s.commitTransaction(ctx, tx, workspaceID, mutations)
	if err != nil {
		return SessionForkCommitResult{}, fmt.Errorf("commit session fork clone: %w", err)
	}
	op.Status, op.CompletedAtUnixMS, op.UpdatedAtUnixMS = SessionForkStatusCommitted, now, now
	op.CommitTransactionID, op.CommitDelta = delta.TransactionID, delta
	return SessionForkCommitResult{
		TransactionID: delta.TransactionID, CommitDelta: delta, Operation: op,
		Session: targetSession, Lineage: lineage, Changed: true,
	}, nil
}

func (s *Store) AcknowledgeSessionForkOperation(
	ctx context.Context,
	workspaceID, operationID string,
	now int64,
) (SessionForkOperation, bool, bool, error) {
	if s == nil || s.db == nil || strings.TrimSpace(workspaceID) == "" ||
		strings.TrimSpace(operationID) == "" || now <= 0 {
		return SessionForkOperation{}, false, false, errors.New(
			"valid session fork acknowledgement input is required",
		)
	}
	workspaceID = strings.TrimSpace(workspaceID)
	operationID = strings.TrimSpace(operationID)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SessionForkOperation{}, false, false, fmt.Errorf(
			"begin acknowledge session fork: %w",
			err,
		)
	}
	defer func() { _ = tx.Rollback() }()
	op, found, err := getSessionForkOperationTx(ctx, tx, workspaceID, operationID)
	if err != nil || !found {
		return SessionForkOperation{}, found, false, err
	}
	if op.Status != SessionForkStatusCommitted {
		return op, true, false, ErrSessionForkTransition
	}
	changed := op.ClientObservedAtUnixMS == 0
	if changed {
		result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_fork_operations
SET client_observed_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ?
  AND status = 'committed' AND client_observed_at_unix_ms IS NULL
`, now, now, workspaceID, operationID)
		if err != nil {
			return SessionForkOperation{}, true, false, fmt.Errorf(
				"acknowledge committed session fork: %w",
				err,
			)
		}
		if changed, err = rowsWereAffected(
			result,
			"acknowledge committed session fork",
		); err != nil {
			return SessionForkOperation{}, true, false, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_session_fork_boundary_barriers
WHERE workspace_id = ? AND operation_id = ?
`, workspaceID, operationID); err != nil {
		return SessionForkOperation{}, true, false, fmt.Errorf(
			"release observed session fork boundary barrier: %w",
			err,
		)
	}
	op, found, err = getSessionForkOperationTx(ctx, tx, workspaceID, operationID)
	if err != nil || !found {
		return SessionForkOperation{}, found, false, err
	}
	mutations := []TransactionMutation(nil)
	if changed {
		mutations = append(mutations, transactionMutation(
			workspaceID,
			op.SourceAgentSessionID,
			MutationEntitySessionForkOperation,
			operationID,
			"client_observed",
			now,
		))
	}
	delta, err := s.commitTransaction(ctx, tx, workspaceID, mutations)
	if err != nil {
		return SessionForkOperation{}, true, false, err
	}
	op.CommitTransactionID, op.CommitDelta = delta.TransactionID, delta
	return op, true, changed, nil
}

func (s *Store) GetSessionForkLineage(ctx context.Context, workspaceID, targetSessionID string) (SessionForkLineage, bool, error) {
	if s == nil || s.db == nil {
		return SessionForkLineage{}, false, errors.New("workspace database is not initialized")
	}
	row := s.db.QueryRowContext(ctx, `
SELECT workspace_id, target_agent_session_id, source_agent_session_id,
       source_turn_id, target_turn_id, operation_id, forked_at_unix_ms
FROM workspace_agent_session_forks
WHERE workspace_id = ? AND target_agent_session_id = ?
`, strings.TrimSpace(workspaceID), strings.TrimSpace(targetSessionID))
	return scanSessionForkLineage(row)
}

func (s *Store) transitionSessionFork(
	ctx context.Context,
	workspaceID, operationID, fromStatus, toStatus, targetProviderSessionID string,
	targetProviderTurnIDs []string, stateBindingMode, stateBindingReceipt, lastError string,
	now int64,
) (SessionForkOperation, bool, error) {
	if s == nil || s.db == nil || strings.TrimSpace(workspaceID) == "" ||
		strings.TrimSpace(operationID) == "" || now <= 0 {
		return SessionForkOperation{}, false, errors.New("valid session fork transition input is required")
	}
	workspaceID, operationID = strings.TrimSpace(workspaceID), strings.TrimSpace(operationID)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SessionForkOperation{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if targetProviderTurnIDs == nil {
		targetProviderTurnIDs = []string{}
	}
	targetProviderTurnIDsJSON, err := json.Marshal(targetProviderTurnIDs)
	if err != nil {
		return SessionForkOperation{}, false, err
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_fork_operations
SET status = ?, target_provider_session_id = NULLIF(?, ''), last_error = ?,
    target_provider_turn_ids_json = ?,
    provider_state_binding_mode = ?,
    provider_state_binding_receipt = ?,
    dispatched_at_unix_ms = CASE WHEN ? = 'dispatching' THEN ? ELSE dispatched_at_unix_ms END,
    accepted_at_unix_ms = CASE WHEN ? = 'provider_accepted' THEN ? ELSE accepted_at_unix_ms END,
    completed_at_unix_ms = CASE
      WHEN ? = 'dispatching' THEN 0
      WHEN ? IN ('failed','unknown') THEN ?
      ELSE completed_at_unix_ms
    END,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND status = ?
`, toStatus, strings.TrimSpace(targetProviderSessionID), strings.TrimSpace(lastError),
		string(targetProviderTurnIDsJSON), strings.TrimSpace(stateBindingMode),
		strings.TrimSpace(stateBindingReceipt),
		toStatus, now, toStatus, now, toStatus, toStatus, now, now,
		workspaceID, operationID, fromStatus)
	if err != nil {
		return SessionForkOperation{}, false, fmt.Errorf("transition session fork operation: %w", err)
	}
	changed, err := rowsWereAffected(result, "transition session fork operation")
	if err != nil {
		return SessionForkOperation{}, false, err
	}
	op, found, err := getSessionForkOperationTx(ctx, tx, workspaceID, operationID)
	if err != nil || !found {
		return SessionForkOperation{}, false, err
	}
	if !changed && op.Status != toStatus {
		return op, false, ErrSessionForkTransition
	}
	if changed && toStatus == SessionForkStatusFailed {
		if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_session_fork_target_reservations
WHERE workspace_id = ? AND operation_id = ?
`, workspaceID, operationID); err != nil {
			return SessionForkOperation{}, false, fmt.Errorf(
				"release failed session fork target reservation: %w",
				err,
			)
		}
		if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_session_fork_boundary_barriers
WHERE workspace_id = ? AND operation_id = ?
`, workspaceID, operationID); err != nil {
			return SessionForkOperation{}, false, fmt.Errorf(
				"release failed session fork boundary barrier: %w",
				err,
			)
		}
	}
	mutations := []TransactionMutation(nil)
	if changed {
		mutations = append(mutations, transactionMutation(workspaceID, op.SourceAgentSessionID, MutationEntitySessionForkOperation, operationID, toStatus, now))
	}
	delta, err := s.commitTransaction(ctx, tx, workspaceID, mutations)
	if err != nil {
		return SessionForkOperation{}, false, err
	}
	op.CommitTransactionID, op.CommitDelta = delta.TransactionID, delta
	return op, changed, nil
}
