package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

// CreateIssueWithContextRefs atomically commits an Issue, its managed-file
// references, and topic activity. Attachment bytes are staged before this
// transaction and startup reconciliation removes only files that never gained
// a committed reference.
func (s *SQLiteStore) CreateIssueWithContextRefs(
	ctx context.Context,
	issue workspaceissues.Issue,
	refs []workspaceissues.ContextRef,
) (workspaceissues.Issue, []workspaceissues.ContextRef, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return workspaceissues.Issue{}, nil, err
	}
	if err := s.ensureIssueWorkspace(ctx, issue.WorkspaceID); err != nil {
		return workspaceissues.Issue{}, nil, err
	}
	if len(refs) == 0 {
		return workspaceissues.Issue{}, nil, workspaceissues.ErrInvalidArgument
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return workspaceissues.Issue{}, nil, fmt.Errorf("begin create workspace issue with context refs: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var topicExists int
	err = tx.QueryRowContext(ctx, `
SELECT 1 FROM workspace_issue_topics WHERE workspace_id = ? AND topic_id = ?
`, issue.WorkspaceID, issue.TopicID).Scan(&topicExists)
	if errors.Is(err, sql.ErrNoRows) {
		return workspaceissues.Issue{}, nil, workspaceissues.ErrTopicNotFound
	}
	if err != nil {
		return workspaceissues.Issue{}, nil, fmt.Errorf("get workspace issue topic for attachment create: %w", err)
	}
	createdIssue, err := insertWorkspaceIssue(ctx, tx, issue)
	if err != nil {
		return workspaceissues.Issue{}, nil, err
	}
	savedRefs := make([]workspaceissues.ContextRef, 0, len(refs))
	for _, ref := range refs {
		if ref.WorkspaceID != issue.WorkspaceID || ref.IssueID != issue.IssueID ||
			ref.TaskID != "" || ref.ParentKind != workspaceissues.ContextRefParentIssue {
			return workspaceissues.Issue{}, nil, workspaceissues.ErrInvalidArgument
		}
		created, err := insertWorkspaceIssueContextRef(ctx, tx, ref)
		if err != nil {
			return workspaceissues.Issue{}, nil, err
		}
		savedRefs = append(savedRefs, created)
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_issue_topics
SET last_activity_at_unix_ms = ?
WHERE workspace_id = ? AND topic_id = ?
`, issue.UpdatedAtUnixMS, issue.WorkspaceID, issue.TopicID)
	if err != nil {
		return workspaceissues.Issue{}, nil, fmt.Errorf("touch workspace issue topic activity during attachment create: %w", err)
	}
	if err := requireRowsAffected(result, workspaceissues.ErrTopicNotFound, "touch workspace issue topic activity during attachment create"); err != nil {
		return workspaceissues.Issue{}, nil, err
	}
	if err := tx.Commit(); err != nil {
		return workspaceissues.Issue{}, nil, fmt.Errorf("commit create workspace issue with context refs: %w", err)
	}
	return createdIssue, savedRefs, nil
}
