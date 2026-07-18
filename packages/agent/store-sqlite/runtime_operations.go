package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

const runtimeOperationSelectSQL = `
SELECT operation_id, workspace_id, agent_session_id, kind, status, COALESCE(result, ''),
       turn_id, COALESCE(request_id, ''), payload_json, COALESCE(lease_owner, ''),
       COALESCE(lease_expires_at_unix_ms, 0), COALESCE(next_attempt_at_unix_ms, 0),
       attempt, version, last_error,
       created_at_unix_ms, updated_at_unix_ms, COALESCE(completed_at_unix_ms, 0)
FROM workspace_agent_runtime_operations
`

func (s *Store) PrepareRuntimeOperation(ctx context.Context, input RuntimeOperationPrepare) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.OperationID = strings.TrimSpace(input.OperationID)
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.TurnID = strings.TrimSpace(input.TurnID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	if err := validateRuntimeOperationPrepare(input); err != nil {
		return RuntimeOperation{}, false, err
	}
	payloadJSON, err := marshalJSONMap(input.Payload)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	now := input.OccurredAtMS
	if now <= 0 {
		return RuntimeOperation{}, false, errors.New("runtime operation occurred time is required")
	}
	subjectID := input.TurnID
	requestID := any(nil)
	switch input.Kind {
	case RuntimeOperationKindInteractiveResponse:
		subjectID = input.RequestID
		requestID = input.RequestID
	case RuntimeOperationKindPlanDecision:
		subjectID = input.TurnID
		requestID = input.RequestID
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("begin prepare runtime operation: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	existing, found, err := getRuntimeOperationBySubjectTx(ctx, tx, input.WorkspaceID, input.AgentSessionID, input.Kind, subjectID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	if found {
		if existing.TurnID != input.TurnID || existing.RequestID != input.RequestID || !jsonMapsEqual(existing.Payload, input.Payload) {
			return RuntimeOperation{}, false, ErrRuntimeOperationConflict
		}
		if _, err := s.commitTransaction(ctx, tx, input.WorkspaceID, nil); err != nil {
			return RuntimeOperation{}, false, fmt.Errorf("commit duplicate runtime operation prepare: %w", err)
		}
		committed = true
		return existing, false, nil
	}
	if byID, idFound, err := getRuntimeOperationTx(ctx, tx, input.WorkspaceID, input.OperationID); err != nil {
		return RuntimeOperation{}, false, err
	} else if idFound {
		_ = byID
		return RuntimeOperation{}, false, ErrRuntimeOperationConflict
	}
	if err := validateRuntimeOperationSubjectTx(ctx, tx, input); err != nil {
		return RuntimeOperation{}, false, err
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_agent_runtime_operations (
  operation_id, workspace_id, agent_session_id, kind, status, subject_id, turn_id,
  request_id, payload_json, next_attempt_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, input.OperationID, input.WorkspaceID, input.AgentSessionID, input.Kind,
		RuntimeOperationStatusPrepared, subjectID, input.TurnID, requestID, payloadJSON, now, now, now)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("insert runtime operation: %w", err)
	}
	op, _, err := getRuntimeOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	delta, err := s.commitTransaction(ctx, tx, input.WorkspaceID, []TransactionMutation{
		transactionMutation(input.WorkspaceID, input.AgentSessionID, MutationEntityRuntimeOperation, input.OperationID, "prepare", op.Version),
	})
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("commit runtime operation prepare: %w", err)
	}
	committed = true
	op.CommitTransactionID = delta.TransactionID
	op.CommitDelta = delta
	return op, true, nil
}

func (s *Store) GetRuntimeOperation(ctx context.Context, workspaceID string, operationID string) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	return getRuntimeOperation(ctx, s.db, strings.TrimSpace(workspaceID), strings.TrimSpace(operationID))
}

