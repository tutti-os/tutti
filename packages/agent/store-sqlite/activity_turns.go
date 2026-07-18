package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

// RecordTurnTransition upserts one turn phase transition and keeps the
// owning session's active_turn_id reference in sync: a live phase points the
// session at this turn, a settled phase clears the pointer (only if it still
// points at this turn). A turn that is already settled is terminal; later
// transitions are rejected (accepted=false) so cancel races and replays stay
// idempotent.
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
		mutations = append(mutations,
			transactionMutation(turn.WorkspaceID, turn.AgentSessionID, MutationEntityTurn, turn.TurnID, "upsert", turn.UpdatedAtUnixMS),
			transactionMutation(turn.WorkspaceID, turn.AgentSessionID, MutationEntitySession, turn.AgentSessionID, "upsert", turn.UpdatedAtUnixMS),
		)
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
	if workspaceID == "" || agentSessionID == "" || turnID == "" {
		return Turn{}, false, errors.New("workspace id, agent session id, and turn id are required")
	}
	if !isKnownTurnPhase(phase) {
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
	if hasExisting && existing.Phase == TurnPhaseSettled && !existing.Backfilled {
		// Terminal: reject silently so replays are idempotent. Backfilled
		// placeholder rows stay writable so live reports can enrich them.
		return existing, false, nil
	}
	if hasExisting && !existing.Backfilled {
		if occurred < existing.UpdatedAtUnixMS || !isAllowedTurnPhaseTransition(existing.Phase, phase) {
			return existing, false, nil
		}
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
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase, outcome, error_json,
  file_changes_json, completed_command_json, backfilled,
  started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms,
  turn_origin, source_goal_operation_id, source_goal_revision, source_goal_repair_epoch
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id, turn_id) DO UPDATE SET
  phase = excluded.phase,
  outcome = excluded.outcome,
  error_json = excluded.error_json,
  file_changes_json = excluded.file_changes_json,
  completed_command_json = excluded.completed_command_json,
  backfilled = 0,
  started_at_unix_ms = excluded.started_at_unix_ms,
  settled_at_unix_ms = excluded.settled_at_unix_ms,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, workspaceID, agentSessionID, turnID, merged.Phase, nullString(merged.Outcome),
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

	stored, ok, err := getAgentTurnTx(ctx, tx, workspaceID, agentSessionID, turnID)
	if err != nil {
		return Turn{}, false, err
	}
	if !ok {
		return Turn{}, false, fmt.Errorf("read recorded workspace agent turn: %w", sql.ErrNoRows)
	}
	return stored, true, nil
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
	merged.Backfilled = false
	merged.UpdatedAtUnixMS = occurred
	if transition.ErrorMessage != "" {
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
SELECT t.workspace_id, t.agent_session_id, t.turn_id
FROM workspace_agent_turns AS t
WHERE t.phase != ?
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_runtime_operations AS op
    WHERE op.workspace_id = t.workspace_id
      AND op.agent_session_id = t.agent_session_id
      AND op.turn_id = t.turn_id
      AND op.status IN (?, ?)
  )
ORDER BY workspace_id ASC, agent_session_id ASC, turn_id ASC
`, TurnPhaseSettled, RuntimeOperationStatusPrepared, RuntimeOperationStatusLeased)
	if err != nil {
		return nil, fmt.Errorf("list stale workspace agent turns: %w", err)
	}
	settlements := make([]StaleTurnSettlement, 0)
	for rows.Next() {
		var settlement StaleTurnSettlement
		if err := rows.Scan(&settlement.WorkspaceID, &settlement.AgentSessionID, &settlement.TurnID); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan stale workspace agent turn: %w", err)
		}
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
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turns AS t
SET phase = ?, outcome = ?, settled_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE phase != ?
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_runtime_operations AS op
    WHERE op.workspace_id = t.workspace_id
      AND op.agent_session_id = t.agent_session_id
      AND op.turn_id = t.turn_id
      AND op.status IN (?, ?)
  )
`, TurnPhaseSettled, TurnOutcomeInterrupted, now, now, TurnPhaseSettled,
		RuntimeOperationStatusPrepared, RuntimeOperationStatusLeased); err != nil {
		return nil, fmt.Errorf("settle stale workspace agent turns: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions AS s
SET active_turn_id = NULL, updated_at_unix_ms = ?
WHERE active_turn_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_runtime_operations AS op
    WHERE op.workspace_id = s.workspace_id
      AND op.agent_session_id = s.agent_session_id
      AND op.turn_id = s.active_turn_id
      AND op.status IN (?, ?)
  )
`, now, RuntimeOperationStatusPrepared, RuntimeOperationStatusLeased); err != nil {
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
      AND op.turn_id = i.turn_id
      AND op.status IN (?, ?)
  )
`, InteractionStatusSuperseded, now, InteractionStatusPending,
		RuntimeOperationStatusPrepared, RuntimeOperationStatusLeased); err != nil {
		return nil, fmt.Errorf("supersede stale workspace agent interactions: %w", err)
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

	mutations := make([]TransactionMutation, 0, len(settlements)*3+len(pendingInteractions))
	for _, settlement := range settlements {
		mutations = append(mutations,
			transactionMutation(settlement.WorkspaceID, settlement.AgentSessionID, MutationEntityTurn, settlement.TurnID, "settle", now),
			transactionMutation(settlement.WorkspaceID, settlement.AgentSessionID, MutationEntitySession, settlement.AgentSessionID, "upsert", now),
		)
	}
	for _, interaction := range pendingInteractions {
		mutations = append(mutations, transactionMutation(
			interaction.WorkspaceID, interaction.AgentSessionID, MutationEntityInteraction,
			interactionMutationEntityID(interaction.TurnID, interaction.RequestID), "supersede", now,
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
      AND op.turn_id = i.turn_id
      AND op.status IN (?, ?)
  )
ORDER BY i.workspace_id, i.agent_session_id, i.turn_id, i.request_id
`, InteractionStatusPending, RuntimeOperationStatusPrepared, RuntimeOperationStatusLeased)
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

func (s *Store) ListSessionInteractions(ctx context.Context, input ListSessionInteractionsInput) ([]Interaction, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return nil, nil
	}
	query := agentInteractionSelectSQL + `
WHERE workspace_id = ? AND agent_session_id = ?`
	args := []any{workspaceID, agentSessionID}
	if status := strings.TrimSpace(input.Status); status != "" {
		query += ` AND status = ?`
		args = append(args, status)
	}
	query += `
ORDER BY created_at_unix_ms ASC, request_id ASC`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list workspace agent interactions: %w", err)
	}
	defer rows.Close()

	interactions := make([]Interaction, 0)
	for rows.Next() {
		interaction, err := scanAgentInteraction(rows)
		if err != nil {
			return nil, err
		}
		interactions = append(interactions, interaction)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace agent interactions: %w", err)
	}
	return interactions, nil
}

const agentInteractionSelectSQL = `
SELECT workspace_id, agent_session_id, request_id, turn_id, kind, status, tool_name,
       input_json, output_json, metadata_json, created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_interactions`

func getAgentTurnTx(ctx context.Context, tx *sql.Tx, workspaceID string, agentSessionID string, turnID string) (Turn, bool, error) {
	row := tx.QueryRowContext(ctx, agentTurnSelectSQL+`
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, workspaceID, agentSessionID, turnID)
	turn, err := scanAgentTurn(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Turn{}, false, nil
		}
		return Turn{}, false, fmt.Errorf("get workspace agent turn for update: %w", err)
	}
	return turn, true, nil
}

