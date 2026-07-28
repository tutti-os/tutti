package conformance

import (
	"context"
	"fmt"
	"reflect"
	"time"
)

func runTerminalSettlementCreatesCheckpointWithoutSuccessor(
	ctx context.Context,
	driver Driver,
) error {
	for _, outcome := range []struct {
		status string
		kind   string
	}{
		{status: "completed", kind: "task_settled"},
		{status: "failed", kind: "task_failed"},
		{status: "canceled", kind: "task_canceled"},
	} {
		fixture := scheduleFixture()
		fixture.WorkflowID += "-settlement-" + outcome.status
		fixture.RevisionID += "-settlement-" + outcome.status
		fixture.CheckpointID += "-settlement-" + outcome.status
		fixture.Tasks[0].AutoAccept = true
		issueID, err := driver.AcceptPlan(ctx, fixture)
		if err != nil {
			return fmt.Errorf("%s: AcceptPlan() error = %w", outcome.status, err)
		}
		before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if err != nil {
			return fmt.Errorf("%s: GetSnapshot(before) error = %w", outcome.status, err)
		}
		scheduled, err := driver.Schedule(ctx, ScheduleInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			SourceSessionID:       fixture.SourceSessionID,
			CheckpointID:          before.Checkpoints[0].CheckpointID,
			ExpectedGraphRevision: before.Execution.GraphRevision,
			TaskIDs:               []string{"task-a"}, RequestID: "schedule-settlement-" + outcome.status,
		})
		if err != nil {
			return fmt.Errorf("%s: Schedule() error = %w", outcome.status, err)
		}
		launchesAfterSchedule := driver.LauncherCallCount()
		if err := driver.SettleRun(ctx, SettleRunInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			TaskID: "task-a", RunID: scheduled.RunIDs[0], Status: outcome.status,
		}); err != nil {
			return fmt.Errorf("%s: SettleRun() error = %w", outcome.status, err)
		}
		after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if err != nil {
			return fmt.Errorf("%s: GetSnapshot(after) error = %w", outcome.status, err)
		}
		if after.RunCount != 1 || driver.LauncherCallCount() != launchesAfterSchedule {
			return fmt.Errorf(
				"%s: settlement dispatched successor: runs=%d launches=%d, want 1/%d",
				outcome.status, after.RunCount, driver.LauncherCallCount(), launchesAfterSchedule,
			)
		}
		if len(after.Checkpoints) != 2 {
			return fmt.Errorf("%s: checkpoints = %#v, want initial + settlement", outcome.status, after.Checkpoints)
		}
		checkpoint := after.Checkpoints[1]
		if checkpoint.Kind != outcome.kind || checkpoint.Status != "active" ||
			checkpoint.Sequence != 2 || checkpoint.SubjectTaskID != "task-a" ||
			checkpoint.SubjectRunID != scheduled.RunIDs[0] {
			return fmt.Errorf("%s: settlement checkpoint = %#v", outcome.status, checkpoint)
		}
		if outcome.status == "completed" {
			taskStatus := ""
			for _, task := range after.Tasks {
				if task.TaskID == "task-a" {
					taskStatus = task.Status
				}
			}
			if taskStatus != "pending_acceptance" {
				return fmt.Errorf(
					"completed autoAccept task status = %q, want pending_acceptance",
					taskStatus,
				)
			}
		}
		beforeReplay := after
		if err := driver.SettleRun(ctx, SettleRunInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			TaskID: "task-a", RunID: scheduled.RunIDs[0], Status: outcome.status,
		}); err != nil {
			return fmt.Errorf("%s: replay SettleRun() error = %w", outcome.status, err)
		}
		afterReplay, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if err != nil {
			return fmt.Errorf("%s: GetSnapshot(replay) error = %w", outcome.status, err)
		}
		if !reflect.DeepEqual(afterReplay, beforeReplay) ||
			driver.LauncherCallCount() != launchesAfterSchedule {
			return fmt.Errorf(
				"%s: replay mutated settlement: before=%#v after=%#v launches=%d",
				outcome.status, beforeReplay, afterReplay, driver.LauncherCallCount(),
			)
		}
	}
	return nil
}

