package conformance

import (
	"context"
	"fmt"
	"reflect"
)

func mutationFixture(suffix string) AcceptPlanInput {
	return AcceptPlanInput{
		WorkspaceID:     "workspace-materialization",
		WorkflowID:      "workflow-mutation-" + suffix,
		RevisionID:      "revision-mutation-" + suffix,
		CheckpointID:    "review-mutation-" + suffix,
		SourceSessionID: "session-source",
		TopicID:         "default",
		Title:           "Managed mutation " + suffix,
		Content:         "The source Agent owns graph changes.",
		Tasks: []Task{
			schedulableTask("task-a", "/tmp/tutti-mutation-task-a"),
			schedulableTask("task-b", "/tmp/tutti-mutation-task-b"),
		},
	}
}

func runMutationFencesReplayAndSchedulesReturnedRevision(
	ctx context.Context,
	driver Driver,
) error {
	fixture := mutationFixture("fences")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	taskC := schedulableTask("task-c", "/tmp/tutti-mutation-task-c")
	base := MutateInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          before.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: before.Execution.GraphRevision,
		Operations:            []MutationOperation{{Kind: "add", Task: taskC}},
		RequestID:             "mutate-add-c",
	}
	assertRejectedUnchanged := func(name string, input MutateInput) error {
		if _, mutateErr := driver.Mutate(ctx, input); mutateErr == nil {
			return fmt.Errorf("%s: Mutate() error = nil, want rejection", name)
		}
		after, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
		if snapshotErr != nil {
			return fmt.Errorf("%s: GetSnapshot() error = %w", name, snapshotErr)
		}
		if !reflect.DeepEqual(after, before) {
			return fmt.Errorf("%s: rejected mutation changed snapshot: before=%#v after=%#v", name, before, after)
		}
		return nil
	}
	wrongCaller := base
	wrongCaller.SourceSessionID = "session-other"
	wrongCaller.RequestID = "mutate-wrong-caller"
	if err := assertRejectedUnchanged("wrong caller", wrongCaller); err != nil {
		return err
	}
	staleCheckpoint := base
	staleCheckpoint.CheckpointID = "checkpoint-stale"
	staleCheckpoint.RequestID = "mutate-stale-checkpoint"
	if err := assertRejectedUnchanged("stale checkpoint", staleCheckpoint); err != nil {
		return err
	}
	staleRevision := base
	staleRevision.ExpectedGraphRevision++
	staleRevision.RequestID = "mutate-stale-revision"
	if err := assertRejectedUnchanged("stale revision", staleRevision); err != nil {
		return err
	}

	first, err := driver.Mutate(ctx, base)
	if err != nil {
		return fmt.Errorf("Mutate(add C) error = %w", err)
	}
	if first.Replayed || first.CheckpointID != base.CheckpointID ||
		first.GraphRevision != before.Execution.GraphRevision+1 ||
		!reflect.DeepEqual(first.AddedTaskIDs, []string{"task-c"}) {
		return fmt.Errorf("Mutate(add C) result = %#v", first)
	}
	mutated, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(mutated) error = %w", err)
	}
	if mutated.Execution.GraphRevision != first.GraphRevision ||
		len(mutated.Checkpoints) != 1 ||
		mutated.Checkpoints[0].Status != "active" ||
		mutated.Checkpoints[0].GraphRevision != first.GraphRevision ||
		len(mutated.Tasks) != 3 {
		return fmt.Errorf("mutated snapshot = %#v", mutated)
	}
	replay, err := driver.MutateReplica(ctx, base)
	if err != nil {
		return fmt.Errorf("MutateReplica(replay) error = %w", err)
	}
	first.Replayed = true
	if !reflect.DeepEqual(replay, first) {
		return fmt.Errorf("mutation replay = %#v, want %#v", replay, first)
	}
	conflict := base
	conflict.Operations = []MutationOperation{{Kind: "add", Task: schedulableTask(
		"task-d", "/tmp/tutti-mutation-task-d",
	)}}
	if _, err := driver.Mutate(ctx, conflict); err == nil {
		return fmt.Errorf("conflicting mutation replay error = nil")
	}
	afterConflict, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || !reflect.DeepEqual(afterConflict, mutated) {
		return fmt.Errorf("conflicting replay mutated state: snapshot=%#v error=%v", afterConflict, err)
	}

	scheduled, err := driver.Schedule(ctx, ScheduleInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID: fixture.SourceSessionID, CheckpointID: base.CheckpointID,
		ExpectedGraphRevision: first.GraphRevision, TaskIDs: []string{"task-c"},
		RequestID: "schedule-mutated-c",
	})
	if err != nil {
		return fmt.Errorf("Schedule(mutated C) error = %w", err)
	}
	if scheduled.GraphRevision != first.GraphRevision || len(scheduled.RunIDs) != 1 {
		return fmt.Errorf("Schedule(mutated C) result = %#v", scheduled)
	}
	afterSchedule, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || afterSchedule.Checkpoints[0].Status != "resolved" {
		return fmt.Errorf("mutate-then-schedule snapshot = %#v error=%v", afterSchedule, err)
	}
	return nil
}

