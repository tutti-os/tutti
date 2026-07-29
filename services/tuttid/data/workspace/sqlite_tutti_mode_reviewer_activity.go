package workspace

import (
	"context"
	"fmt"
	"strings"
)

// HasActiveTuttiModeReviewer is deliberately read-only. Goal-review lifecycle
// remains owned by its scheduler; watchdog delivery only consults durable
// prepared/dispatched ownership to avoid duplicating that work.
func (s *SQLiteStore) HasActiveTuttiModeReviewer(
	ctx context.Context,
	workspaceID string,
	issueID string,
) (bool, error) {
	if err := s.ensureIssueDatabase(); err != nil {
		return false, err
	}
	var active bool
	err := s.readDB.QueryRowContext(ctx, `
SELECT EXISTS (
  SELECT 1
  FROM workspace_tutti_goal_reviews r
  JOIN workspace_tutti_executions e
    ON e.workspace_id = r.workspace_id
   AND e.execution_id = r.execution_id
  WHERE e.workspace_id = ? AND e.issue_id = ?
    AND r.status IN ('prepared', 'dispatched')
)
`, strings.TrimSpace(workspaceID), strings.TrimSpace(issueID)).Scan(&active)
	if err != nil {
		return false, fmt.Errorf("read active Tutti mode goal review: %w", err)
	}
	return active, nil
}
