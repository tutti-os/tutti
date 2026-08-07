package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

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
	case RuntimeOperationKindEditRetry:
		if input.RequestID == "" {
			return errors.New("edit retry client operation id is required")
		}
		if err := validateEditRetryOperationPayload(input.OperationID, input.Payload); err != nil {
			return err
		}
		payload, err := DecodeEditRetryOperationPayload(input.Payload)
		if err != nil {
			return err
		}
		if payload.Checkpoint != EditRetryCheckpointPrepared {
			return errors.New("new edit retry operation must start prepared")
		}
	default:
		return fmt.Errorf("unknown runtime operation kind %q", input.Kind)
	}
	return nil
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

func validateEditRetryRuntimeOperationSubjectTx(
	ctx context.Context,
	tx *sql.Tx,
	input RuntimeOperationPrepare,
	turn Turn,
) error {
	payload, err := DecodeEditRetryOperationPayload(input.Payload)
	if err != nil {
		return err
	}
	if turn.Phase != TurnPhaseSettled || turn.Origin != TurnOriginUserPrompt ||
		strings.TrimSpace(turn.RootProviderTurnID) == "" {
		return ErrRuntimeOperationSubjectState
	}
	var activeTurnID sql.NullString
	var historyRevision int64
	if err := tx.QueryRowContext(ctx, `
SELECT sessions.active_turn_id, history.history_revision
FROM workspace_agent_sessions AS sessions
JOIN workspace_agent_session_history AS history
  ON history.workspace_id = sessions.workspace_id
 AND history.agent_session_id = sessions.agent_session_id
WHERE sessions.workspace_id = ? AND sessions.agent_session_id = ?
  AND sessions.deleted_at_unix_ms = 0
`, input.WorkspaceID, input.AgentSessionID).Scan(&activeTurnID, &historyRevision); err != nil {
		return fmt.Errorf("read edit retry session history: %w", err)
	}
	if activeTurnID.Valid && strings.TrimSpace(activeTurnID.String) != "" {
		return ErrRuntimeOperationSubjectState
	}
	if historyRevision != payload.ExpectedRevision {
		return ErrRuntimeOperationSubjectState
	}
	var validSubject int
	if err := tx.QueryRowContext(ctx, `
SELECT (
  EXISTS(
    SELECT 1 FROM workspace_agent_turn_history
    WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
      AND history_state = 'effective'
  )
  AND EXISTS(
    SELECT 1 FROM workspace_agent_turn_submissions
    WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
  )
  AND NOT EXISTS(
    SELECT 1
    FROM workspace_agent_turns AS candidate
    JOIN workspace_agent_turn_history AS candidate_history
      ON candidate_history.workspace_id = candidate.workspace_id
     AND candidate_history.agent_session_id = candidate.agent_session_id
     AND candidate_history.turn_id = candidate.turn_id
    WHERE candidate.workspace_id = ? AND candidate.agent_session_id = ?
      AND candidate_history.history_state = 'effective'
      AND (candidate.started_at_unix_ms > ?
        OR (candidate.started_at_unix_ms = ? AND candidate.turn_id > ?))
  )
  AND NOT EXISTS(
    SELECT 1 FROM workspace_agent_sessions
    WHERE workspace_id = ? AND root_agent_session_id = ?
      AND root_turn_id = ?
      AND session_kind = 'child' AND deleted_at_unix_ms = 0
  )
)
`, input.WorkspaceID, input.AgentSessionID, input.TurnID,
		input.WorkspaceID, input.AgentSessionID, input.TurnID,
		input.WorkspaceID, input.AgentSessionID, turn.StartedAtUnixMS, turn.StartedAtUnixMS, input.TurnID,
		input.WorkspaceID, input.AgentSessionID, input.TurnID).Scan(&validSubject); err != nil {
		return fmt.Errorf("validate edit retry subject: %w", err)
	}
	if validSubject != 1 {
		return ErrRuntimeOperationSubjectState
	}
	return nil
}
