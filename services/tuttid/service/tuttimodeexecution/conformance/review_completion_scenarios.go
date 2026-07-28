package conformance

import (
	"context"
	"fmt"
	"reflect"
	"strings"
)

func runGoalReviewSideEffectsAreAtomicAndDeduped(ctx context.Context, driver Driver) error {
	for _, failurePoint := range []string{"checkpoint", "wake", "audit"} {
		fixture, issueID, snapshot, err := reachGoalReview(
			ctx, driver, "complete-rollback-"+failurePoint, "self", "",
		)
		if err != nil {
			return err
		}
		active := activeCheckpoint(snapshot)
		wakesBefore, wakesErr := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if wakesErr != nil {
			return wakesErr
		}
		driver.FailNextGoalReviewCommit(failurePoint)
		if _, err := driver.Complete(ctx, CompleteInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			SourceSessionID: fixture.SourceSessionID, CheckpointID: active.CheckpointID,
			ExpectedGraphRevision: snapshot.Execution.GraphRevision,
			RequestID:             "complete-rollback-" + failurePoint, Decision: "goal_satisfied",
		}); err == nil {
			return fmt.Errorf("%s injected Complete error = nil", failurePoint)
		}
		after, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		wakesAfter, wakesAfterErr := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if snapshotErr != nil || wakesAfterErr != nil ||
			!reflect.DeepEqual(after, snapshot) ||
			!reflect.DeepEqual(wakesAfter, wakesBefore) {
			return fmt.Errorf(
				"%s Complete failure did not roll back: snapshot=%#v/%#v wakes=%#v/%#v errors=%v/%v",
				failurePoint, snapshot, after, wakesBefore, wakesAfter, snapshotErr, wakesAfterErr,
			)
		}
	}

	for _, failurePoint := range []string{"review", "wake", "audit"} {
		fixture, issueID, _, err := reachGoalReview(
			ctx, driver, "verdict-rollback-"+failurePoint, "independent", "review-target",
		)
		if err != nil {
			return err
		}
		if err := driver.RecoverReviewers(ctx, fixture.WorkspaceID, "review-owner-"+failurePoint); err != nil {
			return err
		}
		before, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if snapshotErr != nil || len(before.Reviews) != 1 {
			return fmt.Errorf("%s verdict rollback setup = %#v error=%v", failurePoint, before.Reviews, snapshotErr)
		}
		wakesBefore, wakesErr := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if wakesErr != nil {
			return wakesErr
		}
		review := before.Reviews[0]
		driver.FailNextGoalReviewCommit(failurePoint)
		if _, err := driver.SubmitReviewerVerdict(ctx, ReviewerVerdictInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			ReviewID: review.ReviewID, ReviewSessionID: review.SessionID,
			ReviewTurnID: review.TurnID, CheckpointID: review.CheckpointID,
			ExpectedGraphRevision: before.Execution.GraphRevision,
			RequestID:             "verdict-rollback-" + failurePoint,
			Verdict:               "goal_satisfied", Summary: "verified evidence",
		}); err == nil {
			return fmt.Errorf("%s injected verdict error = nil", failurePoint)
		}
		after, afterErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		wakesAfter, wakesAfterErr := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if afterErr != nil || wakesAfterErr != nil ||
			!reflect.DeepEqual(after, before) ||
			!reflect.DeepEqual(wakesAfter, wakesBefore) {
			return fmt.Errorf(
				"%s verdict failure did not roll back: snapshot=%#v/%#v wakes=%#v/%#v errors=%v/%v",
				failurePoint, before, after, wakesBefore, wakesAfter, afterErr, wakesAfterErr,
			)
		}
	}

	for _, failurePoint := range []string{"mode", "audit", "wake"} {
		fixture, issueID, _, err := reachGoalReview(
			ctx, driver, "fallback-rollback-"+failurePoint, "independent", "review-target",
		)
		if err != nil {
			return err
		}
		driver.FailNextReviewerBeforeCanonical()
		if err := driver.RecoverReviewers(ctx, fixture.WorkspaceID, "review-owner-"+failurePoint); err == nil {
			return fmt.Errorf("%s fallback rollback setup reviewer failure error = nil", failurePoint)
		}
		before, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if snapshotErr != nil || len(before.Reviews) != 1 || before.Reviews[0].Status != "failed" {
			return fmt.Errorf("%s fallback rollback setup = %#v error=%v", failurePoint, before.Reviews, snapshotErr)
		}
		wakesBefore, wakesErr := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if wakesErr != nil {
			return wakesErr
		}
		driver.FailNextGoalReviewCommit(failurePoint)
		if _, err := driver.SwitchReviewToSelf(ctx, SwitchReviewToSelfInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			CheckpointID:          before.Reviews[0].CheckpointID,
			ExpectedGraphRevision: before.Execution.GraphRevision,
			RequestedBy:           "fallback-user",
			RequestID:             "fallback-rollback-" + failurePoint,
			Reason:                "Reviewer is unavailable",
		}); err == nil {
			return fmt.Errorf("%s injected fallback error = nil", failurePoint)
		}
		after, afterErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		wakesAfter, wakesAfterErr := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if afterErr != nil || wakesAfterErr != nil ||
			!reflect.DeepEqual(after, before) ||
			!reflect.DeepEqual(wakesAfter, wakesBefore) {
			return fmt.Errorf(
				"%s fallback failure did not roll back: snapshot=%#v/%#v wakes=%#v/%#v errors=%v/%v",
				failurePoint, before, after, wakesBefore, wakesAfter, afterErr, wakesAfterErr,
			)
		}
	}

	fixture, issueID, _, err := reachGoalReview(
		ctx, driver, "complete-effects", "independent", "review-target",
	)
	if err != nil {
		return err
	}
	if err := driver.RecoverReviewers(ctx, fixture.WorkspaceID, "review-owner"); err != nil {
		return err
	}
	beforeVerdict, _ := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	review := beforeVerdict.Reviews[0]
	complete := CompleteInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID: fixture.SourceSessionID, CheckpointID: review.CheckpointID,
		ExpectedGraphRevision: beforeVerdict.Execution.GraphRevision,
		RequestID:             "complete-effects", Decision: "goal_satisfied",
	}
	if _, err := driver.Complete(ctx, complete); err == nil {
		return fmt.Errorf("complete while independent review is active error = nil")
	}
	if _, err := driver.SubmitReviewerVerdict(ctx, ReviewerVerdictInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		ReviewID: review.ReviewID, ReviewSessionID: review.SessionID,
		ReviewTurnID: review.TurnID, CheckpointID: review.CheckpointID,
		ExpectedGraphRevision: beforeVerdict.Execution.GraphRevision,
		RequestID:             "verdict-effects", Verdict: "goal_satisfied", Summary: "verified",
	}); err != nil {
		return err
	}
	wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	if err := assertExactGoalReviewMainWake(
		wakes, review.CheckpointID, fixture.SourceSessionID, "prepared",
	); err != nil {
		return fmt.Errorf("verdict main wake: %w", err)
	}
	first, err := driver.Complete(ctx, complete)
	if err != nil {
		return err
	}
	completed, _ := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if completed.Execution.Status != "completed" ||
		activeCheckpoint(completed).CheckpointID != "" ||
		len(completed.Reviews) != 1 || completed.Reviews[0].Status != "submitted" ||
		completed.Reviews[0].Verdict != "goal_satisfied" ||
		strings.TrimSpace(completed.Reviews[0].Summary) == "" {
		return fmt.Errorf("completion did not retain review evidence: %#v", completed)
	}
	for _, checkpoint := range completed.Checkpoints {
		if checkpoint.CheckpointID == review.CheckpointID && checkpoint.Status != "resolved" {
			return fmt.Errorf("goal review checkpoint = %#v, want resolved", checkpoint)
		}
	}
	wakes, err = driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	goalReviewWakes := wakesForCheckpoint(wakes, review.CheckpointID)
	if err != nil || len(goalReviewWakes) != 1 ||
		(goalReviewWakes[0].Status != "acknowledged" &&
			goalReviewWakes[0].Status != "canceled") {
		return fmt.Errorf("completed open main wakes = %#v error=%v", wakes, err)
	}
	beforeReplay := completed
	replay, err := driver.CompleteReplica(ctx, complete)
	wantReplay := first
	wantReplay.Replayed = true
	afterReplay, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || snapshotErr != nil || !reflect.DeepEqual(replay, wantReplay) ||
		!reflect.DeepEqual(afterReplay, beforeReplay) {
		return fmt.Errorf("complete replay duplicated effects: result=%#v snapshot=%#v error=%v snapshotError=%v", replay, afterReplay, err, snapshotErr)
	}
	return nil
}

