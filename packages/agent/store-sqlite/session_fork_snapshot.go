package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

func loadSessionForkSnapshotTx(
	ctx context.Context,
	tx *sql.Tx,
	session Session,
	throughSequence int64,
	frozenBoundaryMessageID int64,
) (sessionForkSnapshot, error) {
	snapshot := sessionForkSnapshot{Version: 1, Session: session}
	rows, err := tx.QueryContext(ctx, `
SELECT turn_id, turn_sequence
FROM workspace_agent_turn_sequences
WHERE workspace_id = ? AND agent_session_id = ? AND turn_sequence <= ?
ORDER BY turn_sequence
`, session.WorkspaceID, session.ID, throughSequence)
	if err != nil {
		return snapshot, fmt.Errorf("read session fork turns: %w", err)
	}
	type turnBoundary struct {
		turnID   string
		sequence int64
	}
	var boundaries []turnBoundary
	for rows.Next() {
		var boundary turnBoundary
		if err := rows.Scan(&boundary.turnID, &boundary.sequence); err != nil {
			rows.Close()
			return snapshot, err
		}
		boundaries = append(boundaries, boundary)
	}
	if err := rows.Close(); err != nil {
		return snapshot, err
	}
	for _, boundary := range boundaries {
		turn, found, err := getAgentTurnTx(ctx, tx, session.WorkspaceID, session.ID, boundary.turnID)
		if err != nil {
			return snapshot, err
		}
		if !found {
			return snapshot, newSessionForkBoundaryError(
				SessionForkBoundaryReasonPrefixTurnMissing,
				fmt.Sprintf(
					"turn sequence %d references missing turn %q",
					boundary.sequence,
					boundary.turnID,
				),
			)
		}
		snapshot.Turns = append(snapshot.Turns, sessionForkTurnSnapshot{Sequence: boundary.sequence, Turn: turn})
	}
	boundaryMessageID := frozenBoundaryMessageID
	if boundaryMessageID <= 0 {
		if err := tx.QueryRowContext(ctx, `
SELECT COALESCE(MAX(message.id), 0)
FROM workspace_agent_messages message
JOIN workspace_agent_turn_sequences sequence
  ON sequence.workspace_id = message.workspace_id
 AND sequence.agent_session_id = message.agent_session_id
 AND sequence.turn_id = message.turn_id
WHERE message.workspace_id = ?
  AND message.agent_session_id = ?
  AND message.deleted_at_unix_ms = 0
  AND sequence.turn_sequence <= ?
`, session.WorkspaceID, session.ID, throughSequence).Scan(&boundaryMessageID); err != nil {
			return snapshot, fmt.Errorf("read session fork message boundary: %w", err)
		}
	}
	snapshot.BoundaryMessageID = boundaryMessageID
	messageRows, err := tx.QueryContext(ctx, `
SELECT message.id, message.agent_session_id, message.message_id, message.version,
       message.turn_id, message.role, message.kind, message.status,
       message.semantics_json, message.payload_json, message.occurred_at_unix_ms,
       message.started_at_unix_ms, message.completed_at_unix_ms,
       message.created_at_unix_ms, message.updated_at_unix_ms
FROM workspace_agent_messages message
WHERE message.workspace_id = ? AND message.agent_session_id = ?
  AND message.deleted_at_unix_ms = 0
  AND (
    (
      message.turn_id IS NULL
      AND message.kind = 'session_audit'
      AND message.id <= ?
    )
    OR EXISTS (
      SELECT 1
      FROM workspace_agent_turn_sequences sequence
      WHERE sequence.workspace_id = message.workspace_id
        AND sequence.agent_session_id = message.agent_session_id
        AND sequence.turn_id = message.turn_id
        AND sequence.turn_sequence <= ?
    )
  )
ORDER BY message.id
`, session.WorkspaceID, session.ID, boundaryMessageID, throughSequence)
	if err != nil {
		return snapshot, fmt.Errorf("read session fork messages: %w", err)
	}
	for messageRows.Next() {
		message, err := scanAgentMessage(messageRows)
		if err != nil {
			messageRows.Close()
			return snapshot, err
		}
		snapshot.Messages = append(snapshot.Messages, message)
	}
	if err := messageRows.Close(); err != nil {
		return snapshot, err
	}
	interactionRows, err := tx.QueryContext(ctx, `
SELECT interaction.workspace_id, interaction.agent_session_id,
       interaction.request_id, interaction.turn_id, interaction.kind,
       interaction.status, interaction.tool_name, interaction.input_json,
       interaction.output_json, interaction.metadata_json,
       interaction.created_at_unix_ms, interaction.updated_at_unix_ms
FROM workspace_agent_interactions interaction
JOIN workspace_agent_turn_sequences sequence
  ON sequence.workspace_id = interaction.workspace_id
 AND sequence.agent_session_id = interaction.agent_session_id
 AND sequence.turn_id = interaction.turn_id
WHERE interaction.workspace_id = ?
  AND interaction.agent_session_id = ?
  AND sequence.turn_sequence <= ?
ORDER BY sequence.turn_sequence, interaction.created_at_unix_ms,
         interaction.request_id
`, session.WorkspaceID, session.ID, throughSequence)
	if err != nil {
		return snapshot, fmt.Errorf("read session fork interactions: %w", err)
	}
	for interactionRows.Next() {
		interaction, err := scanAgentInteraction(interactionRows)
		if err != nil {
			interactionRows.Close()
			return snapshot, err
		}
		snapshot.Interactions = append(snapshot.Interactions, interaction)
	}
	if err := interactionRows.Close(); err != nil {
		return snapshot, err
	}
	return snapshot, nil
}