func runMutationOperationsCommitAllOrNone(
	ctx context.Context,
	driver Driver,
) error {
	fixture := mutationFixture("atomic")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	before, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(before) error = %w", err)
	}
	taskA := schedulableTask("task-a", "/tmp/tutti-mutation-updated-a")
	taskA.Title = "Updated task A"
	taskC := schedulableTask("task-c", "/tmp/tutti-mutation-task-c")
	taskD := schedulableTask("task-d", "/tmp/tutti-mutation-reworked-d")
	result, err := driver.Mutate(ctx, MutateInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          before.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: before.Execution.GraphRevision,
		Operations: []MutationOperation{
			{Kind: "add", Task: taskC},
			{Kind: "update", TaskID: "task-a", Task: taskA},
			{Kind: "rework", TaskID: "task-b", Task: taskD},
			{Kind: "supersede", TaskID: "task-c"},
		},
		RequestID: "mutate-all-operation-kinds",
	})
	if err != nil {
		return fmt.Errorf("Mutate(all operation kinds) error = %w", err)
	}
	if !reflect.DeepEqual(result.AddedTaskIDs, []string{"task-c", "task-d"}) ||
		!reflect.DeepEqual(result.UpdatedTaskIDs, []string{"task-a"}) ||
		!reflect.DeepEqual(result.SupersededTaskIDs, []string{"task-b", "task-c"}) {
		return fmt.Errorf("Mutate(all operation kinds) result = %#v", result)
	}
	committed, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(committed) error = %w", err)
	}
	if len(committed.Tasks) != 4 || committed.Issue.TaskCount != 2 ||
		committed.Execution.GraphRevision != result.GraphRevision {
		return fmt.Errorf("committed mutation snapshot = %#v", committed)
	}
	tasksByID := make(map[string]Task, len(committed.Tasks))
	for _, task := range committed.Tasks {
		tasksByID[task.TaskID] = task
	}
	if tasksByID["task-a"].Title != taskA.Title ||
		tasksByID["task-b"].SupersededByTaskID != "task-d" ||
		tasksByID["task-b"].SupersededAtUnixMS == 0 ||
		tasksByID["task-c"].SupersededAtUnixMS == 0 ||
		tasksByID["task-d"].SupersededAtUnixMS != 0 {
		return fmt.Errorf("committed mutation tasks = %#v", tasksByID)
	}

	invalid := MutateInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          committed.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: committed.Execution.GraphRevision,
		Operations: []MutationOperation{
			{Kind: "add", Task: schedulableTask("task-e", "/tmp/tutti-mutation-task-e")},
			{Kind: "update", TaskID: "task-missing", Task: taskA},
		},
		RequestID: "mutate-atomic-rejection",
	}
	if _, err := driver.Mutate(ctx, invalid); err == nil {
		return fmt.Errorf("Mutate(partially invalid) error = nil")
	}
	afterRejection, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(after rejection) error = %w", err)
	}
	if !reflect.DeepEqual(afterRejection, committed) {
		return fmt.Errorf(
			"partially invalid mutation changed snapshot: before=%#v after=%#v",
			committed, afterRejection,
		)
	}
	return nil
}

