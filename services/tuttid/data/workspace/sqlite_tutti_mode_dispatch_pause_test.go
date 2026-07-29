package workspace

import (
	"context"
	"errors"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	executionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

func TestTuttiModeDispatchPauseFencesMainWakeDelivery(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_000_400_000).UTC()
	const (
		workspaceID = "workspace-paused-main-wake"
		workflowID  = "workflow-paused-main-wake"
		sourceID    = "session-paused-main-wake"
	)
	prepareTuttiModeExecutionWorkspace(
		t, store, workspaceID, workflowID, sourceID, now,
	)
	issues := workspaceissues.Service{
		Store: store, Clock: func() time.Time { return now },
	}
	issue, tasks := prepareTuttiModeIssueGraph(
		t, issues, workspaceID, workflowID, sourceID,
	)
	executions := &executionservice.Service{
		Store: store, Clock: func() time.Time { return now },
	}
	created, _, aggregate, err := executions.Materialize(
		ctx,
		executionservice.MaterializeInput{
			Issue: issue, Tasks: tasks, WorkflowID: workflowID,
		},
	)
	if err != nil {
		t.Fatalf("Materialize() error = %v", err)
	}
	wakes, err := store.ListTuttiModeExecutionWakes(
		ctx, workspaceID, created.IssueID,
	)
	if err != nil || len(wakes) != 1 {
		t.Fatalf("initial wakes = %#v, error = %v", wakes, err)
	}
	wake := wakes[0]
	persistedIssue, err := store.GetIssue(ctx, workspaceID, created.IssueID)
	if err != nil {
		t.Fatalf("GetIssue() error = %v", err)
	}
	persistedIssue.DispatchPaused = true
	persistedIssue.UpdatedAtUnixMS = now.Add(time.Second).UnixMilli()
	if _, err := store.UpdateIssue(ctx, persistedIssue); err != nil {
		t.Fatalf("UpdateIssue(pause) error = %v", err)
	}

	dispatchable, err := store.ListDispatchableTuttiModeMainWakes(
		ctx, workspaceID, now,
	)
	if err != nil || len(dispatchable) != 0 {
		t.Fatalf("dispatchable paused wakes = %#v, error = %v", dispatchable, err)
	}
	claimed, err := store.ClaimTuttiModeExecutionWake(
		ctx, workspaceID, wake.ID, "paused-owner", now, now.Add(time.Minute),
	)
	if err != nil || claimed {
		t.Fatalf("ClaimTuttiModeExecutionWake(paused) = %v, %v", claimed, err)
	}

	persistedIssue.DispatchPaused = false
	persistedIssue.UpdatedAtUnixMS = now.Add(2 * time.Second).UnixMilli()
	if _, err := store.UpdateIssue(ctx, persistedIssue); err != nil {
		t.Fatalf("UpdateIssue(resume) error = %v", err)
	}
	dispatchable, err = store.ListDispatchableTuttiModeMainWakes(
		ctx, workspaceID, now,
	)
	if err != nil || len(dispatchable) != 1 ||
		dispatchable[0].ID != wake.ID {
		t.Fatalf("dispatchable resumed wakes = %#v, error = %v", dispatchable, err)
	}
	claimed, err = store.ClaimTuttiModeExecutionWake(
		ctx, workspaceID, wake.ID, "resumed-owner", now, now.Add(time.Minute),
	)
	if err != nil || !claimed {
		t.Fatalf("ClaimTuttiModeExecutionWake(resumed) = %v, %v", claimed, err)
	}

	persistedIssue.DispatchPaused = true
	persistedIssue.UpdatedAtUnixMS = now.Add(3 * time.Second).UnixMilli()
	if _, err := store.UpdateIssue(ctx, persistedIssue); err != nil {
		t.Fatalf("UpdateIssue(repause) error = %v", err)
	}
	err = store.MarkTuttiModeExecutionWakeDispatched(
		ctx, workspaceID, wake.ID, "resumed-owner", sourceID, "turn-paused-race",
		wake.DueAt, now,
	)
	if !errors.Is(err, executionbiz.ErrWakeRejected) {
		t.Fatalf(
			"MarkTuttiModeExecutionWakeDispatched(paused race) error = %v, want ErrWakeRejected",
			err,
		)
	}
	after, ok, err := store.GetTuttiModeExecutionWake(ctx, workspaceID, wake.ID)
	if err != nil || !ok || after.Status != executionbiz.WakeStatusLeased {
		t.Fatalf("wake after rejected finalization = %#v, ok=%v error=%v", after, ok, err)
	}
	if aggregate.Execution.ID != wake.ExecutionID {
		t.Fatalf("materialized execution = %q, wake execution = %q", aggregate.Execution.ID, wake.ExecutionID)
	}
}

