package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"
)

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
	messageID := strings.TrimSpace(input.MessageID)
	where := []string{"workspace_id = ?", "agent_session_id = ?", "deleted_at_unix_ms = 0"}
	args := []any{workspaceID, agentSessionID}
	if messageID != "" {
		where = append(where, "message_id = ?")
		args = append(args, messageID)
	}
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
       semantics_json, payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
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
       semantics_json, payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
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
       semantics_json, payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
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
