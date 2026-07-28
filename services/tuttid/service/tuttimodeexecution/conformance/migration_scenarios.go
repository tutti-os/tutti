package conformance

import (
	"context"
	"fmt"
	"reflect"
	"time"
)

type LegacyExecutionInput struct {
	Plan          AcceptPlanInput
	SourceState   string
	RunningTaskID string
}

type LegacyExecution struct {
	IssueID string
	RunID   string
}

// MigrationDriver is intentionally separate from Driver: these operations
// model startup-upgrade fixtures and are not part of the execution service API.
type MigrationDriver interface {
	Driver
	SeedLegacyExecution(context.Context, LegacyExecutionInput) (LegacyExecution, error)
	StartupRepairLegacyExecutions(context.Context) error
	SourceSessionState(context.Context, string, string) (string, error)
}

func MigrationCatalog() []Scenario {
	return []Scenario{
		{
			Name: "ActiveLegacyRunContinuesWithoutSuccessorAutoDispatch",
			run:  migrationRun(runActiveLegacyRunContinuesWithoutSuccessorAutoDispatch),
		},
		{
			Name: "IdleLegacyExecutionGetsOneDeterministicMigrationWake",
			run:  migrationRun(runIdleLegacyExecutionGetsOneDeterministicMigrationWake),
		},
		{
			Name: "MissingAndTombstonedLegacySourcesBecomeOrphanedSource",
			run:  migrationRun(runMissingAndTombstonedLegacySourcesBecomeOrphanedSource),
		},
	}
}

func migrationRun(
	run func(context.Context, MigrationDriver) error,
) func(context.Context, Driver) error {
	return func(ctx context.Context, driver Driver) error {
		migrationDriver, ok := driver.(MigrationDriver)
		if !ok {
			return fmt.Errorf("migration scenario requires MigrationDriver")
		}
		return run(ctx, migrationDriver)
	}
}

func runActiveLegacyRunContinuesWithoutSuccessorAutoDispatch(
	ctx context.Context,
	driver MigrationDriver,
) error {
	fixture := legacyFixture("active")
	fixture.Tasks[0].AutoAccept = true
	legacy, err := driver.SeedLegacyExecution(ctx, LegacyExecutionInput{
		Plan: fixture, SourceState: "active", RunningTaskID: "task-a",
	})
	if err != nil {
		return fmt.Errorf("SeedLegacyExecution() error = %w", err)
	}
	beforeCalls := driver.LauncherCallCount()
	if err := driver.StartupRepairLegacyExecutions(ctx); err != nil {
		return fmt.Errorf("StartupRepairLegacyExecutions() error = %w", err)
	}
	repaired, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, legacy.IssueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(repaired) error = %w", err)
	}
	if repaired.Execution.Status != "running" || repaired.RunCount != 1 ||
		len(repaired.Runs) != 1 || repaired.Runs[0].RunID != legacy.RunID ||
		repaired.Runs[0].Status != "running" {
		return fmt.Errorf("repaired active legacy execution = %#v", repaired)
	}
	if len(repaired.Checkpoints) != 1 ||
		repaired.Checkpoints[0].Kind != "migration" ||
		repaired.Checkpoints[0].Status != "active" {
		return fmt.Errorf("active legacy migration checkpoint = %#v", repaired.Checkpoints)
	}
	if driver.LauncherCallCount() != beforeCalls {
		return fmt.Errorf(
			"startup repair launched work: calls=%d, want %d",
			driver.LauncherCallCount(), beforeCalls,
		)
	}

	if err := driver.SettleRun(ctx, SettleRunInput{
		WorkspaceID: fixture.WorkspaceID,
		IssueID:     legacy.IssueID,
		TaskID:      "task-a",
		RunID:       legacy.RunID,
		Status:      "completed",
	}); err != nil {
		return fmt.Errorf("SettleRun(legacy) error = %w", err)
	}
	settled, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, legacy.IssueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(settled) error = %w", err)
	}
	if settled.RunCount != 1 || driver.LauncherCallCount() != beforeCalls {
		return fmt.Errorf(
			"legacy settlement auto-dispatched successor: runs=%d calls=%d",
			settled.RunCount, driver.LauncherCallCount(),
		)
	}
	first := taskByID(settled.Tasks, "task-a")
	successor := taskByID(settled.Tasks, "task-b")
	if !first.AutoAccept || first.Status != "pending_acceptance" ||
		successor.Status != "not_started" {
		return fmt.Errorf(
			"historical autoAccept was not preserved and ignored: first=%#v successor=%#v",
			first, successor,
		)
	}
	if len(settled.Checkpoints) != 2 ||
		settled.Checkpoints[1].Kind != "task_settled" ||
		settled.Checkpoints[1].Status != "pending" {
		return fmt.Errorf("legacy settlement backlog = %#v", settled.Checkpoints)
	}
	return nil
}