func runParallelSettlementsQueueOrderedCheckpointBacklog(
	ctx context.Context,
	driver Driver,
) error {
	fixture := scheduleFixture()
	fixture.WorkflowID += "-settlement-backlog"
	fixture.RevisionID += "-settlement-backlog"
	fixture.CheckpointID += "-settlement-backlog"
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	scheduled, err := driver.Schedule(ctx, ScheduleInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          before.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: before.Execution.GraphRevision,
		TaskIDs:               []string{"task-a", "task-c"}, RequestID: "schedule-settlement-backlog",
	})
	if err != nil {
		return fmt.Errorf("Schedule(A,C) error = %w", err)
	}
	for index, taskID := range []string{"task-a", "task-c"} {
		if err := driver.SettleRun(ctx, SettleRunInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			TaskID: taskID, RunID: scheduled.RunIDs[index], Status: "completed",
		}); err != nil {
			return fmt.Errorf("SettleRun(%s) error = %w", taskID, err)
		}
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(after) error = %w", err)
	}
	if len(after.Checkpoints) != 3 {
		return fmt.Errorf("checkpoint backlog = %#v, want initial + two settlements", after.Checkpoints)
	}
	first := after.Checkpoints[1]
	second := after.Checkpoints[2]
	if first.Status != "active" || second.Status != "pending" ||
		first.Sequence != 2 || second.Sequence != 3 ||
		first.SubjectRunID != scheduled.RunIDs[0] ||
		second.SubjectRunID != scheduled.RunIDs[1] {
		return fmt.Errorf("ordered checkpoint backlog = %#v", after.Checkpoints)
	}
	if after.Execution.Status != "awaiting_main" {
		return fmt.Errorf("execution status = %q, want awaiting_main", after.Execution.Status)
	}
	return nil
}

func runSettlementReviewCanScheduleDependentNextStep(ctx context.Context, driver Driver) error {
	fixture := settlementFixture("dependent-next-step")
	issueID, first, err := acceptAndScheduleSettlement(ctx, driver, fixture, []string{"task-a"})
	if err != nil {
		return err
	}
	if err := driver.SettleRun(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: first.RunIDs[0], Status: "completed",
	}); err != nil {
		return fmt.Errorf("SettleRun(A) error = %w", err)
	}
	review, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(review.Checkpoints) != 2 {
		return fmt.Errorf("GetSnapshot(A review) = %#v error=%v", review, err)
	}
	if taskByID(review.Tasks, "task-a").Status != "pending_acceptance" ||
		taskByID(review.Tasks, "task-a").AcceptanceState == "user_accepted" ||
		review.RunCount != 1 || driver.LauncherCallCount() != 1 {
		return fmt.Errorf("a settlement auto-advanced = %#v", review)
	}
	next, err := driver.Schedule(ctx, ScheduleInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          review.Checkpoints[1].CheckpointID,
		ExpectedGraphRevision: review.Execution.GraphRevision,
		TaskIDs:               []string{"task-d"}, RequestID: "schedule-dependent-after-review",
	})
	if err != nil {
		return fmt.Errorf("Schedule(D from A review) error = %w", err)
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(next.RunIDs) != 1 ||
		taskByID(after.Tasks, "task-a").Status != "completed" ||
		taskByID(after.Tasks, "task-a").AcceptanceState != "user_accepted" ||
		taskByID(after.Tasks, "task-d").Status != "running" ||
		after.RunCount != 2 || driver.LauncherCallCount() != 2 {
		return fmt.Errorf("explicit dependent next step = %#v result=%#v error=%v", after, next, err)
	}
	return nil
}