func (s *Store) ListClaimableRuntimeOperations(ctx context.Context, input ListClaimableRuntimeOperationsInput) ([]RuntimeOperation, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	limit := input.Limit
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	query := runtimeOperationSelectSQL + `
WHERE ((status = ? AND next_attempt_at_unix_ms <= ?)
    OR (status = ? AND lease_expires_at_unix_ms <= ?))`
	args := []any{RuntimeOperationStatusPrepared, input.NowUnixMS, RuntimeOperationStatusLeased, input.NowUnixMS}
	if workspaceID != "" {
		query += ` AND workspace_id = ?`
		args = append(args, workspaceID)
	}
	query += ` ORDER BY created_at_unix_ms ASC, operation_id ASC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list claimable runtime operations: %w", err)
	}
	defer rows.Close()
	result := make([]RuntimeOperation, 0)
	for rows.Next() {
		op, err := scanRuntimeOperation(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, op)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate claimable runtime operations: %w", err)
	}
	return result, nil
}

func (s *Store) ClaimRuntimeOperationLease(ctx context.Context, input ClaimRuntimeOperationLeaseInput) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.OperationID = strings.TrimSpace(input.OperationID)
	input.LeaseOwner = strings.TrimSpace(input.LeaseOwner)
	if input.WorkspaceID == "" || input.OperationID == "" || input.LeaseOwner == "" || input.NowUnixMS <= 0 || input.LeaseExpiresAtMS <= input.NowUnixMS {
		return RuntimeOperation{}, false, errors.New("valid workspace, operation, owner, now, and future lease expiry are required")
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET status = ?, lease_owner = ?, lease_expires_at_unix_ms = ?, attempt = attempt + 1,
    next_attempt_at_unix_ms = NULL, version = version + 1, last_error = '', updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ?
  AND ((status = ? AND next_attempt_at_unix_ms <= ?)
    OR (status = ? AND lease_expires_at_unix_ms <= ?))
`, RuntimeOperationStatusLeased, input.LeaseOwner, input.LeaseExpiresAtMS, input.NowUnixMS,
		input.WorkspaceID, input.OperationID, RuntimeOperationStatusPrepared, input.NowUnixMS,
		RuntimeOperationStatusLeased, input.NowUnixMS)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("claim runtime operation lease: %w", err)
	}
	claimed, err := rowsWereAffected(result, "claim runtime operation lease")
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	op, found, err := s.GetRuntimeOperation(ctx, input.WorkspaceID, input.OperationID)
	if err != nil || !found {
		return op, false, err
	}
	return op, claimed, nil
}