func runIdleLegacyExecutionGetsOneDeterministicMigrationWake(
	ctx context.Context,
	driver MigrationDriver,
) error {
	fixture := legacyFixture("idle")
	legacy, err := driver.SeedLegacyExecution(ctx, LegacyExecutionInput{
		Plan: fixture, SourceState: "active",
	})
	if err != nil {
		return fmt.Errorf("SeedLegacyExecution() error = %w", err)
	}
	if err := driver.StartupRepairLegacyExecutions(ctx); err != nil {
		return fmt.Errorf("StartupRepairLegacyExecutions(first) error = %w", err)
	}
	first, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, legacy.IssueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(first) error = %w", err)
	}
	firstWakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, legacy.IssueID)
	if err != nil {
		return fmt.Errorf("ListWakes(first) error = %w", err)
	}
	if first.Execution.Status != "awaiting_main" ||
		len(first.Checkpoints) != 1 ||
		first.Checkpoints[0].Kind != "migration" ||
		first.Checkpoints[0].Status != "active" ||
		len(firstWakes) != 1 ||
		firstWakes[0].CheckpointID != first.Checkpoints[0].CheckpointID ||
		firstWakes[0].Status != "prepared" {
		return fmt.Errorf("idle legacy repair = %#v wakes=%#v", first, firstWakes)
	}

	if err := driver.StartupRepairLegacyExecutions(ctx); err != nil {
		return fmt.Errorf("StartupRepairLegacyExecutions(replay) error = %w", err)
	}
	replayed, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, legacy.IssueID)
	if err != nil {
		return fmt.Errorf("GetSnapshot(replay) error = %w", err)
	}
	replayedWakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, legacy.IssueID)
	if err != nil {
		return fmt.Errorf("ListWakes(replay) error = %w", err)
	}
	if !reflect.DeepEqual(replayed, first) ||
		!reflect.DeepEqual(replayedWakes, firstWakes) ||
		driver.LauncherCallCount() != 0 {
		return fmt.Errorf(
			"legacy repair replay changed state: first=%#v/%#v replay=%#v/%#v launches=%d",
			first, firstWakes, replayed, replayedWakes, driver.LauncherCallCount(),
		)
	}
	return nil
}