func runScheduleReviewPromotesExistingSettlementBacklog(ctx context.Context, driver Driver) error {
	fixture := settlementFixture("schedule-promotes-backlog")
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
		return fmt.Errorf("pre-schedule backlog = %#v error=%v", backlog.Checkpoints, err)
	}
	_, err = driver.Schedule(ctx, ScheduleInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          backlog.Checkpoints[1].CheckpointID,
		ExpectedGraphRevision: backlog.Execution.GraphRevision,
		TaskIDs:               []string{"task-e"}, RequestID: "schedule-review-promotes-backlog",
	})
	if err != nil {
		return fmt.Errorf("Schedule(E from A review) error = %w", err)
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil ||
		after.Checkpoints[1].Status != "resolved" ||
		after.Checkpoints[2].Status != "active" ||
		after.Execution.Status != "awaiting_main" ||
		taskByID(after.Tasks, "task-a").AcceptanceState != "user_accepted" ||
		taskByID(after.Tasks, "task-c").Status != "pending_acceptance" ||
		taskByID(after.Tasks, "task-e").Status != "running" {
		return fmt.Errorf("post-schedule backlog = %#v error=%v", after, err)
	}
	return nil
}

func runTimedOutRunCreatesFailedCheckpoint(ctx context.Context, driver Driver) error {
	fixture := settlementFixture("timeout")
	issueID, scheduled, err := acceptAndScheduleSettlement(ctx, driver, fixture, []string{"task-a"})
	if err != nil {
		return err
	}
	if err := driver.TimeoutRun(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: scheduled.RunIDs[0],
	}); err != nil {
		return fmt.Errorf("TimeoutRun() error = %w", err)
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(after timeout) error = %w", err)
	}
	if after.Runs[0].Status != "failed" || len(after.Checkpoints) != 2 ||
		after.Checkpoints[1].Kind != "task_failed" ||
		after.Checkpoints[1].SubjectRunID != scheduled.RunIDs[0] ||
		after.RunCount != 1 || driver.LauncherCallCount() != 1 {
		return fmt.Errorf("timeout settlement = %#v", after)
	}
	beforeReplay := after
	if err := driver.TimeoutRun(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: scheduled.RunIDs[0],
	}); err != nil {
		return fmt.Errorf("TimeoutRun(replay) error = %w", err)
	}
	if err := driver.PeriodicRecoverReplica(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("PeriodicRecoverReplica(timeout) error = %w", err)
	}
	replayed, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || !reflect.DeepEqual(replayed, beforeReplay) || driver.LauncherCallCount() != 1 {
		return fmt.Errorf("timeout replay mutated state: before=%#v after=%#v launches=%d error=%v", beforeReplay, replayed, driver.LauncherCallCount(), err)
	}
	return nil
}

func runAuthoritativeLaunchFailureSettlesRun(ctx context.Context, driver Driver) error {
	fixture := settlementFixture("launch-failure")
	driver.FailNextLaunchAuthoritatively()
	issueID, scheduled, err := acceptAndScheduleSettlement(ctx, driver, fixture, []string{"task-a"})
	if err != nil {
		return err
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(after launch failure) error = %w", err)
	}
	if len(after.Runs) != 1 || after.Runs[0].Status != "failed" ||
		len(after.Checkpoints) != 2 ||
		after.Checkpoints[1].Kind != "task_failed" ||
		after.Checkpoints[1].SubjectRunID != scheduled.RunIDs[0] ||
		driver.LauncherCallCount() != 1 {
		return fmt.Errorf("authoritative launch failure = %#v", after)
	}
	replay, err := driver.ScheduleReplica(ctx, ScheduleInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          after.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: after.Execution.GraphRevision,
		TaskIDs:               []string{"task-a"},
		RequestID:             "schedule-settlement-" + fixture.WorkflowID,
	})
	wantReplay := scheduled
	wantReplay.Replayed = true
	if err != nil || !reflect.DeepEqual(replay, wantReplay) {
		return fmt.Errorf("ScheduleReplica(authoritative failure) = %#v, want %#v, error=%v", replay, wantReplay, err)
	}
	afterScheduleReplay, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || !reflect.DeepEqual(afterScheduleReplay, after) || driver.LauncherCallCount() != 1 {
		return fmt.Errorf("launch failure schedule replay mutated state: before=%#v after=%#v launches=%d error=%v", after, afterScheduleReplay, driver.LauncherCallCount(), err)
	}
	beforeRecovery := after
	if err := driver.PeriodicRecoverReplica(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("PeriodicRecoverReplica(launch failure) error = %w", err)
	}
	recovered, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || !reflect.DeepEqual(recovered, beforeRecovery) || driver.LauncherCallCount() != 1 {
		return fmt.Errorf("launch failure recovery mutated state: before=%#v after=%#v launches=%d error=%v", beforeRecovery, recovered, driver.LauncherCallCount(), err)
	}
	return nil
}

