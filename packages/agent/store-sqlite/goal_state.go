package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	agentactivityprojection "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

const sessionGoalStateSelectSQL = `
SELECT workspace_id, agent_session_id, desired_json, observed_json, revision,
       tombstoned, sync_status, COALESCE(pending_operation_id, ''),
       last_evidence_json, last_error, COALESCE(observed_at_unix_ms, 0),
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_session_goals`

const goalControlOperationSelectSQL = `
SELECT operation_id, workspace_id, agent_session_id, goal_revision, action,
       objective, status, evidence_json, last_error, created_at_unix_ms,
       updated_at_unix_ms, COALESCE(completed_at_unix_ms, 0), provider_phase,
       COALESCE(lease_owner, ''), COALESCE(lease_expires_at_unix_ms, 0),
       COALESCE(next_attempt_at_unix_ms, 0), attempt, repair_required, repair_epoch,
       COALESCE(accepted_at_unix_ms, 0), accepted_attempt,
       COALESCE(first_dispatched_at_unix_ms, 0), dispatched_attempt,
       COALESCE(client_submit_id, '')
FROM workspace_agent_goal_control_operations`

func (s *Store) PrepareGoalControlOperation(ctx context.Context, input GoalControlOperationPrepare) (GoalControlOperation, SessionGoalState, bool, error) {
	if s == nil || s.db == nil {
		return GoalControlOperation{}, SessionGoalState{}, false, errors.New("workspace database is not initialized")
	}
	input.OperationID = strings.TrimSpace(input.OperationID)
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.Action = strings.TrimSpace(input.Action)
	input.Objective = strings.TrimSpace(input.Objective)
	input.ClientSubmitID = strings.TrimSpace(input.ClientSubmitID)
	if input.OperationID == "" || input.WorkspaceID == "" || input.AgentSessionID == "" || input.OccurredAtUnixMS <= 0 {
		return GoalControlOperation{}, SessionGoalState{}, false, errors.New("goal operation identity, scope, and occurred time are required")
	}
	if !isKnownGoalControlAction(input.Action) || input.Action == "reconcile" {
		return GoalControlOperation{}, SessionGoalState{}, false, fmt.Errorf("unsupported goal control action %q", input.Action)
	}
	if input.Action == "set" && input.Objective == "" {
		return GoalControlOperation{}, SessionGoalState{}, false, errors.New("goal objective is required")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, fmt.Errorf("begin goal control operation: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if existing, found, err := getGoalControlOperationTx(ctx, tx, input.WorkspaceID, input.OperationID); err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	} else if found {
		state, _, stateErr := getSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID)
		if stateErr != nil {
			return GoalControlOperation{}, SessionGoalState{}, false, stateErr
		}
		if existing.AgentSessionID != input.AgentSessionID || existing.Action != input.Action || existing.Objective != input.Objective || existing.ClientSubmitID != input.ClientSubmitID {
			return GoalControlOperation{}, SessionGoalState{}, false, ErrGoalOperationConflict
		}
		if _, err := s.commitTransaction(ctx, tx, input.WorkspaceID, nil); err != nil {
			return GoalControlOperation{}, SessionGoalState{}, false, err
		}
		committed = true
		return existing, state, false, nil
	}

	state, found, err := getSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	if !found {
		state, err = bootstrapSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID, input.OccurredAtUnixMS)
		if err != nil {
			return GoalControlOperation{}, SessionGoalState{}, false, err
		}
	}
	desired := cloneJSONMap(state.Desired)
	tombstoned := false
	switch input.Action {
	case "set":
		desired = map[string]any{"objective": input.Objective, "status": "active"}
	case "clear":
		desired = nil
		tombstoned = true
	case "pause", "resume":
		if len(desired) == 0 {
			desired = cloneJSONMap(state.Observed)
		}
		if len(desired) == 0 {
			return GoalControlOperation{}, SessionGoalState{}, false, ErrGoalStateAbsent
		}
		if input.Action == "pause" {
			desired["status"] = "paused"
		} else {
			desired["status"] = "active"
		}
	}
	revision := state.Revision + 1
	desiredJSON, err := marshalNullableJSONMap(desired)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	if state.PendingOperationID != "" {
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_goal_control_operations
SET status = ?, updated_at_unix_ms = ?, completed_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND status IN (?, ?)
`, GoalOperationStatusSuperseded, input.OccurredAtUnixMS, input.OccurredAtUnixMS,
			input.WorkspaceID, state.PendingOperationID, GoalOperationStatusPrepared, GoalOperationStatusDispatched); err != nil {
			return GoalControlOperation{}, SessionGoalState{}, false, fmt.Errorf("supersede prior goal operation: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_session_goals (
  workspace_id, agent_session_id, desired_json, observed_json, revision,
  tombstoned, sync_status, pending_operation_id, last_evidence_json,
  last_error, observed_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id) DO UPDATE SET
  desired_json = excluded.desired_json,
  revision = excluded.revision,
  tombstoned = excluded.tombstoned,
  sync_status = excluded.sync_status,
  pending_operation_id = excluded.pending_operation_id,
  last_error = '',
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, input.WorkspaceID, input.AgentSessionID, desiredJSON, nullableJSONMap(state.Observed), revision,
		boolInt(tombstoned), GoalSyncStatusPending, input.OperationID, marshalJSONMapOrEmpty(state.LastEvidence),
		nullInt64(state.ObservedAtUnixMS), state.CreatedAtUnixMS, input.OccurredAtUnixMS); err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, fmt.Errorf("write desired goal state: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_goal_control_operations (
  operation_id, workspace_id, agent_session_id, goal_revision, action,
  objective, status, provider_phase, next_attempt_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms, client_submit_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, input.OperationID, input.WorkspaceID, input.AgentSessionID, revision, input.Action,
		input.Objective, GoalOperationStatusPrepared, GoalProviderPhasePrepared, input.OccurredAtUnixMS,
		input.OccurredAtUnixMS, input.OccurredAtUnixMS, input.ClientSubmitID); err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, fmt.Errorf("insert goal control operation: %w", err)
	}
	auditMessage, accepted, err := s.upsertAgentMessageTx(
		ctx,
		tx,
		input.WorkspaceID,
		input.AgentSessionID,
		goalControlAuditMessageUpdate(input, revision),
		input.OccurredAtUnixMS,
		false,
		true,
	)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, fmt.Errorf("insert goal control audit: %w", err)
	} else if !accepted {
		return GoalControlOperation{}, SessionGoalState{}, false, errors.New("goal control audit was not accepted")
	}
	op, _, err := getGoalControlOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	state, _, err = getSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	delta, err := s.commitTransaction(ctx, tx, input.WorkspaceID, []TransactionMutation{
		transactionMutation(input.WorkspaceID, input.AgentSessionID, MutationEntityGoalState, input.AgentSessionID, "upsert", revision),
		transactionMutation(input.WorkspaceID, input.AgentSessionID, MutationEntityGoalOperation, input.OperationID, "prepare", op.UpdatedAtUnixMS),
		transactionMutation(input.WorkspaceID, input.AgentSessionID, MutationEntityMessage, auditMessage.MessageID, "insert", int64(auditMessage.Version)),
	})
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, fmt.Errorf("commit goal control operation: %w", err)
	}
	committed = true
	op.CommitTransactionID = delta.TransactionID
	op.CommitDelta = delta
	state.CommitTransactionID = delta.TransactionID
	state.CommitDelta = delta
	return op, state, true, nil
}

func (s *Store) GetGoalControlAudit(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	operationID string,
) (Message, bool, error) {
	if s == nil || s.db == nil {
		return Message{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	operationID = strings.TrimSpace(operationID)
	if workspaceID == "" || agentSessionID == "" || operationID == "" {
		return Message{}, false, nil
	}
	row := s.db.QueryRowContext(ctx, `
SELECT id, agent_session_id, message_id, version, turn_id, role, kind, status,
       semantics_json, payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_messages
WHERE workspace_id = ? AND agent_session_id = ? AND message_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, agentSessionID, "goal-control:"+operationID)
	message, err := scanAgentMessage(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, false, nil
	}
	if err != nil {
		return Message{}, false, fmt.Errorf("get goal control audit: %w", err)
	}
	return message, true, nil
}

