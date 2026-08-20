package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// RecordTurnTransition upserts one turn phase transition and keeps the
// owning session's active_turn_id reference in sync: a live phase points the
// session at this turn, a settled phase clears the pointer (only if it still
// points at this turn). A turn that is already settled is terminal; later
// lifecycle transitions are rejected so cancel races and replays stay
// idempotent. Capability provenance is independent metadata and may still be
// merged when its report arrives after the lifecycle advanced. A phase-less
// transition is accepted only for this merge-only form.
func (s *Store) RecordTurnTransition(ctx context.Context, transition TurnTransition) (Turn, bool, error) {
	if s == nil || s.db == nil {
		return Turn{}, false, errors.New("workspace database is not initialized")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Turn{}, false, fmt.Errorf("begin workspace agent turn transition: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	turn, accepted, err := s.recordTurnTransitionTx(ctx, tx, transition, unixMs(time.Now().UTC()))
	if err != nil {
		return Turn{}, false, err
	}
	mutations := []TransactionMutation{}
	if accepted {
		turnMutation := transactionMutation(
			turn.WorkspaceID, turn.AgentSessionID, MutationEntityTurn,
			turn.TurnID, "upsert", turn.UpdatedAtUnixMS,
		)
		// The persisted row may already be settled when a late capability-only
		// merge is accepted. Only the incoming lifecycle fact can identify a
		// terminal transition; the final row shape cannot.
		if strings.TrimSpace(transition.Phase) == TurnPhaseSettled {
			turnMutation = terminalTurnMutation(
				turn.WorkspaceID, turn.AgentSessionID, turn.TurnID,
				"upsert", turn.UpdatedAtUnixMS, false,
			)
		}
		mutations = append(mutations, turnMutation,
			transactionMutation(turn.WorkspaceID, turn.AgentSessionID, MutationEntitySession, turn.AgentSessionID, "upsert", turn.UpdatedAtUnixMS))
	}
	if _, err := s.commitTransaction(ctx, tx, transition.WorkspaceID, mutations); err != nil {
		return Turn{}, false, fmt.Errorf("commit workspace agent turn transition: %w", err)
	}
	committed = true
	return turn, accepted, nil
}

func (*Store) recordTurnTransitionTx(
	ctx context.Context,
	tx *sql.Tx,
	transition TurnTransition,
	now int64,
) (Turn, bool, error) {
	workspaceID := strings.TrimSpace(transition.WorkspaceID)
	agentSessionID := strings.TrimSpace(transition.AgentSessionID)
	turnID := strings.TrimSpace(transition.TurnID)
	phase := strings.TrimSpace(transition.Phase)
	capabilityRefs := normalizeCapabilityReferences(transition.CapabilityRefs)
	if workspaceID == "" || agentSessionID == "" || turnID == "" {
		return Turn{}, false, errors.New("workspace id, agent session id, and turn id are required")
	}
	if err := requireSessionForkSourceWritableTx(ctx, tx, workspaceID, agentSessionID); err != nil {
		return Turn{}, false, err
	}
	metadataOnly := phase == "" && len(capabilityRefs) > 0
	if !metadataOnly && !isKnownTurnPhase(phase) {
		return Turn{}, false, fmt.Errorf("unknown workspace agent turn phase %q", phase)
	}
	if transition.Outcome != "" && !isKnownTurnOutcome(transition.Outcome) {
		return Turn{}, false, fmt.Errorf("unknown workspace agent turn outcome %q", transition.Outcome)
	}
	if transition.Origin != "" && !isKnownTurnOrigin(transition.Origin) {
		return Turn{}, false, fmt.Errorf("unknown workspace agent turn origin %q", transition.Origin)
	}
	if err := validateLiveTurnSlotTx(ctx, tx, workspaceID, agentSessionID, turnID, phase); err != nil {
		return Turn{}, false, err
	}

	occurred := transition.OccurredAtUnixMS
	if occurred <= 0 {
		occurred = now
	}

	existing, hasExisting, err := getAgentTurnTx(ctx, tx, workspaceID, agentSessionID, turnID)
	if err != nil {
		return Turn{}, false, err
	}
	if metadataOnly {
		if !hasExisting {
			return Turn{}, false, fmt.Errorf("merge workspace agent turn capability refs: %w", sql.ErrNoRows)
		}
		return mergeTurnCapabilityReferencesTx(ctx, tx, existing, capabilityRefs)
	}
	lifecycleRejected := hasExisting && existing.Phase == TurnPhaseSettled && !existing.Backfilled
	if hasExisting && !existing.Backfilled &&
		(occurred < existing.UpdatedAtUnixMS || !isAllowedTurnPhaseTransition(existing.Phase, phase)) {
		lifecycleRejected = true
	}
	if lifecycleRejected {
		if len(capabilityRefs) > 0 {
			stored, changed, err := mergeTurnCapabilityReferencesTx(ctx, tx, existing, capabilityRefs)
			return stored, changed, err
		}
		// Reject stale, illegal, or terminal lifecycle mutations silently so
		// replays are idempotent. Capability provenance above is independent
		// metadata and may still arrive after the lifecycle advanced. Backfilled
		// placeholder rows stay writable so live reports can enrich them.
		return existing, false, nil
	}
	if err := validateLiveTurnSlotTx(ctx, tx, workspaceID, agentSessionID, turnID, phase); err != nil {
		return Turn{}, false, err
	}

	merged := mergeTurnTransition(existing, hasExisting, transition, phase, occurred, now)
	if merged.Phase == TurnPhaseSettled {
		merged.FinalAssistantMessageID, err = finalAssistantMessageIDAtSettlementTx(
			ctx, tx, workspaceID, agentSessionID, turnID, transition.FinalAssistantMessageID,
		)
		if err != nil {
			return Turn{}, false, err
		}
		merged.FinalAssistantMessageResolved = true
	}

	fileChangesJSON, err := marshalNullableJSONMap(merged.FileChanges)
	if err != nil {
		return Turn{}, false, fmt.Errorf("encode workspace agent turn file changes: %w", err)
	}
	capabilityRefsJSON, err := json.Marshal(merged.CapabilityRefs)
	if err != nil {
		return Turn{}, false, fmt.Errorf("encode workspace agent turn capability refs: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, capability_refs_json, phase, outcome, error_json,
  file_changes_json, completed_command_json, backfilled,
  started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms,
  turn_origin, source_goal_operation_id, source_goal_revision, source_goal_repair_epoch
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id, turn_id) DO UPDATE SET
  capability_refs_json = excluded.capability_refs_json,
  phase = excluded.phase,
  outcome = excluded.outcome,
  error_json = excluded.error_json,
  file_changes_json = excluded.file_changes_json,
  completed_command_json = excluded.completed_command_json,
  backfilled = 0,
  started_at_unix_ms = excluded.started_at_unix_ms,
  settled_at_unix_ms = excluded.settled_at_unix_ms,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, workspaceID, agentSessionID, turnID, string(capabilityRefsJSON), merged.Phase, nullString(merged.Outcome),
		encodeTurnErrorJSON(merged.ErrorMessage, merged.ErrorCode),
		fileChangesJSON,
		encodeCompletedCommandJSON(merged.CompletedCommandKind, merged.CompletedCommandStatus, finalAssistantWatermark{
			MessageID: merged.FinalAssistantMessageID, Resolved: merged.FinalAssistantMessageResolved,
		}),
		merged.StartedAtUnixMS, nullInt64(merged.SettledAtUnixMS),
		merged.CreatedAtUnixMS, merged.UpdatedAtUnixMS, merged.Origin,
		nullString(merged.SourceGoalOperationID), nullInt64(merged.SourceGoalRevision), nullInt64WhenAbsent(merged.SourceGoalRepairEpoch, merged.SourceGoalOperationID != "")); err != nil {
		return Turn{}, false, fmt.Errorf("upsert workspace agent turn: %w", err)
	}
	// A fresh canonical Turn is appended under the store's single-live-Turn
	// invariant, so its trigger-assigned position is trustworthy. Migration
	// and imported/backfilled paths establish their proof independently.
	if !hasExisting && !merged.Backfilled {
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turn_sequences
SET provenance = 'verified'
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, workspaceID, agentSessionID, turnID); err != nil {
			return Turn{}, false, fmt.Errorf("verify workspace agent turn sequence: %w", err)
		}
	}
	if merged.Phase == TurnPhaseSettled {
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET active_turn_id = NULL, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND active_turn_id = ?
`, now, workspaceID, agentSessionID, turnID); err != nil {
			return Turn{}, false, fmt.Errorf("clear workspace agent session active turn: %w", err)
		}
		// A settled turn supersedes any interaction still pending on it.
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_interactions
SET status = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ? AND status = ?
`, InteractionStatusSuperseded, now, workspaceID, agentSessionID, turnID, InteractionStatusPending); err != nil {
			return Turn{}, false, fmt.Errorf("supersede workspace agent interactions on settle: %w", err)
		}
	} else {
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET active_turn_id = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
	  AND active_turn_id IS NULL
`, turnID, now, workspaceID, agentSessionID); err != nil {
			return Turn{}, false, fmt.Errorf("set workspace agent session active turn: %w", err)
		}
	}
	if acceptedGoalExecutionTurn(merged) {
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_goals
SET execution_pending = 0, updated_at_unix_ms = MAX(updated_at_unix_ms, ?)
WHERE workspace_id = ? AND agent_session_id = ? AND revision = ? AND execution_pending = 1
  AND EXISTS (
    SELECT 1 FROM workspace_agent_goal_control_operations operation
    WHERE operation.workspace_id = workspace_agent_session_goals.workspace_id
      AND operation.agent_session_id = workspace_agent_session_goals.agent_session_id
      AND operation.operation_id = ? AND operation.goal_revision = ? AND operation.repair_epoch = ?
  )
`, occurred, workspaceID, agentSessionID, merged.SourceGoalRevision,
			merged.SourceGoalOperationID, merged.SourceGoalRevision, merged.SourceGoalRepairEpoch); err != nil {
			return Turn{}, false, fmt.Errorf("clear Goal execution-pending state: %w", err)
		}
	}

	stored, ok, err := getAgentTurnTx(ctx, tx, workspaceID, agentSessionID, turnID)
	if err != nil {
		return Turn{}, false, err
	}
	if !ok {
		return Turn{}, false, fmt.Errorf("read recorded workspace agent turn: %w", sql.ErrNoRows)
	}
	return stored, true, nil
}

