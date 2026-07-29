package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

func (s *SQLiteStore) AdmitTuttiModeMutation(
	ctx context.Context,
	admission executionbiz.MutationAdmission,
) (executionbiz.MutationResult, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return executionbiz.MutationResult{}, err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return executionbiz.MutationResult{}, fmt.Errorf("begin Tutti mode mutation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	replayed, found, err := getTuttiModeMutationReplay(ctx, tx, admission)
	if err != nil || found {
		return replayed, err
	}
	executionID, err := validateTuttiModeMutationFence(ctx, tx, admission)
	if err != nil {
		return executionbiz.MutationResult{}, err
	}
	tasks, err := listTuttiModeMutationTasks(ctx, tx, admission)
	if err != nil {
		return executionbiz.MutationResult{}, err
	}
	result := executionbiz.MutationResult{
		ExecutionID: executionID, CheckpointID: admission.CheckpointID,
		GraphRevision: admission.ExpectedGraphRevision + 1,
		AddedTaskIDs:  []string{}, UpdatedTaskIDs: []string{}, SupersededTaskIDs: []string{},
	}
	graph, err := executionbiz.ApplyMutationGraph(executionbiz.MutationGraphInput{
		WorkspaceID: admission.WorkspaceID,
		IssueID:     admission.IssueID,
		Tasks:       tasks,
		Operations:  admission.Operations,
		Now:         admission.Now,
	})
	if err != nil {
		return executionbiz.MutationResult{}, err
	}
	for _, task := range graph.InsertedTasks {
		if _, err := insertWorkspaceIssueTask(ctx, tx, task); err != nil {
			return executionbiz.MutationResult{}, executionbiz.Reject(
				executionbiz.ErrMutationRejected,
				executionbiz.RejectionDuplicateTask,
				task.TaskID,
			)
		}
	}
	for _, task := range graph.UpdatedTasks {
		if err := updateTuttiModeMutationTask(ctx, tx, task); err != nil {
			return executionbiz.MutationResult{}, err
		}
	}
	result.AddedTaskIDs = graph.AddedTaskIDs
	result.UpdatedTaskIDs = graph.UpdatedTaskIDs
	result.SupersededTaskIDs = graph.SupersededTaskIDs
	if err := projectScheduledTuttiModeIssue(
		ctx, tx, admission.WorkspaceID, admission.IssueID, admission.Now,
	); err != nil {
		return executionbiz.MutationResult{}, err
	}
	if err := rebindTuttiModeMutationFence(ctx, tx, executionID, admission, result.GraphRevision); err != nil {
		return executionbiz.MutationResult{}, err
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return executionbiz.MutationResult{}, err
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_tutti_execution_mutations (
  workspace_id, execution_id, issue_id, source_session_id, kind, request_id,
  input_sha256, checkpoint_id, expected_graph_revision, result_graph_revision,
  result_json, created_at_unix_ms
) VALUES (?, ?, ?, ?, 'mutate', ?, ?, ?, ?, ?, ?, ?)
`, admission.WorkspaceID, executionID, admission.IssueID, admission.SourceSessionID,
		admission.RequestID, admission.InputSHA256, admission.CheckpointID,
		admission.ExpectedGraphRevision, result.GraphRevision, string(resultJSON), unixMs(admission.Now))
	if err != nil {
		if isSQLiteUniqueConstraintError(err) {
			return executionbiz.MutationResult{}, executionbiz.ErrMutationConflict
		}
		return executionbiz.MutationResult{}, fmt.Errorf("record Tutti mode mutation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return executionbiz.MutationResult{}, fmt.Errorf("commit Tutti mode mutation: %w", err)
	}
	return result, nil
}

func getTuttiModeMutationReplay(
	ctx context.Context,
	tx *sql.Tx,
	admission executionbiz.MutationAdmission,
) (executionbiz.MutationResult, bool, error) {
	var inputSHA256, resultJSON string
	err := tx.QueryRowContext(ctx, `
SELECT input_sha256, result_json
FROM workspace_tutti_execution_mutations
WHERE workspace_id = ? AND source_session_id = ? AND kind = 'mutate'
  AND issue_id = ? AND request_id = ?
`, admission.WorkspaceID, admission.SourceSessionID, admission.IssueID, admission.RequestID).
		Scan(&inputSHA256, &resultJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return executionbiz.MutationResult{}, false, nil
	}
	if err != nil {
		return executionbiz.MutationResult{}, false, fmt.Errorf("get Tutti mode mutation replay: %w", err)
	}
	if inputSHA256 != admission.InputSHA256 {
		return executionbiz.MutationResult{}, false, executionbiz.ErrMutationConflict
	}
	var result executionbiz.MutationResult
	if err := json.Unmarshal([]byte(resultJSON), &result); err != nil {
		return executionbiz.MutationResult{}, false, fmt.Errorf("decode Tutti mode mutation replay: %w", err)
	}
	result.Replayed = true
	return result, true, nil
}

func validateTuttiModeMutationFence(
	ctx context.Context,
	tx *sql.Tx,
	admission executionbiz.MutationAdmission,
) (string, error) {
	var executionID, sourceSessionID, status string
	var graphRevision int64
	err := tx.QueryRowContext(ctx, `
SELECT execution_id, source_session_id, status, graph_revision
FROM workspace_tutti_executions
WHERE workspace_id = ? AND issue_id = ?
`, admission.WorkspaceID, admission.IssueID).
		Scan(&executionID, &sourceSessionID, &status, &graphRevision)
	if errors.Is(err, sql.ErrNoRows) {
		return "", executionbiz.ErrExecutionNotFound
	}
	if err != nil {
		return "", fmt.Errorf("get Tutti mode mutation fence: %w", err)
	}
	if sourceSessionID != admission.SourceSessionID {
		return "", executionbiz.Reject(
			executionbiz.ErrMutationRejected, executionbiz.RejectionWrongSourceSession, "",
		)
	}
	if graphRevision != admission.ExpectedGraphRevision {
		return "", executionbiz.Reject(
			executionbiz.ErrMutationRejected, executionbiz.RejectionStaleGraphRevision, "",
		)
	}
	if status != string(executionbiz.StatusAwaitingSchedule) &&
		status != string(executionbiz.StatusAwaitingMain) &&
		status != string(executionbiz.StatusPendingGoalReview) {
		return "", executionbiz.Reject(
			executionbiz.ErrMutationRejected, executionbiz.RejectionInactiveExecution, "",
		)
	}
	var checkpointStatus string
	var checkpointRevision int64
	err = tx.QueryRowContext(ctx, `
SELECT status, graph_revision
FROM workspace_tutti_execution_checkpoints
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
`, admission.WorkspaceID, executionID, admission.CheckpointID).
		Scan(&checkpointStatus, &checkpointRevision)
	if err != nil || checkpointStatus != string(executionbiz.CheckpointStatusActive) {
		return "", executionbiz.Reject(
			executionbiz.ErrMutationRejected, executionbiz.RejectionInactiveCheckpoint, "",
		)
	}
	if checkpointRevision != admission.ExpectedGraphRevision {
		return "", executionbiz.Reject(
			executionbiz.ErrMutationRejected, executionbiz.RejectionStaleGraphRevision, "",
		)
	}
	var planningSource, issueSourceSessionID string
	err = tx.QueryRowContext(ctx, `
SELECT planning_source, source_session_id
FROM workspace_issues WHERE workspace_id = ? AND issue_id = ?
`, admission.WorkspaceID, admission.IssueID).Scan(&planningSource, &issueSourceSessionID)
	if err != nil || planningSource != string(workspaceissues.PlanningSourceTuttiModePlan) {
		return "", executionbiz.Reject(
			executionbiz.ErrMutationRejected, executionbiz.RejectionInactiveExecution, "",
		)
	}
	if issueSourceSessionID != admission.SourceSessionID {
		return "", executionbiz.Reject(
			executionbiz.ErrMutationRejected, executionbiz.RejectionWrongSourceSession, "",
		)
	}
	return executionID, nil
}

func listTuttiModeMutationTasks(
	ctx context.Context,
	tx *sql.Tx,
	admission executionbiz.MutationAdmission,
) (map[string]workspaceissues.Task, error) {
	rows, err := tx.QueryContext(ctx, fmt.Sprintf(`
SELECT %s FROM workspace_issue_tasks
WHERE workspace_id = ? AND issue_id = ?
ORDER BY sort_index ASC, id ASC
`, taskSelectColumns), admission.WorkspaceID, admission.IssueID)
	if err != nil {
		return nil, fmt.Errorf("list Tutti mode mutation tasks: %w", err)
	}
	items, err := scanWorkspaceIssueTasks(rows)
	closeErr := rows.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	result := make(map[string]workspaceissues.Task, len(items))
	for _, task := range items {
		result[task.TaskID] = task
	}
	return result, nil
}

func updateTuttiModeMutationTask(
	ctx context.Context,
	tx *sql.Tx,
	task workspaceissues.Task,
) error {
	dependencies, err := json.Marshal(task.DependencyTaskIDs)
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_issue_tasks
SET title = ?, content = ?, search_text = ?, priority = ?, due_at_unix_ms = ?,
    agent_target_id = ?, model_plan_id = ?, model = ?, permission_mode_id = ?,
    reasoning_effort = ?, execution_directory = ?, dependency_task_ids_json = ?,
    parallelizable = ?, auto_accept = ?, superseded_at_unix_ms = ?,
    superseded_by_task_id = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND task_id = ?
`, task.Title, task.Content, task.SearchText, string(task.Priority), task.DueAtUnixMS,
		task.AgentTargetID, task.ModelPlanID, task.Model, task.PermissionModeID,
		task.ReasoningEffort, task.ExecutionDirectory, string(dependencies),
		task.Parallelizable, task.AutoAccept, task.SupersededAtUnixMS,
		task.SupersededByTaskID, task.UpdatedAtUnixMS,
		task.WorkspaceID, task.IssueID, task.TaskID)
	if err != nil {
		return fmt.Errorf("update Tutti mode mutation task: %w", err)
	}
	return requireRowsAffected(result, executionbiz.ErrMutationRejected, "update Tutti mode mutation task")
}

func rebindTuttiModeMutationFence(
	ctx context.Context,
	tx *sql.Tx,
	executionID string,
	admission executionbiz.MutationAdmission,
	graphRevision int64,
) error {
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_execution_checkpoints
SET graph_revision = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
  AND status = 'active' AND graph_revision = ?
`, graphRevision, unixMs(admission.Now), admission.WorkspaceID, executionID,
		admission.CheckpointID, admission.ExpectedGraphRevision)
	if err != nil {
		return fmt.Errorf("rebind Tutti mode mutation checkpoint: %w", err)
	}
	if err := requireRowsAffected(result, executionbiz.ErrMutationRejected, "rebind Tutti mode mutation checkpoint"); err != nil {
		return err
	}
	if err := supersedeTuttiModeGoalReview(ctx, tx, executionID, admission); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
UPDATE workspace_tutti_execution_checkpoints
SET status = 'superseded', updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND status = 'pending'
  AND kind = 'all_tasks_terminal' AND graph_revision < ?
`, unixMs(admission.Now), admission.WorkspaceID, executionID, graphRevision)
	if err != nil {
		return fmt.Errorf("supersede stale Tutti mode terminal checkpoints: %w", err)
	}
	result, err = tx.ExecContext(ctx, `
UPDATE workspace_tutti_executions
SET status = 'awaiting_main', graph_revision = ?,
    last_orchestrator_activity_at_unix_ms = ?, watchdog_due_at_unix_ms = ?,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND graph_revision = ?
`, graphRevision, unixMs(admission.Now),
		unixMs(admission.Now.Add(executionbiz.WatchdogInterval)), unixMs(admission.Now),
		admission.WorkspaceID, executionID, admission.ExpectedGraphRevision)
	if err != nil {
		return fmt.Errorf("advance Tutti mode mutation revision: %w", err)
	}
	return requireRowsAffected(result, executionbiz.ErrMutationRejected, "advance Tutti mode mutation revision")
}

func supersedeTuttiModeGoalReview(
	ctx context.Context,
	tx *sql.Tx,
	executionID string,
	admission executionbiz.MutationAdmission,
) error {
	nowUnixMS := unixMs(admission.Now)
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_goal_reviews
SET status = 'canceled', failure_reason = 'graph_superseded',
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
  AND status IN ('prepared', 'dispatched')
`, nowUnixMS, admission.WorkspaceID, executionID, admission.CheckpointID); err != nil {
		return fmt.Errorf("supersede stale Tutti mode Goal Review: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET status = 'canceled', lease_owner = '', lease_expires_at_unix_ms = 0,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
  AND target_kind = 'reviewer'
  AND status IN ('prepared', 'leased', 'dispatched')
`, nowUnixMS, admission.WorkspaceID, executionID, admission.CheckpointID); err != nil {
		return fmt.Errorf("cancel stale Tutti mode reviewer wake: %w", err)
	}
	return nil
}