func (s *Store) ReleaseOrFailRuntimeOperation(ctx context.Context, input ReleaseOrFailRuntimeOperationInput) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	status, resultValue, nextAttemptValue := RuntimeOperationStatusPrepared, any(nil), any(input.NextAttemptAtMS)
	if input.Fail {
		status, resultValue, nextAttemptValue = RuntimeOperationStatusFailed, RuntimeOperationResultFailed, nil
	} else if input.NextAttemptAtMS <= input.NowUnixMS {
		return RuntimeOperation{}, false, errors.New("runtime operation retry time must be after release time")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET status = ?, result = ?, lease_owner = NULL, lease_expires_at_unix_ms = NULL,
    next_attempt_at_unix_ms = ?, version = version + 1, last_error = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND status = ? AND lease_owner = ?
`, status, resultValue, nextAttemptValue, strings.TrimSpace(input.LastError), input.NowUnixMS,
		strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.OperationID), RuntimeOperationStatusLeased, strings.TrimSpace(input.LeaseOwner))
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("release or fail runtime operation: %w", err)
	}
	changed, err := rowsWereAffected(result, "release or fail runtime operation")
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	op, found, err := getRuntimeOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil || !found {
		return op, false, err
	}
	mutations := []TransactionMutation{}
	if changed {
		operation := "release"
		if input.Fail {
			operation = "fail"
		}
		mutations = append(mutations, transactionMutation(
			op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeOperation,
			op.OperationID, operation, op.Version,
		))
	}
	delta, err := s.commitTransaction(ctx, tx, op.WorkspaceID, mutations)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	committed = true
	op.CommitTransactionID = delta.TransactionID
	op.CommitDelta = delta
	return op, changed, nil
}

func (s *Store) CheckpointRuntimeOperation(ctx context.Context, input CheckpointRuntimeOperationInput) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.OperationID = strings.TrimSpace(input.OperationID)
	input.LeaseOwner = strings.TrimSpace(input.LeaseOwner)
	if input.WorkspaceID == "" || input.OperationID == "" || input.LeaseOwner == "" || input.NowUnixMS <= 0 {
		return RuntimeOperation{}, false, errors.New("workspace, operation, owner, and checkpoint time are required")
	}
	if err := validatePlanDecisionOperationPayload(input.OperationID, input.Payload); err != nil {
		return RuntimeOperation{}, false, err
	}
	payloadJSON, err := marshalJSONMap(input.Payload)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("begin runtime operation checkpoint: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	current, found, err := getRuntimeOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	if !found || current.Kind != RuntimeOperationKindPlanDecision || current.Status != RuntimeOperationStatusLeased || current.LeaseOwner != input.LeaseOwner {
		return current, false, ErrRuntimeOperationLeaseLost
	}
	if !planDecisionCheckpointIdentityEqual(current.Payload, input.Payload) || !planDecisionStepCanAdvance(payloadString(current.Payload, "step"), payloadString(input.Payload, "step")) {
		return current, false, ErrRuntimeOperationSubjectState
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET payload_json = ?, version = version + 1, updated_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND status = ? AND lease_owner = ?
`, payloadJSON, input.NowUnixMS, input.WorkspaceID, input.OperationID,
		RuntimeOperationStatusLeased, input.LeaseOwner)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("checkpoint runtime operation: %w", err)
	}
	changed, err := rowsWereAffected(result, "checkpoint runtime operation")
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	var pendingEvent RuntimeOperationEvent
	if payloadString(current.Payload, "step") != "send_dispatched" && payloadString(input.Payload, "step") == "send_dispatched" {
		if err := insertPlanDecisionUnknownNoticeTx(ctx, tx, current, input.NowUnixMS); err != nil {
			return RuntimeOperation{}, false, err
		}
		pendingEvent, err = insertRuntimeOperationEventTx(ctx, tx, current, RuntimeOperationEventPlanDecisionPending, map[string]any{
			"turnId": current.TurnID, "requestId": current.RequestID,
			"noticeMessageId": planDecisionNoticeMessageID(current.OperationID),
		}, input.NowUnixMS)
		if err != nil {
			return RuntimeOperation{}, false, err
		}
	}
	op, found, err := getRuntimeOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil || !found {
		return op, false, err
	}
	mutations := []TransactionMutation{
		transactionMutation(input.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeOperation, input.OperationID, "checkpoint", op.Version),
	}
	if pendingEvent.ID > 0 {
		messageID := planDecisionNoticeMessageID(op.OperationID)
		message, found, err := getAgentMessageForUpdate(ctx, tx, input.WorkspaceID, op.AgentSessionID, messageID)
		if err != nil {
			return RuntimeOperation{}, false, err
		}
		if !found {
			return RuntimeOperation{}, false, ErrRuntimeOperationSubjectState
		}
		mutations = append(mutations,
			transactionMutation(input.WorkspaceID, op.AgentSessionID, MutationEntityMessage, messageID, "upsert", int64(message.Version)),
			transactionMutation(input.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeEvent, fmt.Sprint(pendingEvent.ID), "insert", pendingEvent.ID),
		)
	}
	delta, err := s.commitTransaction(ctx, tx, input.WorkspaceID, mutations)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("commit runtime operation checkpoint: %w", err)
	}
	committed = true
	op.CommitTransactionID = delta.TransactionID
	op.CommitDelta = delta
	return op, changed, nil
}

func insertPlanDecisionUnknownNoticeTx(ctx context.Context, tx *sql.Tx, operation RuntimeOperation, now int64) error {
	payloadJSON, err := marshalJSONMap(map[string]any{
		"kind":        "agent_system_notice",
		"noticeKind":  "plan_implementation_pending_confirmation",
		"severity":    "warning",
		"retryable":   false,
		"operationId": operation.OperationID,
		"planTurnId":  operation.TurnID,
	})
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
INSERT OR IGNORE INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, turn_id, role, kind,
  status, payload_json, occurred_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?,
  COALESCE((SELECT MAX(version) + 1 FROM workspace_agent_messages WHERE workspace_id = ? AND agent_session_id = ?), 1),
  ?, 'system', 'system', 'running', ?, ?, ?, ?)
