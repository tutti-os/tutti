package workspace

import (
	"context"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	executionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

type scheduledLaunchIntentStore struct {
	claims     int
	renewals   int
	releases   int
	dispatched int
}

func (*scheduledLaunchIntentStore) MaterializeTuttiModeIssue(
	context.Context,
	workspaceissues.Issue,
	[]workspaceissues.Task,
	executionbiz.Aggregate,
) (workspaceissues.Issue, []workspaceissues.Task, executionbiz.Aggregate, error) {
	panic("not used")
}

func (*scheduledLaunchIntentStore) GetTuttiModeExecutionByIssue(
	context.Context,
	string,
	string,
) (executionbiz.Aggregate, error) {
	panic("not used")
}

func (*scheduledLaunchIntentStore) AdmitTuttiModeSchedule(
	context.Context,
	executionbiz.ScheduleAdmission,
) (executionbiz.ScheduleResult, error) {
	panic("not used")
}

func (*scheduledLaunchIntentStore) ListPreparedTuttiModeRunLaunches(
	context.Context,
	string,
	string,
	[]string,
	time.Time,
) ([]executionbiz.PreparedRunLaunch, error) {
	panic("not used")
}

func (*scheduledLaunchIntentStore) GetTuttiModeRunLaunchClientSubmitID(
	context.Context,
	string,
	string,
	string,
) (string, bool, error) {
	return "persisted-submit-id", true, nil
}

func (store *scheduledLaunchIntentStore) ClaimTuttiModeRunLaunchIntent(
	context.Context,
	string,
	string,
	string,
	string,
	time.Time,
	time.Time,
) (bool, error) {
	store.claims++
	return true, nil
}

func (store *scheduledLaunchIntentStore) RenewTuttiModeRunLaunchIntent(
	context.Context,
	string,
	string,
	string,
	string,
	time.Time,
	time.Time,
) error {
	store.renewals++
	return nil
}

func (store *scheduledLaunchIntentStore) ReleaseTuttiModeRunLaunchIntent(
	context.Context,
	string,
	string,
	string,
	string,
	time.Time,
) error {
	store.releases++
	return nil
}

func (store *scheduledLaunchIntentStore) MarkTuttiModeRunLaunchIntentDispatched(
	context.Context,
	string,
	string,
	string,
	string,
	time.Time,
) error {
	store.dispatched++
	return nil
}

func (*scheduledLaunchIntentStore) RequeueLeasedTuttiModeRunLaunchIntents(
	context.Context,
	string,
	time.Time,
) error {
	return nil
}

func (*scheduledLaunchIntentStore) EnsureTuttiModeRunCancelCompensation(
	context.Context, string, string, string, string, time.Time,
) (bool, error) {
	return false, nil
}

func (*scheduledLaunchIntentStore) ListPreparedTuttiModeRunCancelCompensations(
	context.Context, string,
) ([]executionbiz.RunCancelCompensation, error) {
	return nil, nil
}

func (*scheduledLaunchIntentStore) ClaimTuttiModeRunCancelCompensation(
	context.Context, string, string, string, string, time.Time, time.Time,
) (bool, error) {
	return false, nil
}

func (*scheduledLaunchIntentStore) ReleaseTuttiModeRunCancelCompensation(
	context.Context, string, string, string, string, string, time.Time,
) error {
	return nil
}

func (*scheduledLaunchIntentStore) CompleteTuttiModeRunCancelCompensation(
	context.Context, string, string, string, string, time.Time,
) error {
	return nil
}

func (*scheduledLaunchIntentStore) RequeueLeasedTuttiModeRunCancelCompensations(
	context.Context, string, time.Time,
) error {
	return nil
}

func (*scheduledLaunchIntentStore) FailTuttiModeRunLaunch(
	context.Context, executionbiz.RunLaunchFailure,
) (executionbiz.Checkpoint, bool, error) {
	panic("not used")
}

func (*scheduledLaunchIntentStore) EnsureTuttiModeRunSettlement(
	context.Context, executionbiz.RunSettlement,
) (executionbiz.Checkpoint, bool, error) {
	panic("not used")
}

func (*scheduledLaunchIntentStore) RepairTuttiModeRunSettlements(
	context.Context, string, time.Time,
) (int, error) {
	panic("not used")
}

func (*scheduledLaunchIntentStore) AdmitTuttiModeAcknowledge(
	context.Context, executionbiz.AcknowledgeAdmission,
) (executionbiz.AcknowledgeResult, error) {
	panic("not used")
}

type immediateLeaseRenewalScheduler struct{}

func (immediateLeaseRenewalScheduler) Start(
	_ context.Context,
	_ time.Duration,
	renew func() error,
) func() {
	_ = renew()
	return func() {}
}

type scheduledLaunchRecorder struct {
	calls int
}

func (launcher *scheduledLaunchRecorder) Launch(context.Context, IssueRunLaunch) error {
	launcher.calls++
	return nil
}

func TestTuttiModeLaunchPreservesSourceRailPlacement(t *testing.T) {
	t.Parallel()

	placement := &IssueRunRailPlacement{
		Kind:        "project",
		ProjectPath: "/repo",
		SectionKey:  "project:/repo",
	}
	issue := workspaceissues.Issue{
		WorkspaceID:     "workspace",
		IssueID:         "issue",
		SourceSessionID: "source",
	}
	task := workspaceissues.Task{
		WorkspaceID:   issue.WorkspaceID,
		IssueID:       issue.IssueID,
		TaskID:        "task",
		Title:         "Task",
		AgentTargetID: "local:codex",
	}
	run := workspaceissues.Run{
		WorkspaceID:        issue.WorkspaceID,
		IssueID:            issue.IssueID,
		TaskID:             task.TaskID,
		RunID:              "run",
		AgentSessionID:     "delegate",
		AgentTargetID:      task.AgentTargetID,
		ExecutionDirectory: "/repo",
	}
	launches := (IssueManagerService{}).tuttiModeLaunchesForRuns(
		context.Background(),
		issue,
		[]workspaceissues.Task{task},
		[]executionbiz.PreparedRunLaunch{{
			Run:            run,
			ClientSubmitID: "submit",
		}},
		IssueSourceSessionContext{
			WorkingDirectory: "/repo",
			RailPlacement:    placement,
		},
	)
	if len(launches) != 1 {
		t.Fatalf("launches = %d, want one", len(launches))
	}
	launch := launches[0]
	if launch.ExecutionDirectory != "/repo" {
		t.Fatalf("execution directory = %q, want source runtime directory", launch.ExecutionDirectory)
	}
	if launch.RailPlacement == nil || *launch.RailPlacement != *placement {
		t.Fatalf("rail placement = %#v, want %#v", launch.RailPlacement, placement)
	}
	if launch.RailPlacement == placement {
		t.Fatal("rail placement aliases the source snapshot")
	}
	if !launch.HideSession {
		t.Fatal("Tutti Mode delegate launch must request a hidden session")
	}
}

func TestScheduledRunDeliveryUsesSharedSeamAndRenewsDurableLease(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	issueStore := openIssueServiceStore(t)
	workspaceID := "ws-scheduled-delivery"
	if err := issueStore.Create(ctx, workspacebiz.Summary{
		ID: workspaceID, Name: "Scheduled delivery",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	domain := workspaceissues.Service{Store: issueStore}
	issue, tasks, err := domain.CreateIssueWithTasks(ctx, workspaceissues.CreateIssueWithTasksInput{
		Issue: workspaceissues.CreateIssueInput{
			IssueID: workspaceID + "-issue", WorkspaceID: workspaceID,
			TopicID: workspaceissues.DefaultTopicID, ActorUserID: "local",
			Title: "Scheduled Issue", PlanningSource: string(workspaceissues.PlanningSourceTuttiModePlan),
			SourceSessionID: "source-scheduled-delivery",
			HasBudget:       true, Budget: workspaceissues.Budget{Mode: workspaceissues.BudgetModeAuto},
		},
		Tasks: []workspaceissues.CreateTaskItemInput{{
			TaskID: "task-1", Title: "Task 1", AgentTargetID: "local:codex",
		}},
	})
	if err != nil {
		t.Fatalf("CreateIssueWithTasks() error = %v", err)
	}
	now := time.Now().UTC().UnixMilli()
	run, err := issueStore.CreateRun(ctx, workspaceissues.Run{
		RunID: "run-scheduled-delivery", WorkspaceID: workspaceID,
		IssueID: issue.IssueID, TaskID: tasks[0].TaskID,
		RequesterUserID: "local", AgentTargetID: "local:codex",
		AgentSessionID: "delegate-scheduled-delivery",
		Status:         workspaceissues.StatusRunning, CreatedAtUnixMS: now,
		StartedAtUnixMS: now, UpdatedAtUnixMS: now,
	})
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}

	intents := &scheduledLaunchIntentStore{}
	launcher := &scheduledLaunchRecorder{}
	executions := &executionservice.Service{
		Store: intents,
		Clock: func() time.Time { return time.UnixMilli(1_700_000_000_000).UTC() },
	}
	service := IssueManagerService{
		Store: issueStore, RunLauncher: launcher, TuttiModeExecutions: executions,
		MutationLocks: NewIssueMutationLocks(), RunLaunchGate: NewIssueRunLaunchGate(),
		RunLaunchLeaseRenewalScheduler: immediateLeaseRenewalScheduler{},
	}
	clientSubmitID, err := service.issueRunClientSubmitID(ctx, run)
	if err != nil || clientSubmitID != "persisted-submit-id" {
		t.Fatalf("issueRunClientSubmitID() = %q, %v, want persisted identity", clientSubmitID, err)
	}
	service.launchScheduledTuttiModeRuns(ctx, []IssueRunLaunch{{
		WorkspaceID: workspaceID, IssueID: issue.IssueID, TaskID: tasks[0].TaskID,
		RunID: run.RunID, AgentSessionID: run.AgentSessionID,
		ClientSubmitID: "persisted-submit-id",
	}})

	if launcher.calls != 1 || intents.claims != 1 || intents.renewals != 1 ||
		intents.dispatched != 1 || intents.releases != 0 {
		t.Fatalf(
			"delivery calls launcher=%d claim=%d renew=%d dispatched=%d release=%d",
			launcher.calls, intents.claims, intents.renewals, intents.dispatched, intents.releases,
		)
	}
}
