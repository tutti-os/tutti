package conformance

import (
	"context"
	"fmt"
	"reflect"
	"strings"
)

func runStartupSuppressesNonRunnableExecutionWakes(
	ctx context.Context,
	driver Driver,
) error {
	for _, status := range []string{"orphaned_source", "completed", "archiving", "archived"} {
		fixture := wakeFixture("suppressed-" + status)
		issueID, err := driver.AcceptPlan(ctx, fixture)
		if err != nil {
			return fmt.Errorf("%s: AcceptPlan() error = %w", status, err)
		}
		if err := driver.SetExecutionStatus(
			ctx, fixture.WorkspaceID, issueID, status,
		); err != nil {
			return fmt.Errorf("%s: SetExecutionStatus() error = %w", status, err)
		}
		beforeCalls := driver.WakeDeliveryCallCount()
		if err := driver.StartupRecoverWakes(
			ctx, fixture.WorkspaceID, "wake-suppressed-"+status,
		); err != nil {
			return fmt.Errorf("%s: StartupRecoverWakes() error = %w", status, err)
		}
		if driver.WakeDeliveryCallCount() != beforeCalls {
			return fmt.Errorf("%s execution dispatched a suppressed wake", status)
		}
		suppressed, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if err != nil || len(suppressed) != 1 ||
			suppressed[0].Status != "canceled" ||
			suppressed[0].LeaseOwner != "" ||
			!suppressed[0].LeaseExpiresAt.IsZero() {
			return fmt.Errorf("%s: suppressed wake=%#v error=%v", status, suppressed, err)
		}
		if err := driver.StartupRecoverWakes(
			ctx, fixture.WorkspaceID, "wake-suppressed-replay-"+status,
		); err != nil {
			return fmt.Errorf("%s: StartupRecoverWakes(replay) error = %w", status, err)
		}
		replayed, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if err != nil || !reflect.DeepEqual(replayed, suppressed) ||
			driver.WakeDeliveryCallCount() != beforeCalls {
			return fmt.Errorf(
				"%s: suppression replay wake=%#v calls=%d error=%v",
				status, replayed, driver.WakeDeliveryCallCount(), err,
			)
		}
	}

	// A settled wake Turn is still an open operation until the fenced
	// checkpoint command acknowledges it. Terminal execution suppression must
	// therefore cancel it just like prepared, leased, and dispatched wakes.
	fixture := wakeFixture("suppressed-turn-settled")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("turn_settled: AcceptPlan() error = %w", err)
	}
	if err := driver.RecoverWakes(
		ctx, fixture.WorkspaceID, "wake-suppressed-turn-settled",
	); err != nil {
		return fmt.Errorf("turn_settled: RecoverWakes() error = %w", err)
	}
	dispatched, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(dispatched) != 1 ||
		dispatched[0].Status != "dispatched" ||
		dispatched[0].CanonicalTurnID == "" {
		return fmt.Errorf("turn_settled: dispatched wake=%#v error=%v", dispatched, err)
	}
	if err := driver.SettleWakeTurn(
		ctx,
		fixture.WorkspaceID,
		fixture.SourceSessionID,
		dispatched[0].CanonicalTurnID,
	); err != nil {
		return fmt.Errorf("turn_settled: SettleWakeTurn() error = %w", err)
	}
	if err := driver.SetExecutionStatus(
		ctx, fixture.WorkspaceID, issueID, "completed",
	); err != nil {
		return fmt.Errorf("turn_settled: SetExecutionStatus() error = %w", err)
	}
	beforeCalls := driver.WakeDeliveryCallCount()
	if err := driver.StartupRecoverWakes(
		ctx, fixture.WorkspaceID, "wake-suppressed-settled-recovery",
	); err != nil {
		return fmt.Errorf("turn_settled: StartupRecoverWakes() error = %w", err)
	}
	suppressed, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(suppressed) != 1 ||
		suppressed[0].Status != "canceled" ||
		suppressed[0].LeaseOwner != "" ||
		!suppressed[0].LeaseExpiresAt.IsZero() ||
		driver.WakeDeliveryCallCount() != beforeCalls {
		return fmt.Errorf(
			"turn_settled: suppressed wake=%#v calls=%d error=%v",
			suppressed, driver.WakeDeliveryCallCount(), err,
		)
	}
	return nil
}