`, operation.WorkspaceID, operation.AgentSessionID, planDecisionNoticeMessageID(operation.OperationID),
		operation.WorkspaceID, operation.AgentSessionID, operation.TurnID, payloadJSON, now, now, now)
	if err != nil {
		return fmt.Errorf("insert plan decision unknown notice: %w", err)
	}
	return nil
}

func planDecisionNoticeMessageID(operationID string) string {
	return "plan-decision:" + strings.TrimSpace(operationID) + ":status"
}

func planDecisionCheckpointIdentityEqual(current, next map[string]any) bool {
	for _, key := range []string{"promptKind", "action", "idempotencyKey", "clientSubmitId"} {
		if payloadString(current, key) != payloadString(next, key) {
			return false
		}
	}
	return true
}

func planDecisionStepCanAdvance(current, next string) bool {
	if current == next {
		return true
	}
	return (current == "prepared" && next == "settings_applied") ||
		(current == "settings_applied" && next == "send_dispatched") ||
		(current == "send_dispatched" && next == "send_confirmed")
}

func (s *Store) FindTurnByClientSubmitID(ctx context.Context, workspaceID string, agentSessionID string, clientSubmitID string) (string, bool, error) {
	if s == nil || s.db == nil {
		return "", false, errors.New("workspace database is not initialized")
	}
	var turnID string
	err := s.db.QueryRowContext(ctx, `
SELECT turn_id
FROM workspace_agent_messages
WHERE workspace_id = ? AND agent_session_id = ?
  AND turn_id IS NOT NULL AND length(turn_id) > 0
  AND json_extract(payload_json, '$.clientSubmitId') = ?
ORDER BY version DESC LIMIT 1
`, strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID), strings.TrimSpace(clientSubmitID)).Scan(&turnID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("find turn by client submit id: %w", err)
	}
	return strings.TrimSpace(turnID), true, nil
}

// RequeueLeasedRuntimeOperationsOnStartup invalidates every lease left by the
// previous daemon process. This is deliberately global: a new single daemon
// owner must recover even leases whose wall-clock expiry is still in the
// future instead of misclassifying their turns as generic stale work.
func (s *Store) RequeueLeasedRuntimeOperationsOnStartup(ctx context.Context, nowUnixMS int64) (int64, error) {
	if s == nil || s.db == nil {
		return 0, errors.New("workspace database is not initialized")
	}
	if nowUnixMS <= 0 {
		return 0, errors.New("startup recovery time is required")
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET status = ?, lease_owner = NULL, lease_expires_at_unix_ms = NULL,
    next_attempt_at_unix_ms = ?, version = version + 1,
    last_error = CASE
      WHEN TRIM(last_error) = '' THEN 'startup recovery: previous runtime lease invalidated'
      ELSE last_error || '; startup recovery: previous runtime lease invalidated'
    END,
    updated_at_unix_ms = ?
WHERE status = ?
`, RuntimeOperationStatusPrepared, nowUnixMS, nowUnixMS, RuntimeOperationStatusLeased)
	if err != nil {
		return 0, fmt.Errorf("requeue leased runtime operations on startup: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("requeue startup runtime operation rows affected: %w", err)
	}
	return count, nil
}

func validateRuntimeOperationPrepare(input RuntimeOperationPrepare) error {
	if input.OperationID == "" || input.WorkspaceID == "" || input.AgentSessionID == "" || input.TurnID == "" {
		return errors.New("operation, workspace, session, and turn ids are required")
	}
	switch input.Kind {
	case RuntimeOperationKindInteractiveResponse:
		if input.RequestID == "" {
			return errors.New("interactive runtime operation request id is required")
		}
	case RuntimeOperationKindCancelTurn:
		if input.RequestID != "" {
			return errors.New("cancel runtime operation must not have a request id")
		}
		if _, err := cancelTargetsFromPayload(input.AgentSessionID, input.TurnID, input.Payload); err != nil {
			return err
		}
	case RuntimeOperationKindPlanDecision:
		if input.RequestID == "" || input.RequestID != input.TurnID {
			return errors.New("plan decision request id must equal its plan turn id")
		}
		if err := validatePlanDecisionOperationPayload(input.OperationID, input.Payload); err != nil {
			return err
		}
		if payloadString(input.Payload, "step") != "prepared" {
			return errors.New("new plan decision operation must start prepared")
		}
	default:
		return fmt.Errorf("unknown runtime operation kind %q", input.Kind)
	}
	return nil
}

func cancelTargetsFromRuntimeOperation(operation RuntimeOperation) ([]runtimeCancelTarget, error) {
	return cancelTargetsFromPayload(operation.AgentSessionID, operation.TurnID, operation.Payload)
}

