package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	agentactivityprojection "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/projection"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func (s *SQLiteStore) ReportSessionState(
	ctx context.Context,
	input agentactivitybiz.SessionStateReport,
) (agentactivitybiz.StateReportResult, error) {
	if s == nil || s.db == nil {
		return agentactivitybiz.StateReportResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return agentactivitybiz.StateReportResult{}, errors.New("workspace id and agent session id are required")
	}
	if err := s.ensureWorkspaceExists(ctx, workspaceID); err != nil {
		return agentactivitybiz.StateReportResult{}, err
	}

	now := unixMs(time.Now().UTC())
	if input.OccurredAtUnixMS <= 0 {
		input.OccurredAtUnixMS = now
	}
	accepted, stateApplied, lastEventUnixMS, session, err := s.upsertAgentSession(ctx, input, now)
	if err != nil {
		return agentactivitybiz.StateReportResult{}, err
	}
	return agentactivitybiz.StateReportResult{
		Accepted:        accepted,
		StateApplied:    stateApplied,
		LastEventUnixMS: lastEventUnixMS,
		Session:         session,
	}, nil
}

func (s *SQLiteStore) ReportSessionMessages(
	ctx context.Context,
	input agentactivitybiz.SessionMessageReport,
) (agentactivitybiz.MessageReportResult, error) {
	if s == nil || s.db == nil {
		return agentactivitybiz.MessageReportResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" || len(input.Messages) == 0 {
		return agentactivitybiz.MessageReportResult{}, errors.New("workspace id, agent session id, and messages are required")
	}
	if err := s.ensureWorkspaceExists(ctx, workspaceID); err != nil {
		return agentactivitybiz.MessageReportResult{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return agentactivitybiz.MessageReportResult{}, fmt.Errorf("begin workspace agent message report: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	now := unixMs(time.Now().UTC())
	agentSessionID, err = resolveAgentMessageReportSessionIDTx(ctx, tx, workspaceID, agentSessionID, input.Provider, input.Origin)
	if err != nil {
		return agentactivitybiz.MessageReportResult{}, err
	}
	accepted, _, _, _, err := upsertAgentSessionTx(ctx, tx, agentactivitybiz.SessionStateReport{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Origin:         input.Origin,
		Provider:       input.Provider,
	}, now)
	if err != nil {
		return agentactivitybiz.MessageReportResult{}, err
	}
	if !accepted {
		if err := tx.Commit(); err != nil {
			return agentactivitybiz.MessageReportResult{}, fmt.Errorf("commit ignored workspace agent message report: %w", err)
		}
		committed = true
		return agentactivitybiz.MessageReportResult{}, nil
	}

	result := agentactivitybiz.MessageReportResult{}
	for _, message := range input.Messages {
		message.MessageID = strings.TrimSpace(message.MessageID)
		if message.MessageID == "" {
			continue
		}
		version, err := incrementAgentSessionMessageVersion(ctx, tx, workspaceID, agentSessionID)
		if err != nil {
			return agentactivitybiz.MessageReportResult{}, err
		}
		acceptedMessage, accepted, err := upsertAgentMessageTx(ctx, tx, workspaceID, agentSessionID, version, message, now)
		if err != nil {
			return agentactivitybiz.MessageReportResult{}, err
		}
		if !accepted {
			continue
		}
		result.AcceptedCount++
		result.LatestVersion = version
		result.Messages = append(result.Messages, acceptedMessage)
	}

	if err := tx.Commit(); err != nil {
		return agentactivitybiz.MessageReportResult{}, fmt.Errorf("commit workspace agent message report: %w", err)
	}
	committed = true
	return result, nil
}

func (s *SQLiteStore) GetSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (agentactivitybiz.Session, bool, error) {
	if s == nil || s.db == nil {
		return agentactivitybiz.Session{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return agentactivitybiz.Session{}, false, nil
	}
	row := s.db.QueryRowContext(ctx, `
SELECT workspace_id, agent_session_id, origin, provider, provider_session_id, model,
       settings_json, runtime_context_json, cwd,
       title, status, current_phase, last_error, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, pinned_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, agentSessionID)
	session, err := scanAgentSession(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return agentactivitybiz.Session{}, false, nil
		}
		return agentactivitybiz.Session{}, false, fmt.Errorf("get workspace agent session: %w", err)
	}
	return session, true, nil
}

func (s *SQLiteStore) ListSessions(
	ctx context.Context,
	workspaceID string,
) ([]agentactivitybiz.Session, bool, error) {
	if s == nil || s.db == nil {
		return nil, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil, false, nil
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT workspace_id, agent_session_id, origin, provider, provider_session_id, model,
       settings_json, runtime_context_json, cwd,
       title, status, current_phase, last_error, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, pinned_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_sessions
WHERE workspace_id = ? AND deleted_at_unix_ms = 0
ORDER BY updated_at_unix_ms DESC, agent_session_id ASC
`, workspaceID)
	if err != nil {
		return nil, false, fmt.Errorf("list workspace agent sessions: %w", err)
	}
	defer rows.Close()

	sessions := make([]agentactivitybiz.Session, 0)
	for rows.Next() {
		session, err := scanAgentSession(rows)
		if err != nil {
			return nil, false, err
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("iterate workspace agent sessions: %w", err)
	}
	return sessions, true, nil
}

func (s *SQLiteStore) DeleteSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (bool, error) {
	if s == nil || s.db == nil {
		return false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return false, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin delete workspace agent session: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	now := unixMs(time.Now().UTC())
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET deleted_at_unix_ms = ?,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, now, now, workspaceID, agentSessionID)
	if err != nil {
		return false, fmt.Errorf("delete workspace agent session: %w", err)
	}
	removed, err := rowsWereAffected(result, "delete workspace agent session")
	if err != nil {
		return false, err
	}
	if removed {
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_messages
SET deleted_at_unix_ms = ?,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, now, now, workspaceID, agentSessionID); err != nil {
			return false, fmt.Errorf("delete workspace agent session messages: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit delete workspace agent session: %w", err)
	}
	committed = true
	return removed, nil
}

func (s *SQLiteStore) UpdateSessionPinned(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	pinned bool,
) (agentactivitybiz.Session, bool, error) {
	if s == nil || s.db == nil {
		return agentactivitybiz.Session{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return agentactivitybiz.Session{}, false, nil
	}

	now := unixMs(time.Now().UTC())
	pinnedAtUnixMS := int64(0)
	if pinned {
		pinnedAtUnixMS = now
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET pinned_at_unix_ms = ?,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, pinnedAtUnixMS, now, workspaceID, agentSessionID)
	if err != nil {
		return agentactivitybiz.Session{}, false, fmt.Errorf("update workspace agent session pinned state: %w", err)
	}
	updated, err := rowsWereAffected(result, "update workspace agent session pinned state")
	if err != nil {
		return agentactivitybiz.Session{}, false, err
	}
	if !updated {
		return agentactivitybiz.Session{}, false, nil
	}
	session, ok, err := s.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return agentactivitybiz.Session{}, false, err
	}
	return session, ok, nil
}

func (s *SQLiteStore) ListSessionMessages(
	ctx context.Context,
	input agentactivitybiz.ListSessionMessagesInput,
) (agentactivitybiz.MessagePage, bool, error) {
	if s == nil || s.db == nil {
		return agentactivitybiz.MessagePage{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return agentactivitybiz.MessagePage{}, false, nil
	}
	if _, ok, err := s.GetSession(ctx, workspaceID, agentSessionID); err != nil || !ok {
		return agentactivitybiz.MessagePage{}, ok, err
	}

	queryLimit := input.Limit
	if queryLimit > 0 {
		queryLimit++
	}
	order := input.Order
	if order == "" {
		order = agentactivitybiz.MessageOrderAsc
	}
	var rows *sql.Rows
	var err error
	switch order {
	case agentactivitybiz.MessageOrderDesc:
		if input.BeforeVersion > 0 {
			rows, err = s.db.QueryContext(ctx, `
SELECT id, agent_session_id, message_id, version, turn_id, role, kind, status,
       payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_messages
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
  AND version < ?
ORDER BY version DESC, id DESC
LIMIT ?
`, workspaceID, agentSessionID, input.BeforeVersion, queryLimit)
		} else {
			rows, err = s.db.QueryContext(ctx, `
SELECT id, agent_session_id, message_id, version, turn_id, role, kind, status,
       payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_messages
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
ORDER BY version DESC, id DESC
LIMIT ?
`, workspaceID, agentSessionID, queryLimit)
		}
	case agentactivitybiz.MessageOrderAsc:
		rows, err = s.db.QueryContext(ctx, `
SELECT id, agent_session_id, message_id, version, turn_id, role, kind, status,
       payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_messages
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
  AND version > ?
ORDER BY version ASC, id ASC
LIMIT ?
`, workspaceID, agentSessionID, input.AfterVersion, queryLimit)
	default:
		return agentactivitybiz.MessagePage{}, false, fmt.Errorf("unsupported workspace agent message order: %s", order)
	}
	if err != nil {
		return agentactivitybiz.MessagePage{}, false, fmt.Errorf("list workspace agent messages: %w", err)
	}
	defer rows.Close()

	messages := make([]agentactivitybiz.Message, 0)
	for rows.Next() {
		message, err := scanAgentMessage(rows)
		if err != nil {
			return agentactivitybiz.MessagePage{}, false, err
		}
		messages = append(messages, message)
	}
	if err := rows.Err(); err != nil {
		return agentactivitybiz.MessagePage{}, false, fmt.Errorf("iterate workspace agent messages: %w", err)
	}
	hasMore := false
	if input.Limit > 0 && len(messages) > input.Limit {
		hasMore = true
		messages = messages[:input.Limit]
	}
	latestVersion := input.AfterVersion
	if order == agentactivitybiz.MessageOrderDesc {
		latestVersion = 0
	}
	for _, message := range messages {
		if message.Version > latestVersion {
			latestVersion = message.Version
		}
	}
	return agentactivitybiz.MessagePage{
		AgentSessionID: agentSessionID,
		Messages:       messages,
		LatestVersion:  latestVersion,
		HasMore:        hasMore,
	}, true, nil
}

func (s *SQLiteStore) upsertAgentSession(
	ctx context.Context,
	input agentactivitybiz.SessionStateReport,
	now int64,
) (bool, bool, int64, agentactivitybiz.Session, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, false, 0, agentactivitybiz.Session{}, fmt.Errorf("begin workspace agent session state report: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	accepted, stateApplied, lastEventUnixMS, session, err := upsertAgentSessionTx(ctx, tx, input, now)
	if err != nil {
		return false, false, 0, agentactivitybiz.Session{}, err
	}
	if err := tx.Commit(); err != nil {
		return false, false, 0, agentactivitybiz.Session{}, fmt.Errorf("commit workspace agent session state report: %w", err)
	}
	committed = true
	return accepted, stateApplied, lastEventUnixMS, session, nil
}

func upsertAgentSessionTx(
	ctx context.Context,
	tx *sql.Tx,
	input agentactivitybiz.SessionStateReport,
	now int64,
) (bool, bool, int64, agentactivitybiz.Session, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return false, false, 0, agentactivitybiz.Session{}, nil
	}
	existing, hasExisting, err := getAgentSessionForUpdate(ctx, tx, workspaceID, agentSessionID)
	if err != nil {
		return false, false, 0, agentactivitybiz.Session{}, err
	}
	projected := agentactivityprojection.ProjectSessionState(
		existing,
		hasExisting,
		agentactivityprojection.SessionStateReport{
			WorkspaceID:       workspaceID,
			AgentSessionID:    agentSessionID,
			Origin:            input.Origin,
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
		return false, false, projected.LastEventUnixMS, projectionSessionToBiz(projected.Session), nil
	}
	session := projected.Session
	settingsJSON, err := marshalJSONMap(session.Settings)
	if err != nil {
		return false, false, 0, agentactivitybiz.Session{}, err
	}
	runtimeContextJSON, err := marshalJSONMap(session.RuntimeContext)
	if err != nil {
		return false, false, 0, agentactivitybiz.Session{}, err
	}
	result, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_sessions (
  workspace_id, agent_session_id, origin, provider, provider_session_id, model,
  settings_json, runtime_context_json, cwd,
  title, status, current_phase, last_error, last_event_at_unix_ms, started_at_unix_ms,
  ended_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id) DO UPDATE SET
  origin = excluded.origin,
  provider = excluded.provider,
  provider_session_id = excluded.provider_session_id,
  model = excluded.model,
  settings_json = excluded.settings_json,
  runtime_context_json = excluded.runtime_context_json,
  cwd = excluded.cwd,
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
	`, session.WorkspaceID, session.AgentSessionID, session.Origin, session.Provider,
		session.ProviderSessionID, session.Model, settingsJSON, runtimeContextJSON,
		session.CWD, session.Title,
		session.Status, session.CurrentPhase, session.LastError, session.LastEventUnixMS,
		session.StartedAtUnixMS, session.EndedAtUnixMS, session.CreatedAtUnixMS,
		session.UpdatedAtUnixMS)
	if err != nil {
		return false, false, 0, agentactivitybiz.Session{}, fmt.Errorf("upsert workspace agent session: %w", err)
	}
	accepted, err := rowsWereAffected(result, "upsert workspace agent session")
	if err != nil {
		return false, false, 0, agentactivitybiz.Session{}, err
	}
	return accepted, sessionStateReportApplied(input, projected.Session), projected.LastEventUnixMS, projectionSessionToBiz(projected.Session), nil
}

func getAgentSessionForUpdate(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
) (agentactivityprojection.SessionSnapshot, bool, error) {
	row := tx.QueryRowContext(ctx, `
SELECT workspace_id, agent_session_id, origin, provider, provider_session_id, model,
       settings_json, runtime_context_json, cwd,
       title, status, current_phase, last_error, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, created_at_unix_ms, updated_at_unix_ms,
       deleted_at_unix_ms
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, agentSessionID)
	var session agentactivityprojection.SessionSnapshot
	var settingsJSON string
	var runtimeContextJSON string
	err := row.Scan(
		&session.WorkspaceID,
		&session.AgentSessionID,
		&session.Origin,
		&session.Provider,
		&session.ProviderSessionID,
		&session.Model,
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
	if session.RuntimeContext, err = unmarshalJSONMap(runtimeContextJSON); err != nil {
		return agentactivityprojection.SessionSnapshot{}, false, fmt.Errorf("decode workspace agent session runtime context: %w", err)
	}
	return session, true, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanAgentSession(scanner rowScanner) (agentactivitybiz.Session, error) {
	var session agentactivitybiz.Session
	var settingsJSON string
	var runtimeContextJSON string
	err := scanner.Scan(
		&session.WorkspaceID,
		&session.ID,
		&session.Origin,
		&session.Provider,
		&session.ProviderSessionID,
		&session.Model,
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
		return agentactivitybiz.Session{}, err
	}
	if session.Settings, err = unmarshalJSONMap(settingsJSON); err != nil {
		return agentactivitybiz.Session{}, fmt.Errorf("decode workspace agent session settings: %w", err)
	}
	if session.RuntimeContext, err = unmarshalJSONMap(runtimeContextJSON); err != nil {
		return agentactivitybiz.Session{}, fmt.Errorf("decode workspace agent session runtime context: %w", err)
	}
	return session, nil
}

func marshalJSONMap(payload map[string]any) (string, error) {
	if len(payload) == 0 {
		return "{}", nil
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encode workspace agent session json: %w", err)
	}
	return string(data), nil
}

func unmarshalJSONMap(input string) (map[string]any, error) {
	if strings.TrimSpace(input) == "" {
		return nil, nil
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(input), &payload); err != nil {
		return nil, err
	}
	if len(payload) == 0 {
		return nil, nil
	}
	return payload, nil
}

func cloneJSONMap(payload map[string]any) map[string]any {
	if len(payload) == 0 {
		return nil
	}
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		out[key] = value
	}
	return out
}
