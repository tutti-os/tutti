package storesqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const maxGoalRepairIncidentGenerations = 8

func (s *Store) GetGoalControlOperation(ctx context.Context, workspaceID, operationID string) (GoalControlOperation, bool, error) {
	if s == nil || s.db == nil {
		return GoalControlOperation{}, false, errors.New("workspace database is not initialized")
	}
	return getGoalControlOperation(ctx, s.db, strings.TrimSpace(workspaceID), strings.TrimSpace(operationID))
}

func (s *Store) ListClaimableGoalControlOperations(ctx context.Context, input ListClaimableGoalControlOperationsInput) ([]GoalControlOperation, error) {
	limit := input.Limit
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, goalControlOperationSelectSQL+`
WHERE status IN (?, ?) AND (
  (lease_owner IS NULL AND next_attempt_at_unix_ms IS NOT NULL AND next_attempt_at_unix_ms <= ?)
  OR (lease_owner IS NOT NULL AND lease_expires_at_unix_ms <= ?)
)
ORDER BY created_at_unix_ms, operation_id LIMIT ?`, GoalOperationStatusPrepared,
		GoalOperationStatusDispatched, input.NowUnixMS, input.NowUnixMS, limit)
	if err != nil {
		return nil, fmt.Errorf("list claimable goal operations: %w", err)
	}
	defer rows.Close()
	result := make([]GoalControlOperation, 0)
	for rows.Next() {
		var op GoalControlOperation
		var evidenceJSON string
		var repairRequired int
		if err := rows.Scan(&op.OperationID, &op.WorkspaceID, &op.AgentSessionID, &op.GoalRevision,
			&op.Action, &op.Objective, &op.Status, &evidenceJSON, &op.LastError,
			&op.CreatedAtUnixMS, &op.UpdatedAtUnixMS, &op.CompletedAtUnixMS, &op.ProviderPhase,
			&op.LeaseOwner, &op.LeaseExpiresAtMS, &op.NextAttemptAtMS, &op.Attempt,
			&repairRequired, &op.RepairEpoch, &op.AcceptedAtUnixMS, &op.AcceptedAttempt,
			&op.FirstDispatchedAtUnixMS, &op.DispatchedAttempt, &op.ClientSubmitID); err != nil {
			return nil, err
		}
		op.RepairRequired = repairRequired != 0
		op.Evidence, _ = unmarshalJSONMap(evidenceJSON)
		result = append(result, op)
	}
	return result, rows.Err()
}

