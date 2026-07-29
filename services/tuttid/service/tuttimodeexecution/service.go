package tuttimodeexecution

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

var ErrServiceUnavailable = errors.New("tutti mode execution service is unavailable")
var ErrExecutionNotFound = executionbiz.ErrExecutionNotFound
var ErrExecutionConflict = executionbiz.ErrExecutionConflict
var ErrScheduleRejected = executionbiz.ErrScheduleRejected
var ErrScheduleMutationConflict = executionbiz.ErrScheduleMutationConflict
var ErrMutationRejected = executionbiz.ErrMutationRejected
var ErrMutationConflict = executionbiz.ErrMutationConflict
var ErrAcknowledgeRejected = executionbiz.ErrAcknowledgeRejected
var ErrAcknowledgeMutationConflict = executionbiz.ErrAcknowledgeMutationConflict
var ErrCompleteRejected = executionbiz.ErrCompleteRejected
var ErrCompleteMutationConflict = executionbiz.ErrCompleteMutationConflict
var ErrReviewerVerdictRejected = executionbiz.ErrReviewerVerdictRejected
var ErrReviewerVerdictMutationConflict = executionbiz.ErrReviewerVerdictMutationConflict
var ErrSwitchReviewToSelfRejected = executionbiz.ErrSwitchReviewToSelfRejected
var ErrSwitchReviewToSelfMutationConflict = executionbiz.ErrSwitchReviewToSelfMutationConflict

type Store interface {
	MaterializeTuttiModeIssue(
		context.Context,
		workspaceissues.Issue,
		[]workspaceissues.Task,
		executionbiz.Aggregate,
	) (workspaceissues.Issue, []workspaceissues.Task, executionbiz.Aggregate, error)
	GetTuttiModeExecutionByIssue(context.Context, string, string) (executionbiz.Aggregate, error)
	AdmitTuttiModeSchedule(context.Context, executionbiz.ScheduleAdmission) (executionbiz.ScheduleResult, error)
	ListPreparedTuttiModeRunLaunches(context.Context, string, string, []string, time.Time) ([]executionbiz.PreparedRunLaunch, error)
	GetTuttiModeRunLaunchClientSubmitID(context.Context, string, string, string) (string, bool, error)
	ClaimTuttiModeRunLaunchIntent(context.Context, string, string, string, string, time.Time, time.Time) (bool, error)
	RenewTuttiModeRunLaunchIntent(context.Context, string, string, string, string, time.Time, time.Time) error
	ReleaseTuttiModeRunLaunchIntent(context.Context, string, string, string, string, time.Time) error
	MarkTuttiModeRunLaunchIntentDispatched(context.Context, string, string, string, string, time.Time) error
	RequeueLeasedTuttiModeRunLaunchIntents(context.Context, string, time.Time) error
	EnsureTuttiModeRunCancelCompensation(context.Context, string, string, string, string, time.Time) (bool, error)
	ListPreparedTuttiModeRunCancelCompensations(context.Context, string) ([]executionbiz.RunCancelCompensation, error)
	ClaimTuttiModeRunCancelCompensation(context.Context, string, string, string, string, time.Time, time.Time) (bool, error)
	ReleaseTuttiModeRunCancelCompensation(context.Context, string, string, string, string, string, time.Time) error
	CompleteTuttiModeRunCancelCompensation(context.Context, string, string, string, string, time.Time) error
	RequeueLeasedTuttiModeRunCancelCompensations(context.Context, string, time.Time) error
	FailTuttiModeRunLaunch(context.Context, executionbiz.RunLaunchFailure) (executionbiz.Checkpoint, bool, error)
	EnsureTuttiModeRunSettlement(context.Context, executionbiz.RunSettlement) (executionbiz.Checkpoint, bool, error)
	RepairTuttiModeRunSettlements(context.Context, string, time.Time) (int, error)
	AdmitTuttiModeAcknowledge(context.Context, executionbiz.AcknowledgeAdmission) (executionbiz.AcknowledgeResult, error)
}

type MutationStore interface {
	AdmitTuttiModeMutation(context.Context, executionbiz.MutationAdmission) (executionbiz.MutationResult, error)
}

