package storesqlite

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// AdoptProviderGoalOperation records a Goal that the provider already created
// from inside an accepted Turn. Unlike PrepareGoalControlOperation, this path
// never schedules a provider mutation: the operation and converged state land
// completed in one transaction.
func (s *Store) AdoptProviderGoalOperation(ctx context.Context, input ProviderGoalAdoption) (GoalControlOperation, SessionGoalState, bool, error) {
	if s == nil || s.db == nil {
		return GoalControlOperation{}, SessionGoalState{}, false, errors.New("workspace database is not initialized")
	}
	input.OperationID = strings.TrimSpace(input.OperationID)
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.ClientSubmitID = strings.TrimSpace(input.ClientSubmitID)
	input.Goal = cloneJSONMap(input.Goal)
	objective := strings.TrimSpace(asJSONMapString(input.Goal, "objective"))
	status := strings.TrimSpace(asJSONMapString(input.Goal, "status"))
	if input.OperationID == "" || input.WorkspaceID == "" || input.AgentSessionID == "" ||
		input.ClientSubmitID == "" || input.ExpectedRevision < 0 || input.OccurredAtUnixMS <= 0 {
		return GoalControlOperation{}, SessionGoalState{}, false, errors.New("provider goal adoption identity, scope, and occurred time are required")
	}
	if objective == "" || status != "active" {
		return GoalControlOperation{}, SessionGoalState{}, false, errors.New("provider goal adoption requires an active objective")
	}
	if jsonMapInt64(input.Goal, "startedAtUnixMs") <= 0 {
		input.Goal["startedAtUnixMs"] = input.OccurredAtUnixMS
	}
	goalJSON, err := marshalNullableJSONMap(input.Goal)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, fmt.Errorf("begin provider goal adoption: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if existing, found, readErr := getGoalControlOperationTx(ctx, tx, input.WorkspaceID, input.OperationID); readErr != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, readErr
	} else if found {
		state, stateFound, stateErr := getSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID)
		if stateErr != nil {
			return GoalControlOperation{}, SessionGoalState{}, false, stateErr
		}
		currentOperationID := strings.TrimSpace(asJSONMapString(state.LastEvidence, "operationId"))
		if !stateFound || existing.AgentSessionID != input.AgentSessionID || existing.Action != "set" ||
			existing.Objective != objective || existing.ClientSubmitID != input.ClientSubmitID ||
			existing.Status != GoalOperationStatusCompleted || existing.ProviderPhase != GoalProviderPhaseApplied ||
			existing.GoalRevision != state.Revision || currentOperationID != existing.OperationID ||
			!goalStateConverged(state.Desired, input.Goal, state.Tombstoned) ||
			!goalStateConverged(state.Observed, input.Goal, state.Tombstoned) {
			return GoalControlOperation{}, SessionGoalState{}, false, ErrGoalOperationConflict
		}
		if _, err := s.commitTransaction(ctx, tx, input.WorkspaceID, nil); err != nil {
			return GoalControlOperation{}, SessionGoalState{}, false, err
		}
		committed = true
		return existing, state, false, nil
	}
	if err := requireSessionForkSourceWritableTx(ctx, tx, input.WorkspaceID, input.AgentSessionID); err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}

	state, found, err := getSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	if !found {
		state, err = bootstrapSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID, input.OccurredAtUnixMS)
		if err != nil {
			return GoalControlOperation{}, SessionGoalState{}, false, err
		}
	}
	if state.PendingOperationID != "" {
		return GoalControlOperation{}, state, false, ErrGoalOperationConflict
	}
	if state.Revision != input.ExpectedRevision {
		return GoalControlOperation{}, state, false, ErrGoalGenerationSuperseded
	}
	if state.Revision > 0 && !providerGoalAdoptionMayAdvance(state) {
		return GoalControlOperation{}, state, false, ErrGoalOperationConflict
	}

	revision := state.Revision + 1
	evidence := cloneJSONMap(input.Evidence)
	if evidence == nil {
		evidence = map[string]any{}
	}
	evidence["operationId"] = input.OperationID
	evidence["revision"] = revision
	evidence["repairEpoch"] = int64(0)
	evidenceJSON := marshalJSONMapOrEmpty(evidence)
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_session_goals (
  workspace_id, agent_session_id, desired_json, observed_json, revision,
  tombstoned, sync_status, pending_operation_id, last_evidence_json,
  last_error, observed_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, '', ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id) DO UPDATE SET
  desired_json = excluded.desired_json,
  observed_json = excluded.observed_json,
  revision = excluded.revision,
  tombstoned = 0,
  sync_status = excluded.sync_status,
  pending_operation_id = NULL,
  execution_pending = 0,
  last_evidence_json = excluded.last_evidence_json,
  last_error = '',
  observed_at_unix_ms = excluded.observed_at_unix_ms,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, input.WorkspaceID, input.AgentSessionID, goalJSON, goalJSON, revision,
		GoalSyncStatusSynced, evidenceJSON, input.OccurredAtUnixMS, state.CreatedAtUnixMS, input.OccurredAtUnixMS); err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, fmt.Errorf("write adopted provider goal state: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_goal_control_operations (
  operation_id, workspace_id, agent_session_id, goal_revision, action,
  objective, status, evidence_json, provider_phase, completed_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms, client_submit_id
) VALUES (?, ?, ?, ?, 'set', ?, ?, ?, ?, ?, ?, ?, ?)
`, input.OperationID, input.WorkspaceID, input.AgentSessionID, revision, objective,
		GoalOperationStatusCompleted, evidenceJSON, GoalProviderPhaseApplied, input.OccurredAtUnixMS,
		input.OccurredAtUnixMS, input.OccurredAtUnixMS, input.ClientSubmitID); err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, fmt.Errorf("insert adopted provider goal operation: %w", err)
	}
	op, _, err := getGoalControlOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	state, _, err = getSessionGoalStateTx(ctx, tx, input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, err
	}
	delta, err := s.commitTransaction(ctx, tx, input.WorkspaceID, []TransactionMutation{
		transactionMutation(input.WorkspaceID, input.AgentSessionID, MutationEntityGoalState, input.AgentSessionID, "upsert", revision),
		transactionMutation(input.WorkspaceID, input.AgentSessionID, MutationEntityGoalOperation, input.OperationID, "adopt", op.UpdatedAtUnixMS),
	})
	if err != nil {
		return GoalControlOperation{}, SessionGoalState{}, false, fmt.Errorf("commit provider goal adoption: %w", err)
	}
	committed = true
	op.CommitTransactionID = delta.TransactionID
	op.CommitDelta = delta
	state.CommitTransactionID = delta.TransactionID
	state.CommitDelta = delta
	return op, state, true, nil
}

func providerGoalAdoptionMayAdvance(state SessionGoalState) bool {
	if state.Revision == 0 || state.Tombstoned {
		return true
	}
	switch strings.TrimSpace(asJSONMapString(state.Observed, "status")) {
	case "complete", "completed", "blocked", "limited", "failed", "usageLimited", "budgetLimited":
		return true
	default:
		return false
	}
}