func (s *Store) ClaimGoalControlOperation(ctx context.Context, input ClaimGoalControlOperationInput) (GoalControlOperation, bool, error) {
	if strings.TrimSpace(input.WorkspaceID) == "" || strings.TrimSpace(input.OperationID) == "" ||
		strings.TrimSpace(input.LeaseOwner) == "" || input.NowUnixMS <= 0 || input.LeaseExpiresAtMS <= input.NowUnixMS {
		return GoalControlOperation{}, false, errors.New("valid goal operation lease input is required")
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE workspace_agent_goal_control_operations
SET lease_owner = ?, lease_expires_at_unix_ms = ?, attempt = attempt + 1,
    next_attempt_at_unix_ms = NULL, last_error = '', updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND status IN (?, ?)
  AND ((lease_owner IS NULL AND next_attempt_at_unix_ms IS NOT NULL AND next_attempt_at_unix_ms <= ?)
    OR (lease_owner IS NOT NULL AND lease_expires_at_unix_ms <= ?))`, strings.TrimSpace(input.LeaseOwner),
		input.LeaseExpiresAtMS, input.NowUnixMS, strings.TrimSpace(input.WorkspaceID),
		strings.TrimSpace(input.OperationID), GoalOperationStatusPrepared, GoalOperationStatusDispatched,
		input.NowUnixMS, input.NowUnixMS)
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	changed, err := rowsWereAffected(result, "claim goal control operation")
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	op, found, err := s.GetGoalControlOperation(ctx, input.WorkspaceID, input.OperationID)
	return op, changed && found, err
}

func (s *Store) ReleaseGoalControlOperation(ctx context.Context, input ReleaseGoalControlOperationInput) (GoalControlOperation, bool, error) {
	next := any(input.NextAttemptAtMS)
	completed := any(nil)
	if input.Fail {
		next, completed = nil, input.NowUnixMS
	} else if input.NextAttemptAtMS <= input.NowUnixMS {
		return GoalControlOperation{}, false, errors.New("goal operation retry time must be in the future")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_goal_control_operations
SET status = CASE WHEN ? THEN ? ELSE status END,
    provider_phase = ?, evidence_json = ?, last_error = ?,
    lease_owner = NULL, lease_expires_at_unix_ms = NULL, next_attempt_at_unix_ms = ?,
    updated_at_unix_ms = ?, completed_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND lease_owner = ? AND repair_epoch = ? AND status IN (?, ?)`,
		input.Fail, GoalOperationStatusFailed, normalizeGoalProviderPhase(input.ProviderPhase), marshalJSONMapOrEmpty(input.Evidence),
		strings.TrimSpace(input.LastError), next, input.NowUnixMS, completed,
		strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.OperationID), strings.TrimSpace(input.LeaseOwner), input.RepairEpoch,
		GoalOperationStatusPrepared, GoalOperationStatusDispatched)
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	changed, err := rowsWereAffected(result, "release goal control operation")
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	if input.Fail && changed {
		_, err = tx.ExecContext(ctx, `UPDATE workspace_agent_session_goals
SET sync_status = ?, pending_operation_id = NULL, last_error = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND pending_operation_id = ?`, GoalSyncStatusFailed, strings.TrimSpace(input.LastError),
			input.NowUnixMS, strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.OperationID))
		if err != nil {
			return GoalControlOperation{}, false, err
		}
	}
	op, _, getErr := getGoalControlOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if getErr != nil {
		return GoalControlOperation{}, false, getErr
	}
	mutations := []TransactionMutation{}
	if changed {
		mutations = append(mutations, transactionMutation(input.WorkspaceID, op.AgentSessionID, MutationEntityGoalOperation, op.OperationID, "release", op.UpdatedAtUnixMS))
		if input.Fail {
			mutations = append(mutations, transactionMutation(input.WorkspaceID, op.AgentSessionID, MutationEntityGoalState, op.AgentSessionID, "upsert", op.GoalRevision))
		}
	}
	delta, err := s.commitTransaction(ctx, tx, input.WorkspaceID, mutations)
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	op.CommitTransactionID = delta.TransactionID
	op.CommitDelta = delta
	return op, changed, nil
}

func (s *Store) RecordGoalControlOperationEvidence(ctx context.Context, input GoalControlOperationEvidence) (GoalControlOperation, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `UPDATE workspace_agent_goal_control_operations
SET provider_phase = ?, evidence_json = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ?`, normalizeGoalProviderPhase(input.ProviderPhase),
		marshalJSONMapOrEmpty(input.Evidence), input.OccurredAtUnixMS,
		strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.OperationID))
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	changed, err := rowsWereAffected(result, "record goal operation evidence")
	op, _, getErr := getGoalControlOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err = errors.Join(err, getErr); err != nil {
		return op, false, err
	}
	mutations := []TransactionMutation{}
	if changed {
		mutations = append(mutations, transactionMutation(input.WorkspaceID, op.AgentSessionID, MutationEntityGoalOperation, op.OperationID, "evidence", op.UpdatedAtUnixMS))
	}
	delta, err := s.commitTransaction(ctx, tx, input.WorkspaceID, mutations)
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	op.CommitTransactionID = delta.TransactionID
	op.CommitDelta = delta
	return op, changed, nil
}

