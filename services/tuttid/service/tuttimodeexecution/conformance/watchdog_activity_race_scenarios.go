package conformance

import (
	"context"
	"fmt"
	"time"
)

func runStaleCanonicalMarkersDoNotStrandWakeAdmission(
	ctx context.Context,
	driver Driver,
) error {
	for _, window := range []string{"before_claim", "during_send"} {
		for _, age := range []string{"same", "older"} {
			name := window + "-" + age
			fixture := wakeFixture("watchdog-stale-marker-" + name)
			fixture.SourceSessionID = "session-watchdog-stale-marker-" + name
			issueID, _, err := acceptAndScheduleSettlement(
				ctx, driver, fixture, []string{"task-a"},
			)
			if err != nil {
				return fmt.Errorf("%s: schedule error = %w", name, err)
			}
			before, err := driver.GetSnapshot(
				ctx, fixture.WorkspaceID, issueID,
			)
			if err != nil {
				return err
			}
			driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
			occurredAt := before.Execution.LastOrchestratorActivityAt
			if age == "older" {
				occurredAt = occurredAt.Add(-time.Minute)
			}
			activity := SourceSessionActivity{
				WorkspaceID: fixture.WorkspaceID,
				SessionID:   fixture.SourceSessionID,
				Kind:        "agent_turn",
				ActivityID:  "stale-marker-" + name,
				OccurredAt:  occurredAt,
			}
			switch window {
			case "before_claim":
				driver.CommitCanonicalSourceActivityBeforeNextWakeClaim(
					ctx, activity, "",
				)
			case "during_send":
				driver.CommitCanonicalSourceActivityDuringNextWakeSend(
					ctx, activity, "",
				)
			}
			beforeCalls := driver.WakeDeliveryCallCount()
			if err := driver.RunWatchdog(
				ctx, fixture.WorkspaceID, "watchdog-stale-marker-"+name,
			); err != nil {
				return fmt.Errorf("%s: RunWatchdog() error = %w", name, err)
			}
			wakes, err := driver.ListWakes(
				ctx, fixture.WorkspaceID, issueID,
			)
			if err != nil || len(wakes) != 2 ||
				wakes[1].Status != "dispatched" ||
				driver.WakeDeliveryCallCount() != beforeCalls+1 {
				return fmt.Errorf(
					"%s: harmless marker stranded wake: wakes=%#v calls=%d error=%v",
					name, wakes,
					driver.WakeDeliveryCallCount()-beforeCalls, err,
				)
			}
		}
	}
	return nil
}

func runInternalWakeIdentityIsExactSourceSessionScoped(
	ctx context.Context,
	driver Driver,
) error {
	target := wakeFixture("watchdog-internal-identity-target")
	target.SourceSessionID = "session-watchdog-internal-identity-target"
	targetIssueID, _, err := acceptAndScheduleSettlement(
		ctx, driver, target, []string{"task-a"},
	)
	if err != nil {
		return fmt.Errorf("target schedule error = %w", err)
	}
	other := wakeFixture("watchdog-internal-identity-other")
	other.SourceSessionID = "session-watchdog-internal-identity-other"
	otherIssueID, _, err := acceptAndScheduleSettlement(
		ctx, driver, other, []string{"task-a"},
	)
	if err != nil {
		return fmt.Errorf("other schedule error = %w", err)
	}
	targetBefore, targetWakes, err := wakeSnapshot(
		ctx, driver, target.WorkspaceID, targetIssueID,
	)
	if err != nil || len(targetWakes) != 1 {
		return fmt.Errorf("target initial wakes=%#v error=%v", targetWakes, err)
	}
	otherBefore, err := driver.GetSnapshot(
		ctx, other.WorkspaceID, otherIssueID,
	)
	if err != nil {
		return fmt.Errorf("other initial snapshot error = %w", err)
	}
	driver.AdvanceClockWithoutRenewal(4 * time.Minute)
	activityAt := driver.CurrentTime()
	for _, activity := range []SourceSessionActivity{
		{
			WorkspaceID: target.WorkspaceID,
			SessionID:   target.SourceSessionID,
			Kind:        "user_turn",
			ActivityID:  "exact-target-internal-wake",
			OccurredAt:  activityAt,
		},
		{
			WorkspaceID: other.WorkspaceID,
			SessionID:   other.SourceSessionID,
			Kind:        "user_turn",
			ActivityID:  "cross-session-reused-wake-id",
			OccurredAt:  activityAt,
		},
	} {
		if err := driver.CommitCanonicalSourceActivity(
			ctx, activity, targetWakes[0].ClientSubmitID,
		); err != nil {
			return fmt.Errorf(
				"CommitCanonicalSourceActivity(%s) error = %w",
				activity.SessionID, err,
			)
		}
	}
	beforeCalls := driver.WakeDeliveryCallCount()
	driver.AdvanceClockWithoutRenewal(time.Minute)
	if err := driver.RunWatchdog(
		ctx, target.WorkspaceID, "watchdog-internal-identity",
	); err != nil {
		return fmt.Errorf("RunWatchdog() error = %w", err)
	}
	targetAfter, targetFinalWakes, err := wakeSnapshot(
		ctx, driver, target.WorkspaceID, targetIssueID,
	)
	if err != nil || len(targetFinalWakes) != 2 ||
		targetFinalWakes[1].Status != "dispatched" ||
		targetAfter.Execution.LastOrchestratorActivityAt !=
			targetBefore.Execution.LastOrchestratorActivityAt ||
		targetAfter.Execution.WatchdogDueAt !=
			targetBefore.Execution.WatchdogDueAt {
		return fmt.Errorf(
			"exact target internal wake was not excluded: before=%#v after=%#v wakes=%#v error=%v",
			targetBefore.Execution, targetAfter.Execution, targetFinalWakes, err,
		)
	}
	otherAfter, otherWakes, err := wakeSnapshot(
		ctx, driver, other.WorkspaceID, otherIssueID,
	)
	wantOtherDue := activityAt.Add(fixedWatchdogInterval)
	if err != nil || len(otherWakes) != 1 ||
		!otherAfter.Execution.LastOrchestratorActivityAt.Equal(activityAt) ||
		!otherAfter.Execution.WatchdogDueAt.Equal(wantOtherDue) ||
		otherBefore.Execution.LastOrchestratorActivityAt.Equal(
			otherAfter.Execution.LastOrchestratorActivityAt,
		) ||
		driver.WakeDeliveryCallCount() != beforeCalls+1 {
		return fmt.Errorf(
			"cross-session reused wake ID was excluded: before=%#v after=%#v wakes=%#v calls=%d error=%v",
			otherBefore.Execution, otherAfter.Execution, otherWakes,
			driver.WakeDeliveryCallCount()-beforeCalls, err,
		)
	}
	return nil
}