func TestTuttiModeDispatchPauseDefersNextWatchdogWakeSequence(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_000_500_000).UTC()
	const (
		workspaceID = "workspace-paused-watchdog"
		workflowID  = "workflow-paused-watchdog"
		sourceID    = "session-paused-watchdog"
	)
	prepareTuttiModeExecutionWorkspace(
		t, store, workspaceID, workflowID, sourceID, now,
	)
	issues := workspaceissues.Service{
		Store: store, Clock: func() time.Time { return now },
	}
	issue, tasks := prepareTuttiModeIssueGraph(
		t, issues, workspaceID, workflowID, sourceID,
	)
	executions := &executionservice.Service{
		Store: store, Clock: func() time.Time { return now },
	}
	created, _, aggregate, err := executions.Materialize(
		ctx,
		executionservice.MaterializeInput{
			Issue: issue, Tasks: tasks, WorkflowID: workflowID,
		},
	)
	if err != nil {
		t.Fatalf("Materialize() error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_issues
SET dispatch_paused = 1, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ?
`, now.UnixMilli(), workspaceID, created.IssueID); err != nil {
		t.Fatalf("pause watchdog fixture error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET status = 'turn_settled', turn_settled_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ?
`, now.UnixMilli(), now.UnixMilli(), workspaceID, aggregate.Execution.ID); err != nil {
		t.Fatalf("settle watchdog wake fixture error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_executions
SET watchdog_due_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ?
`, now.UnixMilli(), now.UnixMilli(), workspaceID, aggregate.Execution.ID); err != nil {
		t.Fatalf("advance watchdog deadline fixture error = %v", err)
	}

	if err := store.PrepareDueTuttiModeExecutionWatchdogs(
		ctx, workspaceID, now,
	); err != nil {
		t.Fatalf("PrepareDueTuttiModeExecutionWatchdogs(paused) error = %v", err)
	}
	wakes, err := store.ListTuttiModeExecutionWakes(
		ctx, workspaceID, created.IssueID,
	)
	if err != nil || len(wakes) != 1 {
		t.Fatalf("paused watchdog wakes = %#v, error = %v", wakes, err)
	}

	if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_issues
SET dispatch_paused = 0, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ?
`, now.Add(time.Second).UnixMilli(), workspaceID, created.IssueID); err != nil {
		t.Fatalf("resume watchdog fixture error = %v", err)
	}
	if err := store.PrepareDueTuttiModeExecutionWatchdogs(
		ctx, workspaceID, now,
	); err != nil {
		t.Fatalf("PrepareDueTuttiModeExecutionWatchdogs(resumed) error = %v", err)
	}
	wakes, err = store.ListTuttiModeExecutionWakes(
		ctx, workspaceID, created.IssueID,
	)
	if err != nil || len(wakes) != 2 ||
		wakes[1].Sequence != 2 ||
		wakes[1].Status != executionbiz.WakeStatusPrepared {
		t.Fatalf("resumed watchdog wakes = %#v, error = %v", wakes, err)
	}
}
