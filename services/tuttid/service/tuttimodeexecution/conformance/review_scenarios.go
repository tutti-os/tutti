package conformance

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"time"
)

func ReviewCatalog() []Scenario {
	return []Scenario{
		{Name: "GoalReviewRequiresExplicitMainCompletion", run: runGoalReviewRequiresExplicitMainCompletion},
		{Name: "GoalReviewCompletionIdentityIsFencedAndIdempotent", run: runGoalReviewCompletionIdentityIsFencedAndIdempotent},
		{Name: "IndependentReviewerIsVerdictOnlyAndRecoverable", run: runIndependentReviewerIsVerdictOnlyAndRecoverable},
		{Name: "ReviewerRecoveryFencesLeasesAndConcurrentClaims", run: runReviewerRecoveryFencesLeasesAndConcurrentClaims},
		{Name: "IndependentVerdictIsAdvisory", run: runIndependentVerdictIsAdvisory},
		{Name: "GoalReviewSideEffectsAreAtomicAndDeduped", run: runGoalReviewSideEffectsAreAtomicAndDeduped},
		{Name: "ReviewerFailureReturnsControlToMain", run: runReviewerFailureReturnsControlToMain},
		{Name: "ReviewerTurnWithoutVerdictFailsClosed", run: runReviewerTurnWithoutVerdictFailsClosed},
		{Name: "ReviewerFastVerdictBindsPreparedTurnAtomically", run: runReviewerFastVerdictBindsPreparedTurnAtomically},
		{Name: "ReviewerSettledBeforeDispatchBindFailsClosed", run: runReviewerSettledBeforeDispatchBindFailsClosed},
		{Name: "IndependentReviewFallbackRequiresExplicitAuditedAction", run: runIndependentReviewFallbackRequiresExplicitAuditedAction},
		{Name: "GoalReviewWaitsForSettlementBacklog", run: runGoalReviewWaitsForSettlementBacklog},
	}
}

func runReviewerFastVerdictBindsPreparedTurnAtomically(
	ctx context.Context,
	driver Driver,
) error {
	fixture, issueID, before, err := reachGoalReview(
		ctx, driver, "fast-verdict", "independent", "review-target",
	)
	if err != nil {
		return err
	}
	if len(before.Reviews) != 1 || before.Reviews[0].Status != "prepared" {
		return fmt.Errorf("prepared fast-verdict review = %#v", before.Reviews)
	}
	active := activeCheckpoint(before)
	review := before.Reviews[0]
	driver.SubmitReviewerVerdictOnNextSend(ReviewerVerdictInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		ReviewID: review.ReviewID, CheckpointID: active.CheckpointID,
		ExpectedGraphRevision: before.Execution.GraphRevision,
		RequestID:             "fast-verdict-1", Verdict: "goal_satisfied",
		Summary: "The exact acceptance evidence is complete.",
	})
	if err := driver.RecoverReviewers(
		ctx, fixture.WorkspaceID, "review-owner-fast",
	); err != nil {
		return fmt.Errorf("RecoverReviewers(fast verdict) error = %w", err)
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(after.Reviews) != 1 {
		return fmt.Errorf("fast verdict snapshot = %#v error=%v", after, err)
	}
	wakes, wakeErr := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	if after.Reviews[0].Status != "submitted" ||
		after.Reviews[0].TurnID == "" ||
		after.Reviews[0].Verdict != "goal_satisfied" ||
		wakeErr != nil || countPreparedMainWakesForCheckpoint(
		wakes, active.CheckpointID,
	) != 1 {
		return fmt.Errorf(
			"fast verdict did not bind atomically: snapshot=%#v wakes=%#v error=%v",
			after, wakes, wakeErr,
		)
	}
	if err := driver.SettleReviewerTurnWithoutVerdict(
		ctx, fixture.WorkspaceID, after.Reviews[0].SessionID,
		after.Reviews[0].TurnID, "late canonical settlement",
	); err != nil {
		return fmt.Errorf("submitted verdict settlement replay error = %w", err)
	}
	replayed, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || !reflect.DeepEqual(replayed, after) {
		return fmt.Errorf(
			"submitted verdict changed on settlement: before=%#v after=%#v error=%v",
			after, replayed, err,
		)
	}
	return nil
}