func (s *Store) MarkGoalControlOperationDispatched(ctx context.Context, workspaceID, operationID string, occurredAt int64) (GoalControlOperation, bool, error) {
	workspaceID, operationID = strings.TrimSpace(workspaceID), strings.TrimSpace(operationID)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_goal_control_operations
SET status = ?, provider_phase = ?, updated_at_unix_ms = ?,
    first_dispatched_at_unix_ms = COALESCE(first_dispatched_at_unix_ms, ?),
    dispatched_attempt = CASE WHEN first_dispatched_at_unix_ms IS NULL THEN attempt ELSE dispatched_attempt END
WHERE workspace_id = ? AND operation_id = ? AND status = ?
`, GoalOperationStatusDispatched, GoalProviderPhaseDispatched, occurredAt, occurredAt, workspaceID, operationID, GoalOperationStatusPrepared)
	if err != nil {
		return GoalControlOperation{}, false, fmt.Errorf("dispatch goal control operation: %w", err)
	}
	changed, _ := result.RowsAffected()
	op, found, err := getGoalControlOperationTx(ctx, tx, workspaceID, operationID)
	if err != nil || !found {
		return GoalControlOperation{}, false, err
	}
	if changed > 0 {
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_goals
SET sync_status = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND pending_operation_id = ?
`, GoalSyncStatusApplying, occurredAt, workspaceID, op.AgentSessionID, operationID); err != nil {
			return GoalControlOperation{}, false, fmt.Errorf("mark goal state applying: %w", err)
		}
	}
	mutations := []TransactionMutation{}
	if changed > 0 {
		mutations = append(mutations,
			transactionMutation(workspaceID, op.AgentSessionID, MutationEntityGoalOperation, operationID, "dispatch", op.UpdatedAtUnixMS),
			transactionMutation(workspaceID, op.AgentSessionID, MutationEntityGoalState, op.AgentSessionID, "upsert", op.GoalRevision),
		)
	}
	delta, err := s.commitTransaction(ctx, tx, workspaceID, mutations)
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	op.CommitTransactionID = delta.TransactionID
	op.CommitDelta = delta
	return op, changed > 0, nil
}

