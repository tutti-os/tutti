package conformance

import (
	"context"
	"fmt"
	"reflect"
	"time"
)

func WakeCatalog() []Scenario {
	return []Scenario{
		{
			Name: "ActiveCheckpointAtomicallyPreparesDeterministicMainWake",
			run:  runActiveCheckpointAtomicallyPreparesDeterministicMainWake,
		},
		{
			Name: "TerminalReplayAndRepairDoNotDuplicateMainWake",
			run:  runTerminalReplayAndRepairDoNotDuplicateMainWake,
		},
		{
			Name: "MissingSettlementCheckpointRepairPreparesImmediateWake",
			run:  runMissingSettlementCheckpointRepairPreparesImmediateWake,
		},
		{
			Name: "BusySourcePreservesPreparedMainWake",
			run:  runBusySourcePreservesPreparedMainWake,
		},
		{
			Name: "ExpiredWakeLeaseRecoversWithOwnerFence",
			run:  runExpiredWakeLeaseRecoversWithOwnerFence,
		},
		{
			Name: "WakeDeliveryFailuresRetainOneCanonicalIdentity",
			run:  runWakeDeliveryFailuresRetainOneCanonicalIdentity,
		},
		{
			Name: "SettledWakeTurnDoesNotResolveCheckpoint",
			run:  runSettledWakeTurnDoesNotResolveCheckpoint,
		},
		{
			Name: "CheckpointCommandAcknowledgesWakeAndPromotesNext",
			run:  runCheckpointCommandAcknowledgesWakeAndPromotesNext,
		},
		{
			Name: "StartupSuppressesNonRunnableExecutionWakes",
			run:  runStartupSuppressesNonRunnableExecutionWakes,
		},
		{
			Name: "WakeDispatchRevalidatesSourceAndPromptEvidence",
			run:  runWakeDispatchRevalidatesSourceAndPromptEvidence,
		},
		{
			Name: "BoundedWakeDeliveryDoesNotStarveLaterExecution",
			run:  runBoundedWakeDeliveryDoesNotStarveLaterExecution,
		},
		{
			Name: "CanceledCallerStillCompletesBoundedWakeCleanup",
			run:  runCanceledCallerStillCompletesBoundedWakeCleanup,
		},
		{
			Name: "ExpiredWakeOwnerCannotSendOrFinalize",
			run:  runExpiredWakeOwnerCannotSendOrFinalize,
		},
		{
			Name: "WakeRecoveryIsolatesPerWakeFailures",
			run:  runWakeRecoveryIsolatesPerWakeFailures,
		},
		{
			Name: "CorruptedWakeIdentityFailsClosedPerField",
			run:  runCorruptedWakeIdentityFailsClosedPerField,
		},
		{
			Name: "MainWakeRecoveryPreservesPreparedReviewerWake",
			run:  runMainWakeRecoveryPreservesPreparedReviewerWake,
		},
	}
}

