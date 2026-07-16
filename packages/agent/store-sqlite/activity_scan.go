package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	agentactivityprojection "github.com/tutti-os/tutti/packages/agent/daemon/activity/projection"
)

func getAgentSessionForUpdate(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
) (agentactivityprojection.SessionSnapshot, bool, error) {
	row := tx.QueryRowContext(ctx, `
SELECT workspace_id, agent_session_id, session_kind, root_agent_session_id, root_turn_id,
       parent_agent_session_id, parent_turn_id, parent_tool_call_id,
       origin, agent_target_id, provider, provider_session_id, model,
       user_id, settings_json, session_metadata_json, internal_runtime_context_json, cwd,
	       title, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, created_at_unix_ms, updated_at_unix_ms,
       deleted_at_unix_ms
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, agentSessionID)
	var session agentactivityprojection.SessionSnapshot
	var rootAgentSessionID, rootTurnID sql.NullString
	var parentAgentSessionID, parentTurnID, parentToolCallID sql.NullString
	var agentTargetID sql.NullString
	var settingsJSON string
	var metadataJSON, internalRuntimeContextJSON string
	err := row.Scan(
		&session.WorkspaceID,
		&session.AgentSessionID,
		&session.Kind,
		&rootAgentSessionID,
		&rootTurnID,
		&parentAgentSessionID,
		&parentTurnID,
		&parentToolCallID,
		&session.Origin,
		&agentTargetID,
		&session.Provider,
		&session.ProviderSessionID,
		&session.Model,
		&session.UserID,
		&settingsJSON,
		&metadataJSON,
		&internalRuntimeContextJSON,
		&session.CWD,
		&session.Title,
		&session.MessageVersion,
		&session.LastEventUnixMS,
		&session.StartedAtUnixMS,
		&session.EndedAtUnixMS,
		&session.CreatedAtUnixMS,
		&session.UpdatedAtUnixMS,
		&session.DeletedAtUnixMS,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return agentactivityprojection.SessionSnapshot{}, false, nil
		}
		return agentactivityprojection.SessionSnapshot{}, false, fmt.Errorf("get workspace agent session for update: %w", err)
	}
	if session.Settings, err = unmarshalJSONMap(settingsJSON); err != nil {
		return agentactivityprojection.SessionSnapshot{}, false, fmt.Errorf("decode workspace agent session settings: %w", err)
	}
	session.RootAgentSessionID = strings.TrimSpace(rootAgentSessionID.String)
	session.RootTurnID = strings.TrimSpace(rootTurnID.String)
	session.ParentAgentSessionID = strings.TrimSpace(parentAgentSessionID.String)
	session.ParentTurnID = strings.TrimSpace(parentTurnID.String)
	session.ParentToolCallID = strings.TrimSpace(parentToolCallID.String)
	session.AgentTargetID = strings.TrimSpace(agentTargetID.String)
	metadata, err := unmarshalSessionMetadata(metadataJSON)
	if err != nil {
		return agentactivityprojection.SessionSnapshot{}, false, fmt.Errorf("decode workspace agent session metadata: %w", err)
	}
	internal, err := unmarshalJSONMap(internalRuntimeContextJSON)
	if err != nil {
		return agentactivityprojection.SessionSnapshot{}, false, fmt.Errorf("decode workspace agent internal runtime context: %w", err)
	}
	if session.RuntimeContext, err = joinSessionRuntimeContext(metadata, internal); err != nil {
		return agentactivityprojection.SessionSnapshot{}, false, fmt.Errorf("join workspace agent runtime context: %w", err)
	}
	return session, true, nil
}

func scanAgentSession(scanner rowScanner) (Session, error) {
	session, err := scanAgentSessionWithTrailingValues(scanner)
	return session, err
}

func scanAgentSessionWithSortTime(scanner rowScanner) (Session, int64, error) {
	var sortTimeUnixMS int64
	session, err := scanAgentSessionWithTrailingValues(scanner, &sortTimeUnixMS)
	return session, sortTimeUnixMS, err
}

func scanAgentSessionWithTrailingValues(
	scanner rowScanner,
	trailingValues ...any,
) (Session, error) {
	var session Session
	var agentTargetID sql.NullString
	var activeTurnID sql.NullString
	var rootAgentSessionID, rootTurnID sql.NullString
	var parentAgentSessionID, parentTurnID, parentToolCallID sql.NullString
	var settingsJSON string
	var metadataJSON, internalRuntimeContextJSON string
	destinations := []any{
		&session.WorkspaceID,
		&session.ID,
		&session.Kind,
		&rootAgentSessionID,
		&rootTurnID,
		&parentAgentSessionID,
		&parentTurnID,
		&parentToolCallID,
		&session.Origin,
		&agentTargetID,
		&session.Provider,
		&session.ProviderSessionID,
		&session.Model,
		&session.UserID,
		&settingsJSON,
		&metadataJSON,
		&internalRuntimeContextJSON,
		&session.Cwd,
		&session.RailSectionKey,
		&session.Title,
		&session.MessageVersion,
		&session.LastEventUnixMS,
		&session.StartedAtUnixMS,
		&session.EndedAtUnixMS,
		&session.PinnedAtUnixMS,
		&session.CreatedAtUnixMS,
		&session.UpdatedAtUnixMS,
		&activeTurnID,
	}
	destinations = append(destinations, trailingValues...)
	err := scanner.Scan(destinations...)
	if err != nil {
		return Session{}, err
	}
	if session.Settings, err = unmarshalJSONMap(settingsJSON); err != nil {
		return Session{}, fmt.Errorf("decode workspace agent session settings: %w", err)
	}
	session.AgentTargetID = strings.TrimSpace(agentTargetID.String)
	session.ActiveTurnID = strings.TrimSpace(activeTurnID.String)
	session.RootAgentSessionID = strings.TrimSpace(rootAgentSessionID.String)
	session.RootTurnID = strings.TrimSpace(rootTurnID.String)
	session.ParentAgentSessionID = strings.TrimSpace(parentAgentSessionID.String)
	session.ParentTurnID = strings.TrimSpace(parentTurnID.String)
	session.ParentToolCallID = strings.TrimSpace(parentToolCallID.String)
	if session.Metadata, err = unmarshalSessionMetadata(metadataJSON); err != nil {
		return Session{}, fmt.Errorf("decode workspace agent session metadata: %w", err)
	}
	if session.InternalRuntimeContext, err = unmarshalJSONMap(internalRuntimeContextJSON); err != nil {
		return Session{}, fmt.Errorf("decode workspace agent internal runtime context: %w", err)
	}
	return session, nil
}
