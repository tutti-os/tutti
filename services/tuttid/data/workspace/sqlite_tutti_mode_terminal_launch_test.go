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

func TestTerminalRunFencesPreparedListClaimAndRepair(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_000_170_000).UTC()
	prepareTuttiModeExecutionWorkspace(
		t, store, "workspace-terminal-launch", "workflow-terminal-launch",
		"session-terminal-launch", now,
	)
	executions := &executionservice.Service{
		Store: store, Clock: func() time.Time { return now },
	}
	issues := workspaceissues.Service{
		Store: store, Clock: func() time.Time { return now },
	}
	issue, tasks := prepareTuttiModeIssueGraph(
		t, issues, "workspace-terminal-launch", "workflow-terminal-launch",
		"session-terminal-launch",
	)
	_, _, aggregate, err := executions.Materialize(
		ctx,
		executionservice.MaterializeInput{
			Issue: issue, Tasks: tasks, WorkflowID: "workflow-terminal-launch",
		},
	)
	if err != nil {
		t.Fatalf("Materialize() error = %v", err)
	}
	run := workspaceissues.Run{
		RunID: "run-terminal-launch", TaskID: tasks[0].TaskID,
		IssueID: issue.IssueID, WorkspaceID: issue.WorkspaceID,
		RequesterUserID: "local", AgentUserID: "local",
		AgentTargetID:  tasks[0].AgentTargetID,
		AgentSessionID: "delegate-terminal-launch", AgentProvider: "codex",
		Status:          workspaceissues.StatusRunning,
		CreatedAtUnixMS: now.UnixMilli(), StartedAtUnixMS: now.UnixMilli(),
		UpdatedAtUnixMS: now.UnixMilli(),
	}
	if _, err := store.AdmitTuttiModeSchedule(
		ctx,
		executionbiz.ScheduleAdmission{
			WorkspaceID: issue.WorkspaceID, IssueID: issue.IssueID,
			SourceSessionID:       issue.SourceSessionID,
			CheckpointID:          aggregate.Checkpoints[0].ID,
			ExpectedGraphRevision: 1, RequestID: "schedule-terminal-launch",
			InputSHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			Runs:        []workspaceissues.Run{run}, Now: now,
		},
	); err != nil {
		t.Fatalf("AdmitTuttiModeSchedule() error = %v", err)
	}
	claimed, err := store.ClaimTuttiModeRunLaunchIntent(
		ctx, issue.WorkspaceID, issue.IssueID, run.RunID,
		"held-owner", now, now.Add(time.Minute),
	)
	if err != nil || !claimed {
		t.Fatalf("ClaimTuttiModeRunLaunchIntent() = %v error=%v, want true/nil", claimed, err)
	}
	run.Status = workspaceissues.StatusCanceled
	run.CompletedAtUnixMS = now.Add(time.Second).UnixMilli()
	run.UpdatedAtUnixMS = run.CompletedAtUnixMS
	if _, _, err := store.CompleteRun(ctx, run, nil); err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}
	task := tasks[0]
	task.Status = workspaceissues.StatusCanceled
	task.LatestRunID = run.RunID
	task.UpdatedAtUnixMS = run.UpdatedAtUnixMS
	if _, err := store.UpdateTask(ctx, task); err != nil {
		t.Fatalf("UpdateTask() error = %v", err)
	}
	if _, err := store.RecalculateIssueProjection(
		ctx, issue.WorkspaceID, issue.IssueID,
	); err != nil {
		t.Fatalf("RecalculateIssueProjection() error = %v", err)
	}
	if _, _, err := executions.EnsureRunSettlement(
		ctx,
		executionbiz.RunSettlement{
			WorkspaceID: issue.WorkspaceID, IssueID: issue.IssueID,
			TaskID: run.TaskID, RunID: run.RunID, Status: run.Status,
		},
	); err != nil {
		t.Fatalf("EnsureRunSettlement() error = %v", err)
	}
	var compensationStatus, compensationSessionID, compensationSubmitID string
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT status, agent_session_id, client_submit_id
FROM workspace_issue_run_cancel_compensations
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
`, issue.WorkspaceID, issue.IssueID, run.RunID).Scan(
		&compensationStatus, &compensationSessionID, &compensationSubmitID,
	); err != nil {
		t.Fatalf("read atomic cancel compensation error = %v", err)
	}
	if compensationStatus != "prepared" ||
		compensationSessionID != run.AgentSessionID ||
		compensationSubmitID != workspaceissues.IssueRunClientSubmitID(run.RunID) {
		t.Fatalf(
			"atomic compensation status/session/submit = %q/%q/%q",
			compensationStatus, compensationSessionID, compensationSubmitID,
		)
	}
	compensations, err := store.ListPreparedTuttiModeRunCancelCompensations(
		ctx, issue.WorkspaceID,
	)
	if err != nil || len(compensations) != 1 {
		t.Fatalf("ListPreparedTuttiModeRunCancelCompensations() = %#v error=%v", compensations, err)
	}
	claimed, err = store.ClaimTuttiModeRunCancelCompensation(
		ctx, issue.WorkspaceID, issue.IssueID, run.RunID,
		"cancel-owner-a", now, now.Add(time.Minute),
	)
	if err != nil || !claimed {
		t.Fatalf("ClaimTuttiModeRunCancelCompensation(owner-a) = %v error=%v", claimed, err)
	}
	claimed, err = store.ClaimTuttiModeRunCancelCompensation(
		ctx, issue.WorkspaceID, issue.IssueID, run.RunID,
		"cancel-owner-b", now, now.Add(time.Minute),
	)
	if err != nil || claimed {
		t.Fatalf("ClaimTuttiModeRunCancelCompensation(owner-b) = %v error=%v", claimed, err)
	}
	if err := store.CompleteTuttiModeRunCancelCompensation(
		ctx, issue.WorkspaceID, issue.IssueID, run.RunID,
		"cancel-owner-b", now,
	); !errors.Is(err, executionbiz.ErrScheduleRejected) {
		t.Fatalf("stale CompleteTuttiModeRunCancelCompensation() error = %v", err)
	}
	if err := store.ReleaseTuttiModeRunCancelCompensation(
		ctx, issue.WorkspaceID, issue.IssueID, run.RunID,
		"cancel-owner-a", "retry", now,
	); err != nil {
		t.Fatalf("ReleaseTuttiModeRunCancelCompensation() error = %v", err)
	}
	claimed, err = store.ClaimTuttiModeRunCancelCompensation(
		ctx, issue.WorkspaceID, issue.IssueID, run.RunID,
		"cancel-owner-b", now, now.Add(time.Minute),
	)
	if err != nil || !claimed {
		t.Fatalf("ClaimTuttiModeRunCancelCompensation(retry) = %v error=%v", claimed, err)
	}
	if err := store.CompleteTuttiModeRunCancelCompensation(
		ctx, issue.WorkspaceID, issue.IssueID, run.RunID,
		"cancel-owner-b", now,
	); err != nil {
		t.Fatalf("CompleteTuttiModeRunCancelCompensation() error = %v", err)
	}
	if found, err := store.EnsureTuttiModeRunCancelCompensation(
		ctx, issue.WorkspaceID, issue.IssueID, run.TaskID, run.RunID, now,
	); err != nil || !found {
		t.Fatalf("replayed EnsureTuttiModeRunCancelCompensation() = %v error=%v", found, err)
	}
	compensations, err = store.ListPreparedTuttiModeRunCancelCompensations(
		ctx, issue.WorkspaceID,
	)
	if err != nil || len(compensations) != 0 {
		t.Fatalf("completed compensation replay = %#v error=%v, want none", compensations, err)
	}
	assertTerminalLaunchFenced := func(label string) {
		t.Helper()
		prepared, err := store.ListPreparedTuttiModeRunLaunches(
			ctx, issue.WorkspaceID, issue.IssueID, []string{run.RunID}, now,
		)
		if err != nil || len(prepared) != 0 {
			t.Fatalf("%s prepared launches = %#v error=%v, want none", label, prepared, err)
		}
		claimed, err := store.ClaimTuttiModeRunLaunchIntent(
			ctx, issue.WorkspaceID, issue.IssueID, run.RunID,
			"late-owner", now, now.Add(time.Minute),
		)
		if err != nil || claimed {
			t.Fatalf("%s late Claim() = %v error=%v, want false/nil", label, claimed, err)
		}
	}
	assertTerminalLaunchFenced("settlement")

	if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_launch_intents
SET status = 'dispatched', lease_owner = '', lease_expires_at_unix_ms = 0
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?;
DELETE FROM workspace_issue_run_cancel_compensations
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?;
`, issue.WorkspaceID, issue.IssueID, run.RunID,
		issue.WorkspaceID, issue.IssueID, run.RunID); err != nil {
		t.Fatalf("seed legacy dispatched terminal launch error = %v", err)
	}
	if _, err := executions.RepairRunSettlements(ctx, issue.WorkspaceID); err != nil {
		t.Fatalf("RepairRunSettlements(dispatched compensation) error = %v", err)
	}
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT status, agent_session_id, client_submit_id
FROM workspace_issue_run_cancel_compensations
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
`, issue.WorkspaceID, issue.IssueID, run.RunID).Scan(
		&compensationStatus, &compensationSessionID, &compensationSubmitID,
	); err != nil || compensationStatus != "prepared" ||
		compensationSessionID != run.AgentSessionID ||
		compensationSubmitID != workspaceissues.IssueRunClientSubmitID(run.RunID) {
		t.Fatalf(
			"repaired dispatched compensation = %q/%q/%q error=%v",
			compensationStatus, compensationSessionID, compensationSubmitID, err,
		)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_run_launch_intents
SET status = 'prepared', lease_owner = 'stale-owner',
    lease_expires_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
`, now.Add(-time.Minute).UnixMilli(), now.UnixMilli(),
		issue.WorkspaceID, issue.IssueID, run.RunID); err != nil {
		t.Fatalf("seed legacy terminal launch intent error = %v", err)
	}
	if _, err := executions.RepairRunSettlements(ctx, issue.WorkspaceID); err != nil {
		t.Fatalf("RepairRunSettlements() error = %v", err)
	}
	assertTerminalLaunchFenced("repair")
	var intentStatus, leaseOwner string
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT status, lease_owner
FROM workspace_issue_run_launch_intents
WHERE workspace_id = ? AND issue_id = ? AND run_id = ?
`, issue.WorkspaceID, issue.IssueID, run.RunID).Scan(&intentStatus, &leaseOwner); err != nil {
		t.Fatalf("read repaired terminal intent error = %v", err)
	}
	if intentStatus != "canceled" || leaseOwner != "" {
		t.Fatalf(
			"repaired terminal intent status/owner = %q/%q, want canceled/empty",
			intentStatus, leaseOwner,
		)
	}
}
