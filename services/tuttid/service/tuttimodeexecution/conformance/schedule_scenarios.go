package conformance

import (
	"context"
	"fmt"
	"reflect"
	"sort"
	"sync"
	"time"
)

func scheduleFixture() AcceptPlanInput {
	return AcceptPlanInput{
		WorkspaceID:     "workspace-materialization",
		WorkflowID:      "workflow-schedule",
		RevisionID:      "revision-schedule",
		CheckpointID:    "review-schedule",
		SourceSessionID: "session-source",
		TopicID:         "default",
		Title:           "Explicit schedule",
		Content:         "Schedule only the tasks chosen by the source Agent.",
		Tasks: []Task{
			schedulableTask("task-a", "/tmp/tutti-contract-task-a"),
			schedulableTask("task-b", "/tmp/tutti-contract-task-b"),
			schedulableTask("task-c", "/tmp/tutti-contract-task-c"),
			{
				TaskID:             "task-d",
				Title:              "Task D",
				Content:            "Blocked by A",
				Status:             "not_started",
				Priority:           "medium",
				AgentTargetID:      "local:codex",
				Model:              "gpt-5.4-codex",
				PermissionModeID:   "full-access",
				ExecutionDirectory: "/tmp/tutti-contract-task-d",
				DependencyTaskIDs:  []string{"task-a"},
				Parallelizable:     true,
			},
			schedulableTask("task-e", "/tmp/tutti-contract-task-e"),
			schedulableTask("task-f", "/tmp/tutti-contract-task-f"),
		},
	}
}

func schedulableTask(taskID string, directory string) Task {
	return Task{
		TaskID:             taskID,
		Title:              "Task " + taskID,
		Content:            "Independent work",
		Status:             "not_started",
		Priority:           "medium",
		AgentTargetID:      "local:codex",
		Model:              "gpt-5.4-codex",
		PermissionModeID:   "full-access",
		ExecutionDirectory: directory,
		Parallelizable:     true,
	}
}

func runSourceSchedulesExactSet(ctx context.Context, driver Driver) error {
	fixture := scheduleFixture()
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	checkpointID := before.Checkpoints[0].CheckpointID
	result, err := driver.Schedule(ctx, ScheduleInput{
		WorkspaceID:           fixture.WorkspaceID,
		IssueID:               issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          checkpointID,
		ExpectedGraphRevision: before.Execution.GraphRevision,
		TaskIDs:               []string{"task-a", "task-c"},
		RequestID:             "schedule-a-c",
	})
	if err != nil {
		return fmt.Errorf("Schedule(A,C) error = %w", err)
	}
	if result.ExecutionID == "" || result.CheckpointID != checkpointID ||
		result.GraphRevision != before.Execution.GraphRevision || result.Replayed {
		return fmt.Errorf("Schedule(A,C) result = %#v", result)
	}
	if len(result.RunIDs) != 2 {
		return fmt.Errorf("Schedule(A,C) run IDs = %#v, want 2", result.RunIDs)
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(after) error = %w", err)
	}
	gotTaskIDs := make([]string, 0, len(after.Runs))
	for _, run := range after.Runs {
		gotTaskIDs = append(gotTaskIDs, run.TaskID)
	}
	sort.Strings(gotTaskIDs)
	if !reflect.DeepEqual(gotTaskIDs, []string{"task-a", "task-c"}) {
		return fmt.Errorf("admitted task IDs = %#v, want exactly A and C", gotTaskIDs)
	}
	if after.Execution.Status != "running" {
		return fmt.Errorf("execution status = %q, want running", after.Execution.Status)
	}
	if len(after.Checkpoints) != 1 || after.Checkpoints[0].Status != "resolved" {
		return fmt.Errorf("checkpoint after schedule = %#v, want resolved", after.Checkpoints)
	}
	if calls := driver.LauncherCallCount(); calls != 2 {
		return fmt.Errorf("launcher calls = %d, want 2", calls)
	}
	return nil
}

