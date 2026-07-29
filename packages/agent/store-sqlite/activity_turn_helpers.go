package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

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
