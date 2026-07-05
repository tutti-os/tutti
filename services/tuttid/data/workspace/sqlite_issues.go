package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

var _ workspaceissues.Store = (*SQLiteStore)(nil)

const issueSelectColumns = `
id, issue_id, topic_id, workspace_id, title, content, search_text, status,
task_count, not_started_count, running_count, pending_acceptance_count,
completed_count, failed_count, canceled_count, creator_user_id,
creator_display_name, creator_avatar_url, created_at_unix_ms, updated_at_unix_ms`

const topicSelectColumns = `
id, topic_id, workspace_id, title, summary, is_default, pinned_at_unix_ms,
last_activity_at_unix_ms, created_at_unix_ms, updated_at_unix_ms`

const taskSelectColumns = `
id, task_id, issue_id, workspace_id, title, content, search_text, status,
priority, sort_index, due_at_unix_ms, creator_user_id, creator_display_name,
creator_avatar_url, latest_run_id, created_at_unix_ms, updated_at_unix_ms`

const runSelectColumns = `
id, run_id, task_id, issue_id, workspace_id, requester_user_id, agent_user_id,
agent_target_id, agent_session_id, agent_provider, status, summary,
error_message, output_dir, execution_directory, created_at_unix_ms,
started_at_unix_ms, completed_at_unix_ms, updated_at_unix_ms`

const runOutputSelectColumns = `
id, output_id, run_id, task_id, issue_id, workspace_id, path, display_name,
media_type, size_bytes, created_at_unix_ms`

func (s *SQLiteStore) ListTopics(ctx context.Context, workspaceID string) (workspaceissues.TopicList, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.TopicList{}, err
	}
	if err := s.ensureIssueWorkspace(ctx, workspaceID); err != nil {
		return workspaceissues.TopicList{}, err
	}

	rows, err := s.db.QueryContext(ctx, fmt.Sprintf(`
SELECT %s
FROM workspace_issue_topics
WHERE workspace_id = ?
ORDER BY
  CASE WHEN pinned_at_unix_ms > 0 THEN 0 ELSE 1 END,
  pinned_at_unix_ms DESC,
  last_activity_at_unix_ms DESC,
  id DESC
`, topicSelectColumns), workspaceID)
	if err != nil {
		return workspaceissues.TopicList{}, fmt.Errorf("list workspace issue topics: %w", err)
	}
	defer rows.Close()

	items, err := scanWorkspaceIssueTopics(rows)
	if err != nil {
		return workspaceissues.TopicList{}, err
	}
	return workspaceissues.TopicList{Items: items}, nil
}

func (s *SQLiteStore) CreateTopic(ctx context.Context, topic workspaceissues.Topic) (workspaceissues.Topic, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Topic{}, err
	}
	if err := s.ensureIssueWorkspace(ctx, topic.WorkspaceID); err != nil {
		return workspaceissues.Topic{}, err
	}

	_, err := s.db.ExecContext(ctx, `
INSERT INTO workspace_issue_topics (
  topic_id, workspace_id, title, summary, is_default, pinned_at_unix_ms,
  last_activity_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`, topic.TopicID, topic.WorkspaceID, topic.Title, topic.Summary, boolToInt(topic.IsDefault),
		topic.PinnedAtUnixMS, topic.LastActivityAtUnixMS, topic.CreatedAtUnixMS, topic.UpdatedAtUnixMS)
	if err != nil {
		if isSQLiteUniqueConstraintError(err) {
			return workspaceissues.Topic{}, workspaceissues.ErrTopicAlreadyExists
		}
		return workspaceissues.Topic{}, fmt.Errorf("create workspace issue topic: %w", err)
	}
	return s.GetTopic(ctx, topic.WorkspaceID, topic.TopicID)
}

func (s *SQLiteStore) GetTopic(ctx context.Context, workspaceID string, topicID string) (workspaceissues.Topic, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Topic{}, err
	}

	row := s.db.QueryRowContext(ctx, fmt.Sprintf(`
SELECT %s
FROM workspace_issue_topics
WHERE workspace_id = ? AND topic_id = ?
`, topicSelectColumns), workspaceID, topicID)
	topic, err := scanWorkspaceIssueTopic(row)
	if errors.Is(err, sql.ErrNoRows) {
		return workspaceissues.Topic{}, workspaceissues.ErrTopicNotFound
	}
	if err != nil {
		return workspaceissues.Topic{}, fmt.Errorf("get workspace issue topic: %w", err)
	}
	return topic, nil
}