func runMissingAndTombstonedLegacySourcesBecomeOrphanedSource(
	ctx context.Context,
	driver MigrationDriver,
) error {
	for _, sourceState := range []string{"missing", "tombstoned"} {
		fixture := legacyFixture("orphaned-" + sourceState)
		legacy, err := driver.SeedLegacyExecution(ctx, LegacyExecutionInput{
			Plan: fixture, SourceState: sourceState,
		})
		if err != nil {
			return fmt.Errorf("%s: SeedLegacyExecution() error = %w", sourceState, err)
		}
		beforeSource, err := driver.SourceSessionState(
			ctx, fixture.WorkspaceID, fixture.SourceSessionID,
		)
		if err != nil || beforeSource != sourceState {
			return fmt.Errorf(
				"%s: source before repair=%q error=%v",
				sourceState, beforeSource, err,
			)
		}
		if err := driver.StartupRepairLegacyExecutions(ctx); err != nil {
			return fmt.Errorf("%s: StartupRepairLegacyExecutions() error = %w", sourceState, err)
		}
		snapshot, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, legacy.IssueID)
		if err != nil {
			return fmt.Errorf("%s: GetSnapshot() error = %w", sourceState, err)
		}
		wakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, legacy.IssueID)
		if err != nil {
			return fmt.Errorf("%s: ListWakes() error = %w", sourceState, err)
		}
		afterSource, err := driver.SourceSessionState(
			ctx, fixture.WorkspaceID, fixture.SourceSessionID,
		)
		if err != nil {
			return fmt.Errorf("%s: SourceSessionState(after) error = %w", sourceState, err)
		}
		if snapshot.Execution.Status != "orphaned_source" ||
			len(snapshot.Checkpoints) != 1 ||
			snapshot.Checkpoints[0].Kind != "migration" ||
			snapshot.Checkpoints[0].Status != "canceled" ||
			len(wakes) != 0 || afterSource != beforeSource {
			return fmt.Errorf(
				"%s: orphan repair snapshot=%#v wakes=%#v source=%q",
				sourceState, snapshot, wakes, afterSource,
			)
		}

		driver.AdvanceClockWithoutRenewal(10 * time.Minute)
		if err := driver.RunWatchdog(
			ctx, fixture.WorkspaceID, "orphaned-watchdog-"+sourceState,
		); err != nil {
			return fmt.Errorf("%s: RunWatchdog() error = %w", sourceState, err)
		}
		afterWatchdog, err := driver.GetSnapshot(ctx, fixture.WorkspaceID, legacy.IssueID)
		if err != nil {
			return fmt.Errorf("%s: GetSnapshot(after watchdog) error = %w", sourceState, err)
		}
		afterWakes, err := driver.ListWakes(ctx, fixture.WorkspaceID, legacy.IssueID)
		if err != nil || !reflect.DeepEqual(afterWatchdog, snapshot) || len(afterWakes) != 0 {
			return fmt.Errorf(
				"%s: orphaned automation changed state=%#v wakes=%#v error=%v",
				sourceState, afterWatchdog, afterWakes, err,
			)
		}

		checkpoint := snapshot.Checkpoints[0]
		if _, err := driver.Schedule(ctx, ScheduleInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: legacy.IssueID,
			SourceSessionID:       fixture.SourceSessionID,
			CheckpointID:          checkpoint.CheckpointID,
			ExpectedGraphRevision: snapshot.Execution.GraphRevision,
			TaskIDs:               []string{"task-a"},
			RequestID:             "orphaned-schedule-" + sourceState,
		}); err == nil {
			return fmt.Errorf("%s: orphaned Schedule() error = nil", sourceState)
		}
		if _, err := driver.Acknowledge(ctx, AcknowledgeInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: legacy.IssueID,
			SourceSessionID:       fixture.SourceSessionID,
			CheckpointID:          checkpoint.CheckpointID,
			ExpectedGraphRevision: snapshot.Execution.GraphRevision,
			RequestID:             "orphaned-ack-" + sourceState,
		}); err == nil {
			return fmt.Errorf("%s: orphaned Acknowledge() error = nil", sourceState)
		}
		if _, err := driver.Complete(ctx, CompleteInput{
			WorkspaceID: fixture.WorkspaceID, IssueID: legacy.IssueID,
			SourceSessionID:       fixture.SourceSessionID,
			CheckpointID:          checkpoint.CheckpointID,
			ExpectedGraphRevision: snapshot.Execution.GraphRevision,
			RequestID:             "orphaned-complete-" + sourceState,
			Decision:              "goal_satisfied",
		}); err == nil {
			return fmt.Errorf("%s: orphaned Complete() error = nil", sourceState)
		}
	}
	return nil
}

func legacyFixture(suffix string) AcceptPlanInput {
	fixture := scheduleFixture()
	fixture.WorkspaceID = "workspace-materialization"
	fixture.WorkflowID = "workflow-legacy-" + suffix
	fixture.RevisionID = "revision-legacy-" + suffix
	fixture.CheckpointID = "review-legacy-" + suffix
	fixture.SourceSessionID = "source-legacy-" + suffix
	fixture.Title = "Legacy execution " + suffix
	fixture.Tasks = []Task{
		schedulableTask("task-a", "/tmp/tutti-legacy-"+suffix+"-a"),
		{
			TaskID:             "task-b",
			Title:              "Task B",
			Content:            "Explicit successor",
			Status:             "not_started",
			Priority:           "medium",
			AgentTargetID:      "local:codex",
			Model:              "gpt-5.4-codex",
			PermissionModeID:   "full-access",
			ExecutionDirectory: "/tmp/tutti-legacy-" + suffix + "-b",
			DependencyTaskIDs:  []string{"task-a"},
		},
	}
	return fixture
}
