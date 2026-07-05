package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	sqlitedriver "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

type issueScanner interface {
	Scan(dest ...any) error
}

func (s *SQLiteStore) ensureIssueDatabase() error {
	if s == nil || s.db == nil {
		return workspaceissues.ErrStoreNotConfigured
	}
	return nil
}

func (s *SQLiteStore) ensureIssueWorkspace(ctx context.Context, workspaceID string) error {
	if _, err := s.Get(ctx, workspaceID); err != nil {
		if errors.Is(err, ErrWorkspaceNotFound) {
			return workspaceissues.ErrWorkspaceNotFound
		}
		return err
	}
	return nil
}

func (s *SQLiteStore) ensureContextRefParent(ctx context.Context, ref workspaceissues.ContextRef) error {
	if ref.ParentKind == workspaceissues.ContextRefParentTask {
		_, err := s.GetTask(ctx, ref.WorkspaceID, ref.IssueID, ref.TaskID)
		return err
	}
	_, err := s.GetIssue(ctx, ref.WorkspaceID, ref.IssueID)
	return err
}

func isSQLiteUniqueConstraintError(err error) bool {
	var sqliteErr *sqlitedriver.Error
	if !errors.As(err, &sqliteErr) {
		return false
	}
	switch sqliteErr.Code() {
	case sqlite3.SQLITE_CONSTRAINT_PRIMARYKEY, sqlite3.SQLITE_CONSTRAINT_UNIQUE:
		return true
	default:
		return false
	}
}

func issueListWhere(filter workspaceissues.IssueListFilter) ([]string, []any) {
	return issueListWhereForFilter(filter, true)
}

func issueListStatusCountWhere(filter workspaceissues.IssueListFilter) ([]string, []any) {
	return issueListWhereForFilter(filter, false)
}

func issueListWhereForFilter(filter workspaceissues.IssueListFilter, includeStatus bool) ([]string, []any) {
	where := []string{"workspace_id = ?", "topic_id = ?"}
	args := []any{filter.WorkspaceID, filter.TopicID}
	if includeStatus && filter.StatusFilter != "" {
		where = append(where, "status = ?")
		args = append(args, string(filter.StatusFilter))
	}
	if searchQuery := strings.TrimSpace(filter.SearchQuery); searchQuery != "" {
		where = append(where, "(LOWER(title) LIKE ? OR LOWER(search_text) LIKE ?)")
		like := "%" + strings.ToLower(searchQuery) + "%"
		args = append(args, like, like)
	}
	return where, args
}

func taskListWhere(filter workspaceissues.TaskListFilter) ([]string, []any) {
	return taskListWhereForFilter(filter, true)
}

func taskListStatusCountWhere(filter workspaceissues.TaskListFilter) ([]string, []any) {
	return taskListWhereForFilter(filter, false)
}

func taskListWhereForFilter(filter workspaceissues.TaskListFilter, includeStatus bool) ([]string, []any) {
	where := []string{"workspace_id = ?", "issue_id = ?"}
	args := []any{filter.WorkspaceID, filter.IssueID}
	if includeStatus && filter.StatusFilter != "" {
		where = append(where, "status = ?")
		args = append(args, string(filter.StatusFilter))
	}
	if searchQuery := strings.TrimSpace(filter.SearchQuery); searchQuery != "" {
		where = append(where, "(LOWER(title) LIKE ? OR LOWER(search_text) LIKE ?)")
		like := "%" + strings.ToLower(searchQuery) + "%"
		args = append(args, like, like)
	}
	return where, args
}

func normalizedIssuePageSize(pageSize int) int {
	if pageSize <= 0 {
		return 25
	}
	if pageSize > 50 {
		return 50
	}
	return pageSize
}

func issueListLimit(pageSize int, returnAll bool) int {
	if returnAll {
		return 0
	}
	return normalizedIssuePageSize(pageSize) + 1
}

func issueLimitClause(limit int) string {
	if limit <= 0 {
		return ""
	}
	return "\nLIMIT ?"
}

