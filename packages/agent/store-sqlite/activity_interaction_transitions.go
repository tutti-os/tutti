package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

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
