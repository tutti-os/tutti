package conformance

import (
	"context"
	"fmt"
	"reflect"
	"time"
)

const fixedWatchdogInterval = 5 * time.Minute

func WatchdogCatalog() []Scenario {
	return []Scenario{
		{
			Name: "WatchdogDeadlineIsExactlyFiveMinutesAfterRelevantActivity",
			run:  runWatchdogDeadlineIsExactlyFiveMinutesAfterRelevantActivity,
		},
		{
			Name: "SourceUserAndAgentActivityResetOnlyExactExecution",
			run:  runSourceUserAndAgentActivityResetOnlyExactExecution,
		},
		{
			Name: "ChildAndUnrelatedActivityDoNotResetWatchdog",
			run:  runChildAndUnrelatedActivityDoNotResetWatchdog,
		},
		{
			Name: "BusySourceOpenWakeAndReviewerSuppressDuplicateDelivery",
			run:  runBusySourceOpenWakeAndReviewerSuppressDuplicateDelivery,
		},
		{
			Name: "SourceActivityAfterClaimDefersWakeBeforeSend",
			run:  runSourceActivityAfterClaimDefersWakeBeforeSend,
		},
		{
			Name: "CanonicalActivityBeforeClaimRejectsWakeAdmission",
			run:  runCanonicalActivityBeforeClaimRejectsWakeAdmission,
		},
		{
			Name: "StaleCanonicalMarkersDoNotStrandWakeAdmission",
			run:  runStaleCanonicalMarkersDoNotStrandWakeAdmission,
		},
		{
			Name: "SourceActivityDuringSendRejectsStaleFinalization",
			run:  runSourceActivityDuringSendRejectsStaleFinalization,
		},
		{
			Name: "SettledWakeWithoutCommandCreatesNextFixedSequence",
			run:  runSettledWakeWithoutCommandCreatesNextFixedSequence,
		},
		{
			Name: "CanonicalSettledWakeRecoversAfterLostObserverProjection",
			run:  runCanonicalSettledWakeRecoversAfterLostObserverProjection,
		},
		{
			Name: "CanonicalSourceActivityRecoversAfterLostObserverProjection",
			run:  runCanonicalSourceActivityRecoversAfterLostObserverProjection,
		},
		{
			Name: "InternalWakeIdentityIsExactSourceSessionScoped",
			run:  runInternalWakeIdentityIsExactSourceSessionScoped,
		},
		{
			Name: "CanonicalUserMessageActivityRecoversAfterLostObserverProjection",
			run:  runCanonicalUserMessageActivityRecoversAfterLostObserverProjection,
		},
		{
			Name: "OverdueCanonicalMarkersDoNotStrandWakeDelivery",
			run:  runOverdueCanonicalMarkersDoNotStrandWakeDelivery,
		},
		{
			Name: "ValidCommandRetiresResolvedCheckpointWatchdog",
			run:  runValidCommandRetiresResolvedCheckpointWatchdog,
		},
		{
			Name: "StartupRecoversOnlyExpiredLeasesWithStableIdentity",
			run:  runStartupRecoversOnlyExpiredLeasesWithStableIdentity,
		},
		{
			Name: "NonRunnableExecutionSuppressesWatchdog",
			run:  runNonRunnableExecutionSuppressesWatchdog,
		},
		{
			Name: "InfrastructureRetryDoesNotBackoffProductDeadline",
			run:  runInfrastructureRetryDoesNotBackoffProductDeadline,
		},
	}
}

