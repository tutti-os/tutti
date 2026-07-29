package conformance

import (
	"context"
	"fmt"
	"strings"
	"time"
)

func runBoundedWakeDeliveryDoesNotStarveLaterExecution(
	ctx context.Context,
	driver Driver,
) error {
	driver.SetMainWakeSendTimeout(10 * time.Millisecond)
	first := wakeFixture("bounded-a")
	second := wakeFixture("bounded-b")
	first.SourceSessionID = "session-bounded-a"
	second.SourceSessionID = "session-bounded-b"
	firstIssueID, err := driver.AcceptPlan(ctx, first)
	if err != nil {
		return fmt.Errorf("AcceptPlan(first) error = %w", err)
	}
	secondIssueID, err := driver.AcceptPlan(ctx, second)
	if err != nil {
		return fmt.Errorf("AcceptPlan(second) error = %w", err)
	}
	driver.HangWakeUntilContextDone(first.WorkspaceID, first.SourceSessionID)
	recoverErr := driver.RecoverWakes(ctx, first.WorkspaceID, "wake-bounded-owner")
	if recoverErr == nil {
		return fmt.Errorf("RecoverWakes() error=nil, want pending timeout signal")
	}
	firstWakes, err := driver.ListWakes(ctx, first.WorkspaceID, firstIssueID)
	if err != nil || len(firstWakes) != 1 || firstWakes[0].Status != "prepared" {
		return fmt.Errorf("timed out wake=%#v error=%v, want prepared", firstWakes, err)
	}
	secondWakes, err := driver.ListWakes(ctx, second.WorkspaceID, secondIssueID)
	if err != nil || len(secondWakes) != 1 || secondWakes[0].Status != "dispatched" {
		return fmt.Errorf("later wake=%#v error=%v, want dispatched", secondWakes, err)
	}
	deliveries := driver.WakeDeliveries()
	if len(deliveries) != 2 {
		return fmt.Errorf("delivery calls=%#v, want timed out first and delivered second", deliveries)
	}
	if !deliveries[0].HadDeadline ||
		deliveries[0].DeadlineBudget <= 0 ||
		deliveries[0].DeadlineBudget >= time.Minute {
		return fmt.Errorf("SendInput deadline=%#v, want positive budget shorter than lease", deliveries[0])
	}
	return nil
}

func runCanceledCallerStillCompletesBoundedWakeCleanup(
	ctx context.Context,
	driver Driver,
) error {
	for _, testCase := range []struct {
		name       string
		outcome    string
		wantStatus string
		wantError  bool
	}{
		{
			name:       "release-after-definite-failure",
			outcome:    "before-canonical-error",
			wantStatus: "prepared",
			wantError:  true,
		},
		{
			name:       "lookup-and-finalize-after-response-loss",
			outcome:    "after-canonical-error",
			wantStatus: "dispatched",
			wantError:  false,
		},
		{
			name:       "finalize-after-success",
			outcome:    "success",
			wantStatus: "dispatched",
			wantError:  false,
		},
	} {
		fixture := wakeFixture("caller-canceled-" + testCase.name)
		issueID, err := driver.AcceptPlan(ctx, fixture)
		if err != nil {
			return fmt.Errorf("%s: AcceptPlan() error=%w", testCase.name, err)
		}
		wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if err != nil || len(wakes) != 1 {
			return fmt.Errorf("%s: ListWakes()=%#v error=%v", testCase.name, wakes, err)
		}
		owner := "caller-canceled-owner-" + testCase.name
		if claimed, claimErr := driver.ClaimWake(
			ctx, fixture.WorkspaceID, wakes[0].WakeID, owner, time.Minute,
		); claimErr != nil || !claimed {
			return fmt.Errorf(
				"%s: ClaimWake()=%v error=%v", testCase.name, claimed, claimErr,
			)
		}
		dispatchErr := driver.DispatchClaimedWakeWithCallerCancellation(
			ctx, fixture.WorkspaceID, wakes[0].WakeID, owner, testCase.outcome,
		)
		if testCase.wantError && dispatchErr == nil {
			return fmt.Errorf("%s: dispatch error=nil", testCase.name)
		}
		if !testCase.wantError && dispatchErr != nil {
			return fmt.Errorf("%s: dispatch error=%w", testCase.name, dispatchErr)
		}
		after, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if err != nil || len(after) != 1 || after[0].Status != testCase.wantStatus {
			return fmt.Errorf(
				"%s: wake=%#v error=%v, want %s",
				testCase.name, after, err, testCase.wantStatus,
			)
		}
	}
	return nil
}