// WakeGoalControlOperation durably records that a stale provider result may
// have undone the current pending revision. The existing operation is the
// deterministic repair identity. Incrementing repair_epoch fences the provider
// result that was already in flight when the stale mutation was observed.
func (s *Store) WakeGoalControlOperation(ctx context.Context, input WakeGoalControlOperationInput) (GoalControlOperation, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	// Query through the operation first because the session id is part of the
	// durable operation identity and callers should not need to repeat it.
	op, found, err := getGoalControlOperationTx(ctx, tx, strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.OperationID))
	if err != nil || !found {
		return GoalControlOperation{}, false, err
	}
	state, found, err := getSessionGoalStateTx(ctx, tx, op.WorkspaceID, op.AgentSessionID)
	if err != nil || !found {
		return GoalControlOperation{}, false, err
	}
	if state.Revision != input.GoalRevision || state.PendingOperationID != op.OperationID ||
		op.GoalRevision != input.GoalRevision || (op.Status != GoalOperationStatusPrepared && op.Status != GoalOperationStatusDispatched) {
		if err := s.commitGoalOperationMutation(ctx, tx, op.WorkspaceID, "", nil, nil, false, false); err != nil {
			return GoalControlOperation{}, false, err
		}
		return op, false, nil
	}
	evidence := cloneJSONMap(op.Evidence)
	if evidence == nil {
		evidence = map[string]any{}
	}
	repairID := deterministicGoalRepairOperationID(input.SourceOperationID, input.GoalRevision)
	if existingRepair, ok := evidence["repair"].(map[string]any); ok && op.RepairRequired &&
		strings.TrimSpace(asJSONMapString(existingRepair, "repairId")) == repairID {
		result, updateErr := tx.ExecContext(ctx, `UPDATE workspace_agent_goal_control_operations
SET next_attempt_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND goal_revision = ? AND status IN (?, ?)`,
			input.OccurredAtUnixMS, input.OccurredAtUnixMS, op.WorkspaceID, op.OperationID,
			op.GoalRevision, GoalOperationStatusPrepared, GoalOperationStatusDispatched)
		if updateErr != nil {
			return GoalControlOperation{}, false, updateErr
		}
		changed, updateErr := rowsWereAffected(result, "wake existing goal repair operation")
		if updateErr != nil {
			return GoalControlOperation{}, false, updateErr
		}
		op, _, updateErr = getGoalControlOperationTx(ctx, tx, op.WorkspaceID, op.OperationID)
		if updateErr != nil {
			return GoalControlOperation{}, false, updateErr
		}
		if updateErr = s.commitGoalOperationMutation(ctx, tx, op.WorkspaceID, "wake", &op, nil, changed, false); updateErr != nil {
			return GoalControlOperation{}, false, updateErr
		}
		return op, changed, nil
	}
	evidence["repair"] = map[string]any{
		"repairId":          repairID,
		"goalRevision":      input.GoalRevision,
		"sourceRevision":    input.SourceRevision,
		"sourceOperationId": strings.TrimSpace(input.SourceOperationID),
		"required":          true,
	}
	result, err := tx.ExecContext(ctx, `UPDATE workspace_agent_goal_control_operations
SET status = ?, provider_phase = ?, evidence_json = ?, repair_required = 1,
    repair_epoch = repair_epoch + 1, lease_owner = NULL, lease_expires_at_unix_ms = NULL,
    next_attempt_at_unix_ms = ?, updated_at_unix_ms = ?, attempt=0,
    first_dispatched_at_unix_ms=NULL, dispatched_attempt=0,
    accepted_at_unix_ms=NULL, accepted_attempt=0
WHERE workspace_id = ? AND operation_id = ? AND goal_revision = ? AND status IN (?, ?)`,
		GoalOperationStatusPrepared, GoalProviderPhasePrepared, marshalJSONMapOrEmpty(evidence), input.OccurredAtUnixMS, input.OccurredAtUnixMS,
		op.WorkspaceID, op.OperationID, op.GoalRevision, GoalOperationStatusPrepared, GoalOperationStatusDispatched)
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	changed, err := rowsWereAffected(result, "wake goal control operation")
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	op, _, err = getGoalControlOperationTx(ctx, tx, op.WorkspaceID, op.OperationID)
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	if err := s.commitGoalOperationMutation(ctx, tx, op.WorkspaceID, "wake", &op, nil, changed, false); err != nil {
		return GoalControlOperation{}, false, err
	}
	return op, changed, nil
}