func runExpiredLaunchOwnerCannotSettleReclaimedRun(
	ctx context.Context,
	driver Driver,
) error {
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	fixture := settlementFixture("stale-launch-owner")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	started, release := driver.HoldNextLaunchThenFailAuthoritatively()
	scheduleResult := make(chan error, 1)
	go func() {
		_, scheduleErr := driver.Schedule(ctx, ScheduleInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			SourceSessionID:       fixture.SourceSessionID,
			CheckpointID:          before.Checkpoints[0].CheckpointID,
			ExpectedGraphRevision: before.Execution.GraphRevision,
			TaskIDs:               []string{"task-a"},
			RequestID:             "schedule-stale-launch-owner",
		})
		scheduleResult <- scheduleErr
	}()
	select {
	case <-waitCtx.Done():
		release()
		return waitCtx.Err()
	case <-started:
	}
	reclaimedStarted, releaseReclaimed := driver.HoldNextLaunch()
	driver.StopLeaseRenewal()
	driver.AdvanceClockWithoutRenewal(2 * time.Minute)
	recoveryResult := make(chan error, 1)
	go func() {
		recoveryResult <- driver.PeriodicRecoverReplica(ctx, fixture.WorkspaceID)
	}()
	select {
	case <-waitCtx.Done():
		release()
		releaseReclaimed()
		return waitCtx.Err()
	case recoveryErr := <-recoveryResult:
		release()
		releaseReclaimed()
		return fmt.Errorf(
			"PeriodicRecoverReplica(reclaim) returned before entering launcher: %v",
			recoveryErr,
		)
	case <-reclaimedStarted:
	}
	if driver.LauncherCallCount() != 2 {
		release()
		releaseReclaimed()
		return fmt.Errorf("launcher calls after reclaim = %d, want 2", driver.LauncherCallCount())
	}
	release()
	var scheduleErr error
	select {
	case <-waitCtx.Done():
		releaseReclaimed()
		return waitCtx.Err()
	case scheduleErr = <-scheduleResult:
	}
	if scheduleErr != nil {
		releaseReclaimed()
		return fmt.Errorf("Schedule(stale owner) error = %w", scheduleErr)
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		releaseReclaimed()
		return fmt.Errorf("GetSnapshot(after stale failure) error = %w", err)
	}
	if len(after.Runs) != 1 || after.Runs[0].Status != "running" ||
		len(after.Checkpoints) != 1 ||
		after.Execution.Status != "running" ||
		driver.LauncherCallCount() != 2 {
		releaseReclaimed()
		return fmt.Errorf("stale owner terminalized reclaimed Run: %#v", after)
	}
	releaseReclaimed()
	select {
	case <-waitCtx.Done():
		return waitCtx.Err()
	case recoveryErr := <-recoveryResult:
		if recoveryErr != nil {
			return fmt.Errorf("PeriodicRecoverReplica(reclaim) error = %w", recoveryErr)
		}
	}
	return nil
}

