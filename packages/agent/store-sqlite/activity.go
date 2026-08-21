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
		TransactionID:   session.CommitTransactionID,
		CommitDelta:     session.CommitDelta,
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

	now := unixMs(time.Now().UTC())
	if input.Session.OccurredAtUnixMS <= 0 {
		input.Session.OccurredAtUnixMS = now
	}
	var result ActivityStateReportResult
	err := retrySQLiteBusy(ctx, func(attemptCtx context.Context) error {
		var err error
		result, err = s.reportActivityStateOnce(attemptCtx, input, now)
		return err
	})
	return result, err
}

func (s *Store) reportActivityStateOnce(
	ctx context.Context,
	input ActivityStateReport,
	now int64,
) (ActivityStateReportResult, error) {
	workspaceID := strings.TrimSpace(input.Session.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.Session.AgentSessionID)

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

	goalBefore, err := readSessionGoalProjectionTx(ctx, tx, input.Session)
	if err != nil {
		return ActivityStateReportResult{}, err
	}
	accepted, stateApplied, lastEventUnixMS, session, err := s.upsertAgentSessionTx(ctx, tx, input.Session, now)
	if err != nil {
		return ActivityStateReportResult{}, err
	}
	sessionWritable, err := sessionActivityWritableTx(ctx, tx, workspaceID, agentSessionID)
	if err != nil {
		return ActivityStateReportResult{}, err
	}
	result := ActivityStateReportResult{State: StateReportResult{
		Accepted:        accepted,
		StateApplied:    stateApplied,
		LastEventUnixMS: lastEventUnixMS,
		Session:         session,
	}}
	turnTerminalTransition := false
	rootTurnTerminalTransition := false
	result.Messages.LatestVersion = session.MessageVersion
	if !accepted && len(input.Messages) > 0 {
		return ActivityStateReportResult{}, errors.New("workspace agent activity session rejected atomic messages")
	}
	// Turn transitions have their own monotonic state machine and may be the
	// first durable evidence attached to an otherwise exact-replay session
	// snapshot (notably provider-initiated interactions). Apply them regardless
	// of whether the enclosing session projection changed.
	if input.Turn != nil && sessionWritable {
		result.Turn, result.TurnAccepted, err = s.recordTurnTransitionTx(ctx, tx, *input.Turn, now)
		if err != nil {
			return ActivityStateReportResult{}, err
		}
		if !result.TurnAccepted && !turnTransitionAlreadyApplied(result.Turn, *input.Turn) {
			return ActivityStateReportResult{}, errors.New("workspace agent activity turn transition was rejected")
		}
		turnTerminalTransition = result.TurnAccepted &&
			strings.TrimSpace(input.Turn.Phase) == TurnPhaseSettled
	}
	// RootProviderTurn may arrive on an exact-replay session envelope after Exec
	// already set CurrentPhase (Claude Code identity_resolved). Apply whenever the
	// session row is addressable so Replay commit correlation still gets a
	// durable turn mutation / RootProviderTurnAccepted flag.
	if input.RootProviderTurn != nil && sessionWritable {
		result.RootTurn, result.RootTurnAccepted, result.RootProviderTurnAccepted, err = s.applyRootProviderTurnTransitionTx(ctx, tx, *input.RootProviderTurn, now)
		if err != nil {
			return ActivityStateReportResult{}, err
		}
		rootTurnTerminalTransition = result.RootTurnAccepted &&
			result.RootTurn.Phase == TurnPhaseSettled
	}
	if turnTerminalTransition {
		rootTurn, rootAccepted, err := s.reconcileRootTurnAfterChildTerminalTx(ctx, tx, result.Turn, now)
		if err != nil {
			return ActivityStateReportResult{}, err
		}
		if rootTurn.TurnID != "" {
			result.RootTurn = rootTurn
			result.RootTurnAccepted = rootAccepted
			rootTurnTerminalTransition = rootAccepted && rootTurn.Phase == TurnPhaseSettled
		}
	}
	// Interaction transitions have their own monotonic identity/state machine.
	// Always validate and apply them even when the enclosing session report is
	// an exact replay; otherwise an immutable-identity conflict could hide
	// behind a stale session timestamp.
	if input.Interaction != nil && sessionWritable {
		result.Interaction, result.InteractionResult, err = s.upsertInteractionTx(ctx, tx, *input.Interaction, now)
		if err != nil {
			return ActivityStateReportResult{}, err
		}
		if result.InteractionResult == InteractionTransitionConflict {
			return ActivityStateReportResult{}, errors.New("workspace agent activity interaction transition conflicts with immutable identity")
		}
	}
	if accepted {
		for index, message := range input.Messages {
			message.MessageID = strings.TrimSpace(message.MessageID)
			message.TurnID = strings.TrimSpace(message.TurnID)
			if message.MessageID == "" || message.TurnID == "" {
				return ActivityStateReportResult{}, fmt.Errorf(
					"workspace agent activity message %d requires message id and turn id",
					index,
				)
			}
			acceptedMessage, messageAccepted, _, messageErr := s.upsertAgentMessageTx(
				ctx, tx, workspaceID, agentSessionID, message, now, false, true,
			)
			if messageErr != nil {
				return ActivityStateReportResult{}, messageErr
			}
			if !messageAccepted {
				return ActivityStateReportResult{}, fmt.Errorf(
					"workspace agent activity message %q was rejected",
					message.MessageID,
				)
			}
			result.Messages.AcceptedCount++
			if acceptedMessage.Version > result.Messages.LatestVersion {
				result.Messages.LatestVersion = acceptedMessage.Version
			}
			result.Messages.Messages = append(result.Messages.Messages, acceptedMessage)
		}
	}
	mutations := activityStateMutations(result, turnTerminalTransition, rootTurnTerminalTransition)
	goalMutations, err := sessionGoalMutationsTx(ctx, tx, input.Session, goalBefore)
	if err != nil {
		return ActivityStateReportResult{}, err
	}
	mutations = append(mutations, goalMutations...)
	delta, err := s.commitTransaction(ctx, tx, workspaceID, mutations)
	if err != nil {
		return ActivityStateReportResult{}, fmt.Errorf("commit workspace agent activity state report: %w", err)
	}
	committed = true
	result.TransactionID = delta.TransactionID
	result.CommitDelta = delta
	result.State.TransactionID = delta.TransactionID
	result.State.CommitDelta = delta
	result.State.Session.CommitTransactionID = delta.TransactionID
	result.State.Session.CommitDelta = delta
	return result, nil
}

