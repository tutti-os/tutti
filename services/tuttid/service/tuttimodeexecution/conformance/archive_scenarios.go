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
		{Name: "SourceAgentStopRequiresCurrentCheckpoint", run: runSourceAgentStopRequiresCurrentCheckpoint},
		{Name: "SourceSessionStopArchivesEveryNonterminalExecution", run: runSourceSessionStopArchivesEveryNonterminalExecution},
		{Name: "CanceledSourceTurnRecoversStopFromDurableInbox", run: runCanceledSourceTurnRecoversStopFromDurableInbox},
		{Name: "SourceSessionStopCancelsDispatchedAutomationTurns", run: runSourceSessionStopCancelsDispatchedAutomationTurns},
		{Name: "SourceSessionStopCompensatesReviewerDispatchRace", run: runSourceSessionStopCompensatesReviewerDispatchRace},
		{Name: "SourceSessionStopCompensatesMainWakeDispatchRace", run: runSourceSessionStopCompensatesMainWakeDispatchRace},
	}
}

func runSourceSessionStopArchivesEveryNonterminalExecution(
	ctx context.Context,
	driver Driver,
) error {
	const (
		workspaceID     = "workspace-materialization"
		sourceSessionID = "source-session-stop-all"
	)
	issueIDs := make([]string, 0, 2)
	for _, suffix := range []string{"first", "second"} {
		issueID, err := driver.AcceptPlan(ctx, AcceptPlanInput{
			WorkspaceID: workspaceID, WorkflowID: "workflow-stop-all-" + suffix,
			RevisionID: "revision-stop-all-" + suffix, CheckpointID: "review-stop-all-" + suffix,
			SourceSessionID: sourceSessionID, TopicID: "default",
			Title: "Stop all " + suffix, Content: "Stop all " + suffix,
			Tasks: []Task{schedulableTask("task-"+suffix, "/tmp/tutti-stop-all-"+suffix)},
		})
		if err != nil {
			return err
		}
		issueIDs = append(issueIDs, issueID)
	}
	unrelatedIssueID, err := driver.AcceptPlan(ctx, AcceptPlanInput{
		WorkspaceID: workspaceID, WorkflowID: "workflow-stop-all-unrelated",
		RevisionID: "revision-stop-all-unrelated", CheckpointID: "review-stop-all-unrelated",
		SourceSessionID: "source-session-unrelated", TopicID: "default",
		Title: "Unrelated", Content: "Unrelated",
		Tasks: []Task{schedulableTask("task-unrelated", "/tmp/tutti-stop-all-unrelated")},
	})
	if err != nil {
		return err
	}

	stopped, err := driver.StopSourceSession(ctx, workspaceID, sourceSessionID)
	if err != nil || stopped != len(issueIDs) {
		return fmt.Errorf("StopSourceSession() count=%d error=%v, want %d", stopped, err, len(issueIDs))
	}
	replayed, err := driver.StopSourceSession(ctx, workspaceID, sourceSessionID)
	if err != nil || replayed != 0 {
		return fmt.Errorf("StopSourceSession(replay) count=%d error=%v, want 0", replayed, err)
	}
	for _, issueID := range issueIDs {
		snapshot, err := driver.GetSnapshot(ctx, workspaceID, issueID)
		if err != nil || snapshot.Execution.Status != "archived" ||
			activeCheckpoint(snapshot).CheckpointID != "" {
			return fmt.Errorf("stopped execution %q snapshot=%#v error=%v", issueID, snapshot, err)
		}
	}
	unrelated, err := driver.GetSnapshot(ctx, workspaceID, unrelatedIssueID)
	if err != nil || unrelated.Execution.Status != "awaiting_schedule" {
		return fmt.Errorf("unrelated execution snapshot=%#v error=%v", unrelated, err)
	}
	return nil
}

