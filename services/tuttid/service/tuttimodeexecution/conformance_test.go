package tuttimodeexecution_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
	tuttimodeexecutionconformance "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution/conformance"
	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
	"gopkg.in/yaml.v3"
)

type sqliteConformanceDriver struct {
	dbPath             string
	store              *workspacedata.SQLiteStore
	issues             workspaceservice.IssueManagerService
	executions         *tuttimodeexecutionservice.Service
	plans              *tuttimodeplanservice.Service
	revisions          workspacedata.WorkflowRevisionFiles
	clock              *controlledClock
	launcher           *recordingLauncher
	renewals           *manualLeaseRenewalScheduler
	canceller          *recordingRunCanceller
	wakeTarget         *recordingMainWakeTarget
	wakeStore          *injectableWakeStore
	reviewer           *recordingReviewerTarget
	automationTurns    *recordingAutomationTurnCanceller
	reviewMu           sync.Mutex
	failReviewStep     string
	deletionAdmissions map[string]executionbiz.SourceSessionDeletionAdmission
	cancelAuto         context.CancelFunc
}

type conformanceSourceSessionContextResolver struct{}

func (conformanceSourceSessionContextResolver) ResolveSourceSessionContext(
	_ string,
	_ string,
) (workspaceservice.IssueSourceSessionContext, bool) {
	return workspaceservice.IssueSourceSessionContext{}, true
}

type controlledClock struct {
	mu  sync.Mutex
	now time.Time
}

type recordingAutomationTurnCanceller struct {
	mu            sync.Mutex
	cancellations []tuttimodeexecutionconformance.AutomationTurnCancellation
	failNext      bool
}

func (canceller *recordingAutomationTurnCanceller) CancelAutomationTurn(
	_ context.Context,
	_ string,
	sessionID string,
	turnID string,
) error {
	canceller.mu.Lock()
	defer canceller.mu.Unlock()
	if canceller.failNext {
		canceller.failNext = false
		return errors.New("injected automation Turn cancellation failure")
	}
	canceller.cancellations = append(
		canceller.cancellations,
		tuttimodeexecutionconformance.AutomationTurnCancellation{
			SessionID: sessionID, TurnID: turnID,
		},
	)
	return nil
}

func (driver *sqliteConformanceDriver) FailNextAutomationTurnCancellation() {
	driver.automationTurns.mu.Lock()
	defer driver.automationTurns.mu.Unlock()
	driver.automationTurns.failNext = true
}

func (clock *controlledClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

func (clock *controlledClock) Advance(duration time.Duration) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.now = clock.now.Add(duration)
}

func (clock *controlledClock) Set(now time.Time) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.now = now
}

type manualLeaseRenewalScheduler struct {
	mu         sync.Mutex
	generation uint64
	renew      func() error
}

func (scheduler *manualLeaseRenewalScheduler) Start(
	_ context.Context,
	_ time.Duration,
	renew func() error,
) func() {
	scheduler.mu.Lock()
	scheduler.generation++
	generation := scheduler.generation
	scheduler.renew = renew
	scheduler.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			scheduler.mu.Lock()
			defer scheduler.mu.Unlock()
			if scheduler.generation == generation {
				scheduler.renew = nil
			}
		})
	}
}

func (scheduler *manualLeaseRenewalScheduler) Tick() error {
	scheduler.mu.Lock()
	renew := scheduler.renew
	scheduler.mu.Unlock()
	if renew == nil {
		return fmt.Errorf("no in-flight launch lease to renew")
	}
	return renew()
}

func (scheduler *manualLeaseRenewalScheduler) StopCurrent() {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	scheduler.renew = nil
}

type recordingLauncher struct {
	mu                      sync.Mutex
	calls                   int
	callSignal              chan struct{}
	failNext                bool
	failBeforeCanonical     bool
	failAfterBlock          bool
	clientSubmitIDs         []string
	canonicalByClientSubmit map[string]string
	blockNext               bool
	started                 chan struct{}
	release                 chan struct{}
}

type recordingReviewerTarget struct {
	mu                      sync.Mutex
	calls                   int
	failBeforeCanonical     bool
	failAfterCanonical      bool
	busyBySession           map[string]bool
	canonicalByClientSubmit map[string]tuttimodeexecutionservice.ReviewerDelivery
	capabilities            []string
	onNextSend              func(
		tuttimodeexecutionservice.ReviewerLaunch,
		tuttimodeexecutionservice.ReviewerDelivery,
	) error
	settleNext bool
}

func (target *recordingReviewerTarget) ObserveReviewerSession(
	_ context.Context,
	_ string,
	sessionID string,
) (tuttimodeexecutionservice.ReviewerSessionObservation, error) {
	target.mu.Lock()
	defer target.mu.Unlock()
	return tuttimodeexecutionservice.ReviewerSessionObservation{
		Busy: target.busyBySession[sessionID],
	}, nil
}

func (target *recordingReviewerTarget) SendReviewer(
	_ context.Context,
	launch tuttimodeexecutionservice.ReviewerLaunch,
) (tuttimodeexecutionservice.ReviewerDelivery, error) {
	target.mu.Lock()
	target.calls++
	target.capabilities = append([]string(nil), launch.Capabilities...)
	if target.failBeforeCanonical {
		target.failBeforeCanonical = false
		target.mu.Unlock()
		return tuttimodeexecutionservice.ReviewerDelivery{}, errors.New("injected reviewer failure before canonical Turn")
	}
	if target.canonicalByClientSubmit == nil {
		target.canonicalByClientSubmit = make(map[string]tuttimodeexecutionservice.ReviewerDelivery)
	}
	delivery, found := target.canonicalByClientSubmit[launch.ClientSubmitID]
	if !found {
		delivery = tuttimodeexecutionservice.ReviewerDelivery{
			CanonicalSessionID: launch.SessionID,
			CanonicalTurnID:    fmt.Sprintf("review-turn-%d", len(target.canonicalByClientSubmit)+1),
		}
		target.canonicalByClientSubmit[launch.ClientSubmitID] = delivery
	}
	if target.settleNext {
		target.settleNext = false
		delivery.Settled = true
		target.canonicalByClientSubmit[launch.ClientSubmitID] = delivery
	}
	onSend := target.onNextSend
	target.onNextSend = nil
	if target.failAfterCanonical {
		target.failAfterCanonical = false
		target.mu.Unlock()
		return tuttimodeexecutionservice.ReviewerDelivery{}, errors.New("injected reviewer response loss after canonical Turn")
	}
	target.mu.Unlock()
	if onSend != nil {
		if err := onSend(launch, delivery); err != nil {
			return tuttimodeexecutionservice.ReviewerDelivery{}, err
		}
	}
	return delivery, nil
}

func (target *recordingReviewerTarget) ReadReviewer(
	_ context.Context,
	launch tuttimodeexecutionservice.ReviewerLaunch,
) (tuttimodeexecutionservice.ReviewerDelivery, bool, error) {
	target.mu.Lock()
	defer target.mu.Unlock()
	delivery, found := target.canonicalByClientSubmit[launch.ClientSubmitID]
	return delivery, found, nil
}