func runReviewerTurnWithoutVerdictFailsClosed(ctx context.Context, driver Driver) error {
	fixture, issueID, _, err := reachGoalReview(
		ctx, driver, "reviewer-no-command", "independent", "review-target",
	)
	if err != nil {
		return err
	}
	if err := driver.RecoverReviewers(ctx, fixture.WorkspaceID, "review-owner"); err != nil {
		return err
	}
	before, _ := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if len(before.Reviews) != 1 {
		return fmt.Errorf("prepared review = %#v", before.Reviews)
	}
	review := before.Reviews[0]
	if err := driver.SettleReviewerTurnWithoutVerdict(
		ctx, fixture.WorkspaceID, review.SessionID, review.TurnID,
		"The evidence says goal_satisfied, or perhaps more_work_required.",
	); err != nil {
		return fmt.Errorf("SettleReviewerTurnWithoutVerdict() error = %w", err)
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(after.Reviews) != 1 ||
		after.Reviews[0].Status != "failed" ||
		strings.TrimSpace(after.Reviews[0].FailureReason) == "" ||
		after.Execution.Status != "pending_goal_review" ||
		!after.Execution.CompletedAt.IsZero() {
		return fmt.Errorf("reviewer Turn without command remained pending: reviews=%#v execution=%#v error=%v", after.Reviews, after.Execution, err)
	}
	if err := driver.SettleReviewerTurnWithoutVerdict(
		ctx, fixture.WorkspaceID, review.SessionID, review.TurnID, "goal_satisfied",
	); err != nil {
		return fmt.Errorf("SettleReviewerTurnWithoutVerdict(replay) error = %w", err)
	}
	wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	if err := assertExactGoalReviewMainWake(
		wakes, review.CheckpointID, fixture.SourceSessionID, "prepared",
	); err != nil {
		return fmt.Errorf("no-verdict main wake: %w", err)
	}
	return nil
}

func runGoalReviewWaitsForSettlementBacklog(ctx context.Context, driver Driver) error {
	fixture := settlementFixture("goal-review-backlog-order")
	fixture.ReviewMode = "independent"
	fixture.ReviewAgentTargetID = "review-target"
	fixture.Tasks = []Task{
		schedulableTask("task-a", "/tmp/tutti-contract-backlog-a"),
		schedulableTask("task-b", "/tmp/tutti-contract-backlog-b"),
		schedulableTask("task-c", "/tmp/tutti-contract-backlog-c"),
	}
	issueID, scheduled, err := acceptAndScheduleSettlement(
		ctx, driver, fixture, []string{"task-a", "task-b", "task-c"},
	)
	if err != nil {
		return err
	}
	for index, outcome := range []string{"completed", "failed", "canceled"} {
		if err := driver.SettleRun(ctx, SettleRunInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			TaskID: fixture.Tasks[index].TaskID, RunID: scheduled.RunIDs[index], Status: outcome,
		}); err != nil {
			return err
		}
	}
	snapshot, _ := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	maxAcknowledgeIterations := len(snapshot.Checkpoints) + len(fixture.Tasks) + 2
	for iteration := 0; activeCheckpoint(snapshot).Kind != "all_tasks_terminal"; iteration++ {
		if iteration >= maxAcknowledgeIterations {
			return fmt.Errorf(
				"settlement backlog did not converge after %d iterations: %#v",
				maxAcknowledgeIterations, snapshot.Checkpoints,
			)
		}
		if activeCheckpoint(snapshot).CheckpointID == "" {
			return fmt.Errorf("settlement backlog has no active checkpoint: %#v", snapshot.Checkpoints)
		}
		if len(snapshot.Reviews) != 0 || driver.ReviewerLaunchCallCount() != 0 {
			return fmt.Errorf("review started before settlement backlog drained: %#v", snapshot)
		}
		wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if err != nil {
			return err
		}
		for _, wake := range wakes {
			if wake.CheckpointID == snapshot.Checkpoints[len(snapshot.Checkpoints)-1].CheckpointID {
				return fmt.Errorf("goal review wake prepared before backlog drained: %#v", wakes)
			}
		}
		active := activeCheckpoint(snapshot)
		if _, err := driver.Acknowledge(ctx, AcknowledgeInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			SourceSessionID: fixture.SourceSessionID, CheckpointID: active.CheckpointID,
			ExpectedGraphRevision: snapshot.Execution.GraphRevision,
			RequestID:             "ack-backlog-" + active.CheckpointID,
		}); err != nil {
			return err
		}
		snapshot, err = driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if err != nil {
			return err
		}
	}
	if snapshot.Execution.Status != "pending_goal_review" || len(snapshot.Reviews) != 1 {
		return fmt.Errorf("drained mixed terminal backlog = status:%q reviews:%#v", snapshot.Execution.Status, snapshot.Reviews)
	}
	if err := driver.RecoverReviewers(ctx, fixture.WorkspaceID, "review-owner-backlog"); err != nil {
		return fmt.Errorf("RecoverReviewers(after backlog) error = %w", err)
	}
	if driver.ReviewerLaunchCallCount() != 1 {
		return fmt.Errorf("reviewer launches after backlog = %d, want 1", driver.ReviewerLaunchCallCount())
	}
	return nil
}