func runActiveCheckpointAtomicallyPreparesDeterministicMainWake(
	ctx context.Context,
	driver Driver,
) error {
	fixture := wakeFixture("initial")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	snapshot, wakes, err := wakeSnapshot(ctx, driver, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	if len(snapshot.Checkpoints) != 1 || snapshot.Checkpoints[0].Status != "active" {
		return fmt.Errorf("initial checkpoints = %#v, want one active head", snapshot.Checkpoints)
	}
	if len(wakes) != 1 {
		return fmt.Errorf("initial wakes = %#v, want one atomically prepared wake", wakes)
	}
	checkpoint := snapshot.Checkpoints[0]
	wake := wakes[0]
	wantWakeID := checkpoint.CheckpointID + ":wake:main:1"
	wantSubmitID := "tutti-execution-wake:" + wantWakeID
	if wake.WakeID != wantWakeID || wake.ExecutionID == "" ||
		wake.CheckpointID != checkpoint.CheckpointID ||
		wake.TargetKind != "main" || wake.WakeSequence != 1 ||
		wake.ClientSubmitID != wantSubmitID ||
		wake.TargetSessionID != fixture.SourceSessionID ||
		wake.Status != "prepared" || !wake.DueAt.Equal(driver.CurrentTime()) {
		return fmt.Errorf("initial wake = %#v, want deterministic prepared main wake", wake)
	}
	if driver.WakeDeliveryCallCount() != 0 {
		return fmt.Errorf("materialization sent wake before worker claim")
	}
	return nil
}

func runMissingSettlementCheckpointRepairPreparesImmediateWake(
	ctx context.Context,
	driver Driver,
) error {
	fixture := wakeFixture("repair")
	issueID, scheduled, err := acceptAndScheduleSettlement(
		ctx, driver, fixture, []string{"task-a", "task-c"},
	)
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
	before, wakesBefore, err := wakeSnapshot(
		ctx, driver, fixture.WorkspaceID, issueID,
	)
	if err != nil {
		return err
	}
	if len(before.Checkpoints) != 1 || len(wakesBefore) != 1 {
		return fmt.Errorf(
			"crash-window state checkpoints=%#v wakes=%#v, want only resolved initial pair",
			before.Checkpoints, wakesBefore,
		)
	}
	if err := driver.RepairSettlements(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("RepairSettlements() error = %w", err)
	}
	repaired, wakesAfter, err := wakeSnapshot(
		ctx, driver, fixture.WorkspaceID, issueID,
	)
	if err != nil {
		return err
	}
	if len(repaired.Checkpoints) != 2 || len(wakesAfter) != 2 {
		return fmt.Errorf(
			"repaired state checkpoints=%#v wakes=%#v, want one settlement pair",
			repaired.Checkpoints, wakesAfter,
		)
	}
	checkpoint := repaired.Checkpoints[1]
	wake := wakesAfter[1]
	if checkpoint.Status != "active" || checkpoint.SubjectRunID != input.RunID ||
		wake.CheckpointID != checkpoint.CheckpointID ||
		wake.Status != "prepared" || !wake.DueAt.Equal(driver.CurrentTime()) {
		return fmt.Errorf("repaired checkpoint/wake = %#v / %#v", checkpoint, wake)
	}
	if err := driver.RepairSettlements(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("RepairSettlements(replay) error = %w", err)
	}
	replayed, replayedWakes, err := wakeSnapshot(
		ctx, driver, fixture.WorkspaceID, issueID,
	)
	if err != nil || !reflect.DeepEqual(replayed, repaired) ||
		!reflect.DeepEqual(replayedWakes, wakesAfter) {
		return fmt.Errorf(
			"repair replay mutated state checkpoints=%#v wakes=%#v error=%v",
			replayed.Checkpoints, replayedWakes, err,
		)
	}
	return nil
}

func runTerminalReplayAndRepairDoNotDuplicateMainWake(
	ctx context.Context,
	driver Driver,
) error {
	fixture := wakeFixture("terminal-replay")
	issueID, scheduled, err := acceptAndScheduleSettlement(
		ctx, driver, fixture, []string{"task-a", "task-c"},
	)
	if err != nil {
		return err
	}
	input := SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: scheduled.RunIDs[0], Status: "completed",
	}
	if err := driver.SettleRun(ctx, input); err != nil {
		return fmt.Errorf("SettleRun() error = %w", err)
	}
	before, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("ListWakes(before replay) error = %w", err)
	}
	if err := driver.SettleRun(ctx, input); err != nil {
		return fmt.Errorf("SettleRun(replay) error = %w", err)
	}
	if err := driver.RepairSettlements(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("RepairSettlements() error = %w", err)
	}
	after, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("ListWakes(after replay) error = %w", err)
	}
	if len(before) != 2 || !reflect.DeepEqual(after, before) {
		return fmt.Errorf("terminal replay wakes before=%#v after=%#v, want initial + settlement exactly once", before, after)
	}
	return nil
}