func runReviewerSettledBeforeDispatchBindFailsClosed(
	ctx context.Context,
	driver Driver,
) error {
	fixture, issueID, before, err := reachGoalReview(
		ctx, driver, "settled-before-bind", "independent", "review-target",
	)
	if err != nil {
		return err
	}
	driver.SettleReviewerOnNextSend()
	if err := driver.RecoverReviewers(
		ctx, fixture.WorkspaceID, "review-owner-settled",
	); err != nil {
		return fmt.Errorf("RecoverReviewers(settled before bind) error = %w", err)
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(after.Reviews) != 1 {
		return fmt.Errorf("settled-before-bind snapshot = %#v error=%v", after, err)
	}
	wakes, wakeErr := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
	active := activeCheckpoint(after)
	if after.Reviews[0].Status != "failed" ||
		after.Reviews[0].TurnID == "" ||
		wakeErr != nil || countPreparedMainWakesForCheckpoint(
		wakes, active.CheckpointID,
	) != 1 ||
		before.Execution.Status != after.Execution.Status {
		return fmt.Errorf(
			"settled-before-bind did not fail closed: snapshot=%#v wakes=%#v error=%v",
			after, wakes, wakeErr,
		)
	}
	return nil
}

func countPreparedMainWakesForCheckpoint(
	wakes []Wake,
	checkpointID string,
) int {
	count := 0
	for _, wake := range wakes {
		if wake.CheckpointID == checkpointID &&
			wake.TargetKind == "main" &&
			wake.Status == "prepared" {
			count++
		}
	}
	return count
}

func runGoalReviewRequiresExplicitMainCompletion(ctx context.Context, driver Driver) error {
	fixture, issueID, snapshot, err := reachGoalReview(ctx, driver, "self-explicit", "self", "")
	if err != nil {
		return err
	}
	if snapshot.Execution.Status != "pending_goal_review" ||
		!snapshot.Execution.CompletedAt.IsZero() ||
		snapshot.Execution.ReviewMode != "self" {
		return fmt.Errorf("all-terminal execution = %#v, want incomplete self Goal Review", snapshot.Execution)
	}
	active := activeCheckpoint(snapshot)
	before := snapshot
	if _, err := driver.Acknowledge(ctx, AcknowledgeInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID: fixture.SourceSessionID, CheckpointID: active.CheckpointID,
		ExpectedGraphRevision: snapshot.Execution.GraphRevision, RequestID: "ack-goal-review",
	}); err == nil {
		return fmt.Errorf("generic Goal Review acknowledge error = nil")
	}
	after, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if snapshotErr != nil || !reflect.DeepEqual(after, before) {
		return fmt.Errorf("goal review acknowledge mutated state: before=%#v after=%#v error=%v", before, after, snapshotErr)
	}
	completed, err := driver.Complete(ctx, CompleteInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID: fixture.SourceSessionID, CheckpointID: active.CheckpointID,
		ExpectedGraphRevision: snapshot.Execution.GraphRevision,
		RequestID:             "complete-self-explicit", Decision: "goal_satisfied",
	})
	if err != nil {
		return fmt.Errorf("Complete(goal_satisfied) error = %w", err)
	}
	if completed.Replayed || completed.Decision != "goal_satisfied" {
		return fmt.Errorf("Complete(goal_satisfied) = %#v", completed)
	}
	after, err = driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || after.Execution.Status != "completed" ||
		after.Execution.CompletedAt.IsZero() || activeCheckpoint(after).CheckpointID != "" {
		return fmt.Errorf("completed Goal Review = %#v error=%v", after, err)
	}
	return nil
}