func runScheduleRejectsInvalidSetAtomically(ctx context.Context, driver Driver) error {
	testCases := []struct {
		name          string
		id            string
		caller        string
		checkpointID  string
		revisionDelta int64
		taskIDs       []string
	}{
		{name: "wrong caller", id: "wrong-caller", caller: "session-other", taskIDs: []string{"task-a"}},
		{name: "stale checkpoint", id: "stale-checkpoint", checkpointID: "checkpoint-stale", taskIDs: []string{"task-a"}},
		{name: "stale revision", id: "stale-revision", revisionDelta: 1, taskIDs: []string{"task-a"}},
		{name: "invalid dependency", id: "invalid-dependency", taskIDs: []string{"task-d"}},
		{name: "over capacity", id: "over-capacity", taskIDs: []string{"task-a", "task-b", "task-c", "task-e", "task-f"}},
		{name: "duplicate task ID", id: "duplicate-task", taskIDs: []string{"task-a", "task-a"}},
	}
	for _, testCase := range testCases {
		fixture := scheduleFixture()
		fixture.WorkflowID += "-" + testCase.id
		fixture.RevisionID += "-" + testCase.id
		fixture.CheckpointID += "-" + testCase.id
		issueID, err := driver.AcceptPlan(ctx, fixture)
		if err != nil {
			return fmt.Errorf("%s: AcceptPlan() error = %w", testCase.name, err)
		}
		before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if err != nil {
			return fmt.Errorf("%s: GetSnapshot(before) error = %w", testCase.name, err)
		}
		caller := testCase.caller
		if caller == "" {
			caller = fixture.SourceSessionID
		}
		checkpointID := testCase.checkpointID
		if checkpointID == "" {
			checkpointID = before.Checkpoints[0].CheckpointID
		}
		_, err = driver.Schedule(ctx, ScheduleInput{
			WorkspaceID:           fixture.WorkspaceID,
			IssueID:               issueID,
			SourceSessionID:       caller,
			CheckpointID:          checkpointID,
			ExpectedGraphRevision: before.Execution.GraphRevision + testCase.revisionDelta,
			TaskIDs:               testCase.taskIDs,
			RequestID:             "reject-" + testCase.name,
		})
		if err == nil {
			return fmt.Errorf("%s: Schedule() error = nil, want rejection", testCase.name)
		}
		after, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if snapshotErr != nil {
			return fmt.Errorf("%s: GetSnapshot(after) error = %w", testCase.name, snapshotErr)
		}
		if after.RunCount != before.RunCount || !reflect.DeepEqual(after.Tasks, before.Tasks) ||
			!reflect.DeepEqual(after.Checkpoints, before.Checkpoints) ||
			!reflect.DeepEqual(after.Execution, before.Execution) {
			return fmt.Errorf("%s: rejected schedule mutated snapshot: before=%#v after=%#v", testCase.name, before, after)
		}
	}
	return nil
}

func runScheduleRequestIdentityIsIdempotent(ctx context.Context, driver Driver) error {
	fixture := scheduleFixture()
	fixture.WorkflowID += "-idempotent"
	fixture.RevisionID += "-idempotent"
	fixture.CheckpointID += "-idempotent"
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	input := ScheduleInput{
		WorkspaceID:           fixture.WorkspaceID,
		IssueID:               issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          before.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: before.Execution.GraphRevision,
		TaskIDs:               []string{"task-a"},
		RequestID:             "schedule-idempotent",
	}
	first, err := driver.Schedule(ctx, input)
	if err != nil {
		return fmt.Errorf("first Schedule() error = %w", err)
	}
	replay, err := driver.Schedule(ctx, input)
	if err != nil {
		return fmt.Errorf("replayed Schedule() error = %w", err)
	}
	if !replay.Replayed {
		return fmt.Errorf("replayed Schedule() result = %#v, want replayed", replay)
	}
	first.Replayed = true
	if !reflect.DeepEqual(replay, first) {
		return fmt.Errorf("replayed Schedule() = %#v, want %#v", replay, first)
	}
	afterReplay, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(after replay) error = %w", err)
	}
	if afterReplay.RunCount != 1 || driver.LauncherCallCount() != 1 {
		return fmt.Errorf("replay side effects: runs=%d launcher=%d, want 1/1", afterReplay.RunCount, driver.LauncherCallCount())
	}
	conflicting := input
	conflicting.TaskIDs = []string{"task-b"}
	if _, err := driver.Schedule(ctx, conflicting); err == nil {
		return fmt.Errorf("conflicting Schedule() error = nil, want conflict")
	}
	afterConflict, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(after conflict) error = %w", err)
	}
	if !reflect.DeepEqual(afterConflict, afterReplay) || driver.LauncherCallCount() != 1 {
		return fmt.Errorf("conflicting replay mutated state: before=%#v after=%#v launcher=%d", afterReplay, afterConflict, driver.LauncherCallCount())
	}
	return nil
}

