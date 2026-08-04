package storesqlite

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// ClearAbandonedEditRetryFence clears one session's effective-history fence back
// to ready when the edit-retry operation that owns it can no longer make
// progress: the owning operation is missing (e.g. removed by an older rescue
// script) or already terminal (failed/completed). Fences owned by an in-flight
// (prepared/leased) operation are left untouched — while durable edit-retry is
// disabled those are quarantined by the recovery worker, which clears the fence
// itself. This exists for sessions fenced before the feature was neutralized
// (e.g. recovery_required from FailEditRetryRecovery, or a failed operation
// quarantined without a fence clear); without it those sessions would reject
// every send forever. Returns whether the fence was cleared.
func (s *Store) ClearAbandonedEditRetryFence(ctx context.Context, input ClearAbandonedEditRetryFenceInput) (bool, error) {
	if s == nil || s.db == nil {
		return false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	if input.WorkspaceID == "" || input.AgentSessionID == "" || input.NowUnixMS <= 0 {
		return false, errors.New("valid edit retry fence clear input is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin edit retry fence clear: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	update, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_history
SET recovery_state = 'ready', operation_id = '', updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ?
  AND recovery_state != 'ready'
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_runtime_operations o
    WHERE o.workspace_id = workspace_agent_session_history.workspace_id
      AND o.operation_id = workspace_agent_session_history.operation_id
      AND o.status IN ('prepared','leased','blocked'))
`, input.NowUnixMS, input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return false, fmt.Errorf("clear abandoned edit retry fence: %w", err)
	}
	changed, err := rowsWereAffected(update, "clear abandoned edit retry fence")
	if err != nil {
		return false, err
	}
	if !changed {
		return false, nil
	}
	var revision int64
	if err := tx.QueryRowContext(ctx, `
SELECT history_revision FROM workspace_agent_session_history
WHERE workspace_id = ? AND agent_session_id = ?
`, input.WorkspaceID, input.AgentSessionID).Scan(&revision); err != nil {
		return false, fmt.Errorf("read edit retry fence clear history revision: %w", err)
	}
	if _, err := s.commitTransaction(ctx, tx, input.WorkspaceID, []TransactionMutation{
		transactionMutation(input.WorkspaceID, input.AgentSessionID, MutationEntitySession, input.AgentSessionID, "history_edit_retry_fence_cleared", revision),
	}); err != nil {
		return false, fmt.Errorf("commit edit retry fence clear: %w", err)
	}
	committed = true
	return true, nil
}
