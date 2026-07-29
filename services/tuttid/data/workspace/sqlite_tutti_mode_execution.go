package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

func (s *SQLiteStore) MaterializeTuttiModeIssue(
	ctx context.Context,
	issue workspaceissues.Issue,
	tasks []workspaceissues.Task,
	aggregate executionbiz.Aggregate,
) (workspaceissues.Issue, []workspaceissues.Task, executionbiz.Aggregate, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, err
	}
	if err := validateInitialTuttiModeMaterialization(issue, tasks, aggregate); err != nil {
		return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, err
	}
	if err := s.ensureIssueWorkspace(ctx, issue.WorkspaceID); err != nil {
		return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, err
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, fmt.Errorf("begin Tutti mode Issue materialization: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if err := ensureSourceSessionNotDeletionFencedTx(
		ctx, tx, issue.WorkspaceID, issue.SourceSessionID,
	); err != nil {
		return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, err
	}

	var topicExists int
	err = tx.QueryRowContext(ctx, `
SELECT 1
FROM workspace_issue_topics
WHERE workspace_id = ? AND topic_id = ?
`, issue.WorkspaceID, issue.TopicID).Scan(&topicExists)
	if errors.Is(err, sql.ErrNoRows) {
		return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, workspaceissues.ErrTopicNotFound
	}
	if err != nil {
		return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, fmt.Errorf("get topic for Tutti mode materialization: %w", err)
	}

	createdIssue, err := insertWorkspaceIssue(ctx, tx, issue)
	if err != nil {
		return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, err
	}
	createdTasks := make([]workspaceissues.Task, 0, len(tasks))
	for index, task := range tasks {
		task.SortIndex = index + 1
		createdTask, createErr := insertWorkspaceIssueTask(ctx, tx, task)
		if createErr != nil {
			return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, createErr
		}
		createdTasks = append(createdTasks, createdTask)
	}
	if err := insertTuttiModeExecution(ctx, tx, aggregate.Execution); err != nil {
		return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, err
	}
	for _, checkpoint := range aggregate.Checkpoints {
		if err := insertTuttiModeExecutionCheckpoint(ctx, tx, aggregate.Execution.WorkspaceID, checkpoint); err != nil {
			return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, err
		}
		if err := prepareTuttiModeMainWakeTx(
			ctx, tx, aggregate.Execution.WorkspaceID, aggregate.Execution.ID,
			checkpoint, aggregate.Execution.CreatedAt,
		); err != nil {
			return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, err
		}
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_issue_topics
SET last_activity_at_unix_ms = ?
WHERE workspace_id = ? AND topic_id = ?
`, issue.UpdatedAtUnixMS, issue.WorkspaceID, issue.TopicID)
	if err != nil {
		return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, fmt.Errorf("touch topic during Tutti mode materialization: %w", err)
	}
	if err := requireRowsAffected(result, workspaceissues.ErrTopicNotFound, "touch topic during Tutti mode materialization"); err != nil {
		return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, err
	}
	if err := tx.Commit(); err != nil {
		return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, fmt.Errorf("commit Tutti mode Issue materialization: %w", err)
	}
	return createdIssue, createdTasks, aggregate, nil
}

func (s *SQLiteStore) GetTuttiModeExecutionByIssue(
	ctx context.Context,
	workspaceID string,
	issueID string,
) (executionbiz.Aggregate, error) {
	return s.getTuttiModeExecutionByIssueSnapshot(ctx, workspaceID, issueID, nil)
}

func (s *SQLiteStore) getTuttiModeExecutionByIssueSnapshot(
	ctx context.Context,
	workspaceID string,
	issueID string,
	afterExecutionRead func() error,
) (executionbiz.Aggregate, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return executionbiz.Aggregate{}, err
	}
	tx, err := s.readDB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return executionbiz.Aggregate{}, fmt.Errorf("begin Tutti mode execution snapshot: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	row := tx.QueryRowContext(ctx, `
SELECT execution_id, workspace_id, issue_id, workflow_id, source_session_id,
       status, graph_revision, last_orchestrator_activity_at_unix_ms,
       watchdog_due_at_unix_ms, review_mode, review_agent_target_id,
       completed_at_unix_ms, archived_at_unix_ms, archived_by, archive_reason,
       created_at_unix_ms, updated_at_unix_ms
FROM workspace_tutti_executions
WHERE workspace_id = ? AND issue_id = ?
`, strings.TrimSpace(workspaceID), strings.TrimSpace(issueID))
	execution, err := scanTuttiModeExecution(row)
	if errors.Is(err, sql.ErrNoRows) {
		return executionbiz.Aggregate{}, executionbiz.ErrExecutionNotFound
	}
	if err != nil {
		return executionbiz.Aggregate{}, fmt.Errorf("get Tutti mode execution: %w", err)
	}
	if afterExecutionRead != nil {
		if err := afterExecutionRead(); err != nil {
			return executionbiz.Aggregate{}, fmt.Errorf("observe Tutti mode execution snapshot: %w", err)
		}
	}

	rows, err := tx.QueryContext(ctx, `
SELECT checkpoint_id, execution_id, kind, status, sequence, graph_revision,
       subject_task_id, subject_run_id, creation_reason, requires_goal_review,
       created_at_unix_ms, updated_at_unix_ms, resolved_at_unix_ms
FROM workspace_tutti_execution_checkpoints
WHERE workspace_id = ? AND execution_id = ?
ORDER BY sequence ASC
`, execution.WorkspaceID, execution.ID)
	if err != nil {
		return executionbiz.Aggregate{}, fmt.Errorf("list Tutti mode execution checkpoints: %w", err)
	}

	checkpoints := make([]executionbiz.Checkpoint, 0)
	for rows.Next() {
		checkpoint, scanErr := scanTuttiModeExecutionCheckpoint(rows)
		if scanErr != nil {
			_ = rows.Close()
			return executionbiz.Aggregate{}, fmt.Errorf("scan Tutti mode execution checkpoint: %w", scanErr)
		}
		if checkpoint.Status == executionbiz.CheckpointStatusActive {
			execution.ActiveCheckpointID = checkpoint.ID
		}
		checkpoints = append(checkpoints, checkpoint)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return executionbiz.Aggregate{}, fmt.Errorf("iterate Tutti mode execution checkpoints: %w", err)
	}
	if err := rows.Close(); err != nil {
		return executionbiz.Aggregate{}, fmt.Errorf("close Tutti mode execution checkpoints: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return executionbiz.Aggregate{}, fmt.Errorf("commit Tutti mode execution snapshot: %w", err)
	}
	return executionbiz.Aggregate{Execution: execution, Checkpoints: checkpoints}, nil
}

type rowScanner interface {
	Scan(...any) error
}

func scanTuttiModeExecution(scanner rowScanner) (executionbiz.Execution, error) {
	var execution executionbiz.Execution
	var lastActivity, watchdogDue, completedAt, archivedAt, createdAt, updatedAt int64
	err := scanner.Scan(
		&execution.ID,
		&execution.WorkspaceID,
		&execution.IssueID,
		&execution.WorkflowID,
		&execution.SourceSessionID,
		&execution.Status,
		&execution.GraphRevision,
		&lastActivity,
		&watchdogDue,
		&execution.ReviewMode,
		&execution.ReviewAgentTargetID,
		&completedAt,
		&archivedAt,
		&execution.ArchivedBy,
		&execution.ArchiveReason,
		&createdAt,
		&updatedAt,
	)
	if err != nil {
		return executionbiz.Execution{}, err
	}
	execution.LastOrchestratorActivityAt = time.UnixMilli(lastActivity).UTC()
	execution.WatchdogDueAt = time.UnixMilli(watchdogDue).UTC()
	execution.CompletedAt = optionalTuttiModeExecutionTime(completedAt)
	execution.ArchivedAt = optionalTuttiModeExecutionTime(archivedAt)
	execution.CreatedAt = time.UnixMilli(createdAt).UTC()
	execution.UpdatedAt = time.UnixMilli(updatedAt).UTC()
	return execution, nil
}

func scanTuttiModeExecutionCheckpoint(scanner rowScanner) (executionbiz.Checkpoint, error) {
	var checkpoint executionbiz.Checkpoint
	var requiresGoalReview int
	var createdAt, updatedAt, resolvedAt int64
	err := scanner.Scan(
		&checkpoint.ID,
		&checkpoint.ExecutionID,
		&checkpoint.Kind,
		&checkpoint.Status,
		&checkpoint.Sequence,
		&checkpoint.GraphRevision,
		&checkpoint.SubjectTaskID,
		&checkpoint.SubjectRunID,
		&checkpoint.CreationReason,
		&requiresGoalReview,
		&createdAt,
		&updatedAt,
		&resolvedAt,
	)
	if err != nil {
		return executionbiz.Checkpoint{}, err
	}
	checkpoint.RequiresGoalReview = requiresGoalReview != 0
	checkpoint.CreatedAt = time.UnixMilli(createdAt).UTC()
	checkpoint.UpdatedAt = time.UnixMilli(updatedAt).UTC()
	checkpoint.ResolvedAt = optionalTuttiModeExecutionTime(resolvedAt)
	return checkpoint, nil
}

func insertTuttiModeExecution(
	ctx context.Context,
	execer workspaceIssueExecer,
	execution executionbiz.Execution,
) error {
	_, err := execer.ExecContext(ctx, `
INSERT INTO workspace_tutti_executions (
  workspace_id, execution_id, issue_id, workflow_id, source_session_id,
  status, graph_revision, last_orchestrator_activity_at_unix_ms,
  watchdog_due_at_unix_ms, review_mode, review_agent_target_id,
  completed_at_unix_ms, archived_at_unix_ms, archived_by, archive_reason,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`,
		execution.WorkspaceID,
		execution.ID,
		execution.IssueID,
		execution.WorkflowID,
		execution.SourceSessionID,
		string(execution.Status),
		execution.GraphRevision,
		unixMs(execution.LastOrchestratorActivityAt),
		unixMs(execution.WatchdogDueAt),
		string(execution.ReviewMode),
		execution.ReviewAgentTargetID,
		optionalTuttiModeExecutionUnixMs(execution.CompletedAt),
		optionalTuttiModeExecutionUnixMs(execution.ArchivedAt),
		execution.ArchivedBy,
		execution.ArchiveReason,
		unixMs(execution.CreatedAt),
		unixMs(execution.UpdatedAt),
	)
	if err != nil {
		if isSQLiteUniqueConstraintError(err) {
			return executionbiz.ErrExecutionConflict
		}
		return fmt.Errorf("create Tutti mode execution: %w", err)
	}
	return nil
}

func insertTuttiModeExecutionCheckpoint(
	ctx context.Context,
	execer workspaceIssueExecer,
	workspaceID string,
	checkpoint executionbiz.Checkpoint,
) error {
	_, err := execer.ExecContext(ctx, `
INSERT INTO workspace_tutti_execution_checkpoints (
  workspace_id, execution_id, checkpoint_id, kind, status, sequence,
  graph_revision, subject_task_id, subject_run_id, creation_reason,
  requires_goal_review, created_at_unix_ms, updated_at_unix_ms,
  resolved_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`,
		workspaceID,
		checkpoint.ExecutionID,
		checkpoint.ID,
		string(checkpoint.Kind),
		string(checkpoint.Status),
		checkpoint.Sequence,
		checkpoint.GraphRevision,
		checkpoint.SubjectTaskID,
		checkpoint.SubjectRunID,
		checkpoint.CreationReason,
		boolToInt(checkpoint.RequiresGoalReview),
		unixMs(checkpoint.CreatedAt),
		unixMs(checkpoint.UpdatedAt),
		optionalTuttiModeExecutionUnixMs(checkpoint.ResolvedAt),
	)
	if err != nil {
		if isSQLiteUniqueConstraintError(err) {
			return executionbiz.ErrExecutionConflict
		}
		return fmt.Errorf("create Tutti mode execution checkpoint: %w", err)
	}
	return nil
}

func validateInitialTuttiModeMaterialization(
	issue workspaceissues.Issue,
	tasks []workspaceissues.Task,
	aggregate executionbiz.Aggregate,
) error {
	if err := executionbiz.ValidateInitialAggregate(aggregate); err != nil {
		return err
	}
	execution := aggregate.Execution
	if issue.PlanningSource != workspaceissues.PlanningSourceTuttiModePlan ||
		strings.TrimSpace(issue.WorkspaceID) == "" ||
		execution.WorkspaceID != issue.WorkspaceID ||
		execution.IssueID != issue.IssueID ||
		execution.SourceSessionID != issue.SourceSessionID ||
		len(tasks) == 0 {
		return executionbiz.ErrInvalidExecution
	}
	for _, task := range tasks {
		if task.WorkspaceID != issue.WorkspaceID || task.IssueID != issue.IssueID {
			return executionbiz.ErrInvalidExecution
		}
	}
	return nil
}

func optionalTuttiModeExecutionUnixMs(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return unixMs(value.UTC())
}

func optionalTuttiModeExecutionTime(value int64) time.Time {
	if value == 0 {
		return time.Time{}
	}
	return time.UnixMilli(value).UTC()
}