func cancelTargetsFromPayload(agentSessionID string, turnID string, payload map[string]any) ([]runtimeCancelTarget, error) {
	rootAgentSessionID := payloadString(payload, "rootAgentSessionId")
	if rootAgentSessionID == "" {
		return nil, errors.New("cancel runtime operation root agent session id is required")
	}
	rawTargets, ok := payload["targets"].([]any)
	if !ok || len(rawTargets) == 0 {
		return nil, errors.New("cancel runtime operation targets are required")
	}
	result := make([]runtimeCancelTarget, 0, len(rawTargets))
	seen := make(map[string]struct{}, len(rawTargets))
	subjectFound := false
	for _, raw := range rawTargets {
		value, ok := raw.(map[string]any)
		if !ok {
			return nil, errors.New("cancel runtime operation target must be an object")
		}
		target := runtimeCancelTarget{
			AgentSessionID: payloadString(value, "agentSessionId"),
			TurnID:         payloadString(value, "turnId"),
		}
		if target.AgentSessionID == "" || target.TurnID == "" {
			return nil, errors.New("cancel runtime operation target session and turn ids are required")
		}
		key := target.AgentSessionID + "\x00" + target.TurnID
		if _, exists := seen[key]; exists {
			return nil, errors.New("cancel runtime operation targets must be unique")
		}
		seen[key] = struct{}{}
		if target.AgentSessionID == agentSessionID && target.TurnID == turnID {
			subjectFound = true
		}
		result = append(result, target)
	}
	if !subjectFound {
		return nil, errors.New("cancel runtime operation targets must include the operation subject")
	}
	return result, nil
}