func activityStateMutations(
	result ActivityStateReportResult,
	turnTerminalTransition bool,
	rootTurnTerminalTransition bool,
) []TransactionMutation {
	mutations := make([]TransactionMutation, 0, 4+len(result.Messages.Messages))
	if result.State.Accepted {
		session := result.State.Session
		mutations = append(mutations, transactionMutation(session.WorkspaceID, session.ID, MutationEntitySession, session.ID, "upsert", session.UpdatedAtUnixMS))
	}
	if result.TurnAccepted {
		turnMutation := transactionMutation(result.Turn.WorkspaceID, result.Turn.AgentSessionID, MutationEntityTurn, result.Turn.TurnID, "upsert", result.Turn.UpdatedAtUnixMS)
		if turnTerminalTransition {
			turnMutation = terminalTurnMutation(result.Turn.WorkspaceID, result.Turn.AgentSessionID, result.Turn.TurnID, "upsert", result.Turn.UpdatedAtUnixMS, false)
		}
		mutations = append(mutations, turnMutation)
	}
	if result.RootTurnAccepted || result.RootProviderTurnAccepted {
		rootMutation := transactionMutation(result.RootTurn.WorkspaceID, result.RootTurn.AgentSessionID, MutationEntityTurn, result.RootTurn.TurnID, "upsert", result.RootTurn.UpdatedAtUnixMS)
		if rootTurnTerminalTransition {
			rootMutation = terminalTurnMutation(result.RootTurn.WorkspaceID, result.RootTurn.AgentSessionID, result.RootTurn.TurnID, "upsert", result.RootTurn.UpdatedAtUnixMS, false)
		}
		mutations = append(mutations, rootMutation)
	}
	if result.InteractionResult == InteractionTransitionApplied {
		mutations = append(mutations, transactionMutation(
			result.Interaction.WorkspaceID, result.Interaction.AgentSessionID, MutationEntityInteraction,
			interactionMutationEntityID(result.Interaction.TurnID, result.Interaction.RequestID),
			"upsert", result.Interaction.UpdatedAtUnixMS,
		))
	}
	for _, message := range result.Messages.Messages {
		mutations = append(mutations, transactionMutation(
			result.State.Session.WorkspaceID, message.AgentSessionID, MutationEntityMessage,
			message.MessageID, "upsert", int64(message.Version),
		))
	}
	return mutations
}