func runLogicalSupersessionPreservesHistoryAndRequiresSettlement(
	ctx context.Context,
	driver Driver,
) error {
	fixture := mutationFixture("supersession")
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	initial, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	scheduled, err := driver.Schedule(ctx, ScheduleInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          initial.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: initial.Execution.GraphRevision,
		TaskIDs:               []string{"task-a", "task-b"}, RequestID: "schedule-a-b",
	})
	if err != nil {
		return fmt.Errorf("Schedule(A,B) error = %w", err)
	}
	if err := driver.SettleRun(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: scheduled.RunIDs[0], Status: "completed",
	}); err != nil {
		return fmt.Errorf("SettleRun(A) error = %w", err)
	}
	active, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	checkpoint := active.Checkpoints[len(active.Checkpoints)-1]
	supersedeRunning := MutateInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID: fixture.SourceSessionID, CheckpointID: checkpoint.CheckpointID,
		ExpectedGraphRevision: active.Execution.GraphRevision,
		Operations:            []MutationOperation{{Kind: "supersede", TaskID: "task-b"}},
		RequestID:             "supersede-running-b",
	}
	if _, err := driver.Mutate(ctx, supersedeRunning); err == nil {
		return fmt.Errorf("supersede running task error = nil")
	}
	unchanged, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || !reflect.DeepEqual(unchanged, active) {
		return fmt.Errorf("rejected running mutation changed state: %#v error=%v", unchanged, err)
	}
	if err := driver.SettleRun(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-b", RunID: scheduled.RunIDs[1], Status: "canceled",
	}); err != nil {
		return fmt.Errorf("SettleRun(B) error = %w", err)
	}
	settled, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	var activeA Checkpoint
	for _, candidate := range settled.Checkpoints {
		if candidate.Status == "active" {
			activeA = candidate
			break
		}
	}
	if activeA.CheckpointID == "" {
		return fmt.Errorf("settled snapshot has no active checkpoint: %#v", settled)
	}
	if _, err := driver.Acknowledge(ctx, AcknowledgeInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID: fixture.SourceSessionID,
		CheckpointID:    activeA.CheckpointID, ExpectedGraphRevision: settled.Execution.GraphRevision,
		RequestID: "acknowledge-completed-a",
	}); err != nil {
		return fmt.Errorf("Acknowledge(A) error = %w", err)
	}
	settled, err = driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	checkpoint = Checkpoint{}
	for _, candidate := range settled.Checkpoints {
		if candidate.Status == "active" {
			checkpoint = candidate
			break
		}
	}
	if checkpoint.CheckpointID == "" {
		return fmt.Errorf("acknowledged snapshot has no active checkpoint: %#v", settled)
	}
	updateCompleted := MutateInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID: fixture.SourceSessionID, CheckpointID: checkpoint.CheckpointID,
		ExpectedGraphRevision: settled.Execution.GraphRevision,
		Operations: []MutationOperation{{
			Kind: "update", TaskID: "task-a",
			Task: Task{TaskID: "task-a", Title: "rewritten completed task"},
		}},
		RequestID: "update-completed-a",
	}
	if _, err := driver.Mutate(ctx, updateCompleted); err == nil {
		return fmt.Errorf("update completed task error = nil")
	}
	supersedeCompleted := updateCompleted
	supersedeCompleted.RequestID = "supersede-completed-a"
	supersedeCompleted.Operations = []MutationOperation{{Kind: "supersede", TaskID: "task-a"}}
	if _, err := driver.Mutate(ctx, supersedeCompleted); err == nil {
		return fmt.Errorf("supersede completed task error = nil")
	}
	supersedeRunning.ExpectedGraphRevision = settled.Execution.GraphRevision
	supersedeRunning.CheckpointID = checkpoint.CheckpointID
	result, err := driver.Mutate(ctx, supersedeRunning)
	if err != nil {
		return fmt.Errorf("supersede settled B error = %w", err)
	}
	after, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return err
	}
	if result.GraphRevision != settled.Execution.GraphRevision+1 ||
		!reflect.DeepEqual(result.SupersededTaskIDs, []string{"task-b"}) ||
		len(after.Tasks) != 2 || len(after.Runs) != 2 || after.OutputCount != 1 ||
		after.Issue.Status != "completed" || after.Issue.TaskCount != 1 ||
		after.Issue.CompletedCount != 1 || after.Issue.CanceledCount != 0 {
		return fmt.Errorf("supersession history = result %#v snapshot %#v", result, after)
	}
	var superseded Task
	for _, task := range after.Tasks {
		if task.TaskID == "task-b" {
			superseded = task
		}
	}
	if superseded.SupersededAtUnixMS == 0 {
		return fmt.Errorf("superseded task metadata = %#v", superseded)
	}
	return nil
}