// EnsureGoalRepairOperation creates the durable compensation for a current
// revision whose original operation already completed. Its identity is keyed
// by the stale source operation and current revision, making repeated delivery
// of the same stale callback idempotent without suppressing a later incident.
func (s *Store) EnsureGoalRepairOperation(ctx context.Context, input EnsureGoalRepairOperationInput) (GoalControlOperation, bool, error) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.SourceOperationID = strings.TrimSpace(input.SourceOperationID)
	if input.WorkspaceID == "" || input.AgentSessionID == "" || input.SourceOperationID == "" ||
		input.CurrentRevision <= 0 || input.OccurredAtUnixMS <= 0 {
		return GoalControlOperation{}, false, errors.New("valid goal repair identity and revision are required")
	}
	repairID := deterministicGoalRepairOperationID(input.SourceOperationID, input.CurrentRevision)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if existing, found, getErr := getGoalControlOperationTx(ctx, tx, input.WorkspaceID, repairID); getErr != nil {
		return GoalControlOperation{}, false, getErr
	} else if found {
		if err := s.commitGoalOperationMutation(ctx, tx, input.WorkspaceID, "", nil, nil, false, false); err != nil {
			return GoalControlOperation{}, false, err
		}
		return existing, false, nil
	}
	state, found, err := getSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID)
	if err != nil || !found {
		return GoalControlOperation{}, false, err
	}
	if state.Revision != input.CurrentRevision || state.PendingOperationID != "" {
		if err := s.commitGoalOperationMutation(ctx, tx, input.WorkspaceID, "", nil, nil, false, false); err != nil {
			return GoalControlOperation{}, false, err
		}
		return GoalControlOperation{}, false, nil
	}
	action, objective := repairActionForGoalState(state)
	evidence := map[string]any{"repair": map[string]any{
		"repairId": repairID, "goalRevision": state.Revision,
		"sourceRevision": input.SourceRevision, "sourceOperationId": input.SourceOperationID,
		"required": true,
	}}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_goal_control_operations (
  operation_id, workspace_id, agent_session_id, goal_revision, action, objective,
  status, evidence_json, provider_phase, next_attempt_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms, repair_required, repair_epoch
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`, repairID, input.WorkspaceID,
		input.AgentSessionID, state.Revision, action, objective, GoalOperationStatusPrepared,
		marshalJSONMapOrEmpty(evidence), GoalProviderPhasePrepared, input.OccurredAtUnixMS,
		input.OccurredAtUnixMS, input.OccurredAtUnixMS); err != nil {
		return GoalControlOperation{}, false, fmt.Errorf("insert goal repair operation: %w", err)
	}
	result, err := tx.ExecContext(ctx, `UPDATE workspace_agent_session_goals
SET pending_operation_id = ?, sync_status = ?, last_error = '', updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND revision = ? AND pending_operation_id IS NULL`,
		repairID, GoalSyncStatusPending, input.OccurredAtUnixMS, input.WorkspaceID,
		input.AgentSessionID, input.CurrentRevision)
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	changed, err := rowsWereAffected(result, "attach goal repair operation")
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	if !changed {
		return GoalControlOperation{}, false, errors.New("goal repair state changed concurrently")
	}
	op, _, err := getGoalControlOperationTx(ctx, tx, input.WorkspaceID, repairID)
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	state, _, err = getSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return GoalControlOperation{}, false, err
	}
	if err := s.commitGoalOperationMutation(ctx, tx, input.WorkspaceID, "prepare", &op, &state, true, true); err != nil {
		return GoalControlOperation{}, false, err
	}
	return op, true, nil
}

// EnsureOrWakeGoalRepairOperation attaches compensation to exactly the
// expected current revision in one transaction, closing the snapshot-to-attach
// race with bottom-up lifecycle completion.
func (s *Store) EnsureOrWakeGoalRepairOperation(ctx context.Context, input EnsureGoalRepairOperationInput) (GoalControlOperation, SessionGoalState, bool, error) {
	input.WorkspaceID, input.AgentSessionID, input.SourceOperationID = strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.AgentSessionID), strings.TrimSpace(input.SourceOperationID)
	if input.WorkspaceID == "" || input.AgentSessionID == "" || input.SourceOperationID == "" || input.CurrentRevision <= 0 || input.OccurredAtUnixMS <= 0 {
		return GoalControlOperation{}, SessionGoalState{}, false, errors.New("valid goal repair identity and expected revision are required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	state, found, err := getSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	if !found {
		return GoalControlOperation{}, SessionGoalState{}, false, ErrGoalReconcileConflict
	}
	if state.Revision != input.CurrentRevision {
		return GoalControlOperation{}, state, false, ErrGoalReconcileConflict
	}
	repairID := deterministicGoalRepairOperationID(input.SourceOperationID, state.Revision)
	var generationCount, terminal int
	var lastSourceID string
	err = tx.QueryRowContext(ctx, `SELECT generation_count,terminal,last_source_id FROM workspace_agent_goal_repair_incidents
WHERE workspace_id=? AND agent_session_id=? AND goal_revision=?`, state.WorkspaceID, state.AgentSessionID, state.Revision).
		Scan(&generationCount, &terminal, &lastSourceID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return GoalControlOperation{}, state, false, err
	}
	if terminal != 0 {
		if err = s.commitGoalOperationMutation(ctx, tx, state.WorkspaceID, "", nil, nil, false, false); err != nil {
			return GoalControlOperation{}, state, false, err
		}
		return GoalControlOperation{}, state, false, nil
	}
	if lastSourceID != input.SourceOperationID {
		generationCount++
		if generationCount > maxGoalRepairIncidentGenerations {
			if err = setGoalRevisionTerminalFenceTx(ctx, tx, state, generationCount, input.SourceOperationID, goalRepairBudgetExhaustedError, input.OccurredAtUnixMS); err != nil {
				return GoalControlOperation{}, state, false, err
			}
			state, _, err = getSessionGoalStateTx(ctx, tx, state.WorkspaceID, state.AgentSessionID)
			if err == nil {
				err = s.commitGoalOperationMutation(ctx, tx, state.WorkspaceID, "terminal", nil, &state, false, true)
			}
			return GoalControlOperation{}, state, false, err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO workspace_agent_goal_repair_incidents
(workspace_id,agent_session_id,goal_revision,generation_count,terminal,last_source_id,updated_at_unix_ms)
VALUES(?,?,?,?,0,?,?) ON CONFLICT(workspace_id,agent_session_id,goal_revision) DO UPDATE SET
generation_count=excluded.generation_count,last_source_id=excluded.last_source_id,updated_at_unix_ms=excluded.updated_at_unix_ms`,
			state.WorkspaceID, state.AgentSessionID, state.Revision, generationCount, input.SourceOperationID, input.OccurredAtUnixMS); err != nil {
			return GoalControlOperation{}, state, false, err
		}
	}
	if state.PendingOperationID != "" {
		op, opFound, opErr := getGoalControlOperationTx(ctx, tx, state.WorkspaceID, state.PendingOperationID)
		if opErr != nil || !opFound {
			return GoalControlOperation{}, state, false, opErr
		}
		if op.GoalRevision != state.Revision || (op.Status != GoalOperationStatusPrepared && op.Status != GoalOperationStatusDispatched) {
			return GoalControlOperation{}, state, false, ErrGoalReconcileConflict
		}
		evidence := cloneJSONMap(op.Evidence)
		if evidence == nil {
			evidence = map[string]any{}
		}
		for key, value := range input.Evidence {
			evidence[key] = value
		}
		if existing, ok := evidence["repair"].(map[string]any); ok && op.RepairRequired && asJSONMapString(existing, "repairId") == repairID {
			if _, err = tx.ExecContext(ctx, `UPDATE workspace_agent_goal_control_operations SET next_attempt_at_unix_ms=?,updated_at_unix_ms=? WHERE workspace_id=? AND operation_id=? AND status IN (?,?)`, input.OccurredAtUnixMS, input.OccurredAtUnixMS, state.WorkspaceID, op.OperationID, GoalOperationStatusPrepared, GoalOperationStatusDispatched); err != nil {
				return GoalControlOperation{}, state, false, err
			}
			op, _, err = getGoalControlOperationTx(ctx, tx, state.WorkspaceID, op.OperationID)
			if err != nil {
				return GoalControlOperation{}, state, false, err
			}
			if err = s.commitGoalOperationMutation(ctx, tx, state.WorkspaceID, "wake", &op, nil, true, false); err != nil {
				return GoalControlOperation{}, state, false, err
			}
			return op, state, false, nil
		}
		evidence["repair"] = map[string]any{"repairId": repairID, "goalRevision": state.Revision, "sourceRevision": input.SourceRevision, "sourceOperationId": input.SourceOperationID, "required": true}
		if _, err = tx.ExecContext(ctx, `UPDATE workspace_agent_goal_control_operations
SET status=?, provider_phase=?, evidence_json=?, repair_required=1, repair_epoch=repair_epoch+1,
 lease_owner=NULL, lease_expires_at_unix_ms=NULL, next_attempt_at_unix_ms=?, updated_at_unix_ms=?, attempt=0,
 first_dispatched_at_unix_ms=NULL, dispatched_attempt=0, accepted_at_unix_ms=NULL, accepted_attempt=0
WHERE workspace_id=? AND operation_id=? AND goal_revision=? AND status IN (?,?)`,
			GoalOperationStatusPrepared, GoalProviderPhasePrepared, marshalJSONMapOrEmpty(evidence), input.OccurredAtUnixMS, input.OccurredAtUnixMS,
			state.WorkspaceID, op.OperationID, state.Revision, GoalOperationStatusPrepared, GoalOperationStatusDispatched); err != nil {
			return GoalControlOperation{}, state, false, err
		}
		op, _, err = getGoalControlOperationTx(ctx, tx, state.WorkspaceID, op.OperationID)
		if err == nil {
			state, _, err = getSessionGoalStateTx(ctx, tx, state.WorkspaceID, state.AgentSessionID)
		}
		if err == nil {
			err = s.commitGoalOperationMutation(ctx, tx, state.WorkspaceID, "wake", &op, nil, true, false)
		}
		return op, state, err == nil, err
	}
	if existing, exists, getErr := getGoalControlOperationTx(ctx, tx, state.WorkspaceID, repairID); getErr != nil {
		return GoalControlOperation{}, state, false, getErr
	} else if exists {
		if err = s.commitGoalOperationMutation(ctx, tx, state.WorkspaceID, "", nil, nil, false, false); err != nil {
			return GoalControlOperation{}, state, false, err
		}
		return existing, state, false, nil
	}
	action, objective := repairActionForGoalState(state)
	evidence := cloneJSONMap(input.Evidence)
	if evidence == nil {
		evidence = map[string]any{}
	}
	evidence["repair"] = map[string]any{"repairId": repairID, "goalRevision": state.Revision, "sourceRevision": input.SourceRevision, "sourceOperationId": input.SourceOperationID, "required": true}
	if _, err = tx.ExecContext(ctx, `INSERT INTO workspace_agent_goal_control_operations
(operation_id,workspace_id,agent_session_id,goal_revision,action,objective,status,evidence_json,provider_phase,next_attempt_at_unix_ms,created_at_unix_ms,updated_at_unix_ms,repair_required,repair_epoch)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1)`, repairID, state.WorkspaceID, state.AgentSessionID, state.Revision, action, objective, GoalOperationStatusPrepared, marshalJSONMapOrEmpty(evidence), GoalProviderPhasePrepared, input.OccurredAtUnixMS, input.OccurredAtUnixMS, input.OccurredAtUnixMS); err != nil {
		return GoalControlOperation{}, state, false, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE workspace_agent_session_goals SET pending_operation_id=?,sync_status=?,last_error='',updated_at_unix_ms=? WHERE workspace_id=? AND agent_session_id=? AND revision=? AND pending_operation_id IS NULL`, repairID, GoalSyncStatusPending, input.OccurredAtUnixMS, state.WorkspaceID, state.AgentSessionID, state.Revision)
	if err != nil {
		return GoalControlOperation{}, state, false, err
	}
	changed, err := rowsWereAffected(result, "attach goal repair operation")
	if err != nil || !changed {
		return GoalControlOperation{}, state, false, ErrGoalReconcileConflict
	}
	op, _, err := getGoalControlOperationTx(ctx, tx, state.WorkspaceID, repairID)
	if err == nil {
		state, _, err = getSessionGoalStateTx(ctx, tx, state.WorkspaceID, state.AgentSessionID)
	}
	if err == nil {
		err = s.commitGoalOperationMutation(ctx, tx, state.WorkspaceID, "prepare", &op, &state, true, true)
	}
	return op, state, changed, err
}

func (s *Store) commitGoalOperationMutation(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	stage string,
	op *GoalControlOperation,
	state *SessionGoalState,
	operationChanged bool,
	stateChanged bool,
) error {
	mutations := make([]TransactionMutation, 0, 2)
	if operationChanged && op != nil {
		mutations = append(mutations, transactionMutation(
			workspaceID, op.AgentSessionID, MutationEntityGoalOperation,
			op.OperationID, stage, op.UpdatedAtUnixMS,
		))
	}
	if stateChanged && state != nil {
		mutations = append(mutations, transactionMutation(
			workspaceID, state.AgentSessionID, MutationEntityGoalState,
			state.AgentSessionID, "upsert", state.Revision,
		))
	}
	delta, err := s.commitTransaction(ctx, tx, workspaceID, mutations)
	if err != nil {
		return err
	}
	if op != nil {
		op.CommitTransactionID = delta.TransactionID
		op.CommitDelta = delta
	}
	if state != nil {
		state.CommitTransactionID = delta.TransactionID
		state.CommitDelta = delta
	}
	return nil
}

func deterministicGoalRepairOperationID(sourceOperationID string, currentRevision int64) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(sourceOperationID) + ":" + fmt.Sprint(currentRevision)))
	return "goal-repair-" + hex.EncodeToString(sum[:16])
}

func repairActionForGoalState(state SessionGoalState) (string, string) {
	if state.Tombstoned || len(state.Desired) == 0 {
		return "clear", ""
	}
	objective := strings.TrimSpace(asJSONMapString(state.Desired, "objective"))
	if strings.TrimSpace(asJSONMapString(state.Desired, "status")) == "paused" {
		return "pause", objective
	}
	return "set", objective
}

func (s *Store) RequeueLeasedGoalControlOperationsOnStartup(ctx context.Context, now int64) (int64, error) {
	result, err := s.db.ExecContext(ctx, `UPDATE workspace_agent_goal_control_operations
SET lease_owner = NULL, lease_expires_at_unix_ms = NULL, next_attempt_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE status IN (?, ?) AND lease_owner IS NOT NULL`, now, now, GoalOperationStatusPrepared, GoalOperationStatusDispatched)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func normalizeGoalProviderPhase(phase string) string {
	switch strings.TrimSpace(phase) {
	case GoalProviderPhasePrepared, GoalProviderPhaseDispatched, GoalProviderPhaseAccepted, GoalProviderPhaseApplied:
		return strings.TrimSpace(phase)
	default:
		return GoalProviderPhaseUnknown
	}
}
