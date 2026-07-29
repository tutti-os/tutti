package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
)

func insertStaleTurnSystemMessageTx(
	ctx context.Context,
	tx *sql.Tx,
	settlement StaleTurnSettlement,
	now int64,
) (Message, error) {
	version, err := incrementAgentSessionMessageVersion(ctx, tx, settlement.WorkspaceID, settlement.AgentSessionID)
	if err != nil {
		return Message{}, err
	}
	title := "Agent run was interrupted by an application restart."
	payloadJSON, err := json.Marshal(map[string]any{
		"kind": "agent_system_notice", "noticeKind": "stale_turn_reconciled",
		"severity": "warning", "title": title, "content": title, "text": title,
	})
	if err != nil {
		return Message{}, fmt.Errorf("encode stale turn system message: %w", err)
	}
	messageID := fmt.Sprintf("system-stale-turn-%s", settlement.TurnID)
	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, turn_id, role, kind, status,
  payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id, message_id) DO UPDATE SET
  version = excluded.version, turn_id = excluded.turn_id, role = excluded.role, kind = excluded.kind,
  status = excluded.status, payload_json = excluded.payload_json,
  occurred_at_unix_ms = excluded.occurred_at_unix_ms,
  completed_at_unix_ms = excluded.completed_at_unix_ms,
  deleted_at_unix_ms = 0, updated_at_unix_ms = excluded.updated_at_unix_ms
	`, settlement.WorkspaceID, settlement.AgentSessionID,
		messageID, version, settlement.TurnID,
		"assistant", "text", "completed", string(payloadJSON), now, now, now, now)
	if err != nil {
		return Message{}, fmt.Errorf("persist stale turn system message: %w", err)
	}
	return Message{
		AgentSessionID: settlement.AgentSessionID,
		MessageID:      messageID, Version: version, TurnID: settlement.TurnID,
		Role: "assistant", Kind: "text", Status: "completed",
		OccurredAtUnixMS: now, CompletedAtUnixMS: now, CreatedAtUnixMS: now, UpdatedAtUnixMS: now,
	}, nil
}