func runGoalReviewCompletionIdentityIsFencedAndIdempotent(ctx context.Context, driver Driver) error {
	fixture, issueID, snapshot, err := reachGoalReview(ctx, driver, "complete-fences", "self", "")
	if err != nil {
		return err
	}
	active := activeCheckpoint(snapshot)
	base := CompleteInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID: fixture.SourceSessionID, CheckpointID: active.CheckpointID,
		ExpectedGraphRevision: snapshot.Execution.GraphRevision,
		RequestID:             "complete-fenced", Decision: "goal_satisfied",
	}
	for _, mutation := range []func(*CompleteInput){
		func(input *CompleteInput) { input.SourceSessionID = "wrong-source"; input.RequestID = "wrong-source" },
		func(input *CompleteInput) {
			input.CheckpointID = "stale-checkpoint"
			input.RequestID = "stale-checkpoint"
		},
		func(input *CompleteInput) { input.ExpectedGraphRevision++; input.RequestID = "stale-revision" },
		func(input *CompleteInput) { input.Decision = "more_work_required"; input.RequestID = "wrong-decision" },
	} {
		candidate := base
		mutation(&candidate)
		before, _ := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if _, err := driver.CompleteReplica(ctx, candidate); err == nil {
			return fmt.Errorf("invalid Complete(%#v) error = nil", candidate)
		}
		after, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if snapshotErr != nil || !reflect.DeepEqual(after, before) {
			return fmt.Errorf("rejected Complete mutated state: before=%#v after=%#v error=%v", before, after, snapshotErr)
		}
	}
	first, err := driver.Complete(ctx, base)
	if err != nil {
		return err
	}
	replay, err := driver.CompleteReplica(ctx, base)
	wantReplay := first
	wantReplay.Replayed = true
	if err != nil || !reflect.DeepEqual(replay, wantReplay) {
		return fmt.Errorf("complete replay = %#v, want %#v error=%v", replay, wantReplay, err)
	}
	conflict := base
	conflict.DisagreementReason = "different payload"
	if _, err := driver.CompleteReplica(ctx, conflict); err == nil {
		return fmt.Errorf("conflicting Complete replay error = nil")
	}
	return nil
}

