package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

func (s *Store) CompleteInteractiveRuntimeOperation(ctx context.Context, input CompleteInteractiveRuntimeOperationInput) (RuntimeOperationCompletion, bool, error) {
	if input.Disposition != InteractionStatusAnswered && input.Disposition != InteractionStatusSuperseded {
		return RuntimeOperationCompletion{}, false, errors.New("interactive completion disposition must be answered or superseded")
	}
	return s.completeRuntimeOperation(ctx, input.WorkspaceID, input.OperationID, input.LeaseOwner, input.NowUnixMS,
		func(tx *sql.Tx, op RuntimeOperation) (string, string, map[string]any, error) {
			if op.Kind != RuntimeOperationKindInteractiveResponse {
				return "", "", nil, ErrRuntimeOperationSubjectState
			}
			interaction, found, err := getAgentInteractionTx(ctx, tx, op.WorkspaceID, op.AgentSessionID, op.TurnID, op.RequestID)
			if err != nil {
				return "", "", nil, err
			}
			if !found || interaction.TurnID != op.TurnID {
				return "", "", nil, ErrRuntimeOperationSubjectState
			}
			if interaction.Status == InteractionStatusPending {
				outputJSON, err := marshalJSONMap(input.Output)
				if err != nil {
					return "", "", nil, err
				}
				update, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_interactions
SET status = ?, output_json = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND request_id = ?
  AND turn_id = ? AND status = ?
`, input.Disposition, outputJSON, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID,
					op.RequestID, op.TurnID, InteractionStatusPending)
				if err != nil {
					return "", "", nil, fmt.Errorf("complete runtime interaction: %w", err)
				}
				changed, err := rowsWereAffected(update, "complete runtime interaction")
				if err != nil || !changed {
					return "", "", nil, ErrRuntimeOperationSubjectState
				}
			}
			return input.Disposition, RuntimeOperationEventInteractiveCompleted, map[string]any{
				"requestId": op.RequestID, "turnId": op.TurnID, "status": input.Disposition,
			}, nil
		})
}

func (s *Store) CompleteCancelRuntimeOperation(ctx context.Context, input CompleteCancelRuntimeOperationInput) (RuntimeOperationCompletion, bool, error) {
	return s.completeRuntimeOperation(ctx, input.WorkspaceID, input.OperationID, input.LeaseOwner, input.NowUnixMS,
		func(tx *sql.Tx, op RuntimeOperation) (string, string, map[string]any, error) {
			if op.Kind != RuntimeOperationKindCancelTurn {
				return "", "", nil, ErrRuntimeOperationSubjectState
			}
			targets, err := cancelTargetsFromRuntimeOperation(op)
			if err != nil {
				return "", "", nil, err
			}
			requestedOutcomes, err := cancelTargetOutcomeMap(targets, input.TargetOutcomes)
			if err != nil {
				return "", "", nil, err
			}
			result := RuntimeOperationResultAlreadySettled
			eventTargets := make([]any, 0, len(targets))
			rootAgentSessionID := payloadString(op.Payload, "rootAgentSessionId")
			rootTargeted := false
			for _, target := range targets {
				if target.AgentSessionID == rootAgentSessionID {
					rootTargeted = true
					break
				}
			}
			var reconciledRoot Turn
			for _, target := range targets {
				turn, found, err := getAgentTurnTx(ctx, tx, op.WorkspaceID, target.AgentSessionID, target.TurnID)
				if err != nil {
					return "", "", nil, err
				}
				if !found {
					return "", "", nil, ErrRuntimeOperationSubjectState
				}
				outcome := turn.Outcome
				if turn.Phase != TurnPhaseSettled {
					outcome = requestedOutcomes[cancelTargetKey(target.AgentSessionID, target.TurnID)]
					var activeTurnID sql.NullString
					if err := tx.QueryRowContext(ctx, `
SELECT active_turn_id FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ?
`, op.WorkspaceID, target.AgentSessionID).Scan(&activeTurnID); err != nil {
						return "", "", nil, fmt.Errorf("read cancel runtime operation session: %w", err)
					}
					if !activeTurnID.Valid || activeTurnID.String != target.TurnID {
						return "", "", nil, ErrRuntimeOperationSubjectState
					}
					if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET phase = ?, outcome = ?, settled_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ? AND phase != ?
`, TurnPhaseSettled, outcome, input.NowUnixMS, input.NowUnixMS,
						op.WorkspaceID, target.AgentSessionID, target.TurnID, TurnPhaseSettled); err != nil {
						return "", "", nil, fmt.Errorf("settle cancel runtime operation target: %w", err)
					}
					if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions SET active_turn_id = NULL, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND active_turn_id = ?
`, input.NowUnixMS, op.WorkspaceID, target.AgentSessionID, target.TurnID); err != nil {
						return "", "", nil, fmt.Errorf("clear canceled runtime operation active turn: %w", err)
					}
					turn.Phase = TurnPhaseSettled
					turn.Outcome = outcome
					turn.SettledAtUnixMS = input.NowUnixMS
					turn.UpdatedAtUnixMS = input.NowUnixMS
					if !rootTargeted {
						root, accepted, err := s.reconcileRootTurnAfterChildTerminalTx(ctx, tx, turn, input.NowUnixMS)
						if err != nil {
							return "", "", nil, err
						}
						if accepted {
							reconciledRoot = root
						}
					}
				}
				if target.AgentSessionID == op.AgentSessionID && target.TurnID == op.TurnID && outcome == TurnOutcomeCanceled {
					result = RuntimeOperationResultCanceled
				}
				if outcome == TurnOutcomeCanceled {
					if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET error_json = NULL, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
  AND outcome = ? AND error_json IS NOT NULL
`, input.NowUnixMS, op.WorkspaceID, target.AgentSessionID, target.TurnID, TurnOutcomeCanceled); err != nil {
						return "", "", nil, fmt.Errorf("clear canceled runtime operation target error: %w", err)
					}
					turn.ErrorMessage = ""
					turn.ErrorCode = ""
					turn.UpdatedAtUnixMS = input.NowUnixMS
				}
				if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_interactions SET status = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ? AND status = ?
`, InteractionStatusSuperseded, input.NowUnixMS, op.WorkspaceID, target.AgentSessionID,
					target.TurnID, InteractionStatusPending); err != nil {
					return "", "", nil, fmt.Errorf("supersede canceled runtime operation interactions: %w", err)
				}
				eventTargets = append(eventTargets, map[string]any{
					"agentSessionId": target.AgentSessionID,
					"turnId":         target.TurnID,
					"outcome":        outcome,
				})
			}
			eventPayload := map[string]any{
				"turnId": op.TurnID, "result": result, "rootAgentSessionId": rootAgentSessionID, "targets": eventTargets,
			}
			if reconciledRoot.TurnID != "" {
				eventPayload["reconciledRoot"] = map[string]any{
					"agentSessionId": reconciledRoot.AgentSessionID,
					"turnId":         reconciledRoot.TurnID,
					"outcome":        reconciledRoot.Outcome,
				}
			}
			return result, RuntimeOperationEventTurnCanceled, eventPayload, nil
		})
}

func cancelTargetOutcomeMap(
	targets []runtimeCancelTarget,
	values []CancelRuntimeOperationTargetOutcome,
) (map[string]string, error) {
	if len(values) != len(targets) {
		return nil, errors.New("cancel completion outcomes must cover every target")
	}
	allowed := make(map[string]struct{}, len(targets))
	for _, target := range targets {
		allowed[cancelTargetKey(target.AgentSessionID, target.TurnID)] = struct{}{}
	}
	result := make(map[string]string, len(values))
	for _, value := range values {
		value.AgentSessionID = strings.TrimSpace(value.AgentSessionID)
		value.TurnID = strings.TrimSpace(value.TurnID)
		value.Outcome = strings.TrimSpace(value.Outcome)
		key := cancelTargetKey(value.AgentSessionID, value.TurnID)
		if _, ok := allowed[key]; !ok {
			return nil, errors.New("cancel completion outcome does not match an operation target")
		}
		if _, duplicate := result[key]; duplicate {
			return nil, errors.New("cancel completion outcomes must be unique")
		}
		if value.Outcome != TurnOutcomeCanceled && value.Outcome != TurnOutcomeInterrupted {
			return nil, errors.New("cancel completion outcome must be canceled or interrupted")
		}
		result[key] = value.Outcome
	}
	return result, nil
}

func cancelTargetKey(agentSessionID string, turnID string) string {
	return strings.TrimSpace(agentSessionID) + "\x00" + strings.TrimSpace(turnID)
}

func (s *Store) CompletePlanDecisionRuntimeOperation(ctx context.Context, input CompletePlanDecisionRuntimeOperationInput) (RuntimeOperationCompletion, bool, error) {
	return s.completeRuntimeOperation(ctx, input.WorkspaceID, input.OperationID, input.LeaseOwner, input.NowUnixMS,
		func(tx *sql.Tx, op RuntimeOperation) (string, string, map[string]any, error) {
			if op.Kind != RuntimeOperationKindPlanDecision {
				return "", "", nil, ErrRuntimeOperationSubjectState
			}
			promptKind := payloadString(op.Payload, "promptKind")
			step := payloadString(op.Payload, "step")
			if promptKind == "plan-implementation" {
				confirmedTurnID := payloadString(op.Payload, "confirmedTurnId")
				clientSubmitID := payloadString(op.Payload, "clientSubmitId")
				if payloadString(op.Payload, "action") != "implement" || step != "send_confirmed" ||
					confirmedTurnID == "" || confirmedTurnID == op.TurnID || clientSubmitID == "" {
					return "", "", nil, ErrRuntimeOperationSubjectState
				}
				if _, found, err := getAgentTurnTx(ctx, tx, op.WorkspaceID, op.AgentSessionID, confirmedTurnID); err != nil {
					return "", "", nil, err
				} else if !found {
					return "", "", nil, ErrRuntimeOperationSubjectState
				}
				var confirmed int
				err := tx.QueryRowContext(ctx, `
SELECT EXISTS(
  SELECT 1 FROM workspace_agent_messages
  WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
    AND deleted_at_unix_ms = 0
    AND json_extract(payload_json, '$.clientSubmitId') = ?
)
`, op.WorkspaceID, op.AgentSessionID, confirmedTurnID, clientSubmitID).Scan(&confirmed)
				if err != nil {
					return "", "", nil, fmt.Errorf("confirm plan decision submit evidence: %w", err)
				}
				if confirmed != 1 {
					return "", "", nil, ErrRuntimeOperationSubjectState
				}
				if err := completePlanDecisionNoticeTx(ctx, tx, op, confirmedTurnID, input.NowUnixMS); err != nil {
					return "", "", nil, err
				}
			} else {
				return "", "", nil, ErrRuntimeOperationSubjectState
			}
			return RuntimeOperationResultApplied, RuntimeOperationEventPlanDecisionCompleted, map[string]any{
				"turnId": op.TurnID, "confirmedTurnId": payloadString(op.Payload, "confirmedTurnId"),
				"requestId":       op.RequestID,
				"idempotencyKey":  payloadString(op.Payload, "idempotencyKey"),
				"noticeMessageId": planDecisionNoticeMessageID(op.OperationID),
				"output":          cloneJSONMap(input.Output),
			}, nil
		})
}

func completePlanDecisionNoticeTx(ctx context.Context, tx *sql.Tx, operation RuntimeOperation, confirmedTurnID string, now int64) error {
	payloadJSON, err := marshalJSONMap(map[string]any{
		"kind":            "agent_system_notice",
		"noticeKind":      "plan_implementation_completed",
		"severity":        "info",
		"retryable":       false,
		"operationId":     operation.OperationID,
		"planTurnId":      operation.TurnID,
		"confirmedTurnId": confirmedTurnID,
	})
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_messages
SET version = COALESCE((SELECT MAX(candidate.version) + 1 FROM workspace_agent_messages AS candidate
                        WHERE candidate.workspace_id = ? AND candidate.agent_session_id = ?), version + 1),
    status = 'completed', payload_json = ?, completed_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND message_id = ?
`, operation.WorkspaceID, operation.AgentSessionID, payloadJSON, now, now,
		operation.WorkspaceID, operation.AgentSessionID, planDecisionNoticeMessageID(operation.OperationID))
	if err != nil {
		return fmt.Errorf("complete plan decision notice: %w", err)
	}
	changed, err := rowsWereAffected(result, "complete plan decision notice")
	if err != nil {
		return err
	}
	if !changed {
		return ErrRuntimeOperationSubjectState
	}
	return nil
}

