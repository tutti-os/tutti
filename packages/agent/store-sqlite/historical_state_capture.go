package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func (s *Store) CaptureHistoricalSessionGraph(
	ctx context.Context,
	workspaceID string,
	rootSessionID string,
) (HistoricalSessionGraph, error) {
	if s == nil || s.db == nil {
		return HistoricalSessionGraph{}, errors.New("agent database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	rootSessionID = strings.TrimSpace(rootSessionID)
	if workspaceID == "" || rootSessionID == "" {
		return HistoricalSessionGraph{}, errors.New(
			"workspace and root Agent Session ids are required",
		)
	}
	sessionIDs, err := historicalStrings(ctx, s.db, `
SELECT agent_session_id
FROM workspace_agent_sessions
WHERE workspace_id = ? AND deleted_at_unix_ms = 0
  AND (agent_session_id = ? OR root_agent_session_id = ?)
ORDER BY CASE WHEN agent_session_id = ? THEN 0 ELSE 1 END, agent_session_id
`, workspaceID, rootSessionID, rootSessionID, rootSessionID)
	if err != nil {
		return HistoricalSessionGraph{}, fmt.Errorf(
			"list historical Agent Session graph: %w",
			err,
		)
	}
	if len(sessionIDs) == 0 || sessionIDs[0] != rootSessionID {
		return HistoricalSessionGraph{}, errors.New(
			"historical root Agent Session is missing",
		)
	}
	graph := HistoricalSessionGraph{
		RootSessionID: rootSessionID,
		Sessions:      []HistoricalSession{},
	}
	for _, sessionID := range sessionIDs {
		session, err := s.captureHistoricalSession(ctx, workspaceID, sessionID)
		if err != nil {
			return HistoricalSessionGraph{}, err
		}
		graph.Sessions = append(graph.Sessions, session)
	}
	return graph, nil
}

func (s *Store) captureHistoricalSession(
	ctx context.Context,
	workspaceID string,
	sessionID string,
) (HistoricalSession, error) {
	var session HistoricalSession
	var settingsJSON, internalRuntimeContextJSON, activeTurnID sql.NullString
	err := s.db.QueryRowContext(ctx, `
SELECT agent_session_id, session_kind, COALESCE(root_agent_session_id, ''),
       COALESCE(root_turn_id, ''), COALESCE(parent_agent_session_id, ''),
       COALESCE(parent_turn_id, ''), COALESCE(parent_tool_call_id, ''), origin,
       COALESCE(agent_target_id, ''), provider, provider_session_id, model,
       settings_json, internal_runtime_context_json, cwd,
       rail_section_kind, rail_project_path, rail_section_key, title,
       COALESCE(active_turn_id, ''),
       CASE WHEN pinned_at_unix_ms > 0 THEN 1 ELSE 0 END
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, sessionID).Scan(
		&session.ID, &session.Kind, &session.RootSessionID, &session.RootTurnID,
		&session.ParentSessionID, &session.ParentTurnID, &session.ParentToolCallID,
		&session.Origin, &session.AgentTargetID, &session.Provider,
		&session.ProviderSessionID, &session.Model, &settingsJSON,
		&internalRuntimeContextJSON, &session.Cwd, &session.RailSectionKind,
		&session.RailProjectPath, &session.RailSectionKey, &session.Title,
		&activeTurnID, &session.Pinned,
	)
	if err != nil {
		return HistoricalSession{}, fmt.Errorf(
			"capture historical Session %s: %w",
			sessionID,
			err,
		)
	}
	session.ActiveTurnID = activeTurnID.String
	if err := decodeHistoricalObject(settingsJSON.String, &session.Settings); err != nil {
		return HistoricalSession{}, err
	}
	var internalRuntimeContext map[string]any
	if err := decodeHistoricalObject(
		internalRuntimeContextJSON.String,
		&internalRuntimeContext,
	); err != nil {
		return HistoricalSession{}, err
	}
	if checkpoint, exists := internalRuntimeContext[canonical.ProviderResumeCheckpointRuntimeContextKey]; exists {
		typed, ok := checkpoint.(map[string]any)
		if !ok {
			return HistoricalSession{}, fmt.Errorf(
				"capture historical Session %s: provider resume checkpoint must be an object",
				sessionID,
			)
		}
		session.ProviderResumeCheckpoint = typed
	}
	session.Turns = []HistoricalTurn{}
	session.Messages = []HistoricalMessage{}
	session.Interactions = []HistoricalInteraction{}
	if err := s.captureHistoricalTurns(ctx, workspaceID, sessionID, &session); err != nil {
		return HistoricalSession{}, err
	}
	if err := s.captureHistoricalMessages(ctx, workspaceID, sessionID, &session); err != nil {
		return HistoricalSession{}, err
	}
	if err := s.captureHistoricalInteractions(ctx, workspaceID, sessionID, &session); err != nil {
		return HistoricalSession{}, err
	}
	if err := s.captureHistoricalGoal(ctx, workspaceID, sessionID, &session); err != nil {
		return HistoricalSession{}, err
	}
	return session, nil
}

func (s *Store) captureHistoricalTurns(
	ctx context.Context,
	workspaceID, sessionID string,
	session *HistoricalSession,
) error {
	rows, err := s.db.QueryContext(ctx, `
SELECT turn_id, COALESCE(identity_anchor_turn_id, ''), phase, COALESCE(outcome, ''), COALESCE(error_json, '{}'),
       COALESCE(file_changes_json, '{}'), COALESCE(completed_command_json, '{}'),
       turn_origin, COALESCE(source_goal_operation_id, ''),
       COALESCE(source_goal_revision, 0), COALESCE(source_goal_repair_epoch, 0),
       COALESCE(root_provider_turn_id, ''), capability_refs_json
FROM workspace_agent_turns
WHERE workspace_id = ? AND agent_session_id = ?
ORDER BY COALESCE((
  SELECT turn_sequence
  FROM workspace_agent_turn_sequences
  WHERE workspace_id = workspace_agent_turns.workspace_id
    AND agent_session_id = workspace_agent_turns.agent_session_id
    AND turn_id = workspace_agent_turns.turn_id
), 9223372036854775807), created_at_unix_ms, turn_id
`, workspaceID, sessionID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var turn HistoricalTurn
		var errorJSON, filesJSON, commandJSON, capabilitiesJSON string
		if err := rows.Scan(
			&turn.ID, &turn.IdentityAnchorTurnID, &turn.Phase, &turn.Outcome, &errorJSON, &filesJSON,
			&commandJSON, &turn.Origin, &turn.SourceGoalOperationID,
			&turn.SourceGoalRevision, &turn.SourceGoalRepairEpoch,
			&turn.RootProviderTurnID, &capabilitiesJSON,
		); err != nil {
			return err
		}
		if err := decodeHistoricalObject(errorJSON, &turn.Error); err != nil {
			return err
		}
		if err := decodeHistoricalObject(filesJSON, &turn.FileChanges); err != nil {
			return err
		}
		if err := decodeHistoricalObject(commandJSON, &turn.CompletedCommand); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(capabilitiesJSON), &turn.CapabilityRefs); err != nil {
			return err
		}
		if turn.CapabilityRefs == nil {
			turn.CapabilityRefs = []CapabilityReference{}
		}
		session.Turns = append(session.Turns, turn)
	}
	return rows.Err()
}

func (s *Store) captureHistoricalMessages(
	ctx context.Context,
	workspaceID, sessionID string,
	session *HistoricalSession,
) error {
	rows, err := s.db.QueryContext(ctx, `
SELECT message_id, COALESCE(turn_id, ''), role, kind, status,
       COALESCE(semantics_json, '{}'), payload_json
FROM workspace_agent_messages
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
ORDER BY version, message_id
`, workspaceID, sessionID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var message HistoricalMessage
		var semanticsJSON, payloadJSON string
		if err := rows.Scan(
			&message.ID, &message.TurnID, &message.Role, &message.Kind,
			&message.Status, &semanticsJSON, &payloadJSON,
		); err != nil {
			return err
		}
		if err := decodeHistoricalObject(semanticsJSON, &message.Semantics); err != nil {
			return err
		}
		if err := decodeHistoricalObject(payloadJSON, &message.Payload); err != nil {
			return err
		}
		session.Messages = append(session.Messages, message)
	}
	return rows.Err()
}

func (s *Store) captureHistoricalInteractions(
	ctx context.Context,
	workspaceID, sessionID string,
	session *HistoricalSession,
) error {
	rows, err := s.db.QueryContext(ctx, `
SELECT request_id, turn_id, kind, status, tool_name,
       input_json, output_json, metadata_json
FROM workspace_agent_interactions
WHERE workspace_id = ? AND agent_session_id = ?
ORDER BY COALESCE((
  SELECT turn_sequence
  FROM workspace_agent_turn_sequences
  WHERE workspace_id = workspace_agent_interactions.workspace_id
    AND agent_session_id = workspace_agent_interactions.agent_session_id
    AND turn_id = workspace_agent_interactions.turn_id
), 9223372036854775807), request_id
`, workspaceID, sessionID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var interaction HistoricalInteraction
		var inputJSON, outputJSON, metadataJSON string
		if err := rows.Scan(
			&interaction.RequestID, &interaction.TurnID, &interaction.Kind,
			&interaction.Status, &interaction.ToolName, &inputJSON, &outputJSON,
			&metadataJSON,
		); err != nil {
			return err
		}
		if err := decodeHistoricalObject(inputJSON, &interaction.Input); err != nil {
			return err
		}
		if err := decodeHistoricalObject(outputJSON, &interaction.Output); err != nil {
			return err
		}
		if err := decodeHistoricalObject(metadataJSON, &interaction.Metadata); err != nil {
			return err
		}
		session.Interactions = append(session.Interactions, interaction)
	}
	return rows.Err()
}

func (s *Store) captureHistoricalGoal(
	ctx context.Context,
	workspaceID, sessionID string,
	session *HistoricalSession,
) error {
	var desiredJSON, observedJSON, evidenceJSON string
	var goal HistoricalGoal
	err := s.db.QueryRowContext(ctx, `
SELECT COALESCE(desired_json, '{}'), COALESCE(observed_json, '{}'),
       revision, tombstoned, sync_status,
       COALESCE(pending_operation_id, ''),
       COALESCE(last_evidence_json, '{}'), COALESCE(last_error, '')
FROM workspace_agent_session_goals
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, sessionID).Scan(
		&desiredJSON, &observedJSON, &goal.Revision, &goal.Tombstoned,
		&goal.SyncStatus, &goal.PendingOperationID, &evidenceJSON, &goal.LastError,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := decodeHistoricalObject(desiredJSON, &goal.Desired); err != nil {
		return err
	}
	if err := decodeHistoricalObject(observedJSON, &goal.Observed); err != nil {
		return err
	}
	if err := decodeHistoricalObject(evidenceJSON, &goal.LastEvidence); err != nil {
		return err
	}
	session.Goal = &goal
	return nil
}

func decodeHistoricalObject(raw string, destination *map[string]any) error {
	if strings.TrimSpace(raw) == "" || strings.TrimSpace(raw) == "null" {
		*destination = map[string]any{}
		return nil
	}
	if err := json.Unmarshal([]byte(raw), destination); err != nil {
		return err
	}
	if *destination == nil {
		*destination = map[string]any{}
	}
	return nil
}

func historicalStrings(
	ctx context.Context,
	db *sql.DB,
	query string,
	args ...any,
) ([]string, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []string
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		result = append(result, strings.TrimSpace(value))
	}
	return result, rows.Err()
}