func (s *SQLiteStore) UpdateTopic(ctx context.Context, topic workspaceissues.Topic) (workspaceissues.Topic, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Topic{}, err
	}

	result, err := s.db.ExecContext(ctx, `
UPDATE workspace_issue_topics
SET title = ?, summary = ?, pinned_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND topic_id = ?
`, topic.Title, topic.Summary, topic.PinnedAtUnixMS, topic.UpdatedAtUnixMS, topic.WorkspaceID, topic.TopicID)
	if err != nil {
		return workspaceissues.Topic{}, fmt.Errorf("update workspace issue topic: %w", err)
	}
	if err := requireRowsAffected(result, workspaceissues.ErrTopicNotFound, "update workspace issue topic"); err != nil {
		return workspaceissues.Topic{}, err
	}
	return s.GetTopic(ctx, topic.WorkspaceID, topic.TopicID)
}

func (s *SQLiteStore) DeleteTopic(ctx context.Context, workspaceID string, topicID string) (bool, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return false, err
	}

	result, err := s.db.ExecContext(ctx, `
DELETE FROM workspace_issue_topics
WHERE workspace_id = ? AND topic_id = ?
`, workspaceID, topicID)
	if err != nil {
		return false, fmt.Errorf("delete workspace issue topic: %w", err)
	}
	return rowsWereAffected(result, "delete workspace issue topic")
}

func (s *SQLiteStore) TouchTopicActivity(ctx context.Context, workspaceID string, topicID string, atUnixMS int64) error {
	if err := s.ensureIssueDatabase(); err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE workspace_issue_topics
SET last_activity_at_unix_ms = ?
WHERE workspace_id = ? AND topic_id = ?
`, atUnixMS, workspaceID, topicID)
	if err != nil {
		return fmt.Errorf("touch workspace issue topic activity: %w", err)
	}
	return requireRowsAffected(result, workspaceissues.ErrTopicNotFound, "touch workspace issue topic activity")
}

func (s *SQLiteStore) ListIssues(ctx context.Context, filter workspaceissues.IssueListFilter) (workspaceissues.IssueList, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.IssueList{}, err
	}
	if err := s.ensureIssueWorkspace(ctx, filter.WorkspaceID); err != nil {
		return workspaceissues.IssueList{}, err
	}

	where, args := issueListWhere(filter)
	countWhere := strings.Join(where, " AND ")
	countArgs := append([]any(nil), args...)
	totalCount, err := s.countIssueRows(ctx, "workspace_issues", countWhere, countArgs)
	if err != nil {
		return workspaceissues.IssueList{}, err
	}
	statusCountWhere, statusCountArgs := issueListStatusCountWhere(filter)
	counts, err := s.countIssueStatuses(
		ctx,
		"workspace_issues",
		strings.Join(statusCountWhere, " AND "),
		statusCountArgs,
	)
	if err != nil {
		return workspaceissues.IssueList{}, err
	}

	if filter.Cursor != nil {
		where = append(where, "(updated_at_unix_ms < ? OR (updated_at_unix_ms = ? AND id < ?))")
		args = append(args, filter.Cursor.UpdatedAtUnixMS, filter.Cursor.UpdatedAtUnixMS, filter.Cursor.ID)
	}

	limit := issueListLimit(filter.PageSize, filter.ReturnAll)
	query := fmt.Sprintf(`
SELECT %s
FROM workspace_issues
WHERE %s
ORDER BY updated_at_unix_ms DESC, id DESC%s
`, issueSelectColumns, strings.Join(where, " AND "), issueLimitClause(limit))
	if limit > 0 {
		args = append(args, limit)
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return workspaceissues.IssueList{}, fmt.Errorf("list workspace issues: %w", err)
	}
	defer rows.Close()

	items, err := scanWorkspaceIssues(rows)
	if err != nil {
		return workspaceissues.IssueList{}, err
	}

	var nextCursor *workspaceissues.IssueListCursor
	pageSize := normalizedIssuePageSize(filter.PageSize)
	if !filter.ReturnAll && len(items) > pageSize {
		last := items[pageSize-1]
		nextCursor = &workspaceissues.IssueListCursor{
			UpdatedAtUnixMS: last.UpdatedAtUnixMS,
			ID:              last.ID,
		}
		items = items[:pageSize]
	}

	return workspaceissues.IssueList{
		Items:        items,
		NextCursor:   nextCursor,
		TotalCount:   totalCount,
		StatusCounts: counts,
	}, nil
}

func (s *SQLiteStore) CreateIssue(ctx context.Context, issue workspaceissues.Issue) (workspaceissues.Issue, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Issue{}, err
	}
	if err := s.ensureIssueWorkspace(ctx, issue.WorkspaceID); err != nil {
		return workspaceissues.Issue{}, err
	}

	_, err := s.db.ExecContext(ctx, `
INSERT INTO workspace_issues (
  issue_id, topic_id, workspace_id, title, content, search_text, status,
  task_count, not_started_count, running_count, pending_acceptance_count,
  completed_count, failed_count, canceled_count, creator_user_id,
  creator_display_name, creator_avatar_url, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, issue.IssueID, issue.TopicID, issue.WorkspaceID, issue.Title, issue.Content, issue.SearchText, string(issue.Status),
		issue.TaskCount, issue.NotStartedCount, issue.RunningCount, issue.PendingAcceptanceCount,
		issue.CompletedCount, issue.FailedCount, issue.CanceledCount, issue.CreatorUserID,
		issue.CreatorDisplayName, issue.CreatorAvatarURL, issue.CreatedAtUnixMS, issue.UpdatedAtUnixMS)
	if err != nil {
		if isSQLiteUniqueConstraintError(err) {
			return workspaceissues.Issue{}, workspaceissues.ErrIssueAlreadyExists
		}
		return workspaceissues.Issue{}, fmt.Errorf("create workspace issue: %w", err)
	}

	return s.GetIssue(ctx, issue.WorkspaceID, issue.IssueID)
}

