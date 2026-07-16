package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (s *Store) DeleteSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (bool, error) {
	if s == nil || s.db == nil {
		return false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return false, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin delete workspace agent session: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	now := unixMs(time.Now().UTC())
	removedSessionIDs, err := expandSessionTreeIDsTx(ctx, tx, workspaceID, []string{agentSessionID})
	if err != nil {
		return false, err
	}
	// Always clear exact provenance, including on an idempotent repeat. A
	// delayed provider ACK may have raced the first soft-delete, and a reused
	// session id must not inherit that orphan binding.
	if err := deleteGoalProvenanceForSessionTx(ctx, tx, workspaceID, agentSessionID); err != nil {
		return false, err
	}
	for _, removedSessionID := range removedSessionIDs {
		if err := deleteRuntimeOperationRecordsForSessionTx(ctx, tx, workspaceID, removedSessionID); err != nil {
			return false, err
		}
		if err := deleteGoalRecordsForSessionTx(ctx, tx, workspaceID, removedSessionID); err != nil {
			return false, err
		}
	}
	_, removedSessions, err := deleteSessionTreeRowsTx(ctx, tx, workspaceID, removedSessionIDs, now)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit delete workspace agent session: %w", err)
	}
	committed = true
	return removedSessions > 0, nil
}

func (s *Store) DeleteSessionsBatch(
	ctx context.Context,
	input DeleteSessionsBatchInput,
) (DeleteSessionsBatchResult, error) {
	if s == nil || s.db == nil {
		return DeleteSessionsBatchResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	sessionIDs := make([]string, 0, len(input.SessionIDs))
	seenSessionIDs := make(map[string]struct{}, len(input.SessionIDs))
	for _, value := range input.SessionIDs {
		sessionID := strings.TrimSpace(value)
		if sessionID == "" {
			continue
		}
		if _, exists := seenSessionIDs[sessionID]; exists {
			continue
		}
		seenSessionIDs[sessionID] = struct{}{}
		sessionIDs = append(sessionIDs, sessionID)
	}
	if workspaceID == "" || len(sessionIDs) == 0 {
		return DeleteSessionsBatchResult{}, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DeleteSessionsBatchResult{}, fmt.Errorf("begin delete workspace agent sessions batch: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	removedSessionIDs, err := expandSessionTreeIDsTx(ctx, tx, workspaceID, sessionIDs)
	if err != nil {
		return DeleteSessionsBatchResult{}, err
	}
	now := unixMs(time.Now().UTC())
	for _, agentSessionID := range sessionIDs {
		if err := deleteGoalProvenanceForSessionTx(ctx, tx, workspaceID, agentSessionID); err != nil {
			return DeleteSessionsBatchResult{}, err
		}
	}
	for _, agentSessionID := range removedSessionIDs {
		if err := deleteRuntimeOperationRecordsForSessionTx(ctx, tx, workspaceID, agentSessionID); err != nil {
			return DeleteSessionsBatchResult{}, err
		}
		if err := deleteGoalRecordsForSessionTx(ctx, tx, workspaceID, agentSessionID); err != nil {
			return DeleteSessionsBatchResult{}, err
		}
	}
	removedMessages, removedSessions, err := deleteSessionTreeRowsTx(ctx, tx, workspaceID, removedSessionIDs, now)
	if err != nil {
		return DeleteSessionsBatchResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return DeleteSessionsBatchResult{}, fmt.Errorf("commit delete workspace agent sessions batch: %w", err)
	}
	committed = true
	return DeleteSessionsBatchResult{
		RemovedMessages:   removedMessages,
		RemovedSessions:   removedSessions,
		RemovedSessionIDs: removedSessionIDs,
	}, nil
}

func deleteGoalRecordsForSessionTx(ctx context.Context, tx *sql.Tx, workspaceID string, agentSessionID string) error {
	if err := deleteGoalProvenanceForSessionTx(ctx, tx, workspaceID, agentSessionID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_goal_reconcile_inbox WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
		return fmt.Errorf("delete workspace agent goal reconcile inbox: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_goal_repair_incidents WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
		return fmt.Errorf("delete workspace agent goal repair incidents: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_goal_control_operations WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
		return fmt.Errorf("delete workspace agent session goal operations: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_session_goals WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
		return fmt.Errorf("delete workspace agent session goal state: %w", err)
	}
	return nil
}

func deleteGoalProvenanceForSessionTx(ctx context.Context, tx *sql.Tx, workspaceID string, agentSessionID string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_goal_provenance_ledger WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
		return fmt.Errorf("delete workspace agent goal provenance ledger: %w", err)
	}
	return nil
}

func deleteRuntimeOperationRecordsForSessionTx(ctx context.Context, tx *sql.Tx, workspaceID string, agentSessionID string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_runtime_operation_events WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
		return fmt.Errorf("delete workspace agent session runtime operation events: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_runtime_operations WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, agentSessionID); err != nil {
		return fmt.Errorf("delete workspace agent session runtime operations: %w", err)
	}
	return nil
}

func (s *Store) ClearSessions(
	ctx context.Context,
	workspaceID string,
) (ClearSessionsResult, error) {
	if s == nil || s.db == nil {
		return ClearSessionsResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return ClearSessionsResult{}, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("begin clear workspace agent sessions: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	result, err := s.ClearSessionsTx(ctx, tx, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("commit clear workspace agent sessions: %w", err)
	}
	committed = true
	return result, nil
}

// ClearSessionsTx hard-deletes a workspace's sessions and messages within
// the caller's transaction. Hosts that delete a workspace of their own and
// need the agent-row cascade to be atomic with that deletion should run
// both through one transaction via this method; the caller owns commit and
// rollback.
func (s *Store) ClearSessionsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
) (ClearSessionsResult, error) {
	if s == nil || tx == nil {
		return ClearSessionsResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return ClearSessionsResult{}, nil
	}

	removedSessionIDs, err := listAgentSessionIDsTx(ctx, tx, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, err
	}
	messageResult, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_messages
WHERE workspace_id = ?
`, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent messages: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_submit_claims WHERE workspace_id = ?`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent submit claims: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_runtime_operation_events WHERE workspace_id = ?`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent runtime operation events: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_runtime_operations WHERE workspace_id = ?`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent runtime operations: %w", err)
	}
	// Goal cleanup is explicit and ordered because hosts may run with foreign
	// keys disabled; a reused session id must never inherit an old Goal saga.
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_goal_provenance_ledger WHERE workspace_id = ?`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent goal provenance ledger: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_goal_reconcile_inbox WHERE workspace_id = ?`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent goal reconcile inbox: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_goal_repair_incidents WHERE workspace_id = ?`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent goal repair incidents: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_goal_control_operations WHERE workspace_id = ?`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent goal operations: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_session_goals WHERE workspace_id = ?`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent goal state: %w", err)
	}
	// Explicit deletes rather than FK cascades: SQLite only cascades with
	// PRAGMA foreign_keys enabled, which hosts do not guarantee.
	if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_interactions
WHERE workspace_id = ?
`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent interactions: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_turns
WHERE workspace_id = ?
`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent turns: %w", err)
	}
	sessionResult, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_sessions
WHERE workspace_id = ?
`, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent sessions: %w", err)
	}
	removedMessages, err := messageResult.RowsAffected()
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent messages rows affected: %w", err)
	}
	removedSessions, err := sessionResult.RowsAffected()
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent sessions rows affected: %w", err)
	}
	return ClearSessionsResult{
		RemovedMessages:   int(removedMessages),
		RemovedSessions:   int(removedSessions),
		RemovedSessionIDs: removedSessionIDs,
	}, nil
}

func listAgentSessionIDsTx(ctx context.Context, tx *sql.Tx, workspaceID string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `
SELECT agent_session_id
FROM workspace_agent_sessions
WHERE workspace_id = ?
ORDER BY updated_at_unix_ms DESC, agent_session_id ASC
`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list workspace agent sessions for clear: %w", err)
	}
	defer rows.Close()

	sessionIDs := make([]string, 0)
	for rows.Next() {
		var sessionID string
		if err := rows.Scan(&sessionID); err != nil {
			return nil, fmt.Errorf("scan workspace agent session id for clear: %w", err)
		}
		sessionID = strings.TrimSpace(sessionID)
		if sessionID != "" {
			sessionIDs = append(sessionIDs, sessionID)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace agent session ids for clear: %w", err)
	}
	return sessionIDs, nil
}