func acceptedGoalExecutionTurn(turn Turn) bool {
	if turn.Origin != TurnOriginGoalArm && turn.Origin != TurnOriginGoalContinuation {
		return false
	}
	return strings.TrimSpace(turn.SourceGoalOperationID) != "" &&
		turn.SourceGoalRevision > 0 && turn.SourceGoalRepairEpoch >= 0
}

// validateLiveTurnSlotTx enforces the session-to-live-turn cardinality at the
// durable write boundary. Keeping the previous active_turn_id while still
// inserting a second live turn only hides the conflict from selectors; it
// leaves two canonical live entities behind. Returning an error is
// intentional so ReportActivityState rolls the accompanying session patch
// back in the same transaction.
func validateLiveTurnSlotTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
	turnID string,
	phase string,
) error {
	if phase == TurnPhaseSettled {
		return nil
	}

	var activeTurnID sql.NullString
	err := tx.QueryRowContext(ctx, `
SELECT active_turn_id
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, agentSessionID).Scan(&activeTurnID)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("workspace agent turn references unknown or deleted session %q", agentSessionID)
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read workspace agent session active turn: %w", err)
	}
	if active := strings.TrimSpace(activeTurnID.String); activeTurnID.Valid && active != "" && active != turnID {
		return fmt.Errorf("workspace agent session already has live turn %q; cannot start %q", active, turnID)
	}

	var conflictingTurnID string
	err = tx.QueryRowContext(ctx, `
SELECT turn_id
FROM workspace_agent_turns
WHERE workspace_id = ? AND agent_session_id = ? AND phase != ? AND turn_id != ?
ORDER BY updated_at_unix_ms DESC, turn_id DESC
LIMIT 1
`, workspaceID, agentSessionID, TurnPhaseSettled, turnID).Scan(&conflictingTurnID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read workspace agent session live turns: %w", err)
	}
	return fmt.Errorf("workspace agent session already has live turn %q; cannot start %q", conflictingTurnID, turnID)
}

func mergeTurnTransition(existing Turn, hasExisting bool, transition TurnTransition, phase string, occurred int64, now int64) Turn {
	merged := existing
	if !hasExisting {
		merged = Turn{
			WorkspaceID:     strings.TrimSpace(transition.WorkspaceID),
			AgentSessionID:  strings.TrimSpace(transition.AgentSessionID),
			TurnID:          strings.TrimSpace(transition.TurnID),
			CreatedAtUnixMS: now,
			Origin:          TurnOriginLegacyUnknown,
		}
		if origin := strings.TrimSpace(transition.Origin); origin != "" {
			merged.Origin = origin
		}
		merged.SourceGoalOperationID = strings.TrimSpace(transition.SourceGoalOperationID)
		merged.SourceGoalRevision = transition.SourceGoalRevision
		merged.SourceGoalRepairEpoch = transition.SourceGoalRepairEpoch
	}
	merged.Phase = phase
	merged.CapabilityRefs = normalizeCapabilityReferences(append(
		append([]CapabilityReference(nil), existing.CapabilityRefs...),
		transition.CapabilityRefs...,
	))
	merged.Backfilled = false
	merged.UpdatedAtUnixMS = occurred
	if transition.ErrorMessage != "" || transition.ErrorCode != "" {
		merged.ErrorMessage = strings.TrimSpace(transition.ErrorMessage)
		merged.ErrorCode = strings.TrimSpace(transition.ErrorCode)
	}
	if len(transition.FileChanges) > 0 {
		merged.FileChanges = cloneJSONMap(transition.FileChanges)
	}
	if transition.CompletedCommandKind != "" {
		merged.CompletedCommandKind = strings.TrimSpace(transition.CompletedCommandKind)
		merged.CompletedCommandStatus = strings.TrimSpace(transition.CompletedCommandStatus)
	}
	if transition.FinalAssistantMessageID != "" {
		merged.FinalAssistantMessageID = strings.TrimSpace(transition.FinalAssistantMessageID)
	}
	startedAt := transition.StartedAtUnixMS
	if startedAt <= 0 {
		startedAt = occurred
	}
	if merged.StartedAtUnixMS <= 0 || (startedAt > 0 && startedAt < merged.StartedAtUnixMS) {
		merged.StartedAtUnixMS = startedAt
	}
	if phase == TurnPhaseSettled {
		settledAt := transition.SettledAtUnixMS
		if settledAt <= 0 {
			settledAt = occurred
		}
		merged.SettledAtUnixMS = settledAt
		merged.Outcome = strings.TrimSpace(transition.Outcome)
		if merged.Outcome == "" {
			merged.Outcome = TurnOutcomeCompleted
		}
	} else {
		// Outcome only exists once the turn is settled.
		merged.Outcome = ""
		merged.SettledAtUnixMS = 0
	}
	return merged
}

func isAllowedTurnPhaseTransition(existing string, incoming string) bool {
	if existing == incoming {
		return true
	}
	switch existing {
	case TurnPhaseSubmitted:
		return incoming == TurnPhaseRunning || incoming == TurnPhaseWaiting ||
			incoming == TurnPhaseSettling || incoming == TurnPhaseSettled
	case TurnPhaseRunning:
		return incoming == TurnPhaseWaiting || incoming == TurnPhaseSettling || incoming == TurnPhaseSettled
	case TurnPhaseWaiting:
		return incoming == TurnPhaseRunning || incoming == TurnPhaseSettling || incoming == TurnPhaseSettled
	case TurnPhaseSettling:
		return incoming == TurnPhaseSettled
	default:
		return false
	}
}

func (s *Store) GetTurn(ctx context.Context, workspaceID string, agentSessionID string, turnID string) (Turn, bool, error) {
	if s == nil || s.db == nil {
		return Turn{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	turnID = strings.TrimSpace(turnID)
	if workspaceID == "" || agentSessionID == "" || turnID == "" {
		return Turn{}, false, nil
	}
	row := s.db.QueryRowContext(ctx, agentTurnSelectSQL+`
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, workspaceID, agentSessionID, turnID)
	turn, err := scanAgentTurn(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Turn{}, false, nil
		}
		return Turn{}, false, fmt.Errorf("get workspace agent turn: %w", err)
	}
	return turn, true, nil
}