func runCanceledSourceTurnRecoversStopFromDurableInbox(
	ctx context.Context,
	driver Driver,
) error {
	const (
		workspaceID     = "workspace-materialization"
		sourceSessionID = "source-canceled-turn-recovery"
	)
	issueID, err := driver.AcceptPlan(ctx, AcceptPlanInput{
		WorkspaceID: workspaceID, WorkflowID: "workflow-canceled-turn-recovery",
		RevisionID: "revision-canceled-turn-recovery", CheckpointID: "review-canceled-turn-recovery",
		SourceSessionID: sourceSessionID, TopicID: "default",
		Title: "Recover canceled source", Content: "Recover canceled source",
		Tasks: []Task{schedulableTask("task-canceled-turn-recovery", "/tmp/tutti-canceled-turn-recovery")},
	})
	if err != nil {
		return err
	}
	if err := driver.CommitCanonicalSourceCancellation(
		ctx, workspaceID, sourceSessionID, "turn-canceled-source",
	); err != nil {
		return err
	}
	if err := driver.RunWatchdog(ctx, workspaceID, "watchdog-canceled-source"); err != nil {
		return fmt.Errorf("RunWatchdog(canceled source recovery) error = %w", err)
	}
	snapshot, err := driver.GetSnapshot(ctx, workspaceID, issueID)
	if err != nil || snapshot.Execution.Status != "archived" ||
		activeCheckpoint(snapshot).CheckpointID != "" {
		return fmt.Errorf("canceled source recovery snapshot=%#v error=%v", snapshot, err)
	}
	return nil
}