func (s *SQLiteStore) GetIssue(ctx context.Context, workspaceID string, issueID string) (workspaceissues.Issue, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Issue{}, err
	}

	row := s.db.QueryRowContext(ctx, fmt.Sprintf(`
SELECT %s
FROM workspace_issues
WHERE workspace_id = ? AND issue_id = ?
`, issueSelectColumns), workspaceID, issueID)
	issue, err := scanWorkspaceIssue(row)
	if errors.Is(err, sql.ErrNoRows) {
		return workspaceissues.Issue{}, workspaceissues.ErrIssueNotFound
	}
	if err != nil {
		return workspaceissues.Issue{}, fmt.Errorf("get workspace issue: %w", err)
	}
	return issue, nil
}

func (s *SQLiteStore) UpdateIssue(ctx context.Context, issue workspaceissues.Issue) (workspaceissues.Issue, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Issue{}, err
	}

	result, err := s.db.ExecContext(ctx, `
UPDATE workspace_issues
SET title = ?, content = ?, search_text = ?, status = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ?
`, issue.Title, issue.Content, issue.SearchText, string(issue.Status), issue.UpdatedAtUnixMS,
		issue.WorkspaceID, issue.IssueID)
	if err != nil {
		return workspaceissues.Issue{}, fmt.Errorf("update workspace issue: %w", err)
	}
	if err := requireRowsAffected(result, workspaceissues.ErrIssueNotFound, "update workspace issue"); err != nil {
		return workspaceissues.Issue{}, err
	}
	return s.GetIssue(ctx, issue.WorkspaceID, issue.IssueID)
}

func (s *SQLiteStore) DeleteIssue(ctx context.Context, workspaceID string, issueID string, _ string) (bool, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return false, err
	}

	result, err := s.db.ExecContext(ctx, `
DELETE FROM workspace_issues
WHERE workspace_id = ? AND issue_id = ?
`, workspaceID, issueID)
	if err != nil {
		return false, fmt.Errorf("delete workspace issue: %w", err)
	}
	return rowsWereAffected(result, "delete workspace issue")
}