func runWatchdogDeadlineIsExactlyFiveMinutesAfterRelevantActivity(
	ctx context.Context,
	driver Driver,
) error {
	fixture := wakeFixture("watchdog-deadline")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	initial, wakes, err := wakeSnapshot(ctx, driver, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	if !initial.Execution.LastOrchestratorActivityAt.Equal(driver.CurrentTime()) ||
		!initial.Execution.WatchdogDueAt.Equal(driver.CurrentTime().Add(fixedWatchdogInterval)) {
		return fmt.Errorf("initial execution timing = %#v, want now and now+5m", initial.Execution)
	}
	if len(wakes) != 1 || !wakes[0].DueAt.Equal(driver.CurrentTime()) {
		return fmt.Errorf("initial wake = %#v, want immediate due distinct from watchdog", wakes)
	}

	scheduleFixture := wakeFixture("watchdog-schedule-reset")
	scheduleIssueID, err := driver.AcceptPlan(ctx, scheduleFixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan(schedule reset) error = %w", err)
	}
	beforeSchedule, err := driver.GetSnapshot(
		ctx, scheduleFixture.WorkspaceID, scheduleIssueID,
	)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before schedule) error = %w", err)
	}
	driver.AdvanceClockWithoutRenewal(2 * time.Minute)
	scheduledAt := driver.CurrentTime()
	if _, err := driver.Schedule(ctx, ScheduleInput{
		WorkspaceID:           scheduleFixture.WorkspaceID,
		IssueID:               scheduleIssueID,
		SourceSessionID:       scheduleFixture.SourceSessionID,
		CheckpointID:          beforeSchedule.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: beforeSchedule.Execution.GraphRevision,
		TaskIDs:               []string{"task-a"},
		RequestID:             "watchdog-clock-separated-schedule",
	}); err != nil {
		return fmt.Errorf("Schedule(clock separated) error = %w", err)
	}
	afterSchedule, err := driver.GetSnapshot(
		ctx, scheduleFixture.WorkspaceID, scheduleIssueID,
	)
	if err != nil {
		return fmt.Errorf("GetSnapshot(after schedule) error = %w", err)
	}
	if !afterSchedule.Execution.LastOrchestratorActivityAt.Equal(scheduledAt) ||
		!afterSchedule.Execution.WatchdogDueAt.Equal(scheduledAt.Add(fixedWatchdogInterval)) {
		return fmt.Errorf("valid schedule timing = %#v, want schedule+5m", afterSchedule.Execution)
	}

	for _, terminalStatus := range []string{"completed", "failed", "canceled"} {
		candidate := wakeFixture("watchdog-settlement-" + terminalStatus)
		candidateIssueID, scheduled, scheduleErr := acceptAndScheduleSettlement(
			ctx, driver, candidate, []string{"task-a"},
		)
		if scheduleErr != nil {
			return fmt.Errorf("%s: schedule error = %w", terminalStatus, scheduleErr)
		}
		driver.AdvanceClockWithoutRenewal(2 * time.Minute)
		settledAt := driver.CurrentTime()
		if settleErr := driver.SettleRun(ctx, SettleRunInput{
			WorkspaceID: candidate.WorkspaceID,
			IssueID:     candidateIssueID,
			TaskID:      "task-a",
			RunID:       scheduled.RunIDs[0],
			Status:      terminalStatus,
		}); settleErr != nil {
			return fmt.Errorf("%s: SettleRun() error = %w", terminalStatus, settleErr)
		}
		after, snapshotErr := driver.GetSnapshot(
			ctx, candidate.WorkspaceID, candidateIssueID,
		)
		if snapshotErr != nil {
			return fmt.Errorf("%s: GetSnapshot() error = %w", terminalStatus, snapshotErr)
		}
		if !after.Execution.LastOrchestratorActivityAt.Equal(settledAt) ||
			!after.Execution.WatchdogDueAt.Equal(settledAt.Add(fixedWatchdogInterval)) {
			return fmt.Errorf("%s: settlement timing = %#v, want settlement+5m", terminalStatus, after.Execution)
		}
	}
	return nil
}

