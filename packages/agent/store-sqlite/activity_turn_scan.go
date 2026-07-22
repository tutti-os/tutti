package storesqlite

import (
	"database/sql"
	"fmt"
	"strings"
)

const agentTurnSelectSQL = `
SELECT workspace_id, agent_session_id, turn_id, phase, outcome, error_json,
       file_changes_json, completed_command_json, backfilled,
       started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms,
       turn_origin, COALESCE(source_goal_operation_id, ''), COALESCE(source_goal_revision, 0),
       COALESCE(source_goal_repair_epoch, 0),
       root_provider_turn_id, root_provider_turn_phase, root_provider_turn_outcome,
       root_provider_turn_error_json, root_provider_turn_completed_command_json,
       root_provider_turn_updated_at_unix_ms,
       COALESCE(parent_turn_id, ''), COALESCE(relation, '')
FROM workspace_agent_turns`

func scanAgentTurn(scanner rowScanner) (Turn, error) {
	var turn Turn
	var outcome sql.NullString
	var errorJSON sql.NullString
	var fileChangesJSON sql.NullString
	var completedCommandJSON sql.NullString
	var settledAt sql.NullInt64
	var rootProviderTurnID, rootProviderTurnPhase, rootProviderTurnOutcome sql.NullString
	var rootProviderTurnErrorJSON, rootProviderTurnCompletedCommandJSON sql.NullString
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
		&turn.Origin,
		&turn.SourceGoalOperationID,
		&turn.SourceGoalRevision,
		&turn.SourceGoalRepairEpoch,
		&rootProviderTurnID,
		&rootProviderTurnPhase,
		&rootProviderTurnOutcome,
		&rootProviderTurnErrorJSON,
		&rootProviderTurnCompletedCommandJSON,
		&turn.RootProviderTurnUpdatedAtUnixMS,
		&turn.ParentTurnID,
		&turn.Relation,
	)
	if err != nil {
		return Turn{}, err
	}
	turn.Outcome = strings.TrimSpace(outcome.String)
	turn.Backfilled = backfilled != 0
	turn.SettledAtUnixMS = settledAt.Int64
	turn.RootProviderTurnID = strings.TrimSpace(rootProviderTurnID.String)
	turn.RootProviderTurnPhase = strings.TrimSpace(rootProviderTurnPhase.String)
	turn.RootProviderTurnOutcome = strings.TrimSpace(rootProviderTurnOutcome.String)
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
		turn.FinalAssistantMessageID, _ = decoded["finalAssistantMessageId"].(string)
		turn.FinalAssistantMessageResolved, _ = decoded["finalAssistantMessageResolved"].(bool)
	}
	if rootProviderTurnErrorJSON.Valid && strings.TrimSpace(rootProviderTurnErrorJSON.String) != "" {
		decoded, err := unmarshalJSONMap(rootProviderTurnErrorJSON.String)
		if err != nil {
			return Turn{}, fmt.Errorf("decode workspace agent root provider turn error: %w", err)
		}
		turn.RootProviderTurnErrorMessage, _ = decoded["message"].(string)
		turn.RootProviderTurnErrorCode, _ = decoded["code"].(string)
	}
	if rootProviderTurnCompletedCommandJSON.Valid && strings.TrimSpace(rootProviderTurnCompletedCommandJSON.String) != "" {
		decoded, err := unmarshalJSONMap(rootProviderTurnCompletedCommandJSON.String)
		if err != nil {
			return Turn{}, fmt.Errorf("decode workspace agent root provider turn completed command: %w", err)
		}
		turn.RootProviderTurnCompletedCommandKind, _ = decoded["kind"].(string)
		turn.RootProviderTurnCompletedCommandStatus, _ = decoded["status"].(string)
	}
	return turn, nil
}
