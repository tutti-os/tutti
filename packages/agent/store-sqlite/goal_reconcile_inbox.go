package storesqlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrGoalReconcileInboxConflict = errors.New("goal reconcile inbox request identity conflict")

const (
	goalReconcilePhasePending   = "quiesce_pending"
	goalReconcilePhaseFinalized = "finalized"
	goalReconcileFinalizeGrace  = 5 * time.Second
)

func (s *Store) PutGoalReconcileInbox(ctx context.Context, input GoalReconcileInboxItem) (bool, error) {
	input.RequestID, input.WorkspaceID, input.AgentSessionID = strings.TrimSpace(input.RequestID), strings.TrimSpace(input.WorkspaceID), strings.TrimSpace(input.AgentSessionID)
	if input.RequestID == "" || input.WorkspaceID == "" || input.AgentSessionID == "" || input.CreatedAtUnixMS <= 0 {
		return false, errors.New("valid goal reconcile inbox identity is required")
	}
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		return false, err
	}
	phase, err := normalizeGoalReconcileInboxPhase(input.Payload)
	if err != nil {
		return false, err
	}
	nextAttemptAt := input.CreatedAtUnixMS
	if phase == goalReconcilePhasePending {
		nextAttemptAt += goalReconcileFinalizeGrace.Milliseconds()
	}
	result, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO workspace_agent_goal_reconcile_inbox
(request_id,workspace_id,agent_session_id,payload_json,status,next_attempt_at_unix_ms,created_at_unix_ms,updated_at_unix_ms)
VALUES(?,?,?,?,'prepared',?,?,?)`, input.RequestID, input.WorkspaceID, input.AgentSessionID, string(payload), nextAttemptAt, input.CreatedAtUnixMS, input.CreatedAtUnixMS)
	if err != nil {
		return false, err
	}
	created, err := rowsWereAffected(result, "put goal reconcile inbox")
	if err != nil || created {
		return created, err
	}
	for attempt := 0; attempt < 3; attempt++ {
		var workspaceID, agentSessionID, existingPayload, status string
		if err := s.db.QueryRowContext(ctx, `SELECT workspace_id,agent_session_id,payload_json,status FROM workspace_agent_goal_reconcile_inbox WHERE request_id=?`, input.RequestID).
			Scan(&workspaceID, &agentSessionID, &existingPayload, &status); err != nil {
			return false, err
		}
		var existing map[string]any
		if err := json.Unmarshal([]byte(existingPayload), &existing); err != nil || workspaceID != input.WorkspaceID || agentSessionID != input.AgentSessionID || !goalReconcileInboxIdentityEqual(existing, input.Payload) {
			return false, fmt.Errorf("%w: request_id=%s", ErrGoalReconcileInboxConflict, input.RequestID)
		}
		existingPhase, phaseErr := normalizeGoalReconcileInboxPhase(existing)
		if phaseErr != nil {
			return false, fmt.Errorf("%w: request_id=%s", ErrGoalReconcileInboxConflict, input.RequestID)
		}
		if existingPayload == string(payload) || (existingPhase == goalReconcilePhaseFinalized && phase == goalReconcilePhasePending) {
			return false, nil
		}
		if existingPhase == goalReconcilePhaseFinalized || phase != goalReconcilePhaseFinalized {
			return false, fmt.Errorf("%w: request_id=%s", ErrGoalReconcileInboxConflict, input.RequestID)
		}
		// Finalization is a one-way CAS. It makes a still-prepared request
		// immediately claimable; a worker that already leased the pending row
		// owns the conservative timeout outcome and is not raced underneath.
		if status != "prepared" {
			return false, nil
		}
		updated, updateErr := s.db.ExecContext(ctx, `UPDATE workspace_agent_goal_reconcile_inbox
SET payload_json=?,next_attempt_at_unix_ms=?,updated_at_unix_ms=?
WHERE request_id=? AND status='prepared' AND payload_json=?`, string(payload), input.CreatedAtUnixMS, input.CreatedAtUnixMS, input.RequestID, existingPayload)
		if updateErr != nil {
			return false, updateErr
		}
		changed, updateErr := rowsWereAffected(updated, "finalize goal reconcile inbox")
		if updateErr != nil {
			return false, updateErr
		}
		if changed {
			return false, nil
		}
	}
	return false, fmt.Errorf("%w: request_id=%s changed concurrently", ErrGoalReconcileInboxConflict, input.RequestID)
}

func normalizeGoalReconcileInboxPhase(payload map[string]any) (string, error) {
	phase, _ := payload["phase"].(string)
	phase = strings.TrimSpace(phase)
	if phase == "" {
		// Rows written by older runtimes carried the post-quiesce result only.
		return goalReconcilePhaseFinalized, nil
	}
	if phase != goalReconcilePhasePending && phase != goalReconcilePhaseFinalized {
		return "", fmt.Errorf("unsupported goal reconcile inbox phase %q", phase)
	}
	return phase, nil
}

func goalReconcileInboxIdentityEqual(left, right map[string]any) bool {
	immutable := []string{
		"providerTurnId", "reason", "fenceMode", "expectedOperationId",
		"expectedRevision", "expectedRepairEpoch",
	}
	leftIdentity, rightIdentity := make(map[string]any, len(immutable)), make(map[string]any, len(immutable))
	for _, key := range immutable {
		leftIdentity[key], rightIdentity[key] = left[key], right[key]
	}
	leftJSON, leftErr := json.Marshal(leftIdentity)
	rightJSON, rightErr := json.Marshal(rightIdentity)
	return leftErr == nil && rightErr == nil && string(leftJSON) == string(rightJSON)
}

func (s *Store) ListClaimableGoalReconcileInbox(ctx context.Context, now int64, limit int) ([]GoalReconcileInboxItem, error) {
	if limit <= 0 || limit > 1000 {
		limit = 64
	}
	rows, err := s.db.QueryContext(ctx, `SELECT request_id,workspace_id,agent_session_id,payload_json,status,attempt,