func runExpiredWakeOwnerCannotSendOrFinalize(
	ctx context.Context,
	driver Driver,
) error {
	preSend := wakeFixture("expired-pre-send")
	preSendIssueID, err := driver.AcceptPlan(ctx, preSend)
	if err != nil {
		return fmt.Errorf("AcceptPlan(pre-send) error = %w", err)
	}
	wakes, err := driver.ListWakes(ctx, preSend.WorkspaceID, preSendIssueID)
	if err != nil || len(wakes) != 1 {
		return fmt.Errorf("ListWakes(pre-send)=%#v error=%v", wakes, err)
	}
	if claimed, err := driver.ClaimWake(
		ctx, preSend.WorkspaceID, wakes[0].WakeID, "expired-owner-a", time.Minute,
	); err != nil || !claimed {
		return fmt.Errorf("ClaimWake(pre-send)=%v error=%v", claimed, err)
	}
	driver.AdvanceClockWithoutRenewal(2 * time.Minute)
	beforeCalls := driver.WakeDeliveryCallCount()
	if err := driver.DispatchClaimedWake(
		ctx, preSend.WorkspaceID, wakes[0].WakeID, "expired-owner-a",
	); err == nil {
		return fmt.Errorf("DispatchClaimedWake(expired before send) error=nil")
	}
	if driver.WakeDeliveryCallCount() != beforeCalls {
		return fmt.Errorf("expired owner reached SendInput before reclaim")
	}

	if err := driver.StartupRecoverWakes(
		ctx, preSend.WorkspaceID, "expired-owner-repair",
	); err != nil {
		return fmt.Errorf("StartupRecoverWakes(pre-send repair) error=%w", err)
	}
	duringSend := wakeFixture("expired-during-send")
	duringIssueID, err := driver.AcceptPlan(ctx, duringSend)
	if err != nil {
		return fmt.Errorf("AcceptPlan(during-send) error = %w", err)
	}
	duringWakes, err := driver.ListWakes(ctx, duringSend.WorkspaceID, duringIssueID)
	if err != nil || len(duringWakes) != 1 {
		return fmt.Errorf("ListWakes(during-send)=%#v error=%v", duringWakes, err)
	}
	if claimed, err := driver.ClaimWake(
		ctx, duringSend.WorkspaceID, duringWakes[0].WakeID,
		"expired-owner-b", time.Minute,
	); err != nil || !claimed {
		return fmt.Errorf("ClaimWake(during-send)=%v error=%v", claimed, err)
	}
	driver.AdvanceClockDuringWake(
		duringSend.WorkspaceID, duringSend.SourceSessionID, 2*time.Minute,
	)
	if err := driver.DispatchClaimedWake(
		ctx, duringSend.WorkspaceID, duringWakes[0].WakeID, "expired-owner-b",
	); err == nil {
		return fmt.Errorf("DispatchClaimedWake(expired final CAS) error=nil")
	}
	after, err := driver.ListWakes(ctx, duringSend.WorkspaceID, duringIssueID)
	if err != nil || len(after) != 1 || after[0].Status == "dispatched" {
		return fmt.Errorf("expired final CAS wake=%#v error=%v", after, err)
	}
	callsAfterExpiry := driver.WakeDeliveryCallCount()
	if err := driver.DispatchClaimedWake(
		ctx, duringSend.WorkspaceID, duringWakes[0].WakeID, "expired-owner-b",
	); err == nil {
		return fmt.Errorf("DispatchClaimedWake(expired replay) error=nil")
	}
	if driver.WakeDeliveryCallCount() != callsAfterExpiry {
		return fmt.Errorf("expired owner duplicated SendInput after failed final CAS")
	}
	return nil
}