func runIndependentReviewerIsVerdictOnlyAndRecoverable(ctx context.Context, driver Driver) error {
	fixture, issueID, snapshot, err := reachGoalReview(
		ctx, driver, "independent-recovery", "independent", "review-target",
	)
	if err != nil {
		return err
	}
	if snapshot.Execution.ReviewMode != "independent" ||
		snapshot.Execution.ReviewAgentTargetID != "review-target" {
		return fmt.Errorf("materialized review configuration = %#v", snapshot.Execution)
	}
	if len(snapshot.Reviews) != 1 {
		return fmt.Errorf("prepared independent reviews = %#v, want exactly one", snapshot.Reviews)
	}
	prepared := snapshot.Reviews[0]
	if prepared.ReviewID == "" || prepared.SessionID == "" ||
		prepared.ClientSubmitID == "" || prepared.SessionID == fixture.SourceSessionID {
		return fmt.Errorf("prepared deterministic dedicated review identity = %#v", prepared)
	}
	driver.FailNextReviewerAfterCanonical()
	if err := driver.RecoverReviewers(ctx, fixture.WorkspaceID, "review-owner-a"); err == nil {
		return fmt.Errorf("ambiguous reviewer delivery error = nil")
	}
	if driver.ReviewerCanonicalTurnCount() != 1 {
		return fmt.Errorf("canonical reviewer turns = %d, want 1", driver.ReviewerCanonicalTurnCount())
	}
	canonicalSessionID, canonicalTurnID, found := driver.ReviewerCanonicalIdentity(prepared.ClientSubmitID)
	if !found || canonicalSessionID == "" || canonicalTurnID == "" ||
		canonicalSessionID != prepared.SessionID {
		return fmt.Errorf(
			"canonical reviewer identity after response loss = session:%q turn:%q found:%v, prepared=%#v",
			canonicalSessionID, canonicalTurnID, found, prepared,
		)
	}
	afterLoss, lossErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if lossErr != nil || len(afterLoss.Reviews) != 1 ||
		afterLoss.Reviews[0].ReviewID != prepared.ReviewID ||
		afterLoss.Reviews[0].SessionID != prepared.SessionID ||
		afterLoss.Reviews[0].ClientSubmitID != prepared.ClientSubmitID {
		return fmt.Errorf("review identity changed after response loss: %#v error=%v", afterLoss.Reviews, lossErr)
	}
	if err := driver.StartupRecoverReviewers(ctx, fixture.WorkspaceID, "review-owner-b"); err != nil {
		return fmt.Errorf("StartupRecoverReviewers() error = %w", err)
	}
	if driver.ReviewerCanonicalTurnCount() != 1 {
		return fmt.Errorf("review recovery duplicated canonical Turn: %d", driver.ReviewerCanonicalTurnCount())
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(after.Reviews) != 1 {
		return fmt.Errorf("durable independent review = %#v error=%v", after.Reviews, err)
	}
	review := after.Reviews[0]
	if review.ReviewID == "" || review.ClientSubmitID == "" ||
		review.SessionID == "" || review.TurnID == "" ||
		review.Status != "dispatched" || review.AgentTargetID != "review-target" {
		return fmt.Errorf("review identity = %#v", review)
	}
	if review.ReviewID != prepared.ReviewID ||
		review.SessionID != prepared.SessionID ||
		review.ClientSubmitID != prepared.ClientSubmitID ||
		review.SessionID != canonicalSessionID ||
		review.TurnID != canonicalTurnID {
		return fmt.Errorf(
			"response-loss/startup review identity drifted: prepared=%#v canonical=%q/%q recovered=%#v",
			prepared, canonicalSessionID, canonicalTurnID, review,
		)
	}
	if review.ReviewID == review.SessionID ||
		review.ReviewID == review.ClientSubmitID ||
		review.SessionID == review.ClientSubmitID {
		return fmt.Errorf("review, dedicated session, and submit identities must be distinct: %#v", review)
	}
	if got := driver.ReviewerCapabilities(); !reflect.DeepEqual(got, []string{
		"tutti-goal-review.goal-review.verdict",
	}) {
		return fmt.Errorf("reviewer capabilities = %#v, want verdict-only provider", got)
	}
	return nil
}

func runReviewerRecoveryFencesLeasesAndConcurrentClaims(ctx context.Context, driver Driver) error {
	busyFixture, busyIssueID, busySnapshot, err := reachGoalReview(
		ctx, driver, "reviewer-busy", "independent", "review-target",
	)
	if err != nil {
		return err
	}
	if len(busySnapshot.Reviews) != 1 ||
		busySnapshot.Reviews[0].Status != "prepared" ||
		busySnapshot.Reviews[0].SessionID == "" {
		return fmt.Errorf("busy review is not prepared/claimable: %#v", busySnapshot.Reviews)
	}
	busyReview := busySnapshot.Reviews[0]
	launchesBeforeBusy := driver.ReviewerLaunchCallCount()
	turnsBeforeBusy := driver.ReviewerCanonicalTurnCount()
	driver.SetReviewerSessionBusy(busyReview.SessionID, true)
	if err := driver.RecoverReviewers(ctx, busyFixture.WorkspaceID, "review-owner-busy"); err != nil {
		return fmt.Errorf("busy reviewer recovery error = %w", err)
	}
	afterBusy, snapshotErr := driver.GetSnapshot(ctx, busyFixture.WorkspaceID, busyIssueID)
	if snapshotErr != nil || !reflect.DeepEqual(afterBusy, busySnapshot) ||
		driver.ReviewerLaunchCallCount() != launchesBeforeBusy ||
		driver.ReviewerCanonicalTurnCount() != turnsBeforeBusy {
		return fmt.Errorf(
			"busy dedicated reviewer changed delivery/state: before=%#v after=%#v launches=%d/%d turns=%d/%d error=%v",
			busySnapshot, afterBusy,
			launchesBeforeBusy, driver.ReviewerLaunchCallCount(),
			turnsBeforeBusy, driver.ReviewerCanonicalTurnCount(),
			snapshotErr,
		)
	}
	driver.SetReviewerSessionBusy(busyReview.SessionID, false)
	if err := driver.RecoverReviewers(ctx, busyFixture.WorkspaceID, "review-owner-unblocked"); err != nil {
		return fmt.Errorf("unblocked reviewer recovery error = %w", err)
	}
	if driver.ReviewerLaunchCallCount() != launchesBeforeBusy+1 ||
		driver.ReviewerCanonicalTurnCount() != turnsBeforeBusy+1 {
		return fmt.Errorf(
			"unblocked dedicated reviewer delivery = launches:%d turns:%d, want %d/%d",
			driver.ReviewerLaunchCallCount(), driver.ReviewerCanonicalTurnCount(),
			launchesBeforeBusy+1, turnsBeforeBusy+1,
		)
	}

	fixture, issueID, _, err := reachGoalReview(
		ctx, driver, "reviewer-lease", "independent", "review-target",
	)
	if err != nil {
		return err
	}
	prepared, _ := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if len(prepared.Reviews) != 1 {
		return fmt.Errorf("prepared reviews = %#v", prepared.Reviews)
	}
	review := prepared.Reviews[0]
	launchesBeforeLease := driver.ReviewerLaunchCallCount()
	turnsBeforeLease := driver.ReviewerCanonicalTurnCount()
	claimed, err := driver.ClaimReviewer(
		ctx, fixture.WorkspaceID, review.ReviewID, "review-owner-a", time.Minute,
	)
	if err != nil || !claimed {
		return fmt.Errorf("ClaimReviewer(owner-a) = %v error=%v", claimed, err)
	}
	if err := driver.StartupRecoverReviewers(ctx, fixture.WorkspaceID, "review-owner-b"); err != nil {
		return fmt.Errorf("active lease startup recovery error = %w", err)
	}
	if driver.ReviewerLaunchCallCount() != launchesBeforeLease ||
		driver.ReviewerCanonicalTurnCount() != turnsBeforeLease {
		return fmt.Errorf("active review lease was stolen: launches=%d", driver.ReviewerLaunchCallCount())
	}
	driver.AdvanceClockWithoutRenewal(2 * time.Minute)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, owner := range []string{"review-owner-b", "review-owner-c"} {
		owner := owner
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- driver.StartupRecoverReviewers(ctx, fixture.WorkspaceID, owner)
		}()
	}
	wg.Wait()
	close(results)
	for recoverErr := range results {
		if recoverErr != nil {
			return fmt.Errorf("expired lease recovery error = %w", recoverErr)
		}
	}
	if driver.ReviewerLaunchCallCount() != launchesBeforeLease+1 ||
		driver.ReviewerCanonicalTurnCount() != turnsBeforeLease+1 {
		return fmt.Errorf(
			"concurrent expired-lease recovery = launches:%d turns:%d, want %d/%d",
			driver.ReviewerLaunchCallCount(), driver.ReviewerCanonicalTurnCount(),
			launchesBeforeLease+1, turnsBeforeLease+1,
		)
	}
	return nil
}