func (s *SQLiteStore) countIssueRows(ctx context.Context, tableName string, where string, args []any) (int, error) {
	row := s.db.QueryRowContext(ctx, fmt.Sprintf(`
SELECT COUNT(*)
FROM %s
WHERE %s
`, tableName, where), args...)

	var count int
	if err := row.Scan(&count); err != nil {
		return 0, fmt.Errorf("count %s rows: %w", tableName, err)
	}
	return count, nil
}

func (s *SQLiteStore) countIssueStatuses(ctx context.Context, tableName string, where string, args []any) (workspaceissues.StatusCounts, error) {
	rows, err := s.db.QueryContext(ctx, fmt.Sprintf(`
SELECT status, COUNT(*)
FROM %s
WHERE %s
GROUP BY status
`, tableName, where), args...)
	if err != nil {
		return workspaceissues.StatusCounts{}, fmt.Errorf("count %s statuses: %w", tableName, err)
	}
	defer rows.Close()

	var counts workspaceissues.StatusCounts
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return workspaceissues.StatusCounts{}, fmt.Errorf("scan %s status count: %w", tableName, err)
		}
		incrementIssueStatusCount(&counts, workspaceissues.Status(status), count)
	}
	if err := rows.Err(); err != nil {
		return workspaceissues.StatusCounts{}, fmt.Errorf("iterate %s status counts: %w", tableName, err)
	}
	return counts, nil
}

func incrementIssueStatusCount(counts *workspaceissues.StatusCounts, status workspaceissues.Status, value int) {
	counts.All += value
	switch status {
	case workspaceissues.StatusNotStarted:
		counts.NotStarted += value
	case workspaceissues.StatusRunning:
		counts.Running += value
	case workspaceissues.StatusPendingAcceptance:
		counts.PendingAcceptance += value
	case workspaceissues.StatusCompleted:
		counts.Completed += value
	case workspaceissues.StatusFailed:
		counts.Failed += value
	case workspaceissues.StatusCanceled:
		counts.Canceled += value
	default:
		counts.NotStarted += value
	}
}