func runSourceSessionStopCancelsDispatchedAutomationTurns(
	ctx context.Context,
	driver Driver,
) error {
	fixture, issueID, before, err := reachGoalReview(
		ctx, driver, "stop-reviewer-turn", "independent", "review-target",
	)
	if err != nil {
		return err
	}
	if err := driver.RecoverReviewers(
		ctx, fixture.WorkspaceID, "review-owner-stop",
	); err != nil {
		return err
	}
	dispatched, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(dispatched.Reviews) != 1 ||
		dispatched.Reviews[0].Status != "dispatched" ||
		dispatched.Reviews[0].TurnID == "" {
		return fmt.Errorf("dispatched reviewer snapshot=%#v error=%v", dispatched, err)
	}
	review := dispatched.Reviews[0]
	stopped, err := driver.StopSourceSession(
		ctx, fixture.WorkspaceID, fixture.SourceSessionID,
	)
	if err != nil || stopped != 1 {
		return fmt.Errorf("StopSourceSession(reviewer) count=%d error=%v", stopped, err)
	}
	found := false
	for _, cancellation := range driver.AutomationTurnCancellations() {
		if cancellation.SessionID == review.SessionID &&
			cancellation.TurnID == review.TurnID {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf(
			"reviewer Turn %s/%s was not canceled: %#v (before=%#v)",
			review.SessionID, review.TurnID,
			driver.AutomationTurnCancellations(), before,
		)
	}
	return nil
}

func runSourceSessionStopCompensatesReviewerDispatchRace(
	ctx context.Context,
	driver Driver,
) error {
	fixture, issueID, before, err := reachGoalReview(
		ctx, driver, "stop-reviewer-race", "independent", "review-target",
	)
	if err != nil {
		return err
	}
	review := before.Reviews[0]
	driver.StopSourceSessionDuringNextReviewerSend(
		fixture.WorkspaceID, fixture.SourceSessionID,
	)
	if err := driver.RecoverReviewers(
		ctx, fixture.WorkspaceID, "review-owner-stop-race",
	); err == nil {
		return fmt.Errorf("RecoverReviewers(stop race) error=nil, want dispatch fence")
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || after.Execution.Status != "archived" ||
		len(after.Reviews) != 1 || after.Reviews[0].Status != "canceled" {
		return fmt.Errorf("reviewer stop race snapshot=%#v error=%v", after, err)
	}
	sessionID, turnID, found := driver.ReviewerCanonicalIdentity(review.ClientSubmitID)
	if !found {
		return fmt.Errorf("reviewer stop race lost canonical identity")
	}
	for _, cancellation := range driver.AutomationTurnCancellations() {
		if cancellation.SessionID == sessionID && cancellation.TurnID == turnID {
			return nil
		}
	}
	return fmt.Errorf(
		"reviewer stop race did not compensate %s/%s: %#v",
		sessionID, turnID, driver.AutomationTurnCancellations(),
	)
}

func runSourceSessionStopCompensatesMainWakeDispatchRace(
	ctx context.Context,
	driver Driver,
) error {
	const (
		workspaceID     = "workspace-materialization"
		sourceSessionID = "source-stop-main-wake-race"
	)
	issueID, err := driver.AcceptPlan(ctx, AcceptPlanInput{
		WorkspaceID: workspaceID, WorkflowID: "workflow-stop-main-wake-race",
		RevisionID: "revision-stop-main-wake-race", CheckpointID: "review-stop-main-wake-race",
		SourceSessionID: sourceSessionID, TopicID: "default",
		Title: "Stop main wake race", Content: "Stop main wake race",
		Tasks: []Task{schedulableTask("task-stop-main-wake-race", "/tmp/tutti-stop-main-wake-race")},
	})
	if err != nil {
		return err
	}
	wakes, err := driver.ListWakes(ctx, workspaceID, issueID)
	if err != nil || len(wakes) != 1 {
		return fmt.Errorf("main wake race setup wakes=%#v error=%v", wakes, err)
	}
	wake := wakes[0]
	driver.StopSourceSessionDuringNextWakeSend(workspaceID, sourceSessionID)
	if err := driver.RecoverWakes(
		ctx, workspaceID, "wake-owner-stop-race",
	); err == nil {
		return fmt.Errorf("RecoverWakes(stop race) error=nil, want dispatch fence")
	}
	after, err := driver.GetSnapshot(ctx, workspaceID, issueID)
	if err != nil || after.Execution.Status != "archived" {
		return fmt.Errorf("main wake stop race snapshot=%#v error=%v", after, err)
	}
	for _, cancellation := range driver.AutomationTurnCancellations() {
		if cancellation.SessionID == sourceSessionID &&
			cancellation.TurnID != "" {
			return nil
		}
	}
	return fmt.Errorf(
		"main wake stop race did not compensate %s: wake=%#v cancellations=%#v",
		sourceSessionID, wake, driver.AutomationTurnCancellations(),
	)
}

func runSourceAgentStopRequiresCurrentCheckpoint(
	ctx context.Context,
	driver Driver,
) error {
	fixture := settlementFixture("source-agent-stop")
	issueID, err := driver.AcceptPlan(ctx, AcceptPlanInput{
		WorkspaceID: fixture.WorkspaceID, WorkflowID: fixture.WorkflowID,
		RevisionID:      "revision-source-agent-stop",
		CheckpointID:    "review-source-agent-stop",
		SourceSessionID: fixture.SourceSessionID,
		TopicID:         "default", Title: "Stop", Content: "Stop",
		Tasks: []Task{schedulableTask("task-a", "/tmp/tutti-source-agent-stop")},
	})
	if err != nil {
		return err
	}
	snapshot, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	checkpoint := activeCheckpoint(snapshot)
	rejected := ArchiveInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID: "another-source", CheckpointID: checkpoint.CheckpointID,
		ExpectedGraphRevision: snapshot.Execution.GraphRevision,
		RequestID:             "source-agent-stop-wrong-source", Reason: "replaced",
	}
	if _, err := driver.Archive(ctx, rejected); err == nil {
		return fmt.Errorf("source Agent stop with wrong source error = nil")
	}
	stop := rejected
	stop.SourceSessionID = fixture.SourceSessionID
	stop.RequestID = "source-agent-stop"
	operation, err := driver.Archive(ctx, stop)
	if err != nil || operation.Status != "completed" ||
		operation.RequestedBy != fixture.SourceSessionID {
		return fmt.Errorf("source Agent stop=%#v error=%v", operation, err)
	}
	replay, err := driver.Archive(ctx, stop)
	if err != nil || replay.OperationID != operation.OperationID {
		return fmt.Errorf("source Agent stop replay=%#v error=%v", replay, err)
	}
	final, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || final.Execution.Status != "archived" ||
		activeCheckpoint(final).CheckpointID != "" {
		return fmt.Errorf("source Agent stop final=%#v error=%v", final, err)
	}
	wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	for _, wake := range wakes {
		if wake.Status != "canceled" && wake.Status != "acknowledged" &&
			wake.Status != "failed" {
			return fmt.Errorf("source Agent stop left open wake=%#v", wake)
		}
	}
	return nil
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
