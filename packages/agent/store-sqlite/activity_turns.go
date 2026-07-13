package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
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
	if err := tx.Commit(); err != nil {
		return Turn{}, false, fmt.Errorf("commit workspace agent turn transition: %w", err)
	}
	committed = true
	return turn, accepted, nil
}

func (s *Store) recordTurnTransitionTx(
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

	fileChangesJSON, err := marshalNullableJSONMap(merged.FileChanges)
	if err != nil {
		return Turn{}, false, fmt.Errorf("encode workspace agent turn file changes: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase, outcome, error_json,
  file_changes_json, completed_command_json, backfilled,
  started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
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
		encodeCompletedCommandJSON(merged.CompletedCommandKind, merged.CompletedCommandStatus),
		merged.StartedAtUnixMS, nullInt64(merged.SettledAtUnixMS),
		merged.CreatedAtUnixMS, merged.UpdatedAtUnixMS); err != nil {
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
		}
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
		if err := tx.Commit(); err != nil {
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
	notifiedSessions := make(map[string]struct{}, len(settlements))
	for _, settlement := range settlements {
		key := settlement.WorkspaceID + "\x00" + settlement.AgentSessionID
		if _, exists := notifiedSessions[key]; exists {
			continue
		}
		notifiedSessions[key] = struct{}{}
		if err := insertStaleTurnSystemMessageTx(ctx, tx, settlement, now); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit workspace agent stale turn settlement: %w", err)
	}
	committed = true
	return settlements, nil
}

func (s *Store) upsertInteractionTx(
	ctx context.Context,
	tx *sql.Tx,
	upsert InteractionUpsert,
	now int64,
) (Interaction, bool, error) {
	workspaceID := strings.TrimSpace(upsert.WorkspaceID)
	agentSessionID := strings.TrimSpace(upsert.AgentSessionID)
	requestID := strings.TrimSpace(upsert.RequestID)
	turnID := strings.TrimSpace(upsert.TurnID)
	kind := strings.TrimSpace(upsert.Kind)
	status := strings.TrimSpace(upsert.Status)
	if workspaceID == "" || agentSessionID == "" || requestID == "" || turnID == "" {
		return Interaction{}, false, errors.New("workspace id, agent session id, request id, and turn id are required")
	}
	if !isKnownInteractionKind(kind) {
		return Interaction{}, false, fmt.Errorf("unknown workspace agent interaction kind %q", kind)
	}
	if !isKnownInteractionStatus(status) {
		return Interaction{}, false, fmt.Errorf("unknown workspace agent interaction status %q", status)
	}

	occurred := upsert.OccurredAtUnixMS
	if occurred <= 0 {
		occurred = now
	}

	existing, hasExisting, err := getAgentInteractionTx(ctx, tx, workspaceID, agentSessionID, turnID, requestID)
	if err != nil {
		return Interaction{}, false, err
	}
	if hasExisting {
		if occurred < existing.UpdatedAtUnixMS {
			return existing, false, nil
		}
		if existing.Status != InteractionStatusPending && status != existing.Status {
			return existing, false, nil
		}
	}

	if _, hasTurn, err := getAgentTurnTx(ctx, tx, workspaceID, agentSessionID, turnID); err != nil {
		return Interaction{}, false, err
	} else if !hasTurn {
		if _, accepted, err := s.recordTurnTransitionTx(ctx, tx, TurnTransition{
			WorkspaceID:      workspaceID,
			AgentSessionID:   agentSessionID,
			TurnID:           turnID,
			Phase:            TurnPhaseWaiting,
			OccurredAtUnixMS: occurred,
		}, now); err != nil {
			return Interaction{}, false, fmt.Errorf("ensure workspace agent turn for interaction: %w", err)
		} else if !accepted {
			return Interaction{}, false, errors.New("workspace agent interaction turn transition was rejected")
		}
	}

	inputJSON, err := marshalJSONMap(upsert.Input)
	if err != nil {
		return Interaction{}, false, fmt.Errorf("encode workspace agent interaction input: %w", err)
	}
	outputJSON, err := marshalJSONMap(upsert.Output)
	if err != nil {
		return Interaction{}, false, fmt.Errorf("encode workspace agent interaction output: %w", err)
	}
	metadataJSON, err := marshalJSONMap(upsert.Metadata)
	if err != nil {
		return Interaction{}, false, fmt.Errorf("encode workspace agent interaction metadata: %w", err)
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
		return Interaction{}, false, fmt.Errorf("upsert workspace agent interaction: %w", err)
	}

	stored, ok, err := getAgentInteractionTx(ctx, tx, workspaceID, agentSessionID, turnID, requestID)
	if err != nil {
		return Interaction{}, false, err
	}
	if !ok {
		return Interaction{}, false, fmt.Errorf("read upserted workspace agent interaction: %w", sql.ErrNoRows)
	}
	return stored, true, nil
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

const agentTurnSelectSQL = `
SELECT workspace_id, agent_session_id, turn_id, phase, outcome, error_json,
       file_changes_json, completed_command_json, backfilled,
       started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_turns`

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

func scanAgentTurn(scanner rowScanner) (Turn, error) {
	var turn Turn
	var outcome sql.NullString
	var errorJSON sql.NullString
	var fileChangesJSON sql.NullString
	var completedCommandJSON sql.NullString
	var settledAt sql.NullInt64
	var backfilled int
	err := scanner.Scan(
		&turn.WorkspaceID,
		&turn.AgentSessionID,
		&turn.TurnID,
		&turn.Phase,
		&outcome,
		&errorJSON,
		&fileChangesJSON,
		&completedCommandJSON,
		&backfilled,
		&turn.StartedAtUnixMS,
		&settledAt,
		&turn.CreatedAtUnixMS,
		&turn.UpdatedAtUnixMS,
	)
	if err != nil {
		return Turn{}, err
	}
	turn.Outcome = strings.TrimSpace(outcome.String)
	turn.Backfilled = backfilled != 0
	turn.SettledAtUnixMS = settledAt.Int64
	if errorJSON.Valid && strings.TrimSpace(errorJSON.String) != "" {
		decoded, err := unmarshalJSONMap(errorJSON.String)
		if err != nil {
			return Turn{}, fmt.Errorf("decode workspace agent turn error: %w", err)
		}
		turn.ErrorMessage, _ = decoded["message"].(string)
		turn.ErrorCode, _ = decoded["code"].(string)
	}
	if fileChangesJSON.Valid && strings.TrimSpace(fileChangesJSON.String) != "" {
		if turn.FileChanges, err = unmarshalJSONMap(fileChangesJSON.String); err != nil {
			return Turn{}, fmt.Errorf("decode workspace agent turn file changes: %w", err)
		}
	}
	if completedCommandJSON.Valid && strings.TrimSpace(completedCommandJSON.String) != "" {
		decoded, err := unmarshalJSONMap(completedCommandJSON.String)
		if err != nil {
			return Turn{}, fmt.Errorf("decode workspace agent turn completed command: %w", err)
		}
		turn.CompletedCommandKind, _ = decoded["kind"].(string)
		turn.CompletedCommandStatus, _ = decoded["status"].(string)
	}
	return turn, nil
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
	switch phase {
	case TurnPhaseSubmitted, TurnPhaseRunning, TurnPhaseWaiting, TurnPhaseSettling, TurnPhaseSettled:
		return true
	default:
		return false
	}
}

func isKnownTurnOutcome(outcome string) bool {
	switch outcome {
	case TurnOutcomeCompleted, TurnOutcomeFailed, TurnOutcomeCanceled, TurnOutcomeInterrupted:
		return true
	default:
		return false
	}
}

func isKnownInteractionKind(kind string) bool {
	switch kind {
	case InteractionKindApproval, InteractionKindQuestion, InteractionKindPlan:
		return true
	default:
		return false
	}
}

func isKnownInteractionStatus(status string) bool {
	switch status {
	case InteractionStatusPending, InteractionStatusAnswered, InteractionStatusSuperseded:
		return true
	default:
		return false
	}
}

func encodeTurnErrorJSON(message string, code string) any {
	message = strings.TrimSpace(message)
	if message == "" {
		return nil
	}
	payload := map[string]any{"message": message}
	if code = strings.TrimSpace(code); code != "" {
		payload["code"] = code
	}
	encoded, err := marshalJSONMap(payload)
	if err != nil {
		return nil
	}
	return encoded
}

func encodeCompletedCommandJSON(kind string, status string) any {
	kind = strings.TrimSpace(kind)
	if kind == "" {
		return nil
	}
	payload := map[string]any{"kind": kind}
	if status = strings.TrimSpace(status); status != "" {
		payload["status"] = status
	}
	encoded, err := marshalJSONMap(payload)
	if err != nil {
		return nil
	}
	return encoded
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