func getSessionForkSourceTx(ctx context.Context, tx *sql.Tx, workspaceID, sessionID string) (Session, bool, error) {
	row := tx.QueryRowContext(ctx, `
SELECT workspace_id, agent_session_id, session_kind, root_agent_session_id, root_turn_id,
       parent_agent_session_id, parent_turn_id, parent_tool_call_id,
       origin, agent_target_id, provider, provider_session_id, model,
       user_id, settings_json, session_metadata_json, internal_runtime_context_json, cwd,
       rail_section_key, title, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, pinned_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms, active_turn_id
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, sessionID)
	session, err := scanAgentSession(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, false, nil
	}
	if err != nil {
		return Session{}, false, err
	}
	var railKind, railPath string
	if err := tx.QueryRowContext(ctx, `
SELECT rail_section_kind, rail_project_path
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, sessionID).Scan(&railKind, &railPath); err != nil {
		return Session{}, false, err
	}
	session.RailSectionKind, session.RailProjectPath = railKind, railPath
	return session, true, nil
}

func insertForkedSessionTx(ctx context.Context, tx *sql.Tx, op SessionForkOperation, snapshot sessionForkSnapshot, now int64) error {
	target := sessionForkResultSession(op, snapshot, now)
	metadataJSON, err := marshalSessionMetadata(target.Metadata, target.Capabilities)
	if err != nil {
		return err
	}
	settingsJSON, err := marshalJSONMap(target.Settings)
	if err != nil {
		return err
	}
	runtimeContextJSON, err := marshalJSONMap(target.InternalRuntimeContext)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_agent_sessions (
  workspace_id, agent_session_id, session_kind,
  root_agent_session_id, root_turn_id, parent_agent_session_id, parent_turn_id, parent_tool_call_id,
  origin, user_id, agent_target_id, provider, provider_session_id, model,
  settings_json, session_metadata_json, internal_runtime_context_json,
  cwd, rail_section_kind, rail_project_path, rail_section_key,
  title, message_version, last_event_at_unix_ms, started_at_unix_ms,
  ended_at_unix_ms, pinned_at_unix_ms, deleted_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms, active_turn_id
) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0, 0, ?, ?, NULL)
`, target.WorkspaceID, target.ID, target.Kind,
		target.Origin, target.UserID, nullString(target.AgentTargetID),
		target.Provider, target.ProviderSessionID, target.Model, settingsJSON, metadataJSON,
		runtimeContextJSON, target.Cwd, target.RailSectionKind, target.RailProjectPath,
		target.RailSectionKey, target.Title, target.LastEventUnixMS, target.StartedAtUnixMS,
		target.CreatedAtUnixMS, target.UpdatedAtUnixMS)
	if err != nil {
		return fmt.Errorf("insert forked workspace agent session: %w", err)
	}
	return nil
}

func materializeSessionForkSnapshot(snapshot sessionForkSnapshot) sessionForkSnapshot {
	if snapshot.Version != 1 {
		return snapshot
	}
	if strings.TrimSpace(snapshot.TargetCwd) == "" {
		snapshot.TargetCwd = strings.TrimSpace(snapshot.Session.Cwd)
	}
	if snapshot.TargetRuntimeContext == nil {
		snapshot.TargetRuntimeContext = cloneJSONMap(
			snapshot.Session.InternalRuntimeContext,
		)
	}
	if snapshot.TargetSettings == nil {
		snapshot.TargetSettings = cloneJSONMap(snapshot.Session.Settings)
	}
	return snapshot
}

func sessionForkResultSession(
	op SessionForkOperation,
	snapshot sessionForkSnapshot,
	committedAtUnixMS int64,
) Session {
	source := snapshot.Session
	targetTitle := strings.TrimSpace(snapshot.TargetTitle)
	if targetTitle == "" {
		// Compatibility for snapshots prepared before Fork titles were
		// materialized independently from the source title.
		targetTitle = strings.TrimSpace(source.Title)
	}
	metadata := source.Metadata
	metadata.Imported, metadata.Usage, metadata.Goal = false, nil, nil
	targetSettings := snapshot.TargetSettings
	if targetSettings == nil {
		targetSettings = source.Settings
	}
	return Session{
		ID:                     op.TargetAgentSessionID,
		WorkspaceID:            op.WorkspaceID,
		Kind:                   SessionKindRoot,
		Origin:                 "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
		UserID:                 source.UserID,
		AgentTargetID:          source.AgentTargetID,
		Provider:               source.Provider,
		ProviderSessionID:      op.TargetProviderSessionID,
		Model:                  sessionForkTargetModel(source.Model, targetSettings),
		Settings:               cloneJSONMap(targetSettings),
		Metadata:               metadata,
		InternalRuntimeContext: cloneJSONMap(snapshot.TargetRuntimeContext),
		Cwd:                    strings.TrimSpace(snapshot.TargetCwd),
		RailSectionKind:        source.RailSectionKind,
		RailProjectPath:        source.RailProjectPath,
		RailSectionKey:         source.RailSectionKey,
		Title:                  targetTitle,
		MessageVersion:         uint64(len(snapshot.Messages)),
		LastEventUnixMS:        committedAtUnixMS,
		StartedAtUnixMS:        committedAtUnixMS,
		CreatedAtUnixMS:        committedAtUnixMS,
		UpdatedAtUnixMS:        committedAtUnixMS,
	}
}

func nextSessionForkTargetTitleTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	sourceAgentSessionID string,
	sourceTitle string,
) (string, error) {
	sourceTitle = strings.TrimSpace(sourceTitle)
	if sourceTitle == "" {
		return "", nil
	}

	familyRootSessionID := sourceAgentSessionID
	if err := tx.QueryRowContext(ctx, `