func runWakeRecoveryIsolatesPerWakeFailures(
	ctx context.Context,
	driver Driver,
) error {
	cases := []struct {
		name   string
		inject func(context.Context, Driver, AcceptPlanInput, string, Wake) error
	}{
		{
			name: "integrity",
			inject: func(ctx context.Context, driver Driver, fixture AcceptPlanInput, issueID string, _ Wake) error {
				return driver.CorruptWakeIdentity(
					ctx, fixture.WorkspaceID, issueID, "client_submit_id", "corrupt-submit",
				)
			},
		},
		{
			name: "observe",
			inject: func(_ context.Context, driver Driver, fixture AcceptPlanInput, _ string, _ Wake) error {
				driver.FailWakeObservation(fixture.WorkspaceID, fixture.SourceSessionID)
				return nil
			},
		},
		{
			name: "claim",
			inject: func(_ context.Context, driver Driver, _ AcceptPlanInput, _ string, wake Wake) error {
				driver.FailWakeClaim(wake.WakeID)
				return nil
			},
		},
		{
			name: "delivery",
			inject: func(_ context.Context, driver Driver, _ AcceptPlanInput, _ string, _ Wake) error {
				driver.FailNextWakeBeforeCanonical()
				return nil
			},
		},
	}
	for _, testCase := range cases {
		first := wakeFixture("isolate-" + testCase.name + "-a")
		second := wakeFixture("isolate-" + testCase.name + "-b")
		first.SourceSessionID = "session-isolate-" + testCase.name + "-a"
		second.SourceSessionID = "session-isolate-" + testCase.name + "-b"
		firstIssueID, err := driver.AcceptPlan(ctx, first)
		if err != nil {
			return fmt.Errorf("%s: AcceptPlan(first) error=%w", testCase.name, err)
		}
		secondIssueID, err := driver.AcceptPlan(ctx, second)
		if err != nil {
			return fmt.Errorf("%s: AcceptPlan(second) error=%w", testCase.name, err)
		}
		firstWakes, err := driver.ListWakes(ctx, first.WorkspaceID, firstIssueID)
		if err != nil || len(firstWakes) != 1 {
			return fmt.Errorf("%s: first wakes=%#v error=%v", testCase.name, firstWakes, err)
		}
		if err := testCase.inject(ctx, driver, first, firstIssueID, firstWakes[0]); err != nil {
			return fmt.Errorf("%s: inject error=%w", testCase.name, err)
		}
		beforeCalls := driver.WakeDeliveryCallCount()
		if err := driver.RecoverWakes(
			ctx, first.WorkspaceID, "isolate-owner-"+testCase.name,
		); err == nil {
			return fmt.Errorf("%s: RecoverWakes() error=nil, want aggregate", testCase.name)
		}
		secondWakes, err := driver.ListWakes(ctx, second.WorkspaceID, secondIssueID)
		if err != nil || len(secondWakes) != 1 ||
			secondWakes[0].Status != "dispatched" {
			return fmt.Errorf(
				"%s: later execution starved wake=%#v error=%v",
				testCase.name, secondWakes, err,
			)
		}
		if driver.WakeDeliveryCallCount() <= beforeCalls {
			return fmt.Errorf("%s: no later delivery after first failure", testCase.name)
		}
	}
	return nil
}