func getAgentInteractionTx(ctx context.Context, tx *sql.Tx, workspaceID string, agentSessionID string, turnID string, requestID string) (Interaction, bool, error) {
	row := tx.QueryRowContext(ctx, agentInteractionSelectSQL+`
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ? AND request_id = ?
`, workspaceID, agentSessionID, turnID, requestID)
	interaction, err := scanAgentInteraction(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Interaction{}, false, nil
		}
		return Interaction{}, false, fmt.Errorf("get workspace agent interaction for update: %w", err)
	}
	return interaction, true, nil
}

func scanAgentInteraction(scanner rowScanner) (Interaction, error) {
	var interaction Interaction
	var inputJSON string
	var outputJSON string
	var metadataJSON string
	err := scanner.Scan(
		&interaction.WorkspaceID,
		&interaction.AgentSessionID,
		&interaction.RequestID,
		&interaction.TurnID,
		&interaction.Kind,
		&interaction.Status,
		&interaction.ToolName,
		&inputJSON,
		&outputJSON,
		&metadataJSON,
		&interaction.CreatedAtUnixMS,
		&interaction.UpdatedAtUnixMS,
	)
	if err != nil {
		return Interaction{}, err
	}
	if interaction.Input, err = unmarshalJSONMap(inputJSON); err != nil {
		return Interaction{}, fmt.Errorf("decode workspace agent interaction input: %w", err)
	}
	if interaction.Output, err = unmarshalJSONMap(outputJSON); err != nil {
		return Interaction{}, fmt.Errorf("decode workspace agent interaction output: %w", err)
	}
	if interaction.Metadata, err = unmarshalJSONMap(metadataJSON); err != nil {
		return Interaction{}, fmt.Errorf("decode workspace agent interaction metadata: %w", err)
	}
	return interaction, nil
}

func isKnownTurnPhase(phase string) bool {
	return canonical.IsKnownTurnPhase(phase)
}

func isKnownTurnOutcome(outcome string) bool {
	return canonical.IsKnownTurnOutcome(outcome)
}

func isKnownTurnOrigin(origin string) bool {
	return canonical.IsKnownTurnOrigin(origin)
}

func isKnownInteractionKind(kind string) bool {
	return canonical.IsKnownInteractionKind(kind)
}

func isKnownInteractionStatus(status string) bool {
	return canonical.IsKnownInteractionStatus(status)
}

func marshalNullableJSONMap(value map[string]any) (any, error) {
	if len(value) == 0 {
		return nil, nil
	}
	return marshalJSONMap(value)
}

func nullInt64(value int64) any {
	if value <= 0 {
		return nil
	}
	return value
}

func nullInt64WhenAbsent(value int64, present bool) any {
	if !present {
		return nil
	}
	return value
}