func (s *Store) ListSessionTurns(ctx context.Context, workspaceID string, agentSessionID string) ([]Turn, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx, agentTurnSelectSQL+`
WHERE workspace_id = ? AND agent_session_id = ?
ORDER BY started_at_unix_ms ASC, turn_id ASC
`, workspaceID, agentSessionID)
	if err != nil {
		return nil, fmt.Errorf("list workspace agent turns: %w", err)
	}
	defer rows.Close()

	turns := make([]Turn, 0)
	for rows.Next() {
		turn, err := scanAgentTurn(rows)
		if err != nil {
			return nil, err
		}
		turns = append(turns, turn)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace agent turns: %w", err)
	}
	return turns, nil
}

// SettleStaleTurns force-settles every turn that is not settled with outcome
// interrupted, clears session active turn pointers, and supersedes pending
// interactions. It runs at daemon startup (protocol v2 rule nine): after a
// daemon restart no provider process survives, so any live turn on disk is a
// lie that must be settled by reconciliation, not guessed lazily at read
// time.
func (s *Store) SettleStaleTurns(ctx context.Context) ([]StaleTurnSettlement, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin workspace agent stale turn settlement: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	rows, err := tx.QueryContext(ctx, `
SELECT t.workspace_id, t.agent_session_id, t.turn_id,
       COALESCE(s.provider, ''), s.session_kind, COALESCE(s.parent_tool_call_id, ''),
       t.started_at_unix_ms
FROM workspace_agent_turns AS t
JOIN workspace_agent_sessions AS s
  ON s.workspace_id = t.workspace_id
 AND s.agent_session_id = t.agent_session_id
WHERE t.phase != ?
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_runtime_operations AS op
    WHERE op.workspace_id = t.workspace_id
      AND op.agent_session_id = t.agent_session_id
      AND (
        op.turn_id = t.turn_id
        OR (
          op.kind = ?
          AND json_extract(op.payload_json, '$.replacementTurnId') = t.turn_id
        )
      )
      AND op.status IN (?, ?)
  )
ORDER BY t.workspace_id ASC, t.agent_session_id ASC, t.turn_id ASC
`, TurnPhaseSettled, RuntimeOperationKindEditRetry,
		RuntimeOperationStatusPrepared, RuntimeOperationStatusLeased)
	if err != nil {
		return nil, fmt.Errorf("list stale workspace agent turns: %w", err)
	}
	settlements := make([]StaleTurnSettlement, 0)
	for rows.Next() {
		var settlement StaleTurnSettlement
		var sessionKind, parentToolCallID string
		if err := rows.Scan(
			&settlement.WorkspaceID,
			&settlement.AgentSessionID,
			&settlement.TurnID,
			&settlement.Provider,
			&sessionKind,
			&parentToolCallID,
			&settlement.StartedAtUnixMS,
		); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan stale workspace agent turn: %w", err)
		}
		settlement.IsChildSession = strings.EqualFold(strings.TrimSpace(sessionKind), SessionKindChild) ||
			strings.TrimSpace(parentToolCallID) != ""
		settlements = append(settlements, settlement)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("iterate stale workspace agent turns: %w", err)
	}
	rows.Close()

	if len(settlements) == 0 {
		if _, err := s.commitTransaction(ctx, tx, "", nil); err != nil {
			return nil, fmt.Errorf("commit empty workspace agent stale turn settlement: %w", err)
		}
		committed = true
		return nil, nil
	}

	now := unixMs(time.Now().UTC())
	for index := range settlements {
		settlements[index].SettledAtUnixMS = now
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turns AS t
SET phase = ?, outcome = ?, settled_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE phase != ?
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_runtime_operations AS op
    WHERE op.workspace_id = t.workspace_id
      AND op.agent_session_id = t.agent_session_id
      AND (
        op.turn_id = t.turn_id
        OR (
          op.kind = ?
          AND json_extract(op.payload_json, '$.replacementTurnId') = t.turn_id
        )
      )
      AND op.status IN (?, ?)
  )