func runBusySourcePreservesPreparedMainWake(ctx context.Context, driver Driver) error {
	fixture := wakeFixture("busy")
	busyIssueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan(busy) error = %w", err)
	}
	idleFixture := wakeFixture("idle-alongside-busy")
	idleFixture.SourceSessionID = "session-source-idle"
	idleIssueID, err := driver.AcceptPlan(ctx, idleFixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan(idle) error = %w", err)
	}
	driver.SetSourceBusy(fixture.WorkspaceID, fixture.SourceSessionID, true)
	if err := driver.RecoverWakes(ctx, fixture.WorkspaceID, "wake-worker-busy"); err != nil {
		return fmt.Errorf("RecoverWakes(busy) error = %w", err)
	}
	busyWakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, busyIssueID)
	if err != nil || len(busyWakes) != 1 {
		return fmt.Errorf("ListWakes(busy) = %#v error=%v", busyWakes, err)
	}
	idleWakes, err := driver.ListWakes(ctx, idleFixture.WorkspaceID, idleIssueID)
	if err != nil || len(idleWakes) != 1 {
		return fmt.Errorf("ListWakes(idle) = %#v error=%v", idleWakes, err)
	}
	if busyWakes[0].Status != "prepared" || busyWakes[0].LeaseOwner != "" ||
		idleWakes[0].Status != "dispatched" ||
		driver.WakeDeliveryCallCount() != 1 {
		return fmt.Errorf(
			"session-scoped busy result: busy=%#v idle=%#v calls=%d",
			busyWakes[0], idleWakes[0], driver.WakeDeliveryCallCount(),
		)
	}
	if deliveries := driver.WakeDeliveries(); len(deliveries) != 1 ||
		deliveries[0].TargetSessionID != idleFixture.SourceSessionID {
		return fmt.Errorf("busy recovery delivered wrong target: %#v", deliveries)
	}
	driver.SetSourceBusy(fixture.WorkspaceID, fixture.SourceSessionID, false)
	if err := driver.RecoverWakes(ctx, fixture.WorkspaceID, "wake-worker-idle"); err != nil {
		return fmt.Errorf("RecoverWakes(idle) error = %w", err)
	}
	busyWakes, err = driver.ListWakes(ctx, fixture.WorkspaceID, busyIssueID)
	if err != nil || len(busyWakes) != 1 || busyWakes[0].Status != "dispatched" ||
		driver.WakeDeliveryCallCount() != 2 {
		return fmt.Errorf(
			"idle recovery wakes=%#v calls=%d error=%v",
			busyWakes, driver.WakeDeliveryCallCount(), err,
		)
	}
	return nil
}

func runExpiredWakeLeaseRecoversWithOwnerFence(ctx context.Context, driver Driver) error {
	fixture := wakeFixture("lease")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(wakes) != 1 {
		return fmt.Errorf("ListWakes() = %#v error=%v", wakes, err)
	}
	claimed, err := driver.ClaimWake(
		ctx, fixture.WorkspaceID, wakes[0].WakeID, "wake-owner-a", time.Minute,
	)
	if err != nil || !claimed {
		return fmt.Errorf("ClaimWake(owner-a) = %v error=%v", claimed, err)
	}
	if err := driver.DispatchClaimedWake(
		ctx, fixture.WorkspaceID, wakes[0].WakeID, "wake-owner-b",
	); err == nil {
		return fmt.Errorf("DispatchClaimedWake(stale owner) error=nil, want fence rejection")
	}
	if driver.WakeDeliveryCallCount() != 0 {
		return fmt.Errorf("stale owner reached SendInput")
	}
	if err := driver.StartupRecoverWakes(
		ctx, fixture.WorkspaceID, "wake-owner-b",
	); err != nil {
		return fmt.Errorf("StartupRecoverWakes(before expiry) error = %w", err)
	}
	wakes, err = driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(wakes) != 1 || wakes[0].Status != "leased" ||
		wakes[0].LeaseOwner != "wake-owner-a" ||
		driver.WakeDeliveryCallCount() != 0 {
		return fmt.Errorf("fresh startup stole live lease: wakes=%#v error=%v", wakes, err)
	}
	driver.AdvanceClockWithoutRenewal(2 * time.Minute)
	if err := driver.StartupRecoverWakes(
		ctx, fixture.WorkspaceID, "wake-owner-b",
	); err != nil {
		return fmt.Errorf("StartupRecoverWakes() error = %w", err)
	}
	wakes, err = driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(wakes) != 1 || wakes[0].Status != "dispatched" ||
		wakes[0].LeaseOwner != "" || driver.WakeDeliveryCallCount() != 1 {
		return fmt.Errorf("expired lease recovery wakes=%#v calls=%d error=%v", wakes, driver.WakeDeliveryCallCount(), err)
	}
	if err := driver.DispatchClaimedWake(
		ctx, fixture.WorkspaceID, wakes[0].WakeID, "wake-owner-a",
	); err == nil {
		return fmt.Errorf("expired stale owner finalized reclaimed wake")
	}
	if driver.WakeDeliveryCallCount() != 1 {
		return fmt.Errorf("stale finalization duplicated SendInput")
	}
	return nil
}