func runOverdueCanonicalMarkersDoNotStrandWakeDelivery(
	ctx context.Context,
	driver Driver,
) error {
	for _, window := range []string{"before_claim", "during_send"} {
		fixture := wakeFixture("watchdog-overdue-marker-" + window)
		fixture.SourceSessionID = "session-watchdog-overdue-marker-" + window
		issueID, _, err := acceptAndScheduleSettlement(
			ctx, driver, fixture, []string{"task-a"},
		)
		if err != nil {
			return fmt.Errorf("%s: schedule error = %w", window, err)
		}
		before, err := driver.GetSnapshot(
			ctx, fixture.WorkspaceID, issueID,
		)
		if err != nil {
			return fmt.Errorf("%s: initial snapshot error = %w", window, err)
		}
		driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval + time.Minute)
		activityAt := before.Execution.LastOrchestratorActivityAt.Add(time.Minute)
		activity := SourceSessionActivity{
			WorkspaceID: fixture.WorkspaceID,
			SessionID:   fixture.SourceSessionID,
			Kind:        "agent_turn",
			ActivityID:  "overdue-marker-" + window,
			OccurredAt:  activityAt,
		}
		switch window {
		case "before_claim":
			driver.CommitCanonicalSourceActivityBeforeNextWakeClaim(
				ctx, activity, "",
			)
		case "during_send":
			driver.CommitCanonicalSourceActivityDuringNextWakeSend(
				ctx, activity, "",
			)
		}
		beforeCalls := driver.WakeDeliveryCallCount()
		beforeCanonical := driver.WakeDeliveryCanonicalTurnCount()
		if err := driver.RunWatchdog(
			ctx, fixture.WorkspaceID, "watchdog-overdue-marker-"+window,
		); err != nil {
			return fmt.Errorf("%s: RunWatchdog() error = %w", window, err)
		}
		_, wakes, err := wakeSnapshot(
			ctx, driver, fixture.WorkspaceID, issueID,
		)
		if err != nil || len(wakes) != 2 ||
			wakes[1].Status != "dispatched" ||
			driver.WakeDeliveryCallCount() != beforeCalls+1 ||
			driver.WakeDeliveryCanonicalTurnCount() != beforeCanonical+1 {
			return fmt.Errorf(
				"%s: overdue marker stranded wake: wakes=%#v calls=%d canonical=%d error=%v",
				window, wakes,
				driver.WakeDeliveryCallCount()-beforeCalls,
				driver.WakeDeliveryCanonicalTurnCount()-beforeCanonical,
				err,
			)
		}
		if err := driver.RunWatchdog(
			ctx, fixture.WorkspaceID, "watchdog-overdue-marker-replay-"+window,
		); err != nil {
			return fmt.Errorf("%s: replay RunWatchdog() error = %w", window, err)
		}
		replayed, replayedWakes, err := wakeSnapshot(
			ctx, driver, fixture.WorkspaceID, issueID,
		)
		wantDue := activityAt.Add(fixedWatchdogInterval)
		if err != nil || len(replayedWakes) != 2 ||
			replayedWakes[1].WakeID != wakes[1].WakeID ||
			replayedWakes[1].CanonicalTurnID != wakes[1].CanonicalTurnID ||
			!replayed.Execution.LastOrchestratorActivityAt.Equal(activityAt) ||
			!replayed.Execution.WatchdogDueAt.Equal(wantDue) ||
			driver.WakeDeliveryCallCount() != beforeCalls+1 ||
			driver.WakeDeliveryCanonicalTurnCount() != beforeCanonical+1 {
			return fmt.Errorf(
				"%s: overdue marker replay lost canonical Turn idempotence: execution=%#v wakes=%#v calls=%d canonical=%d error=%v",
				window, replayed.Execution, replayedWakes,
				driver.WakeDeliveryCallCount()-beforeCalls,
				driver.WakeDeliveryCanonicalTurnCount()-beforeCanonical,
				err,
			)
		}
	}
	return nil
}