func runWakeDispatchRevalidatesSourceAndPromptEvidence(
	ctx context.Context,
	driver Driver,
) error {
	fixture := wakeFixture("prompt")
	issueID, scheduled, err := acceptAndScheduleSettlement(
		ctx, driver, fixture, []string{"task-a", "task-c"},
	)
	if err != nil {
		return err
	}
	if err := driver.SettleRun(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: scheduled.RunIDs[0], Status: "completed",
	}); err != nil {
		return fmt.Errorf("SettleRun() error = %w", err)
	}
	snapshot, wakes, err := wakeSnapshot(ctx, driver, fixture.WorkspaceID, issueID)
	if err != nil || len(wakes) != 2 {
		return fmt.Errorf("wakeSnapshot() wakes=%#v error=%v", wakes, err)
	}
	var checkpoint Checkpoint
	var wake Wake
	for _, candidate := range snapshot.Checkpoints {
		if candidate.Status == "active" {
			checkpoint = candidate
		}
	}
	for _, candidate := range wakes {
		if candidate.CheckpointID == checkpoint.CheckpointID {
			wake = candidate
		}
	}
	if checkpoint.Kind != "task_settled" || wake.Status != "prepared" {
		return fmt.Errorf("eligible prompt checkpoint/wake=%#v / %#v", checkpoint, wake)
	}
	if err := driver.RecoverWakes(ctx, fixture.WorkspaceID, "wake-prompt"); err != nil {
		return fmt.Errorf("RecoverWakes() error = %w", err)
	}
	deliveries := driver.WakeDeliveries()
	if len(deliveries) != 1 {
		return fmt.Errorf("wake deliveries=%#v, want one", deliveries)
	}
	delivery := deliveries[0]
	for _, evidence := range []string{
		"Issue: " + issueID,
		"Checkpoint: " + checkpoint.CheckpointID,
		"Kind: " + checkpoint.Kind,
		fmt.Sprintf("Graph revision: %d", snapshot.Execution.GraphRevision),
		fmt.Sprintf(
			"tutti plan issue schedule --issue-id %s --checkpoint-id %s --expected-graph-revision %d",
			issueID, checkpoint.CheckpointID, snapshot.Execution.GraphRevision,
		),
		fmt.Sprintf(
			"tutti plan issue acknowledge --issue-id %s --checkpoint-id %s --expected-graph-revision %d",
			issueID, checkpoint.CheckpointID, snapshot.Execution.GraphRevision,
		),
		"does not dispatch a successor automatically",
	} {
		if !strings.Contains(delivery.Prompt, evidence) {
			return fmt.Errorf("wake prompt missing %q:\n%s", evidence, delivery.Prompt)
		}
	}
	if delivery.TargetSessionID != snapshot.Execution.SourceSessionID ||
		delivery.ClientSubmitID != wake.ClientSubmitID {
		return fmt.Errorf("wake delivery target/identity=%#v snapshot=%#v", delivery, snapshot.Execution)
	}

	corruptFixture := wakeFixture("source-mismatch")
	corruptIssueID, err := driver.AcceptPlan(ctx, corruptFixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan(source mismatch) error = %w", err)
	}
	if err := driver.CorruptWakeTargetSession(
		ctx, corruptFixture.WorkspaceID, corruptIssueID, "session-wrong",
	); err != nil {
		return fmt.Errorf("CorruptWakeTargetSession() error = %w", err)
	}
	beforeCalls := driver.WakeDeliveryCallCount()
	if err := driver.RecoverWakes(
		ctx, corruptFixture.WorkspaceID, "wake-source-mismatch",
	); err == nil {
		return fmt.Errorf("RecoverWakes(source mismatch) error=nil, want fail closed")
	}
	corruptWakes, err := driver.ListWakes(
		ctx, corruptFixture.WorkspaceID, corruptIssueID,
	)
	if err != nil || len(corruptWakes) != 1 ||
		corruptWakes[0].Status != "failed" ||
		corruptWakes[0].LeaseOwner != "" ||
		driver.WakeDeliveryCallCount() != beforeCalls {
		return fmt.Errorf(
			"source mismatch wake=%#v calls=%d error=%v",
			corruptWakes, driver.WakeDeliveryCallCount(), err,
		)
	}
	return nil
}

func wakeFixture(suffix string) AcceptPlanInput {
	fixture := scheduleFixture()
	fixture.WorkflowID += "-wake-" + suffix
	fixture.RevisionID += "-wake-" + suffix
	fixture.CheckpointID += "-wake-" + suffix
	return fixture
}

func wakeSnapshot(
	ctx context.Context,
	driver Driver,
	workspaceID string,
	issueID string,
) (Snapshot, []Wake, error) {
	snapshot, err := driver.GetSnapshot(ctx, workspaceID, issueID)
	if err != nil {
		return Snapshot{}, nil, fmt.Errorf("GetSnapshot() error = %w", err)
	}
	wakes, err := driver.ListWakes(ctx, workspaceID, issueID)
	if err != nil {
		return Snapshot{}, nil, fmt.Errorf("ListWakes() error = %w", err)
	}
	return snapshot, wakes, nil
}
