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

// UpsertInteraction records an interaction status transition for an existing
// Turn. It never manufactures the owning Turn: provider-initiated prompts must
// report a provider_initiated Turn and the interaction together through
// ReportActivityState so both entities commit atomically.
// Pending interactions are independent entities; a new request never
// supersedes an unrelated pending request.
// Answered/superseded are terminal; a terminal row rejects regressions to
// pending (accepted=false) so replays stay idempotent.
func (s *Store) UpsertInteraction(ctx context.Context, upsert InteractionUpsert) (Interaction, InteractionTransitionResult, error) {
	if s == nil || s.db == nil {
		return Interaction{}, InteractionTransitionConflict, errors.New("workspace database is not initialized")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Interaction{}, InteractionTransitionConflict, fmt.Errorf("begin workspace agent interaction upsert: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	interaction, result, err := s.upsertInteractionTx(ctx, tx, upsert, unixMs(time.Now().UTC()))
	if err != nil {
		return Interaction{}, InteractionTransitionConflict, err
	}
	mutations := []TransactionMutation{}
	if result == InteractionTransitionApplied {
		mutations = append(mutations, transactionMutation(
			interaction.WorkspaceID, interaction.AgentSessionID, MutationEntityInteraction,
			interactionMutationEntityID(interaction.TurnID, interaction.RequestID), "upsert", interaction.UpdatedAtUnixMS,
		))
	}
	if _, err := s.commitTransaction(ctx, tx, upsert.WorkspaceID, mutations); err != nil {
		return Interaction{}, InteractionTransitionConflict, fmt.Errorf("commit workspace agent interaction upsert: %w", err)
	}
	committed = true
	return interaction, result, nil
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

func isKnownInteractionKind(kind string) bool {
	return canonical.IsKnownInteractionKind(kind)
}

func isKnownInteractionStatus(status string) bool {
	return canonical.IsKnownInteractionStatus(status)
}