func (s *SQLiteStore) RecalculateIssueProjection(ctx context.Context, workspaceID string, issueID string) (workspaceissues.Issue, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Issue{}, err
	}

	counts, err := s.countIssueStatuses(ctx, "workspace_issue_tasks", "workspace_id = ? AND issue_id = ?", []any{workspaceID, issueID})
	if err != nil {
		return workspaceissues.Issue{}, err
	}
	status := workspaceissues.ProjectIssueStatus(counts)
	now := unixMs(time.Now().UTC())
	result, err := s.db.ExecContext(ctx, `
UPDATE workspace_issues
SET status = ?, task_count = ?, not_started_count = ?, running_count = ?,
    pending_acceptance_count = ?, completed_count = ?, failed_count = ?,
    canceled_count = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ?
`, string(status), counts.All, counts.NotStarted, counts.Running, counts.PendingAcceptance,
		counts.Completed, counts.Failed, counts.Canceled, now, workspaceID, issueID)
	if err != nil {
		return workspaceissues.Issue{}, fmt.Errorf("recalculate workspace issue projection: %w", err)
	}
	if err := requireRowsAffected(result, workspaceissues.ErrIssueNotFound, "recalculate workspace issue projection"); err != nil {
		return workspaceissues.Issue{}, err
	}
	return s.GetIssue(ctx, workspaceID, issueID)
}

