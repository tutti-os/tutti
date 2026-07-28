package conformance

import (
	"context"
	"fmt"
	"time"
)

func runTerminalPreparedLaunchCannotRecover(ctx context.Context, driver Driver) error {
	fixture := settlementFixture("terminal-prepared-launch")
	driver.FailNextLaunch()
	issueID, scheduled, err := acceptAndScheduleSettlement(
		ctx, driver, fixture, []string{"task-a"},
	)
	if err != nil {
		return err
	}
	if driver.LauncherCallCount() != 1 {
		return fmt.Errorf(
			"launcher calls after ambiguous delivery = %d, want 1",
			driver.LauncherCallCount(),
		)
	}
	if err := driver.SettleRun(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: scheduled.RunIDs[0], Status: "canceled",
	}); err != nil {
		return fmt.Errorf("SettleRun(canceled) error = %w", err)
	}
	claimed, err := driver.ClaimRunLaunchReplica(
		ctx, fixture.WorkspaceID, issueID, scheduled.RunIDs[0],
	)
	if err != nil {
		return fmt.Errorf("ClaimRunLaunchReplica(terminal) error = %w", err)
	}
	if claimed {
		return fmt.Errorf("terminal prepared launch remained claimable")
	}
	if err := driver.StartupRecoverReplica(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("StartupRecoverReplica(terminal) error = %w", err)
	}
	if err := driver.PeriodicRecoverReplica(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("PeriodicRecoverReplica(terminal) error = %w", err)
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(terminal prepared) error = %w", err)
	}
	if driver.LauncherCallCount() != 1 ||
		len(after.Runs) != 1 || after.Runs[0].Status != "canceled" ||
		len(after.Checkpoints) != 2 ||
		after.Checkpoints[1].Kind != "task_canceled" {
		return fmt.Errorf(
			"terminal prepared launch recovered: snapshot=%#v launches=%d",
			after, driver.LauncherCallCount(),
		)
	}
	return nil
}

func runTerminalInFlightLaunchIsCanceledAfterDelivery(
	ctx context.Context,
	driver Driver,
) error {
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	fixture := settlementFixture("terminal-in-flight-launch")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	started, release := driver.HoldNextLaunch()
	released := false
	defer func() {
		if !released {
			release()
		}
	}()
	scheduleResult := make(chan error, 1)
	go func() {
		_, scheduleErr := driver.Schedule(ctx, ScheduleInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			SourceSessionID:       fixture.SourceSessionID,
			CheckpointID:          before.Checkpoints[0].CheckpointID,
			ExpectedGraphRevision: before.Execution.GraphRevision,
			TaskIDs:               []string{"task-a"},
			RequestID:             "schedule-terminal-in-flight",
		})
		scheduleResult <- scheduleErr
	}()
	select {
	case <-waitCtx.Done():
		return waitCtx.Err()
	case <-started:
	}
	inFlight, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(inFlight.Runs) != 1 {
		return fmt.Errorf("GetSnapshot(in-flight) = %#v error=%v", inFlight, err)
	}
	runID := inFlight.Runs[0].RunID
	if err := driver.SettleRunReplica(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: runID, Status: "failed",
	}); err != nil {
		return fmt.Errorf("SettleRunReplica(in-flight) error = %w", err)
	}
	pendingCompensations, err := driver.PreparedCancelCompensationCount(
		ctx, fixture.WorkspaceID,
	)
	if err != nil {
		return fmt.Errorf("PreparedCancelCompensationCount() error = %w", err)
	}
	if pendingCompensations != 1 {
		return fmt.Errorf(
			"cancel compensations at terminal commit = %d, want 1",
			pendingCompensations,
		)
	}
	if err := driver.StartupRecoverReplica(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("StartupRecoverReplica(in-flight terminal) error = %w", err)
	}
	if err := driver.PeriodicRecoverReplica(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("PeriodicRecoverReplica(in-flight terminal) error = %w", err)
	}
	if driver.LauncherCallCount() != 1 {
		return fmt.Errorf(
			"terminal in-flight Run relaunched before delivery returned: calls=%d",
			driver.LauncherCallCount(),
		)
	}
	release()
	released = true
	select {
	case <-waitCtx.Done():
		return waitCtx.Err()
	case scheduleErr := <-scheduleResult:
		if scheduleErr != nil {
			return fmt.Errorf("Schedule(in-flight terminal) error = %w", scheduleErr)
		}
	}
	if driver.CancellationCallCount() != 1 {
		return fmt.Errorf(
			"post-launch cancellation calls = %d, want 1",
			driver.CancellationCallCount(),
		)
	}
	if err := driver.PeriodicRecoverReplica(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("PeriodicRecoverReplica(after compensation) error = %w", err)
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(after compensation) error = %w", err)
	}
	if driver.LauncherCallCount() != 1 ||
		len(after.Runs) != 1 || after.Runs[0].Status != "failed" ||
		len(after.Checkpoints) != 2 ||
		after.Checkpoints[1].Kind != "task_failed" {
		return fmt.Errorf(
			"terminal in-flight launch state = %#v launches=%d",
			after, driver.LauncherCallCount(),
		)
	}
	return nil
}