`, TurnPhaseSettled, TurnOutcomeInterrupted, now, now, TurnPhaseSettled,
		RuntimeOperationKindEditRetry,
		RuntimeOperationStatusPrepared, RuntimeOperationStatusLeased); err != nil {
		return nil, fmt.Errorf("settle stale workspace agent turns: %w", err)
	}
	for index := range settlements {
		turn, found, err := getAgentTurnTx(
			ctx,
			tx,
			settlements[index].WorkspaceID,
			settlements[index].AgentSessionID,
			settlements[index].TurnID,
		)
		if err != nil {
			return nil, fmt.Errorf("read settled stale workspace agent turn: %w", err)
		}
		if !found {
			return nil, errors.New("settled stale workspace agent turn disappeared")
		}
		settlements[index].Turn = turn
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions AS s
SET active_turn_id = NULL, updated_at_unix_ms = ?
WHERE active_turn_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_runtime_operations AS op
    WHERE op.workspace_id = s.workspace_id
      AND op.agent_session_id = s.agent_session_id
      AND (
        op.turn_id = s.active_turn_id
        OR (
          op.kind = ?
          AND json_extract(op.payload_json, '$.replacementTurnId') = s.active_turn_id
        )
      )
      AND op.status IN (?, ?)
  )
`, now, RuntimeOperationKindEditRetry,
		RuntimeOperationStatusPrepared, RuntimeOperationStatusLeased); err != nil {
		return nil, fmt.Errorf("clear stale workspace agent session active turns: %w", err)
	}
	pendingInteractions, err := listStalePendingInteractionsTx(ctx, tx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_interactions AS i
SET status = ?, updated_at_unix_ms = ?
WHERE status = ?
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_runtime_operations AS op
    WHERE op.workspace_id = i.workspace_id
      AND op.agent_session_id = i.agent_session_id
      AND (
        op.turn_id = i.turn_id
        OR (
          op.kind = ?
          AND json_extract(op.payload_json, '$.replacementTurnId') = i.turn_id
        )
      )
      AND op.status IN (?, ?)
  )