func runSourceUserAndAgentActivityResetOnlyExactExecution(
	ctx context.Context,
	driver Driver,
) error {
	first := wakeFixture("activity-exact-first")
	second := wakeFixture("activity-exact-second")
	coSourced := wakeFixture("activity-exact-cosourced")
	first.SourceSessionID = "session-activity-exact-first"
	second.SourceSessionID = "session-activity-exact-second"
	coSourced.SourceSessionID = first.SourceSessionID
	firstIssueID, _, err := acceptAndScheduleSettlement(ctx, driver, first, []string{"task-a"})
	if err != nil {
		return err
	}
	secondIssueID, _, err := acceptAndScheduleSettlement(ctx, driver, second, []string{"task-a"})
	if err != nil {
		return err
	}
	coSourcedIssueID, _, err := acceptAndScheduleSettlement(
		ctx, driver, coSourced, []string{"task-a"},
	)
	if err != nil {
		return err
	}
	secondBefore, err := driver.GetSnapshot(ctx, second.WorkspaceID, secondIssueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(second before) error = %w", err)
	}

	for _, kind := range []string{"user_turn", "agent_turn"} {
		driver.AdvanceClockWithoutRenewal(time.Minute)
		activityAt := driver.CurrentTime()
		if err := driver.ObserveSourceSessionActivity(ctx, SourceSessionActivity{
			WorkspaceID: first.WorkspaceID,
			SessionID:   first.SourceSessionID,
			Kind:        kind,
			ActivityID:  kind + "-activity",
			OccurredAt:  activityAt,
		}); err != nil {
			return fmt.Errorf("ObserveSourceSessionActivity(%s) error = %w", kind, err)
		}
		firstAfter, err := driver.GetSnapshot(ctx, first.WorkspaceID, firstIssueID)
		if err != nil {
			return fmt.Errorf("GetSnapshot(first after %s) error = %w", kind, err)
		}
		if !firstAfter.Execution.LastOrchestratorActivityAt.Equal(activityAt) ||
			!firstAfter.Execution.WatchdogDueAt.Equal(activityAt.Add(fixedWatchdogInterval)) {
			return fmt.Errorf("%s exact-source timing = %#v", kind, firstAfter.Execution)
		}
		coSourcedAfter, err := driver.GetSnapshot(
			ctx, coSourced.WorkspaceID, coSourcedIssueID,
		)
		if err != nil {
			return fmt.Errorf("GetSnapshot(co-sourced after %s) error = %w", kind, err)
		}
		if !coSourcedAfter.Execution.LastOrchestratorActivityAt.Equal(activityAt) ||
			!coSourcedAfter.Execution.WatchdogDueAt.Equal(activityAt.Add(fixedWatchdogInterval)) {
			return fmt.Errorf("%s did not reset all co-sourced executions: %#v", kind, coSourcedAfter.Execution)
		}
		secondAfter, err := driver.GetSnapshot(ctx, second.WorkspaceID, secondIssueID)
		if err != nil {
			return fmt.Errorf("GetSnapshot(second after %s) error = %w", kind, err)
		}
		if secondAfter.Execution.LastOrchestratorActivityAt !=
			secondBefore.Execution.LastOrchestratorActivityAt ||
			secondAfter.Execution.WatchdogDueAt != secondBefore.Execution.WatchdogDueAt {
			return fmt.Errorf("%s reset unrelated execution: before=%#v after=%#v", kind, secondBefore.Execution, secondAfter.Execution)
		}
	}
	beforeReplay, err := driver.GetSnapshot(ctx, first.WorkspaceID, firstIssueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before replay) error = %w", err)
	}
	driver.AdvanceClockWithoutRenewal(4 * time.Minute)
	for _, activity := range []SourceSessionActivity{
		{
			WorkspaceID: first.WorkspaceID, SessionID: first.SourceSessionID,
			Kind: "agent_turn", ActivityID: "agent_turn-activity",
			OccurredAt: beforeReplay.Execution.LastOrchestratorActivityAt,
		},
		{
			WorkspaceID: first.WorkspaceID, SessionID: first.SourceSessionID,
			Kind: "user_turn", ActivityID: "older-user-turn",
			OccurredAt: beforeReplay.Execution.LastOrchestratorActivityAt.Add(-time.Minute),
		},
	} {
		if err := driver.ObserveSourceSessionActivity(ctx, activity); err != nil {
			return fmt.Errorf("ObserveSourceSessionActivity(replay %#v) error = %w", activity, err)
		}
	}
	afterReplay, err := driver.GetSnapshot(ctx, first.WorkspaceID, firstIssueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(after replay) error = %w", err)
	}
	if afterReplay.Execution.LastOrchestratorActivityAt !=
		beforeReplay.Execution.LastOrchestratorActivityAt ||
		afterReplay.Execution.WatchdogDueAt != beforeReplay.Execution.WatchdogDueAt {
		return fmt.Errorf(
			"same/older activity replay drifted deadline: before=%#v after=%#v",
			beforeReplay.Execution, afterReplay.Execution,
		)
	}
	newerAt := driver.CurrentTime()
	if err := driver.ObserveSourceSessionActivity(ctx, SourceSessionActivity{
		WorkspaceID: first.WorkspaceID, SessionID: first.SourceSessionID,
		Kind: "agent_turn", ActivityID: "newer-agent-turn", OccurredAt: newerAt,
	}); err != nil {
		return fmt.Errorf("ObserveSourceSessionActivity(newer) error = %w", err)
	}
	afterNewer, err := driver.GetSnapshot(ctx, first.WorkspaceID, firstIssueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(after newer) error = %w", err)
	}
	if !afterNewer.Execution.LastOrchestratorActivityAt.Equal(newerAt) ||
		!afterNewer.Execution.WatchdogDueAt.Equal(newerAt.Add(fixedWatchdogInterval)) {
		return fmt.Errorf("newer activity timing = %#v", afterNewer.Execution)
	}
	return nil
}