func runRepairRestoresMissingSettlementCheckpoint(ctx context.Context, driver Driver) error {
	fixture := settlementFixture("repair")
	issueID, scheduled, err := acceptAndScheduleSettlement(ctx, driver, fixture, []string{"task-a"})
	if err != nil {
		return err
	}
	input := SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: scheduled.RunIDs[0], Status: "completed",
	}
	if err := driver.PersistTerminalRunWithoutCheckpoint(ctx, input); err != nil {
		return fmt.Errorf("PersistTerminalRunWithoutCheckpoint() error = %w", err)
	}
	crashed, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(crashed) error = %w", err)
	}
	if crashed.Runs[0].Status != "completed" || len(crashed.Checkpoints) != 1 {
		return fmt.Errorf("crash fixture = %#v, want terminal Run without settlement checkpoint", crashed)
	}
	if err := driver.PeriodicRecoverReplica(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("PeriodicRecoverReplica() error = %w", err)
	}
	repaired, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(repaired) error = %w", err)
	}
	if len(repaired.Checkpoints) != 2 ||
		repaired.Checkpoints[1].Kind != "task_settled" ||
		repaired.Checkpoints[1].Status != "active" ||
		repaired.Checkpoints[1].Sequence != 2 ||
		repaired.Checkpoints[1].GraphRevision != crashed.Execution.GraphRevision ||
		repaired.Checkpoints[1].SubjectTaskID != "task-a" ||
		repaired.Checkpoints[1].SubjectRunID != scheduled.RunIDs[0] {
		return fmt.Errorf("repaired checkpoints = %#v, want deterministic settlement", repaired.Checkpoints)
	}
	repairedTask := taskByID(repaired.Tasks, "task-a")
	if len(repaired.Runs) != 1 || repaired.Runs[0].Status != "completed" ||
		repairedTask.Status != "pending_acceptance" ||
		repairedTask.AcceptanceState == "user_accepted" ||
		repaired.Execution.Status != "awaiting_main" ||
		repaired.RunCount != crashed.RunCount || driver.LauncherCallCount() != 1 {
		return fmt.Errorf("repaired persisted projection = %#v launches=%d", repaired, driver.LauncherCallCount())
	}
	beforeReplay := repaired
	if err := driver.RepairSettlements(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("RepairSettlements(replay) error = %w", err)
	}
	afterReplay, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || !reflect.DeepEqual(afterReplay, beforeReplay) || driver.LauncherCallCount() != 1 {
		return fmt.Errorf("repair replay mutated state: before=%#v after=%#v launches=%d error=%v", beforeReplay, afterReplay, driver.LauncherCallCount(), err)
	}
	return nil
}