func scanWorkspaceIssues(rows *sql.Rows) ([]workspaceissues.Issue, error) {
	items := make([]workspaceissues.Issue, 0)
	for rows.Next() {
		item, err := scanWorkspaceIssue(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace issues: %w", err)
	}
	return items, nil
}

func scanWorkspaceIssueTopics(rows *sql.Rows) ([]workspaceissues.Topic, error) {
	items := make([]workspaceissues.Topic, 0)
	for rows.Next() {
		item, err := scanWorkspaceIssueTopic(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace issue topics: %w", err)
	}
	return items, nil
}

func scanWorkspaceIssueTopic(scanner issueScanner) (workspaceissues.Topic, error) {
	var item workspaceissues.Topic
	var id int64
	var isDefault int
	err := scanner.Scan(
		&id, &item.TopicID, &item.WorkspaceID, &item.Title, &item.Summary,
		&isDefault, &item.PinnedAtUnixMS, &item.LastActivityAtUnixMS,
		&item.CreatedAtUnixMS, &item.UpdatedAtUnixMS,
	)
	item.ID = uint64(id)
	item.IsDefault = isDefault != 0
	return item, err
}

func scanWorkspaceIssue(scanner issueScanner) (workspaceissues.Issue, error) {
	var item workspaceissues.Issue
	var id int64
	var status string
	err := scanner.Scan(
		&id, &item.IssueID, &item.TopicID, &item.WorkspaceID, &item.Title, &item.Content,
		&item.SearchText, &status, &item.TaskCount, &item.NotStartedCount, &item.RunningCount,
		&item.PendingAcceptanceCount, &item.CompletedCount, &item.FailedCount,
		&item.CanceledCount, &item.CreatorUserID, &item.CreatorDisplayName,
		&item.CreatorAvatarURL, &item.CreatedAtUnixMS, &item.UpdatedAtUnixMS,
	)
	item.ID = uint64(id)
	item.Status = workspaceissues.Status(status)
	return item, err
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func scanWorkspaceIssueTasks(rows *sql.Rows) ([]workspaceissues.Task, error) {
	items := make([]workspaceissues.Task, 0)
	for rows.Next() {
		item, err := scanWorkspaceIssueTask(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace issue tasks: %w", err)
	}
	return items, nil
}

func scanWorkspaceIssueTask(scanner issueScanner) (workspaceissues.Task, error) {
	var item workspaceissues.Task
	var id int64
	var status string
	var priority string
	err := scanner.Scan(
		&id, &item.TaskID, &item.IssueID, &item.WorkspaceID, &item.Title, &item.Content,
		&item.SearchText, &status, &priority, &item.SortIndex, &item.DueAtUnixMS,
		&item.CreatorUserID, &item.CreatorDisplayName, &item.CreatorAvatarURL,
		&item.LatestRunID, &item.CreatedAtUnixMS, &item.UpdatedAtUnixMS,
	)
	item.ID = uint64(id)
	item.Status = workspaceissues.Status(status)
	item.Priority = workspaceissues.Priority(priority)
	return item, err
}

func scanWorkspaceIssueContextRef(scanner issueScanner) (workspaceissues.ContextRef, error) {
	var item workspaceissues.ContextRef
	var id int64
	var parentKind string
	err := scanner.Scan(
		&id, &item.ContextRefID, &item.WorkspaceID, &item.IssueID, &item.TaskID,
		&parentKind, &item.RefType, &item.Path, &item.DisplayName, &item.CreatedAtUnixMS,
	)
	item.ID = uint64(id)
	item.ParentKind = workspaceissues.ContextRefParentKind(parentKind)
	return item, err
}

func scanWorkspaceIssueRun(scanner issueScanner) (workspaceissues.Run, error) {
	var item workspaceissues.Run
	var id int64
	var status string
	err := scanner.Scan(
		&id, &item.RunID, &item.TaskID, &item.IssueID, &item.WorkspaceID,
		&item.RequesterUserID, &item.AgentUserID, &item.AgentTargetID,
		&item.AgentSessionID, &item.AgentProvider, &status, &item.Summary,
		&item.ErrorMessage, &item.OutputDir, &item.ExecutionDirectory,
		&item.CreatedAtUnixMS, &item.StartedAtUnixMS, &item.CompletedAtUnixMS,
		&item.UpdatedAtUnixMS,
	)
	item.ID = uint64(id)
	item.Status = workspaceissues.Status(status)
	return item, err
}

func scanWorkspaceIssueRunOutput(scanner issueScanner) (workspaceissues.RunOutput, error) {
	var item workspaceissues.RunOutput
	var id int64
	err := scanner.Scan(
		&id, &item.OutputID, &item.RunID, &item.TaskID, &item.IssueID, &item.WorkspaceID,
		&item.Path, &item.DisplayName, &item.MediaType, &item.SizeBytes, &item.CreatedAtUnixMS,
	)
	item.ID = uint64(id)
	return item, err
}

func scanWorkspaceIssueRunOutputSearchHit(scanner issueScanner) (workspaceissues.RunOutputSearchHit, error) {
	var hit workspaceissues.RunOutputSearchHit
	var id int64
	err := scanner.Scan(
		&id, &hit.Output.OutputID, &hit.Output.RunID, &hit.Output.TaskID, &hit.Output.IssueID, &hit.Output.WorkspaceID,
		&hit.Output.Path, &hit.Output.DisplayName, &hit.Output.MediaType, &hit.Output.SizeBytes, &hit.Output.CreatedAtUnixMS,
		&hit.IssueTitle,
	)
	hit.Output.ID = uint64(id)
	return hit, err
}

func rowsWereAffected(result sql.Result, operation string) (bool, error) {
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("%s rows affected: %w", operation, err)
	}
	return rowsAffected > 0, nil
}

func requireRowsAffected(result sql.Result, notFound error, operation string) error {
	removed, err := rowsWereAffected(result, operation)
	if err != nil {
		return err
	}
	if !removed {
		return notFound
	}
	return nil
}
