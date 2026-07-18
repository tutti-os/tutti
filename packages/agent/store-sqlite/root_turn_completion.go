package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

func (s *Store) applyRootProviderTurnTransitionTx(
	ctx context.Context,
	tx *sql.Tx,
	transition RootProviderTurnTransition,
	now int64,
) (Turn, bool, error) {
	workspaceID := strings.TrimSpace(transition.WorkspaceID)
	rootAgentSessionID := strings.TrimSpace(transition.RootAgentSessionID)
	rootTurnID := strings.TrimSpace(transition.RootTurnID)
	providerTurnID := strings.TrimSpace(transition.ProviderTurnID)
	phase := strings.TrimSpace(transition.Phase)
	if workspaceID == "" || rootAgentSessionID == "" || rootTurnID == "" || providerTurnID == "" {
		return Turn{}, false, errors.New("workspace id, root session id, root turn id, and provider turn id are required")
	}
	if phase != RootProviderTurnPhaseRunning && phase != RootProviderTurnPhaseCompleted {
		return Turn{}, false, fmt.Errorf("unsupported root provider turn phase %q", phase)
	}
	outcome := strings.TrimSpace(transition.Outcome)
	if phase == RootProviderTurnPhaseRunning && outcome != "" {
		return Turn{}, false, errors.New("running root provider turn cannot have an outcome")
	}
	if phase == RootProviderTurnPhaseCompleted {
		if outcome == "" {
			outcome = TurnOutcomeCompleted
		}
		if !isKnownTurnOutcome(outcome) {
			return Turn{}, false, fmt.Errorf("unknown root provider turn outcome %q", outcome)
		}
	}

	var sessionKind string
	err := tx.QueryRowContext(ctx, `
SELECT session_kind
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, rootAgentSessionID).Scan(&sessionKind)
	if err != nil {
		return Turn{}, false, fmt.Errorf("read root provider turn session: %w", err)
	}
	if sessionKind != SessionKindRoot {
		return Turn{}, false, errors.New("root provider turn must belong to a root session")
	}
	rootTurn, ok, err := getAgentTurnTx(ctx, tx, workspaceID, rootAgentSessionID, rootTurnID)
	if err != nil {
		return Turn{}, false, err
	}
	if !ok {
		return Turn{}, false, errors.New("root provider turn references an unknown root turn")
	}
	occurred := transition.OccurredAtUnixMS
	if occurred <= 0 {
		occurred = now
	}
	if rootTurn.RootProviderTurnUpdatedAtUnixMS > occurred {
		return rootTurn, false, nil
	}
	if rootTurn.RootProviderTurnID != "" && rootTurn.RootProviderTurnID != providerTurnID {
		if phase == RootProviderTurnPhaseCompleted {
			return rootTurn, false, nil
		}
	} else if rootTurn.RootProviderTurnPhase == RootProviderTurnPhaseCompleted && phase == RootProviderTurnPhaseRunning {
		return rootTurn, false, nil
	}
	if rootTurn.Phase == TurnPhaseSettled && phase != RootProviderTurnPhaseCompleted {
		// A settled canonical root can still accept the matching provider's late
		// terminal fact, but it must never be reopened by a late started event.
		return rootTurn, false, nil
	}

	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET root_provider_turn_id = ?, root_provider_turn_phase = ?, root_provider_turn_outcome = ?,
    root_provider_turn_error_json = ?, root_provider_turn_completed_command_json = ?,
    root_provider_turn_updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, providerTurnID, phase, nullString(outcome),
		encodeTurnErrorJSON(transition.ErrorMessage, transition.ErrorCode),
		encodeCompletedCommandJSON(transition.CompletedCommandKind, transition.CompletedCommandStatus),
		occurred, workspaceID, rootAgentSessionID, rootTurnID); err != nil {
		return Turn{}, false, fmt.Errorf("record root provider turn transition: %w", err)
	}
	if rootTurn.Phase == TurnPhaseSettled {
		updated, found, err := getAgentTurnTx(ctx, tx, workspaceID, rootAgentSessionID, rootTurnID)
		if err != nil {
			return Turn{}, false, err
		}
		if !found {
			return Turn{}, false, errors.New("updated root provider turn references an unknown root turn")
		}
		// The provider projection changed, but the canonical turn did not. Keep
		// RootTurnAccepted false so callers do not publish or re-observe another
		// canonical settlement.
		return updated, false, nil
	}

	canonicalPhase := TurnPhaseRunning
	if phase == RootProviderTurnPhaseCompleted {
		// With no active child, this provider fact is itself the canonical
		// settlement transition. Compatibility reporters therefore classify the
		// completed RootProviderTurn patch as terminal and persist its Turn
		// messages before entering this transaction.
		activeChildren, err := countActiveChildTurnsTx(ctx, tx, workspaceID, rootAgentSessionID, rootTurnID)
		if err != nil {
			return Turn{}, false, err
		}
		if activeChildren > 0 {
			canonicalPhase = TurnPhaseWaiting
		} else {
			canonicalPhase = TurnPhaseSettled
		}
	}
	canonical := retainedRootTurnTransition(transition, canonicalPhase, outcome, occurred)
	turn, accepted, err := s.recordTurnTransitionTx(ctx, tx, canonical, now)
	if err != nil {
		return Turn{}, false, err
	}
	if !accepted && !turnTransitionAlreadyApplied(turn, canonical) {
		return Turn{}, false, errors.New("root turn transition was rejected")
	}
	return turn, accepted, nil
}

func (s *Store) reconcileRootTurnAfterChildTerminalTx(
	ctx context.Context,
	tx *sql.Tx,
	child Turn,
	now int64,
) (Turn, bool, error) {
	if child.Phase != TurnPhaseSettled {
		return Turn{}, false, nil
	}
	var kind string
	var rootAgentSessionID, rootTurnID sql.NullString
	err := tx.QueryRowContext(ctx, `
SELECT session_kind, root_agent_session_id, root_turn_id
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, child.WorkspaceID, child.AgentSessionID).Scan(&kind, &rootAgentSessionID, &rootTurnID)
	if err != nil {
		return Turn{}, false, fmt.Errorf("read terminal child session relation: %w", err)
	}
	if kind != SessionKindChild {
		return Turn{}, false, nil
	}
	rootSessionID := strings.TrimSpace(rootAgentSessionID.String)
	rootID := strings.TrimSpace(rootTurnID.String)
	rootTurn, ok, err := getAgentTurnTx(ctx, tx, child.WorkspaceID, rootSessionID, rootID)
	if err != nil || !ok || rootTurn.Phase == TurnPhaseSettled ||
		rootTurn.RootProviderTurnPhase != RootProviderTurnPhaseCompleted {
		return Turn{}, false, err
	}
	activeChildren, err := countActiveChildTurnsTx(ctx, tx, child.WorkspaceID, rootSessionID, rootID)
	if err != nil || activeChildren > 0 {
		return Turn{}, false, err
	}
	transition := TurnTransition{
		WorkspaceID:            child.WorkspaceID,
		AgentSessionID:         rootSessionID,
		TurnID:                 rootID,
		Phase:                  TurnPhaseSettled,
		Outcome:                rootTurn.RootProviderTurnOutcome,
		ErrorMessage:           rootTurn.RootProviderTurnErrorMessage,
		ErrorCode:              rootTurn.RootProviderTurnErrorCode,
		CompletedCommandKind:   rootTurn.RootProviderTurnCompletedCommandKind,
		CompletedCommandStatus: rootTurn.RootProviderTurnCompletedCommandStatus,
		OccurredAtUnixMS:       maxInt64(now, rootTurn.RootProviderTurnUpdatedAtUnixMS),
	}
	turn, accepted, err := s.recordTurnTransitionTx(ctx, tx, transition, now)
	if err != nil {
		return Turn{}, false, err
	}
	if !accepted && !turnTransitionAlreadyApplied(turn, transition) {
		return Turn{}, false, errors.New("settle root turn after child terminal was rejected")
	}
	return turn, accepted, nil
}