func runAcknowledgeFencesAndDrainsBacklogIntoGoalReview(ctx context.Context, driver Driver) error {
	fixture := settlementFixture("acknowledge")
	fixture.Tasks = []Task{
		schedulableTask("task-a", "/tmp/tutti-contract-task-a"),
		schedulableTask("task-c", "/tmp/tutti-contract-task-c"),
	}
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
	if err != nil {
		return fmt.Errorf("GetSnapshot(backlog) error = %w", err)
	}
	if len(backlog.Checkpoints) != 4 ||
		backlog.Checkpoints[1].Status != "active" ||
		backlog.Checkpoints[2].Status != "pending" ||
		backlog.Checkpoints[3].Kind != "all_tasks_terminal" ||
		backlog.Checkpoints[3].Status != "pending" {
		return fmt.Errorf("terminal backlog = %#v", backlog.Checkpoints)
	}

	assertRejectUnchanged := func(label string, input AcknowledgeInput) error {
		before := backlog
		if _, acknowledgeErr := driver.AcknowledgeReplica(ctx, input); acknowledgeErr == nil {
			return fmt.Errorf("%s Acknowledge() error = nil, want rejection", label)
		}
		after, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if snapshotErr != nil || !reflect.DeepEqual(after, before) {
			return fmt.Errorf("%s rejection mutated state: before=%#v after=%#v error=%v", label, before, after, snapshotErr)
		}
		return nil
	}
	active := backlog.Checkpoints[1]
	base := AcknowledgeInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID: fixture.SourceSessionID,
		CheckpointID:    active.CheckpointID, ExpectedGraphRevision: backlog.Execution.GraphRevision,
		RequestID: "ack-first",
	}
	wrongCaller := base
	wrongCaller.SourceSessionID = "session-other"
	wrongCaller.RequestID = "ack-wrong-caller"
	if err := assertRejectUnchanged("wrong caller", wrongCaller); err != nil {
		return err
	}
	staleRevision := base
	staleRevision.ExpectedGraphRevision++
	staleRevision.RequestID = "ack-stale-revision"
	if err := assertRejectUnchanged("stale revision", staleRevision); err != nil {
		return err
	}
	staleCheckpoint := base
	staleCheckpoint.CheckpointID = "checkpoint-stale"
	staleCheckpoint.RequestID = "ack-stale-checkpoint"
	if err := assertRejectUnchanged("stale checkpoint", staleCheckpoint); err != nil {
		return err
	}

	first, err := driver.Acknowledge(ctx, base)
	if err != nil {
		return fmt.Errorf("Acknowledge(first) error = %w", err)
	}
	if first.Replayed || first.CheckpointID != active.CheckpointID ||
		first.NextCheckpointID != backlog.Checkpoints[2].CheckpointID ||
		first.NextCheckpointState != "active" ||
		first.GraphRevision != backlog.Execution.GraphRevision {
		return fmt.Errorf("Acknowledge(first) = %#v", first)
	}
	promoted, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || promoted.Checkpoints[1].Status != "resolved" ||
		promoted.Checkpoints[2].Status != "active" ||
		taskByID(promoted.Tasks, "task-a").Status != "completed" ||
		taskByID(promoted.Tasks, "task-a").AcceptanceState != "user_accepted" {
		return fmt.Errorf("persisted promotion = %#v error=%v", promoted.Checkpoints, err)
	}
	replay, err := driver.AcknowledgeReplica(ctx, base)
	wantAcknowledgeReplay := first
	wantAcknowledgeReplay.Replayed = true
	if err != nil || !reflect.DeepEqual(replay, wantAcknowledgeReplay) {
		return fmt.Errorf("acknowledge replay = %#v, want %#v error=%v", replay, wantAcknowledgeReplay, err)
	}
	afterAcknowledgeReplay, replaySnapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if replaySnapshotErr != nil || !reflect.DeepEqual(afterAcknowledgeReplay, promoted) {
		return fmt.Errorf("acknowledge replay mutated snapshot: before=%#v after=%#v error=%v", promoted, afterAcknowledgeReplay, replaySnapshotErr)
	}
	conflict := base
	conflict.CheckpointID = backlog.Checkpoints[2].CheckpointID
	beforeConflict := promoted
	if _, err := driver.AcknowledgeReplica(ctx, conflict); err == nil {
		return fmt.Errorf("acknowledge conflicting replay error = nil")
	}
	afterConflict, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || !reflect.DeepEqual(afterConflict, beforeConflict) {
		return fmt.Errorf("conflicting replay mutated state: before=%#v after=%#v error=%v", beforeConflict, afterConflict, err)
	}

	secondInput := base
	secondInput.CheckpointID = backlog.Checkpoints[2].CheckpointID
	secondInput.RequestID = "ack-second"
	second, err := driver.Acknowledge(ctx, secondInput)
	if err != nil {
		return fmt.Errorf("Acknowledge(second) error = %w", err)
	}
	if second.NextCheckpointID != backlog.Checkpoints[3].CheckpointID ||
		second.NextCheckpointKind != "all_tasks_terminal" ||
		second.NextCheckpointState != "active" {
		return fmt.Errorf("Acknowledge(second) = %#v", second)
	}
	goalReview, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || goalReview.Execution.Status != "pending_goal_review" ||
		goalReview.Checkpoints[3].Status != "active" ||
		taskByID(goalReview.Tasks, "task-c").Status != "completed" ||
		taskByID(goalReview.Tasks, "task-c").AcceptanceState != "user_accepted" {
		return fmt.Errorf("goal review transition = %#v error=%v", goalReview, err)
	}
	goalBefore := goalReview
	goalInput := base
	goalInput.CheckpointID = goalReview.Checkpoints[3].CheckpointID
	goalInput.RequestID = "ack-goal-review"
	if _, err := driver.Acknowledge(ctx, goalInput); err == nil {
		return fmt.Errorf("generic Goal Review acknowledge error = nil")
	}
	goalAfter, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || !reflect.DeepEqual(goalAfter, goalBefore) {
		return fmt.Errorf("goal review rejection mutated state: before=%#v after=%#v error=%v", goalBefore, goalAfter, err)
	}
	return nil
}