func runTerminalAmbiguousLaunchIsCanceledAfterDelivery(
	ctx context.Context,
	driver Driver,
) error {
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	fixture := settlementFixture("terminal-ambiguous-launch")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	driver.FailNextLaunch()
	started, release := driver.HoldNextLaunch()
	released := false
	defer func() {
		if !released {
			release()
		}
	}()
	scheduleResult := make(chan error, 1)
	go func() {
		_, scheduleErr := driver.Schedule(ctx, ScheduleInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			SourceSessionID:       fixture.SourceSessionID,
			CheckpointID:          before.Checkpoints[0].CheckpointID,
			ExpectedGraphRevision: before.Execution.GraphRevision,
			TaskIDs:               []string{"task-a"},
			RequestID:             "schedule-terminal-ambiguous",
		})
		scheduleResult <- scheduleErr
	}()
	select {
	case <-waitCtx.Done():
		return waitCtx.Err()
	case <-started:
	}
	inFlight, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(inFlight.Runs) != 1 {
		return fmt.Errorf("GetSnapshot(in-flight) = %#v error=%v", inFlight, err)
	}
	if err := driver.SettleRunReplica(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: inFlight.Runs[0].RunID, Status: "failed",
	}); err != nil {
		return fmt.Errorf("SettleRunReplica(ambiguous) error = %w", err)
	}
	release()
	released = true
	select {
	case <-waitCtx.Done():
		return waitCtx.Err()
	case scheduleErr := <-scheduleResult:
		if scheduleErr != nil {
			return fmt.Errorf("Schedule(ambiguous terminal) error = %w", scheduleErr)
		}
	}
	submitIDs := driver.LauncherClientSubmitIDs()
	canceledSubmitIDs := driver.CancellationClientSubmitIDs()
	if len(submitIDs) != 1 || len(canceledSubmitIDs) != 1 ||
		canceledSubmitIDs[0] != submitIDs[0] {
		return fmt.Errorf(
			"ambiguous terminal cancellation identities = %#v, launches=%#v",
			canceledSubmitIDs, submitIDs,
		)
	}
	return nil
}

func runFailedLateLaunchCancellationIsDurablyRetried(
	ctx context.Context,
	driver Driver,
) error {
	return runLateLaunchCancellationRetry(ctx, driver, driver.FailNextCancellation)
}

func runUnsupportedCancellationResultIsDurablyRetried(
	ctx context.Context,
	driver Driver,
) error {
	return runLateLaunchCancellationRetry(
		ctx, driver, driver.ReturnUnknownNextCancellation,
	)
}