func runPreparedLaunchIntentIsRecoverable(ctx context.Context, driver Driver) error {
	fixture := scheduleFixture()
	fixture.WorkflowID += "-launch-recovery"
	fixture.RevisionID += "-launch-recovery"
	fixture.CheckpointID += "-launch-recovery"
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	driver.FailNextLaunch()
	_, err = driver.Schedule(ctx, ScheduleInput{
		WorkspaceID:           fixture.WorkspaceID,
		IssueID:               issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          before.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: before.Execution.GraphRevision,
		TaskIDs:               []string{"task-a"},
		RequestID:             "schedule-launch-recovery",
	})
	if err != nil {
		return fmt.Errorf("Schedule() error = %w", err)
	}
	if calls := driver.LauncherCallCount(); calls != 1 {
		return fmt.Errorf("initial launcher calls = %d, want 1 failed delivery", calls)
	}
	if err := driver.RecoverLaunches(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("RecoverLaunches() error = %w", err)
	}
	if calls := driver.LauncherCallCount(); calls != 2 {
		return fmt.Errorf("recovered launcher calls = %d, want 2", calls)
	}
	afterRecovery, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(afterRecovery.Runs) != 1 {
		return fmt.Errorf("GetSnapshot(after recovery) = %#v, %v", afterRecovery, err)
	}
	wantSubmitID := "issue-run:" + afterRecovery.Runs[0].RunID
	if got := driver.LauncherClientSubmitIDs(); !reflect.DeepEqual(got, []string{wantSubmitID, wantSubmitID}) {
		return fmt.Errorf("delivery client submit IDs = %#v, want identical persisted %q", got, wantSubmitID)
	}
	if got := driver.LauncherCanonicalTurnCount(); got != 1 {
		return fmt.Errorf("canonical turn count = %d, want 1 after response-loss retry", got)
	}
	if err := driver.RecoverLaunches(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("second RecoverLaunches() error = %w", err)
	}
	if calls := driver.LauncherCallCount(); calls != 2 {
		return fmt.Errorf("settled launch intent was redelivered: calls = %d", calls)
	}
	return nil
}

func runActiveRunBudgetReservationRejectsWholeSet(ctx context.Context, driver Driver) error {
	fixture := scheduleFixture()
	fixture.WorkflowID += "-active-budget"
	fixture.RevisionID += "-active-budget"
	fixture.CheckpointID += "-active-budget"
	fixture.BudgetMode = "fixed"
	fixture.TokenLimit = 48_000
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	if err := driver.SeedActiveRun(ctx, fixture.WorkspaceID, issueID, "task-a"); err != nil {
		return fmt.Errorf("SeedActiveRun() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	_, err = driver.Schedule(ctx, ScheduleInput{
		WorkspaceID:           fixture.WorkspaceID,
		IssueID:               issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          before.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: before.Execution.GraphRevision,
		TaskIDs:               []string{"task-b"},
		RequestID:             "schedule-over-budget-with-active",
	})
	if err == nil {
		return fmt.Errorf("Schedule() error = nil, want active-Run budget reservation rejection")
	}
	after, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if snapshotErr != nil {
		return fmt.Errorf("GetSnapshot(after) error = %w", snapshotErr)
	}
	if after.RunCount != before.RunCount || !reflect.DeepEqual(after.Tasks, before.Tasks) ||
		!reflect.DeepEqual(after.Checkpoints, before.Checkpoints) ||
		!reflect.DeepEqual(after.Execution, before.Execution) {
		return fmt.Errorf("budget rejection mutated requested set: before=%#v after=%#v", before, after)
	}
	return nil
}

func runConcurrentReplayClaimsOneDelivery(ctx context.Context, driver Driver) error {
	fixture := scheduleFixture()
	fixture.WorkflowID += "-concurrent-replay"
	fixture.RevisionID += "-concurrent-replay"
	fixture.CheckpointID += "-concurrent-replay"
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	input := ScheduleInput{
		WorkspaceID:           fixture.WorkspaceID,
		IssueID:               issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          before.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: before.Execution.GraphRevision,
		TaskIDs:               []string{"task-a"},
		RequestID:             "schedule-concurrent-replay",
	}
	started, release := driver.HoldNextLaunch()
	defer release()
	firstErr := make(chan error, 1)
	go func() {
		_, scheduleErr := driver.Schedule(ctx, input)
		firstErr <- scheduleErr
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		return fmt.Errorf("first launch did not reach delivery seam")
	}
	if err := driver.AdvanceClock(2 * time.Minute); err != nil {
		return fmt.Errorf("advance lease clock error = %w", err)
	}
	if err := driver.StartupRecoverReplica(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("replica startup recovery error = %w", err)
	}
	if calls := driver.LauncherCallCount(); calls != 1 {
		return fmt.Errorf("replica startup recovery entered launcher %d times, want 1", calls)
	}
	var wait sync.WaitGroup
	wait.Add(1)
	var replay ScheduleResult
	var replayErr error
	go func() {
		defer wait.Done()
		replay, replayErr = driver.ScheduleReplica(ctx, input)
	}()
	wait.Wait()
	if replayErr != nil {
		return fmt.Errorf("concurrent replay Schedule() error = %w", replayErr)
	}
	if !replay.Replayed {
		return fmt.Errorf("concurrent replay result = %#v, want replayed", replay)
	}
	if calls := driver.LauncherCallCount(); calls != 1 {
		return fmt.Errorf("concurrent replay entered launcher %d times, want 1", calls)
	}
	release()
	if err := <-firstErr; err != nil {
		return fmt.Errorf("first Schedule() error = %w", err)
	}
	if calls := driver.LauncherCallCount(); calls != 1 {
		return fmt.Errorf("launcher calls after release = %d, want 1", calls)
	}
	return nil
}