// AcknowledgeGoalControlOperation records transport/provider acceptance
// without claiming that the command has been consumed or applied. The
// operation deliberately remains dispatched and the Goal remains applying.
func (s *Store) AcknowledgeGoalControlOperation(ctx context.Context, input GoalControlOperationAcknowledge) (GoalControlOperation, SessionGoalState, bool, error) {
	input.WorkspaceID, input.OperationID = strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.OperationID)
	if input.WorkspaceID == "" || input.OperationID == "" || input.OccurredAtUnixMS <= 0 {
		return GoalControlOperation{}, SessionGoalState{}, false, errors.New("goal acknowledgement identity and occurred time are required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	op, found, err := getGoalControlOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil || !found {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	state, stateFound, err := getSessionGoalStateTx(ctx, tx, input.WorkspaceID, op.AgentSessionID)
	if err != nil || !stateFound {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	if op.Status != GoalOperationStatusDispatched || state.PendingOperationID != input.OperationID {
		if _, err := s.commitTransaction(ctx, tx, input.WorkspaceID, nil); err != nil {
			return GoalControlOperation{}, SessionGoalState{}, false, err
		}
		return op, state, false, nil
	}
	if op.RepairRequired && input.RepairEpoch != op.RepairEpoch {
		if _, err := s.commitTransaction(ctx, tx, input.WorkspaceID, nil); err != nil {
			return GoalControlOperation{}, SessionGoalState{}, false, err
		}
		return op, state, false, nil
	}
	evidenceJSON := marshalJSONMapOrEmpty(input.Evidence)
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_goal_control_operations
SET evidence_json = ?, provider_phase = ?, lease_owner = NULL,
    lease_expires_at_unix_ms = NULL, next_attempt_at_unix_ms = ?, updated_at_unix_ms = ?,
    accepted_at_unix_ms = COALESCE(accepted_at_unix_ms, ?),
    accepted_attempt = CASE WHEN accepted_at_unix_ms IS NULL THEN attempt ELSE accepted_attempt END
WHERE workspace_id = ? AND operation_id = ? AND status = ?
`, evidenceJSON, GoalProviderPhaseAccepted, input.OccurredAtUnixMS+5000, input.OccurredAtUnixMS, input.OccurredAtUnixMS,
		input.WorkspaceID, input.OperationID, GoalOperationStatusDispatched); err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_goals
SET sync_status = ?, last_evidence_json = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND pending_operation_id = ?
`, GoalSyncStatusApplying, evidenceJSON, input.OccurredAtUnixMS, input.WorkspaceID, op.AgentSessionID, input.OperationID); err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	op, _, err = getGoalControlOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	state, _, err = getSessionGoalStateTx(ctx, tx, input.WorkspaceID, op.AgentSessionID)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	delta, err := s.commitTransaction(ctx, tx, input.WorkspaceID, []TransactionMutation{
		transactionMutation(input.WorkspaceID, op.AgentSessionID, MutationEntityGoalOperation, op.OperationID, "acknowledge", op.UpdatedAtUnixMS),
		transactionMutation(input.WorkspaceID, op.AgentSessionID, MutationEntityGoalState, op.AgentSessionID, "upsert", state.Revision),
	})
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	op.CommitTransactionID = delta.TransactionID
	op.CommitDelta = delta
	state.CommitTransactionID = delta.TransactionID
	state.CommitDelta = delta
	return op, state, true, nil
}

func (s *Store) CompleteGoalControlOperation(ctx context.Context, input GoalControlOperationComplete) (GoalControlOperation, SessionGoalState, bool, error) {
	input.WorkspaceID, input.OperationID = strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.OperationID)
	if input.WorkspaceID == "" || input.OperationID == "" || input.OccurredAtUnixMS <= 0 {
		return GoalControlOperation{}, SessionGoalState{}, false, errors.New("goal completion identity and occurred time are required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	op, found, err := getGoalControlOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil || !found {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	state, stateFound, err := getSessionGoalStateTx(ctx, tx, input.WorkspaceID, op.AgentSessionID)
	if err != nil || !stateFound {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	if op.Status == GoalOperationStatusCompleted || op.Status == GoalOperationStatusFailed || op.Status == GoalOperationStatusSuperseded {
		if _, err := s.commitTransaction(ctx, tx, input.WorkspaceID, nil); err != nil {
			return GoalControlOperation{}, SessionGoalState{}, false, err
		}
		return op, state, false, nil
	}
	if op.RepairRequired && input.RepairEpoch != op.RepairEpoch {
		if _, err := s.commitTransaction(ctx, tx, input.WorkspaceID, nil); err != nil {
			return GoalControlOperation{}, SessionGoalState{}, false, err
		}
		return op, state, false, nil
	}
	terminalFence, err := goalRevisionTerminalFenceTx(ctx, tx, state.WorkspaceID, state.AgentSessionID, state.Revision)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	status := GoalOperationStatusFailed
	syncStatus := GoalSyncStatusFailed
	if input.Succeeded {
		status = GoalOperationStatusCompleted
		if goalStateConverged(state.Desired, input.Observed, state.Tombstoned) {
			syncStatus = GoalSyncStatusSynced
		} else {
			syncStatus = GoalSyncStatusDiverged
		}
	}
	stateLastError := strings.TrimSpace(input.LastError)
	syncStatus, stateLastError = terminalGoalSyncState(state, syncStatus, stateLastError, terminalFence)
	evidenceJSON := marshalJSONMapOrEmpty(input.Evidence)
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_goal_control_operations
SET status = ?, evidence_json = ?, last_error = ?, provider_phase = ?,
    lease_owner = NULL, lease_expires_at_unix_ms = NULL, next_attempt_at_unix_ms = NULL,
    repair_required = 0,
    updated_at_unix_ms = ?, completed_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ?
`, status, evidenceJSON, strings.TrimSpace(input.LastError), providerPhaseForCompletion(input.Succeeded), input.OccurredAtUnixMS,
		input.OccurredAtUnixMS, input.WorkspaceID, input.OperationID); err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_goals
SET observed_json = ?, sync_status = ?, pending_operation_id = NULL,
    last_evidence_json = ?, last_error = ?, observed_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND pending_operation_id = ?
`, nullableJSONMap(input.Observed), syncStatus, evidenceJSON, stateLastError,
		input.OccurredAtUnixMS, input.OccurredAtUnixMS, input.WorkspaceID, op.AgentSessionID, input.OperationID); err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	op, _, err = getGoalControlOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	state, _, err = getSessionGoalStateTx(ctx, tx, input.WorkspaceID, op.AgentSessionID)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	delta, err := s.commitTransaction(ctx, tx, input.WorkspaceID, []TransactionMutation{
		transactionMutation(input.WorkspaceID, op.AgentSessionID, MutationEntityGoalOperation, op.OperationID, "complete", op.UpdatedAtUnixMS),
		transactionMutation(input.WorkspaceID, op.AgentSessionID, MutationEntityGoalState, op.AgentSessionID, "upsert", state.Revision),
	})
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	op.CommitTransactionID = delta.TransactionID
	op.CommitDelta = delta
	state.CommitTransactionID = delta.TransactionID
	state.CommitDelta = delta
	return op, state, true, nil
}

func (s *Store) GetSessionGoalState(ctx context.Context, workspaceID, agentSessionID string) (SessionGoalState, bool, error) {
	if s == nil || s.db == nil {
		return SessionGoalState{}, false, errors.New("workspace database is not initialized")
	}
	return getSessionGoalState(ctx, s.db, strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID))
}

func (s *Store) ReconcileSessionGoalObservation(ctx context.Context, input GoalObservationReconcile) (SessionGoalState, error) {
	input.WorkspaceID, input.AgentSessionID = strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.AgentSessionID)
	if input.WorkspaceID == "" || input.AgentSessionID == "" || input.OccurredAtUnixMS <= 0 {
		return SessionGoalState{}, errors.New("goal observation scope and occurred time are required")
	}
	// SQLite serializes writers, but the explicit revision/pending/timestamp
	// predicate is still the state-machine contract and protects alternative
	// repository implementations from a stale read-modify-write.
	for attempt := 0; attempt < 4; attempt++ {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return SessionGoalState{}, err
		}
		state, found, err := getSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID)
		if err != nil {
			_ = tx.Rollback()
			return SessionGoalState{}, err
		}
		if input.Expected != nil && input.Expected.Exists != found {
			_ = tx.Rollback()
			return SessionGoalState{}, ErrGoalReconcileConflict
		}
		if !found {
			state, err = bootstrapSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID, input.OccurredAtUnixMS)
			if err != nil {
				_ = tx.Rollback()
				return SessionGoalState{}, err
			}
		}
		if input.Expected != nil && input.Expected.Exists && (state.Revision != input.Expected.Revision ||
			state.PendingOperationID != strings.TrimSpace(input.Expected.PendingOperationID) ||
			state.ObservedAtUnixMS != input.Expected.ObservedAtUnixMS) {
			_ = tx.Rollback()
			return SessionGoalState{}, ErrGoalReconcileConflict
		}
		if state.ObservedAtUnixMS > input.OccurredAtUnixMS {
			_ = tx.Rollback()
			return state, nil
		}
		terminalFence, err := goalRevisionTerminalFenceTx(ctx, tx, input.WorkspaceID, input.AgentSessionID, state.Revision)
		if err != nil {
			_ = tx.Rollback()
			return SessionGoalState{}, err
		}
		forceUnknown := input.ForceSyncUnknown || terminalFence
		lastError := strings.TrimSpace(input.LastError)
		converged := goalStateConverged(state.Desired, input.Observed, state.Tombstoned)
		syncStatus := GoalSyncStatusUnknown
		completePending := false
		if !forceUnknown {
			if state.PendingOperationID != "" {
				syncStatus = GoalSyncStatusApplying
				pending, pendingFound, pendingErr := getGoalControlOperationTx(ctx, tx, input.WorkspaceID, state.PendingOperationID)
				if pendingErr != nil {
					_ = tx.Rollback()
					return SessionGoalState{}, pendingErr
				}
				completePending = converged && pendingFound && goalEvidenceAuthoritativeForPending(input.Evidence, state, pending)
				if completePending {
					syncStatus = GoalSyncStatusSynced
				}
			} else if converged {
				syncStatus = GoalSyncStatusSynced
			} else if state.Revision > 0 {
				syncStatus = GoalSyncStatusDiverged
			}
		}
		syncStatus, lastError = terminalGoalSyncState(state, syncStatus, lastError, terminalFence)
		expectedPending := state.PendingOperationID
		pendingValue := any(expectedPending)
		if expectedPending == "" || completePending {
			pendingValue = nil
		}
		result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_goals