type ArchiveStore interface {
	RequestTuttiModeArchive(context.Context, executionbiz.ArchiveRequest) (executionbiz.ArchiveOperation, bool, error)
	RequestTuttiModeArchivesForSourceSession(context.Context, executionbiz.SourceSessionArchiveRequest) ([]executionbiz.ArchiveOperation, error)
	GetTuttiModeArchiveOperation(context.Context, string, string) (executionbiz.ArchiveOperation, error)
	FailTuttiModeArchive(context.Context, string, string, string, time.Time) (executionbiz.ArchiveOperation, error)
	CompleteTuttiModeArchiveIfSettled(context.Context, string, string, time.Time) (executionbiz.ArchiveOperation, bool, error)
	ListRecoverableTuttiModeArchives(context.Context, string) ([]executionbiz.ArchiveOperation, error)
}

type ArchiveRunCanceller interface {
	CancelTuttiModeIssueExecution(context.Context, string, string) (int, error)
}

type ArchiveRecoveryEnqueuer interface {
	Enqueue(string)
}

type ArchiveAutomationTurnCanceller interface {
	CancelAutomationTurn(context.Context, string, string, string) error
}

type WakeStore interface {
	ListTuttiModeExecutionWakes(context.Context, string, string) ([]executionbiz.Wake, error)
	ListDispatchableTuttiModeMainWakes(context.Context, string, time.Time) ([]executionbiz.Wake, error)
	ListDispatchedTuttiModeMainWakes(context.Context, string) ([]executionbiz.Wake, error)
	ListCorruptedTuttiModeMainWakes(context.Context, string, time.Time) ([]executionbiz.Wake, error)
	GetTuttiModeExecutionWake(context.Context, string, string) (executionbiz.Wake, bool, error)
	ClaimTuttiModeExecutionWake(context.Context, string, string, string, time.Time, time.Time) (bool, error)
	ReleaseTuttiModeExecutionWake(context.Context, string, string, string, string, time.Time) error
	MarkTuttiModeExecutionWakeDispatched(
		context.Context, string, string, string, string, string, time.Time, time.Time,
	) error
	MarkTuttiModeExecutionWakeTurnSettled(context.Context, string, string, string, time.Time) (bool, error)
	FailTuttiModeExecutionWakeIntegrity(context.Context, string, string, string, time.Time) error
	RequeueExpiredTuttiModeExecutionWakes(context.Context, string, time.Time) error
	CancelSuppressedTuttiModeExecutionWakes(context.Context, string, time.Time) error
	DrainTuttiModeSourceActivityInbox(context.Context, string) error
	PrepareDueTuttiModeExecutionWatchdogs(context.Context, string, time.Time) error
	ObserveTuttiModeSourceSessionActivity(context.Context, string, string, time.Time) error
}

type ReviewerActivityReader interface {
	HasActiveTuttiModeReviewer(context.Context, string, string) (bool, error)
}

type Service struct {
	Store                      Store
	Wakes                      WakeStore
	Reviews                    GoalReviewStore
	MainWakeTargets            MainWakeTarget
	ReviewerTargets            ReviewerTarget
	ReviewerActivity           ReviewerActivityReader
	BeforeGoalReviewCommitStep func(string) error
	Archives                   ArchiveStore
	ArchiveRuns                ArchiveRunCanceller
	ArchiveAutomationTurns     ArchiveAutomationTurnCanceller
	ArchiveRecoveryQueue       ArchiveRecoveryEnqueuer
	MainWakeSendTimeout        time.Duration
	MainWakeCleanupTimeout     time.Duration
	Clock                      func() time.Time
}

type MaterializeInput struct {
	Issue               workspaceissues.Issue
	Tasks               []workspaceissues.Task
	WorkflowID          string
	ReviewMode          string
	ReviewAgentTargetID string
}

type ScheduleInput struct {
	WorkspaceID           string
	IssueID               string
	SourceSessionID       string
	CheckpointID          string
	ExpectedGraphRevision int64
	TaskIDs               []string
	RequestID             string
	Runs                  []workspaceissues.Run
}

type AcknowledgeInput struct {
	WorkspaceID           string
	IssueID               string
	SourceSessionID       string
	CheckpointID          string
	ExpectedGraphRevision int64
	RequestID             string
}

type MutateInput struct {
	WorkspaceID           string
	IssueID               string
	SourceSessionID       string
	CheckpointID          string
	ExpectedGraphRevision int64
	Operations            []executionbiz.MutationOperation
	RequestID             string
}

