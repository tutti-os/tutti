package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
)

type historicalImportTurnRange struct {
	startedAtUnixMS int64
	settledAtUnixMS int64
}

func ensureHistoricalImportTurnsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
	messages []MessageUpdate,
	now int64,
) ([]string, error) {
	ranges := map[string]historicalImportTurnRange{}
	for _, message := range messages {
		turnID := strings.TrimSpace(message.TurnID)
		if turnID == "" {
			continue
		}
		startedAt := historicalImportFirstNonZeroInt64(message.StartedAtUnixMS, message.OccurredAtUnixMS, message.CompletedAtUnixMS, now)
		settledAt := historicalImportFirstNonZeroInt64(message.CompletedAtUnixMS, message.OccurredAtUnixMS, message.StartedAtUnixMS, now)
		current, ok := ranges[turnID]
		if !ok || startedAt < current.startedAtUnixMS {
			current.startedAtUnixMS = startedAt
		}
		if settledAt > current.settledAtUnixMS {
			current.settledAtUnixMS = settledAt
		}
		ranges[turnID] = current
	}

	turnIDs := make([]string, 0, len(ranges))
	for turnID := range ranges {
		turnIDs = append(turnIDs, turnID)
	}
	sort.Strings(turnIDs)
	for _, turnID := range turnIDs {
		timeRange := ranges[turnID]
		if _, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase, outcome, backfilled,
  turn_origin, started_at_unix_ms, settled_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
`, workspaceID, agentSessionID, turnID, TurnPhaseSettled, TurnOutcomeCompleted,
			TurnOriginUserPrompt, timeRange.startedAtUnixMS, timeRange.settledAtUnixMS,
			timeRange.startedAtUnixMS, timeRange.settledAtUnixMS); err != nil {
			return nil, fmt.Errorf("create historical import turn %q: %w", turnID, err)
		}
		stored, ok, err := getAgentTurnTx(ctx, tx, workspaceID, agentSessionID, turnID)
		if err != nil {
			return nil, err
		}
		if !ok || !stored.Backfilled {
			return nil, fmt.Errorf("historical import turn %q conflicts with a canonical live turn", turnID)
		}
	}
	return turnIDs, nil
}

func refreshHistoricalImportTurnsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
	turnIDs []string,
) ([]Turn, error) {
	turns := make([]Turn, 0, len(turnIDs))
	for _, turnID := range turnIDs {
		var startedAtUnixMS int64
		var settledAtUnixMS int64
		if err := tx.QueryRowContext(ctx, `
SELECT
  COALESCE(
    MIN(CASE WHEN LOWER(TRIM(role)) = 'user' THEN
      CASE
        WHEN started_at_unix_ms > 0 THEN started_at_unix_ms
        WHEN occurred_at_unix_ms > 0 THEN occurred_at_unix_ms
        WHEN completed_at_unix_ms > 0 THEN completed_at_unix_ms
        ELSE created_at_unix_ms
      END
    END),
    MIN(CASE
      WHEN started_at_unix_ms > 0 THEN started_at_unix_ms
      WHEN occurred_at_unix_ms > 0 THEN occurred_at_unix_ms
      WHEN completed_at_unix_ms > 0 THEN completed_at_unix_ms
      ELSE created_at_unix_ms
    END)
  ),
  MAX(CASE
    WHEN completed_at_unix_ms > 0 THEN completed_at_unix_ms
    WHEN occurred_at_unix_ms > 0 THEN occurred_at_unix_ms
    WHEN started_at_unix_ms > 0 THEN started_at_unix_ms
    ELSE updated_at_unix_ms
  END)
FROM workspace_agent_messages
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
  AND deleted_at_unix_ms = 0
`, workspaceID, agentSessionID, turnID).Scan(&startedAtUnixMS, &settledAtUnixMS); err != nil {
			return nil, fmt.Errorf("derive historical import turn %q timestamps: %w", turnID, err)
		}
		finalAssistantMessageID, err := finalAssistantMessageIDAtSettlementTx(
			ctx, tx, workspaceID, agentSessionID, turnID, "",
		)
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET phase = ?, outcome = ?, backfilled = 1, turn_origin = ?,
    started_at_unix_ms = ?, settled_at_unix_ms = ?,
    created_at_unix_ms = ?, updated_at_unix_ms = ?,
    completed_command_json = ?
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ? AND backfilled = 1
`, TurnPhaseSettled, TurnOutcomeCompleted, TurnOriginUserPrompt,
			startedAtUnixMS, settledAtUnixMS, startedAtUnixMS, settledAtUnixMS,
			encodeCompletedCommandJSON("", "", finalAssistantWatermark{
				MessageID: finalAssistantMessageID,
				Resolved:  true,
			}),
			workspaceID, agentSessionID, turnID); err != nil {
			return nil, fmt.Errorf("refresh historical import turn %q: %w", turnID, err)
		}
		stored, ok, err := getAgentTurnTx(ctx, tx, workspaceID, agentSessionID, turnID)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("read refreshed historical import turn %q: %w", turnID, sql.ErrNoRows)
		}
		turns = append(turns, stored)
	}
	return turns, nil
}

func historicalImportFirstNonZeroInt64(values ...int64) int64 {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}
