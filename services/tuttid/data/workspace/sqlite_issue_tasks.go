package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

func (s *SQLiteStore) ListTasks(ctx context.Context, filter workspaceissues.TaskListFilter) (workspaceissues.TaskList, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.TaskList{}, err
	}
	if _, err := s.GetIssue(ctx, filter.WorkspaceID, filter.IssueID); err != nil {
		return workspaceissues.TaskList{}, err
	}

	where, args := taskListWhere(filter)
	countWhere := strings.Join(where, " AND ")
	countArgs := append([]any(nil), args...)
	totalCount, err := s.countIssueRows(ctx, "workspace_issue_tasks", countWhere, countArgs)
	if err != nil {
		return workspaceissues.TaskList{}, err
	}
	statusCountWhere, statusCountArgs := taskListStatusCountWhere(filter)
	counts, err := s.countIssueStatuses(
		ctx,
		"workspace_issue_tasks",
		strings.Join(statusCountWhere, " AND "),
		statusCountArgs,
	)
	if err != nil {
		return workspaceissues.TaskList{}, err
	}

	if filter.Cursor != nil {
		where = append(where, "(sort_index > ? OR (sort_index = ? AND id > ?))")
		args = append(args, filter.Cursor.SortIndex, filter.Cursor.SortIndex, filter.Cursor.ID)
	}

	limit := issueListLimit(filter.PageSize, filter.ReturnAll)
	query := fmt.Sprintf(`
SELECT %s
FROM workspace_issue_tasks
WHERE %s
ORDER BY sort_index ASC, id ASC%s
`, taskSelectColumns, strings.Join(where, " AND "), issueLimitClause(limit))
	if limit > 0 {
		args = append(args, limit)
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return workspaceissues.TaskList{}, fmt.Errorf("list workspace issue tasks: %w", err)
	}
	defer rows.Close()

	items, err := scanWorkspaceIssueTasks(rows)
	if err != nil {
		return workspaceissues.TaskList{}, err
	}

	var nextCursor *workspaceissues.TaskListCursor
	pageSize := normalizedIssuePageSize(filter.PageSize)
	if !filter.ReturnAll && len(items) > pageSize {
		last := items[pageSize-1]
		nextCursor = &workspaceissues.TaskListCursor{SortIndex: last.SortIndex, ID: last.ID}
		items = items[:pageSize]
	}

	return workspaceissues.TaskList{
		Items:        items,
		NextCursor:   nextCursor,
		TotalCount:   totalCount,
		StatusCounts: counts,
	}, nil
}

func (s *SQLiteStore) AppendTasks(ctx context.Context, tasks []workspaceissues.Task) ([]workspaceissues.Task, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return nil, err
	}
	if len(tasks) == 0 {
		return []workspaceissues.Task{}, nil
	}

	workspaceID := tasks[0].WorkspaceID
	issueID := tasks[0].IssueID
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin append workspace issue tasks: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	var exists int
	if err := tx.QueryRowContext(ctx, `
SELECT 1
FROM workspace_issues
WHERE workspace_id = ? AND issue_id = ?
`, workspaceID, issueID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
		return nil, workspaceissues.ErrIssueNotFound
	} else if err != nil {
		return nil, fmt.Errorf("get workspace issue for task append: %w", err)
	}

	var nextSortIndex int
	if err := tx.QueryRowContext(ctx, `
SELECT COALESCE(MAX(sort_index), 0) + 1
FROM workspace_issue_tasks
WHERE workspace_id = ? AND issue_id = ?
`, workspaceID, issueID).Scan(&nextSortIndex); err != nil {
		return nil, fmt.Errorf("get next workspace issue task sort index: %w", err)
	}

	created := make([]workspaceissues.Task, 0, len(tasks))
	for index, task := range tasks {
		if task.WorkspaceID != workspaceID || task.IssueID != issueID {
			return nil, workspaceissues.ErrInvalidArgument
		}
		task.SortIndex = nextSortIndex + index
		result, err := tx.ExecContext(ctx, `
INSERT INTO workspace_issue_tasks (
  task_id, issue_id, workspace_id, title, content, search_text, status,
  priority, sort_index, due_at_unix_ms, creator_user_id, creator_display_name,
  creator_avatar_url, latest_run_id, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, task.TaskID, task.IssueID, task.WorkspaceID, task.Title, task.Content, task.SearchText,
			string(task.Status), string(task.Priority), task.SortIndex, task.DueAtUnixMS, task.CreatorUserID,
			task.CreatorDisplayName, task.CreatorAvatarURL, task.LatestRunID, task.CreatedAtUnixMS, task.UpdatedAtUnixMS)
		if err != nil {
			if isSQLiteUniqueConstraintError(err) {
				return nil, workspaceissues.ErrTaskAlreadyExists
			}
			return nil, fmt.Errorf("append workspace issue task: %w", err)
		}
		id, err := result.LastInsertId()
		if err != nil {
			return nil, fmt.Errorf("read appended workspace issue task id: %w", err)
		}
		task.ID = uint64(id)
		created = append(created, task)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit append workspace issue tasks: %w", err)
	}

	return created, nil
}

func (s *SQLiteStore) GetTask(ctx context.Context, workspaceID string, issueID string, taskID string) (workspaceissues.Task, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Task{}, err
	}

	row := s.db.QueryRowContext(ctx, `
SELECT `+taskSelectColumns+`
FROM workspace_issue_tasks
WHERE workspace_id = ? AND issue_id = ? AND task_id = ?
`, workspaceID, issueID, taskID)
	task, err := scanWorkspaceIssueTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return workspaceissues.Task{}, workspaceissues.ErrTaskNotFound
	}
	if err != nil {
		return workspaceissues.Task{}, fmt.Errorf("get workspace issue task: %w", err)
	}
	return task, nil
}

func (s *SQLiteStore) UpdateTask(ctx context.Context, task workspaceissues.Task) (workspaceissues.Task, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Task{}, err
	}

	result, err := s.db.ExecContext(ctx, `
UPDATE workspace_issue_tasks
SET title = ?, content = ?, search_text = ?, status = ?, priority = ?,
    sort_index = ?, due_at_unix_ms = ?, latest_run_id = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND task_id = ?
`, task.Title, task.Content, task.SearchText, string(task.Status), string(task.Priority),
		task.SortIndex, task.DueAtUnixMS, task.LatestRunID, task.UpdatedAtUnixMS, task.WorkspaceID, task.IssueID, task.TaskID)
	if err != nil {
		return workspaceissues.Task{}, fmt.Errorf("update workspace issue task: %w", err)
	}
	if err := requireRowsAffected(result, workspaceissues.ErrTaskNotFound, "update workspace issue task"); err != nil {
		return workspaceissues.Task{}, err
	}
	return s.GetTask(ctx, task.WorkspaceID, task.IssueID, task.TaskID)
}

func (s *SQLiteStore) DeleteTask(ctx context.Context, workspaceID string, issueID string, taskID string, _ string) (bool, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return false, err
	}

	result, err := s.db.ExecContext(ctx, `
DELETE FROM workspace_issue_tasks
WHERE workspace_id = ? AND issue_id = ? AND task_id = ?
`, workspaceID, issueID, taskID)
	if err != nil {
		return false, fmt.Errorf("delete workspace issue task: %w", err)
	}
	return rowsWereAffected(result, "delete workspace issue task")
}