type AcknowledgeResult struct {
	ExecutionID         string
	CheckpointID        string
	GraphRevision       int64
	NextCheckpointID    string
	NextCheckpointKind  executionbiz.CheckpointKind
	NextCheckpointState executionbiz.CheckpointStatus
	Replayed            bool
}

type CompleteInput struct {
	WorkspaceID           string
	IssueID               string
	SourceSessionID       string
	CheckpointID          string
	ExpectedGraphRevision int64
	RequestID             string
	Decision              string
	DisagreementReason    string
}

type CompleteResult struct {
	ExecutionID   string
	CheckpointID  string
	GraphRevision int64
	Decision      string
	Replayed      bool
}

type ReviewerVerdictInput struct {
	WorkspaceID           string
	IssueID               string
	ReviewID              string
	ReviewSessionID       string
	ReviewTurnID          string
	CheckpointID          string
	ExpectedGraphRevision int64
	RequestID             string
	Verdict               string
	Summary               string
}

type ReviewerVerdictResult struct {
	ReviewID string
	Verdict  string
	Replayed bool
}

type SwitchReviewToSelfInput struct {
	WorkspaceID           string
	IssueID               string
	CheckpointID          string
	ExpectedGraphRevision int64
	RequestID             string
	Reason                string
	RequestedByActorID    string
}

type SwitchReviewToSelfResult struct {
	ExecutionID string
	ReviewID    string
	ReviewMode  string
	Replayed    bool
}

func (service Service) Materialize(
	ctx context.Context,
	input MaterializeInput,
) (workspaceissues.Issue, []workspaceissues.Task, executionbiz.Aggregate, error) {
	if service.Store == nil {
		return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, ErrServiceUnavailable
	}
	if input.Issue.PlanningSource != workspaceissues.PlanningSourceTuttiModePlan ||
		strings.TrimSpace(input.Issue.SourceSessionID) == "" || len(input.Tasks) == 0 {
		return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, executionbiz.ErrInvalidExecution
	}
	aggregate, err := executionbiz.NewInitialAggregate(
		input.Issue.WorkspaceID,
		input.Issue.IssueID,
		input.WorkflowID,
		input.Issue.SourceSessionID,
		service.now(),
		executionbiz.ReviewConfiguration{
			Mode:          executionbiz.ReviewMode(input.ReviewMode),
			AgentTargetID: input.ReviewAgentTargetID,
		},
	)
	if err != nil {
		return workspaceissues.Issue{}, nil, executionbiz.Aggregate{}, err
	}
	return service.Store.MaterializeTuttiModeIssue(ctx, input.Issue, input.Tasks, aggregate)
}

func (service Service) GetByIssue(
	ctx context.Context,
	workspaceID string,
	issueID string,
) (executionbiz.Aggregate, error) {
	if service.Store == nil {
		return executionbiz.Aggregate{}, ErrServiceUnavailable
	}
	workspaceID = strings.TrimSpace(workspaceID)
	issueID = strings.TrimSpace(issueID)
	if workspaceID == "" || issueID == "" {
		return executionbiz.Aggregate{}, executionbiz.ErrInvalidExecution
	}
	return service.Store.GetTuttiModeExecutionByIssue(ctx, workspaceID, issueID)
}