func runWakeDeliveryFailuresRetainOneCanonicalIdentity(
	ctx context.Context,
	driver Driver,
) error {
	testCases := []struct {
		name           string
		inject         func()
		firstCanonical int
		wantFirstState string
		wantCalls      int
	}{
		{
			name: "definite-before-canonical", inject: driver.FailNextWakeBeforeCanonical,
			firstCanonical: 0, wantFirstState: "prepared", wantCalls: 2,
		},
		{
			name: "ambiguous-before-canonical", inject: driver.FailNextWakeAmbiguouslyBeforeCanonical,
			firstCanonical: 0, wantFirstState: "prepared", wantCalls: 2,
		},
		{
			name: "response-loss-recovered", inject: driver.FailNextWakeAfterCanonical,
			firstCanonical: 1, wantFirstState: "dispatched", wantCalls: 1,
		},
		{
			name: "lookup-unavailable", inject: func() {
				driver.FailNextWakeAfterCanonical()
				driver.FailNextWakeCanonicalLookup()
			},
			firstCanonical: 1, wantFirstState: "prepared", wantCalls: 2,
		},
	}
	for _, testCase := range testCases {
		fixture := wakeFixture("delivery-" + testCase.name)
		issueID, err := driver.AcceptPlan(ctx, fixture)
		if err != nil {
			return fmt.Errorf("%s: AcceptPlan() error = %w", testCase.name, err)
		}
		beforeCalls := driver.WakeDeliveryCallCount()
		beforeCanonical := driver.WakeDeliveryCanonicalTurnCount()
		testCase.inject()
		firstErr := driver.RecoverWakes(
			ctx, fixture.WorkspaceID, "wake-"+testCase.name+"-first",
		)
		if testCase.wantFirstState == "prepared" && firstErr == nil {
			return fmt.Errorf("%s: RecoverWakes(first) error=nil, want pending retry signal", testCase.name)
		}
		if testCase.wantFirstState != "prepared" && firstErr != nil {
			return fmt.Errorf("%s: RecoverWakes(first) error = %w", testCase.name, firstErr)
		}
		first, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if err != nil || len(first) != 1 {
			return fmt.Errorf("%s: ListWakes(first)=%#v error=%v", testCase.name, first, err)
		}
		if first[0].Status != testCase.wantFirstState ||
			driver.WakeDeliveryCanonicalTurnCount()-beforeCanonical != testCase.firstCanonical {
			return fmt.Errorf(
				"%s: first recovery wake=%#v canonical delta=%d",
				testCase.name, first[0],
				driver.WakeDeliveryCanonicalTurnCount()-beforeCanonical,
			)
		}
		if first[0].Status == "prepared" {
			if err := driver.RecoverWakes(
				ctx, fixture.WorkspaceID, "wake-"+testCase.name+"-retry",
			); err != nil {
				return fmt.Errorf("%s: RecoverWakes(retry) error = %w", testCase.name, err)
			}
		}
		final, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if err != nil || len(final) != 1 || final[0].Status != "dispatched" ||
			final[0].CanonicalTurnID == "" ||
			final[0].CanonicalSessionID != fixture.SourceSessionID {
			return fmt.Errorf("%s: final wake=%#v error=%v", testCase.name, final, err)
		}
		deliveries := driver.WakeDeliveryClientSubmitIDs()[beforeCalls:]
		if got := driver.WakeDeliveryCallCount() - beforeCalls; got != testCase.wantCalls {
			return fmt.Errorf("%s: SendInput calls=%d, want %d", testCase.name, got, testCase.wantCalls)
		}
		wantIDs := make([]string, testCase.wantCalls)
		for index := range wantIDs {
			wantIDs[index] = final[0].ClientSubmitID
		}
		if !reflect.DeepEqual(deliveries, wantIDs) {
			return fmt.Errorf("%s: SendInput identities=%#v want=%#v", testCase.name, deliveries, wantIDs)
		}
		if got := driver.WakeDeliveryCanonicalTurnCount() - beforeCanonical; got != 1 {
			return fmt.Errorf("%s: canonical Turn delta=%d, want 1", testCase.name, got)
		}
	}
	return nil
}