func runIndependentVerdictIsAdvisory(ctx context.Context, driver Driver) error {
	for _, verdict := range []string{"goal_satisfied", "more_work_required", "inconclusive"} {
		fixture, issueID, _, err := reachGoalReview(
			ctx, driver, "verdict-"+verdict, "independent", "review-target",
		)
		if err != nil {
			return err
		}
		if err := driver.RecoverReviewers(ctx, fixture.WorkspaceID, "review-owner"); err != nil {
			return err
		}
		snapshot, _ := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		review := snapshot.Reviews[0]
		for _, command := range []string{"schedule", "acknowledge", "complete"} {
			beforeReject := snapshot
			switch command {
			case "schedule":
				_, err = driver.ScheduleReplica(ctx, ScheduleInput{
					WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
					SourceSessionID: review.SessionID, CheckpointID: review.CheckpointID,
					ExpectedGraphRevision: snapshot.Execution.GraphRevision,
					TaskIDs:               []string{"task-a"}, RequestID: "reviewer-schedule-" + verdict,
				})
			case "acknowledge":
				_, err = driver.AcknowledgeReplica(ctx, AcknowledgeInput{
					WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
					SourceSessionID: review.SessionID, CheckpointID: review.CheckpointID,
					ExpectedGraphRevision: snapshot.Execution.GraphRevision,
					RequestID:             "reviewer-ack-" + verdict,
				})
			case "complete":
				_, err = driver.CompleteReplica(ctx, CompleteInput{
					WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
					SourceSessionID: review.SessionID, CheckpointID: review.CheckpointID,
					ExpectedGraphRevision: snapshot.Execution.GraphRevision,
					RequestID:             "reviewer-complete-" + verdict, Decision: "goal_satisfied",
				})
			}
			if err == nil {
				return fmt.Errorf("reviewer %s error = nil", command)
			}
			afterReject, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
			if snapshotErr != nil || !reflect.DeepEqual(afterReject, beforeReject) {
				return fmt.Errorf("reviewer %s mutated state: before=%#v after=%#v error=%v", command, beforeReject, afterReject, snapshotErr)
			}
		}
		input := ReviewerVerdictInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			ReviewID: review.ReviewID, ReviewSessionID: review.SessionID,
			ReviewTurnID: review.TurnID, CheckpointID: review.CheckpointID,
			ExpectedGraphRevision: snapshot.Execution.GraphRevision,
			RequestID:             "verdict-" + verdict, Verdict: verdict, Summary: "structured evidence",
		}
		for _, mutation := range []func(*ReviewerVerdictInput){
			func(candidate *ReviewerVerdictInput) {
				candidate.ReviewID = "wrong-review"
				candidate.RequestID += "-wrong-review"
			},
			func(candidate *ReviewerVerdictInput) {
				candidate.ReviewSessionID = "wrong-review-session"
				candidate.RequestID += "-wrong-session"
			},
			func(candidate *ReviewerVerdictInput) {
				candidate.ReviewTurnID = "wrong-review-turn"
				candidate.RequestID += "-wrong-turn"
			},
			func(candidate *ReviewerVerdictInput) {
				candidate.ReviewSessionID = fixture.SourceSessionID
				candidate.ReviewTurnID = "source-turn"
				candidate.RequestID += "-source-main"
			},
			func(candidate *ReviewerVerdictInput) {
				candidate.CheckpointID = "stale-checkpoint"
				candidate.RequestID += "-stale-checkpoint"
			},
			func(candidate *ReviewerVerdictInput) {
				candidate.ExpectedGraphRevision++
				candidate.RequestID += "-stale-revision"
			},
			func(candidate *ReviewerVerdictInput) {
				candidate.Verdict = "looks_good"
				candidate.RequestID += "-invalid-verdict"
			},
			func(candidate *ReviewerVerdictInput) {
				candidate.Summary = "   "
				candidate.RequestID += "-blank-summary"
			},
		} {
			candidate := input
			mutation(&candidate)
			beforeReject := snapshot
			if _, err := driver.SubmitReviewerVerdictReplica(ctx, candidate); err == nil {
				return fmt.Errorf("%s invalid reviewer identity/fence error = nil: %#v", verdict, candidate)
			}
			afterReject, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
			if snapshotErr != nil || !reflect.DeepEqual(afterReject, beforeReject) {
				return fmt.Errorf("%s rejected verdict mutated state: before=%#v after=%#v error=%v", verdict, beforeReject, afterReject, snapshotErr)
			}
		}
		submitted, err := driver.SubmitReviewerVerdict(ctx, input)
		if err != nil || submitted.Verdict != verdict || submitted.Replayed {
			return fmt.Errorf("%s verdict = %#v error=%v", verdict, submitted, err)
		}
		replay, err := driver.SubmitReviewerVerdictReplica(ctx, input)
		wantReplay := submitted
		wantReplay.Replayed = true
		if err != nil || !reflect.DeepEqual(replay, wantReplay) {
			return fmt.Errorf("%s verdict replay = %#v, want %#v error=%v", verdict, replay, wantReplay, err)
		}
		conflict := input
		conflict.Summary = "different evidence"
		if _, err := driver.SubmitReviewerVerdictReplica(ctx, conflict); err == nil {
			return fmt.Errorf("%s conflicting verdict replay error = nil", verdict)
		}
		afterVerdict, _ := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if afterVerdict.Execution.Status != "pending_goal_review" ||
			!afterVerdict.Execution.CompletedAt.IsZero() {
			return fmt.Errorf("%s reviewer verdict became authoritative: %#v", verdict, afterVerdict.Execution)
		}
		wakes, wakeErr := driver.ListWakes(ctx, fixture.WorkspaceID, issueID)
		if wakeErr != nil {
			return wakeErr
		}
		if err := assertExactGoalReviewMainWake(
			wakes, review.CheckpointID, fixture.SourceSessionID, "prepared",
		); err != nil {
			return fmt.Errorf("%s verdict wake: %w", verdict, err)
		}
		active := activeCheckpoint(afterVerdict)
		complete := CompleteInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			SourceSessionID: fixture.SourceSessionID, CheckpointID: active.CheckpointID,
			ExpectedGraphRevision: afterVerdict.Execution.GraphRevision,
			RequestID:             "complete-" + verdict, Decision: "goal_satisfied",
		}
		_, completeErr := driver.Complete(ctx, complete)
		if verdict == "goal_satisfied" && completeErr != nil {
			return fmt.Errorf("positive main Complete error = %w", completeErr)
		}
		if verdict == "goal_satisfied" {
			completed, _ := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
			if completed.Execution.Status != "completed" {
				return fmt.Errorf("positive main Complete status = %q", completed.Execution.Status)
			}
			continue
		}
		if verdict != "goal_satisfied" {
			beforeReject := afterVerdict
			for _, reason := range []string{"", "   "} {
				complete.DisagreementReason = reason
				if _, err := driver.Complete(ctx, complete); err == nil {
					return fmt.Errorf("%s Complete with blank disagreement reason error = nil", verdict)
				}
				afterReject, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
				if snapshotErr != nil || !reflect.DeepEqual(afterReject, beforeReject) {
					return fmt.Errorf("%s rejection mutated state: before=%#v after=%#v error=%v", verdict, beforeReject, afterReject, snapshotErr)
				}
			}
			complete.DisagreementReason = "Main evidence resolves the review concern"
		}
		if _, err := driver.Complete(ctx, complete); err != nil {
			return fmt.Errorf("%s main Complete error = %w", verdict, err)
		}
		completed, _ := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if completed.Execution.Status != "completed" {
			return fmt.Errorf("%s main Complete status = %q", verdict, completed.Execution.Status)
		}
		if verdict != "goal_satisfied" {
			found := false
			for _, entry := range completed.Audit {
				if entry.Kind == "review_disagreement" &&
					entry.ActorID == fixture.SourceSessionID &&
					strings.TrimSpace(entry.Reason) != "" &&
					entry.ReviewID == review.ReviewID {
					found = true
				}
			}
			if !found {
				return fmt.Errorf("%s audited disagreement = %#v", verdict, completed.Audit)
			}
		}
	}
	return nil
}

