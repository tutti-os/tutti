package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"

	agentactivityprojection "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
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

func (*Store) upsertAgentMessageTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
	input MessageUpdate,
	now int64,
	allowLegacyTurnless bool,
) (Message, bool, error) {
	existing, ok, err := getAgentMessageForUpdate(ctx, tx, workspaceID, agentSessionID, input.MessageID)
	if err != nil {
		return Message{}, false, err
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
		0,
		now,
	)
	if !accepted {
		return Message{}, false, nil
	}
	if ok && agentMessageProjectionAlreadyApplied(existing, message) {
		return existing, true, nil
	}
	if ok {
		return Message{}, false, fmt.Errorf(
			"workspace agent activity message %q conflicts with durable submit provenance",
			input.MessageID,
		)
	}
	messageSemantics := cloneMessageSemantics(input.Semantics)
	turnID := strings.TrimSpace(message.TurnID)
	kind := strings.TrimSpace(message.Kind)
	if kind == "session_audit" {
		if turnID != "" {
			return Message{}, false, fmt.Errorf("workspace agent session audit must not reference turn %q", turnID)
		}
	} else if turnID == "" && !allowLegacyTurnless {
		return Message{}, false, fmt.Errorf("workspace agent message %q kind %q is missing turn", message.MessageID, kind)
	} else if turnID != "" {
		if _, exists, err := getAgentTurnTx(ctx, tx, workspaceID, agentSessionID, turnID); err != nil {
			return Message{}, false, err
		} else if !exists {
			return Message{}, false, fmt.Errorf("workspace agent message references unknown turn %q", turnID)
		}
	}
	version, err := incrementAgentSessionMessageVersion(ctx, tx, workspaceID, agentSessionID)
	if err != nil {
		return Message{}, false, err
	}
	message.Version = version
	payloadJSON, err := json.Marshal(message.Payload)
	if err != nil {
		return Message{}, false, fmt.Errorf("encode workspace agent message payload: %w", err)
	}
	semanticsJSON, err := json.Marshal(messageSemantics)
	if err != nil {
		return Message{}, false, fmt.Errorf("encode workspace agent message semantics: %w", err)
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, turn_id, role, kind, status,
  semantics_json, payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id, message_id) DO UPDATE SET
  version = excluded.version,
  turn_id = excluded.turn_id,
  role = excluded.role,
  kind = excluded.kind,
  status = excluded.status,
  semantics_json = excluded.semantics_json,
  payload_json = excluded.payload_json,
  occurred_at_unix_ms = excluded.occurred_at_unix_ms,
  started_at_unix_ms = excluded.started_at_unix_ms,
  completed_at_unix_ms = excluded.completed_at_unix_ms,
  deleted_at_unix_ms = 0,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, workspaceID, agentSessionID, strings.TrimSpace(input.MessageID), version,
		nullString(strings.TrimSpace(message.TurnID)), message.Role, message.Kind, message.Status, string(semanticsJSON), string(payloadJSON),
		message.OccurredAtUnixMS, message.StartedAtUnixMS, message.CompletedAtUnixMS,
		message.CreatedAtUnixMS, message.UpdatedAtUnixMS)
	if err != nil {
		return Message{}, false, fmt.Errorf("upsert workspace agent message: %w", err)
	}
	acceptedMessage, ok, err := getAgentMessageForUpdate(ctx, tx, workspaceID, agentSessionID, input.MessageID)
	if err != nil {
		return Message{}, false, err
	}
	if !ok {
		return Message{}, false, fmt.Errorf("read accepted workspace agent message: %w", sql.ErrNoRows)
	}
	return acceptedMessage, true, nil
}

func agentMessageProjectionAlreadyApplied(
	existing Message,
	projected agentactivityprojection.MessageSnapshot,
) bool {
	return strings.TrimSpace(existing.TurnID) == strings.TrimSpace(projected.TurnID) &&
		strings.TrimSpace(existing.Role) == strings.TrimSpace(projected.Role) &&
		strings.TrimSpace(existing.Kind) == strings.TrimSpace(projected.Kind) &&
		strings.TrimSpace(existing.Status) == strings.TrimSpace(projected.Status) &&
		reflect.DeepEqual(existing.Payload, projected.Payload)
}

func getAgentMessageForUpdate(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
	messageID string,
) (Message, bool, error) {
	row := tx.QueryRowContext(ctx, `
SELECT id, agent_session_id, message_id, version, turn_id, role, kind, status,
       semantics_json, payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_messages
WHERE workspace_id = ? AND agent_session_id = ? AND message_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, agentSessionID, messageID)
	message, err := scanAgentMessage(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Message{}, false, nil
		}
		return Message{}, false, fmt.Errorf("get workspace agent message: %w", err)
	}
	return message, true, nil
}

func messageProjectionSnapshot(message Message) agentactivityprojection.MessageSnapshot {
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

func scanAgentMessage(scanner rowScanner) (Message, error) {
	var message Message
	var payloadJSON string
	var semanticsJSON string
	var turnID sql.NullString
	err := scanner.Scan(
		&message.ID,
		&message.AgentSessionID,
		&message.MessageID,
		&message.Version,
		&turnID,
		&message.Role,
		&message.Kind,
		&message.Status,
		&semanticsJSON,
		&payloadJSON,
		&message.OccurredAtUnixMS,
		&message.StartedAtUnixMS,
		&message.CompletedAtUnixMS,
		&message.CreatedAtUnixMS,
		&message.UpdatedAtUnixMS,
	)
	if err != nil {
		return Message{}, fmt.Errorf("scan workspace agent message row: %w", err)
	}
	// NULL turn_id (session-level message) is surfaced as an empty string in
	// the Go DTO; transport projections re-encode it as null.
	message.TurnID = strings.TrimSpace(turnID.String)
	if strings.TrimSpace(semanticsJSON) != "" && strings.TrimSpace(semanticsJSON) != "null" && strings.TrimSpace(semanticsJSON) != "{}" {
		if err := json.Unmarshal([]byte(semanticsJSON), &message.Semantics); err != nil {
			return Message{}, fmt.Errorf("decode workspace agent message semantics id=%d message_id=%q: %w", message.ID, message.MessageID, err)
		}
	}
	if strings.TrimSpace(payloadJSON) == "" {
		message.Payload = map[string]any{}
		return message, nil
	}
	if err := json.Unmarshal([]byte(payloadJSON), &message.Payload); err != nil {
		return Message{}, fmt.Errorf(
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

func cloneMessageSemantics(value *MessageSemantics) *MessageSemantics {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