func runSettledWakeTurnDoesNotResolveCheckpoint(ctx context.Context, driver Driver) error {
	fixture := wakeFixture("turn-settled")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	if err := driver.RecoverWakes(ctx, fixture.WorkspaceID, "wake-turn-settled"); err != nil {
		return fmt.Errorf("RecoverWakes() error = %w", err)
	}
	before, wakes, err := wakeSnapshot(ctx, driver, fixture.WorkspaceID, issueID)
	if err != nil || len(wakes) != 1 || wakes[0].CanonicalTurnID == "" {
		return fmt.Errorf("dispatched wake = %#v error=%v", wakes, err)
	}
	for _, unrelated := range []struct {
		sessionID string
		turnID    string
	}{
		{sessionID: "session-unrelated", turnID: wakes[0].CanonicalTurnID},
		{sessionID: fixture.SourceSessionID, turnID: "turn-unrelated"},
	} {
		if err := driver.SettleWakeTurn(
			ctx, fixture.WorkspaceID, unrelated.sessionID, unrelated.turnID,
		); err != nil {
			return fmt.Errorf("SettleWakeTurn(unrelated=%#v) error = %w", unrelated, err)
		}
		unrelatedSnapshot, unrelatedWakes, snapshotErr := wakeSnapshot(
			ctx, driver, fixture.WorkspaceID, issueID,
		)
		if snapshotErr != nil ||
			!reflect.DeepEqual(unrelatedSnapshot, before) ||
			!reflect.DeepEqual(unrelatedWakes, wakes) {
			return fmt.Errorf(
				"unrelated Turn settlement mutated orchestration: snapshot=%#v wakes=%#v error=%v",
				unrelatedSnapshot, unrelatedWakes, snapshotErr,
			)
		}
	}
	if err := driver.SettleWakeTurn(
		ctx, fixture.WorkspaceID, fixture.SourceSessionID, wakes[0].CanonicalTurnID,
	); err != nil {
		return fmt.Errorf("SettleWakeTurn() error = %w", err)
	}
	after, settled, err := wakeSnapshot(ctx, driver, fixture.WorkspaceID, issueID)
	if err != nil || len(settled) != 1 {
		return fmt.Errorf("settled wake snapshot = %#v error=%v", settled, err)
	}
	if settled[0].Status != "turn_settled" ||
		after.Checkpoints[0].Status != "active" ||
		after.Execution.Status != before.Execution.Status {
		return fmt.Errorf("settled Turn resolved orchestration: snapshot=%#v wake=%#v", after, settled[0])
	}
	if err := driver.StartupRecoverWakes(
		ctx, fixture.WorkspaceID, "wake-turn-settled-restart",
	); err != nil {
		return fmt.Errorf("StartupRecoverWakes() error = %w", err)
	}
	if driver.WakeDeliveryCallCount() != 1 {
		return fmt.Errorf("Task 4 restart created later wake sequence: calls=%d", driver.WakeDeliveryCallCount())
	}
	return nil
}