SET observed_json = ?, sync_status = ?, pending_operation_id = ?, last_evidence_json = ?,
    last_error = ?, observed_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND revision = ?
  AND COALESCE(pending_operation_id, '') = ? AND COALESCE(observed_at_unix_ms, 0) = ?
`, nullableJSONMap(input.Observed), syncStatus, pendingValue, marshalJSONMapOrEmpty(input.Evidence), lastError,
			input.OccurredAtUnixMS, input.OccurredAtUnixMS, input.WorkspaceID, input.AgentSessionID,
			state.Revision, expectedPending, state.ObservedAtUnixMS)
		if err != nil {
			_ = tx.Rollback()
			return SessionGoalState{}, err
		}
		changed, err := rowsWereAffected(result, "reconcile goal observation CAS")
		if err != nil {
			_ = tx.Rollback()
			return SessionGoalState{}, err
		}
		if !changed {
			_ = tx.Rollback()
			continue
		}
		if completePending {
			if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_goal_control_operations
SET status = ?, provider_phase = ?, evidence_json = ?, lease_owner = NULL,
    lease_expires_at_unix_ms = NULL, next_attempt_at_unix_ms = NULL,
    repair_required = 0,
    updated_at_unix_ms = ?, completed_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND goal_revision = ? AND status IN (?, ?)
`, GoalOperationStatusCompleted, GoalProviderPhaseApplied, marshalJSONMapOrEmpty(input.Evidence),
				input.OccurredAtUnixMS, input.OccurredAtUnixMS, input.WorkspaceID, expectedPending,
				state.Revision, GoalOperationStatusPrepared, GoalOperationStatusDispatched); err != nil {
				_ = tx.Rollback()
				return SessionGoalState{}, err
			}
		}
		updated, _, err := getSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID)
		if err == nil {
			mutations := []TransactionMutation{
				transactionMutation(input.WorkspaceID, input.AgentSessionID, MutationEntityGoalState, input.AgentSessionID, "reconcile", updated.Revision),
			}
			if completePending {
				mutations = append(mutations, transactionMutation(input.WorkspaceID, input.AgentSessionID, MutationEntityGoalOperation, expectedPending, "complete", input.OccurredAtUnixMS))
			}
			var delta TransactionDelta
			delta, err = s.commitTransaction(ctx, tx, input.WorkspaceID, mutations)
			updated.CommitTransactionID = delta.TransactionID
			updated.CommitDelta = delta
		} else {
			_ = tx.Rollback()
		}
		return updated, err
	}
	return SessionGoalState{}, errors.New("goal observation reconcile CAS did not converge")
}