func (launcher *recordingLauncher) Launch(_ context.Context, launch workspaceservice.IssueRunLaunch) error {
	launcher.mu.Lock()
	launcher.calls++
	if launcher.callSignal != nil {
		close(launcher.callSignal)
		launcher.callSignal = make(chan struct{})
	}
	launcher.clientSubmitIDs = append(launcher.clientSubmitIDs, launch.ClientSubmitID)
	failBeforeCanonical := launcher.failBeforeCanonical
	launcher.failBeforeCanonical = false
	if failBeforeCanonical {
		launcher.mu.Unlock()
		return workspaceservice.NewIssueRunLaunchNotStartedError(
			fmt.Errorf("injected authoritative launch failure before canonical Turn creation"),
		)
	}
	fail := launcher.failNext
	if launcher.failNext {
		launcher.failNext = false
	}
	block := launcher.blockNext
	failAfterBlock := launcher.failAfterBlock
	launcher.failAfterBlock = false
	started := launcher.started
	release := launcher.release
	launcher.blockNext = false
	launcher.mu.Unlock()
	if block {
		close(started)
		<-release
	}
	if failAfterBlock {
		return workspaceservice.NewIssueRunLaunchNotStartedError(
			fmt.Errorf("injected stale authoritative launch failure"),
		)
	}
	launcher.mu.Lock()
	if launcher.canonicalByClientSubmit == nil {
		launcher.canonicalByClientSubmit = make(map[string]string)
	}
	if _, exists := launcher.canonicalByClientSubmit[launch.ClientSubmitID]; !exists {
		launcher.canonicalByClientSubmit[launch.ClientSubmitID] = fmt.Sprintf(
			"turn-%d", len(launcher.canonicalByClientSubmit)+1,
		)
	}
	launcher.mu.Unlock()
	if fail {
		return fmt.Errorf("injected launch failure after canonical Turn creation")
	}
	return nil
}

