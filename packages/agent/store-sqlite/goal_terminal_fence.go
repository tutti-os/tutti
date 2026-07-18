package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

const goalRepairBudgetExhaustedError = "goal repair incident budget exhausted"

// goalRevisionTerminalFenceTx is the single transaction-scoped read for the
// revision terminal fence. Every bottom-up path that derives sync_status must
// consult it before claiming convergence.
func goalRevisionTerminalFenceTx(ctx context.Context, tx *sql.Tx, workspaceID, agentSessionID string, revision int64) (bool, error) {
	if revision <= 0 {
		return false, nil
	}
	var terminal int
	err := tx.QueryRowContext(ctx, `SELECT terminal FROM workspace_agent_goal_repair_incidents
WHERE workspace_id=? AND agent_session_id=? AND goal_revision=?`, workspaceID, agentSessionID, revision).Scan(&terminal)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return terminal != 0, err
}

func setGoalRevisionTerminalFenceTx(ctx context.Context, tx *sql.Tx, state SessionGoalState, generationCount int, sourceID, lastError string, occurredAt int64) error {
	if generationCount <= maxGoalRepairIncidentGenerations {
		generationCount = maxGoalRepairIncidentGenerations + 1
	}
	lastError = strings.TrimSpace(lastError)
	if lastError == "" {
		lastError = goalRepairBudgetExhaustedError
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO workspace_agent_goal_repair_incidents
(workspace_id,agent_session_id,goal_revision,generation_count,terminal,last_source_id,updated_at_unix_ms)
VALUES(?,?,?,?,1,?,?) ON CONFLICT(workspace_id,agent_session_id,goal_revision) DO UPDATE SET
generation_count=MAX(workspace_agent_goal_repair_incidents.generation_count,excluded.generation_count),terminal=1,
last_source_id=excluded.last_source_id,updated_at_unix_ms=excluded.updated_at_unix_ms`,
		state.WorkspaceID, state.AgentSessionID, state.Revision, generationCount, strings.TrimSpace(sourceID), occurredAt); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE workspace_agent_session_goals
SET sync_status=?,last_error=?,pending_operation_id=NULL,updated_at_unix_ms=?
WHERE workspace_id=? AND agent_session_id=? AND revision=?`, GoalSyncStatusUnknown, lastError, occurredAt,
		state.WorkspaceID, state.AgentSessionID, state.Revision)
	return err
}

func terminalGoalSyncState(state SessionGoalState, candidateStatus, candidateLastError string, terminal bool) (string, string) {
	if !terminal {
		return candidateStatus, strings.TrimSpace(candidateLastError)
	}
	lastError := strings.TrimSpace(state.LastError)
	if lastError == "" {
		lastError = strings.TrimSpace(candidateLastError)
	}
	if lastError == "" {
		lastError = goalRepairBudgetExhaustedError
	}
	return GoalSyncStatusUnknown, lastError
}

func (s *Store) MarkGoalRevisionTerminalIncident(ctx context.Context, input GoalTerminalIncidentInput) (SessionGoalState, error) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.SourceID = strings.TrimSpace(input.SourceID)
	if input.WorkspaceID == "" || input.AgentSessionID == "" || input.Revision <= 0 || input.SourceID == "" || input.OccurredAtUnixMS <= 0 {
		return SessionGoalState{}, errors.New("valid goal terminal incident identity is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SessionGoalState{}, err
	}
	defer func() { _ = tx.Rollback() }()
	state, found, err := getSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return SessionGoalState{}, err
	}
	if !found || state.Revision != input.Revision {
		return SessionGoalState{}, ErrGoalReconcileConflict
	}
	if input.Expected != nil && (!input.Expected.Exists || state.Revision != input.Expected.Revision ||
		state.PendingOperationID != strings.TrimSpace(input.Expected.PendingOperationID) || state.ObservedAtUnixMS != input.Expected.ObservedAtUnixMS) {
		return SessionGoalState{}, ErrGoalReconcileConflict
	}
	if err := setGoalRevisionTerminalFenceTx(ctx, tx, state, maxGoalRepairIncidentGenerations+1, input.SourceID, input.LastError, input.OccurredAtUnixMS); err != nil {
		return SessionGoalState{}, err
	}
	state, _, err = getSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return SessionGoalState{}, err
	}
	delta, err := s.commitTransaction(ctx, tx, input.WorkspaceID, []TransactionMutation{
		transactionMutation(input.WorkspaceID, input.AgentSessionID, MutationEntityGoalState, input.AgentSessionID, "terminal", state.Revision),
	})
	if err != nil {
		return SessionGoalState{}, err
	}
	state.CommitTransactionID = delta.TransactionID
	state.CommitDelta = delta
	return state, nil
}