func reachGoalReview(
	ctx context.Context,
	driver Driver,
	suffix string,
	reviewMode string,
	reviewAgentTargetID string,
) (AcceptPlanInput, string, Snapshot, error) {
	fixture := settlementFixture("goal-review-" + suffix)
	fixture.Tasks = []Task{
		schedulableTask("task-a", "/tmp/tutti-contract-task-a-"+suffix),
		schedulableTask("task-b", "/tmp/tutti-contract-task-b-"+suffix),
	}
	fixture.ReviewMode = reviewMode
	fixture.ReviewAgentTargetID = reviewAgentTargetID
	issueID, scheduled, err := acceptAndScheduleSettlement(
		ctx, driver, fixture, []string{"task-a", "task-b"},
	)
	if err != nil {
		return fixture, "", Snapshot{}, err
	}
	for index, taskID := range []string{"task-a", "task-b"} {
		if err := driver.SettleRun(ctx, SettleRunInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			TaskID: taskID, RunID: scheduled.RunIDs[index], Status: "completed",
		}); err != nil {
			return fixture, "", Snapshot{}, err
		}
	}
	snapshot, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fixture, "", Snapshot{}, err
	}
	for {
		active := activeCheckpoint(snapshot)
		if active.Kind == "all_tasks_terminal" {
			break
		}
		if active.CheckpointID == "" {
			return fixture, "", Snapshot{}, fmt.Errorf("no active checkpoint before Goal Review: %#v", snapshot.Checkpoints)
		}
		if _, err := driver.Acknowledge(ctx, AcknowledgeInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
			SourceSessionID: fixture.SourceSessionID, CheckpointID: active.CheckpointID,
			ExpectedGraphRevision: snapshot.Execution.GraphRevision,
			RequestID:             "ack-" + suffix + "-" + active.CheckpointID,
		}); err != nil {
			return fixture, "", Snapshot{}, err
		}
		snapshot, err = driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if err != nil {
			return fixture, "", Snapshot{}, err
		}
	}
	return fixture, issueID, snapshot, nil
}