`, InteractionStatusSuperseded, now, InteractionStatusPending,
		RuntimeOperationKindEditRetry,
		RuntimeOperationStatusPrepared, RuntimeOperationStatusLeased); err != nil {
		return nil, fmt.Errorf("supersede stale workspace agent interactions: %w", err)
	}
	canceledMessages, err := s.cancelStaleTurnToolMessagesTx(ctx, tx, settlements, now)
	if err != nil {
		return nil, err
	}
	notifiedSessions := make(map[string]Message, len(settlements))
	for _, settlement := range settlements {
		key := settlement.WorkspaceID + "\x00" + settlement.AgentSessionID
		if _, exists := notifiedSessions[key]; exists {
			continue
		}
		message, err := insertStaleTurnSystemMessageTx(ctx, tx, settlement, now)
		if err != nil {
			return nil, err
		}
		notifiedSessions[key] = message
	}

	mutations := make([]TransactionMutation, 0, len(settlements)*3+len(pendingInteractions)+len(canceledMessages))
	for _, settlement := range settlements {
		mutations = append(mutations,
			terminalTurnMutation(settlement.WorkspaceID, settlement.AgentSessionID, settlement.TurnID, "settle", now, true),
			transactionMutation(settlement.WorkspaceID, settlement.AgentSessionID, MutationEntitySession, settlement.AgentSessionID, "upsert", now),
		)
	}
	for _, interaction := range pendingInteractions {
		mutations = append(mutations, transactionMutation(
			interaction.WorkspaceID, interaction.AgentSessionID, MutationEntityInteraction,
			interactionMutationEntityID(interaction.TurnID, interaction.RequestID), "supersede", now,
		))
	}
	for _, canceled := range canceledMessages {
		mutations = append(mutations, transactionMutation(
			canceled.workspaceID, canceled.message.AgentSessionID, MutationEntityMessage,
			canceled.message.MessageID, "upsert", int64(canceled.message.Version),
		))
	}
	for key, message := range notifiedSessions {
		parts := strings.SplitN(key, "\x00", 2)
		mutations = append(mutations, transactionMutation(
			parts[0], message.AgentSessionID, MutationEntityMessage,
			message.MessageID, "insert", int64(message.Version),
		))
	}
	delta, err := s.commitTransaction(ctx, tx, "", mutations)
	if err != nil {
		return nil, fmt.Errorf("commit workspace agent stale turn settlement: %w", err)
	}
	committed = true
	for index := range settlements {
		settlements[index].TransactionID = delta.TransactionID
		settlements[index].CommitDelta = delta
	}
	return settlements, nil
}

func listStalePendingInteractionsTx(ctx context.Context, tx *sql.Tx) ([]Interaction, error) {
	rows, err := tx.QueryContext(ctx, `