func runExpiredLaunchLeaseIsRecoveredOnce(ctx context.Context, driver Driver) error {
	fixture := scheduleFixture()
	fixture.WorkflowID += "-expired-launch-lease"
	fixture.RevisionID += "-expired-launch-lease"
	fixture.CheckpointID += "-expired-launch-lease"
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	input := ScheduleInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          before.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: before.Execution.GraphRevision,
		TaskIDs:               []string{"task-a"}, RequestID: "schedule-expired-launch-lease",
	}
	started, release := driver.HoldNextLaunch()
	defer release()
	firstErr := make(chan error, 1)
	go func() {
		_, scheduleErr := driver.Schedule(ctx, input)
		firstErr <- scheduleErr
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		return fmt.Errorf("first launch did not reach delivery seam")
	}
	if err := driver.StartupRecoverReplica(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("replica startup before expiry error = %w", err)
	}
	if calls := driver.LauncherCallCount(); calls != 1 {
		return fmt.Errorf("startup before expiry entered launcher %d times, want 1", calls)
	}
	if err := driver.AdvanceClock(30 * time.Second); err != nil {
		return fmt.Errorf("renew active launch lease error = %w", err)
	}
	driver.StopLeaseRenewal()
	driver.AdvanceClockWithoutRenewal(2 * time.Minute)
	if err := driver.PeriodicRecoverReplica(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("periodic recovery after expiry error = %w", err)
	}
	if calls := driver.LauncherCallCount(); calls != 2 {
		return fmt.Errorf("post-expiry launcher calls = %d, want initial + one recovery", calls)
	}
	if got := driver.LauncherCanonicalTurnCount(); got != 1 {
		return fmt.Errorf("canonical turn count = %d, want 1 after expired-lease retry", got)
	}
	if err := driver.PeriodicRecoverReplica(ctx, fixture.WorkspaceID); err != nil {
		return fmt.Errorf("second periodic recovery error = %w", err)
	}
	if calls := driver.LauncherCallCount(); calls != 2 {
		return fmt.Errorf("post-expiry recovery repeated delivery: calls=%d, want 2", calls)
	}
	release()
	if err := <-firstErr; err != nil {
		return fmt.Errorf("original Schedule() error = %w", err)
	}
	if calls := driver.LauncherCallCount(); calls != 2 {
		return fmt.Errorf("original owner completion redelivered: calls=%d, want 2", calls)
	}
	return nil
}

func runIdleRecoveryQueueObservesScheduleAdmission(ctx context.Context, driver Driver) error {
	fixture := scheduleFixture()
	fixture.WorkflowID += "-automatic-launch-recovery"
	fixture.RevisionID += "-automatic-launch-recovery"
	fixture.CheckpointID += "-automatic-launch-recovery"
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}

	driver.EnableAutomaticRecovery(ctx)
	driver.FailNextLaunch()
	result, err := driver.Schedule(ctx, ScheduleInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          before.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: before.Execution.GraphRevision,
		TaskIDs:               []string{"task-a"},
		RequestID:             "schedule-automatic-launch-recovery",
	})
	if err != nil {
		return fmt.Errorf("Schedule() error = %w", err)
	}
	if len(result.RunIDs) != 1 {
		return fmt.Errorf("Schedule() run ids = %#v, want one", result.RunIDs)
	}

	waitCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if err := driver.AwaitLauncherCalls(waitCtx, 2); err != nil {
		return fmt.Errorf("idle reconcile queue did not automatically recover launch: %w", err)
	}
	identities := driver.LauncherClientSubmitIDs()
	if len(identities) != 2 || identities[0] != identities[1] {
		return fmt.Errorf("automatic recovery identities = %#v, want one stable identity", identities)
	}
	if got := driver.LauncherCanonicalTurnCount(); got != 1 {
		return fmt.Errorf("automatic recovery canonical Turn count = %d, want 1", got)
	}
	return nil
}
