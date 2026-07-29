package workspace

import (
	"context"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

func TestTuttiModeReviewerActivityReadsOnlyOwnedActiveStates(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_000_000_000).UTC()
	prepareTuttiModeExecutionWorkspace(
		t, store, "workspace-reviewer", "workflow-reviewer",
		"session-reviewer", now,
	)
	issues := workspaceissues.Service{
		Store: store, Clock: func() time.Time { return now },
	}
	issue, tasks := prepareTuttiModeIssueGraph(
		t, issues, "workspace-reviewer", "workflow-reviewer",
		"session-reviewer",
	)
	executions := executionservice.Service{
		Store: store, Clock: func() time.Time { return now },
	}
	_, _, aggregate, err := executions.Materialize(
		ctx,
		executionservice.MaterializeInput{
			Issue: issue, Tasks: tasks, WorkflowID: "workflow-reviewer",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
INSERT INTO workspace_tutti_goal_reviews (
  workspace_id, execution_id, checkpoint_id, review_id,
  status, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, 'review-reader', 'prepared', ?, ?)
`, issue.WorkspaceID, aggregate.Execution.ID,
		aggregate.Checkpoints[0].ID, now.UnixMilli(), now.UnixMilli()); err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		status string
		active bool
	}{
		{status: "prepared", active: true},
		{status: "dispatched", active: true},
		{status: "submitted", active: false},
		{status: "failed", active: false},
		{status: "canceled", active: false},
	} {
		t.Run(test.status, func(t *testing.T) {
			if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_goal_reviews
SET status = ?, updated_at_unix_ms = updated_at_unix_ms + 1
WHERE workspace_id = ? AND execution_id = ?
`, test.status, issue.WorkspaceID, aggregate.Execution.ID); err != nil {
				t.Fatal(err)
			}
			active, err := store.HasActiveTuttiModeReviewer(
				ctx, issue.WorkspaceID, issue.IssueID,
			)
			if err != nil || active != test.active {
				t.Fatalf(
					"HasActiveTuttiModeReviewer(%s) = %v, %v; want %v",
					test.status, active, err, test.active,
				)
			}
		})
	}
}