SELECT i.workspace_id, i.agent_session_id, i.turn_id, i.request_id
FROM workspace_agent_interactions AS i
WHERE i.status = ?
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_runtime_operations AS op
    WHERE op.workspace_id = i.workspace_id
      AND op.agent_session_id = i.agent_session_id
      AND (
        op.turn_id = i.turn_id
        OR (
          op.kind = ?
          AND json_extract(op.payload_json, '$.replacementTurnId') = i.turn_id
        )
      )
      AND op.status IN (?, ?)
  )
ORDER BY i.workspace_id, i.agent_session_id, i.turn_id, i.request_id
`, InteractionStatusPending, RuntimeOperationKindEditRetry,
		RuntimeOperationStatusPrepared, RuntimeOperationStatusLeased)
	if err != nil {
		return nil, fmt.Errorf("list stale workspace agent interactions: %w", err)
	}
	defer rows.Close()
	interactions := make([]Interaction, 0)
	for rows.Next() {
		var interaction Interaction
		if err := rows.Scan(&interaction.WorkspaceID, &interaction.AgentSessionID, &interaction.TurnID, &interaction.RequestID); err != nil {
			return nil, fmt.Errorf("scan stale workspace agent interaction: %w", err)
		}
		interactions = append(interactions, interaction)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate stale workspace agent interactions: %w", err)
	}
	return interactions, nil
}

func (*Store) upsertInteractionTx(
	ctx context.Context,
	tx *sql.Tx,
	upsert InteractionUpsert,
	now int64,
) (Interaction, InteractionTransitionResult, error) {
	workspaceID := strings.TrimSpace(upsert.WorkspaceID)
	agentSessionID := strings.TrimSpace(upsert.AgentSessionID)
	requestID := strings.TrimSpace(upsert.RequestID)
	turnID := strings.TrimSpace(upsert.TurnID)
	kind := strings.TrimSpace(upsert.Kind)
	status := strings.TrimSpace(upsert.Status)
	if workspaceID == "" || agentSessionID == "" || requestID == "" || turnID == "" {
		return Interaction{}, InteractionTransitionConflict, errors.New("workspace id, agent session id, request id, and turn id are required")
	}
	if err := requireSessionForkSourceWritableTx(ctx, tx, workspaceID, agentSessionID); err != nil {
		return Interaction{}, InteractionTransitionConflict, err
	}
	if !isKnownInteractionKind(kind) {
		return Interaction{}, InteractionTransitionConflict, fmt.Errorf("unknown workspace agent interaction kind %q", kind)
	}
	if !isKnownInteractionStatus(status) {
		return Interaction{}, InteractionTransitionConflict, fmt.Errorf("unknown workspace agent interaction status %q", status)
	}

	occurred := upsert.OccurredAtUnixMS
	if occurred <= 0 {
		occurred = now
	}

	existing, hasExisting, err := getAgentInteractionTx(ctx, tx, workspaceID, agentSessionID, turnID, requestID)
	if err != nil {
		return Interaction{}, InteractionTransitionConflict, err
	}
	if hasExisting {
		if !interactionImmutableIdentityEqual(existing, upsert) {
			return existing, InteractionTransitionConflict, nil
		}
		if existing.Status != InteractionStatusPending || status == existing.Status {
			return existing, InteractionTransitionAlreadyApplied, nil
		}
		if status == InteractionStatusPending {
			return existing, InteractionTransitionConflict, nil
		}
	}

	ownerTurn, hasTurn, err := getAgentTurnTx(ctx, tx, workspaceID, agentSessionID, turnID)
	if err != nil {
		return Interaction{}, InteractionTransitionConflict, err
	}
	if !hasTurn {
		return Interaction{}, InteractionTransitionConflict, fmt.Errorf("workspace agent interaction references unknown turn %q", turnID)
	}
	if ownerTurn.Phase == TurnPhaseSettled && status == InteractionStatusPending {
		// A settled turn cannot acquire new actionable work. Treat a late pending
		// provider report as an idempotent stale transition; terminal reports may
		// still be recorded for replay and reconciliation evidence.
		return Interaction{}, InteractionTransitionAlreadyApplied, nil
	}

	inputJSON, err := marshalJSONMap(upsert.Input)
	if err != nil {
		return Interaction{}, InteractionTransitionConflict, fmt.Errorf("encode workspace agent interaction input: %w", err)
	}
	outputJSON, err := marshalJSONMap(upsert.Output)
	if err != nil {
		return Interaction{}, InteractionTransitionConflict, fmt.Errorf("encode workspace agent interaction output: %w", err)
	}
	metadataJSON, err := marshalJSONMap(upsert.Metadata)
	if err != nil {
		return Interaction{}, InteractionTransitionConflict, fmt.Errorf("encode workspace agent interaction metadata: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_interactions (
  workspace_id, agent_session_id, request_id, turn_id, kind, status, tool_name,
  input_json, output_json, metadata_json, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id, turn_id, request_id) DO UPDATE SET
  kind = excluded.kind,
  status = excluded.status,
  tool_name = excluded.tool_name,
  input_json = excluded.input_json,
  output_json = excluded.output_json,
  metadata_json = excluded.metadata_json,
  updated_at_unix_ms = excluded.updated_at_unix_ms
	`, workspaceID, agentSessionID, requestID, turnID, kind, status,
		strings.TrimSpace(upsert.ToolName), inputJSON, outputJSON, metadataJSON,
		occurred, occurred); err != nil {
		return Interaction{}, InteractionTransitionConflict, fmt.Errorf("upsert workspace agent interaction: %w", err)
	}

	stored, ok, err := getAgentInteractionTx(ctx, tx, workspaceID, agentSessionID, turnID, requestID)
	if err != nil {
		return Interaction{}, InteractionTransitionConflict, err
	}
	if !ok {
		return Interaction{}, InteractionTransitionConflict, fmt.Errorf("read upserted workspace agent interaction: %w", sql.ErrNoRows)
	}
	return stored, InteractionTransitionApplied, nil
}

func interactionImmutableIdentityEqual(existing Interaction, incoming InteractionUpsert) bool {
	return existing.Kind == strings.TrimSpace(incoming.Kind) &&
		existing.ToolName == strings.TrimSpace(incoming.ToolName) &&
		jsonMapsEqual(existing.Input, incoming.Input) &&
		jsonMapsEqual(existing.Metadata, incoming.Metadata)
}
