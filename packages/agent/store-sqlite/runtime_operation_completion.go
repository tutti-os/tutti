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
			result := input.Disposition
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
			} else {
				result = interaction.Status
			}
			return result, RuntimeOperationEventInteractiveCompleted, map[string]any{
				"requestId": op.RequestID, "turnId": op.TurnID, "status": result,
			}, nil
		})
}

func (s *Store) CompleteCancelRuntimeOperation(ctx context.Context, input CompleteCancelRuntimeOperationInput) (RuntimeOperationCompletion, bool, error) {
	return s.completeRuntimeOperation(ctx, input.WorkspaceID, input.OperationID, input.LeaseOwner, input.NowUnixMS,
		func(tx *sql.Tx, op RuntimeOperation) (string, string, map[string]any, error) {
			if op.Kind != RuntimeOperationKindCancelTurn {
				return "", "", nil, ErrRuntimeOperationSubjectState
			}
			turn, found, err := getAgentTurnTx(ctx, tx, op.WorkspaceID, op.AgentSessionID, op.TurnID)
			if err != nil {
				return "", "", nil, err
			}
			if !found {
				return "", "", nil, ErrRuntimeOperationSubjectState
			}
			result := RuntimeOperationResultCanceled
			if turn.Phase == TurnPhaseSettled {
				if turn.Outcome != TurnOutcomeCanceled {
					result = RuntimeOperationResultAlreadySettled
				}
			} else {
				var activeTurnID sql.NullString
				if err := tx.QueryRowContext(ctx, `
SELECT active_turn_id FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ?
`, op.WorkspaceID, op.AgentSessionID).Scan(&activeTurnID); err != nil {
					return "", "", nil, fmt.Errorf("read cancel runtime operation session: %w", err)
				}
				if !activeTurnID.Valid || activeTurnID.String != op.TurnID {
					return "", "", nil, ErrRuntimeOperationSubjectState
				}
				if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET phase = ?, outcome = ?, settled_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ? AND phase != ?
`, TurnPhaseSettled, TurnOutcomeCanceled, input.NowUnixMS, input.NowUnixMS,
					op.WorkspaceID, op.AgentSessionID, op.TurnID, TurnPhaseSettled); err != nil {
					return "", "", nil, fmt.Errorf("settle canceled runtime operation turn: %w", err)
				}
				if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions SET active_turn_id = NULL, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND active_turn_id = ?
`, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID, op.TurnID); err != nil {
					return "", "", nil, fmt.Errorf("clear canceled runtime operation active turn: %w", err)
				}
			}
			if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_interactions SET status = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ? AND status = ?
`, InteractionStatusSuperseded, input.NowUnixMS, op.WorkspaceID, op.AgentSessionID,
				op.TurnID, InteractionStatusPending); err != nil {
				return "", "", nil, fmt.Errorf("supersede canceled runtime operation interactions: %w", err)
			}
			return result, RuntimeOperationEventTurnCanceled, map[string]any{
				"turnId": op.TurnID, "result": result,
			}, nil
		})
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
		if err := tx.Commit(); err != nil {
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
	if err := tx.Commit(); err != nil {
		return RuntimeOperationCompletion{}, false, fmt.Errorf("commit runtime operation completion: %w", err)
	}
	committed = true
	return RuntimeOperationCompletion{Operation: op, Event: event}, true, nil
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