func retainedRootTurnTransition(
	transition RootProviderTurnTransition,
	phase string,
	outcome string,
	occurred int64,
) TurnTransition {
	return TurnTransition{
		WorkspaceID:            strings.TrimSpace(transition.WorkspaceID),
		AgentSessionID:         strings.TrimSpace(transition.RootAgentSessionID),
		TurnID:                 strings.TrimSpace(transition.RootTurnID),
		Phase:                  phase,
		Outcome:                outcome,
		ErrorMessage:           strings.TrimSpace(transition.ErrorMessage),
		ErrorCode:              strings.TrimSpace(transition.ErrorCode),
		CompletedCommandKind:   strings.TrimSpace(transition.CompletedCommandKind),
		CompletedCommandStatus: strings.TrimSpace(transition.CompletedCommandStatus),
		OccurredAtUnixMS:       occurred,
	}
}

func countActiveChildTurnsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	rootAgentSessionID string,
	rootTurnID string,
) (int, error) {
	var count int
	err := tx.QueryRowContext(ctx, `
SELECT COUNT(1)
FROM workspace_agent_sessions
WHERE workspace_id = ? AND session_kind = 'child'
  AND root_agent_session_id = ? AND root_turn_id = ?
  AND deleted_at_unix_ms = 0 AND active_turn_id IS NOT NULL
`, workspaceID, rootAgentSessionID, rootTurnID).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count active child turns: %w", err)
	}
	return count, nil
}

func maxInt64(left int64, right int64) int64 {
	if right > left {
		return right
	}
	return left
}
