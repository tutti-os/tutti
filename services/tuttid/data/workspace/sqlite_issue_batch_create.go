package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

// CreateIssueWithTasks commits the Plan-derived Issue, its initial task graph,
// and topic activity together. Event publication happens above this store
// boundary only after this transaction returns successfully.
func (s *SQLiteStore) CreateIssueWithTasks(
	ctx context.Context,
	issue workspaceissues.Issue,
	tasks []workspaceissues.Task,
) (workspaceissues.Issue, []workspaceissues.Task, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Issue{}, nil, err
	}
	if err := s.ensureIssueWorkspace(ctx, issue.WorkspaceID); err != nil {
		return workspaceissues.Issue{}, nil, err
	}
	if len(tasks) == 0 {
		return workspaceissues.Issue{}, nil, workspaceissues.ErrInvalidArgument
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return workspaceissues.Issue{}, nil, fmt.Errorf("begin create workspace issue with tasks: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	var topicExists int
	err = tx.QueryRowContext(ctx, `
SELECT 1
FROM workspace_issue_topics
WHERE workspace_id = ? AND topic_id = ?
`, issue.WorkspaceID, issue.TopicID).Scan(&topicExists)
	if errors.Is(err, sql.ErrNoRows) {
		return workspaceissues.Issue{}, nil, workspaceissues.ErrTopicNotFound
	}
	if err != nil {
		return workspaceissues.Issue{}, nil, fmt.Errorf("get workspace issue topic for batch create: %w", err)
	}

	createdIssue, err := insertWorkspaceIssue(ctx, tx, issue)
	if err != nil {
		return workspaceissues.Issue{}, nil, err
	}
	createdTasks := make([]workspaceissues.Task, 0, len(tasks))
	for index, task := range tasks {
		if task.WorkspaceID != issue.WorkspaceID || task.IssueID != issue.IssueID {
			return workspaceissues.Issue{}, nil, workspaceissues.ErrInvalidArgument
		}
		task.SortIndex = index + 1
		createdTask, err := insertWorkspaceIssueTask(ctx, tx, task)
		if err != nil {
			return workspaceissues.Issue{}, nil, err
		}
		createdTasks = append(createdTasks, createdTask)
	}

	result, err := tx.ExecContext(ctx, `
UPDATE workspace_issue_topics
SET last_activity_at_unix_ms = ?
WHERE workspace_id = ? AND topic_id = ?
`, issue.UpdatedAtUnixMS, issue.WorkspaceID, issue.TopicID)
	if err != nil {
		return workspaceissues.Issue{}, nil, fmt.Errorf("touch workspace issue topic activity during batch create: %w", err)
	}
	if err := requireRowsAffected(result, workspaceissues.ErrTopicNotFound, "touch workspace issue topic activity during batch create"); err != nil {
		return workspaceissues.Issue{}, nil, err
	}
	if err := tx.Commit(); err != nil {
		return workspaceissues.Issue{}, nil, fmt.Errorf("commit create workspace issue with tasks: %w", err)
	}
	return createdIssue, createdTasks, nil
}
