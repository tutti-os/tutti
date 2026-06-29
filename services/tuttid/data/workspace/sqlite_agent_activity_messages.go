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

func incrementAgentSessionMessageVersion(ctx context.Context, tx *sql.Tx, workspaceID, agentSessionID string) (uint64, error) {
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET message_version = message_version + 1,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, unixMs(time.Now().UTC()), workspaceID, agentSessionID); err != nil {
		return 0, fmt.Errorf("increment workspace agent message version: %w", err)
	}
	row := tx.QueryRowContext(ctx, `
SELECT message_version
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, agentSessionID)
	var version uint64
	if err := row.Scan(&version); err != nil {
		return 0, fmt.Errorf("select workspace agent message version: %w", err)
	}
	return version, nil
}

func upsertAgentMessageTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
	version uint64,
	input agentactivitybiz.MessageUpdate,
	now int64,
) (agentactivitybiz.Message, bool, error) {
	existing, ok, err := getAgentMessageForUpdate(ctx, tx, workspaceID, agentSessionID, input.MessageID)
	if err != nil {
		return agentactivitybiz.Message{}, false, err
	}
	message, accepted := agentactivityprojection.ProjectMessageUpdate(
		messageProjectionSnapshot(existing),
		ok,
		agentactivityprojection.MessageUpdate{
			MessageID:         input.MessageID,
			TurnID:            input.TurnID,
			Role:              input.Role,
			Kind:              input.Kind,
			Status:            input.Status,
			ContentDelta:      input.ContentDelta,
			Payload:           input.Payload,
			OccurredAtUnixMS:  input.OccurredAtUnixMS,
			StartedAtUnixMS:   input.StartedAtUnixMS,
			CompletedAtUnixMS: input.CompletedAtUnixMS,
		},
		version,
		now,
	)
	if !accepted {
		return agentactivitybiz.Message{}, false, nil
	}
	payloadJSON, err := json.Marshal(message.Payload)
	if err != nil {
		return agentactivitybiz.Message{}, false, fmt.Errorf("encode workspace agent message payload: %w", err)
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, turn_id, role, kind, status,
  payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id, message_id) DO UPDATE SET
  version = excluded.version,
  turn_id = excluded.turn_id,
  role = excluded.role,
  kind = excluded.kind,
  status = excluded.status,
  payload_json = excluded.payload_json,
  occurred_at_unix_ms = excluded.occurred_at_unix_ms,
  started_at_unix_ms = excluded.started_at_unix_ms,
  completed_at_unix_ms = excluded.completed_at_unix_ms,
  deleted_at_unix_ms = 0,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, workspaceID, agentSessionID, strings.TrimSpace(input.MessageID), version,
		message.TurnID, message.Role, message.Kind, message.Status, string(payloadJSON),
		message.OccurredAtUnixMS, message.StartedAtUnixMS, message.CompletedAtUnixMS,
		message.CreatedAtUnixMS, message.UpdatedAtUnixMS)
	if err != nil {
		return agentactivitybiz.Message{}, false, fmt.Errorf("upsert workspace agent message: %w", err)
	}
	acceptedMessage, ok, err := getAgentMessageForUpdate(ctx, tx, workspaceID, agentSessionID, input.MessageID)
	if err != nil {
		return agentactivitybiz.Message{}, false, err
	}
	if !ok {
		return agentactivitybiz.Message{}, false, fmt.Errorf("read accepted workspace agent message: %w", sql.ErrNoRows)
	}
	return acceptedMessage, true, nil
}

func getAgentMessageForUpdate(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
	messageID string,
) (agentactivitybiz.Message, bool, error) {
	row := tx.QueryRowContext(ctx, `
SELECT id, agent_session_id, message_id, version, turn_id, role, kind, status,
       payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_messages
WHERE workspace_id = ? AND agent_session_id = ? AND message_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, agentSessionID, messageID)
	message, err := scanAgentMessage(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return agentactivitybiz.Message{}, false, nil
		}
		return agentactivitybiz.Message{}, false, fmt.Errorf("get workspace agent message: %w", err)
	}
	return message, true, nil
}

func messageProjectionSnapshot(message agentactivitybiz.Message) agentactivityprojection.MessageSnapshot {
	return agentactivityprojection.MessageSnapshot{
		ID:                message.ID,
		AgentSessionID:    strings.TrimSpace(message.AgentSessionID),
		MessageID:         strings.TrimSpace(message.MessageID),
		Version:           message.Version,
		TurnID:            strings.TrimSpace(message.TurnID),
		Role:              strings.TrimSpace(message.Role),
		Kind:              strings.TrimSpace(message.Kind),
		Status:            strings.TrimSpace(message.Status),
		Payload:           message.Payload,
		OccurredAtUnixMS:  message.OccurredAtUnixMS,
		StartedAtUnixMS:   message.StartedAtUnixMS,
		CompletedAtUnixMS: message.CompletedAtUnixMS,
		CreatedAtUnixMS:   message.CreatedAtUnixMS,
		UpdatedAtUnixMS:   message.UpdatedAtUnixMS,
	}
}

func scanAgentMessage(scanner rowScanner) (agentactivitybiz.Message, error) {
	var message agentactivitybiz.Message
	var payloadJSON string
	err := scanner.Scan(
		&message.ID,
		&message.AgentSessionID,
		&message.MessageID,
		&message.Version,
		&message.TurnID,
		&message.Role,
		&message.Kind,
		&message.Status,
		&payloadJSON,
		&message.OccurredAtUnixMS,
		&message.StartedAtUnixMS,
		&message.CompletedAtUnixMS,
		&message.CreatedAtUnixMS,
		&message.UpdatedAtUnixMS,
	)
	if err != nil {
		return agentactivitybiz.Message{}, fmt.Errorf("scan workspace agent message row: %w", err)
	}
	if strings.TrimSpace(payloadJSON) == "" {
		message.Payload = map[string]any{}
		return message, nil
	}
	if err := json.Unmarshal([]byte(payloadJSON), &message.Payload); err != nil {
		return agentactivitybiz.Message{}, fmt.Errorf(
			"decode workspace agent message payload id=%d message_id=%q version=%d turn_id=%q role=%q kind=%q status=%q: %w",
			message.ID,
			message.MessageID,
			message.Version,
			message.TurnID,
			message.Role,
			message.Kind,
			message.Status,
			err,
		)
	}
	return message, nil
}