func runLateLaunchCancellationRetry(
	ctx context.Context,
	driver Driver,
	injectFirstAttemptFailure func(),
) error {
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	fixture := settlementFixture("durable-cancel-compensation")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	injectFirstAttemptFailure()
	started, release := driver.HoldNextLaunch()
	released := false
	defer func() {
		if !released {
			release()
		}
	}()
	scheduleResult := make(chan error, 1)
	go func() {
		_, scheduleErr := driver.Schedule(ctx, ScheduleInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			SourceSessionID:       fixture.SourceSessionID,
			CheckpointID:          before.Checkpoints[0].CheckpointID,
			ExpectedGraphRevision: before.Execution.GraphRevision,
			TaskIDs:               []string{"task-a"},
			RequestID:             "schedule-durable-cancel",
		})
		scheduleResult <- scheduleErr
	}()
	select {
	case <-waitCtx.Done():
		return waitCtx.Err()
	case <-started:
	}
	inFlight, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(inFlight.Runs) != 1 {
		return fmt.Errorf("GetSnapshot(in-flight) = %#v error=%v", inFlight, err)
	}
	if err := driver.SettleRunReplica(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: inFlight.Runs[0].RunID, Status: "failed",
	}); err != nil {
		return fmt.Errorf("SettleRunReplica(durable cancel) error = %w", err)
	}
	release()
	released = true
	select {
	case <-waitCtx.Done():
		return waitCtx.Err()
	case scheduleErr := <-scheduleResult:
		if scheduleErr != nil {
			return fmt.Errorf("Schedule(durable cancel) error = %w", scheduleErr)
		}
	}
	if driver.CancellationCallCount() != 1 {
		return fmt.Errorf(
			"initial cancellation attempts = %d, want 1",
			driver.CancellationCallCount(),
		)
	}
	recoveryFixture := settlementFixture("cancel-retry-does-not-starve-running")
	recoveryFixture.WorkspaceID = fixture.WorkspaceID
	recoveryIssueID, err := driver.AcceptPlan(ctx, recoveryFixture)
	if err != nil {
		return fmt.Errorf("prepare running reconciliation fixture: %w", err)
	}
	if err := driver.SeedActiveRun(
		ctx, recoveryFixture.WorkspaceID, recoveryIssueID, "task-a",
	); err != nil {
		return fmt.Errorf("SeedActiveRun(reconciliation fixture) error = %w", err)
	}
	driver.AdvanceClockWithoutRenewal(46 * time.Minute)
	driver.FailNextCancellation()
	if err := driver.StartupReconcileReplica(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("StartupReconcileReplica(retryable cancel) error = %w", err)
	}
	reconciled, err := driver.GetSnapshot(
		ctx, recoveryFixture.WorkspaceID, recoveryIssueID,
	)
	if err != nil || len(reconciled.Runs) != 1 ||
		reconciled.Runs[0].Status != "failed" {
		return fmt.Errorf(
			"retryable cancellation starved running reconciliation: snapshot=%#v error=%v",
			reconciled, err,
		)
	}
	if driver.CancellationCallCount() != 2 {
		return fmt.Errorf(
			"startup retryable cancellation attempts = %d (%#v), want 2",
			driver.CancellationCallCount(), driver.CancellationClientSubmitIDs(),
		)
	}
	if err := driver.PeriodicRecoverReplica(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("PeriodicRecoverReplica(cancel retry) error = %w", err)
	}
	submitIDs := driver.CancellationClientSubmitIDs()
	if len(submitIDs) != 3 ||
		submitIDs[0] != submitIDs[1] ||
		submitIDs[1] != submitIDs[2] {
		return fmt.Errorf(
			"durable cancellation retry identities = %#v, want three identical",
			submitIDs,
		)
	}
	if err := driver.PeriodicRecoverReplica(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("PeriodicRecoverReplica(cancel replay) error = %w", err)
	}
	if driver.CancellationCallCount() != 3 {
		return fmt.Errorf(
			"completed cancellation replay attempts = %d, want 3",
			driver.CancellationCallCount(),
		)
	}
	return nil
}