func (service Service) Schedule(
	ctx context.Context,
	input ScheduleInput,
) (executionbiz.ScheduleResult, error) {
	if service.Store == nil {
		return executionbiz.ScheduleResult{}, ErrServiceUnavailable
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.IssueID = strings.TrimSpace(input.IssueID)
	input.SourceSessionID = strings.TrimSpace(input.SourceSessionID)
	input.CheckpointID = strings.TrimSpace(input.CheckpointID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	if input.WorkspaceID == "" || input.IssueID == "" ||
		input.SourceSessionID == "" || input.CheckpointID == "" ||
		input.RequestID == "" || input.ExpectedGraphRevision < 1 ||
		len(input.TaskIDs) == 0 || len(input.TaskIDs) != len(input.Runs) {
		return executionbiz.ScheduleResult{}, executionbiz.ErrScheduleRejected
	}
	taskIDs := make([]string, len(input.TaskIDs))
	seen := make(map[string]struct{}, len(input.TaskIDs))
	for index, taskID := range input.TaskIDs {
		taskID = strings.TrimSpace(taskID)
		if taskID == "" {
			return executionbiz.ScheduleResult{}, executionbiz.ErrScheduleRejected
		}
		if _, duplicate := seen[taskID]; duplicate {
			return executionbiz.ScheduleResult{}, executionbiz.ErrScheduleRejected
		}
		seen[taskID] = struct{}{}
		taskIDs[index] = taskID
		run := input.Runs[index]
		if run.WorkspaceID != input.WorkspaceID || run.IssueID != input.IssueID ||
			run.TaskID != taskID || strings.TrimSpace(run.RunID) == "" ||
			run.Status != workspaceissues.StatusRunning {
			return executionbiz.ScheduleResult{}, executionbiz.ErrScheduleRejected
		}
	}
	digest, err := scheduleInputDigest(input, taskIDs)
	if err != nil {
		return executionbiz.ScheduleResult{}, err
	}
	return service.Store.AdmitTuttiModeSchedule(ctx, executionbiz.ScheduleAdmission{
		WorkspaceID:           input.WorkspaceID,
		IssueID:               input.IssueID,
		SourceSessionID:       input.SourceSessionID,
		CheckpointID:          input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision,
		RequestID:             input.RequestID,
		InputSHA256:           digest,
		Runs:                  append([]workspaceissues.Run(nil), input.Runs...),
		Now:                   service.now(),
	})
}

func (service Service) ListPreparedRunLaunches(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runIDs []string,
) ([]executionbiz.PreparedRunLaunch, error) {
	if service.Store == nil {
		return nil, ErrServiceUnavailable
	}
	return service.Store.ListPreparedTuttiModeRunLaunches(ctx, workspaceID, issueID, runIDs, service.now())
}

func (service Service) GetRunLaunchClientSubmitID(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
) (string, bool, error) {
	if service.Store == nil {
		return "", false, ErrServiceUnavailable
	}
	workspaceID = strings.TrimSpace(workspaceID)
	issueID = strings.TrimSpace(issueID)
	runID = strings.TrimSpace(runID)
	if workspaceID == "" || issueID == "" || runID == "" {
		return "", false, executionbiz.ErrScheduleRejected
	}
	return service.Store.GetTuttiModeRunLaunchClientSubmitID(
		ctx, workspaceID, issueID, runID,
	)
}

func (service Service) ClaimRunLaunch(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
	leaseOwner string,
	leaseDuration time.Duration,
) (bool, error) {
	if service.Store == nil {
		return false, ErrServiceUnavailable
	}
	workspaceID = strings.TrimSpace(workspaceID)
	issueID = strings.TrimSpace(issueID)
	runID = strings.TrimSpace(runID)
	leaseOwner = strings.TrimSpace(leaseOwner)
	if workspaceID == "" || issueID == "" || runID == "" || leaseOwner == "" ||
		leaseDuration <= 0 {
		return false, executionbiz.ErrScheduleRejected
	}
	now := service.now()
	return service.Store.ClaimTuttiModeRunLaunchIntent(
		ctx, workspaceID, issueID, runID, leaseOwner, now, now.Add(leaseDuration),
	)
}

func (service Service) ReleaseRunLaunch(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
	leaseOwner string,
) error {
	if service.Store == nil {
		return ErrServiceUnavailable
	}
	if strings.TrimSpace(workspaceID) == "" || strings.TrimSpace(issueID) == "" ||
		strings.TrimSpace(runID) == "" || strings.TrimSpace(leaseOwner) == "" {
		return executionbiz.ErrScheduleRejected
	}
	return service.Store.ReleaseTuttiModeRunLaunchIntent(
		ctx, workspaceID, issueID, runID, leaseOwner, service.now(),
	)
}

func (service Service) RenewRunLaunch(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
	leaseOwner string,
	leaseDuration time.Duration,
) error {
	if service.Store == nil {
		return ErrServiceUnavailable
	}
	workspaceID = strings.TrimSpace(workspaceID)
	issueID = strings.TrimSpace(issueID)
	runID = strings.TrimSpace(runID)
	leaseOwner = strings.TrimSpace(leaseOwner)
	if workspaceID == "" || issueID == "" || runID == "" || leaseOwner == "" ||
		leaseDuration <= 0 {
		return executionbiz.ErrScheduleRejected
	}
	now := service.now()
	return service.Store.RenewTuttiModeRunLaunchIntent(
		ctx, workspaceID, issueID, runID, leaseOwner, now, now.Add(leaseDuration),
	)
}

func (service Service) MarkRunLaunchDispatched(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
	leaseOwner string,
) error {
	if service.Store == nil {
		return ErrServiceUnavailable
	}
	if strings.TrimSpace(workspaceID) == "" || strings.TrimSpace(issueID) == "" ||
		strings.TrimSpace(runID) == "" || strings.TrimSpace(leaseOwner) == "" {
		return executionbiz.ErrScheduleRejected
	}
	return service.Store.MarkTuttiModeRunLaunchIntentDispatched(
		ctx,
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(issueID),
		strings.TrimSpace(runID),
		strings.TrimSpace(leaseOwner),
		service.now(),
	)
}

func (service Service) RequeueLeasedRunLaunches(
	ctx context.Context,
	workspaceID string,
) error {
	if service.Store == nil {
		return ErrServiceUnavailable
	}
	return service.Store.RequeueLeasedTuttiModeRunLaunchIntents(
		ctx, strings.TrimSpace(workspaceID), service.now(),
	)
}

func (service Service) EnsureRunCancelCompensation(
	ctx context.Context,
	workspaceID string,
	issueID string,
	taskID string,
	runID string,
) (bool, error) {
	if service.Store == nil {
		return false, ErrServiceUnavailable
	}
	return service.Store.EnsureTuttiModeRunCancelCompensation(
		ctx,
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(issueID),
		strings.TrimSpace(taskID),
		strings.TrimSpace(runID),
		service.now(),
	)
}

func (service Service) ListPreparedRunCancelCompensations(
	ctx context.Context,
	workspaceID string,
) ([]executionbiz.RunCancelCompensation, error) {
	if service.Store == nil {
		return nil, ErrServiceUnavailable
	}
	return service.Store.ListPreparedTuttiModeRunCancelCompensations(
		ctx, strings.TrimSpace(workspaceID),
	)
}

func (service Service) ClaimRunCancelCompensation(
	ctx context.Context,
	item executionbiz.RunCancelCompensation,
	leaseOwner string,
	leaseDuration time.Duration,
) (bool, error) {
	if service.Store == nil {
		return false, ErrServiceUnavailable
	}
	now := service.now()
	return service.Store.ClaimTuttiModeRunCancelCompensation(
		ctx, item.WorkspaceID, item.IssueID, item.RunID,
		strings.TrimSpace(leaseOwner), now, now.Add(leaseDuration),
	)
}

func (service Service) ReleaseRunCancelCompensation(
	ctx context.Context,
	item executionbiz.RunCancelCompensation,
	leaseOwner string,
	message string,
) error {
	if service.Store == nil {
		return ErrServiceUnavailable
	}
	return service.Store.ReleaseTuttiModeRunCancelCompensation(
		ctx, item.WorkspaceID, item.IssueID, item.RunID,
		strings.TrimSpace(leaseOwner), strings.TrimSpace(message), service.now(),
	)
}

func (service Service) CompleteRunCancelCompensation(
	ctx context.Context,
	item executionbiz.RunCancelCompensation,
	leaseOwner string,
) error {
	if service.Store == nil {
		return ErrServiceUnavailable
	}
	return service.Store.CompleteTuttiModeRunCancelCompensation(
		ctx, item.WorkspaceID, item.IssueID, item.RunID,
		strings.TrimSpace(leaseOwner), service.now(),
	)
}

func (service Service) RequeueLeasedRunCancelCompensations(
	ctx context.Context,
	workspaceID string,
) error {
	if service.Store == nil {
		return ErrServiceUnavailable
	}
	return service.Store.RequeueLeasedTuttiModeRunCancelCompensations(
		ctx, strings.TrimSpace(workspaceID), service.now(),
	)
}

func (service Service) FailRunLaunch(
	ctx context.Context,
	workspaceID string,
	issueID string,
	runID string,
	leaseOwner string,
	message string,
) (executionbiz.Checkpoint, bool, error) {
	if service.Store == nil {
		return executionbiz.Checkpoint{}, false, ErrServiceUnavailable
	}
	failure := executionbiz.RunLaunchFailure{
		WorkspaceID: strings.TrimSpace(workspaceID),
		IssueID:     strings.TrimSpace(issueID), RunID: strings.TrimSpace(runID),
		LeaseOwner:   strings.TrimSpace(leaseOwner),
		ErrorMessage: strings.TrimSpace(message), Now: service.now(),
	}
	if failure.WorkspaceID == "" || failure.IssueID == "" ||
		failure.RunID == "" || failure.LeaseOwner == "" {
		return executionbiz.Checkpoint{}, false, executionbiz.ErrScheduleRejected
	}
	return service.Store.FailTuttiModeRunLaunch(ctx, failure)
}

func (service Service) EnsureRunSettlement(
	ctx context.Context,
	input executionbiz.RunSettlement,
) (executionbiz.Checkpoint, bool, error) {
	if service.Store == nil {
		return executionbiz.Checkpoint{}, false, ErrServiceUnavailable
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.IssueID = strings.TrimSpace(input.IssueID)
	input.TaskID = strings.TrimSpace(input.TaskID)
	input.RunID = strings.TrimSpace(input.RunID)
	input.Now = service.now()
	if input.WorkspaceID == "" || input.IssueID == "" ||
		input.TaskID == "" || input.RunID == "" {
		return executionbiz.Checkpoint{}, false, executionbiz.ErrInvalidExecution
	}
	return service.Store.EnsureTuttiModeRunSettlement(ctx, input)
}

func (service Service) RepairRunSettlements(ctx context.Context, workspaceID string) (int, error) {
	if service.Store == nil {
		return 0, ErrServiceUnavailable
	}
	return service.Store.RepairTuttiModeRunSettlements(ctx, strings.TrimSpace(workspaceID), service.now())
}

func (service Service) Acknowledge(
	ctx context.Context,
	input AcknowledgeInput,
) (AcknowledgeResult, error) {
	if service.Store == nil {
		return AcknowledgeResult{}, ErrServiceUnavailable
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.IssueID = strings.TrimSpace(input.IssueID)
	input.SourceSessionID = strings.TrimSpace(input.SourceSessionID)
	input.CheckpointID = strings.TrimSpace(input.CheckpointID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	if input.WorkspaceID == "" || input.IssueID == "" ||
		input.SourceSessionID == "" || input.CheckpointID == "" ||
		input.RequestID == "" || input.ExpectedGraphRevision < 1 {
		return AcknowledgeResult{}, executionbiz.ErrAcknowledgeRejected
	}
	payload, err := json.Marshal(struct {
		CheckpointID          string `json:"checkpointId"`
		ExpectedGraphRevision int64  `json:"expectedGraphRevision"`
	}{
		CheckpointID: input.CheckpointID, ExpectedGraphRevision: input.ExpectedGraphRevision,
	})
	if err != nil {
		return AcknowledgeResult{}, err
	}
	sum := sha256.Sum256(payload)
	result, err := service.Store.AdmitTuttiModeAcknowledge(ctx, executionbiz.AcknowledgeAdmission{
		WorkspaceID: input.WorkspaceID, IssueID: input.IssueID,
		SourceSessionID: input.SourceSessionID, CheckpointID: input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision, RequestID: input.RequestID,
		InputSHA256: hex.EncodeToString(sum[:]), Now: service.now(),
	})
	if err != nil {
		return AcknowledgeResult{}, err
	}
	return AcknowledgeResult{
		ExecutionID: result.ExecutionID, CheckpointID: result.CheckpointID,
		GraphRevision: result.GraphRevision, NextCheckpointID: result.NextCheckpointID,
		NextCheckpointKind:  result.NextCheckpointKind,
		NextCheckpointState: result.NextCheckpointState, Replayed: result.Replayed,
	}, nil
}

func (service Service) Mutate(
	ctx context.Context,
	input MutateInput,
) (executionbiz.MutationResult, error) {
	if service.Store == nil {
		return executionbiz.MutationResult{}, ErrServiceUnavailable
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.IssueID = strings.TrimSpace(input.IssueID)
	input.SourceSessionID = strings.TrimSpace(input.SourceSessionID)
	input.CheckpointID = strings.TrimSpace(input.CheckpointID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	if input.WorkspaceID == "" || input.IssueID == "" ||
		input.SourceSessionID == "" || input.CheckpointID == "" ||
		input.RequestID == "" || input.ExpectedGraphRevision < 1 ||
		len(input.Operations) == 0 {
		return executionbiz.MutationResult{}, executionbiz.Reject(
			executionbiz.ErrMutationRejected,
			executionbiz.RejectionInvalidMutation,
			"",
		)
	}
	operations := append([]executionbiz.MutationOperation(nil), input.Operations...)
	for index := range operations {
		operations[index].TaskID = strings.TrimSpace(operations[index].TaskID)
		operations[index].Task.TaskID = strings.TrimSpace(operations[index].Task.TaskID)
		switch operations[index].Kind {
		case executionbiz.MutationOperationAdd:
			if operations[index].Task.TaskID == "" {
				return executionbiz.MutationResult{}, executionbiz.Reject(
					executionbiz.ErrMutationRejected,
					executionbiz.RejectionInvalidMutation,
					"",
				)
			}
			if strings.TrimSpace(operations[index].Task.AgentTargetID) == "" {
				return executionbiz.MutationResult{}, executionbiz.Reject(
					executionbiz.ErrMutationRejected,
					executionbiz.RejectionMissingAgentTarget,
					operations[index].Task.TaskID,
				)
			}
		case executionbiz.MutationOperationUpdate, executionbiz.MutationOperationSupersede,
			executionbiz.MutationOperationRework:
			if operations[index].TaskID == "" {
				return executionbiz.MutationResult{}, executionbiz.Reject(
					executionbiz.ErrMutationRejected,
					executionbiz.RejectionInvalidMutation,
					"",
				)
			}
			if operations[index].Kind == executionbiz.MutationOperationUpdate &&
				!operations[index].TaskFields.Any() {
				return executionbiz.MutationResult{}, executionbiz.Reject(
					executionbiz.ErrMutationRejected,
					executionbiz.RejectionInvalidMutation,
					operations[index].TaskID,
				)
			}
			if operations[index].Kind == executionbiz.MutationOperationRework &&
				operations[index].Task.TaskID == "" {
				return executionbiz.MutationResult{}, executionbiz.Reject(
					executionbiz.ErrMutationRejected,
					executionbiz.RejectionInvalidMutation,
					operations[index].TaskID,
				)
			}
		default:
			return executionbiz.MutationResult{}, executionbiz.Reject(
				executionbiz.ErrMutationRejected,
				executionbiz.RejectionInvalidMutation,
				operations[index].TaskID,
			)
		}
	}
	payload, err := json.Marshal(struct {
		CheckpointID          string                           `json:"checkpointId"`
		ExpectedGraphRevision int64                            `json:"expectedGraphRevision"`
		Operations            []executionbiz.MutationOperation `json:"operations"`
	}{
		CheckpointID: input.CheckpointID, ExpectedGraphRevision: input.ExpectedGraphRevision,
		Operations: operations,
	})
	if err != nil {
		return executionbiz.MutationResult{}, err
	}
	sum := sha256.Sum256(payload)
	mutations, ok := service.Store.(MutationStore)
	if !ok {
		return executionbiz.MutationResult{}, ErrServiceUnavailable
	}
	return mutations.AdmitTuttiModeMutation(ctx, executionbiz.MutationAdmission{
		WorkspaceID: input.WorkspaceID, IssueID: input.IssueID,
		SourceSessionID: input.SourceSessionID, CheckpointID: input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision, RequestID: input.RequestID,
		InputSHA256: hex.EncodeToString(sum[:]), Operations: operations, Now: service.now(),
	})
}

func scheduleInputDigest(input ScheduleInput, taskIDs []string) (string, error) {
	payload, err := json.Marshal(struct {
		CheckpointID          string   `json:"checkpointId"`
		ExpectedGraphRevision int64    `json:"expectedGraphRevision"`
		TaskIDs               []string `json:"taskIds"`
	}{
		CheckpointID:          input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision,
		TaskIDs:               taskIDs,
	})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}

func (service Service) now() time.Time {
	if service.Clock != nil {
		return service.Clock().UTC()
	}
	return time.Now().UTC()
}
