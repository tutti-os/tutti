package conformance

import (
	"context"
	"fmt"
	"reflect"
	"time"
)

type canonicalSourceActivityRecoveryCase struct {
	name             string
	kind             string
	clientSubmit     string
	existingTurnTime bool
}

func runCanonicalSourceActivityRecoversAfterLostObserverProjection(
	ctx context.Context,
	driver Driver,
) error {
	for _, test := range []canonicalSourceActivityRecoveryCase{
		{name: "user_turn", kind: "user_turn", clientSubmit: "external-submit-user-turn"},
		{name: "agent_turn", kind: "agent_turn"},
	} {
		if err := runCanonicalSourceActivityRecoveryCase(
			ctx, driver, test,
		); err != nil {
			return err
		}
	}

	queueFixture := wakeFixture("watchdog-canonical-queue-recovery")
	queueFixture.SourceSessionID = "session-watchdog-canonical-queue-recovery"
	queueIssueID, _, err := acceptAndScheduleSettlement(
		ctx, driver, queueFixture, []string{"task-a"},
	)
	if err != nil {
		return fmt.Errorf("queue fixture: %w", err)
	}
	driver.SetSourceBusy(
		queueFixture.WorkspaceID, queueFixture.SourceSessionID, true,
	)
	driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
	if err := driver.RunWatchdog(
		ctx, queueFixture.WorkspaceID, "watchdog-queue-materialize",
	); err != nil {
		return fmt.Errorf("queue recovery materialization error = %w", err)
	}
	prepared, err := driver.ListWakes(
		ctx, queueFixture.WorkspaceID, queueIssueID,
	)
	if err != nil || len(prepared) != 2 ||
		prepared[1].Status != "prepared" {
		return fmt.Errorf(
			"queue recovery prepared wakes=%#v error=%v",
			prepared, err,
		)
	}
	driver.SetSourceBusy(
		queueFixture.WorkspaceID, queueFixture.SourceSessionID, false,
	)
	activityAt := driver.CurrentTime()
	if err := driver.CommitCanonicalSourceActivity(
		ctx,
		SourceSessionActivity{
			WorkspaceID: queueFixture.WorkspaceID,
			SessionID:   queueFixture.SourceSessionID,
			Kind:        "user_turn",
			ActivityID:  "canonical-queue-source-turn",
			OccurredAt:  activityAt,
		},
		"external-submit-queue-recovery",
	); err != nil {
		return fmt.Errorf("queue recovery canonical commit error = %w", err)
	}
	beforeQueueCalls := driver.WakeDeliveryCallCount()
	if err := driver.StartupRecoverWakes(
		ctx, queueFixture.WorkspaceID, "watchdog-queue-recovery",
	); err != nil {
		return fmt.Errorf("queue-style wake recovery error = %w", err)
	}
	queueRecovered, queueWakes, err := wakeSnapshot(
		ctx, driver, queueFixture.WorkspaceID, queueIssueID,
	)
	queueDue := activityAt.Add(fixedWatchdogInterval)
	if err != nil || len(queueWakes) != 2 ||
		queueWakes[1].Status != "prepared" ||
		!queueWakes[1].DueAt.Equal(queueDue) ||
		!queueRecovered.Execution.LastOrchestratorActivityAt.Equal(activityAt) ||
		!queueRecovered.Execution.WatchdogDueAt.Equal(queueDue) ||
		driver.WakeDeliveryCallCount() != beforeQueueCalls {
		return fmt.Errorf(
			"queue path bypassed durable activity drain: execution=%#v wakes=%#v calls=%d error=%v",
			queueRecovered.Execution, queueWakes,
			driver.WakeDeliveryCallCount()-beforeQueueCalls, err,
		)
	}
	// Keep this intentionally pending wake from becoming due during the
	// independent internal-submit scenario below.
	driver.SetSourceBusy(
		queueFixture.WorkspaceID, queueFixture.SourceSessionID, true,
	)

	fixture := wakeFixture("watchdog-canonical-internal-submit")
	fixture.SourceSessionID = "session-watchdog-canonical-internal-submit"
	issueID, _, err := acceptAndScheduleSettlement(
		ctx, driver, fixture, []string{"task-a"},
	)
	if err != nil {
		return fmt.Errorf("internal-submit fixture: %w", err)
	}
	wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(wakes) != 1 {
		return fmt.Errorf("internal-submit initial wakes=%#v error=%v", wakes, err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	driver.AdvanceClockWithoutRenewal(4 * time.Minute)
	if err := driver.CommitCanonicalSourceActivity(
		ctx,
		SourceSessionActivity{
			WorkspaceID: fixture.WorkspaceID,
			SessionID:   fixture.SourceSessionID,
			Kind:        "user_turn",
			ActivityID:  "canonical-internal-submit",
			OccurredAt:  driver.CurrentTime(),
		},
		wakes[0].ClientSubmitID,
	); err != nil {
		return fmt.Errorf("internal-submit canonical commit error = %w", err)
	}
	beforeCalls := driver.WakeDeliveryCallCount()
	driver.AdvanceClockWithoutRenewal(time.Minute)
	if err := driver.RunWatchdog(
		ctx, fixture.WorkspaceID, "watchdog-canonical-internal-submit",
	); err != nil {
		return fmt.Errorf("internal-submit RunWatchdog() error = %w", err)
	}
	after, finalWakes, err := wakeSnapshot(
		ctx, driver, fixture.WorkspaceID, issueID,
	)
	if err != nil || len(finalWakes) != 2 ||
		after.Execution.LastOrchestratorActivityAt !=
			before.Execution.LastOrchestratorActivityAt ||
		after.Execution.WatchdogDueAt != before.Execution.WatchdogDueAt ||
		finalWakes[1].Status != "dispatched" ||
		driver.WakeDeliveryCallCount() != beforeCalls+1 {
		return fmt.Errorf(
			"internal accepted wake submit incorrectly debounced watchdog: before=%#v after=%#v wakes=%#v calls=%d error=%v",
			before.Execution, after.Execution, finalWakes,
			driver.WakeDeliveryCallCount()-beforeCalls, err,
		)
	}
	return nil
}

func runCanonicalUserMessageActivityRecoversAfterLostObserverProjection(
	ctx context.Context,
	driver Driver,
) error {
	for _, test := range []canonicalSourceActivityRecoveryCase{
		{name: "user_turn_empty_submit", kind: "user_turn"},
		{
			name: "user_guidance_existing_turn", kind: "user_turn",
			clientSubmit: "external-guidance", existingTurnTime: true,
		},
	} {
		if err := runCanonicalSourceActivityRecoveryCase(
			ctx, driver, test,
		); err != nil {
			return err
		}
	}
	return nil
}

func runCanonicalSourceActivityRecoveryCase(
	ctx context.Context,
	driver Driver,
	test canonicalSourceActivityRecoveryCase,
) error {
	fixture := wakeFixture("watchdog-canonical-source-" + test.name)
	fixture.SourceSessionID = "session-watchdog-canonical-source-" + test.name
	issueID, _, err := acceptAndScheduleSettlement(
		ctx, driver, fixture, []string{"task-a"},
	)
	if err != nil {
		return fmt.Errorf("%s: schedule error = %w", test.name, err)
	}
	turnStartedAt := driver.CurrentTime()
	driver.AdvanceClockWithoutRenewal(4 * time.Minute)
	activityAt := driver.CurrentTime()
	activity := SourceSessionActivity{
		WorkspaceID: fixture.WorkspaceID,
		SessionID:   fixture.SourceSessionID,
		Kind:        test.kind,
		ActivityID:  "canonical-source-" + test.name,
		OccurredAt:  activityAt,
	}
	if test.existingTurnTime {
		activity.TurnStartedAt = turnStartedAt
	}
	if err := driver.CommitCanonicalSourceActivity(
		ctx, activity, test.clientSubmit,
	); err != nil {
		return fmt.Errorf("%s: CommitCanonicalSourceActivity() error = %w", test.name, err)
	}
	beforeCalls := driver.WakeDeliveryCallCount()
	driver.AdvanceClockWithoutRenewal(time.Minute)
	if err := driver.StartupRecoverWatchdog(
		ctx, fixture.WorkspaceID, "watchdog-canonical-source-restart-"+test.name,
	); err != nil {
		return fmt.Errorf("%s: StartupRecoverWatchdog() error = %w", test.name, err)
	}
	recovered, wakes, err := wakeSnapshot(
		ctx, driver, fixture.WorkspaceID, issueID,
	)
	wantDue := activityAt.Add(fixedWatchdogInterval)
	if err != nil || len(wakes) != 1 ||
		!recovered.Execution.LastOrchestratorActivityAt.Equal(activityAt) ||
		!recovered.Execution.WatchdogDueAt.Equal(wantDue) ||
		driver.WakeDeliveryCallCount() != beforeCalls {
		return fmt.Errorf(
			"%s: lost canonical activity did not recover before due materialization: execution=%#v wakes=%#v calls=%d error=%v",
			test.name, recovered.Execution, wakes,
			driver.WakeDeliveryCallCount()-beforeCalls, err,
		)
	}
	if err := driver.CommitCanonicalSourceActivity(
		ctx, activity, test.clientSubmit,
	); err != nil {
		return fmt.Errorf("%s: canonical replay error = %w", test.name, err)
	}
	if err := driver.RunWatchdog(
		ctx, fixture.WorkspaceID, "watchdog-canonical-source-replay-"+test.name,
	); err != nil {
		return fmt.Errorf("%s: replay recovery error = %w", test.name, err)
	}
	replayed, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil ||
		!replayed.Execution.LastOrchestratorActivityAt.Equal(activityAt) ||
		!replayed.Execution.WatchdogDueAt.Equal(wantDue) ||
		driver.WakeDeliveryCallCount() != beforeCalls {
		return fmt.Errorf(
			"%s: canonical replay drifted deadline: execution=%#v calls=%d error=%v",
			test.name, replayed.Execution,
			driver.WakeDeliveryCallCount()-beforeCalls, err,
		)
	}
	driver.AdvanceClockWithoutRenewal(4 * time.Minute)
	if err := driver.RunWatchdog(
		ctx, fixture.WorkspaceID, "watchdog-canonical-source-due-"+test.name,
	); err != nil {
		return fmt.Errorf("%s: RunWatchdog(new due) error = %w", test.name, err)
	}
	final, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(final) != 2 || final[1].Status != "dispatched" ||
		driver.WakeDeliveryCallCount() != beforeCalls+1 {
		return fmt.Errorf(
			"%s: recovered deadline did not dispatch once: wakes=%#v calls=%d error=%v",
			test.name, final, driver.WakeDeliveryCallCount()-beforeCalls, err,
		)
	}
	return nil
}

func runSourceActivityAfterClaimDefersWakeBeforeSend(
	ctx context.Context,
	driver Driver,
) error {
	for _, kind := range []string{"user_turn", "agent_turn"} {
		fixture := wakeFixture("watchdog-claim-send-" + kind)
		issueID, _, err := acceptAndScheduleSettlement(
			ctx, driver, fixture, []string{"task-a"},
		)
		if err != nil {
			return fmt.Errorf("%s: schedule error = %w", kind, err)
		}
		driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
		activityAt := driver.CurrentTime()
		clientSubmitID := ""
		if kind == "user_turn" {
			clientSubmitID = "external-claim-send-" + kind
		}
		driver.CommitCanonicalSourceActivityAfterNextWakeClaim(
			ctx,
			SourceSessionActivity{
				WorkspaceID: fixture.WorkspaceID,
				SessionID:   fixture.SourceSessionID,
				Kind:        kind,
				ActivityID:  "claim-send-" + kind,
			},
			clientSubmitID,
		)
		beforeCalls := driver.WakeDeliveryCallCount()
		if err := driver.RunWatchdog(
			ctx, fixture.WorkspaceID, "watchdog-claim-send-"+kind,
		); err != nil {
			return fmt.Errorf("%s: RunWatchdog(race) error = %w", kind, err)
		}
		afterRace, wakes, err := wakeSnapshot(
			ctx, driver, fixture.WorkspaceID, issueID,
		)
		if err != nil || len(wakes) != 2 {
			return fmt.Errorf("%s: race snapshot wakes=%#v error=%v", kind, wakes, err)
		}
		deferred := wakes[1]
		wantDue := activityAt.Add(fixedWatchdogInterval)
		if driver.WakeDeliveryCallCount() != beforeCalls ||
			deferred.Status != "prepared" ||
			!deferred.DueAt.Equal(wantDue) ||
			!afterRace.Execution.LastOrchestratorActivityAt.Equal(activityAt) ||
			!afterRace.Execution.WatchdogDueAt.Equal(wantDue) {
			return fmt.Errorf(
				"%s: claim-to-send activity was not fenced: execution=%#v wake=%#v calls=%d",
				kind, afterRace.Execution, deferred,
				driver.WakeDeliveryCallCount()-beforeCalls,
			)
		}
		if err := driver.RunWatchdog(
			ctx, fixture.WorkspaceID, "watchdog-claim-send-before-due-"+kind,
		); err != nil {
			return fmt.Errorf("%s: RunWatchdog(before due) error = %w", kind, err)
		}
		if driver.WakeDeliveryCallCount() != beforeCalls {
			return fmt.Errorf("%s: deferred wake sent before new due", kind)
		}
		driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
		if err := driver.RunWatchdog(
			ctx, fixture.WorkspaceID, "watchdog-claim-send-due-"+kind,
		); err != nil {
			return fmt.Errorf("%s: RunWatchdog(new due) error = %w", kind, err)
		}
		final, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if err != nil || len(final) != 2 ||
			final[1].WakeID != deferred.WakeID ||
			final[1].ClientSubmitID != deferred.ClientSubmitID ||
			final[1].Status != "dispatched" ||
			driver.WakeDeliveryCallCount() != beforeCalls+1 {
			return fmt.Errorf(
				"%s: deferred operation did not resume once: wakes=%#v calls=%d error=%v",
				kind, final, driver.WakeDeliveryCallCount()-beforeCalls, err,
			)
		}
	}
	return nil
}

func runCanonicalActivityBeforeClaimRejectsWakeAdmission(
	ctx context.Context,
	driver Driver,
) error {
	fixture := wakeFixture("watchdog-before-claim-canonical")
	issueID, _, err := acceptAndScheduleSettlement(
		ctx, driver, fixture, []string{"task-a"},
	)
	if err != nil {
		return err
	}
	driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
	activityAt := driver.CurrentTime()
	driver.CommitCanonicalSourceActivityBeforeNextWakeClaim(
		ctx,
		SourceSessionActivity{
			WorkspaceID: fixture.WorkspaceID,
			SessionID:   fixture.SourceSessionID,
			Kind:        "user_turn",
			ActivityID:  "canonical-source-before-claim",
			OccurredAt:  activityAt,
		},
		"external-before-claim",
	)
	beforeCalls := driver.WakeDeliveryCallCount()
	if err := driver.RunWatchdog(
		ctx, fixture.WorkspaceID, "watchdog-before-claim-fence",
	); err != nil {
		return fmt.Errorf("RunWatchdog(before claim fence) error = %w", err)
	}
	_, fencedWakes, err := wakeSnapshot(
		ctx, driver, fixture.WorkspaceID, issueID,
	)
	if err != nil || len(fencedWakes) != 2 ||
		fencedWakes[1].Status != "prepared" ||
		driver.WakeDeliveryCallCount() != beforeCalls {
		return fmt.Errorf(
			"canonical activity crossed claim fence: wakes=%#v calls=%d error=%v",
			fencedWakes, driver.WakeDeliveryCallCount()-beforeCalls, err,
		)
	}
	if err := driver.RunWatchdog(
		ctx, fixture.WorkspaceID, "watchdog-before-claim-drain",
	); err != nil {
		return fmt.Errorf("RunWatchdog(before claim drain) error = %w", err)
	}
	recovered, wakes, err := wakeSnapshot(
		ctx, driver, fixture.WorkspaceID, issueID,
	)
	wantDue := activityAt.Add(fixedWatchdogInterval)
	if err != nil || len(wakes) != 2 ||
		wakes[1].Status != "prepared" ||
		!wakes[1].DueAt.Equal(wantDue) ||
		!recovered.Execution.WatchdogDueAt.Equal(wantDue) ||
		driver.WakeDeliveryCallCount() != beforeCalls {
		return fmt.Errorf(
			"claim-fenced activity did not recover: execution=%#v wakes=%#v calls=%d error=%v",
			recovered.Execution, wakes,
			driver.WakeDeliveryCallCount()-beforeCalls, err,
		)
	}
	driver.SetSourceBusy(fixture.WorkspaceID, fixture.SourceSessionID, true)

	internalFixture := wakeFixture("watchdog-before-claim-internal")
	internalFixture.SourceSessionID = "session-watchdog-before-claim-internal"
	internalIssueID, _, err := acceptAndScheduleSettlement(
		ctx, driver, internalFixture, []string{"task-a"},
	)
	if err != nil {
		return err
	}
	internalWakes, err := driver.ListWakes(
		ctx, internalFixture.WorkspaceID, internalIssueID,
	)
	if err != nil || len(internalWakes) != 1 {
		return fmt.Errorf(
			"internal classification initial wakes=%#v error=%v",
			internalWakes, err,
		)
	}
	driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
	driver.CommitCanonicalSourceActivityBeforeNextWakeClaim(
		ctx,
		SourceSessionActivity{
			WorkspaceID: internalFixture.WorkspaceID,
			SessionID:   internalFixture.SourceSessionID,
			Kind:        "user_turn",
			ActivityID:  "canonical-internal-before-claim",
			OccurredAt:  driver.CurrentTime(),
		},
		internalWakes[0].ClientSubmitID,
	)
	beforeInternalCalls := driver.WakeDeliveryCallCount()
	if err := driver.RunWatchdog(
		ctx, internalFixture.WorkspaceID, "watchdog-before-claim-internal",
	); err != nil {
		return fmt.Errorf("RunWatchdog(internal claim classification) error = %w", err)
	}
	internalFinal, err := driver.ListWakes(
		ctx, internalFixture.WorkspaceID, internalIssueID,
	)
	if err != nil || len(internalFinal) != 2 ||
		internalFinal[1].Status != "dispatched" ||
		driver.WakeDeliveryCallCount() != beforeInternalCalls+1 {
		return fmt.Errorf(
			"internal wake submit was classified as source activity: wakes=%#v calls=%d error=%v",
			internalFinal,
			driver.WakeDeliveryCallCount()-beforeInternalCalls,
			err,
		)
	}
	return nil
}

func runCanonicalSettledWakeRecoversAfterLostObserverProjection(
	ctx context.Context,
	driver Driver,
) error {
	fixture := wakeFixture("watchdog-canonical-settlement-recovery")
	issueID, _, err := acceptAndScheduleSettlement(
		ctx, driver, fixture, []string{"task-a"},
	)
	if err != nil {
		return err
	}
	driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
	if err := driver.RunWatchdog(
		ctx, fixture.WorkspaceID, "watchdog-canonical-settlement-sequence-1",
	); err != nil {
		return fmt.Errorf("RunWatchdog(sequence 1) error = %w", err)
	}
	before, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(before) != 2 ||
		before[1].Status != "dispatched" ||
		before[1].CanonicalTurnID == "" {
		return fmt.Errorf("sequence 1 wakes=%#v error=%v", before, err)
	}
	sequenceOne := before[1]
	canonicalSettledAt := driver.CurrentTime()
	driver.SetCanonicalWakeTurnSettledAt(
		fixture.WorkspaceID,
		fixture.SourceSessionID,
		sequenceOne.CanonicalTurnID,
		canonicalSettledAt,
	)
	beforeCalls := driver.WakeDeliveryCallCount()
	driver.AdvanceClockWithoutRenewal(4 * time.Minute)
	if err := driver.StartupRecoverWatchdog(
		ctx, fixture.WorkspaceID, "watchdog-canonical-settlement-restart",
	); err != nil {
		return fmt.Errorf("StartupRecoverWatchdog() error = %w", err)
	}
	recovered, wakes, err := wakeSnapshot(
		ctx, driver, fixture.WorkspaceID, issueID,
	)
	wantDue := canonicalSettledAt.Add(fixedWatchdogInterval)
	if err != nil || len(wakes) != 2 ||
		wakes[1].Status != "turn_settled" ||
		wakes[1].WakeID != sequenceOne.WakeID ||
		!recovered.Execution.LastOrchestratorActivityAt.Equal(canonicalSettledAt) ||
		!recovered.Execution.WatchdogDueAt.Equal(wantDue) ||
		driver.WakeDeliveryCallCount() != beforeCalls {
		return fmt.Errorf(
			"lost observer projection did not converge from canonical Turn: execution=%#v wakes=%#v calls=%d error=%v",
			recovered.Execution, wakes,
			driver.WakeDeliveryCallCount()-beforeCalls, err,
		)
	}
	if err := driver.StartupRecoverWatchdog(
		ctx, fixture.WorkspaceID, "watchdog-canonical-settlement-replay",
	); err != nil {
		return fmt.Errorf("StartupRecoverWatchdog(replay) error = %w", err)
	}
	if driver.WakeDeliveryCallCount() != beforeCalls {
		return fmt.Errorf("canonical settlement replay duplicated SendInput")
	}
	driver.AdvanceClockWithoutRenewal(time.Minute)
	if err := driver.RunWatchdog(
		ctx, fixture.WorkspaceID, "watchdog-canonical-settlement-sequence-2",
	); err != nil {
		return fmt.Errorf("RunWatchdog(sequence 2) error = %w", err)
	}
	final, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(final) != 3 {
		return fmt.Errorf("sequence 2 wakes=%#v error=%v", final, err)
	}
	sequenceTwo := final[2]
	wantWakeID := sequenceOne.CheckpointID + ":wake:main:2"
	if sequenceTwo.CheckpointID != sequenceOne.CheckpointID ||
		sequenceTwo.WakeSequence != 2 ||
		sequenceTwo.WakeID != wantWakeID ||
		sequenceTwo.ClientSubmitID != "tutti-execution-wake:"+wantWakeID ||
		sequenceTwo.Status != "dispatched" ||
		driver.WakeDeliveryCallCount() != beforeCalls+1 {
		return fmt.Errorf(
			"canonical recovery did not resume fixed sequence: wakes=%#v calls=%d",
			final, driver.WakeDeliveryCallCount()-beforeCalls,
		)
	}
	return nil
}

func runSourceActivityDuringSendRejectsStaleFinalization(
	ctx context.Context,
	driver Driver,
) error {
	fixture := wakeFixture("watchdog-send-final-cas")
	issueID, _, err := acceptAndScheduleSettlement(
		ctx, driver, fixture, []string{"task-a"},
	)
	if err != nil {
		return err
	}
	driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
	activityAt := driver.CurrentTime()
	driver.CommitCanonicalSourceActivityDuringNextWakeSend(
		ctx,
		SourceSessionActivity{
			WorkspaceID: fixture.WorkspaceID,
			SessionID:   fixture.SourceSessionID,
			Kind:        "agent_turn",
			ActivityID:  "root-turn-during-wake-send",
		},
		"",
	)
	beforeCalls := driver.WakeDeliveryCallCount()
	beforeCanonical := driver.WakeDeliveryCanonicalTurnCount()
	if err := driver.RunWatchdog(
		ctx, fixture.WorkspaceID, "watchdog-send-final-cas-stale",
	); err != nil {
		return fmt.Errorf("RunWatchdog(stale final CAS) error = %w", err)
	}
	afterRace, wakes, err := wakeSnapshot(
		ctx, driver, fixture.WorkspaceID, issueID,
	)
	wantDue := activityAt.Add(fixedWatchdogInterval)
	if err != nil || len(wakes) != 2 {
		return fmt.Errorf("wakeSnapshot(stale final CAS) wakes=%#v error=%v", wakes, err)
	}
	retained := wakes[1]
	if retained.Status != "prepared" ||
		!retained.DueAt.Equal(wantDue) ||
		!afterRace.Execution.WatchdogDueAt.Equal(wantDue) ||
		driver.WakeDeliveryCallCount() != beforeCalls+1 ||
		driver.WakeDeliveryCanonicalTurnCount() != beforeCanonical+1 {
		return fmt.Errorf(
			"activity during send bypassed final CAS: execution=%#v wake=%#v calls=%d canonical=%d",
			afterRace.Execution, retained,
			driver.WakeDeliveryCallCount()-beforeCalls,
			driver.WakeDeliveryCanonicalTurnCount()-beforeCanonical,
		)
	}
	driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
	if err := driver.RunWatchdog(
		ctx, fixture.WorkspaceID, "watchdog-send-final-cas-retry",
	); err != nil {
		return fmt.Errorf("RunWatchdog(final CAS retry) error = %w", err)
	}
	final, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(final) != 2 ||
		final[1].WakeID != retained.WakeID ||
		final[1].ClientSubmitID != retained.ClientSubmitID ||
		final[1].Status != "dispatched" ||
		driver.WakeDeliveryCallCount() != beforeCalls+2 ||
		driver.WakeDeliveryCanonicalTurnCount() != beforeCanonical+1 {
		return fmt.Errorf(
			"fenced send did not converge idempotently: wakes=%#v calls=%d canonical=%d error=%v",
			final,
			driver.WakeDeliveryCallCount()-beforeCalls,
			driver.WakeDeliveryCanonicalTurnCount()-beforeCanonical,
			err,
		)
	}
	return nil
}

func runStartupRecoversOnlyExpiredLeasesWithStableIdentity(
	ctx context.Context,
	driver Driver,
) error {
	expired := wakeFixture("watchdog-startup-expired")
	active := wakeFixture("watchdog-startup-active")
	scanned := wakeFixture("watchdog-startup-scanned")
	expired.SourceSessionID = "session-watchdog-startup-expired"
	active.SourceSessionID = "session-watchdog-startup-active"
	scanned.SourceSessionID = "session-watchdog-startup-scanned"
	expiredIssueID, _, err := acceptAndScheduleSettlement(ctx, driver, expired, []string{"task-a"})
	if err != nil {
		return err
	}
	activeIssueID, _, err := acceptAndScheduleSettlement(ctx, driver, active, []string{"task-a"})
	if err != nil {
		return err
	}
	driver.SetSourceBusy(expired.WorkspaceID, expired.SourceSessionID, true)
	driver.SetSourceBusy(active.WorkspaceID, active.SourceSessionID, true)
	driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
	if err := driver.RunWatchdog(ctx, expired.WorkspaceID, "watchdog-seed-leases"); err != nil {
		return fmt.Errorf("RunWatchdog(seed leases) error = %w", err)
	}
	expiredWakes, _ := driver.ListWakes(ctx, expired.WorkspaceID, expiredIssueID)
	activeWakes, _ := driver.ListWakes(ctx, active.WorkspaceID, activeIssueID)
	if len(expiredWakes) != 2 || len(activeWakes) != 2 {
		return fmt.Errorf("seeded watchdog wakes expired=%#v active=%#v", expiredWakes, activeWakes)
	}
	expiredWake := expiredWakes[1]
	activeWake := activeWakes[1]
	if claimed, err := driver.ClaimWake(
		ctx, expired.WorkspaceID, expiredWake.WakeID, "expired-owner", time.Minute,
	); err != nil || !claimed {
		return fmt.Errorf("ClaimWake(expired)=%v error=%v", claimed, err)
	}
	if claimed, err := driver.ClaimWake(
		ctx, active.WorkspaceID, activeWake.WakeID, "active-owner", 15*time.Minute,
	); err != nil || !claimed {
		return fmt.Errorf("ClaimWake(active)=%v error=%v", claimed, err)
	}
	scannedIssueID, _, err := acceptAndScheduleSettlement(
		ctx, driver, scanned, []string{"task-a"},
	)
	if err != nil {
		return err
	}
	driver.SetSourceBusy(expired.WorkspaceID, expired.SourceSessionID, false)
	driver.SetSourceBusy(active.WorkspaceID, active.SourceSessionID, false)
	driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
	if err := driver.StartupRecoverWatchdog(ctx, expired.WorkspaceID, "startup-owner"); err != nil {
		return fmt.Errorf("StartupRecoverWatchdog() error = %w", err)
	}
	expiredAfter, _ := driver.ListWakes(ctx, expired.WorkspaceID, expiredIssueID)
	activeAfter, _ := driver.ListWakes(ctx, active.WorkspaceID, activeIssueID)
	scannedAfter, _ := driver.ListWakes(ctx, scanned.WorkspaceID, scannedIssueID)
	if len(expiredAfter) != 2 || expiredAfter[1].WakeID != expiredWake.WakeID ||
		expiredAfter[1].ClientSubmitID != expiredWake.ClientSubmitID ||
		expiredAfter[1].Status != "dispatched" {
		return fmt.Errorf("expired lease recovery changed operation: before=%#v after=%#v", expiredWake, expiredAfter)
	}
	if len(activeAfter) != 2 || activeAfter[1].Status != "leased" ||
		activeAfter[1].LeaseOwner != "active-owner" ||
		activeAfter[1].WakeID != activeWake.WakeID {
		return fmt.Errorf("startup stole active lease: before=%#v after=%#v", activeWake, activeAfter)
	}
	if len(scannedAfter) != 2 || scannedAfter[1].Status != "dispatched" {
		return fmt.Errorf("startup did not scan due nonterminal execution: %#v", scannedAfter)
	}
	return nil
}

func runNonRunnableExecutionSuppressesWatchdog(
	ctx context.Context,
	driver Driver,
) error {
	for _, status := range []string{"orphaned_source", "completed", "archiving", "archived"} {
		fixture := wakeFixture("watchdog-nonrunnable-" + status)
		issueID, _, err := acceptAndScheduleSettlement(ctx, driver, fixture, []string{"task-a"})
		if err != nil {
			return fmt.Errorf("%s: schedule error = %w", status, err)
		}
		if err := driver.SetExecutionStatus(ctx, fixture.WorkspaceID, issueID, status); err != nil {
			return fmt.Errorf("%s: SetExecutionStatus() error = %w", status, err)
		}
		beforeSnapshot, beforeWakes, err := wakeSnapshot(
			ctx, driver, fixture.WorkspaceID, issueID,
		)
		if err != nil {
			return fmt.Errorf("%s: wakeSnapshot(before) error = %w", status, err)
		}
		beforeCalls := driver.WakeDeliveryCallCount()
		driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
		if err := driver.ObserveSourceSessionActivity(ctx, SourceSessionActivity{
			WorkspaceID: fixture.WorkspaceID,
			SessionID:   fixture.SourceSessionID,
			Kind:        "agent_turn",
		}); err != nil {
			return fmt.Errorf("%s: ObserveSourceSessionActivity() error = %w", status, err)
		}
		if err := driver.StartupRecoverWatchdog(ctx, fixture.WorkspaceID, "watchdog-nonrunnable"); err != nil {
			return fmt.Errorf("%s: StartupRecoverWatchdog() error = %w", status, err)
		}
		afterSnapshot, afterWakes, err := wakeSnapshot(
			ctx, driver, fixture.WorkspaceID, issueID,
		)
		if err != nil ||
			!reflect.DeepEqual(afterSnapshot.Execution, beforeSnapshot.Execution) ||
			!reflect.DeepEqual(afterSnapshot.Checkpoints, beforeSnapshot.Checkpoints) ||
			!reflect.DeepEqual(afterWakes, beforeWakes) ||
			driver.WakeDeliveryCallCount() != beforeCalls {
			return fmt.Errorf(
				"%s: nonrunnable watchdog changed state: before=%#v/%#v after=%#v/%#v calls=%d error=%v",
				status, beforeSnapshot, beforeWakes, afterSnapshot, afterWakes,
				driver.WakeDeliveryCallCount(), err,
			)
		}
	}
	return nil
}

func runInfrastructureRetryDoesNotBackoffProductDeadline(
	ctx context.Context,
	driver Driver,
) error {
	fixture := wakeFixture("watchdog-retry")
	issueID, _, err := acceptAndScheduleSettlement(ctx, driver, fixture, []string{"task-a"})
	if err != nil {
		return err
	}
	driver.AdvanceClockWithoutRenewal(fixedWatchdogInterval)
	productDue := driver.CurrentTime()
	driver.FailNextWakeBeforeCanonical()
	if err := driver.RunWatchdog(ctx, fixture.WorkspaceID, "watchdog-retry-first"); err == nil {
		return fmt.Errorf("RunWatchdog(first) error=nil, want recoverable delivery failure")
	}
	afterFailure, wakes, err := wakeSnapshot(ctx, driver, fixture.WorkspaceID, issueID)
	if err != nil || len(wakes) != 2 || wakes[1].Status != "prepared" {
		return fmt.Errorf("failed delivery state wakes=%#v error=%v", wakes, err)
	}
	operation := wakes[1]
	if !afterFailure.Execution.WatchdogDueAt.Equal(productDue) ||
		!operation.DueAt.Equal(productDue) {
		return fmt.Errorf(
			"infrastructure failure moved due: execution=%s wake=%s want=%s",
			afterFailure.Execution.WatchdogDueAt, operation.DueAt, productDue,
		)
	}
	driver.AdvanceClockWithoutRenewal(10 * time.Second)
	if err := driver.RunWatchdog(ctx, fixture.WorkspaceID, "watchdog-retry-second"); err != nil {
		return fmt.Errorf("RunWatchdog(retry) error = %w", err)
	}
	afterRetry, wakes, err := wakeSnapshot(ctx, driver, fixture.WorkspaceID, issueID)
	if err != nil || len(wakes) != 2 || wakes[1].Status != "dispatched" ||
		wakes[1].WakeID != operation.WakeID ||
		wakes[1].ClientSubmitID != operation.ClientSubmitID {
		return fmt.Errorf("retry changed durable identity: before=%#v after=%#v error=%v", operation, wakes, err)
	}
	if !afterRetry.Execution.WatchdogDueAt.Equal(productDue) ||
		!wakes[1].DueAt.Equal(productDue) {
		return fmt.Errorf(
			"infrastructure retry backed due off: execution=%s wake=%s want=%s",
			afterRetry.Execution.WatchdogDueAt, wakes[1].DueAt, productDue,
		)
	}
	return nil
}
