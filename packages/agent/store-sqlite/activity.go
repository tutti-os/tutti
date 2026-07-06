package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	agentactivityprojection "github.com/tutti-os/tutti/packages/agent/daemon/activity/projection"
)

func (s *Store) ReportSessionState(
	ctx context.Context,
	input SessionStateReport,
) (StateReportResult, error) {
	if s == nil || s.db == nil {
		return StateReportResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return StateReportResult{}, errors.New("workspace id and agent session id are required")
	}
	if err := s.ensureWorkspaceExists(ctx, workspaceID); err != nil {
		return StateReportResult{}, err
	}

	now := unixMs(time.Now().UTC())
	if input.OccurredAtUnixMS <= 0 {
		input.OccurredAtUnixMS = now
	}
	accepted, stateApplied, lastEventUnixMS, session, err := s.upsertAgentSession(ctx, input, now)
	if err != nil {
		return StateReportResult{}, err
	}
	return StateReportResult{
		Accepted:        accepted,
		StateApplied:    stateApplied,
		LastEventUnixMS: lastEventUnixMS,
		Session:         session,
	}, nil
}

func (s *Store) ReportSessionMessages(
	ctx context.Context,
	input SessionMessageReport,
) (MessageReportResult, error) {
	if s == nil || s.db == nil {
		return MessageReportResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" || len(input.Messages) == 0 {
		return MessageReportResult{}, errors.New("workspace id, agent session id, and messages are required")
	}
	if err := s.ensureWorkspaceExists(ctx, workspaceID); err != nil {
		return MessageReportResult{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MessageReportResult{}, fmt.Errorf("begin workspace agent message report: %w", err)
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
		return MessageReportResult{}, err
	}
	accepted, _, _, _, err := s.upsertAgentSessionTx(ctx, tx, SessionStateReport{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Origin:         input.Origin,
		Provider:       input.Provider,
	}, now)
	if err != nil {
		return MessageReportResult{}, err
	}
	if !accepted {
		if err := tx.Commit(); err != nil {
			return MessageReportResult{}, fmt.Errorf("commit ignored workspace agent message report: %w", err)
		}
		committed = true
		return MessageReportResult{}, nil
	}

	result := MessageReportResult{}
	for _, message := range input.Messages {
		message.MessageID = strings.TrimSpace(message.MessageID)
		if message.MessageID == "" {
			continue
		}
		version, err := incrementAgentSessionMessageVersion(ctx, tx, workspaceID, agentSessionID)
		if err != nil {
			return MessageReportResult{}, err
		}
		acceptedMessage, accepted, err := upsertAgentMessageTx(ctx, tx, workspaceID, agentSessionID, version, message, now)
		if err != nil {
			return MessageReportResult{}, err
		}
		if !accepted {
			continue
		}
		result.AcceptedCount++
		result.LatestVersion = version
		result.Messages = append(result.Messages, acceptedMessage)
	}

	if err := tx.Commit(); err != nil {
		return MessageReportResult{}, fmt.Errorf("commit workspace agent message report: %w", err)
	}
	committed = true
	return result, nil
}

func (s *Store) GetSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (Session, bool, error) {
	if s == nil || s.db == nil {
		return Session{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return Session{}, false, nil
	}
	row := s.db.QueryRowContext(ctx, `
SELECT workspace_id, agent_session_id, origin, agent_target_id, provider, provider_session_id, model,
       user_id, settings_json, runtime_context_json, cwd,
       title, status, current_phase, last_error, message_version, last_event_at_unix_ms,
       started_at_unix_ms, ended_at_unix_ms, pinned_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, agentSessionID)
	session, err := scanAgentSession(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Session{}, false, nil
		}
		return Session{}, false, fmt.Errorf("get workspace agent session: %w", err)
	}
	return session, true, nil
}

func (s *Store) ListSessions(
	ctx context.Context,
	workspaceID string,
) ([]Session, bool, error) {
	if s == nil || s.db == nil {
		return nil, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil, false, nil
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT workspace_id, agent_session_id, origin, agent_target_id, provider, provider_session_id, model,
       user_id, settings_json, runtime_context_json, cwd,
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

	sessions := make([]Session, 0)
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

func (s *Store) DeleteSession(
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

func (s *Store) ClearSessions(
	ctx context.Context,
	workspaceID string,
) (ClearSessionsResult, error) {
	if s == nil || s.db == nil {
		return ClearSessionsResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return ClearSessionsResult{}, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("begin clear workspace agent sessions: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	result, err := s.ClearSessionsTx(ctx, tx, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("commit clear workspace agent sessions: %w", err)
	}
	committed = true
	return result, nil
}

// ClearSessionsTx hard-deletes a workspace's sessions and messages within
// the caller's transaction. Hosts that delete a workspace of their own and
// need the agent-row cascade to be atomic with that deletion should run
// both through one transaction via this method; the caller owns commit and
// rollback.
func (s *Store) ClearSessionsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
) (ClearSessionsResult, error) {
	if s == nil || tx == nil {
		return ClearSessionsResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return ClearSessionsResult{}, nil
	}

	removedSessionIDs, err := listAgentSessionIDsTx(ctx, tx, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, err
	}
	messageResult, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_messages
WHERE workspace_id = ?
`, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent messages: %w", err)
	}
	sessionResult, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_sessions
WHERE workspace_id = ?
`, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent sessions: %w", err)
	}
	removedMessages, err := messageResult.RowsAffected()
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent messages rows affected: %w", err)
	}
	removedSessions, err := sessionResult.RowsAffected()
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent sessions rows affected: %w", err)
	}
	return ClearSessionsResult{
		RemovedMessages:   int(removedMessages),
		RemovedSessions:   int(removedSessions),
		RemovedSessionIDs: removedSessionIDs,
	}, nil
}

func listAgentSessionIDsTx(ctx context.Context, tx *sql.Tx, workspaceID string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `
SELECT agent_session_id
FROM workspace_agent_sessions
WHERE workspace_id = ?
ORDER BY updated_at_unix_ms DESC, agent_session_id ASC
`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list workspace agent sessions for clear: %w", err)
	}
	defer rows.Close()

	sessionIDs := make([]string, 0)
	for rows.Next() {
		var sessionID string
		if err := rows.Scan(&sessionID); err != nil {
			return nil, fmt.Errorf("scan workspace agent session id for clear: %w", err)
		}
		sessionID = strings.TrimSpace(sessionID)
		if sessionID != "" {
			sessionIDs = append(sessionIDs, sessionID)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace agent session ids for clear: %w", err)
	}
	return sessionIDs, nil
}

func (s *Store) UpdateSessionPinned(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	pinned bool,
) (Session, bool, error) {
	if s == nil || s.db == nil {
		return Session{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return Session{}, false, nil
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
		return Session{}, false, fmt.Errorf("update workspace agent session pinned state: %w", err)
	}
	updated, err := rowsWereAffected(result, "update workspace agent session pinned state")
	if err != nil {
		return Session{}, false, err
	}
	if !updated {
		return Session{}, false, nil
	}
	session, ok, err := s.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, false, err
	}
	return session, ok, nil
}

func (s *Store) ListSessionMessages(
	ctx context.Context,
	input ListSessionMessagesInput,
) (MessagePage, bool, error) {
	if s == nil || s.db == nil {
		return MessagePage{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return MessagePage{}, false, nil
	}
	if _, ok, err := s.GetSession(ctx, workspaceID, agentSessionID); err != nil || !ok {
		return MessagePage{}, ok, err
	}

	queryLimit := input.Limit
	if queryLimit > 0 {
		queryLimit++
	}
	turnID := strings.TrimSpace(input.TurnID)
	where := []string{"workspace_id = ?", "agent_session_id = ?", "deleted_at_unix_ms = 0"}
	args := []any{workspaceID, agentSessionID}
	if turnID != "" {
		where = append(where, "turn_id = ?")
		args = append(args, turnID)
	}
	order := input.Order
	if order == "" {
		order = MessageOrderAsc
	}
	var rows *sql.Rows
	var err error
	switch order {
	case MessageOrderDesc:
		if input.BeforeVersion > 0 {
			whereWithCursor := append(append([]string{}, where...), "version < ?")
			argsWithCursor := append(append([]any{}, args...), input.BeforeVersion, queryLimit)
			rows, err = s.db.QueryContext(ctx, `
SELECT id, agent_session_id, message_id, version, turn_id, role, kind, status,
       payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_messages
WHERE `+strings.Join(whereWithCursor, " AND ")+`
ORDER BY version DESC, id DESC
LIMIT ?
`, argsWithCursor...)
		} else {
			argsWithLimit := append(append([]any{}, args...), queryLimit)
			rows, err = s.db.QueryContext(ctx, `
SELECT id, agent_session_id, message_id, version, turn_id, role, kind, status,
       payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_messages
WHERE `+strings.Join(where, " AND ")+`
ORDER BY version DESC, id DESC
LIMIT ?
`, argsWithLimit...)
		}
	case MessageOrderAsc:
		whereWithCursor := append(append([]string{}, where...), "version > ?")
		argsWithCursor := append(append([]any{}, args...), input.AfterVersion, queryLimit)
		rows, err = s.db.QueryContext(ctx, `
SELECT id, agent_session_id, message_id, version, turn_id, role, kind, status,
       payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_messages
WHERE `+strings.Join(whereWithCursor, " AND ")+`
ORDER BY version ASC, id ASC
LIMIT ?
`, argsWithCursor...)
	default:
		return MessagePage{}, false, fmt.Errorf("unsupported workspace agent message order: %s", order)
	}
	if err != nil {
		slog.Warn("workspace agent messages query failed",
			"event", "workspace.agent_session.messages.sqlite.query_failed",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"after_version", input.AfterVersion,
			"before_version", input.BeforeVersion,
			"order", order,
			"limit", input.Limit,
			"query_limit", queryLimit,
			"error", err,
		)
		return MessagePage{}, false, fmt.Errorf("list workspace agent messages: %w", err)
	}
	defer rows.Close()

	messages := make([]Message, 0)
	for rows.Next() {
		message, err := scanAgentMessage(rows)
		if err != nil {
			slog.Warn("workspace agent message row scan failed",
				"event", "workspace.agent_session.messages.sqlite.scan_failed",
				"workspace_id", workspaceID,
				"agent_session_id", agentSessionID,
				"after_version", input.AfterVersion,
				"before_version", input.BeforeVersion,
				"order", order,
				"limit", input.Limit,
				"query_limit", queryLimit,
				"scanned_message_count", len(messages),
				"error", err,
			)
			return MessagePage{}, false, err
		}
		messages = append(messages, message)
	}
	if err := rows.Err(); err != nil {
		slog.Warn("workspace agent messages row iteration failed",
			"event", "workspace.agent_session.messages.sqlite.iterate_failed",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"after_version", input.AfterVersion,
			"before_version", input.BeforeVersion,
			"order", order,
			"limit", input.Limit,
			"query_limit", queryLimit,
			"scanned_message_count", len(messages),
			"error", err,
		)
		return MessagePage{}, false, fmt.Errorf("iterate workspace agent messages: %w", err)
	}
	hasMore := false
	if input.Limit > 0 && len(messages) > input.Limit {
		hasMore = true
		messages = messages[:input.Limit]
	}
	latestVersion := input.AfterVersion
	if order == MessageOrderDesc {
		latestVersion = 0
	}
	for _, message := range messages {
		if message.Version > latestVersion {
			latestVersion = message.Version
		}
	}
	return MessagePage{
		AgentSessionID: agentSessionID,
		Messages:       messages,
		LatestVersion:  latestVersion,
		HasMore:        hasMore,
	}, true, nil
}

func (s *Store) upsertAgentSession(
	ctx context.Context,
	input SessionStateReport,
	now int64,
) (bool, bool, int64, Session, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, false, 0, Session{}, fmt.Errorf("begin workspace agent session state report: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	accepted, stateApplied, lastEventUnixMS, session, err := s.upsertAgentSessionTx(ctx, tx, input, now)
	if err != nil {
		return false, false, 0, Session{}, err
	}
	if err := tx.Commit(); err != nil {
		return false, false, 0, Session{}, fmt.Errorf("commit workspace agent session state report: %w", err)
	}
	committed = true
	return accepted, stateApplied, lastEventUnixMS, session, nil
}

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