func runAcknowledgeEligibilityUsesActiveWorkOrBacklog(ctx context.Context, driver Driver) error {
	activeFixture := settlementFixture("ack-active-run")
	issueID, scheduled, err := acceptAndScheduleSettlement(ctx, driver, activeFixture, []string{"task-a", "task-c"})
	if err != nil {
		return err
	}
	if err := driver.SettleRun(ctx, SettleRunInput{
		WorkspaceID: activeFixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: scheduled.RunIDs[0], Status: "completed",
	}); err != nil {
		return err
	}
	active, _ := driver.GetSnapshot(ctx, activeFixture.WorkspaceID, issueID)
	if len(active.Checkpoints) < 2 {
		return fmt.Errorf("active Run checkpoint backlog = %#v", active.Checkpoints)
	}
	result, err := driver.Acknowledge(ctx, AcknowledgeInput{
		WorkspaceID: activeFixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       activeFixture.SourceSessionID,
		CheckpointID:          active.Checkpoints[1].CheckpointID,
		ExpectedGraphRevision: active.Execution.GraphRevision, RequestID: "ack-with-active-run",
	})
	if err != nil || result.NextCheckpointID != "" {
		return fmt.Errorf("ack with active Run = %#v error=%v", result, err)
	}
	activeAfter, activeSnapshotErr := driver.GetSnapshot(ctx, activeFixture.WorkspaceID, issueID)
	if activeSnapshotErr != nil ||
		activeAfter.Checkpoints[1].Status != "resolved" ||
		activeAfter.Execution.Status != "running" ||
		taskByID(activeAfter.Tasks, "task-a").Status != "completed" ||
		taskByID(activeAfter.Tasks, "task-a").AcceptanceState != "user_accepted" {
		return fmt.Errorf("ack with active Run persisted projection = %#v error=%v", activeAfter, activeSnapshotErr)
	}

	idleFixture := settlementFixture("ack-no-work")
	idleIssueID, idleRun, err := acceptAndScheduleSettlement(ctx, driver, idleFixture, []string{"task-a"})
	if err != nil {
		return err
	}
	if err := driver.SettleRun(ctx, SettleRunInput{
		WorkspaceID: idleFixture.WorkspaceID, IssueID: idleIssueID,
		TaskID: "task-a", RunID: idleRun.RunIDs[0], Status: "completed",
	}); err != nil {
		return err
	}
	idle, _ := driver.GetSnapshot(ctx, idleFixture.WorkspaceID, idleIssueID)
	activeRuns := 0
	for _, run := range idle.Runs {
		if run.Status == "running" {
			activeRuns++
		}
	}
	if len(idle.Checkpoints) != 2 ||
		idle.Checkpoints[0].Status != "resolved" ||
		idle.Checkpoints[1].Status != "active" ||
		activeRuns != 0 {
		return fmt.Errorf("idle checkpoint backlog = %#v", idle.Checkpoints)
	}
	before := idle
	_, err = driver.Acknowledge(ctx, AcknowledgeInput{
		WorkspaceID: idleFixture.WorkspaceID, IssueID: idleIssueID,
		SourceSessionID:       idleFixture.SourceSessionID,
		CheckpointID:          idle.Checkpoints[1].CheckpointID,
		ExpectedGraphRevision: idle.Execution.GraphRevision, RequestID: "ack-with-no-work",
	})
	after, snapshotErr := driver.GetSnapshot(ctx, idleFixture.WorkspaceID, idleIssueID)
	if err == nil || snapshotErr != nil || !reflect.DeepEqual(after, before) {
		return fmt.Errorf("ack without active work/backlog: error=%v before=%#v after=%#v snapshotError=%v", err, before, after, snapshotErr)
	}
	return nil
}