func activeCheckpoint(snapshot Snapshot) Checkpoint {
	for _, checkpoint := range snapshot.Checkpoints {
		if checkpoint.Status == "active" {
			return checkpoint
		}
	}
	return Checkpoint{}
}

func assertExactGoalReviewMainWake(
	wakes []Wake,
	checkpointID string,
	sourceSessionID string,
	status string,
) error {
	matching := wakesForCheckpoint(wakes, checkpointID)
	if len(matching) != 1 {
		return fmt.Errorf("wakes = %#v, want exactly one for checkpoint %q", wakes, checkpointID)
	}
	wake := matching[0]
	expectedWakeID := checkpointID + ":wake:main:1"
	expectedExecutionID := ""
	if checkpointMarker := strings.Index(checkpointID, ":checkpoint:"); checkpointMarker > 0 {
		expectedExecutionID = checkpointID[:checkpointMarker]
	}
	if checkpointID == "" || sourceSessionID == "" || expectedExecutionID == "" ||
		wake.ExecutionID != expectedExecutionID ||
		wake.CheckpointID != checkpointID ||
		wake.TargetKind != "main" ||
		wake.WakeSequence != 1 ||
		wake.TargetSessionID != sourceSessionID ||
		wake.WakeID != expectedWakeID ||
		wake.ClientSubmitID != "tutti-execution-wake:"+expectedWakeID ||
		wake.Status != status {
		return fmt.Errorf(
			"wake = %#v, want execution=%q checkpoint=%q target=main/%q sequence=1 id=%q submit=%q status=%q",
			wake, expectedExecutionID, checkpointID, sourceSessionID, expectedWakeID,
			"tutti-execution-wake:"+expectedWakeID, status,
		)
	}
	switch status {
	case "prepared":
		if wake.CanonicalSessionID != "" || wake.CanonicalTurnID != "" {
			return fmt.Errorf("prepared wake already has canonical identity: %#v", wake)
		}
	case "dispatched":
		if wake.CanonicalSessionID != sourceSessionID || wake.CanonicalTurnID == "" {
			return fmt.Errorf("dispatched wake canonical identity = %#v", wake)
		}
	}
	return nil
}

func wakesForCheckpoint(wakes []Wake, checkpointID string) []Wake {
	var matching []Wake
	for _, wake := range wakes {
		if wake.CheckpointID == checkpointID {
			matching = append(matching, wake)
		}
	}
	return matching
}
