package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

var ErrDeleteSessionsPlanChanged = errors.New("workspace agent session deletion plan changed")

// PlanClearSessions resolves the exact canonical session set owned by one
// workspace. Host uses this snapshot to close live runtimes before issuing the
// same atomic batch deletion command used by scoped deletes.
func (s *Store) PlanClearSessions(
	ctx context.Context,
	workspaceID string,
) (DeleteSessionsPlan, error) {
	if s == nil || s.db == nil {
		return DeleteSessionsPlan{}, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return DeleteSessionsPlan{}, nil
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return DeleteSessionsPlan{}, fmt.Errorf("begin plan workspace agent sessions clear: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	sessionIDs, err := listAgentSessionIDsTx(ctx, tx, workspaceID)
	if err != nil {
		return DeleteSessionsPlan{}, err
	}
	if err := requireSessionForkDeleteAllowedTx(ctx, tx, workspaceID, sessionIDs); err != nil {
		return DeleteSessionsPlan{}, err
	}
	return DeleteSessionsPlan{
		WorkspaceID: workspaceID,
		SessionIDs:  normalizedSessionIDs(sessionIDs),
	}, nil
}

func (s *Store) PlanDeleteSessions(
	ctx context.Context,
	input DeleteSessionsBatchInput,
) (DeleteSessionsPlan, error) {
	if s == nil || s.db == nil {
		return DeleteSessionsPlan{}, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	sessionIDs := normalizedSessionIDs(input.SessionIDs)
	if workspaceID == "" || len(sessionIDs) == 0 {
		return DeleteSessionsPlan{}, nil
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return DeleteSessionsPlan{}, fmt.Errorf("begin plan workspace agent sessions delete: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	eligibleRootIDs, err := filterDeleteSessionRootsTx(ctx, tx, workspaceID, sessionIDs, input)
	if err != nil {
		return DeleteSessionsPlan{}, err
	}
	resolved, err := expandSessionTreeIDsTx(ctx, tx, workspaceID, eligibleRootIDs)
	if err != nil {
		return DeleteSessionsPlan{}, err
	}
	if err := requireSessionForkDeleteAllowedTx(ctx, tx, workspaceID, append(eligibleRootIDs, resolved...)); err != nil {
		return DeleteSessionsPlan{}, err
	}
	return DeleteSessionsPlan{WorkspaceID: workspaceID, SessionIDs: normalizedSessionIDs(resolved)}, nil
}

func (s *Store) DeleteSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (bool, error) {
	result, err := s.DeleteSessionWithCommit(ctx, workspaceID, agentSessionID)
	return result.RemovedSessions > 0, err
}

func (s *Store) DeleteSessionWithCommit(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (DeleteSessionResult, error) {
	if s == nil || s.db == nil {
		return DeleteSessionResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return DeleteSessionResult{}, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DeleteSessionResult{}, fmt.Errorf("begin delete workspace agent session: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	now := unixMs(time.Now().UTC())
	sessionClosureIDs, err := expandSessionTreeIDsTx(ctx, tx, workspaceID, []string{agentSessionID})
	if err != nil {
		return DeleteSessionResult{}, err
	}
	if err := requireSessionForkDeleteAllowedTx(ctx, tx, workspaceID, append([]string{agentSessionID}, sessionClosureIDs...)); err != nil {
		return DeleteSessionResult{}, err
	}
	mutations, err := sessionDeleteMutationsTx(ctx, tx, workspaceID, sessionClosureIDs, now)
	if err != nil {
		return DeleteSessionResult{}, err
	}
	removedMessages, removedSessions, removedSessionIDs, err := deleteSessionTreeRowsTx(ctx, tx, workspaceID, sessionClosureIDs, now)
	if err != nil {
		return DeleteSessionResult{}, err
	}
	delta, err := s.commitTransaction(ctx, tx, workspaceID, mutations)
	if err != nil {
		return DeleteSessionResult{}, fmt.Errorf("commit delete workspace agent session: %w", err)
	}
	committed = true
	return DeleteSessionResult{
		TransactionID: delta.TransactionID, CommitDelta: delta,
		RemovedMessages: removedMessages, RemovedSessions: removedSessions, RemovedSessionIDs: removedSessionIDs,
	}, nil
}

func (s *Store) DeleteSessionsBatch(
	ctx context.Context,
	input DeleteSessionsBatchInput,
) (DeleteSessionsBatchResult, error) {
	if s == nil || s.db == nil {
		return DeleteSessionsBatchResult{}, errors.New("workspace database is not initialized")
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

	result, err := s.DeleteSessionsBatchTx(ctx, tx, input)
	if err != nil {
		return DeleteSessionsBatchResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return DeleteSessionsBatchResult{}, fmt.Errorf("commit delete workspace agent sessions batch: %w", err)
	}
	committed = true
	return result, nil
}

// DeleteSessionsBatchTx deletes the full root/child closure inside a host-owned
// transaction. It lets an embedding host atomically remove domain rows that
// are keyed by agent session without introducing package-specific foreign
// keys into this reusable store.
func (s *Store) DeleteSessionsBatchTx(ctx context.Context, tx *sql.Tx, input DeleteSessionsBatchInput) (DeleteSessionsBatchResult, error) {
	if s == nil || tx == nil {
		return DeleteSessionsBatchResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	sessionIDs := normalizedSessionIDs(input.SessionIDs)
	if workspaceID == "" || len(sessionIDs) == 0 {
		return DeleteSessionsBatchResult{}, nil
	}
	eligibleRootIDs, err := filterDeleteSessionRootsTx(ctx, tx, workspaceID, sessionIDs, input)
	if err != nil {
		return DeleteSessionsBatchResult{}, err
	}
	sessionClosureIDs, err := expandSessionTreeIDsTx(ctx, tx, workspaceID, eligibleRootIDs)
	if err != nil {
		return DeleteSessionsBatchResult{}, err
	}
	if err := requireSessionForkDeleteAllowedTx(ctx, tx, workspaceID, append(eligibleRootIDs, sessionClosureIDs...)); err != nil {
		return DeleteSessionsBatchResult{}, err
	}
	if expected := normalizedSessionIDs(input.ExpectedSessionIDs); len(expected) > 0 && !equalStrings(expected, normalizedSessionIDs(sessionClosureIDs)) {
		return DeleteSessionsBatchResult{}, ErrDeleteSessionsPlanChanged
	}
	now := unixMs(time.Now().UTC())
	mutations, err := sessionDeleteMutationsTx(ctx, tx, workspaceID, sessionClosureIDs, now)
	if err != nil {
		return DeleteSessionsBatchResult{}, err
	}
	removedMessages, removedSessions, removedSessionIDs, err := deleteSessionTreeRowsTx(ctx, tx, workspaceID, sessionClosureIDs, now)
	if err != nil {
		return DeleteSessionsBatchResult{}, err
	}
	delta, err := s.participateTransaction(ctx, tx, workspaceID, mutations)
	if err != nil {
		return DeleteSessionsBatchResult{}, fmt.Errorf("participate in delete workspace agent sessions batch: %w", err)
	}
	return DeleteSessionsBatchResult{
		TransactionID:     delta.TransactionID,
		CommitDelta:       delta,
		RemovedMessages:   removedMessages,
		RemovedSessions:   removedSessions,
		RemovedSessionIDs: removedSessionIDs,
	}, nil
}

// filterDeleteSessionRootsTx applies optional ownership predicates to the
// requested root set. Project removal uses these predicates as a commit-time
// fence: a root that is pinned or moved after discovery is excluded, causing
// the expected deletion plan to change instead of deleting stale candidates.
func filterDeleteSessionRootsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	sessionIDs []string,
	input DeleteSessionsBatchInput,
) ([]string, error) {
	sectionKey := strings.TrimSpace(input.RequiredRootRailSectionKey)
	if sectionKey == "" && !input.ExcludePinnedRoots {
		return sessionIDs, nil
	}
	if len(sessionIDs) == 0 {
		return nil, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(sessionIDs)), ",")
	args := make([]any, 0, len(sessionIDs)+2)
	args = append(args, workspaceID)
	for _, sessionID := range sessionIDs {
		args = append(args, sessionID)
	}
	query := `
SELECT agent_session_id
FROM workspace_agent_sessions
WHERE workspace_id = ?
  AND agent_session_id IN (` + placeholders + `)
  AND session_kind = 'root'
  AND deleted_at_unix_ms = 0`
	if sectionKey != "" {
		query += " AND rail_section_key = ?"
		args = append(args, sectionKey)
	}
	if input.ExcludePinnedRoots {
		query += " AND pinned_at_unix_ms = 0"
	}
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("filter workspace agent session deletion roots: %w", err)
	}
	defer rows.Close()
	eligible := make([]string, 0, len(sessionIDs))
	for rows.Next() {
		var sessionID string
		if err := rows.Scan(&sessionID); err != nil {
			return nil, fmt.Errorf("scan workspace agent session deletion root: %w", err)
		}
		eligible = append(eligible, sessionID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace agent session deletion roots: %w", err)
	}
	return normalizedSessionIDs(eligible), nil
}

func normalizedSessionIDs(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
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

	removedSessionIDs, err := listAgentSessionIDsTx(ctx, tx, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, err
	}
	mutations, err := sessionDeleteMutationsTx(ctx, tx, workspaceID, removedSessionIDs, unixMs(time.Now().UTC()))
	if err != nil {
		return ClearSessionsResult{}, err
	}
	result, err := s.clearSessionsTx(ctx, tx, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, err
	}
	delta, err := s.commitTransaction(ctx, tx, workspaceID, mutations)
	if err != nil {
		return ClearSessionsResult{}, fmt.Errorf("commit clear workspace agent sessions: %w", err)
	}
	committed = true
	result.TransactionID = delta.TransactionID
	result.CommitDelta = delta
	return result, nil
}

// ClearSessionsTx hard-deletes a workspace's sessions and messages within
// the caller's transaction. Hosts that delete a workspace of their own and
// need the agent-row cascade to be atomic with that deletion should run
// both through one transaction via this method; the caller owns commit and
// rollback. The configured participant runs before return, so its marker is
// governed by that same caller-owned commit.
func (s *Store) ClearSessionsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
) (ClearSessionsResult, error) {
	removedSessionIDs, err := listAgentSessionIDsTx(ctx, tx, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, err
	}
	mutations, err := sessionDeleteMutationsTx(ctx, tx, workspaceID, removedSessionIDs, unixMs(time.Now().UTC()))
	if err != nil {
		return ClearSessionsResult{}, err
	}
	result, err := s.clearSessionsTx(ctx, tx, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, err
	}
	delta, err := s.participateTransaction(ctx, tx, workspaceID, mutations)
	if err != nil {
		return ClearSessionsResult{}, err
	}
	result.TransactionID = delta.TransactionID
	result.CommitDelta = delta
	return result, nil
}

func (s *Store) clearSessionsTx(
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
	if err := requireSessionForkDeleteAllowedTx(ctx, tx, workspaceID, removedSessionIDs); err != nil {
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
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_agent_goal_generation_fences WHERE workspace_id = ?`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent goal generation fences: %w", err)
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
DELETE FROM workspace_agent_turn_submissions
WHERE workspace_id = ?
`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent turn submissions: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_turn_history
WHERE workspace_id = ?
`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent turn history: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_turns
WHERE workspace_id = ?
`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent turns: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_agent_session_history
WHERE workspace_id = ?
`, workspaceID); err != nil {
		return ClearSessionsResult{}, fmt.Errorf("clear workspace agent session history: %w", err)
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

func sessionDeleteMutations(workspaceID string, sessionIDs []string, version int64) []TransactionMutation {
	mutations := make([]TransactionMutation, 0, len(sessionIDs))
	for _, agentSessionID := range sessionIDs {
		mutations = append(mutations, transactionMutation(
			workspaceID, agentSessionID, MutationEntitySession, agentSessionID, "delete", version,
		))
	}
	return mutations
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
