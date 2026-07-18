package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// finalAssistantMessageIDAtSettlementTx selects the durable result watermark
// while the Turn settlement transaction is still open. A same-report anchor
// is accepted only when it is already persisted and is still the newest
// assistant text message; otherwise the store derives the watermark from all
// messages persisted for the Turn. Once the Turn is settled, terminal replay
// rejection keeps this value fixed even if later messages arrive.
func finalAssistantMessageIDAtSettlementTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
	turnID string,
	preferredMessageID string,
) (string, error) {
	preferredMessageID = strings.TrimSpace(preferredMessageID)
	if preferredMessageID != "" {
		var messageID string
		err := tx.QueryRowContext(ctx, `
SELECT message_id
FROM workspace_agent_messages
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
  AND message_id = ? AND LOWER(TRIM(role)) = 'assistant' AND LOWER(TRIM(kind)) = 'text'
  AND deleted_at_unix_ms = 0
  AND version = (
    SELECT MAX(version)
    FROM workspace_agent_messages
    WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
      AND LOWER(TRIM(role)) = 'assistant' AND LOWER(TRIM(kind)) = 'text'
      AND deleted_at_unix_ms = 0
  )
`, workspaceID, agentSessionID, turnID, preferredMessageID,
			workspaceID, agentSessionID, turnID).Scan(&messageID)
		if err == nil {
			return strings.TrimSpace(messageID), nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return "", fmt.Errorf("resolve preferred final assistant message: %w", err)
		}
	}

	var messageID string
	err := tx.QueryRowContext(ctx, `
SELECT message_id
FROM workspace_agent_messages
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
  AND LOWER(TRIM(role)) = 'assistant' AND LOWER(TRIM(kind)) = 'text'
  AND deleted_at_unix_ms = 0
ORDER BY version DESC, id DESC
LIMIT 1
`, workspaceID, agentSessionID, turnID).Scan(&messageID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("resolve final assistant message at settlement: %w", err)
	}
	return strings.TrimSpace(messageID), nil
}

func encodeTurnErrorJSON(message string, code string) any {
	message = strings.TrimSpace(message)
	if message == "" {
		return nil
	}
	payload := map[string]any{"message": message}
	if code = strings.TrimSpace(code); code != "" {
		payload["code"] = code
	}
	encoded, err := marshalJSONMap(payload)
	if err != nil {
		return nil
	}
	return encoded
}

type finalAssistantWatermark struct {
	MessageID string
	Resolved  bool
}

func encodeCompletedCommandJSON(kind string, status string, finalAssistantWatermarks ...finalAssistantWatermark) any {
	kind = strings.TrimSpace(kind)
	watermark := finalAssistantWatermark{}
	if len(finalAssistantWatermarks) > 0 {
		watermark = finalAssistantWatermarks[0]
		watermark.MessageID = strings.TrimSpace(watermark.MessageID)
	}
	if kind == "" && !watermark.Resolved && watermark.MessageID == "" {
		return nil
	}
	payload := map[string]any{}
	if kind != "" {
		payload["kind"] = kind
	}
	if status = strings.TrimSpace(status); status != "" {
		payload["status"] = status
	}
	if watermark.Resolved {
		payload["finalAssistantMessageResolved"] = true
	}
	if watermark.MessageID != "" {
		payload["finalAssistantMessageId"] = watermark.MessageID
	}
	encoded, err := marshalJSONMap(payload)
	if err != nil {
		return nil
	}
	return encoded
}
