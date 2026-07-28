package workspace

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	agentstore "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

// tuttiModeSourceActivityParticipant records only canonical identities. The
// exact source activity and its timestamp are resolved from canonical rows
// while draining, so post-commit observers are wake hints rather than the
// durability boundary.
type tuttiModeSourceActivityParticipant struct{}

type tuttiModeSourceActivityRows interface {
	Next() bool
	Scan(...any) error
	Err() error
	Close() error
}

// tuttiModeRelevantSourceActivitySelectSQL is the single data-adapter
// authority for classifying a canonical Agent mutation as source activity.
// Draining and both wake-admission fences consume this same relation so an
// internal Tutti wake can never be ignored by one seam but blocked by another.
const tuttiModeRelevantSourceActivitySelectSQL = `
SELECT i.workspace_id, i.agent_session_id, i.mutation_id,
       CASE
         WHEN i.entity_kind = 'message' THEN m.occurred_at_unix_ms
         WHEN i.entity_kind = 'turn' THEN tt.settled_at_unix_ms
         ELSE 0
       END AS activity_at_unix_ms
FROM workspace_tutti_source_activity_inbox i
LEFT JOIN workspace_agent_messages m
  ON i.entity_kind = 'message'
 AND m.workspace_id = i.workspace_id
 AND m.agent_session_id = i.agent_session_id
 AND m.message_id = i.entity_id
 AND m.deleted_at_unix_ms = 0
LEFT JOIN workspace_agent_turns tt
  ON i.entity_kind = 'turn'
 AND tt.workspace_id = i.workspace_id
 AND tt.agent_session_id = i.agent_session_id
 AND tt.turn_id = i.entity_id
WHERE (
  i.entity_kind = 'message'
  AND m.role = 'user'
  AND m.turn_id IS NOT NULL
  AND m.occurred_at_unix_ms > 0
  AND NOT EXISTS (
    SELECT 1
    FROM workspace_tutti_execution_wakes internal_wake
    WHERE internal_wake.workspace_id = i.workspace_id
      AND internal_wake.target_session_id = i.agent_session_id
      AND internal_wake.client_submit_id =
        TRIM(COALESCE(json_extract(m.payload_json, '$.clientSubmitId'), ''))
  )
) OR (
  i.entity_kind = 'turn'
  AND tt.phase = 'settled'
  AND COALESCE(tt.settled_at_unix_ms, 0) > 0
)`

func (tuttiModeSourceActivityParticipant) Participate(
	ctx context.Context,
	writer agentstore.TransactionWriter,
	delta agentstore.TransactionDelta,
) error {
	for _, mutation := range delta.Mutations {
		entityKind := strings.TrimSpace(mutation.EntityKind)
		if entityKind != agentstore.MutationEntityMessage &&
			entityKind != agentstore.MutationEntityTurn {
			continue
		}
		if _, err := writer.ExecContext(ctx, `
INSERT OR IGNORE INTO workspace_tutti_source_activity_inbox (
  mutation_id, transaction_id, workspace_id, agent_session_id,
  entity_kind, entity_id, entity_version
) VALUES (?, ?, ?, ?, ?, ?, ?)
`, mutation.MutationID, delta.TransactionID, mutation.WorkspaceID,
			mutation.AgentSessionID, entityKind, mutation.EntityID,
			mutation.Version); err != nil {
			return fmt.Errorf("append Tutti mode source activity marker: %w", err)
		}
	}
	return nil
}

func (s *SQLiteStore) DrainTuttiModeSourceActivityInbox(
	ctx context.Context,
	workspaceID string,
) error {
	if err := s.ensureIssueDatabase(); err != nil {
		return err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Tutti mode source activity drain: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, `
SELECT relevant.agent_session_id, MAX(relevant.activity_at_unix_ms)
FROM (`+tuttiModeRelevantSourceActivitySelectSQL+`) relevant
WHERE relevant.workspace_id = ?
GROUP BY relevant.agent_session_id
ORDER BY relevant.agent_session_id
`, workspaceID)
	if err != nil {
		return fmt.Errorf("list Tutti mode source activity markers: %w", err)
	}
	var activityRows tuttiModeSourceActivityRows = rows
	if s.sourceActivityRowsHook != nil {
		activityRows = s.sourceActivityRowsHook(activityRows)
	}
	type sourceActivity struct {
		sessionID      string
		occurredAtUnix int64
	}
	var activities []sourceActivity
	for activityRows.Next() {
		var activity sourceActivity
		if err := activityRows.Scan(
			&activity.sessionID, &activity.occurredAtUnix,
		); err != nil {
			_ = activityRows.Close()
			return fmt.Errorf("scan Tutti mode source activity marker: %w", err)
		}
		activities = append(activities, activity)
	}
	if err := activityRows.Err(); err != nil {
		_ = activityRows.Close()
		return fmt.Errorf("iterate Tutti mode source activity markers: %w", err)
	}
	if err := activityRows.Close(); err != nil {
		return fmt.Errorf("close Tutti mode source activity markers: %w", err)
	}
	for _, activity := range activities {
		if activity.occurredAtUnix <= 0 {
			continue
		}
		if err := observeTuttiModeSourceSessionActivityTx(
			ctx, tx, workspaceID, activity.sessionID,
			time.UnixMilli(activity.occurredAtUnix).UTC(),
		); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_tutti_source_activity_inbox
WHERE workspace_id = ?
`, workspaceID); err != nil {
		return fmt.Errorf("retire Tutti mode source activity markers: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Tutti mode source activity drain: %w", err)
	}
	return nil
}

func observeTuttiModeSourceSessionActivityTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	sessionID string,
	occurredAt time.Time,
) error {
	_, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_executions
SET last_orchestrator_activity_at_unix_ms = ?,
    watchdog_due_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND source_session_id = ?
  AND status IN ('awaiting_schedule', 'running', 'awaiting_main', 'pending_goal_review')
  AND last_orchestrator_activity_at_unix_ms < ?
`, unixMs(occurredAt), unixMs(occurredAt.Add(executionbiz.WatchdogInterval)),
		unixMs(occurredAt), workspaceID, sessionID, unixMs(occurredAt))
	if err != nil {
		return fmt.Errorf("observe Tutti mode source-session activity: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET due_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND status IN ('prepared', 'leased')
  AND EXISTS (
    SELECT 1
    FROM workspace_tutti_executions e
    JOIN workspace_tutti_execution_checkpoints c
      ON c.workspace_id = e.workspace_id AND c.execution_id = e.execution_id
     AND c.checkpoint_id = workspace_tutti_execution_wakes.checkpoint_id
    WHERE e.workspace_id = workspace_tutti_execution_wakes.workspace_id
      AND e.execution_id = workspace_tutti_execution_wakes.execution_id
      AND e.source_session_id = ?
      AND e.status IN ('awaiting_schedule', 'running', 'awaiting_main', 'pending_goal_review')
      AND e.last_orchestrator_activity_at_unix_ms = ?
      AND c.kind = 'watchdog' AND c.status = 'active'
  )
`, unixMs(occurredAt.Add(executionbiz.WatchdogInterval)), unixMs(occurredAt),
		workspaceID, sessionID, unixMs(occurredAt)); err != nil {
		return fmt.Errorf("debounce prepared Tutti mode watchdog wake: %w", err)
	}
	return nil
}
