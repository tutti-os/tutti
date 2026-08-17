package workspace

import (
	"context"
	"fmt"
	"strings"

	agentstore "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentturnanalyticsbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentturnanalytics"
)

type agentTransactionParticipants []agentstore.TransactionParticipant

func (participants agentTransactionParticipants) Participate(
	ctx context.Context,
	writer agentstore.TransactionWriter,
	delta agentstore.TransactionDelta,
) error {
	for _, participant := range participants {
		if participant == nil {
			continue
		}
		if err := participant.Participate(ctx, writer, delta); err != nil {
			return err
		}
	}
	return nil
}

// agentTurnTerminalAnalyticsParticipant joins the product-owned delivery
// ledger to the canonical settlement transaction. CommitObserver is only a
// wake hint; a crash before observer fanout cannot erase this marker.
type agentTurnTerminalAnalyticsParticipant struct{}

func (agentTurnTerminalAnalyticsParticipant) Participate(
	ctx context.Context,
	writer agentstore.TransactionWriter,
	delta agentstore.TransactionDelta,
) error {
	for _, mutation := range delta.Mutations {
		if strings.TrimSpace(mutation.EntityKind) != agentstore.MutationEntityTurn ||
			!mutation.TurnTerminalTransition {
			continue
		}
		workspaceID := strings.TrimSpace(mutation.WorkspaceID)
		agentSessionID := strings.TrimSpace(mutation.AgentSessionID)
		turnID := strings.TrimSpace(mutation.EntityID)
		if workspaceID == "" || agentSessionID == "" || turnID == "" {
			continue
		}
		eventID := agentturnanalyticsbiz.StableEventID(workspaceID, agentSessionID, turnID)
		startupReconciled := mutation.StartupReconciled
		if _, err := writer.ExecContext(ctx, `
INSERT INTO agent_turn_terminal_analytics (
  workspace_id, agent_session_id, turn_id, event_id, provider,
  turn_origin, turn_outcome, error_code, startup_reconciled,
  started_at_unix_ms, settled_at_unix_ms, status,
  created_at_unix_ms, updated_at_unix_ms
)
SELECT turn.workspace_id, turn.agent_session_id, turn.turn_id, ?,
       COALESCE(session.provider, ''), turn.turn_origin, turn.outcome,
       COALESCE(json_extract(turn.error_json, '$.code'), ''), ?,
       turn.started_at_unix_ms, turn.settled_at_unix_ms, 'pending',
       turn.updated_at_unix_ms, turn.updated_at_unix_ms
FROM workspace_agent_turns AS turn
JOIN workspace_agent_sessions AS session
  ON session.workspace_id = turn.workspace_id
 AND session.agent_session_id = turn.agent_session_id
WHERE turn.workspace_id = ?
  AND turn.agent_session_id = ?
  AND turn.turn_id = ?
  AND turn.phase = 'settled'
  AND turn.outcome IN ('completed', 'failed', 'canceled', 'interrupted')
  AND turn.backfilled = 0
  AND turn.turn_origin = 'user_prompt'
  AND session.session_kind = 'root'
ON CONFLICT(workspace_id, agent_session_id, turn_id) DO NOTHING
`, eventID, boolInt(startupReconciled), workspaceID, agentSessionID, turnID); err != nil {
			return fmt.Errorf("append Agent Turn terminal analytics marker: %w", err)
		}
	}
	return nil
}