func runMixedTerminalOutcomesReachGoalReview(ctx context.Context, driver Driver) error {
	fixture := settlementFixture("mixed-terminal")
	fixture.Tasks = []Task{
		schedulableTask("task-a", "/tmp/tutti-contract-task-a"),
		schedulableTask("task-c", "/tmp/tutti-contract-task-c"),
	}
	issueID, scheduled, err := acceptAndScheduleSettlement(ctx, driver, fixture, []string{"task-a", "task-c"})
	if err != nil {
		return err
	}
	for index, outcome := range []string{"failed", "canceled"} {
		if err := driver.SettleRun(ctx, SettleRunInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			TaskID: fixture.Tasks[index].TaskID, RunID: scheduled.RunIDs[index], Status: outcome,
		}); err != nil {
			return err
		}
	}
	snapshot, _ := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if len(snapshot.Checkpoints) != 4 {
		return fmt.Errorf("mixed terminal backlog = %#v", snapshot.Checkpoints)
	}
	for index := 1; index <= 2; index++ {
		if _, err := driver.Acknowledge(ctx, AcknowledgeInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			SourceSessionID:       fixture.SourceSessionID,
			CheckpointID:          snapshot.Checkpoints[index].CheckpointID,
			ExpectedGraphRevision: snapshot.Execution.GraphRevision,
			RequestID:             fmt.Sprintf("ack-mixed-%d", index),
		}); err != nil {
			return err
		}
	}
	goal, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(goal.Checkpoints) != 4 ||
		goal.Checkpoints[3].Kind != "all_tasks_terminal" ||
		goal.Checkpoints[3].Status != "active" ||
		goal.Execution.Status != "pending_goal_review" {
		return fmt.Errorf("mixed terminal Goal Review = %#v error=%v", goal, err)
	}
	return nil
}

func taskByID(tasks []Task, taskID string) Task {
	for _, task := range tasks {
		if task.TaskID == taskID {
			return task
		}
	}
	return Task{}
}

func settlementFixture(suffix string) AcceptPlanInput {
	fixture := scheduleFixture()
	fixture.WorkflowID += "-settlement-" + suffix
	fixture.RevisionID += "-settlement-" + suffix
	fixture.CheckpointID += "-settlement-" + suffix
	return fixture
}

func acceptAndScheduleSettlement(
	ctx context.Context,
	driver Driver,
	fixture AcceptPlanInput,
	taskIDs []string,
) (string, ScheduleResult, error) {
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return "", ScheduleResult{}, fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return "", ScheduleResult{}, fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	scheduled, err := driver.Schedule(ctx, ScheduleInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          before.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: before.Execution.GraphRevision,
		TaskIDs:               taskIDs, RequestID: "schedule-settlement-" + fixture.WorkflowID,
	})
	if err != nil {
		return "", ScheduleResult{}, fmt.Errorf("Schedule() error = %w", err)
	}
	return issueID, scheduled, nil
}
