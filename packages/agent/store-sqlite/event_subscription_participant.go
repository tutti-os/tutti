package storesqlite

import (
	"context"
	"fmt"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

// EventSubscriptionParticipant atomically turns canonical terminal-turn facts
// into durable one-shot deliveries. It performs no network or runtime work.
type EventSubscriptionParticipant struct{}

func (EventSubscriptionParticipant) Participate(ctx context.Context, writer TransactionWriter, delta TransactionDelta) error {
	for _, mutation := range delta.Mutations {
		if mutation.EntityKind == MutationEntitySession && mutation.Operation == "delete" {
			if _, err := writer.ExecContext(ctx, `UPDATE workspace_agent_event_subscriptions
SET status='canceled',updated_at_unix_ms=?
WHERE workspace_id=? AND status='active' AND
 ((source_kind=? AND source_id=?) OR subscriber_agent_session_id=?)`,
				mutation.Version, mutation.WorkspaceID, canonical.EventSourceKindAgentTurn, mutation.EntityID, mutation.EntityID); err != nil {
				return fmt.Errorf("cancel subscriptions for deleted agent event session: %w", err)
			}
			if _, err := writer.ExecContext(ctx, `UPDATE workspace_agent_event_deliveries
SET status='failed',lease_owner=NULL,lease_expires_at_unix_ms=NULL,
    last_error='subscriber_session_deleted',updated_at_unix_ms=?
WHERE workspace_id=? AND subscriber_agent_session_id=? AND status IN ('prepared','leased')`,
				mutation.Version, mutation.WorkspaceID, mutation.EntityID); err != nil {
				return fmt.Errorf("stop deliveries for deleted agent event subscriber: %w", err)
			}
			continue
		}
		// Canonical writers currently label ordinary runtime turn transitions as
		// "upsert" and coordinator-owned settlements as "settle". Query the
		// committed-in-this-transaction row instead of coupling matching to that
		// caller-local operation label.
		if mutation.EntityKind != MutationEntityTurn {
			continue
		}
		eventID := mutation.MutationID
		for _, definition := range canonical.TerminalTurnEventDefinitions() {
			if _, err := writer.ExecContext(ctx, `
INSERT OR IGNORE INTO workspace_agent_event_deliveries
(delivery_id,event_id,subscription_id,workspace_id,subscriber_agent_session_id,event_type,event_version,source_kind,source_id,source_subject_id,payload_json,status,next_attempt_at_unix_ms,created_at_unix_ms,updated_at_unix_ms)
SELECT ? || ':' || s.subscription_id, ?, s.subscription_id, s.workspace_id,
       s.subscriber_agent_session_id, ?, ?, ?, t.agent_session_id, t.turn_id,
       '{}', 'prepared', ?, ?, ?
FROM workspace_agent_event_subscriptions s
JOIN workspace_agent_turns t
  ON t.workspace_id=s.workspace_id AND t.agent_session_id=s.source_id
WHERE s.workspace_id=? AND t.agent_session_id=? AND t.turn_id=?
  AND t.phase='settled' AND t.outcome=?
  AND s.status='active'
	  AND s.event_type=? AND s.event_version=? AND s.source_kind=?
  AND (s.source_subject_id IS NULL OR s.source_subject_id=t.turn_id)
`, eventID, eventID, definition.Type, definition.Version, definition.SourceKind,
				mutation.Version, mutation.Version, mutation.Version,
				mutation.WorkspaceID, mutation.AgentSessionID, mutation.EntityID, definition.Outcome,
				definition.Type, definition.Version, definition.SourceKind); err != nil {
				return fmt.Errorf("append agent event delivery: %w", err)
			}
		}
		if _, err := writer.ExecContext(ctx, `UPDATE workspace_agent_event_subscriptions
SET status='matched',matched_event_id=?,updated_at_unix_ms=?
WHERE status='active' AND subscription_id IN
 (SELECT subscription_id FROM workspace_agent_event_deliveries WHERE event_id=?)`, eventID, mutation.Version, eventID); err != nil {
			return fmt.Errorf("match agent event subscriptions: %w", err)
		}
	}
	return nil
}