func runReviewerFailureReturnsControlToMain(ctx context.Context, driver Driver) error {
	fixture, issueID, _, err := reachGoalReview(
		ctx, driver, "reviewer-failure", "independent", "review-target",
	)
	if err != nil {
		return err
	}
	driver.FailNextReviewerBeforeCanonical()
	if err := driver.RecoverReviewers(ctx, fixture.WorkspaceID, "review-owner"); err == nil {
		return fmt.Errorf("authoritative reviewer failure error = nil")
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(after.Reviews) != 1 ||
		after.Reviews[0].Status != "failed" ||
		strings.TrimSpace(after.Reviews[0].FailureReason) == "" ||
		after.Execution.Status != "pending_goal_review" ||
		!after.Execution.CompletedAt.IsZero() {
		return fmt.Errorf("reviewer failure = %#v execution=%#v error=%v", after.Reviews, after.Execution, err)
	}
	if err := driver.RecoverWakes(ctx, fixture.WorkspaceID, "main-wake-owner"); err != nil {
		return fmt.Errorf("recover main wake after reviewer failure: %w", err)
	}
	wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	if err := assertExactGoalReviewMainWake(
		wakes, after.Reviews[0].CheckpointID, fixture.SourceSessionID, "dispatched",
	); err != nil {
		return fmt.Errorf("reviewer failure main wake: %w", err)
	}
	if err := driver.RecoverReviewers(ctx, fixture.WorkspaceID, "review-owner-replay"); err != nil {
		return fmt.Errorf("reviewer failure replay error = %w", err)
	}
	replayedWakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || !reflect.DeepEqual(replayedWakes, wakes) {
		return fmt.Errorf("reviewer failure replay duplicated wake: before=%#v after=%#v error=%v", wakes, replayedWakes, err)
	}
	return nil
}

func runIndependentReviewFallbackRequiresExplicitAuditedAction(ctx context.Context, driver Driver) error {
	for _, state := range []string{"nonfailed", "submitted", "self"} {
		mode := "independent"
		target := "review-target"
		if state == "self" {
			mode = "self"
			target = ""
		}
		fixture, issueID, snapshot, err := reachGoalReview(
			ctx, driver, "fallback-reject-"+state, mode, target,
		)
		if err != nil {
			return err
		}
		if state == "submitted" {
			if err := driver.RecoverReviewers(ctx, fixture.WorkspaceID, "review-owner-submitted"); err != nil {
				return err
			}
			snapshot, _ = driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
			review := snapshot.Reviews[0]
			if _, err := driver.SubmitReviewerVerdict(ctx, ReviewerVerdictInput{
				WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
				ReviewID: review.ReviewID, ReviewSessionID: review.SessionID,
				ReviewTurnID: review.TurnID, CheckpointID: review.CheckpointID,
				ExpectedGraphRevision: snapshot.Execution.GraphRevision,
				RequestID:             "fallback-submitted-verdict", Verdict: "inconclusive",
				Summary: "Needs main judgment",
			}); err != nil {
				return err
			}
			snapshot, _ = driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		}
		before := snapshot
		active := activeCheckpoint(snapshot)
		if _, err := driver.SwitchReviewToSelf(ctx, SwitchReviewToSelfInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			CheckpointID:          active.CheckpointID,
			ExpectedGraphRevision: snapshot.Execution.GraphRevision,
			RequestedBy:           "user-reject", RequestID: "fallback-reject-" + state,
			Reason: "Explicit fallback request",
		}); err == nil {
			return fmt.Errorf("%s SwitchReviewToSelf error = nil", state)
		}
		after, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if snapshotErr != nil || !reflect.DeepEqual(after, before) {
			return fmt.Errorf("%s fallback rejection mutated state: before=%#v after=%#v error=%v", state, before, after, snapshotErr)
		}
	}

	fixture, issueID, _, err := reachGoalReview(
		ctx, driver, "explicit-fallback", "independent", "review-target",
	)
	if err != nil {
		return err
	}
	driver.FailNextReviewerBeforeCanonical()
	_ = driver.RecoverReviewers(ctx, fixture.WorkspaceID, "review-owner")
	failed, _ := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if failed.Execution.ReviewMode != "independent" {
		return fmt.Errorf("reviewer failure automatically weakened mode = %q", failed.Execution.ReviewMode)
	}
	active := activeCheckpoint(failed)
	base := SwitchReviewToSelfInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		CheckpointID:          active.CheckpointID,
		ExpectedGraphRevision: failed.Execution.GraphRevision,
		RequestedBy:           "user-1", RequestID: "fallback-explicit",
		Reason: "Reviewer target is unavailable",
	}
	for _, mutation := range []func(*SwitchReviewToSelfInput){
		func(input *SwitchReviewToSelfInput) {
			input.CheckpointID = "stale-checkpoint"
			input.RequestID += "-checkpoint"
		},
		func(input *SwitchReviewToSelfInput) { input.ExpectedGraphRevision++; input.RequestID += "-revision" },
		func(input *SwitchReviewToSelfInput) { input.RequestedBy = ""; input.RequestID += "-actor" },
		func(input *SwitchReviewToSelfInput) { input.Reason = "   "; input.RequestID += "-reason" },
	} {
		candidate := base
		mutation(&candidate)
		beforeReject := failed
		if _, err := driver.SwitchReviewToSelfReplica(ctx, candidate); err == nil {
			return fmt.Errorf("invalid SwitchReviewToSelf(%#v) error = nil", candidate)
		}
		afterReject, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if snapshotErr != nil || !reflect.DeepEqual(afterReject, beforeReject) {
			return fmt.Errorf("fallback rejection mutated state: before=%#v after=%#v error=%v", beforeReject, afterReject, snapshotErr)
		}
	}
	launchesBefore := driver.ReviewerLaunchCallCount()
	input := base
	result, err := driver.SwitchReviewToSelf(ctx, input)
	if err != nil {
		return fmt.Errorf("SwitchReviewToSelf() error = %w", err)
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || after.Execution.ReviewMode != "self" {
		return fmt.Errorf("explicit self fallback = %#v error=%v", after.Execution, err)
	}
	found := false
	for _, entry := range after.Audit {
		if entry.Kind == "review_mode_switched_to_self" &&
			entry.ActorID == input.RequestedBy && entry.Reason == input.Reason {
			found = true
		}
	}
	if !found {
		return fmt.Errorf("fallback audit = %#v", after.Audit)
	}
	failureRetained := false
	for _, entry := range after.Audit {
		if entry.Kind == "review_failed" && entry.ReviewID == result.ReviewID {
			failureRetained = true
		}
	}
	if !failureRetained {
		return fmt.Errorf("fallback lost failed-review audit: %#v", after.Audit)
	}
	wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	if err := assertExactGoalReviewMainWake(
		wakes, active.CheckpointID, fixture.SourceSessionID, "prepared",
	); err != nil {
		return fmt.Errorf("fallback main wake: %w", err)
	}
	if err := driver.RecoverReviewers(ctx, fixture.WorkspaceID, "review-owner-after-fallback"); err != nil {
		return fmt.Errorf("review recovery after fallback error = %w", err)
	}
	if driver.ReviewerLaunchCallCount() != launchesBefore {
		return fmt.Errorf("fallback relaunched reviewer: before=%d after=%d", launchesBefore, driver.ReviewerLaunchCallCount())
	}
	beforeReplay, replaySnapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	wakesBeforeReplay, replayWakesErr := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if replaySnapshotErr != nil || replayWakesErr != nil {
		return fmt.Errorf("read fallback replay baseline: snapshot=%v wakes=%v", replaySnapshotErr, replayWakesErr)
	}
	replay, err := driver.SwitchReviewToSelfReplica(ctx, input)
	wantReplay := result
	wantReplay.Replayed = true
	afterReplay, replaySnapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	wakesAfterReplay, replayWakesErr := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if err != nil || replaySnapshotErr != nil || replayWakesErr != nil ||
		!reflect.DeepEqual(replay, wantReplay) ||
		!reflect.DeepEqual(afterReplay, beforeReplay) ||
		!reflect.DeepEqual(wakesAfterReplay, wakesBeforeReplay) {
		return fmt.Errorf(
			"SwitchReviewToSelf replay changed effects: result=%#v want=%#v snapshots=%#v/%#v wakes=%#v/%#v errors=%v/%v/%v",
			replay, wantReplay, beforeReplay, afterReplay, wakesBeforeReplay, wakesAfterReplay,
			err, replaySnapshotErr, replayWakesErr,
		)
	}
	conflict := input
	conflict.Reason = "different reason"
	if _, err := driver.SwitchReviewToSelfReplica(ctx, conflict); err == nil {
		return fmt.Errorf("SwitchReviewToSelf conflicting replay error = nil")
	}
	crossActor := input
	crossActor.RequestedBy = "user-2"
	if _, err := driver.SwitchReviewToSelfReplica(ctx, crossActor); err == nil {
		return fmt.Errorf("SwitchReviewToSelf cross-actor replay error = nil")
	}
	return nil
}