func runChildAndUnrelatedActivityDoNotResetWatchdog(
	ctx context.Context,
	driver Driver,
) error {
	fixture := wakeFixture("activity-ignored")
	issueID, _, err := acceptAndScheduleSettlement(ctx, driver, fixture, []string{"task-a"})
	if err != nil {
		return err
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	driver.AdvanceClockWithoutRenewal(time.Minute)
	for _, activity := range []SourceSessionActivity{
		{WorkspaceID: fixture.WorkspaceID, SessionID: fixture.SourceSessionID, Kind: "child_stream"},
		{WorkspaceID: fixture.WorkspaceID, SessionID: "session-child-delegate", Kind: "agent_turn"},
		{WorkspaceID: fixture.WorkspaceID, SessionID: "session-unrelated", Kind: "user_turn"},
		{WorkspaceID: "workspace-unrelated", SessionID: fixture.SourceSessionID, Kind: "agent_turn"},
	} {
		if err := driver.ObserveSourceSessionActivity(ctx, activity); err != nil {
			return fmt.Errorf("ObserveSourceSessionActivity(%#v) error = %w", activity, err)
		}
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(after) error = %w", err)
	}
	if after.Execution.LastOrchestratorActivityAt != before.Execution.LastOrchestratorActivityAt ||
		after.Execution.WatchdogDueAt != before.Execution.WatchdogDueAt {
		return fmt.Errorf("ignored activity reset watchdog: before=%#v after=%#v", before.Execution, after.Execution)
	}
	for _, status := range []string{"completed", "orphaned_source", "archiving", "archived"} {
		terminal := wakeFixture("activity-ignored-" + status)
		terminal.SourceSessionID = "session-activity-ignored-" + status
		terminalIssueID, err := driver.AcceptPlan(ctx, terminal)
		if err != nil {
			return fmt.Errorf("%s: AcceptPlan() error = %w", status, err)
		}
		if err := driver.SetExecutionStatus(
			ctx, terminal.WorkspaceID, terminalIssueID, status,
		); err != nil {
			return fmt.Errorf("%s: SetExecutionStatus() error = %w", status, err)
		}
		terminalBefore, err := driver.GetSnapshot(
			ctx, terminal.WorkspaceID, terminalIssueID,
		)
		if err != nil {
			return fmt.Errorf("%s: GetSnapshot(before) error = %w", status, err)
		}
		driver.AdvanceClockWithoutRenewal(time.Minute)
		if err := driver.ObserveSourceSessionActivity(ctx, SourceSessionActivity{
			WorkspaceID: terminal.WorkspaceID,
			SessionID:   terminal.SourceSessionID,
			Kind:        "user_turn",
		}); err != nil {
			return fmt.Errorf("%s: ObserveSourceSessionActivity() error = %w", status, err)
		}
		terminalAfter, err := driver.GetSnapshot(
			ctx, terminal.WorkspaceID, terminalIssueID,
		)
		if err != nil {
			return fmt.Errorf("%s: GetSnapshot(after) error = %w", status, err)
		}
		if terminalAfter.Execution.LastOrchestratorActivityAt !=
			terminalBefore.Execution.LastOrchestratorActivityAt ||
			terminalAfter.Execution.WatchdogDueAt != terminalBefore.Execution.WatchdogDueAt {
			return fmt.Errorf("%s execution accepted source activity: before=%#v after=%#v", status, terminalBefore.Execution, terminalAfter.Execution)
		}
	}
	return nil
}

func runBusySourceOpenWakeAndReviewerSuppressDuplicateDelivery(
	ctx context.Context,
	driver Driver,
) error {
	for _, suppression := range []string{"source_busy", "reviewer_active"} {
		fixture := wakeFixture("watchdog-suppressed-" + suppression)
		fixture.SourceSessionID = "session-watchdog-suppressed-" + suppression
		issueID, _, err := acceptAndScheduleSettlement(ctx, driver, fixture, []string{"task-a"})
		if err != nil {
			return fmt.Errorf("%s: schedule error = %w", suppression, err)
		}
		switch suppression {
		case "source_busy":
			driver.SetSourceBusy(fixture.WorkspaceID, fixture.SourceSessionID, true)
		case "reviewer_active":
			beforeToggle, snapshotErr := driver.GetSnapshot(
				ctx, fixture.WorkspaceID, issueID,
			)
			if snapshotErr != nil {
				return fmt.Errorf("reviewer_active: GetSnapshot(before toggle) error = %w", snapshotErr)
			}
			beforeToggleWakes, wakeErr := driver.ListWakes(
				ctx, fixture.WorkspaceID, issueID,
			)
			if wakeErr != nil {
				return fmt.Errorf("reviewer_active: ListWakes(before toggle) error = %w", wakeErr)
			}
			if err := driver.SetReviewerActive(
				ctx, fixture.WorkspaceID, issueID, true,
			); err != nil {
				return fmt.Errorf("reviewer_active: seed active review error = %w", err)
			}
			afterToggle, snapshotErr := driver.GetSnapshot(
				ctx, fixture.WorkspaceID, issueID,
			)
			afterToggleWakes, wakeErr := driver.ListWakes(
				ctx, fixture.WorkspaceID, issueID,
			)
			normalizedAfterToggle := afterToggle
			normalizedAfterToggle.Reviews = beforeToggle.Reviews
			if snapshotErr != nil || wakeErr != nil ||
				len(afterToggle.Reviews) != len(beforeToggle.Reviews)+1 ||
				!reflect.DeepEqual(normalizedAfterToggle, beforeToggle) ||
				!reflect.DeepEqual(afterToggleWakes, beforeToggleWakes) {
				return fmt.Errorf(
					"reviewer activation mutated state outside its owned review row: before=%#v/%#v after=%#v/%#v snapshotErr=%v wakeErr=%v",
					beforeToggle, beforeToggleWakes, afterToggle, afterToggleWakes,
					snapshotErr, wakeErr,
				)
			}
		}
		beforeSuppressedCalls := driver.WakeDeliveryCallCount()
		driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
		if err := driver.RunWatchdog(ctx, fixture.WorkspaceID, "watchdog-suppressed"); err != nil {
			return fmt.Errorf("%s: RunWatchdog(suppressed) error = %w", suppression, err)
		}
		wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if err != nil || len(wakes) != 2 {
			return fmt.Errorf("%s: retained wakes = %#v error=%v, want acknowledged initial + prepared watchdog", suppression, wakes, err)
		}
		retained := wakes[1]
		if retained.Status != "prepared" ||
			driver.WakeDeliveryCallCount() != beforeSuppressedCalls {
			return fmt.Errorf("%s: retained wake=%#v calls=%d", suppression, retained, driver.WakeDeliveryCallCount())
		}
		if suppression == "source_busy" {
			if err := driver.ObserveSourceSessionActivity(ctx, SourceSessionActivity{
				WorkspaceID: fixture.WorkspaceID,
				SessionID:   fixture.SourceSessionID,
				Kind:        "user_turn",
			}); err != nil {
				return fmt.Errorf("source_busy: ObserveSourceSessionActivity() error = %w", err)
			}
			resetDue := driver.CurrentTime().Add(fixedWatchdogInterval)
			afterActivity, rescheduledWakes, err := wakeSnapshot(
				ctx, driver, fixture.WorkspaceID, issueID,
			)
			if err != nil || len(rescheduledWakes) != 2 ||
				!afterActivity.Execution.WatchdogDueAt.Equal(resetDue) ||
				!rescheduledWakes[1].DueAt.Equal(resetDue) ||
				rescheduledWakes[1].WakeID != retained.WakeID {
				return fmt.Errorf(
					"source_busy: relevant activity did not debounce same operation: execution=%#v wakes=%#v error=%v",
					afterActivity.Execution, rescheduledWakes, err,
				)
			}
			retained = rescheduledWakes[1]
			driver.AdvanceClockWithoutRenewal(4 * time.Minute)
			for _, replay := range []SourceSessionActivity{
				{
					WorkspaceID: fixture.WorkspaceID, SessionID: fixture.SourceSessionID,
					Kind: "user_turn", ActivityID: "same-user-turn",
					OccurredAt: afterActivity.Execution.LastOrchestratorActivityAt,
				},
				{
					WorkspaceID: fixture.WorkspaceID, SessionID: fixture.SourceSessionID,
					Kind: "agent_turn", ActivityID: "older-agent-turn",
					OccurredAt: afterActivity.Execution.LastOrchestratorActivityAt.Add(-time.Minute),
				},
			} {
				if err := driver.ObserveSourceSessionActivity(ctx, replay); err != nil {
					return fmt.Errorf("source_busy: replay activity %#v error = %w", replay, err)
				}
			}
			afterReplay, replayedWakes, err := wakeSnapshot(
				ctx, driver, fixture.WorkspaceID, issueID,
			)
			if err != nil ||
				!reflect.DeepEqual(afterReplay.Execution, afterActivity.Execution) ||
				len(replayedWakes) != 2 ||
				!reflect.DeepEqual(replayedWakes[1], retained) {
				return fmt.Errorf(
					"source_busy: same/older replay drifted retained operation: before=%#v/%#v after=%#v/%#v error=%v",
					afterActivity.Execution, retained, afterReplay.Execution,
					replayedWakes, err,
				)
			}
			newerAt := driver.CurrentTime()
			if err := driver.ObserveSourceSessionActivity(ctx, SourceSessionActivity{
				WorkspaceID: fixture.WorkspaceID, SessionID: fixture.SourceSessionID,
				Kind: "agent_turn", ActivityID: "newer-agent-turn",
				OccurredAt: newerAt,
			}); err != nil {
				return fmt.Errorf("source_busy: newer activity error = %w", err)
			}
			afterNewer, newerWakes, err := wakeSnapshot(
				ctx, driver, fixture.WorkspaceID, issueID,
			)
			newerDue := newerAt.Add(fixedWatchdogInterval)
			if err != nil || len(newerWakes) != 2 ||
				!afterNewer.Execution.WatchdogDueAt.Equal(newerDue) ||
				!newerWakes[1].DueAt.Equal(newerDue) ||
				newerWakes[1].WakeID != retained.WakeID {
				return fmt.Errorf(
					"source_busy: newer activity did not advance retained operation: execution=%#v wakes=%#v error=%v",
					afterNewer.Execution, newerWakes, err,
				)
			}
			retained = newerWakes[1]
			driver.AdvanceClockWithoutRenewal(
				retained.DueAt.Sub(driver.CurrentTime()),
			)
			if claimed, err := driver.ClaimWake(
				ctx, fixture.WorkspaceID, retained.WakeID,
				"watchdog-activity-lease", time.Minute,
			); err != nil || !claimed {
				return fmt.Errorf("source_busy: ClaimWake()=%v error=%v", claimed, err)
			}
			leasedBefore, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
			if err != nil || len(leasedBefore) != 2 ||
				leasedBefore[1].Status != "leased" {
				return fmt.Errorf("source_busy: leased wake=%#v error=%v", leasedBefore, err)
			}
			driver.AdvanceClockWithoutRenewal(30 * time.Second)
			for _, replay := range []SourceSessionActivity{
				{
					WorkspaceID: fixture.WorkspaceID, SessionID: fixture.SourceSessionID,
					Kind: "agent_turn", ActivityID: "same-leased-turn",
					OccurredAt: newerAt,
				},
				{
					WorkspaceID: fixture.WorkspaceID, SessionID: fixture.SourceSessionID,
					Kind: "user_turn", ActivityID: "older-leased-turn",
					OccurredAt: newerAt.Add(-time.Minute),
				},
			} {
				if err := driver.ObserveSourceSessionActivity(ctx, replay); err != nil {
					return fmt.Errorf("source_busy: leased replay %#v error = %w", replay, err)
				}
			}
			leasedAfterReplay, err := driver.ListWakes(
				ctx, fixture.WorkspaceID, issueID,
			)
			if err != nil || !reflect.DeepEqual(leasedAfterReplay, leasedBefore) {
				return fmt.Errorf(
					"source_busy: same/older replay drifted leased wake: before=%#v after=%#v error=%v",
					leasedBefore, leasedAfterReplay, err,
				)
			}
			leasedNewerAt := driver.CurrentTime()
			if err := driver.ObserveSourceSessionActivity(ctx, SourceSessionActivity{
				WorkspaceID: fixture.WorkspaceID, SessionID: fixture.SourceSessionID,
				Kind: "agent_turn", ActivityID: "newer-leased-turn",
				OccurredAt: leasedNewerAt,
			}); err != nil {
				return fmt.Errorf("source_busy: newer leased activity error = %w", err)
			}
			leasedAfterNewer, err := driver.ListWakes(
				ctx, fixture.WorkspaceID, issueID,
			)
			leasedNewDue := leasedNewerAt.Add(fixedWatchdogInterval)
			if err != nil || len(leasedAfterNewer) != 2 ||
				leasedAfterNewer[1].WakeID != retained.WakeID ||
				leasedAfterNewer[1].Status != "leased" ||
				leasedAfterNewer[1].LeaseOwner != "watchdog-activity-lease" ||
				!leasedAfterNewer[1].DueAt.Equal(leasedNewDue) {
				return fmt.Errorf(
					"source_busy: newer activity did not advance leased wake: %#v error=%v",
					leasedAfterNewer, err,
				)
			}
			retained = leasedAfterNewer[1]
			driver.AdvanceClockWithoutRenewal(31 * time.Second)
		}
		switch suppression {
		case "source_busy":
			driver.SetSourceBusy(fixture.WorkspaceID, fixture.SourceSessionID, false)
		case "reviewer_active":
			if err := driver.SetReviewerActive(
				ctx, fixture.WorkspaceID, issueID, false,
			); err != nil {
				return fmt.Errorf("reviewer_active: retire active review error = %w", err)
			}
		}
		if err := driver.RunWatchdog(ctx, fixture.WorkspaceID, "watchdog-released"); err != nil {
			return fmt.Errorf("%s: RunWatchdog(released) error = %w", suppression, err)
		}
		if suppression == "source_busy" {
			beforeDue, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
			if err != nil || len(beforeDue) != 2 ||
				beforeDue[1].Status != "prepared" ||
				driver.WakeDeliveryCallCount() != beforeSuppressedCalls {
				return fmt.Errorf(
					"source_busy: reset watchdog delivered before new due: wakes=%#v calls=%d error=%v",
					beforeDue, driver.WakeDeliveryCallCount(), err,
				)
			}
			driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
			if err := driver.RunWatchdog(
				ctx, fixture.WorkspaceID, "watchdog-released-after-reset",
			); err != nil {
				return fmt.Errorf("source_busy: RunWatchdog(new due) error = %w", err)
			}
		}
		wakes, err = driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if err != nil || len(wakes) != 2 || wakes[1].Status != "dispatched" ||
			wakes[1].WakeID != retained.WakeID ||
			wakes[1].ClientSubmitID != retained.ClientSubmitID {
			return fmt.Errorf("%s: released wakes=%#v error=%v", suppression, wakes, err)
		}
		beforeCalls := driver.WakeDeliveryCallCount()
		driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
		if err := driver.RunWatchdog(ctx, fixture.WorkspaceID, "watchdog-open-wake"); err != nil {
			return fmt.Errorf("%s: RunWatchdog(open wake) error = %w", suppression, err)
		}
		afterOpen, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if err != nil || len(afterOpen) != 2 ||
			driver.WakeDeliveryCallCount() != beforeCalls {
			return fmt.Errorf("%s: open wake duplicated delivery: wakes=%#v calls=%d error=%v", suppression, afterOpen, driver.WakeDeliveryCallCount(), err)
		}
	}
	return nil
}

func runSettledWakeWithoutCommandCreatesNextFixedSequence(
	ctx context.Context,
	driver Driver,
) error {
	fixture := wakeFixture("watchdog-next-sequence")
	issueID, _, err := acceptAndScheduleSettlement(ctx, driver, fixture, []string{"task-a"})
	if err != nil {
		return err
	}
	driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
	if err := driver.RunWatchdog(ctx, fixture.WorkspaceID, "watchdog-sequence-1"); err != nil {
		return fmt.Errorf("RunWatchdog(sequence 1) error = %w", err)
	}
	for wantSequence := int64(2); wantSequence <= 3; wantSequence++ {
		wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if err != nil || len(wakes) != int(wantSequence) {
			return fmt.Errorf("sequence %d wakes=%#v error=%v", wantSequence-1, wakes, err)
		}
		previous := wakes[len(wakes)-1]
		if previous.Status != "dispatched" || previous.CanonicalTurnID == "" {
			return fmt.Errorf("sequence %d wake=%#v, want dispatched", wantSequence-1, previous)
		}
		canonicalSettledAt := driver.CurrentTime()
		driver.AdvanceClockWithoutRenewal(4 * time.Minute)
		if err := driver.SettleWakeTurnAt(
			ctx, fixture.WorkspaceID, fixture.SourceSessionID,
			previous.CanonicalTurnID, canonicalSettledAt,
		); err != nil {
			return fmt.Errorf("SettleWakeTurnAt(sequence %d) error = %w", wantSequence-1, err)
		}
		settled, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if err != nil {
			return fmt.Errorf("GetSnapshot(settled %d) error = %w", wantSequence-1, err)
		}
		canonicalDue := canonicalSettledAt.Add(fixedWatchdogInterval)
		if !settled.Execution.LastOrchestratorActivityAt.Equal(canonicalSettledAt) ||
			!settled.Execution.WatchdogDueAt.Equal(canonicalDue) {
			return fmt.Errorf(
				"sequence %d canonical settlement drifted: activity=%s due=%s want activity=%s due=%s",
				wantSequence-1,
				settled.Execution.LastOrchestratorActivityAt,
				settled.Execution.WatchdogDueAt,
				canonicalSettledAt,
				canonicalDue,
			)
		}
		driver.AdvanceClockWithoutRenewal(canonicalDue.Sub(driver.CurrentTime()) - time.Second)
		beforeCalls := driver.WakeDeliveryCallCount()
		if err := driver.RunWatchdog(ctx, fixture.WorkspaceID, "watchdog-before-due"); err != nil {
			return fmt.Errorf("RunWatchdog(before sequence %d) error = %w", wantSequence, err)
		}
		if driver.WakeDeliveryCallCount() != beforeCalls {
			return fmt.Errorf("sequence %d delivered before fixed deadline", wantSequence)
		}
		driver.AdvanceClockWithoutRenewal(time.Second)
		if err := driver.RunWatchdog(ctx, fixture.WorkspaceID, fmt.Sprintf("watchdog-sequence-%d", wantSequence)); err != nil {
			return fmt.Errorf("RunWatchdog(sequence %d) error = %w", wantSequence, err)
		}
		after, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if err != nil || len(after) != int(wantSequence+1) {
			return fmt.Errorf("sequence %d wakes=%#v error=%v", wantSequence, after, err)
		}
		next := after[len(after)-1]
		wantWakeID := previous.CheckpointID + fmt.Sprintf(":wake:main:%d", wantSequence)
		wantClientSubmitID := "tutti-execution-wake:" + wantWakeID
		if next.CheckpointID != previous.CheckpointID ||
			next.WakeSequence != wantSequence ||
			next.WakeID != wantWakeID ||
			next.ClientSubmitID != wantClientSubmitID ||
			next.Status != "dispatched" {
			return fmt.Errorf("sequence %d wake=%#v previous=%#v", wantSequence, next, previous)
		}
	}
	return nil
}

func runValidCommandRetiresResolvedCheckpointWatchdog(
	ctx context.Context,
	driver Driver,
) error {
	fixture := wakeFixture("watchdog-acknowledge")
	issueID, _, err := acceptAndScheduleSettlement(ctx, driver, fixture, []string{"task-a"})
	if err != nil {
		return err
	}
	driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
	if err := driver.RunWatchdog(ctx, fixture.WorkspaceID, "watchdog-ack"); err != nil {
		return fmt.Errorf("RunWatchdog() error = %w", err)
	}
	before, wakes, err := wakeSnapshot(ctx, driver, fixture.WorkspaceID, issueID)
	if err != nil || len(wakes) != 2 {
		return fmt.Errorf("wakeSnapshot(before acknowledge) wakes=%#v error=%v", wakes, err)
	}
	active := before.Checkpoints[len(before.Checkpoints)-1]
	resolvedWake := wakes[len(wakes)-1]
	if active.Kind != "watchdog" || active.Status != "active" ||
		resolvedWake.CheckpointID != active.CheckpointID {
		return fmt.Errorf("active watchdog pair=%#v/%#v", active, resolvedWake)
	}
	if _, err := driver.Acknowledge(ctx, AcknowledgeInput{
		WorkspaceID:           fixture.WorkspaceID,
		IssueID:               issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          active.CheckpointID,
		ExpectedGraphRevision: before.Execution.GraphRevision,
		RequestID:             "ack-watchdog",
	}); err != nil {
		return fmt.Errorf("Acknowledge() error = %w", err)
	}
	acknowledgedAt := driver.CurrentTime()
	afterAck, wakes, err := wakeSnapshot(ctx, driver, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	if wakes[len(wakes)-1].Status != "acknowledged" ||
		!afterAck.Execution.WatchdogDueAt.Equal(acknowledgedAt.Add(fixedWatchdogInterval)) {
		return fmt.Errorf("acknowledged watchdog state=%#v wakes=%#v", afterAck.Execution, wakes)
	}
	driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
	if err := driver.RunWatchdog(ctx, fixture.WorkspaceID, "watchdog-after-ack"); err != nil {
		return fmt.Errorf("RunWatchdog(after acknowledge) error = %w", err)
	}
	finalSnapshot, finalWakes, err := wakeSnapshot(ctx, driver, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	for _, wake := range finalWakes {
		if wake.CheckpointID == active.CheckpointID && wake.WakeSequence > resolvedWake.WakeSequence {
			return fmt.Errorf("resolved checkpoint gained future watchdog wake: %#v", finalWakes)
		}
	}
	if len(finalSnapshot.Checkpoints) != len(before.Checkpoints)+1 ||
		finalSnapshot.Checkpoints[len(finalSnapshot.Checkpoints)-1].Kind != "watchdog" ||
		finalSnapshot.Checkpoints[len(finalSnapshot.Checkpoints)-1].CheckpointID == active.CheckpointID {
		return fmt.Errorf("post-ack watchdog did not use a new checkpoint: %#v", finalSnapshot.Checkpoints)
	}
	newCheckpoint := finalSnapshot.Checkpoints[len(finalSnapshot.Checkpoints)-1]
	newCheckpointWakes := make([]Wake, 0, 1)
	for _, wake := range finalWakes {
		if wake.CheckpointID == newCheckpoint.CheckpointID {
			newCheckpointWakes = append(newCheckpointWakes, wake)
		}
	}
	wantWakeID := newCheckpoint.CheckpointID + ":wake:main:1"
	if newCheckpoint.Status != "active" ||
		len(newCheckpointWakes) != 1 ||
		newCheckpointWakes[0].WakeSequence != 1 ||
		newCheckpointWakes[0].WakeID != wantWakeID ||
		newCheckpointWakes[0].ClientSubmitID != "tutti-execution-wake:"+wantWakeID ||
		newCheckpointWakes[0].Status != "dispatched" {
		return fmt.Errorf(
			"new watchdog pair=%#v/%#v, want one deterministic dispatched seq1",
			newCheckpoint, newCheckpointWakes,
		)
	}
	return nil
}