func runCanceledDeliveryContextStillCompensatesLateLaunch(
	ctx context.Context,
	driver Driver,
) error {
	waitCtx, cancelWait := context.WithTimeout(ctx, 5*time.Second)
	defer cancelWait()
	launchCtx, cancelLaunch := context.WithCancel(ctx)
	defer cancelLaunch()
	fixture := settlementFixture("canceled-delivery-context")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	started, release := driver.HoldNextLaunch()
	released := false
	defer func() {
		if !released {
			release()
		}
	}()
	scheduleResult := make(chan error, 1)
	go func() {
		_, scheduleErr := driver.Schedule(launchCtx, ScheduleInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			SourceSessionID:       fixture.SourceSessionID,
			CheckpointID:          before.Checkpoints[0].CheckpointID,
			ExpectedGraphRevision: before.Execution.GraphRevision,
			TaskIDs:               []string{"task-a"},
			RequestID:             "schedule-canceled-delivery-context",
		})
		scheduleResult <- scheduleErr
	}()
	select {
	case <-waitCtx.Done():
		return waitCtx.Err()
	case <-started:
	}
	inFlight, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(inFlight.Runs) != 1 {
		return fmt.Errorf("GetSnapshot(in-flight) = %#v error=%v", inFlight, err)
	}
	if err := driver.SettleRunReplica(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: inFlight.Runs[0].RunID, Status: "failed",
	}); err != nil {
		return fmt.Errorf("SettleRunReplica(canceled delivery context) error = %w", err)
	}
	cancelLaunch()
	release()
	released = true
	select {
	case <-waitCtx.Done():
		return waitCtx.Err()
	case <-scheduleResult:
	}
	if driver.CancellationCallCount() != 1 {
		return fmt.Errorf(
			"canceled-context compensation calls = %d, want 1",
			driver.CancellationCallCount(),
		)
	}
	return nil
}

func runReclaimedRunningLaunchIsNotCanceledOnAmbiguousError(
	ctx context.Context,
	driver Driver,
) error {
	return runReclaimedRunningLaunchIsNotCanceled(ctx, driver, true)
}

func runReclaimedRunningLaunchIsNotCanceledOnSuccess(
	ctx context.Context,
	driver Driver,
) error {
	return runReclaimedRunningLaunchIsNotCanceled(ctx, driver, false)
}

func runReclaimedRunningLaunchIsNotCanceled(
	ctx context.Context,
	driver Driver,
	failFirstLaunch bool,
) error {
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	fixture := settlementFixture("reclaimed-ambiguous-launch")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	if failFirstLaunch {
		driver.FailNextLaunch()
	}
	firstStarted, releaseFirst := driver.HoldNextLaunch()
	firstReleased := false
	defer func() {
		if !firstReleased {
			releaseFirst()
		}
	}()
	scheduleResult := make(chan error, 1)
	go func() {
		_, scheduleErr := driver.Schedule(ctx, ScheduleInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			SourceSessionID:       fixture.SourceSessionID,
			CheckpointID:          before.Checkpoints[0].CheckpointID,
			ExpectedGraphRevision: before.Execution.GraphRevision,
			TaskIDs:               []string{"task-a"},
			RequestID:             "schedule-reclaimed-ambiguous",
		})
		scheduleResult <- scheduleErr
	}()
	select {
	case <-waitCtx.Done():
		return waitCtx.Err()
	case <-firstStarted:
	}
	secondStarted, releaseSecond := driver.HoldNextLaunch()
	secondReleased := false
	defer func() {
		if !secondReleased {
			releaseSecond()
		}
	}()
	driver.StopLeaseRenewal()
	driver.AdvanceClockWithoutRenewal(2 * time.Minute)
	recoveryResult := make(chan error, 1)
	go func() {
		recoveryResult <- driver.PeriodicRecoverReplica(ctx, fixture.WorkspaceID)
	}()
	select {
	case <-waitCtx.Done():
		return waitCtx.Err()
	case <-secondStarted:
	}
	releaseFirst()
	firstReleased = true
	select {
	case <-waitCtx.Done():
		return waitCtx.Err()
	case scheduleErr := <-scheduleResult:
		if scheduleErr != nil {
			return fmt.Errorf("Schedule(stale ambiguous owner) error = %w", scheduleErr)
		}
	}
	if driver.CancellationCallCount() != 0 {
		return fmt.Errorf(
			"stale ambiguous owner canceled reclaimed running launch: calls=%d",
			driver.CancellationCallCount(),
		)
	}
	releaseSecond()
	secondReleased = true
	select {
	case <-waitCtx.Done():
		return waitCtx.Err()
	case recoveryErr := <-recoveryResult:
		if recoveryErr != nil {
			return fmt.Errorf("PeriodicRecoverReplica(reclaimed) error = %w", recoveryErr)
		}
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(after reclaim) error = %w", err)
	}
	if driver.CancellationCallCount() != 0 ||
		driver.LauncherCallCount() != 2 ||
		len(after.Runs) != 1 || after.Runs[0].Status != "running" {
		return fmt.Errorf(
			"reclaimed ambiguous launch state = %#v launches=%d cancellations=%d",
			after, driver.LauncherCallCount(), driver.CancellationCallCount(),
		)
	}
	return nil
}