func runCorruptedWakeIdentityFailsClosedPerField(
	ctx context.Context,
	driver Driver,
) error {
	for _, testCase := range []struct {
		field string
		value string
	}{
		{field: "wake_id", value: "corrupt-wake-id"},
		{field: "client_submit_id", value: "corrupt-client-submit"},
		{field: "target_kind", value: "reviewer"},
		{field: "wake_sequence", value: "2"},
		{field: "target_session_id", value: "corrupt-session"},
	} {
		fixture := wakeFixture("identity-" + strings.ReplaceAll(testCase.field, "_", "-"))
		issueID, err := driver.AcceptPlan(ctx, fixture)
		if err != nil {
			return fmt.Errorf("%s: AcceptPlan() error=%w", testCase.field, err)
		}
		if err := driver.CorruptWakeIdentity(
			ctx, fixture.WorkspaceID, issueID, testCase.field, testCase.value,
		); err != nil {
			return fmt.Errorf("%s: CorruptWakeIdentity() error=%w", testCase.field, err)
		}
		beforeCalls := driver.WakeDeliveryCallCount()
		if err := driver.StartupRecoverWakes(
			ctx, fixture.WorkspaceID, "identity-owner-"+testCase.field,
		); err == nil {
			return fmt.Errorf("%s: StartupRecoverWakes() error=nil, want integrity", testCase.field)
		}
		wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if err != nil || len(wakes) != 1 || wakes[0].Status != "failed" {
			return fmt.Errorf("%s: corrupted wake=%#v error=%v", testCase.field, wakes, err)
		}
		if driver.WakeDeliveryCallCount() != beforeCalls {
			return fmt.Errorf("%s: corrupted identity reached SendInput", testCase.field)
		}
	}
	fixture := wakeFixture("identity-target-kind-sequence-two")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("sequence-two: AcceptPlan() error=%w", err)
	}
	initialWakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(initialWakes) != 1 {
		return fmt.Errorf("sequence-two: initial wakes=%#v error=%v", initialWakes, err)
	}
	checkpointID := initialWakes[0].CheckpointID
	wakeID := checkpointID + ":wake:main:2"
	for _, mutation := range []struct {
		field string
		value string
	}{
		{field: "wake_sequence", value: "2"},
		{field: "wake_id", value: wakeID},
		{field: "client_submit_id", value: "tutti-execution-wake:" + wakeID},
		{field: "target_kind", value: "reviewer"},
	} {
		if err := driver.CorruptWakeIdentity(
			ctx, fixture.WorkspaceID, issueID, mutation.field, mutation.value,
		); err != nil {
			return fmt.Errorf(
				"sequence-two: corrupt %s error=%w", mutation.field, err,
			)
		}
	}
	beforeCalls := driver.WakeDeliveryCallCount()
	if err := driver.StartupRecoverWakes(
		ctx, fixture.WorkspaceID, "identity-owner-target-kind-sequence-two",
	); err == nil {
		return fmt.Errorf("sequence-two: StartupRecoverWakes() error=nil, want integrity")
	}
	wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(wakes) != 1 || wakes[0].Status != "failed" {
		return fmt.Errorf("sequence-two: corrupted wake=%#v error=%v", wakes, err)
	}
	if driver.WakeDeliveryCallCount() != beforeCalls {
		return fmt.Errorf("sequence-two: corrupted identity reached SendInput")
	}
	return nil
}

func runMainWakeRecoveryPreservesPreparedReviewerWake(
	ctx context.Context,
	driver Driver,
) error {
	fixture := wakeFixture("reviewer-owned")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error=%w", err)
	}
	if err := driver.SeedPreparedReviewerWake(
		ctx, fixture.WorkspaceID, issueID,
	); err != nil {
		return fmt.Errorf("SeedPreparedReviewerWake() error=%w", err)
	}
	if err := driver.RecoverWakes(
		ctx, fixture.WorkspaceID, "main-worker-owner",
	); err != nil {
		return fmt.Errorf("RecoverWakes() error=%w", err)
	}
	wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(wakes) != 2 {
		return fmt.Errorf("ListWakes()=%#v error=%v, want main and reviewer", wakes, err)
	}
	statuses := make(map[string]string, len(wakes))
	for _, wake := range wakes {
		statuses[wake.TargetKind] = wake.Status
	}
	if statuses["main"] != "dispatched" {
		return fmt.Errorf("main wake status=%q, want dispatched", statuses["main"])
	}
	if statuses["reviewer"] != "prepared" {
		return fmt.Errorf(
			"reviewer wake status=%q, want untouched prepared",
			statuses["reviewer"],
		)
	}
	if driver.WakeDeliveryCallCount() != 1 {
		return fmt.Errorf(
			"main delivery calls=%d, want reviewer excluded",
			driver.WakeDeliveryCallCount(),
		)
	}
	return nil
}
