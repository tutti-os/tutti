package workspace

import (
	"context"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

func TestPrepareDueTuttiModeExecutionWatchdogsRebindsStaleActiveCheckpointRevision(
	t *testing.T,
) {
	t.Parallel()
	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_000_000_000).UTC()
	prepareTuttiModeExecutionWorkspace(
		t, store, "workspace-checkpoint-recovery", "workflow-checkpoint-recovery",
		"session-checkpoint-recovery", now,
	)
	issues := workspaceissues.Service{
		Store: store, Clock: func() time.Time { return now },
	}
	issue, tasks := prepareTuttiModeIssueGraph(
		t, issues, "workspace-checkpoint-recovery", "workflow-checkpoint-recovery",
		"session-checkpoint-recovery",
	)
	executions := executionservice.Service{
		Store: store, Clock: func() time.Time { return now },
	}
	_, _, aggregate, err := executions.Materialize(
		ctx,
		executionservice.MaterializeInput{
			Issue: issue, Tasks: tasks, WorkflowID: "workflow-checkpoint-recovery",
		},
	)
	if err != nil {
		t.Fatalf("Materialize() error = %v", err)
	}
	checkpointID := aggregate.Checkpoints[0].ID
	executionID := aggregate.Execution.ID
	if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_executions
SET status = 'awaiting_main', graph_revision = 2,
    watchdog_due_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ?
`, now.Add(5*time.Minute).UnixMilli(), now.UnixMilli(),
		issue.WorkspaceID, executionID); err != nil {
		t.Fatalf("prepare execution revision error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_execution_checkpoints
SET kind = 'task_settled', graph_revision = 1, updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
`, now.UnixMilli(), issue.WorkspaceID, executionID, checkpointID); err != nil {
		t.Fatalf("prepare stale checkpoint revision error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET status = 'turn_settled', turn_settled_at_unix_ms = ?,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
`, now.UnixMilli(), now.UnixMilli(),
		issue.WorkspaceID, executionID, checkpointID); err != nil {
		t.Fatalf("prepare settled wake error = %v", err)
	}

	if err := store.PrepareDueTuttiModeExecutionWatchdogs(
		ctx, issue.WorkspaceID, now,
	); err != nil {
		t.Fatalf("PrepareDueTuttiModeExecutionWatchdogs() error = %v", err)
	}

	var checkpointRevision, wakeSequence int64
	var wakeStatus string
	if err := store.readDB.QueryRowContext(ctx, `
SELECT c.graph_revision, w.wake_sequence, w.status
FROM workspace_tutti_execution_checkpoints c
JOIN workspace_tutti_execution_wakes w
  ON w.workspace_id = c.workspace_id AND w.execution_id = c.execution_id
 AND w.checkpoint_id = c.checkpoint_id
WHERE c.workspace_id = ? AND c.execution_id = ? AND c.checkpoint_id = ?
ORDER BY w.wake_sequence DESC
LIMIT 1
`, issue.WorkspaceID, executionID, checkpointID).
		Scan(&checkpointRevision, &wakeSequence, &wakeStatus); err != nil {
		t.Fatalf("read recovered checkpoint error = %v", err)
	}
	if checkpointRevision != 2 || wakeSequence != 2 || wakeStatus != "prepared" {
		t.Fatalf(
			"recovered checkpoint revision/wake = %d/%d/%q, want 2/2/prepared",
			checkpointRevision, wakeSequence, wakeStatus,
		)
	}
}