func validateRuntimeOperationSubjectTx(ctx context.Context, tx *sql.Tx, input RuntimeOperationPrepare) error {
	turn, found, err := getAgentTurnTx(ctx, tx, input.WorkspaceID, input.AgentSessionID, input.TurnID)
	if err != nil {
		return err
	}
	if !found {
		return ErrRuntimeOperationSubjectState
	}
	if input.Kind == RuntimeOperationKindCancelTurn {
		targets, err := cancelTargetsFromPayload(input.AgentSessionID, input.TurnID, input.Payload)
		if err != nil {
			return err
		}
		rootAgentSessionID := payloadString(input.Payload, "rootAgentSessionId")
		for _, target := range targets {
			targetTurn, targetFound, err := getAgentTurnTx(ctx, tx, input.WorkspaceID, target.AgentSessionID, target.TurnID)
			if err != nil {
				return err
			}
			if !targetFound {
				return ErrRuntimeOperationSubjectState
			}
			var kind string
			var recordedRoot sql.NullString
			if err := tx.QueryRowContext(ctx, `
SELECT session_kind, root_agent_session_id
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, input.WorkspaceID, target.AgentSessionID).Scan(&kind, &recordedRoot); err != nil {
				return fmt.Errorf("read cancel target session relation: %w", err)
			}
			if (kind == SessionKindRoot && target.AgentSessionID != rootAgentSessionID) ||
				(kind == SessionKindChild && strings.TrimSpace(recordedRoot.String) != rootAgentSessionID) ||
				(kind != SessionKindRoot && kind != SessionKindChild) {
				return ErrRuntimeOperationSubjectState
			}
			if targetTurn.Phase == TurnPhaseSettled {
				continue
			}
			var active sql.NullString
			if err := tx.QueryRowContext(ctx, `SELECT active_turn_id FROM workspace_agent_sessions WHERE workspace_id = ? AND agent_session_id = ?`, input.WorkspaceID, target.AgentSessionID).Scan(&active); err != nil {
				return fmt.Errorf("read runtime operation target: %w", err)
			}
			if !active.Valid || active.String != target.TurnID {
				return ErrRuntimeOperationSubjectState
			}
		}
		return nil
	}
	if input.Kind == RuntimeOperationKindPlanDecision && payloadString(input.Payload, "promptKind") == "plan-implementation" {
		if turn.Phase != TurnPhaseSettled || turn.Outcome != TurnOutcomeCompleted {
			return ErrRuntimeOperationSubjectState
		}
		var hasPlan int
		err := tx.QueryRowContext(ctx, `
SELECT EXISTS(
  SELECT 1 FROM workspace_agent_messages
  WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
    AND deleted_at_unix_ms = 0
    AND (kind = 'plan' OR json_extract(payload_json, '$.messageKind') = 'plan')
)
`, input.WorkspaceID, input.AgentSessionID, input.TurnID).Scan(&hasPlan)
		if err != nil {
			return fmt.Errorf("validate plan decision evidence: %w", err)
		}
		if hasPlan != 1 {
			return ErrRuntimeOperationSubjectState
		}
		return nil
	}
	interaction, found, err := getAgentInteractionTx(ctx, tx, input.WorkspaceID, input.AgentSessionID, input.TurnID, input.RequestID)
	if err != nil {
		return err
	}
	if !found || interaction.TurnID != input.TurnID {
		return ErrRuntimeOperationSubjectState
	}
	return nil
}

func payloadString(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return strings.TrimSpace(value)
}

func validatePlanDecisionOperationPayload(operationID string, payload map[string]any) error {
	if payloadString(payload, "promptKind") != "plan-implementation" || payloadString(payload, "action") != "implement" {
		return errors.New("plan decision prompt kind and action are invalid")
	}
	if payloadString(payload, "idempotencyKey") == "" || payloadString(payload, "clientSubmitId") != "plan-decision:"+strings.TrimSpace(operationID) {
		return errors.New("plan decision identity payload is invalid")
	}
	switch payloadString(payload, "step") {
	case "prepared", "settings_applied", "send_dispatched":
		if payloadString(payload, "confirmedTurnId") != "" {
			return errors.New("unconfirmed plan decision must not carry a confirmed turn")
		}
	case "send_confirmed":
		if payloadString(payload, "confirmedTurnId") == "" {
			return errors.New("confirmed plan decision turn is required")
		}
	default:
		return errors.New("plan decision step is invalid")
	}
	return nil
}

func getRuntimeOperation(ctx context.Context, q rowQueryer, workspaceID string, operationID string) (RuntimeOperation, bool, error) {
	return scanRuntimeOperationRow(q.QueryRowContext(ctx, runtimeOperationSelectSQL+` WHERE workspace_id = ? AND operation_id = ?`, workspaceID, operationID))
}

type rowQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func getRuntimeOperationTx(ctx context.Context, tx *sql.Tx, workspaceID string, operationID string) (RuntimeOperation, bool, error) {
	return getRuntimeOperation(ctx, tx, workspaceID, operationID)
}

func getRuntimeOperationBySubjectTx(ctx context.Context, tx *sql.Tx, workspaceID string, sessionID string, kind string, subjectID string) (RuntimeOperation, bool, error) {
	return scanRuntimeOperationRow(tx.QueryRowContext(ctx, runtimeOperationSelectSQL+` WHERE workspace_id = ? AND agent_session_id = ? AND kind = ? AND subject_id = ?`, workspaceID, sessionID, kind, subjectID))
}

func scanRuntimeOperationRow(row *sql.Row) (RuntimeOperation, bool, error) {
	op, err := scanRuntimeOperation(row)
	if errors.Is(err, sql.ErrNoRows) {
		return RuntimeOperation{}, false, nil
	}
	return op, err == nil, err
}

func scanRuntimeOperation(scanner rowScanner) (RuntimeOperation, error) {
	var op RuntimeOperation
	var payloadJSON string
	err := scanner.Scan(&op.OperationID, &op.WorkspaceID, &op.AgentSessionID, &op.Kind, &op.Status, &op.Result,
		&op.TurnID, &op.RequestID, &payloadJSON, &op.LeaseOwner, &op.LeaseExpiresAtMS, &op.NextAttemptAtMS, &op.Attempt,
		&op.Version, &op.LastError, &op.CreatedAtUnixMS, &op.UpdatedAtUnixMS, &op.CompletedAtUnixMS)
	if err != nil {
		return RuntimeOperation{}, err
	}
	op.Payload, err = unmarshalJSONMap(payloadJSON)
	if err != nil {
		return RuntimeOperation{}, fmt.Errorf("decode runtime operation payload: %w", err)
	}
	return op, nil
}

func jsonMapsEqual(left map[string]any, right map[string]any) bool {
	leftJSON, leftErr := marshalJSONMap(left)
	rightJSON, rightErr := marshalJSONMap(right)
	return leftErr == nil && rightErr == nil && leftJSON == rightJSON
}