func runCheckpointCommandAcknowledgesWakeAndPromotesNext(
	ctx context.Context,
	driver Driver,
) error {
	fixture := wakeFixture("command")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	initial, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(initial) error = %w", err)
	}
	initialWakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(initialWakes) != 1 {
		return fmt.Errorf("ListWakes(initial) = %#v error=%v", initialWakes, err)
	}
	scheduleInput := ScheduleInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          initial.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: initial.Execution.GraphRevision,
		TaskIDs:               []string{"task-a", "task-c"}, RequestID: "wake-command-schedule",
	}
	for _, invalid := range []ScheduleInput{
		func() ScheduleInput {
			value := scheduleInput
			value.SourceSessionID = "session-wrong"
			value.RequestID = "wake-command-wrong-caller"
			return value
		}(),
		func() ScheduleInput {
			value := scheduleInput
			value.CheckpointID = "checkpoint-stale"
			value.RequestID = "wake-command-stale-checkpoint"
			return value
		}(),
		func() ScheduleInput {
			value := scheduleInput
			value.ExpectedGraphRevision++
			value.RequestID = "wake-command-stale-revision"
			return value
		}(),
	} {
		if _, scheduleErr := driver.Schedule(ctx, invalid); scheduleErr == nil {
			return fmt.Errorf("invalid Schedule(%#v) error=nil", invalid)
		}
		afterReject, listErr := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if listErr != nil || !reflect.DeepEqual(afterReject, initialWakes) {
			return fmt.Errorf(
				"rejected Schedule mutated wakes: before=%#v after=%#v error=%v",
				initialWakes, afterReject, listErr,
			)
		}
	}
	scheduled, err := driver.Schedule(ctx, scheduleInput)
	if err != nil {
		return fmt.Errorf("Schedule() error = %w", err)
	}
	wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(wakes) != 1 || wakes[0].Status != "acknowledged" {
		return fmt.Errorf("schedule did not acknowledge initial wake: %#v error=%v", wakes, err)
	}
	afterSchedule := append([]Wake(nil), wakes...)
	replay, err := driver.Schedule(ctx, scheduleInput)
	if err != nil || !replay.Replayed {
		return fmt.Errorf("Schedule(replay) result=%#v error=%v", replay, err)
	}
	wakes, err = driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || !reflect.DeepEqual(wakes, afterSchedule) {
		return fmt.Errorf("Schedule(replay) mutated wakes=%#v error=%v", wakes, err)
	}
	conflict := scheduleInput
	conflict.TaskIDs = []string{"task-b"}
	if _, err := driver.Schedule(ctx, conflict); err == nil {
		return fmt.Errorf("Schedule(conflicting request) error=nil")
	}
	wakes, err = driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || !reflect.DeepEqual(wakes, afterSchedule) {
		return fmt.Errorf("Schedule(conflict) mutated wakes=%#v error=%v", wakes, err)
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
	if err != nil || len(backlog.Checkpoints) < 3 {
		return fmt.Errorf("GetSnapshot(backlog) = %#v error=%v", backlog, err)
	}
	wakes, err = driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(wakes) != 2 {
		return fmt.Errorf("active-only wake preparation = %#v error=%v", wakes, err)
	}
	if wakes[1].CheckpointID != backlog.Checkpoints[1].CheckpointID ||
		wakes[1].Status != "prepared" {
		return fmt.Errorf("first settlement wake = %#v backlog=%#v", wakes[1], backlog.Checkpoints)
	}
	beforeAcknowledge := append([]Wake(nil), wakes...)
	acknowledgeInput := AcknowledgeInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          backlog.Checkpoints[1].CheckpointID,
		ExpectedGraphRevision: backlog.Execution.GraphRevision,
		RequestID:             "wake-command-acknowledge",
	}
	for _, invalid := range []AcknowledgeInput{
		func() AcknowledgeInput {
			value := acknowledgeInput
			value.SourceSessionID = "session-wrong"
			value.RequestID = "wake-ack-wrong-caller"
			return value
		}(),
		func() AcknowledgeInput {
			value := acknowledgeInput
			value.CheckpointID = "checkpoint-stale"
			value.RequestID = "wake-ack-stale-checkpoint"
			return value
		}(),
		func() AcknowledgeInput {
			value := acknowledgeInput
			value.ExpectedGraphRevision++
			value.RequestID = "wake-ack-stale-revision"
			return value
		}(),
	} {
		if _, acknowledgeErr := driver.Acknowledge(ctx, invalid); acknowledgeErr == nil {
			return fmt.Errorf("invalid Acknowledge(%#v) error=nil", invalid)
		}
		afterReject, listErr := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if listErr != nil || !reflect.DeepEqual(afterReject, beforeAcknowledge) {
			return fmt.Errorf(
				"rejected Acknowledge mutated wakes: before=%#v after=%#v error=%v",
				beforeAcknowledge, afterReject, listErr,
			)
		}
	}
	acknowledged, err := driver.Acknowledge(ctx, acknowledgeInput)
	if err != nil {
		return fmt.Errorf("Acknowledge() error = %w", err)
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(after acknowledge) error = %w", err)
	}
	wakes, err = driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(wakes) != 3 {
		return fmt.Errorf("promoted wake list = %#v error=%v", wakes, err)
	}
	if wakes[1].Status != "acknowledged" ||
		wakes[2].CheckpointID != after.Checkpoints[2].CheckpointID ||
		wakes[2].WakeSequence != 1 || wakes[2].Status != "prepared" ||
		wakes[2].WakeID != after.Checkpoints[2].CheckpointID+":wake:main:1" {
		return fmt.Errorf("acknowledge/promote was not atomic: checkpoints=%#v wakes=%#v", after.Checkpoints, wakes)
	}
	afterAcknowledge := append([]Wake(nil), wakes...)
	replayedAcknowledge, err := driver.Acknowledge(ctx, acknowledgeInput)
	if err != nil || !replayedAcknowledge.Replayed {
		return fmt.Errorf("Acknowledge(replay) result=%#v error=%v", replayedAcknowledge, err)
	}
	wakes, err = driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || !reflect.DeepEqual(wakes, afterAcknowledge) {
		return fmt.Errorf("Acknowledge(replay) mutated wakes=%#v error=%v", wakes, err)
	}
	conflictingAcknowledge := acknowledgeInput
	conflictingAcknowledge.CheckpointID = acknowledged.NextCheckpointID
	if _, err := driver.Acknowledge(ctx, conflictingAcknowledge); err == nil {
		return fmt.Errorf("Acknowledge(conflicting request) error=nil")
	}
	wakes, err = driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || !reflect.DeepEqual(wakes, afterAcknowledge) {
		return fmt.Errorf("Acknowledge(conflict) mutated wakes=%#v error=%v", wakes, err)
	}
	return nil
}