func goalEvidenceAuthoritativeForPending(evidence map[string]any, state SessionGoalState, op GoalControlOperation) bool {
	if op.RepairRequired && jsonMapInt64(evidence, "repairEpoch") != op.RepairEpoch {
		return false
	}
	if strings.TrimSpace(asJSONMapString(evidence, "confidence")) == "authoritative" {
		return true
	}
	return strings.TrimSpace(asJSONMapString(evidence, "phase")) == GoalProviderPhaseApplied &&
		strings.TrimSpace(asJSONMapString(evidence, "operationId")) == state.PendingOperationID &&
		jsonMapInt64(evidence, "revision") == state.Revision
}

func bootstrapSessionGoalStateTx(ctx context.Context, tx *sql.Tx, workspaceID, agentSessionID string, now int64) (SessionGoalState, error) {
	var metadataJSON string
	if err := tx.QueryRowContext(ctx, `SELECT session_metadata_json FROM workspace_agent_sessions WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0`, workspaceID, agentSessionID).Scan(&metadataJSON); err != nil {
		return SessionGoalState{}, err
	}
	metadata, err := unmarshalJSONMap(metadataJSON)
	if err != nil {
		return SessionGoalState{}, err
	}
	observed, _ := metadata["goal"].(map[string]any)
	desired := cloneJSONMap(observed)
	syncStatus := GoalSyncStatusUnknown
	if len(observed) > 0 {
		syncStatus = GoalSyncStatusSynced
	}
	if _, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO workspace_agent_session_goals (
  workspace_id, agent_session_id, desired_json, observed_json, revision,
  tombstoned, sync_status, last_evidence_json, observed_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, 0, 0, ?, '{}', ?, ?, ?)
`, workspaceID, agentSessionID, nullableJSONMap(desired), nullableJSONMap(observed), syncStatus,
		nullInt64(now), now, now); err != nil {
		return SessionGoalState{}, err
	}
	state, _, err := getSessionGoalStateTx(ctx, tx, workspaceID, agentSessionID)
	return state, err
}

// reconcileObservedGoalFromSessionTx is the bottom-up synchronization path:
// accepted runtime session snapshots update only the observed side. A pending
// upper intent stays applying until its own operation completes, preventing a
// late provider snapshot from erasing a newer desired revision/tombstone.
func reconcileObservedGoalFromSessionTx(ctx context.Context, tx *sql.Tx, session agentactivityprojection.SessionSnapshot, occurredAt int64) error {
	workspaceID, agentSessionID := strings.TrimSpace(session.WorkspaceID), strings.TrimSpace(session.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return nil
	}
	metadata, _, err := splitSessionRuntimeContext(session.RuntimeContext)
	if err != nil {
		return err
	}
	var observed map[string]any
	if metadata.Goal != nil {
		if err := remarshalJSON(metadata.Goal, &observed); err != nil {
			return err
		}
	}
	state, found, err := getSessionGoalStateTx(ctx, tx, workspaceID, agentSessionID)
	if err != nil {
		return err
	}
	if !found {
		syncStatus := GoalSyncStatusUnknown
		if len(observed) > 0 {
			syncStatus = GoalSyncStatusSynced
		}
		_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_agent_session_goals (
  workspace_id, agent_session_id, desired_json, observed_json, revision,
  tombstoned, sync_status, last_evidence_json, observed_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)
`, workspaceID, agentSessionID, nullableJSONMap(observed), nullableJSONMap(observed), syncStatus,
			`{"source":"runtime_session_report","confidence":"provider_observed"}`,
			nullInt64(occurredAt), occurredAt, occurredAt)
		return err
	}
	terminalFence, err := goalRevisionTerminalFenceTx(ctx, tx, workspaceID, agentSessionID, state.Revision)
	if err != nil {
		return err
	}
	if evidence, ok := goalControlAppliedEvidence(session.RuntimeContext); !terminalFence && ok &&
		state.PendingOperationID != "" &&
		asJSONMapString(evidence, "operationId") == state.PendingOperationID &&
		jsonMapInt64(evidence, "revision") == state.Revision &&
		goalStateConverged(state.Desired, observed, state.Tombstoned) {
		pending, pendingFound, err := getGoalControlOperationTx(ctx, tx, workspaceID, state.PendingOperationID)
		if err != nil {
			return err
		}
		if !pendingFound || (pending.RepairRequired && jsonMapInt64(evidence, "repairEpoch") != pending.RepairEpoch) {
			return nil
		}
		evidenceJSON := marshalJSONMapOrEmpty(evidence)
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_goal_control_operations
SET status = ?, provider_phase = ?, evidence_json = ?, lease_owner = NULL,
    lease_expires_at_unix_ms = NULL, next_attempt_at_unix_ms = NULL,
    repair_required = 0,
    updated_at_unix_ms = ?, completed_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND goal_revision = ? AND status = ?
`, GoalOperationStatusCompleted, GoalProviderPhaseApplied, evidenceJSON, occurredAt, occurredAt,
			workspaceID, state.PendingOperationID, state.Revision, GoalOperationStatusDispatched); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_goals
SET observed_json = ?, sync_status = ?, pending_operation_id = NULL,
    last_evidence_json = ?, last_error = '', observed_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND revision = ? AND pending_operation_id = ?
`, nullableJSONMap(observed), GoalSyncStatusSynced, evidenceJSON, occurredAt, occurredAt,
			workspaceID, agentSessionID, state.Revision, state.PendingOperationID); err != nil {
			return err
		}
		return nil
	}
	if state.ObservedAtUnixMS > occurredAt {
		return nil
	}
	var syncStatus string
	if state.PendingOperationID != "" {
		syncStatus = GoalSyncStatusApplying
	} else if goalStateConverged(state.Desired, observed, state.Tombstoned) {
		syncStatus = GoalSyncStatusSynced
	} else if state.Revision > 0 {
		syncStatus = GoalSyncStatusDiverged
	} else {
		syncStatus = GoalSyncStatusUnknown
	}
	syncStatus, lastError := terminalGoalSyncState(state, syncStatus, state.LastError, terminalFence)
	_, err = tx.ExecContext(ctx, `
UPDATE workspace_agent_session_goals
SET observed_json = ?, sync_status = ?, last_evidence_json = ?, last_error = ?,
    observed_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND revision = ?
  AND COALESCE(pending_operation_id, '') = ? AND COALESCE(observed_at_unix_ms, 0) = ?
`, nullableJSONMap(observed), syncStatus,
		`{"source":"runtime_session_report","confidence":"provider_observed"}`,
		lastError, occurredAt, occurredAt, workspaceID, agentSessionID, state.Revision,
		state.PendingOperationID, state.ObservedAtUnixMS)
	return err
}