WITH RECURSIVE ancestors(agent_session_id) AS (
  SELECT ?
  UNION
  SELECT fork.source_agent_session_id
  FROM workspace_agent_session_forks fork
  JOIN ancestors
    ON ancestors.agent_session_id = fork.target_agent_session_id
  WHERE fork.workspace_id = ?
)
SELECT ancestor.agent_session_id
FROM ancestors ancestor
WHERE NOT EXISTS (
  SELECT 1
  FROM workspace_agent_session_forks parent_fork
  WHERE parent_fork.workspace_id = ?
    AND parent_fork.target_agent_session_id = ancestor.agent_session_id
)
LIMIT 1
`, sourceAgentSessionID, workspaceID, workspaceID).Scan(&familyRootSessionID); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return "", fmt.Errorf("resolve session fork title family root: %w", err)
		}
		familyRootSessionID = sourceAgentSessionID
	}

	baseTitle := sourceTitle
	var familyRootTitle string
	if err := tx.QueryRowContext(ctx, `
SELECT title
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, familyRootSessionID).Scan(&familyRootTitle); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return "", fmt.Errorf("read session fork title family root: %w", err)
		}
	} else if familyRootTitle = strings.TrimSpace(familyRootTitle); familyRootTitle != "" {
		baseTitle = familyRootTitle
	}

	var familyForkCount int64
	if err := tx.QueryRowContext(ctx, `
WITH RECURSIVE family(agent_session_id) AS (
  SELECT ?
  UNION
  SELECT operation.target_agent_session_id
  FROM workspace_agent_session_fork_operations operation
  JOIN family
    ON family.agent_session_id = operation.source_agent_session_id
  WHERE operation.workspace_id = ?
    AND operation.status <> ?
)
SELECT COUNT(*)
FROM workspace_agent_session_fork_operations operation
JOIN family
  ON family.agent_session_id = operation.source_agent_session_id
WHERE operation.workspace_id = ?
  AND operation.status <> ?
`, familyRootSessionID, workspaceID, SessionForkStatusFailed, workspaceID,
		SessionForkStatusFailed).Scan(&familyForkCount); err != nil {
		return "", fmt.Errorf("count session fork title family: %w", err)
	}
	return fmt.Sprintf("%s (%d)", baseTitle, familyForkCount+2), nil
}

func sessionForkResultLineage(
	op SessionForkOperation,
	committedAtUnixMS int64,
) SessionForkLineage {
	return SessionForkLineage{
		WorkspaceID:          op.WorkspaceID,
		TargetAgentSessionID: op.TargetAgentSessionID,
		SourceAgentSessionID: op.SourceAgentSessionID,
		SourceTurnID:         op.SourceTurnID,
		TargetTurnID:         op.TargetTurnID,
		OperationID:          op.OperationID,
		ForkedAtUnixMS:       committedAtUnixMS,
	}
}

