package conformance

import (
	"context"
	"fmt"
)

func runGraphMutationRebindsPromotedSettlementBacklog(
	ctx context.Context,
	driver Driver,
) error {
	fixture := settlementFixture("mutation-rebinds-backlog")
	issueID, scheduled, err := acceptAndScheduleSettlement(
		ctx, driver, fixture, []string{"task-a", "task-c"},
	)
	if err != nil {
		return err
	}
	for index, taskID := range []string{"task-a", "task-c"} {
		if err := driver.SettleRun(ctx, SettleRunInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			TaskID: taskID, RunID: scheduled.RunIDs[index], Status: "completed",
		}); err != nil {
			return fmt.Errorf("SettleRun(%s) error = %w", taskID, err)
		}
	}
	backlog, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(backlog.Checkpoints) != 3 ||
		backlog.Checkpoints[1].Status != "active" ||
		backlog.Checkpoints[2].Status != "pending" {
		return fmt.Errorf("pre-mutation backlog = %#v error=%v", backlog.Checkpoints, err)
	}
	firstMutation, err := driver.Mutate(ctx, MutateInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          backlog.Checkpoints[1].CheckpointID,
		ExpectedGraphRevision: backlog.Execution.GraphRevision,
		Operations: []MutationOperation{{
			Kind: "add",
			Task: schedulableTask("task-g", "/tmp/tutti-settlement-task-g"),
		}},
		RequestID: "mutate-add-g-before-schedule-promotion",
	})
	if err != nil {
		return fmt.Errorf("Mutate(add G) error = %w", err)
	}
	runG, err := driver.Schedule(ctx, ScheduleInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          backlog.Checkpoints[1].CheckpointID,
		ExpectedGraphRevision: firstMutation.GraphRevision,
		TaskIDs:               []string{"task-g"},
		RequestID:             "schedule-g-promotes-c",
	})
	if err != nil {
		return fmt.Errorf("Schedule(G) error = %w", err)
	}
	afterSchedule, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil ||
		afterSchedule.Checkpoints[2].Status != "active" ||
		afterSchedule.Checkpoints[2].GraphRevision != firstMutation.GraphRevision {
		return fmt.Errorf(
			"schedule promoted stale checkpoint = %#v mutation=%#v error=%v",
			afterSchedule.Checkpoints, firstMutation, err,
		)
	}
	if err := driver.SettleRun(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-g", RunID: runG.RunIDs[0], Status: "completed",
	}); err != nil {
		return fmt.Errorf("SettleRun(G) error = %w", err)
	}
	withPendingG, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(withPendingG.Checkpoints) != 4 ||
		withPendingG.Checkpoints[2].Status != "active" ||
		withPendingG.Checkpoints[3].Status != "pending" {
		return fmt.Errorf("g settlement backlog = %#v error=%v", withPendingG.Checkpoints, err)
	}
	secondMutation, err := driver.Mutate(ctx, MutateInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          withPendingG.Checkpoints[2].CheckpointID,
		ExpectedGraphRevision: withPendingG.Execution.GraphRevision,
		Operations: []MutationOperation{{
			Kind: "add",
			Task: schedulableTask("task-h", "/tmp/tutti-settlement-task-h"),
		}},
		RequestID: "mutate-add-h-before-acknowledge-promotion",
	})
	if err != nil {
		return fmt.Errorf("Mutate(add H) error = %w", err)
	}
	acknowledged, err := driver.Acknowledge(ctx, AcknowledgeInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          withPendingG.Checkpoints[2].CheckpointID,
		ExpectedGraphRevision: secondMutation.GraphRevision,
		RequestID:             "ack-c-promotes-g",
	})
	if err != nil {
		return fmt.Errorf("Acknowledge(C) error = %w", err)
	}
	afterAcknowledge, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil ||
		acknowledged.NextCheckpointID != withPendingG.Checkpoints[3].CheckpointID ||
		afterAcknowledge.Checkpoints[3].Status != "active" ||
		afterAcknowledge.Checkpoints[3].GraphRevision != secondMutation.GraphRevision {
		return fmt.Errorf(
			"acknowledge promoted stale checkpoint = %#v result=%#v mutation=%#v error=%v",
			afterAcknowledge.Checkpoints, acknowledged, secondMutation, err,
		)
	}
	if _, err := driver.Schedule(ctx, ScheduleInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          withPendingG.Checkpoints[3].CheckpointID,
		ExpectedGraphRevision: secondMutation.GraphRevision,
		TaskIDs:               []string{"task-h"},
		RequestID:             "schedule-h-from-rebound-g",
	}); err != nil {
		return fmt.Errorf("Schedule(H from rebound G) error = %w", err)
	}
	return nil
}