func turnTransitionAlreadyApplied(stored Turn, incoming TurnTransition) bool {
	if capabilityReferencesAlreadyApplied(stored.CapabilityRefs, incoming.CapabilityRefs) {
		if strings.TrimSpace(incoming.Phase) == "" {
			return true
		}
		// A replay of the original submitted envelope may arrive after its
		// capability refs were merged into a later lifecycle phase. This is the
		// sole cross-phase idempotency case; refs must already be present and the
		// submitted event must not be newer than the stored turn.
		if strings.TrimSpace(incoming.Phase) == TurnPhaseSubmitted &&
			incoming.OccurredAtUnixMS > 0 &&
			incoming.OccurredAtUnixMS <= stored.UpdatedAtUnixMS {
			return true
		}
	}
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

func capabilityReferencesAlreadyApplied(stored, incoming []CapabilityReference) bool {
	normalizedIncoming := normalizeCapabilityReferences(incoming)
	if len(normalizedIncoming) == 0 {
		return false
	}
	storedKeys := make(map[string]struct{}, len(stored))
	for _, reference := range normalizeCapabilityReferences(stored) {
		storedKeys[reference.Source+"\x00"+reference.Capability] = struct{}{}
	}
	for _, reference := range normalizedIncoming {
		if _, ok := storedKeys[reference.Source+"\x00"+reference.Capability]; !ok {
			return false
		}
	}
	return true
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

	now := unixMs(time.Now().UTC())
	var result MessageReportResult
	err := retrySQLiteBusy(ctx, func(attemptCtx context.Context) error {
		var err error
		result, err = s.reportSessionMessagesOnce(attemptCtx, input, now)
		return err
	})
	return result, err
}

func (s *Store) reportSessionMessagesOnce(
	ctx context.Context,
	input SessionMessageReport,
	now int64,
) (MessageReportResult, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)

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
		if _, err := s.commitTransaction(ctx, tx, workspaceID, nil); err != nil {
			return MessageReportResult{}, fmt.Errorf("commit ignored workspace agent message report: %w", err)
		}
		committed = true
		return MessageReportResult{}, nil
	}

	result := MessageReportResult{}
	allowLegacyTurnless := input.HistoricalImport
	historicalTurnIDs := []string(nil)
	if input.HistoricalImport {
		historicalTurnIDs, err = ensureHistoricalImportTurnsTx(
			ctx, tx, workspaceID, agentSessionID, input.Messages, now,
		)
		if err != nil {
			return MessageReportResult{}, err
		}
	}
	for _, message := range input.Messages {
		message.MessageID = strings.TrimSpace(message.MessageID)
		if message.MessageID == "" {
			continue
		}
		acceptedMessage, accepted, statusTransitioned, err := s.upsertAgentMessageTx(ctx, tx, workspaceID, agentSessionID, message, now, allowLegacyTurnless, false)
		if err != nil {
			return MessageReportResult{}, err
		}
		if !accepted {
			if input.HistoricalImport && strings.TrimSpace(message.TurnID) != "" {
				return MessageReportResult{}, fmt.Errorf(
					"historical import message %q was rejected",
					message.MessageID,
				)
			}
			continue
		}
		result.AcceptedCount++
		result.LatestVersion = acceptedMessage.Version
		result.Messages = append(result.Messages, acceptedMessage)
		if statusTransitioned {
			result.StatusTransitionedMessageIDs = append(result.StatusTransitionedMessageIDs, acceptedMessage.MessageID)
		}
	}

	historicalTurns := []Turn(nil)
	if len(historicalTurnIDs) > 0 {
		historicalTurns, err = refreshHistoricalImportTurnsTx(
			ctx, tx, workspaceID, agentSessionID, historicalTurnIDs,
		)
		if err != nil {
			return MessageReportResult{}, err
		}
	}
	mutations := make([]TransactionMutation, 0, len(historicalTurns)+len(result.Messages))
	for _, turn := range historicalTurns {
		mutations = append(mutations, transactionMutation(
			workspaceID, agentSessionID, MutationEntityTurn, turn.TurnID, "upsert", turn.UpdatedAtUnixMS,
		))
	}
	for _, message := range result.Messages {
		mutations = append(mutations, transactionMutation(workspaceID, agentSessionID, MutationEntityMessage, message.MessageID, "upsert", int64(message.Version)))
	}
	delta, err := s.commitTransaction(ctx, tx, workspaceID, mutations)
	if err != nil {
		return MessageReportResult{}, fmt.Errorf("commit workspace agent message report: %w", err)
	}
	committed = true
	result.TransactionID = delta.TransactionID
	result.CommitDelta = delta
	return result, nil
}