func runMutationSupersedesStaleGoalReview(
	ctx context.Context,
	driver Driver,
) error {
	fixture := mutationFixture("goal-review")
	fixture.Tasks = fixture.Tasks[:1]
	issueID, err := driver.AcceptPlan(ctx, fixture)
	if err != nil {
		return fmt.Errorf("AcceptPlan() error = %w", err)
	}
	initial, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(initial) error = %w", err)
	}
	scheduled, err := driver.Schedule(ctx, ScheduleInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          initial.Checkpoints[0].CheckpointID,
		ExpectedGraphRevision: initial.Execution.GraphRevision,
		TaskIDs:               []string{"task-a"},
		RequestID:             "schedule-goal-review-a",
	})
	if err != nil {
		return fmt.Errorf("Schedule(A) error = %w", err)
	}
	if err := driver.SettleRun(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		TaskID: "task-a", RunID: scheduled.RunIDs[0], Status: "completed",
	}); err != nil {
		return fmt.Errorf("SettleRun(A) error = %w", err)
	}
	settled, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || len(settled.Checkpoints) != 3 {
		return fmt.Errorf("GetSnapshot(settled) = %#v, %v", settled, err)
	}
	if _, err := driver.Acknowledge(ctx, AcknowledgeInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          settled.Checkpoints[1].CheckpointID,
		ExpectedGraphRevision: settled.Execution.GraphRevision,
		RequestID:             "ack-goal-review-task",
	}); err != nil {
		return fmt.Errorf("Acknowledge(task checkpoint) error = %w", err)
	}
	goalReview, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if err != nil || goalReview.Execution.Status != "pending_goal_review" ||
		goalReview.Checkpoints[2].Status != "active" {
		return fmt.Errorf("goal review snapshot = %#v, %v", goalReview, err)
	}
	if err := driver.SetReviewerActive(
		ctx, fixture.WorkspaceID, issueID, true,
	); err != nil {
		return fmt.Errorf("SetReviewerActive(true) error = %w", err)
	}
	result, err := driver.Mutate(ctx, MutateInput{
		WorkspaceID: fixture.WorkspaceID, IssueID: issueID,
		SourceSessionID:       fixture.SourceSessionID,
		CheckpointID:          goalReview.Checkpoints[2].CheckpointID,
		ExpectedGraphRevision: goalReview.Execution.GraphRevision,
		Operations: []MutationOperation{{
			Kind: "add",
			Task: schedulableTask("task-b", "/tmp/tutti-mutation-goal-review-b"),
		}},
		RequestID: "mutate-goal-review-add-b",
	})
	if err != nil {
		return fmt.Errorf("Mutate(add B) error = %w", err)
	}
	active, err := driver.ReviewerActive(ctx, fixture.WorkspaceID, issueID)
	if err != nil {
		return fmt.Errorf("ReviewerActive() error = %w", err)
	}
	after, snapshotErr := driver.GetSnapshot(ctx, fixture.WorkspaceID, issueID)
	if snapshotErr != nil {
		return fmt.Errorf("GetSnapshot(after) error = %w", snapshotErr)
	}
	if active || result.GraphRevision != goalReview.Execution.GraphRevision+1 ||
		after.Execution.Status != "awaiting_main" ||
		after.Checkpoints[2].Status != "active" ||
		after.Checkpoints[2].GraphRevision != result.GraphRevision {
		return fmt.Errorf(
			"mutation retained stale Goal Review: active=%v result=%#v snapshot=%#v",
			active, result, after,
		)
	}
	return nil
}