func runTimedOutDispatchedLaunchRequestsExactCancellation(
	ctx context.Context,
	driver Driver,
) error {
	fixture := settlementFixture("timeout-dispatched-launch")
	issueID, scheduled, err := acceptAndScheduleSettlement(
		ctx, driver, fixture, []string{"task-a"},
	)
	if err != nil {
		return err
	}
	submitIDs := driver.LauncherClientSubmitIDs()
	if len(submitIDs) != 1 {
		return fmt.Errorf("launcher submit identities = %#v, want one", submitIDs)
	}
	if err := driver.TimeoutRun(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: scheduled.RunIDs[0], Status: "failed",
	}); err != nil {
		return fmt.Errorf("TimeoutRun(dispatched) error = %w", err)
	}
	canceledSubmitIDs := driver.CancellationClientSubmitIDs()
	if len(canceledSubmitIDs) != 1 || canceledSubmitIDs[0] != submitIDs[0] {
		return fmt.Errorf(
			"timeout cancellation submit identities = %#v, want %#v",
			canceledSubmitIDs, submitIDs,
		)
	}
	return nil
}

func runTimedOutInFlightLaunchCancelsAfterDelivery(
	ctx context.Context,
	driver Driver,
) error {
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	fixture := settlementFixture("timeout-in-flight-launch")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	started, release := driver.HoldNextLaunch()
	released := false
	defer func() {
		if !released {
			release()
		}
	}()
	scheduleResult := make(chan error, 1)
	go func() {
		_, scheduleErr := driver.Schedule(ctx, ScheduleInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			SourceSessionID:       fixture.SourceSessionID,
			CheckpointID:          before.Checkpoints[0].CheckpointID,
			ExpectedGraphRevision: before.Execution.GraphRevision,
			TaskIDs:               []string{"task-a"},
			RequestID:             "schedule-timeout-in-flight",
		})
		scheduleResult <- scheduleErr
	}()
	select {
	case <-waitCtx.Done():
		return waitCtx.Err()
	case <-started:
	}
	inFlight, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(inFlight.Runs) != 1 {
		return fmt.Errorf("GetSnapshot(in-flight) = %#v error=%v", inFlight, err)
	}
	if err := driver.TimeoutRun(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: inFlight.Runs[0].RunID, Status: "failed",
	}); err != nil {
		return fmt.Errorf("TimeoutRun(in-flight) error = %w", err)
	}
	if driver.CancellationCallCount() != 0 {
		return fmt.Errorf(
			"in-flight timeout canceled before launch delivery returned: calls=%d",
			driver.CancellationCallCount(),
		)
	}
	release()
	released = true
	select {
	case <-waitCtx.Done():
		return waitCtx.Err()
	case scheduleErr := <-scheduleResult:
		if scheduleErr != nil {
			return fmt.Errorf("Schedule(in-flight timeout) error = %w", scheduleErr)
		}
	}
	if driver.CancellationCallCount() != 1 {
		return fmt.Errorf(
			"in-flight timeout post-launch cancellation calls = %d, want 1",
			driver.CancellationCallCount(),
		)
	}
	return nil
}