func goalControlAppliedEvidence(runtimeContext map[string]any) (map[string]any, bool) {
	raw, ok := runtimeContext["goalControlEvidence"].(map[string]any)
	if !ok || strings.TrimSpace(asJSONMapString(raw, "phase")) != "applied" {
		return nil, false
	}
	if strings.TrimSpace(asJSONMapString(raw, "operationId")) == "" || jsonMapInt64(raw, "revision") <= 0 {
		return nil, false
	}
	return cloneJSONMap(raw), true
}

func jsonMapInt64(value map[string]any, key string) int64 {
	switch number := value[key].(type) {
	case int64:
		return number
	case int:
		return int64(number)
	case float64:
		return int64(number)
	case json.Number:
		result, _ := number.Int64()
		return result
	default:
		return 0
	}
}

func getSessionGoalState(ctx context.Context, q rowQueryer, workspaceID, agentSessionID string) (SessionGoalState, bool, error) {
	return scanSessionGoalState(q.QueryRowContext(ctx, sessionGoalStateSelectSQL+` WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID))
}

func getSessionGoalStateTx(ctx context.Context, tx *sql.Tx, workspaceID, agentSessionID string) (SessionGoalState, bool, error) {
	return getSessionGoalState(ctx, tx, workspaceID, agentSessionID)
}

func scanSessionGoalState(row *sql.Row) (SessionGoalState, bool, error) {
	var state SessionGoalState
	var desiredJSON, observedJSON sql.NullString
	var evidenceJSON string
	var tombstoned int
	if err := row.Scan(&state.WorkspaceID, &state.AgentSessionID, &desiredJSON, &observedJSON,
		&state.Revision, &tombstoned, &state.SyncStatus, &state.PendingOperationID,
		&evidenceJSON, &state.LastError, &state.ObservedAtUnixMS,
		&state.CreatedAtUnixMS, &state.UpdatedAtUnixMS); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SessionGoalState{}, false, nil
		}
		return SessionGoalState{}, false, err
	}
	state.Tombstoned = tombstoned != 0
	state.Desired = unmarshalNullableJSONMap(desiredJSON)
	state.Observed = unmarshalNullableJSONMap(observedJSON)
	state.LastEvidence, _ = unmarshalJSONMap(evidenceJSON)
	return state, true, nil
}

func getGoalControlOperation(ctx context.Context, q rowQueryer, workspaceID, operationID string) (GoalControlOperation, bool, error) {
	return scanGoalControlOperation(q.QueryRowContext(ctx, goalControlOperationSelectSQL+` WHERE workspace_id = ? AND operation_id = ?`, workspaceID, operationID))
}

func getGoalControlOperationTx(ctx context.Context, tx *sql.Tx, workspaceID, operationID string) (GoalControlOperation, bool, error) {
	return getGoalControlOperation(ctx, tx, workspaceID, operationID)
}

func scanGoalControlOperation(row *sql.Row) (GoalControlOperation, bool, error) {
	var op GoalControlOperation
	var evidenceJSON string
	var repairRequired int
	if err := row.Scan(&op.OperationID, &op.WorkspaceID, &op.AgentSessionID, &op.GoalRevision,
		&op.Action, &op.Objective, &op.Status, &evidenceJSON, &op.LastError,
		&op.CreatedAtUnixMS, &op.UpdatedAtUnixMS, &op.CompletedAtUnixMS, &op.ProviderPhase,
		&op.LeaseOwner, &op.LeaseExpiresAtMS, &op.NextAttemptAtMS, &op.Attempt,
		&repairRequired, &op.RepairEpoch, &op.AcceptedAtUnixMS, &op.AcceptedAttempt,
		&op.FirstDispatchedAtUnixMS, &op.DispatchedAttempt, &op.ClientSubmitID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return GoalControlOperation{}, false, nil
		}
		return GoalControlOperation{}, false, err
	}
	op.Evidence, _ = unmarshalJSONMap(evidenceJSON)
	op.RepairRequired = repairRequired != 0
	return op, true, nil
}