type runtimeOperationDomainCompletion func(*sql.Tx, RuntimeOperation) (string, string, map[string]any, error)

func (s *Store) completeRuntimeOperation(ctx context.Context, workspaceID string, operationID string, leaseOwner string, now int64, completeDomain runtimeOperationDomainCompletion) (RuntimeOperationCompletion, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperationCompletion{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID, operationID, leaseOwner = strings.TrimSpace(workspaceID), strings.TrimSpace(operationID), strings.TrimSpace(leaseOwner)
	if workspaceID == "" || operationID == "" || leaseOwner == "" || now <= 0 {
		return RuntimeOperationCompletion{}, false, errors.New("workspace, operation, lease owner, and completion time are required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RuntimeOperationCompletion{}, false, fmt.Errorf("begin runtime operation completion: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	op, found, err := getRuntimeOperationTx(ctx, tx, workspaceID, operationID)
	if err != nil {
		return RuntimeOperationCompletion{}, false, err
	}
	if !found {
		return RuntimeOperationCompletion{}, false, sql.ErrNoRows
	}
	if op.Status == RuntimeOperationStatusCompleted {
		event, _, err := getRuntimeOperationEventTx(ctx, tx, op.OperationID)
		if err != nil {
			return RuntimeOperationCompletion{}, false, err
		}
		if _, err := s.commitTransaction(ctx, tx, workspaceID, nil); err != nil {
			return RuntimeOperationCompletion{}, false, err
		}
		committed = true
		return RuntimeOperationCompletion{Operation: op, Event: event}, false, nil
	}
	if op.Status != RuntimeOperationStatusLeased || op.LeaseOwner != leaseOwner || op.LeaseExpiresAtMS <= now {
		return RuntimeOperationCompletion{}, false, ErrRuntimeOperationLeaseLost
	}
	result, eventKind, eventPayload, err := completeDomain(tx, op)
	if err != nil {
		return RuntimeOperationCompletion{}, false, err
	}
	event, err := insertRuntimeOperationEventTx(ctx, tx, op, eventKind, eventPayload, now)
	if err != nil {
		return RuntimeOperationCompletion{}, false, err
	}
	update, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET status = ?, result = ?, lease_owner = NULL, lease_expires_at_unix_ms = NULL,
    version = version + 1, last_error = '', updated_at_unix_ms = ?, completed_at_unix_ms = ?
WHERE workspace_id = ? AND operation_id = ? AND status = ? AND lease_owner = ?
`, RuntimeOperationStatusCompleted, result, now, now, workspaceID, operationID,
		RuntimeOperationStatusLeased, leaseOwner)
	if err != nil {
		return RuntimeOperationCompletion{}, false, fmt.Errorf("complete runtime operation: %w", err)
	}
	changed, err := rowsWereAffected(update, "complete runtime operation")
	if err != nil || !changed {
		return RuntimeOperationCompletion{}, false, ErrRuntimeOperationLeaseLost
	}
	op, _, err = getRuntimeOperationTx(ctx, tx, workspaceID, operationID)
	if err != nil {
		return RuntimeOperationCompletion{}, false, err
	}
	mutations, err := runtimeOperationCompletionMutations(ctx, tx, op, event)
	if err != nil {
		return RuntimeOperationCompletion{}, false, err
	}
	delta, err := s.commitTransaction(ctx, tx, workspaceID, mutations)
	if err != nil {
		return RuntimeOperationCompletion{}, false, fmt.Errorf("commit runtime operation completion: %w", err)
	}
	committed = true
	op.CommitTransactionID = delta.TransactionID
	op.CommitDelta = delta
	return RuntimeOperationCompletion{TransactionID: delta.TransactionID, CommitDelta: delta, Operation: op, Event: event}, true, nil
}

func runtimeOperationCompletionMutations(ctx context.Context, tx *sql.Tx, op RuntimeOperation, event RuntimeOperationEvent) ([]TransactionMutation, error) {
	mutations := []TransactionMutation{
		transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeOperation, op.OperationID, "complete", op.Version),
		transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeEvent, fmt.Sprint(event.ID), "insert", event.ID),
	}
	switch event.Kind {
	case RuntimeOperationEventInteractiveCompleted:
		mutations = append(mutations, transactionMutation(
			op.WorkspaceID, op.AgentSessionID, MutationEntityInteraction,
			interactionMutationEntityID(op.TurnID, op.RequestID), "upsert", op.UpdatedAtUnixMS,
		))
	case RuntimeOperationEventTurnCanceled:
		if targets, ok := event.Payload["targets"].([]any); ok {
			for _, raw := range targets {
				target, _ := raw.(map[string]any)
				sessionID, turnID := payloadString(target, "agentSessionId"), payloadString(target, "turnId")
				mutations = append(mutations,
					transactionMutation(op.WorkspaceID, sessionID, MutationEntityTurn, turnID, "upsert", op.UpdatedAtUnixMS),
					transactionMutation(op.WorkspaceID, sessionID, MutationEntitySession, sessionID, "upsert", op.UpdatedAtUnixMS),
				)
				interactionMutations, err := canceledInteractionMutations(ctx, tx, op.WorkspaceID, sessionID, turnID, op.UpdatedAtUnixMS)
				if err != nil {
					return nil, err
				}
				mutations = append(mutations, interactionMutations...)
			}
		}
		if root, ok := event.Payload["reconciledRoot"].(map[string]any); ok {
			sessionID, turnID := payloadString(root, "agentSessionId"), payloadString(root, "turnId")
			mutations = append(mutations,
				transactionMutation(op.WorkspaceID, sessionID, MutationEntityTurn, turnID, "upsert", op.UpdatedAtUnixMS),
				transactionMutation(op.WorkspaceID, sessionID, MutationEntitySession, sessionID, "upsert", op.UpdatedAtUnixMS),
			)
		}
	case RuntimeOperationEventPlanDecisionCompleted:
		messageID := planDecisionNoticeMessageID(op.OperationID)
		message, found, err := getAgentMessageForUpdate(ctx, tx, op.WorkspaceID, op.AgentSessionID, messageID)
		if err != nil {
			return nil, err
		}
		if found {
			mutations = append(mutations, transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityMessage, messageID, "upsert", int64(message.Version)))
		}
	}
	return mutations, nil
}

func canceledInteractionMutations(ctx context.Context, tx *sql.Tx, workspaceID, agentSessionID, turnID string, updatedAt int64) ([]TransactionMutation, error) {
	rows, err := tx.QueryContext(ctx, `
SELECT request_id FROM workspace_agent_interactions
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
  AND status = ? AND updated_at_unix_ms = ?
ORDER BY request_id
`, workspaceID, agentSessionID, turnID, InteractionStatusSuperseded, updatedAt)
	if err != nil {
		return nil, fmt.Errorf("list canceled runtime operation interactions: %w", err)
	}
	defer rows.Close()
	mutations := make([]TransactionMutation, 0)
	for rows.Next() {
		var requestID string
		if err := rows.Scan(&requestID); err != nil {
			return nil, fmt.Errorf("scan canceled runtime operation interaction: %w", err)
		}
		mutations = append(mutations, transactionMutation(
			workspaceID, agentSessionID, MutationEntityInteraction,
			interactionMutationEntityID(turnID, requestID), "supersede", updatedAt,
		))
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate canceled runtime operation interactions: %w", err)
	}
	return mutations, nil
}

func insertRuntimeOperationEventTx(ctx context.Context, tx *sql.Tx, op RuntimeOperation, kind string, payload map[string]any, now int64) (RuntimeOperationEvent, error) {
	payloadJSON, err := marshalJSONMap(payload)
	if err != nil {
		return RuntimeOperationEvent{}, err
	}
	result, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_runtime_operation_events (
  operation_id, workspace_id, agent_session_id, kind, payload_json, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?)
`, op.OperationID, op.WorkspaceID, op.AgentSessionID, kind, payloadJSON, now)
	if err != nil {
		return RuntimeOperationEvent{}, fmt.Errorf("insert runtime operation event: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return RuntimeOperationEvent{}, fmt.Errorf("read runtime operation event id: %w", err)
	}
	return RuntimeOperationEvent{ID: id, OperationID: op.OperationID, WorkspaceID: op.WorkspaceID,
		AgentSessionID: op.AgentSessionID, Kind: kind, Payload: cloneJSONMap(payload), CreatedAtUnixMS: now}, nil
}