COALESCE(lease_owner,''),COALESCE(lease_expires_at_unix_ms,0),COALESCE(next_attempt_at_unix_ms,0),last_error,created_at_unix_ms,updated_at_unix_ms
FROM workspace_agent_goal_reconcile_inbox WHERE (status='prepared' AND next_attempt_at_unix_ms<=?) OR (status='leased' AND lease_expires_at_unix_ms<=?)
ORDER BY created_at_unix_ms LIMIT ?`, now, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []GoalReconcileInboxItem
	for rows.Next() {
		var item GoalReconcileInboxItem
		var raw string
		if err := rows.Scan(&item.RequestID, &item.WorkspaceID, &item.AgentSessionID, &raw, &item.Status, &item.Attempt, &item.LeaseOwner, &item.LeaseExpiresAtMS, &item.NextAttemptAtMS, &item.LastError, &item.CreatedAtUnixMS, &item.UpdatedAtUnixMS); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(raw), &item.Payload); err != nil {
			item.PayloadError = fmt.Sprintf("decode goal reconcile inbox %s: %v", item.RequestID, err)
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *Store) ClaimGoalReconcileInbox(ctx context.Context, input ClaimGoalReconcileInboxInput) (GoalReconcileInboxItem, bool, error) {
	result, err := s.db.ExecContext(ctx, `UPDATE workspace_agent_goal_reconcile_inbox SET status='leased',lease_owner=?,lease_expires_at_unix_ms=?,attempt=attempt+1,updated_at_unix_ms=?
WHERE request_id=? AND ((status='prepared' AND next_attempt_at_unix_ms<=?) OR (status='leased' AND lease_expires_at_unix_ms<=?))`, input.LeaseOwner, input.LeaseExpiresAtMS, input.NowUnixMS, input.RequestID, input.NowUnixMS, input.NowUnixMS)
	if err != nil {
		return GoalReconcileInboxItem{}, false, err
	}
	changed, err := rowsWereAffected(result, "claim goal reconcile inbox")
	if err != nil || !changed {
		return GoalReconcileInboxItem{}, false, err
	}
	items, err := s.listGoalReconcileInboxByID(ctx, input.RequestID)
	if err != nil || len(items) == 0 {
		return GoalReconcileInboxItem{}, false, err
	}
	return items[0], true, nil
}

func (s *Store) listGoalReconcileInboxByID(ctx context.Context, id string) ([]GoalReconcileInboxItem, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT request_id,workspace_id,agent_session_id,payload_json,status,attempt,COALESCE(lease_owner,''),COALESCE(lease_expires_at_unix_ms,0),COALESCE(next_attempt_at_unix_ms,0),last_error,created_at_unix_ms,updated_at_unix_ms FROM workspace_agent_goal_reconcile_inbox WHERE request_id=?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []GoalReconcileInboxItem
	for rows.Next() {
		var x GoalReconcileInboxItem
		var raw string
		if err := rows.Scan(&x.RequestID, &x.WorkspaceID, &x.AgentSessionID, &raw, &x.Status, &x.Attempt, &x.LeaseOwner, &x.LeaseExpiresAtMS, &x.NextAttemptAtMS, &x.LastError, &x.CreatedAtUnixMS, &x.UpdatedAtUnixMS); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(raw), &x.Payload); err != nil {
			x.PayloadError = fmt.Sprintf("decode goal reconcile inbox %s: %v", x.RequestID, err)
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (s *Store) CompleteGoalReconcileInbox(ctx context.Context, requestID, owner string, now int64) (bool, error) {
	r, err := s.db.ExecContext(ctx, `UPDATE workspace_agent_goal_reconcile_inbox SET status='completed',lease_owner=NULL,lease_expires_at_unix_ms=NULL,next_attempt_at_unix_ms=NULL,updated_at_unix_ms=?,completed_at_unix_ms=? WHERE request_id=? AND status='leased' AND lease_owner=?`, now, now, requestID, owner)
	if err != nil {
		return false, err
	}
	return rowsWereAffected(r, "complete goal reconcile inbox")
}

func (s *Store) ReleaseGoalReconcileInbox(ctx context.Context, input ReleaseGoalReconcileInboxInput) (bool, error) {
	status := "prepared"
	var next any = input.NextAttemptAtMS
	if input.Fail {
		status = "failed"
		next = nil
	}
	r, err := s.db.ExecContext(ctx, `UPDATE workspace_agent_goal_reconcile_inbox SET status=?,lease_owner=NULL,lease_expires_at_unix_ms=NULL,next_attempt_at_unix_ms=?,last_error=?,updated_at_unix_ms=? WHERE request_id=? AND status='leased' AND lease_owner=?`, status, next, input.LastError, input.NowUnixMS, input.RequestID, input.LeaseOwner)
	if err != nil {
		return false, err
	}
	return rowsWereAffected(r, "release goal reconcile inbox")
}

func (s *Store) RequeueLeasedGoalReconcileInboxOnStartup(ctx context.Context, now int64) (int64, error) {
	r, err := s.db.ExecContext(ctx, `UPDATE workspace_agent_goal_reconcile_inbox SET status='prepared',lease_owner=NULL,lease_expires_at_unix_ms=NULL,next_attempt_at_unix_ms=?,updated_at_unix_ms=? WHERE status='leased'`, now, now)
	if err != nil {
		return 0, err
	}
	return r.RowsAffected()
}
