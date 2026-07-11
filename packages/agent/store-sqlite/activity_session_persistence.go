package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	agentactivityprojection "github.com/tutti-os/tutti/packages/agent/daemon/activity/projection"
)

func (s *Store) upsertAgentSessionTx(
	ctx context.Context,
	tx *sql.Tx,
	input SessionStateReport,
	now int64,
) (bool, bool, int64, Session, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return false, false, 0, Session{}, nil
	}
	existing, hasExisting, err := getAgentSessionForUpdate(ctx, tx, workspaceID, agentSessionID)
	if err != nil {
		return false, false, 0, Session{}, err
	}
	projected := agentactivityprojection.ProjectSessionState(
		existing,
		hasExisting,
		agentactivityprojection.SessionStateReport{
			WorkspaceID:       workspaceID,
			AgentSessionID:    agentSessionID,
			Origin:            input.Origin,
			UserID:            input.UserID,
			AgentTargetID:     input.AgentTargetID,
			Provider:          input.Provider,
			ProviderSessionID: input.ProviderSessionID,
			Model:             input.Model,
			Settings:          cloneJSONMap(input.Settings),
			RuntimeContext:    cloneJSONMap(input.RuntimeContext),
			CWD:               input.Cwd,
			Title:             input.Title,
			Status:            input.Status,
			CurrentPhase:      input.CurrentPhase,
			LastError:         input.LastError,
			OccurredAtUnixMS:  input.OccurredAtUnixMS,
			StartedAtUnixMS:   input.StartedAtUnixMS,
			EndedAtUnixMS:     input.EndedAtUnixMS,
		},
		now,
	)
	if !projected.Accepted {
		return false, false, projected.LastEventUnixMS, projectionSessionToDTO(projected.Session), nil
	}
	session := projected.Session
	settingsJSON, err := marshalJSONMap(session.Settings)
	if err != nil {
		return false, false, 0, Session{}, err
	}
	runtimeContextJSON, err := marshalJSONMap(session.RuntimeContext)
	if err != nil {
		return false, false, 0, Session{}, err
	}
	railSection, err := s.resolveAgentSessionRailSectionTx(
		ctx,
		tx,
		workspaceID,
		agentSessionID,
		hasExisting,
		existing.CWD,
		session.CWD,
		session.RuntimeContext,
	)
	if err != nil {
		return false, false, 0, Session{}, err
	}
	result, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_sessions (
  workspace_id, agent_session_id, origin, user_id, agent_target_id, provider, provider_session_id, model,
  settings_json, runtime_context_json, cwd, rail_section_kind, rail_project_path, rail_section_key,
  title, status, current_phase, last_error, last_event_at_unix_ms, started_at_unix_ms,
  ended_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id) DO UPDATE SET
  origin = excluded.origin,
  user_id = excluded.user_id,
  agent_target_id = excluded.agent_target_id,
  provider = excluded.provider,
  provider_session_id = excluded.provider_session_id,
  model = excluded.model,
  settings_json = excluded.settings_json,
  runtime_context_json = excluded.runtime_context_json,
  cwd = excluded.cwd,
  rail_section_kind = excluded.rail_section_kind,
  rail_project_path = excluded.rail_project_path,
  rail_section_key = excluded.rail_section_key,
  title = excluded.title,
  status = excluded.status,
  current_phase = excluded.current_phase,
  last_error = excluded.last_error,
  last_event_at_unix_ms = excluded.last_event_at_unix_ms,
  started_at_unix_ms = excluded.started_at_unix_ms,
  ended_at_unix_ms = excluded.ended_at_unix_ms,
  deleted_at_unix_ms = 0,
  updated_at_unix_ms = excluded.updated_at_unix_ms
WHERE workspace_agent_sessions.deleted_at_unix_ms = 0
`, session.WorkspaceID, session.AgentSessionID, session.Origin, session.UserID, nullString(session.AgentTargetID), session.Provider,
		session.ProviderSessionID, session.Model, settingsJSON, runtimeContextJSON,
		session.CWD, railSection.Kind, railSection.ProjectPath, railSection.Key, session.Title,
		session.Status, session.CurrentPhase, session.LastError, session.LastEventUnixMS,
		session.StartedAtUnixMS, session.EndedAtUnixMS, session.CreatedAtUnixMS,
		session.UpdatedAtUnixMS)
	if err != nil {
		return false, false, 0, Session{}, fmt.Errorf("upsert workspace agent session: %w", err)
	}
	accepted, err := rowsWereAffected(result, "upsert workspace agent session")
	if err != nil {
		return false, false, 0, Session{}, err
	}
	return accepted, sessionStateReportApplied(input, projected.Session), projected.LastEventUnixMS, projectionSessionToDTO(projected.Session), nil
}

func getAgentSessionForUpdate(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
) (agentactivityprojection.SessionSnapshot, bool, error) {
	row := tx.QueryRowContext(ctx, `
SELECT workspace_id, agent_session_id, origin, agent_target_id, provider, provider_session_id, model,
       user_id, settings_json, runtime_context_json, cwd,
       title, status, current_phase, last_error, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, created_at_unix_ms, updated_at_unix_ms,
       deleted_at_unix_ms
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, agentSessionID)
	var session agentactivityprojection.SessionSnapshot
	var agentTargetID sql.NullString
	var settingsJSON string
	var runtimeContextJSON string
	err := row.Scan(
		&session.WorkspaceID,
		&session.AgentSessionID,
		&session.Origin,
		&agentTargetID,
		&session.Provider,
		&session.ProviderSessionID,
		&session.Model,
		&session.UserID,
		&settingsJSON,
		&runtimeContextJSON,
		&session.CWD,
		&session.Title,
		&session.Status,
		&session.CurrentPhase,
		&session.LastError,
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
	session.AgentTargetID = strings.TrimSpace(agentTargetID.String)
	if session.RuntimeContext, err = unmarshalJSONMap(runtimeContextJSON); err != nil {
		return agentactivityprojection.SessionSnapshot{}, false, fmt.Errorf("decode workspace agent session runtime context: %w", err)
	}
	return session, true, nil
}

func scanAgentSession(scanner rowScanner) (Session, error) {
	var session Session
	var agentTargetID sql.NullString
	var settingsJSON string
	var runtimeContextJSON string
	err := scanner.Scan(
		&session.WorkspaceID,
		&session.ID,
		&session.Origin,
		&agentTargetID,
		&session.Provider,
		&session.ProviderSessionID,
		&session.Model,
		&session.UserID,
		&settingsJSON,
		&runtimeContextJSON,
		&session.Cwd,
		&session.Title,
		&session.Status,
		&session.CurrentPhase,
		&session.LastError,
		&session.MessageVersion,
		&session.LastEventUnixMS,
		&session.StartedAtUnixMS,
		&session.EndedAtUnixMS,
		&session.PinnedAtUnixMS,
		&session.CreatedAtUnixMS,
		&session.UpdatedAtUnixMS,
	)
	if err != nil {
		return Session{}, err
	}
	if session.Settings, err = unmarshalJSONMap(settingsJSON); err != nil {
		return Session{}, fmt.Errorf("decode workspace agent session settings: %w", err)
	}
	session.AgentTargetID = strings.TrimSpace(agentTargetID.String)
	if session.RuntimeContext, err = unmarshalJSONMap(runtimeContextJSON); err != nil {
		return Session{}, fmt.Errorf("decode workspace agent session runtime context: %w", err)
	}
	return session, nil
}
