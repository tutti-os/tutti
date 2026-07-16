package storesqlite

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (s *Store) ReportSessionState(
	ctx context.Context,
	input SessionStateReport,
) (StateReportResult, error) {
	if s == nil || s.db == nil {
		return StateReportResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return StateReportResult{}, errors.New("workspace id and agent session id are required")
	}
	if err := s.ensureWorkspaceExists(ctx, workspaceID); err != nil {
		return StateReportResult{}, err
	}

	now := unixMs(time.Now().UTC())
	if input.OccurredAtUnixMS <= 0 {
		input.OccurredAtUnixMS = now
	}
	accepted, stateApplied, lastEventUnixMS, session, err := s.upsertAgentSession(ctx, input, now)
	if err != nil {
		return StateReportResult{}, err
	}
	return StateReportResult{
		Accepted:        accepted,
		StateApplied:    stateApplied,
		LastEventUnixMS: lastEventUnixMS,
		Session:         session,
	}, nil
}

// ReportActivityState commits a session report and its protocol v2 child
// entities in one transaction. This is the write boundary used by live
// runtime reports; publishing happens only after this method returns.
func (s *Store) ReportActivityState(
	ctx context.Context,
	input ActivityStateReport,
) (ActivityStateReportResult, error) {
	if s == nil || s.db == nil {
		return ActivityStateReportResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.Session.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.Session.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return ActivityStateReportResult{}, errors.New("workspace id and agent session id are required")
	}
	if err := validateActivityStateChildScope(workspaceID, agentSessionID, input); err != nil {
		return ActivityStateReportResult{}, err
	}
	if err := s.ensureWorkspaceExists(ctx, workspaceID); err != nil {
		return ActivityStateReportResult{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ActivityStateReportResult{}, fmt.Errorf("begin workspace agent activity state report: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	now := unixMs(time.Now().UTC())
	if input.Session.OccurredAtUnixMS <= 0 {
		input.Session.OccurredAtUnixMS = now
	}
	accepted, stateApplied, lastEventUnixMS, session, err := s.upsertAgentSessionTx(ctx, tx, input.Session, now)
	if err != nil {
		return ActivityStateReportResult{}, err
	}
	result := ActivityStateReportResult{State: StateReportResult{
		Accepted:        accepted,
		StateApplied:    stateApplied,
		LastEventUnixMS: lastEventUnixMS,
		Session:         session,
	}}
	// Turn transitions have their own monotonic state machine and may be the
	// first durable evidence attached to an otherwise exact-replay session
	// snapshot (notably provider-initiated interactions). Apply them regardless
	// of whether the enclosing session projection changed.
	if accepted && input.Turn != nil {
		result.Turn, result.TurnAccepted, err = s.recordTurnTransitionTx(ctx, tx, *input.Turn, now)
		if err != nil {
			return ActivityStateReportResult{}, err
		}
		if !result.TurnAccepted && !turnTransitionAlreadyApplied(result.Turn, *input.Turn) {
			return ActivityStateReportResult{}, errors.New("workspace agent activity turn transition was rejected")
		}
	}
	if accepted && input.RootProviderTurn != nil {
		result.RootTurn, result.RootTurnAccepted, err = s.applyRootProviderTurnTransitionTx(ctx, tx, *input.RootProviderTurn, now)
		if err != nil {
			return ActivityStateReportResult{}, err
		}
	}
	if result.TurnAccepted && result.Turn.Phase == TurnPhaseSettled {
		rootTurn, rootAccepted, err := s.reconcileRootTurnAfterChildTerminalTx(ctx, tx, result.Turn, now)
		if err != nil {
			return ActivityStateReportResult{}, err
		}
		if rootTurn.TurnID != "" {
			result.RootTurn = rootTurn
			result.RootTurnAccepted = rootAccepted
		}
	}
	// Interaction transitions have their own monotonic identity/state machine.
	// Always validate and apply them even when the enclosing session report is
	// an exact replay; otherwise an immutable-identity conflict could hide
	// behind a stale session timestamp.
	if accepted && input.Interaction != nil {
		result.Interaction, result.InteractionResult, err = s.upsertInteractionTx(ctx, tx, *input.Interaction, now)
		if err != nil {
			return ActivityStateReportResult{}, err
		}
		if result.InteractionResult == InteractionTransitionConflict {
			return ActivityStateReportResult{}, errors.New("workspace agent activity interaction transition conflicts with immutable identity")
		}
	}
	if err := tx.Commit(); err != nil {
		return ActivityStateReportResult{}, fmt.Errorf("commit workspace agent activity state report: %w", err)
	}
	committed = true
	return result, nil
}

func turnTransitionAlreadyApplied(stored Turn, incoming TurnTransition) bool {
	if stored.TurnID == "" || stored.Phase != strings.TrimSpace(incoming.Phase) {
		return false
	}
	if stored.Phase != TurnPhaseSettled {
		return true
	}
	outcome := strings.TrimSpace(incoming.Outcome)
	if outcome == "" {
		outcome = TurnOutcomeCompleted
	}
	return stored.Outcome == outcome
}

func validateActivityStateChildScope(workspaceID string, agentSessionID string, input ActivityStateReport) error {
	if input.Turn != nil && (strings.TrimSpace(input.Turn.WorkspaceID) != workspaceID ||
		strings.TrimSpace(input.Turn.AgentSessionID) != agentSessionID) {
		return errors.New("turn workspace and agent session must match the activity state report")
	}
	if input.RootProviderTurn != nil && (strings.TrimSpace(input.RootProviderTurn.WorkspaceID) != workspaceID ||
		strings.TrimSpace(input.RootProviderTurn.RootAgentSessionID) != agentSessionID) {
		return errors.New("root provider turn workspace and root session must match the activity state report")
	}
	if input.Interaction != nil && (strings.TrimSpace(input.Interaction.WorkspaceID) != workspaceID ||
		strings.TrimSpace(input.Interaction.AgentSessionID) != agentSessionID) {
		return errors.New("interaction workspace and agent session must match the activity state report")
	}
	if input.Turn != nil && input.Interaction != nil &&
		strings.TrimSpace(input.Turn.TurnID) != strings.TrimSpace(input.Interaction.TurnID) {
		return errors.New("interaction turn must match the activity state report turn")
	}
	return nil
}

func (s *Store) ReportSessionMessages(
	ctx context.Context,
	input SessionMessageReport,
) (MessageReportResult, error) {
	if s == nil || s.db == nil {
		return MessageReportResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" || len(input.Messages) == 0 {
		return MessageReportResult{}, errors.New("workspace id, agent session id, and messages are required")
	}
	if err := s.ensureWorkspaceExists(ctx, workspaceID); err != nil {
		return MessageReportResult{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MessageReportResult{}, fmt.Errorf("begin workspace agent message report: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	now := unixMs(time.Now().UTC())
	agentSessionID, err = resolveAgentMessageReportSessionIDTx(ctx, tx, workspaceID, agentSessionID, input.Provider, input.Origin)
	if err != nil {
		return MessageReportResult{}, err
	}
	accepted, _, _, _, err := s.upsertAgentSessionTx(ctx, tx, SessionStateReport{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Origin:         input.Origin,
		Provider:       input.Provider,
	}, now)
	if err != nil {
		return MessageReportResult{}, err
	}
	if !accepted {
		if err := tx.Commit(); err != nil {
			return MessageReportResult{}, fmt.Errorf("commit ignored workspace agent message report: %w", err)
		}
		committed = true
		return MessageReportResult{}, nil
	}

	result := MessageReportResult{}
	allowLegacyTurnless := input.HistoricalImport
	for _, message := range input.Messages {
		message.MessageID = strings.TrimSpace(message.MessageID)
		if message.MessageID == "" {
			continue
		}
		acceptedMessage, accepted, err := s.upsertAgentMessageTx(ctx, tx, workspaceID, agentSessionID, message, now, allowLegacyTurnless)
		if err != nil {
			return MessageReportResult{}, err
		}
		if !accepted {
			continue
		}
		result.AcceptedCount++
		result.LatestVersion = acceptedMessage.Version
		result.Messages = append(result.Messages, acceptedMessage)
	}

	if err := tx.Commit(); err != nil {
		return MessageReportResult{}, fmt.Errorf("commit workspace agent message report: %w", err)
	}
	committed = true
	return result, nil
}