func newSQLiteConformanceDriver(t *testing.T) *sqliteConformanceDriver {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "tutti.sqlite")
	store, err := workspacedata.OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	if err := store.Create(context.Background(), workspacebiz.Summary{
		ID:   "workspace-materialization",
		Name: "Materialization",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	clock := &controlledClock{now: now}
	launcher := &recordingLauncher{}
	renewals := &manualLeaseRenewalScheduler{}
	canceller := &recordingRunCanceller{}
	wakeTarget := newRecordingMainWakeTarget()
	wakeStore := newInjectableWakeStore(store)
	reviewer := &recordingReviewerTarget{
		busyBySession:           make(map[string]bool),
		canonicalByClientSubmit: make(map[string]tuttimodeexecutionservice.ReviewerDelivery),
	}
	automationTurns := &recordingAutomationTurnCanceller{}
	executions := &tuttimodeexecutionservice.Service{
		Store: store, Wakes: wakeStore, MainWakeTargets: wakeTarget,
		ReviewerActivity: store, ReviewerTargets: reviewer, Clock: clock.Now,
		ArchiveAutomationTurns: automationTurns,
	}
	driver := &sqliteConformanceDriver{
		dbPath: dbPath, store: store,
		issues: workspaceservice.IssueManagerService{
			Store: store, RunLauncher: launcher, TuttiModeExecutions: executions,
			SourceSessionContextResolver:    conformanceSourceSessionContextResolver{},
			MutationLocks:                   workspaceservice.NewIssueMutationLocks(),
			TuttiModeRunLaunchLeaseDuration: time.Minute,
			RunLaunchLeaseRenewalScheduler:  renewals,
			RunCancellationRequester:        canceller,
		},
		executions:         executions,
		revisions:          workspacedata.WorkflowRevisionFiles{StateDir: t.TempDir()},
		clock:              clock,
		launcher:           launcher,
		renewals:           renewals,
		canceller:          canceller,
		wakeTarget:         wakeTarget,
		wakeStore:          wakeStore,
		reviewer:           reviewer,
		automationTurns:    automationTurns,
		deletionAdmissions: make(map[string]executionbiz.SourceSessionDeletionAdmission),
	}
	driver.executions.Archives = store
	driver.executions.ArchiveRuns = &workspaceservice.IssueExecutionCoordinator{
		Issues: &driver.issues, RunSessionCanceller: canceller,
	}
	executions.BeforeGoalReviewCommitStep = driver.beforeGoalReviewCommitStep
	driver.plans = &tuttimodeplanservice.Service{
		Store:             store,
		Revisions:         driver.revisions,
		IssueMaterializer: tuttimodeplanservice.WorkspaceIssueMaterializer{Issues: &driver.issues},
		Now:               clock.Now,
	}
	return driver
}

func (driver *sqliteConformanceDriver) AcceptPlan(
	ctx context.Context,
	input tuttimodeexecutionconformance.AcceptPlanInput,
) (string, error) {
	now := driver.clock.Now()
	tasks := make([]tuttimodeplanservice.PlanTask, 0, len(input.Tasks))
	for _, task := range input.Tasks {
		tasks = append(tasks, tuttimodeplanservice.PlanTask{
			ID:                 task.TaskID,
			Title:              task.Title,
			Content:            task.Content,
			Priority:           task.Priority,
			AgentTargetID:      task.AgentTargetID,
			Model:              task.Model,
			PermissionModeID:   task.PermissionModeID,
			ExecutionDirectory: task.ExecutionDirectory,
			DependsOn:          append([]string(nil), task.DependencyTaskIDs...),
			Parallelizable:     task.Parallelizable,
			AutoAccept:         task.AutoAccept,
		})
	}
	frontmatter, err := yaml.Marshal(tuttimodeplanservice.PlanDocument{
		Schema:  tuttimodeplanservice.SchemaV1,
		Phase:   tuttimodeplanservice.PhaseTaskGraph,
		Title:   input.Title,
		TopicID: input.TopicID,
		Execution: tuttimodeplanservice.PlanExecution{
			Mode:                   "sequential",
			ReasoningIntensity:     50,
			OrchestrationIntensity: 50,
		},
		Budget: tuttimodeplanservice.PlanBudget{
			Mode:       firstNonEmptyConformance(input.BudgetMode, "auto"),
			TokenLimit: input.TokenLimit,
		},
		Review: tuttimodeplanservice.PlanReview{
			Mode:          input.ReviewMode,
			AgentTargetID: input.ReviewAgentTargetID,
		},
		Tasks: tasks,
	})
	if err != nil {
		return "", fmt.Errorf("encode plan revision: %w", err)
	}
	raw := []byte("---\n" + string(frontmatter) + "---\n" + input.Content + "\n")
	documentPath, digest, err := driver.revisions.Write(input.WorkflowID, raw)
	if err != nil {
		return "", fmt.Errorf("write plan revision: %w", err)
	}
	if err := driver.store.CreateWorkspaceWorkflowProposal(ctx, workflowbiz.ProposalAggregate{
		Workflow: workflowbiz.Workflow{
			ID:                input.WorkflowID,
			WorkspaceID:       input.WorkspaceID,
			Type:              workflowbiz.WorkflowTypeTuttiModePlan,
			Owner:             workflowbiz.WorkflowOwnerTutti,
			TriggerKind:       workflowbiz.TriggerKindAgentCLI,
			SourceSessionID:   input.SourceSessionID,
			Status:            workflowbiz.WorkflowStatusPendingReview,
			CurrentRevisionID: input.RevisionID,
			CreatedAt:         now,
			UpdatedAt:         now,
		},
		Plan: workflowbiz.TuttiModePlan{WorkflowID: input.WorkflowID},
		Revision: workflowbiz.PlanRevision{
			ID:            input.RevisionID,
			WorkflowID:    input.WorkflowID,
			Sequence:      1,
			SchemaVersion: tuttimodeplanservice.SchemaV1,
			DocumentPath:  documentPath,
			SHA256:        digest,
			CreatedAt:     now,
		},
		Checkpoint: workflowbiz.WorkflowCheckpoint{
			ID:         input.CheckpointID,
			WorkflowID: input.WorkflowID,
			Kind:       workflowbiz.CheckpointKindTaskReview,
			RevisionID: input.RevisionID,
			Status:     workflowbiz.CheckpointStatusPending,
			CreatedAt:  now,
			UpdatedAt:  now,
		},
	}); err != nil {
		return "", fmt.Errorf("seed pending plan review: %w", err)
	}
	result, err := driver.plans.Decide(ctx, tuttimodeplanservice.DecideInput{
		WorkspaceID:  input.WorkspaceID,
		WorkflowID:   input.WorkflowID,
		CheckpointID: input.CheckpointID,
		Decision:     workflowbiz.CheckpointStatusAccepted,
		DecidedBy:    "conformance-user",
	})
	if err != nil {
		return "", err
	}
	if result.Operation == nil ||
		result.Operation.Status != workflowbiz.OperationStatusSucceeded ||
		result.Operation.IssueID == "" {
		return "", fmt.Errorf("accept plan operation = %#v, want succeeded create_issue", result.Operation)
	}
	return result.Operation.IssueID, nil
}

func (driver *sqliteConformanceDriver) GetIssueByID(
	ctx context.Context,
	workspaceID string,
	issueID string,
) (tuttimodeexecutionconformance.Issue, []tuttimodeexecutionconformance.Task, error) {
	detail, err := driver.issues.GetIssueDetail(ctx, workspaceID, issueID)
	if err != nil {
		return tuttimodeexecutionconformance.Issue{}, nil, err
	}
	issue := tuttimodeexecutionconformance.Issue{
		WorkspaceID:     detail.Issue.WorkspaceID,
		IssueID:         detail.Issue.IssueID,
		TopicID:         detail.Issue.TopicID,
		Title:           detail.Issue.Title,
		Content:         detail.Issue.Content,
		Status:          string(detail.Issue.Status),
		TaskCount:       detail.Issue.TaskCount,
		CompletedCount:  detail.Issue.CompletedCount,
		CanceledCount:   detail.Issue.CanceledCount,
		PlanningSource:  string(detail.Issue.PlanningSource),
		SourceSessionID: detail.Issue.SourceSessionID,
	}
	tasks := make([]tuttimodeexecutionconformance.Task, 0, len(detail.Tasks))
	for _, task := range detail.Tasks {
		tasks = append(tasks, tuttimodeexecutionconformance.Task{
			TaskID:             task.TaskID,
			Title:              task.Title,
			Content:            task.Content,
			Status:             string(task.Status),
			AcceptanceState:    string(task.AcceptanceState),
			Priority:           string(task.Priority),
			SortIndex:          task.SortIndex,
			AgentTargetID:      task.AgentTargetID,
			Model:              task.Model,
			PermissionModeID:   task.PermissionModeID,
			ExecutionDirectory: task.ExecutionDirectory,
			DependencyTaskIDs:  append([]string(nil), task.DependencyTaskIDs...),
			Parallelizable:     task.Parallelizable,
			AutoAccept:         task.AutoAccept,
			SupersededAtUnixMS: task.SupersededAtUnixMS,
			SupersededByTaskID: task.SupersededByTaskID,
		})
	}
	return issue, tasks, nil
}

func (driver *sqliteConformanceDriver) Mutate(
	ctx context.Context,
	input tuttimodeexecutionconformance.MutateInput,
) (tuttimodeexecutionconformance.MutateResult, error) {
	return driver.mutateWith(ctx, driver.executions, input)
}

func (driver *sqliteConformanceDriver) MutateReplica(
	ctx context.Context,
	input tuttimodeexecutionconformance.MutateInput,
) (tuttimodeexecutionconformance.MutateResult, error) {
	replica := &tuttimodeexecutionservice.Service{
		Store: driver.store, Wakes: driver.wakeStore, Clock: driver.clock.Now,
	}
	return driver.mutateWith(ctx, replica, input)
}

func (*sqliteConformanceDriver) mutateWith(
	ctx context.Context,
	service *tuttimodeexecutionservice.Service,
	input tuttimodeexecutionconformance.MutateInput,
) (tuttimodeexecutionconformance.MutateResult, error) {
	operations := make([]executionbiz.MutationOperation, 0, len(input.Operations))
	for _, operation := range input.Operations {
		taskFields := executionbiz.MutationTaskFields{
			Title:              operation.Task.Title != "",
			Content:            operation.Task.Content != "",
			Priority:           operation.Task.Priority != "",
			AgentTargetID:      operation.Task.AgentTargetID != "",
			Model:              operation.Task.Model != "",
			PermissionModeID:   operation.Task.PermissionModeID != "",
			ExecutionDirectory: operation.Task.ExecutionDirectory != "",
			DependencyTaskIDs:  operation.Task.DependencyTaskIDs != nil,
			Parallelizable:     operation.Task.Parallelizable,
			AutoAccept:         operation.Task.AutoAccept,
		}
		operations = append(operations, executionbiz.MutationOperation{
			Kind:   executionbiz.MutationOperationKind(operation.Kind),
			TaskID: operation.TaskID,
			Task: workspaceissues.Task{
				TaskID: operation.Task.TaskID, Title: operation.Task.Title,
				Content: operation.Task.Content, Priority: workspaceissues.Priority(operation.Task.Priority),
				AgentTargetID: operation.Task.AgentTargetID, Model: operation.Task.Model,
				PermissionModeID:   operation.Task.PermissionModeID,
				ExecutionDirectory: operation.Task.ExecutionDirectory,
				DependencyTaskIDs:  append([]string(nil), operation.Task.DependencyTaskIDs...),
				Parallelizable:     operation.Task.Parallelizable,
				AutoAccept:         operation.Task.AutoAccept,
			},
			TaskFields: taskFields,
		})
	}
	result, err := service.Mutate(ctx, tuttimodeexecutionservice.MutateInput{
		WorkspaceID: input.WorkspaceID, IssueID: input.IssueID,
		SourceSessionID: input.SourceSessionID, CheckpointID: input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision,
		Operations:            operations, RequestID: input.RequestID,
	})
	if err != nil {
		return tuttimodeexecutionconformance.MutateResult{}, err
	}
	return tuttimodeexecutionconformance.MutateResult{
		ExecutionID: result.ExecutionID, CheckpointID: result.CheckpointID,
		GraphRevision:     result.GraphRevision,
		AddedTaskIDs:      append([]string(nil), result.AddedTaskIDs...),
		UpdatedTaskIDs:    append([]string(nil), result.UpdatedTaskIDs...),
		SupersededTaskIDs: append([]string(nil), result.SupersededTaskIDs...),
		Replayed:          result.Replayed,
	}, nil
}

func (driver *sqliteConformanceDriver) GetSnapshot(
	ctx context.Context,
	workspaceID string,
	issueID string,
) (tuttimodeexecutionconformance.Snapshot, error) {
	issue, tasks, err := driver.GetIssueByID(ctx, workspaceID, issueID)
	if err != nil {
		return tuttimodeexecutionconformance.Snapshot{}, err
	}
	execution, checkpoints, err := driver.GetExecutionByIssue(ctx, workspaceID, issueID)
	if err != nil {
		return tuttimodeexecutionconformance.Snapshot{}, err
	}
	runCount, err := driver.CountRuns(ctx, workspaceID, issueID)
	if err != nil {
		return tuttimodeexecutionconformance.Snapshot{}, err
	}
	runs, err := driver.issues.ListRuns(ctx, workspaceID, issueID, "")
	if err != nil {
		return tuttimodeexecutionconformance.Snapshot{}, err
	}
	snapshotRuns := make([]tuttimodeexecutionconformance.RunSnapshot, 0, len(runs))
	outputCount := 0
	for _, run := range runs {
		snapshotRuns = append(snapshotRuns, tuttimodeexecutionconformance.RunSnapshot{
			RunID: run.RunID, TaskID: run.TaskID, Status: string(run.Status),
		})
		outputs, outputErr := driver.store.ListRunOutputs(
			ctx, workspaceID, issueID, run.TaskID, run.RunID,
		)
		if outputErr != nil {
			return tuttimodeexecutionconformance.Snapshot{}, outputErr
		}
		outputCount += len(outputs)
	}
	reviews, err := driver.executions.ListGoalReviews(ctx, workspaceID, issueID)
	if err != nil {
		return tuttimodeexecutionconformance.Snapshot{}, err
	}
	audit, err := driver.executions.ListGoalReviewAudit(ctx, workspaceID, issueID)
	if err != nil {
		return tuttimodeexecutionconformance.Snapshot{}, err
	}
	snapshotReviews := make([]tuttimodeexecutionconformance.GoalReview, 0, len(reviews))
	for _, review := range reviews {
		snapshotReviews = append(snapshotReviews, tuttimodeexecutionconformance.GoalReview{
			ReviewID: review.ID, CheckpointID: review.CheckpointID,
			AgentTargetID: review.AgentTargetID, ClientSubmitID: review.ClientSubmitID,
			SessionID: review.SessionID, TurnID: review.TurnID,
			Status: string(review.Status), Verdict: string(review.Verdict),
			Summary: review.Summary, FailureReason: review.FailureReason,
			AttemptCount: review.AttemptCount, LeaseOwner: review.LeaseOwner,
			LeaseExpiresAt: review.LeaseExpiresAt,
		})
	}
	snapshotAudit := make([]tuttimodeexecutionconformance.ReviewAuditEntry, 0, len(audit))
	for _, entry := range audit {
		snapshotAudit = append(snapshotAudit, tuttimodeexecutionconformance.ReviewAuditEntry{
			Kind: entry.Kind, ActorID: entry.ActorID, Reason: entry.Reason,
			ReviewID: entry.ReviewID, CreatedAt: entry.CreatedAt,
		})
	}
	return tuttimodeexecutionconformance.Snapshot{
		Issue:       issue,
		Tasks:       tasks,
		Execution:   execution,
		Checkpoints: checkpoints,
		RunCount:    runCount,
		Runs:        snapshotRuns,
		OutputCount: outputCount,
		Reviews:     snapshotReviews,
		Audit:       snapshotAudit,
	}, nil
}

func (driver *sqliteConformanceDriver) Schedule(
	ctx context.Context,
	input tuttimodeexecutionconformance.ScheduleInput,
) (tuttimodeexecutionconformance.ScheduleResult, error) {
	result, err := driver.issues.ScheduleTuttiModeIssue(ctx, input.WorkspaceID, workspaceservice.ScheduleTuttiModeIssueInput{
		IssueID:               input.IssueID,
		SourceSessionID:       input.SourceSessionID,
		CheckpointID:          input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision,
		TaskIDs:               append([]string(nil), input.TaskIDs...),
		RequestID:             input.RequestID,
	})
	if err != nil {
		return tuttimodeexecutionconformance.ScheduleResult{}, err
	}
	return tuttimodeexecutionconformance.ScheduleResult{
		ExecutionID:   result.ExecutionID,
		CheckpointID:  result.CheckpointID,
		GraphRevision: result.GraphRevision,
		RunIDs:        append([]string(nil), result.RunIDs...),
		Replayed:      result.Replayed,
	}, nil
}

func (driver *sqliteConformanceDriver) ScheduleReplica(
	ctx context.Context,
	input tuttimodeexecutionconformance.ScheduleInput,
) (tuttimodeexecutionconformance.ScheduleResult, error) {
	replica := driver.issues
	replica.MutationLocks = workspaceservice.NewIssueMutationLocks()
	replica.RunLaunchGate = workspaceservice.NewIssueRunLaunchGate()
	result, err := replica.ScheduleTuttiModeIssue(ctx, input.WorkspaceID, workspaceservice.ScheduleTuttiModeIssueInput{
		IssueID:               input.IssueID,
		SourceSessionID:       input.SourceSessionID,
		CheckpointID:          input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision,
		TaskIDs:               append([]string(nil), input.TaskIDs...),
		RequestID:             input.RequestID,
	})
	if err != nil {
		return tuttimodeexecutionconformance.ScheduleResult{}, err
	}
	return tuttimodeexecutionconformance.ScheduleResult{
		ExecutionID: result.ExecutionID, CheckpointID: result.CheckpointID,
		GraphRevision: result.GraphRevision, RunIDs: append([]string(nil), result.RunIDs...),
		Replayed: result.Replayed,
	}, nil
}

func (driver *sqliteConformanceDriver) SettleRun(
	ctx context.Context,
	input tuttimodeexecutionconformance.SettleRunInput,
) error {
	completeInput := workspaceservice.CompleteIssueManagerRunInput{Status: input.Status}
	if input.Status == string(workspaceissues.StatusCompleted) {
		completeInput.Outputs = []workspaceissues.CompleteRunOutputInput{{
			OutputID: "output-" + input.RunID, Path: "result.txt",
			DisplayName: "Result", MediaType: "text/plain", SizeBytes: 6,
		}}
	}
	_, err := driver.issues.CompleteRun(
		ctx,
		input.WorkspaceID,
		input.IssueID,
		input.TaskID,
		input.RunID,
		completeInput,
	)
	return err
}

func (driver *sqliteConformanceDriver) SettleRunReplica(
	ctx context.Context,
	input tuttimodeexecutionconformance.SettleRunInput,
) error {
	replica := driver.issues
	replica.MutationLocks = workspaceservice.NewIssueMutationLocks()
	replica.RunLaunchGate = workspaceservice.NewIssueRunLaunchGate()
	_, err := replica.CompleteRun(
		ctx,
		input.WorkspaceID,
		input.IssueID,
		input.TaskID,
		input.RunID,
		workspaceservice.CompleteIssueManagerRunInput{Status: input.Status},
	)
	return err
}

func (driver *sqliteConformanceDriver) TimeoutRun(
	ctx context.Context,
	input tuttimodeexecutionconformance.SettleRunInput,
) error {
	detail, err := driver.issues.GetRunDetail(
		ctx,
		input.WorkspaceID,
		input.IssueID,
		input.TaskID,
		input.RunID,
	)
	if err != nil {
		return fmt.Errorf("get Run before timeout reconciliation: %w", err)
	}
	startedAtUnixMS := detail.Run.StartedAtUnixMS
	if startedAtUnixMS <= 0 {
		startedAtUnixMS = detail.Run.CreatedAtUnixMS
	}
	driver.clock.Set(time.UnixMilli(startedAtUnixMS).UTC().Add(46 * time.Minute))
	coordinator := &workspaceservice.IssueExecutionCoordinator{
		Issues:              &driver.issues,
		RunSessionCanceller: driver.canceller,
		Clock:               driver.clock.Now,
	}
	_, err = coordinator.ReconcileRunningRuns(ctx, input.WorkspaceID)
	return err
}

func (driver *sqliteConformanceDriver) ClaimRunLaunchReplica(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
) (bool, error) {
	return driver.executions.ClaimRunLaunch(
		ctx, workspaceID, issueID, runID, "replica-claim", time.Minute,
	)
}

func (driver *sqliteConformanceDriver) FailNextLaunchAuthoritatively() {
	driver.launcher.mu.Lock()
	defer driver.launcher.mu.Unlock()
	driver.launcher.failBeforeCanonical = true
}

func (driver *sqliteConformanceDriver) HoldNextLaunchThenFailAuthoritatively() (<-chan struct{}, func()) {
	driver.launcher.mu.Lock()
	defer driver.launcher.mu.Unlock()
	driver.launcher.blockNext = true
	driver.launcher.failAfterBlock = true
	driver.launcher.started = make(chan struct{})
	driver.launcher.release = make(chan struct{})
	started := driver.launcher.started
	release := driver.launcher.release
	var once sync.Once
	return started, func() {
		once.Do(func() { close(release) })
	}
}

func (driver *sqliteConformanceDriver) PersistTerminalRunWithoutCheckpoint(
	ctx context.Context,
	input tuttimodeexecutionconformance.SettleRunInput,
) error {
	run, err := driver.store.GetRun(ctx, input.WorkspaceID, input.IssueID, input.TaskID, input.RunID)
	if err != nil {
		return err
	}
	run.Status = workspaceissues.Status(input.Status)
	run.CompletedAtUnixMS = driver.clock.Now().UnixMilli()
	run.UpdatedAtUnixMS = run.CompletedAtUnixMS
	if _, _, err := driver.store.CompleteRun(ctx, run, nil); err != nil {
		return err
	}
	task, err := driver.store.GetTask(ctx, input.WorkspaceID, input.IssueID, input.TaskID)
	if err != nil {
		return err
	}
	switch run.Status {
	case workspaceissues.StatusCompleted:
		task.Status = workspaceissues.StatusPendingAcceptance
	case workspaceissues.StatusFailed:
		task.Status = workspaceissues.StatusFailed
	case workspaceissues.StatusCanceled:
		task.Status = workspaceissues.StatusCanceled
	}
	task.UpdatedAtUnixMS = run.UpdatedAtUnixMS
	if _, err := driver.store.UpdateTask(ctx, task); err != nil {
		return err
	}
	_, err = driver.store.RecalculateIssueProjection(ctx, input.WorkspaceID, input.IssueID)
	return err
}

func (driver *sqliteConformanceDriver) RepairSettlements(
	ctx context.Context,
	workspaceID string,
) error {
	_, err := driver.executions.RepairRunSettlements(ctx, workspaceID)
	return err
}

func (driver *sqliteConformanceDriver) Acknowledge(
	ctx context.Context,
	input tuttimodeexecutionconformance.AcknowledgeInput,
) (tuttimodeexecutionconformance.AcknowledgeResult, error) {
	result, err := driver.executions.Acknowledge(ctx, tuttimodeexecutionservice.AcknowledgeInput{
		WorkspaceID: input.WorkspaceID, IssueID: input.IssueID,
		SourceSessionID: input.SourceSessionID, CheckpointID: input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision, RequestID: input.RequestID,
	})
	if err != nil {
		return tuttimodeexecutionconformance.AcknowledgeResult{}, err
	}
	return tuttimodeexecutionconformance.AcknowledgeResult{
		ExecutionID: result.ExecutionID, CheckpointID: result.CheckpointID,
		GraphRevision: result.GraphRevision, NextCheckpointID: result.NextCheckpointID,
		NextCheckpointKind:  string(result.NextCheckpointKind),
		NextCheckpointState: string(result.NextCheckpointState),
		Replayed:            result.Replayed,
	}, nil
}

func (driver *sqliteConformanceDriver) AcknowledgeReplica(
	ctx context.Context,
	input tuttimodeexecutionconformance.AcknowledgeInput,
) (tuttimodeexecutionconformance.AcknowledgeResult, error) {
	return driver.Acknowledge(ctx, input)
}

func (driver *sqliteConformanceDriver) Complete(
	ctx context.Context,
	input tuttimodeexecutionconformance.CompleteInput,
) (tuttimodeexecutionconformance.CompleteResult, error) {
	result, err := driver.executions.Complete(ctx, tuttimodeexecutionservice.CompleteInput{
		WorkspaceID: input.WorkspaceID, IssueID: input.IssueID,
		SourceSessionID: input.SourceSessionID, CheckpointID: input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision,
		RequestID:             input.RequestID, Decision: input.Decision,
		DisagreementReason: input.DisagreementReason,
	})
	if err != nil {
		return tuttimodeexecutionconformance.CompleteResult{}, err
	}
	return tuttimodeexecutionconformance.CompleteResult{
		ExecutionID: result.ExecutionID, CheckpointID: result.CheckpointID,
		GraphRevision: result.GraphRevision, Decision: result.Decision,
		Replayed: result.Replayed,
	}, nil
}

func (driver *sqliteConformanceDriver) CompleteReplica(
	ctx context.Context,
	input tuttimodeexecutionconformance.CompleteInput,
) (tuttimodeexecutionconformance.CompleteResult, error) {
	return driver.Complete(ctx, input)
}

func (driver *sqliteConformanceDriver) SubmitReviewerVerdict(
	ctx context.Context,
	input tuttimodeexecutionconformance.ReviewerVerdictInput,
) (tuttimodeexecutionconformance.ReviewerVerdictResult, error) {
	result, err := driver.executions.SubmitReviewerVerdict(ctx, tuttimodeexecutionservice.ReviewerVerdictInput{
		WorkspaceID: input.WorkspaceID, IssueID: input.IssueID,
		ReviewID: input.ReviewID, ReviewSessionID: input.ReviewSessionID,
		ReviewTurnID: input.ReviewTurnID, CheckpointID: input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision,
		RequestID:             input.RequestID, Verdict: input.Verdict, Summary: input.Summary,
	})
	if err != nil {
		return tuttimodeexecutionconformance.ReviewerVerdictResult{}, err
	}
	return tuttimodeexecutionconformance.ReviewerVerdictResult{
		ReviewID: result.ReviewID, Verdict: result.Verdict, Replayed: result.Replayed,
	}, nil
}

func (driver *sqliteConformanceDriver) SubmitReviewerVerdictReplica(
	ctx context.Context,
	input tuttimodeexecutionconformance.ReviewerVerdictInput,
) (tuttimodeexecutionconformance.ReviewerVerdictResult, error) {
	return driver.SubmitReviewerVerdict(ctx, input)
}

func (driver *sqliteConformanceDriver) SwitchReviewToSelf(
	ctx context.Context,
	input tuttimodeexecutionconformance.SwitchReviewToSelfInput,
) (tuttimodeexecutionconformance.SwitchReviewToSelfResult, error) {
	result, err := driver.executions.SwitchReviewToSelf(ctx, tuttimodeexecutionservice.SwitchReviewToSelfInput{
		WorkspaceID: input.WorkspaceID, IssueID: input.IssueID,
		CheckpointID:          input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision,
		RequestID:             input.RequestID, Reason: input.Reason,
		RequestedByActorID: input.RequestedBy,
	})
	if err != nil {
		return tuttimodeexecutionconformance.SwitchReviewToSelfResult{}, err
	}
	return tuttimodeexecutionconformance.SwitchReviewToSelfResult{
		ExecutionID: result.ExecutionID, ReviewID: result.ReviewID,
		Replayed: result.Replayed,
	}, nil
}

func (driver *sqliteConformanceDriver) SwitchReviewToSelfReplica(
	ctx context.Context,
	input tuttimodeexecutionconformance.SwitchReviewToSelfInput,
) (tuttimodeexecutionconformance.SwitchReviewToSelfResult, error) {
	return driver.SwitchReviewToSelf(ctx, input)
}

func (driver *sqliteConformanceDriver) ClaimReviewer(
	ctx context.Context,
	workspaceID string,
	reviewID string,
	leaseOwner string,
	duration time.Duration,
) (bool, error) {
	return driver.executions.ClaimReviewer(
		ctx, workspaceID, reviewID, leaseOwner, duration,
	)
}

func (driver *sqliteConformanceDriver) RecoverReviewers(ctx context.Context, workspaceID string, owner string) error {
	return driver.executions.RecoverReviewers(ctx, workspaceID, owner)
}

func (driver *sqliteConformanceDriver) StartupRecoverReviewers(ctx context.Context, workspaceID string, owner string) error {
	replica := &tuttimodeexecutionservice.Service{
		Store: driver.store, ReviewerTargets: driver.reviewer,
		ReviewerActivity: driver.store, Clock: driver.clock.Now,
		BeforeGoalReviewCommitStep: driver.beforeGoalReviewCommitStep,
	}
	return replica.RecoverReviewers(ctx, workspaceID, owner)
}

func (driver *sqliteConformanceDriver) SettleReviewerTurnWithoutVerdict(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	turnID string,
	finalText string,
) error {
	return driver.executions.SettleReviewerTurnWithoutVerdict(
		ctx, workspaceID, sessionID, turnID, finalText,
	)
}

func (driver *sqliteConformanceDriver) SetReviewerSessionBusy(sessionID string, busy bool) {
	driver.reviewer.mu.Lock()
	defer driver.reviewer.mu.Unlock()
	driver.reviewer.busyBySession[sessionID] = busy
}

func (driver *sqliteConformanceDriver) FailNextGoalReviewCommit(step string) {
	driver.reviewMu.Lock()
	defer driver.reviewMu.Unlock()
	driver.failReviewStep = step
}

func (driver *sqliteConformanceDriver) beforeGoalReviewCommitStep(step string) error {
	driver.reviewMu.Lock()
	defer driver.reviewMu.Unlock()
	if driver.failReviewStep != step {
		return nil
	}
	driver.failReviewStep = ""
	return fmt.Errorf("injected Goal Review %s transaction failure", step)
}

func (driver *sqliteConformanceDriver) FailNextReviewerBeforeCanonical() {
	driver.reviewer.mu.Lock()
	defer driver.reviewer.mu.Unlock()
	driver.reviewer.failBeforeCanonical = true
}

func (driver *sqliteConformanceDriver) FailNextReviewerAfterCanonical() {
	driver.reviewer.mu.Lock()
	defer driver.reviewer.mu.Unlock()
	driver.reviewer.failAfterCanonical = true
}

func (driver *sqliteConformanceDriver) SubmitReviewerVerdictOnNextSend(
	input tuttimodeexecutionconformance.ReviewerVerdictInput,
) {
	driver.reviewer.mu.Lock()
	defer driver.reviewer.mu.Unlock()
	driver.reviewer.onNextSend = func(
		_ tuttimodeexecutionservice.ReviewerLaunch,
		delivery tuttimodeexecutionservice.ReviewerDelivery,
	) error {
		_, err := driver.executions.SubmitReviewerVerdict(
			context.Background(),
			tuttimodeexecutionservice.ReviewerVerdictInput{
				WorkspaceID: input.WorkspaceID, IssueID: input.IssueID,
				ReviewID:              input.ReviewID,
				ReviewSessionID:       delivery.CanonicalSessionID,
				ReviewTurnID:          delivery.CanonicalTurnID,
				CheckpointID:          input.CheckpointID,
				ExpectedGraphRevision: input.ExpectedGraphRevision,
				RequestID:             input.RequestID, Verdict: input.Verdict,
				Summary: input.Summary,
			},
		)
		return err
	}
}

func (driver *sqliteConformanceDriver) SettleReviewerOnNextSend() {
	driver.reviewer.mu.Lock()
	defer driver.reviewer.mu.Unlock()
	driver.reviewer.settleNext = true
}

func (driver *sqliteConformanceDriver) ReviewerLaunchCallCount() int {
	driver.reviewer.mu.Lock()
	defer driver.reviewer.mu.Unlock()
	return driver.reviewer.calls
}

func (driver *sqliteConformanceDriver) ReviewerCanonicalTurnCount() int {
	driver.reviewer.mu.Lock()
	defer driver.reviewer.mu.Unlock()
	return len(driver.reviewer.canonicalByClientSubmit)
}

func (driver *sqliteConformanceDriver) ReviewerCanonicalIdentity(clientSubmitID string) (string, string, bool) {
	driver.reviewer.mu.Lock()
	defer driver.reviewer.mu.Unlock()
	delivery, found := driver.reviewer.canonicalByClientSubmit[clientSubmitID]
	return delivery.CanonicalSessionID, delivery.CanonicalTurnID, found
}

func (driver *sqliteConformanceDriver) ReviewerCapabilities() []string {
	driver.reviewer.mu.Lock()
	defer driver.reviewer.mu.Unlock()
	return append([]string(nil), driver.reviewer.capabilities...)
}

func (driver *sqliteConformanceDriver) Archive(
	ctx context.Context,
	input tuttimodeexecutionconformance.ArchiveInput,
) (tuttimodeexecutionconformance.ArchiveOperation, error) {
	operation, err := driver.executions.Archive(ctx, tuttimodeexecutionservice.ArchiveInput{
		WorkspaceID: input.WorkspaceID, IssueID: input.IssueID,
		RequestID: input.RequestID, RequestedBy: input.RequestedBy, Reason: input.Reason,
		SourceSessionID: input.SourceSessionID, CheckpointID: input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision,
	})
	return conformanceArchiveOperation(operation), err
}

func (driver *sqliteConformanceDriver) GetArchive(
	ctx context.Context, workspaceID, operationID string,
) (tuttimodeexecutionconformance.ArchiveOperation, error) {
	operation, err := driver.executions.GetArchive(ctx, workspaceID, operationID)
	return conformanceArchiveOperation(operation), err
}

func (driver *sqliteConformanceDriver) RestartRecoverArchives(
	ctx context.Context, workspaceID string,
) error {
	replica := &tuttimodeexecutionservice.Service{
		Store: driver.store, Wakes: driver.wakeStore, Archives: driver.store,
		ArchiveAutomationTurns: driver.automationTurns,
		ArchiveRuns: &workspaceservice.IssueExecutionCoordinator{
			Issues: &driver.issues, RunSessionCanceller: driver.canceller,
		},
		Clock: driver.clock.Now,
	}
	return replica.RecoverArchives(ctx, workspaceID)
}

func (driver *sqliteConformanceDriver) AutomationTurnCancellations() []tuttimodeexecutionconformance.AutomationTurnCancellation {
	driver.automationTurns.mu.Lock()
	defer driver.automationTurns.mu.Unlock()
	return append(
		[]tuttimodeexecutionconformance.AutomationTurnCancellation(nil),
		driver.automationTurns.cancellations...,
	)
}

func (driver *sqliteConformanceDriver) StopSourceSession(
	ctx context.Context,
	workspaceID string,
	sourceSessionID string,
) (int, error) {
	return driver.executions.StopSourceSession(
		ctx,
		tuttimodeexecutionservice.StopSourceSessionInput{
			WorkspaceID: workspaceID, SourceSessionID: sourceSessionID,
		},
	)
}

func (driver *sqliteConformanceDriver) StopSourceSessionDuringNextReviewerSend(
	workspaceID string,
	sourceSessionID string,
) {
	driver.reviewer.mu.Lock()
	defer driver.reviewer.mu.Unlock()
	driver.reviewer.onNextSend = func(
		tuttimodeexecutionservice.ReviewerLaunch,
		tuttimodeexecutionservice.ReviewerDelivery,
	) error {
		_, err := driver.StopSourceSession(
			context.Background(), workspaceID, sourceSessionID,
		)
		return err
	}
}

func (driver *sqliteConformanceDriver) AdmitSourceDeletion(
	ctx context.Context, workspaceID string, sessionIDs []string,
) error {
	normalized := append([]string(nil), sessionIDs...)
	slices.Sort(normalized)
	admission, err := driver.store.AdmitSourceSessionDeletion(ctx, executionbiz.SourceSessionDeletionAdmission{
		WorkspaceID: workspaceID, SessionIDs: normalized, Now: driver.clock.Now(),
	})
	if err == nil {
		driver.deletionAdmissions[workspaceID+"|"+strings.Join(normalized, "\x00")] = admission
	}
	return err
}

func (driver *sqliteConformanceDriver) ReleaseSourceDeletion(
	ctx context.Context, workspaceID string, sessionIDs []string, succeeded bool,
) error {
	normalized := append([]string(nil), sessionIDs...)
	slices.Sort(normalized)
	key := workspaceID + "|" + strings.Join(normalized, "\x00")
	admission := driver.deletionAdmissions[key]
	if admission.AdmissionID == "" {
		return fmt.Errorf("source deletion admission not found")
	}
	return driver.store.ReportSourceSessionDeletion(ctx, admission, succeeded, driver.clock.Now())
}

func conformanceArchiveOperation(
	operation executionbiz.ArchiveOperation,
) tuttimodeexecutionconformance.ArchiveOperation {
	return tuttimodeexecutionconformance.ArchiveOperation{
		OperationID: operation.OperationID, Status: string(operation.Status),
		RequestedBy: operation.RequestedBy, Reason: operation.Reason,
		LastError: operation.LastError, CompletedAt: operation.CompletedAt,
	}
}

func (driver *sqliteConformanceDriver) SeedActiveRun(
	ctx context.Context,
	workspaceID string,
	issueID string,
	taskID string,
) error {
	task, err := driver.store.GetTask(ctx, workspaceID, issueID, taskID)
	if err != nil {
		return err
	}
	now := driver.clock.Now().UnixMilli()
	run, err := driver.store.CreateRun(ctx, workspaceissues.Run{
		RunID: "seed-run-" + taskID, TaskID: taskID, IssueID: issueID,
		WorkspaceID: workspaceID, RequesterUserID: "conformance",
		AgentUserID: "conformance", AgentTargetID: task.AgentTargetID,
		AgentSessionID: "seed-session-" + taskID, Status: workspaceissues.StatusRunning,
		CreatedAtUnixMS: now, StartedAtUnixMS: now, UpdatedAtUnixMS: now,
	})
	if err != nil {
		return err
	}
	task.Status = workspaceissues.StatusRunning
	task.LatestRunID = run.RunID
	task.UpdatedAtUnixMS = now
	if _, err := driver.store.UpdateTask(ctx, task); err != nil {
		return err
	}
	_, err = driver.store.RecalculateIssueProjection(ctx, workspaceID, issueID)
	return err
}

func (driver *sqliteConformanceDriver) GetExecutionByIssue(
	ctx context.Context,
	workspaceID string,
	issueID string,
) (tuttimodeexecutionconformance.Execution, []tuttimodeexecutionconformance.Checkpoint, error) {
	aggregate, err := driver.executions.GetByIssue(ctx, workspaceID, issueID)
	if err != nil {
		return tuttimodeexecutionconformance.Execution{}, nil, err
	}
	execution := tuttimodeexecutionconformance.Execution{
		WorkspaceID:                aggregate.Execution.WorkspaceID,
		IssueID:                    aggregate.Execution.IssueID,
		WorkflowID:                 aggregate.Execution.WorkflowID,
		SourceSessionID:            aggregate.Execution.SourceSessionID,
		Status:                     string(aggregate.Execution.Status),
		GraphRevision:              aggregate.Execution.GraphRevision,
		LastOrchestratorActivityAt: aggregate.Execution.LastOrchestratorActivityAt,
		WatchdogDueAt:              aggregate.Execution.WatchdogDueAt,
		ReviewMode:                 string(aggregate.Execution.ReviewMode),
		ReviewAgentTargetID:        aggregate.Execution.ReviewAgentTargetID,
		CompletedAt:                aggregate.Execution.CompletedAt,
		ArchivedAt:                 aggregate.Execution.ArchivedAt,
		ArchivedBy:                 aggregate.Execution.ArchivedBy,
		ArchiveReason:              aggregate.Execution.ArchiveReason,
	}
	checkpoints := make([]tuttimodeexecutionconformance.Checkpoint, 0, len(aggregate.Checkpoints))
	for _, checkpoint := range aggregate.Checkpoints {
		checkpoints = append(checkpoints, tuttimodeexecutionconformance.Checkpoint{
			CheckpointID:  checkpoint.ID,
			Kind:          string(checkpoint.Kind),
			Status:        string(checkpoint.Status),
			Sequence:      checkpoint.Sequence,
			GraphRevision: checkpoint.GraphRevision,
			SubjectTaskID: checkpoint.SubjectTaskID,
			SubjectRunID:  checkpoint.SubjectRunID,
		})
	}
	return execution, checkpoints, nil
}

func (driver *sqliteConformanceDriver) CountRuns(ctx context.Context, workspaceID, issueID string) (int, error) {
	runs, err := driver.issues.ListRuns(ctx, workspaceID, issueID, "")
	return len(runs), err
}

func (driver *sqliteConformanceDriver) LauncherCallCount() int {
	driver.launcher.mu.Lock()
	defer driver.launcher.mu.Unlock()
	return driver.launcher.calls
}

func (driver *sqliteConformanceDriver) FailNextLaunch() {
	driver.launcher.mu.Lock()
	defer driver.launcher.mu.Unlock()
	driver.launcher.failNext = true
}

func (driver *sqliteConformanceDriver) HoldNextLaunch() (<-chan struct{}, func()) {
	driver.launcher.mu.Lock()
	defer driver.launcher.mu.Unlock()
	driver.launcher.blockNext = true
	driver.launcher.started = make(chan struct{})
	driver.launcher.release = make(chan struct{})
	started := driver.launcher.started
	release := driver.launcher.release
	var once sync.Once
	return started, func() {
		once.Do(func() { close(release) })
	}
}

func (driver *sqliteConformanceDriver) AdvanceClock(duration time.Duration) error {
	driver.clock.Advance(duration)
	return driver.renewals.Tick()
}

func (driver *sqliteConformanceDriver) StopLeaseRenewal() {
	driver.renewals.StopCurrent()
}

func (driver *sqliteConformanceDriver) AdvanceClockWithoutRenewal(duration time.Duration) {
	driver.clock.Advance(duration)
}

func (driver *sqliteConformanceDriver) RecoverLaunches(ctx context.Context, workspaceID string) error {
	return driver.issues.RecoverTuttiModeRunLaunchIntents(ctx, workspaceID)
}

func (driver *sqliteConformanceDriver) EnableAutomaticRecovery(ctx context.Context) {
	queueCtx, cancel := context.WithCancel(ctx)
	driver.cancelAuto = cancel
	coordinator := &workspaceservice.IssueExecutionCoordinator{
		Issues: &driver.issues, RunSessionCanceller: driver.canceller,
	}
	driver.issues.ExecutionRecoveryQueue = workspaceservice.NewWorkspaceExecutionRecoveryQueue(
		workspaceservice.WorkspaceExecutionRecoveryQueueOptions{
			Context:  queueCtx,
			Delay:    time.Millisecond,
			Interval: time.Millisecond,
			Reconcile: func(
				ctx context.Context, workspaceID string,
			) (workspaceservice.WorkspaceExecutionRecoveryResult, error) {
				runResult, err := coordinator.ReconcileTuttiModeRunLaunchesAndRunningRuns(ctx, workspaceID)
				if err != nil {
					return workspaceservice.WorkspaceExecutionRecoveryResult{}, err
				}
				pendingArchives, err := driver.executions.RecoverArchivesAndCount(ctx, workspaceID)
				return workspaceservice.WorkspaceExecutionRecoveryResult{
					Pending: runResult.RunningCount > runResult.CompletedCount ||
						pendingArchives > 0,
				}, err
			},
		},
	)
	driver.executions.ArchiveRecoveryQueue = driver.issues.ExecutionRecoveryQueue
}

func (driver *sqliteConformanceDriver) AwaitLauncherCalls(ctx context.Context, want int) error {
	for {
		driver.launcher.mu.Lock()
		calls := driver.launcher.calls
		if calls >= want {
			driver.launcher.mu.Unlock()
			if driver.cancelAuto != nil {
				driver.cancelAuto()
				driver.cancelAuto = nil
			}
			return nil
		}
		if driver.launcher.callSignal == nil {
			driver.launcher.callSignal = make(chan struct{})
		}
		signal := driver.launcher.callSignal
		driver.launcher.mu.Unlock()
		select {
		case <-ctx.Done():
			if driver.cancelAuto != nil {
				driver.cancelAuto()
				driver.cancelAuto = nil
			}
			return fmt.Errorf("launcher calls = %d, want at least %d: %w", calls, want, ctx.Err())
		case <-signal:
		}
	}
}

func (driver *sqliteConformanceDriver) StartupRecoverReplica(ctx context.Context, workspaceID string) error {
	replica := driver.issues
	replica.MutationLocks = workspaceservice.NewIssueMutationLocks()
	replica.RunLaunchGate = workspaceservice.NewIssueRunLaunchGate()
	return replica.RecoverTuttiModeRunLaunches(ctx, workspaceID)
}

func (driver *sqliteConformanceDriver) StartupReconcileReplica(ctx context.Context, workspaceID string) error {
	replica := driver.issues
	replica.MutationLocks = workspaceservice.NewIssueMutationLocks()
	replica.RunLaunchGate = workspaceservice.NewIssueRunLaunchGate()
	coordinator := workspaceservice.IssueExecutionCoordinator{
		Issues:              &replica,
		RunSessionCanceller: driver.canceller,
		Clock:               driver.clock.Now,
	}
	_, err := coordinator.ReconcileTuttiModeRunLaunchesAndRunningRuns(
		ctx, workspaceID,
	)
	return err
}

func (driver *sqliteConformanceDriver) PeriodicRecoverReplica(ctx context.Context, workspaceID string) error {
	replica := driver.issues
	replica.MutationLocks = workspaceservice.NewIssueMutationLocks()
	replica.RunLaunchGate = workspaceservice.NewIssueRunLaunchGate()
	coordinator := workspaceservice.IssueExecutionCoordinator{Issues: &replica}
	_, err := coordinator.ReconcileTuttiModeRunLaunchesAndRunningRuns(ctx, workspaceID)
	return err
}

func (driver *sqliteConformanceDriver) LauncherClientSubmitIDs() []string {
	driver.launcher.mu.Lock()
	defer driver.launcher.mu.Unlock()
	return append([]string(nil), driver.launcher.clientSubmitIDs...)
}

func (driver *sqliteConformanceDriver) LauncherCanonicalTurnCount() int {
	driver.launcher.mu.Lock()
	defer driver.launcher.mu.Unlock()
	return len(driver.launcher.canonicalByClientSubmit)
}

func TestMaterializationSQLiteServiceConformance(t *testing.T) {
	for _, scenario := range tuttimodeexecutionconformance.MaterializationCatalog() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			if err := tuttimodeexecutionconformance.Run(
				context.Background(),
				newSQLiteConformanceDriver(t),
				scenario,
			); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestScheduleSQLiteServiceConformance(t *testing.T) {
	for _, scenario := range tuttimodeexecutionconformance.ScheduleCatalog() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			if err := tuttimodeexecutionconformance.Run(
				context.Background(),
				newSQLiteConformanceDriver(t),
				scenario,
			); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMutationSQLiteServiceConformance(t *testing.T) {
	for _, scenario := range tuttimodeexecutionconformance.MutationCatalog() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			if err := tuttimodeexecutionconformance.Run(
				context.Background(),
				newSQLiteConformanceDriver(t),
				scenario,
			); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSettlementSQLiteServiceConformance(t *testing.T) {
	for _, scenario := range tuttimodeexecutionconformance.SettlementCatalog() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			if err := tuttimodeexecutionconformance.Run(
				context.Background(),
				newSQLiteConformanceDriver(t),
				scenario,
			); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestWakeSQLiteServiceConformance(t *testing.T) {
	for _, scenario := range tuttimodeexecutionconformance.WakeCatalog() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			if err := tuttimodeexecutionconformance.Run(
				context.Background(),
				newSQLiteConformanceDriver(t),
				scenario,
			); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestWatchdogSQLiteServiceConformance(t *testing.T) {
	for _, scenario := range tuttimodeexecutionconformance.WatchdogCatalog() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			if err := tuttimodeexecutionconformance.Run(
				context.Background(),
				newSQLiteConformanceDriver(t),
				scenario,
			); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestGoalReviewSQLiteServiceConformance(t *testing.T) {
	for _, scenario := range tuttimodeexecutionconformance.ReviewCatalog() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			if err := tuttimodeexecutionconformance.Run(
				context.Background(),
				newSQLiteConformanceDriver(t),
				scenario,
			); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestArchiveSQLiteServiceConformance(t *testing.T) {
	for _, scenario := range tuttimodeexecutionconformance.ArchiveCatalog() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			if err := tuttimodeexecutionconformance.Run(
				context.Background(),
				newSQLiteConformanceDriver(t),
				scenario,
			); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDeletionSQLiteServiceConformance(t *testing.T) {
	for _, scenario := range tuttimodeexecutionconformance.DeletionCatalog() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			if err := tuttimodeexecutionconformance.Run(
				context.Background(),
				newSQLiteConformanceDriver(t),
				scenario,
			); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func firstNonEmptyConformance(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