func (s *SQLiteStore) AddContextRefs(ctx context.Context, refs []workspaceissues.ContextRef) ([]workspaceissues.ContextRef, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return nil, err
	}
	if len(refs) == 0 {
		return nil, nil
	}
	if err := s.ensureContextRefParent(ctx, refs[0]); err != nil {
		return nil, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin workspace issue context refs transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	saved := make([]workspaceissues.ContextRef, 0, len(refs))
	for _, ref := range refs {
		result, err := tx.ExecContext(ctx, `
INSERT INTO workspace_issue_context_refs (
  context_ref_id, workspace_id, issue_id, task_id, parent_kind,
  ref_type, path, display_name, created_at_unix_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, ref.ContextRefID, ref.WorkspaceID, ref.IssueID, ref.TaskID, string(ref.ParentKind),
			ref.RefType, ref.Path, ref.DisplayName, ref.CreatedAtUnixMS)
		if err != nil {
			if isSQLiteUniqueConstraintError(err) {
				return nil, workspaceissues.ErrContextRefAlreadyExists
			}
			return nil, fmt.Errorf("add workspace issue context ref: %w", err)
		}
		id, err := result.LastInsertId()
		if err != nil {
			return nil, fmt.Errorf("read workspace issue context ref id: %w", err)
		}
		ref.ID = uint64(id)
		saved = append(saved, ref)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit workspace issue context refs: %w", err)
	}
	return saved, nil
}

func (s *SQLiteStore) ListContextRefs(
	ctx context.Context,
	workspaceID string,
	issueID string,
	taskID string,
	parentKind workspaceissues.ContextRefParentKind,
) ([]workspaceissues.ContextRef, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return nil, err
	}

	rows, err := s.db.QueryContext(ctx, `
SELECT id, context_ref_id, workspace_id, issue_id, task_id, parent_kind,
       ref_type, path, display_name, created_at_unix_ms
FROM workspace_issue_context_refs
WHERE workspace_id = ? AND issue_id = ? AND task_id = ? AND parent_kind = ?
ORDER BY created_at_unix_ms ASC, id ASC
`, workspaceID, issueID, taskID, string(parentKind))
	if err != nil {
		return nil, fmt.Errorf("list workspace issue context refs: %w", err)
	}
	defer rows.Close()

	items := make([]workspaceissues.ContextRef, 0)
	for rows.Next() {
		item, err := scanWorkspaceIssueContextRef(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace issue context refs: %w", err)
	}
	return items, nil
}

func (s *SQLiteStore) RemoveContextRef(
	ctx context.Context,
	workspaceID string,
	issueID string,
	taskID string,
	parentKind workspaceissues.ContextRefParentKind,
	contextRefID string,
) (bool, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return false, err
	}

	result, err := s.db.ExecContext(ctx, `
DELETE FROM workspace_issue_context_refs
WHERE workspace_id = ? AND issue_id = ? AND task_id = ? AND parent_kind = ? AND context_ref_id = ?
`, workspaceID, issueID, taskID, string(parentKind), contextRefID)
	if err != nil {
		return false, fmt.Errorf("remove workspace issue context ref: %w", err)
	}
	return rowsWereAffected(result, "remove workspace issue context ref")
}

func (s *SQLiteStore) CreateRun(ctx context.Context, run workspaceissues.Run) (workspaceissues.Run, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Run{}, err
	}
	if run.TaskID != "" {
		if _, err := s.GetTask(ctx, run.WorkspaceID, run.IssueID, run.TaskID); err != nil {
			return workspaceissues.Run{}, err
		}
	} else if _, err := s.GetIssue(ctx, run.WorkspaceID, run.IssueID); err != nil {
		return workspaceissues.Run{}, err
	}

	_, err := s.db.ExecContext(ctx, `
INSERT INTO workspace_issue_runs (
  run_id, task_id, issue_id, workspace_id, requester_user_id, agent_user_id,
  agent_target_id, agent_session_id, agent_provider, status, summary,
  error_message, output_dir, execution_directory, created_at_unix_ms,
  started_at_unix_ms, completed_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, run.RunID, run.TaskID, run.IssueID, run.WorkspaceID, run.RequesterUserID, run.AgentUserID,
		run.AgentTargetID, run.AgentSessionID, run.AgentProvider, string(run.Status), run.Summary,
		run.ErrorMessage, run.OutputDir, run.ExecutionDirectory, run.CreatedAtUnixMS,
		run.StartedAtUnixMS, run.CompletedAtUnixMS, run.UpdatedAtUnixMS)
	if err != nil {
		if isSQLiteUniqueConstraintError(err) {
			return workspaceissues.Run{}, workspaceissues.ErrRunAlreadyExists
		}
		return workspaceissues.Run{}, fmt.Errorf("create workspace issue run: %w", err)
	}
	return s.GetRun(ctx, run.WorkspaceID, run.IssueID, run.TaskID, run.RunID)
}

func (s *SQLiteStore) CompleteRun(ctx context.Context, run workspaceissues.Run, outputs []workspaceissues.RunOutput) (workspaceissues.Run, []workspaceissues.RunOutput, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Run{}, nil, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return workspaceissues.Run{}, nil, fmt.Errorf("begin workspace issue run transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	result, err := tx.ExecContext(ctx, `
UPDATE workspace_issue_runs
SET status = ?, summary = ?, error_message = ?, completed_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND task_id = ? AND run_id = ?
`, string(run.Status), run.Summary, run.ErrorMessage, run.CompletedAtUnixMS, run.UpdatedAtUnixMS,
		run.WorkspaceID, run.IssueID, run.TaskID, run.RunID)
	if err != nil {
		return workspaceissues.Run{}, nil, fmt.Errorf("complete workspace issue run: %w", err)
	}
	if err := requireRowsAffected(result, workspaceissues.ErrRunNotFound, "complete workspace issue run"); err != nil {
		return workspaceissues.Run{}, nil, err
	}

	if _, err := tx.ExecContext(ctx, `
DELETE FROM workspace_issue_run_outputs
WHERE workspace_id = ? AND issue_id = ? AND task_id = ? AND run_id = ?
`, run.WorkspaceID, run.IssueID, run.TaskID, run.RunID); err != nil {
		return workspaceissues.Run{}, nil, fmt.Errorf("replace workspace issue run outputs: %w", err)
	}

	saved := make([]workspaceissues.RunOutput, 0, len(outputs))
	for _, output := range outputs {
		result, err := tx.ExecContext(ctx, `
INSERT INTO workspace_issue_run_outputs (
  output_id, run_id, task_id, issue_id, workspace_id, path, display_name,
  media_type, size_bytes, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, output.OutputID, output.RunID, output.TaskID, output.IssueID, output.WorkspaceID,
			output.Path, output.DisplayName, output.MediaType, output.SizeBytes, output.CreatedAtUnixMS)
		if err != nil {
			return workspaceissues.Run{}, nil, fmt.Errorf("add workspace issue run output: %w", err)
		}
		id, err := result.LastInsertId()
		if err != nil {
			return workspaceissues.Run{}, nil, fmt.Errorf("read workspace issue run output id: %w", err)
		}
		output.ID = uint64(id)
		saved = append(saved, output)
	}

	if err := tx.Commit(); err != nil {
		return workspaceissues.Run{}, nil, fmt.Errorf("commit workspace issue run: %w", err)
	}

	completed, err := s.GetRun(ctx, run.WorkspaceID, run.IssueID, run.TaskID, run.RunID)
	if err != nil {
		return workspaceissues.Run{}, nil, err
	}
	return completed, saved, nil
}

func (s *SQLiteStore) ListRuns(ctx context.Context, workspaceID string, issueID string, taskID string) ([]workspaceissues.Run, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return nil, err
	}

	query := fmt.Sprintf(`
SELECT %s
FROM workspace_issue_runs
ORDER BY created_at_unix_ms DESC, id DESC
`, runSelectColumns)
	args := []any{workspaceID, issueID}
	where := "WHERE workspace_id = ? AND issue_id = ?"
	if taskID != "" {
		where += " AND task_id = ?"
		args = append(args, taskID)
	}
	query = strings.Replace(query, "FROM workspace_issue_runs\n", "FROM workspace_issue_runs\n"+where+"\n", 1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list workspace issue runs: %w", err)
	}
	defer rows.Close()

	items := make([]workspaceissues.Run, 0)
	for rows.Next() {
		item, err := scanWorkspaceIssueRun(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace issue runs: %w", err)
	}
	return items, nil
}

func (s *SQLiteStore) ListRunningRuns(ctx context.Context, workspaceID string, limit int) ([]workspaceissues.Run, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 100
	}

	rows, err := s.db.QueryContext(ctx, fmt.Sprintf(`
SELECT %s
FROM workspace_issue_runs
WHERE workspace_id = ? AND status = ? AND TRIM(agent_session_id) <> ''
ORDER BY updated_at_unix_ms ASC, id ASC
LIMIT ?
`, runSelectColumns), workspaceID, string(workspaceissues.StatusRunning), limit)
	if err != nil {
		return nil, fmt.Errorf("list running workspace issue runs: %w", err)
	}
	defer rows.Close()

	items := make([]workspaceissues.Run, 0)
	for rows.Next() {
		item, err := scanWorkspaceIssueRun(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate running workspace issue runs: %w", err)
	}
	return items, nil
}

func (s *SQLiteStore) GetRun(ctx context.Context, workspaceID string, issueID string, taskID string, runID string) (workspaceissues.Run, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Run{}, err
	}

	row := s.db.QueryRowContext(ctx, fmt.Sprintf(`
SELECT %s
FROM workspace_issue_runs
WHERE workspace_id = ? AND issue_id = ? AND task_id = ? AND run_id = ?
`, runSelectColumns), workspaceID, issueID, taskID, runID)
	run, err := scanWorkspaceIssueRun(row)
	if errors.Is(err, sql.ErrNoRows) {
		return workspaceissues.Run{}, workspaceissues.ErrRunNotFound
	}
	if err != nil {
		return workspaceissues.Run{}, fmt.Errorf("get workspace issue run: %w", err)
	}
	return run, nil
}

func (s *SQLiteStore) ListRunOutputs(ctx context.Context, workspaceID string, issueID string, taskID string, runID string) ([]workspaceissues.RunOutput, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return nil, err
	}

	rows, err := s.db.QueryContext(ctx, fmt.Sprintf(`
SELECT %s
FROM workspace_issue_run_outputs
WHERE workspace_id = ? AND issue_id = ? AND task_id = ? AND run_id = ?
ORDER BY created_at_unix_ms ASC, id ASC
`, runOutputSelectColumns), workspaceID, issueID, taskID, runID)
	if err != nil {
		return nil, fmt.Errorf("list workspace issue run outputs: %w", err)
	}
	defer rows.Close()

	outputs := make([]workspaceissues.RunOutput, 0)
	for rows.Next() {
		item, err := scanWorkspaceIssueRunOutput(rows)
		if err != nil {
			return nil, err
		}
		outputs = append(outputs, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace issue run outputs: %w", err)
	}
	return outputs, nil
}

func (s *SQLiteStore) ListLatestRunOutputs(ctx context.Context, workspaceID string, issueID string, taskID string) ([]workspaceissues.RunOutput, error) {
	runs, err := s.ListRuns(ctx, workspaceID, issueID, taskID)
	if err != nil || len(runs) == 0 {
		return nil, err
	}
	return s.ListRunOutputs(ctx, workspaceID, issueID, runs[0].TaskID, runs[0].RunID)
}