func sessionForkTargetModel(sourceModel string, targetSettings map[string]any) string {
	if model, ok := targetSettings["model"].(string); ok {
		return strings.TrimSpace(model)
	}
	return sourceModel
}

func insertForkedTurnTx(ctx context.Context, tx *sql.Tx, workspaceID, sessionID string, turn Turn) error {
	capabilityRefsJSON, err := json.Marshal(turn.CapabilityRefs)
	if err != nil {
		return err
	}
	fileChangesJSON, err := marshalNullableJSONMap(turn.FileChanges)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, identity_anchor_turn_id, capability_refs_json, phase, outcome,
  error_json, file_changes_json, completed_command_json, backfilled,
  started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms,
  turn_origin, source_goal_operation_id, source_goal_revision, source_goal_repair_epoch,
  root_provider_turn_id, provider_turn_binding_json,
  root_provider_turn_phase, root_provider_turn_outcome,
  root_provider_turn_error_json, root_provider_turn_completed_command_json,
  root_provider_turn_updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
`, workspaceID, sessionID, turn.TurnID, nullString(turn.IdentityAnchorTurnID), string(capabilityRefsJSON), turn.Phase,
		nullString(turn.Outcome), encodeTurnErrorJSON(turn.ErrorMessage, turn.ErrorCode),
		fileChangesJSON,
		encodeCompletedCommandJSON(turn.CompletedCommandKind, turn.CompletedCommandStatus, finalAssistantWatermark{
			MessageID: turn.FinalAssistantMessageID, Resolved: turn.FinalAssistantMessageResolved,
		}),
		turn.Backfilled, turn.StartedAtUnixMS, nullInt64(turn.SettledAtUnixMS),
		turn.CreatedAtUnixMS, turn.UpdatedAtUnixMS, turn.Origin,
		nullString(turn.RootProviderTurnID),
		string(firstNonEmptyJSON(turn.ProviderTurnBindingJSON)),
		nullString(turn.RootProviderTurnPhase),
		nullString(turn.RootProviderTurnOutcome),
		encodeTurnErrorJSON(turn.RootProviderTurnErrorMessage, turn.RootProviderTurnErrorCode),
		encodeCompletedCommandJSON(turn.RootProviderTurnCompletedCommandKind, turn.RootProviderTurnCompletedCommandStatus, finalAssistantWatermark{}),
		turn.RootProviderTurnUpdatedAtUnixMS)
	if err != nil {
		return fmt.Errorf("insert forked workspace agent turn: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turn_sequences
SET provenance = 'fork_clone_verified'
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
`, workspaceID, sessionID, turn.TurnID); err != nil {
		return fmt.Errorf("verify forked workspace agent turn sequence: %w", err)
	}
	return nil
}

func insertForkedMessageTx(ctx context.Context, tx *sql.Tx, workspaceID, sessionID string, message Message, version uint64) error {
	payloadJSON, err := marshalJSONMap(message.Payload)
	if err != nil {
		return err
	}
	semanticsJSON, err := json.Marshal(message.Semantics)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, turn_id, role, kind, status,
  semantics_json, payload_json, occurred_at_unix_ms, started_at_unix_ms,
  completed_at_unix_ms, deleted_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
`, workspaceID, sessionID, message.MessageID, version, nullString(message.TurnID),
		message.Role, message.Kind, message.Status, string(semanticsJSON), payloadJSON,
		message.OccurredAtUnixMS, message.StartedAtUnixMS, message.CompletedAtUnixMS,
		message.CreatedAtUnixMS, message.UpdatedAtUnixMS)
	if err != nil {
		return fmt.Errorf("insert forked workspace agent message: %w", err)
	}
	return nil
}

func insertForkedInteractionTx(ctx context.Context, tx *sql.Tx, workspaceID, sessionID string, interaction Interaction) error {
	inputJSON, err := marshalJSONMap(interaction.Input)
	if err != nil {
		return err
	}
	outputJSON, err := marshalJSONMap(interaction.Output)
	if err != nil {
		return err
	}
	metadataJSON, err := marshalJSONMap(interaction.Metadata)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_agent_interactions (
  workspace_id, agent_session_id, request_id, turn_id, kind, status,
  tool_name, input_json, output_json, metadata_json,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, workspaceID, sessionID, interaction.RequestID, interaction.TurnID,
		interaction.Kind, interaction.Status, interaction.ToolName, inputJSON,
		outputJSON, metadataJSON, interaction.CreatedAtUnixMS, interaction.UpdatedAtUnixMS)
	if err != nil {
		return fmt.Errorf("insert forked workspace agent interaction: %w", err)
	}
	return nil
}
