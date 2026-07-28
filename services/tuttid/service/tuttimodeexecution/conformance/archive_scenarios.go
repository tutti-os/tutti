package conformance

import (
	"context"
	"fmt"
	"time"
)

func ArchiveCatalog() []Scenario {
	return []Scenario{
		{Name: "ArchiveFencesRunsAndWaitsForSettlement", run: runArchiveFencesRunsAndWaitsForSettlement},
		{Name: "ArchiveCancellationFailureRecoversAfterRestart", run: runArchiveCancellationFailureRecoversAfterRestart},
	}
}

func runArchiveFencesRunsAndWaitsForSettlement(ctx context.Context, driver Driver) error {
	issueID, snapshot, schedule, err := prepareRunningArchiveExecution(ctx, driver, "archive")
	if err != nil {
		return err
	}
	operation, err := driver.Archive(ctx, ArchiveInput{
		WorkspaceID: snapshot.Execution.WorkspaceID, IssueID: issueID,
		RequestID: "archive-request", RequestedBy: "local-user", Reason: "stop requested",
	})
	if err != nil {
		return fmt.Errorf("request archive: %w", err)
	}
	if operation.Status != "archiving" {
		return fmt.Errorf("archive before settlement=%#v", operation)
	}
	replay, err := driver.Archive(ctx, ArchiveInput{
		WorkspaceID: snapshot.Execution.WorkspaceID, IssueID: issueID,
		RequestID: "archive-request", RequestedBy: "local-user", Reason: "stop requested",
	})
	if err != nil || replay.OperationID != operation.OperationID {
		return fmt.Errorf("archive replay=%#v error=%v", replay, err)
	}
	if _, err := driver.Schedule(ctx, ScheduleInput{
		WorkspaceID: snapshot.Execution.WorkspaceID, IssueID: issueID,
		SourceSessionID:       snapshot.Execution.SourceSessionID,
		CheckpointID:          snapshot.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: 1, TaskIDs: []string{snapshot.Tasks[0].TaskID},
		RequestID: "schedule-after-archive",
	}); err == nil {
		return fmt.Errorf("schedule admitted after archive fence")
	}
	driver.EnableAutomaticRecovery(ctx)
	if err := driver.SettleRun(ctx, SettleRunInput{
		WorkspaceID: snapshot.Execution.WorkspaceID, IssueID: issueID,
		TaskID: snapshot.Tasks[0].TaskID, RunID: schedule.RunIDs[0], Status: "canceled",
	}); err != nil {
		return fmt.Errorf("settle archived Run: %w", err)
	}
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		current, getErr := driver.GetArchive(waitCtx, snapshot.Execution.WorkspaceID, operation.OperationID)
		if getErr != nil {
			return fmt.Errorf("read automatically recovered archive: %w", getErr)
		}
		if current.Status == "completed" {
			break
		}
		select {
		case <-waitCtx.Done():
			return fmt.Errorf("wait for automatic archive recovery: %w", waitCtx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	final, err := driver.GetSnapshot(ctx, snapshot.Execution.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	if final.Execution.Status != "archived" || final.Execution.ArchivedAt.IsZero() ||
		final.Execution.ArchivedBy != "local-user" || final.Execution.ArchiveReason != "stop requested" {
		return fmt.Errorf("final archived execution=%#v", final.Execution)
	}
	return nil
}

func runArchiveCancellationFailureRecoversAfterRestart(ctx context.Context, driver Driver) error {
	issueID, snapshot, schedule, err := prepareRunningArchiveExecution(ctx, driver, "archive-failure")
	if err != nil {
		return err
	}
	driver.FailNextCancellation()
	failed, err := driver.Archive(ctx, ArchiveInput{
		WorkspaceID: snapshot.Execution.WorkspaceID, IssueID: issueID,
		RequestID: "archive-failure-request", RequestedBy: "local-user", Reason: "stop requested",
	})
	if err == nil || failed.Status != "failed" || failed.LastError == "" {
		return fmt.Errorf("failed cancellation archive=%#v error=%v", failed, err)
	}
	if err := driver.RestartRecoverArchives(ctx, snapshot.Execution.WorkspaceID); err != nil {
		return fmt.Errorf("restart archive recovery: %w", err)
	}
	current, err := driver.GetArchive(ctx, snapshot.Execution.WorkspaceID, failed.OperationID)
	if err != nil || current.Status != "archiving" {
		return fmt.Errorf("recovered archive=%#v error=%v", current, err)
	}
	driver.EnableAutomaticRecovery(ctx)
	if err := driver.SettleRun(ctx, SettleRunInput{
		WorkspaceID: snapshot.Execution.WorkspaceID, IssueID: issueID,
		TaskID: snapshot.Tasks[0].TaskID, RunID: schedule.RunIDs[0], Status: "canceled",
	}); err != nil {
		return err
	}
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		current, err = driver.GetArchive(waitCtx, snapshot.Execution.WorkspaceID, failed.OperationID)
		if err != nil {
			return err
		}
		if current.Status == "completed" && !current.CompletedAt.IsZero() {
			return nil
		}
		select {
		case <-waitCtx.Done():
			return fmt.Errorf("wait for recovered archive completion: %w", waitCtx.Err())
		case <-time.After(time.Millisecond):
		}
	}
}

func prepareRunningArchiveExecution(
	ctx context.Context, driver Driver, suffix string,
) (string, Snapshot, ScheduleResult, error) {
	workspaceID := "workspace-materialization"
	workflowID := "workflow-" + suffix
	sourceID := "source-" + suffix
	issueID, err := driver.AcceptPlan(ctx, AcceptPlanInput{
		WorkspaceID: workspaceID, WorkflowID: workflowID, RevisionID: "revision-" + suffix,
		CheckpointID: "review-" + suffix, SourceSessionID: sourceID,
		TopicID: "default", Title: "Archive", Content: "Archive",
		Tasks: []Task{{TaskID: "task-1", Title: "Task", AgentTargetID: "local:codex"}},
	})
	if err != nil {
		return "", Snapshot{}, ScheduleResult{}, err
	}
	snapshot, err := driver.GetSnapshot(ctx, workspaceID, issueID)
	if err != nil {
		return "", Snapshot{}, ScheduleResult{}, err
	}
	schedule, err := driver.Schedule(ctx, ScheduleInput{
		WorkspaceID: workspaceID, IssueID: issueID, SourceSessionID: sourceID,
		CheckpointID:          snapshot.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: 1, TaskIDs: []string{"task-1"},
		RequestID: "schedule-" + suffix,
	})
	return issueID, snapshot, schedule, err
}
