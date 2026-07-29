package workspace

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

const tuttiModeRunLaunchLease = time.Minute

type issueRunLaunchTickerRenewalScheduler struct{}

func (issueRunLaunchTickerRenewalScheduler) Start(
	ctx context.Context,
	interval time.Duration,
	renew func() error,
) func() {
	renewCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-renewCtx.Done():
				return
			case <-ticker.C:
				if err := renew(); err != nil {
					return
				}
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			<-done
		})
	}
}

func (s IssueManagerService) ScheduleTuttiModeIssue(
	ctx context.Context,
	workspaceID string,
	input ScheduleTuttiModeIssueInput,
) (ScheduleTuttiModeIssueResult, error) {
	if s.TuttiModeExecutions == nil || s.RunLauncher == nil {
		return ScheduleTuttiModeIssueResult{}, tuttimodeexecutionservice.ErrServiceUnavailable
	}
	workspaceID = strings.TrimSpace(workspaceID)
	input.IssueID = strings.TrimSpace(input.IssueID)
	input.SourceSessionID = strings.TrimSpace(input.SourceSessionID)
	input.CheckpointID = strings.TrimSpace(input.CheckpointID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	if workspaceID == "" || input.IssueID == "" || input.SourceSessionID == "" ||
		input.CheckpointID == "" || input.ExpectedGraphRevision < 1 ||
		input.RequestID == "" || len(input.TaskIDs) == 0 {
		return ScheduleTuttiModeIssueResult{}, executionbiz.ErrScheduleRejected
	}

	unlockIssue := s.MutationLocks.Lock(workspaceID, input.IssueID)
	detail, err := s.domainService().GetIssueDetail(ctx, workspaceID, input.IssueID)
	if err != nil {
		unlockIssue()
		return ScheduleTuttiModeIssueResult{}, err
	}
	detail.Tasks = s.projectReviewedSettlementSubjectForSchedule(
		ctx, workspaceID, input.IssueID, input.CheckpointID, detail.Tasks,
	)
	if err := s.validateTuttiModeScheduleIsolation(detail.Issue, detail.Tasks, input.TaskIDs); err != nil {
		unlockIssue()
		return ScheduleTuttiModeIssueResult{}, err
	}
	runs, err := s.prepareTuttiModeScheduleRuns(detail.Issue, detail.Tasks, input.TaskIDs)
	if err != nil {
		unlockIssue()
		return ScheduleTuttiModeIssueResult{}, err
	}
	scheduled, err := s.TuttiModeExecutions.Schedule(ctx, tuttimodeexecutionservice.ScheduleInput{
		WorkspaceID:           workspaceID,
		IssueID:               input.IssueID,
		SourceSessionID:       input.SourceSessionID,
		CheckpointID:          input.CheckpointID,
		ExpectedGraphRevision: input.ExpectedGraphRevision,
		TaskIDs:               append([]string(nil), input.TaskIDs...),
		RequestID:             input.RequestID,
		Runs:                  runs,
	})
	if err != nil {
		unlockIssue()
		return ScheduleTuttiModeIssueResult{}, err
	}
	// Exact-set admission bypasses the generic CreateRun path, so it must
	// explicitly keep the workspace reconcile worker alive. The worker owns
	// recovery when delivery loses its response or this process stops after
	// persisting the prepared launch intents.
	s.enqueueWorkspaceRunReconcile(workspaceID)
	preparedRuns, err := s.TuttiModeExecutions.ListPreparedRunLaunches(
		ctx,
		workspaceID,
		input.IssueID,
		scheduled.RunIDs,
	)
	if err != nil {
		unlockIssue()
		return ScheduleTuttiModeIssueResult{}, err
	}
	launches := s.tuttiModeLaunchesForRuns(ctx, detail.Issue, detail.Tasks, preparedRuns)
	unlockIssue()

	s.launchScheduledTuttiModeRuns(ctx, launches)
	return ScheduleTuttiModeIssueResult{
		ExecutionID:   scheduled.ExecutionID,
		CheckpointID:  scheduled.CheckpointID,
		GraphRevision: scheduled.GraphRevision,
		RunIDs:        append([]string(nil), scheduled.RunIDs...),
		Replayed:      scheduled.Replayed,
	}, nil
}

func (s IssueManagerService) projectReviewedSettlementSubjectForSchedule(
	ctx context.Context,
	workspaceID string,
	issueID string,
	checkpointID string,
	tasks []workspaceissues.Task,
) []workspaceissues.Task {
	if s.TuttiModeExecutions == nil {
		return tasks
	}
	aggregate, err := s.TuttiModeExecutions.GetByIssue(ctx, workspaceID, issueID)
	if err != nil {
		return tasks
	}
	subjectTaskID := ""
	for _, checkpoint := range aggregate.Checkpoints {
		if checkpoint.ID == checkpointID &&
			checkpoint.Status == executionbiz.CheckpointStatusActive &&
			checkpoint.Kind == executionbiz.CheckpointKindTaskSettled {
			subjectTaskID = checkpoint.SubjectTaskID
			break
		}
	}
	if subjectTaskID == "" {
		return tasks
	}
	projected := append([]workspaceissues.Task(nil), tasks...)
	for index := range projected {
		if projected[index].TaskID == subjectTaskID &&
			projected[index].Status == workspaceissues.StatusPendingAcceptance {
			projected[index] = workspaceissues.ProjectReviewedSettlementTaskForRun(
				projected[index],
			)
		}
	}
	return projected
}

func (s IssueManagerService) validateTuttiModeScheduleIsolation(
	issue workspaceissues.Issue,
	tasks []workspaceissues.Task,
	taskIDs []string,
) error {
	byID := make(map[string]workspaceissues.Task, len(tasks))
	activeOther := false
	for _, task := range tasks {
		byID[task.TaskID] = task
		if task.Status == workspaceissues.StatusRunning ||
			task.Status == workspaceissues.StatusPendingAcceptance {
			activeOther = true
			if !task.Parallelizable {
				for _, taskID := range taskIDs {
					if strings.TrimSpace(taskID) != task.TaskID {
						return executionbiz.Reject(
							executionbiz.ErrScheduleRejected,
							executionbiz.RejectionParallelismRejected,
							strings.TrimSpace(taskID),
						)
					}
				}
			}
		}
	}
	newTasks := make([]workspaceissues.Task, 0, len(taskIDs))
	for _, taskID := range taskIDs {
		task, ok := byID[strings.TrimSpace(taskID)]
		if !ok {
			return executionbiz.Reject(
				executionbiz.ErrScheduleRejected,
				executionbiz.RejectionTaskNotFound,
				strings.TrimSpace(taskID),
			)
		}
		if task.Status == workspaceissues.StatusNotStarted {
			newTasks = append(newTasks, task)
		}
	}
	requiresConcurrency := len(newTasks) > 1 || (len(newTasks) > 0 && activeOther)
	if !requiresConcurrency {
		return nil
	}
	for _, task := range newTasks {
		if !task.Parallelizable {
			return executionbiz.Reject(
				executionbiz.ErrScheduleRejected,
				executionbiz.RejectionParallelismRejected,
				task.TaskID,
			)
		}
		if issue.SequentialExecution {
			if _, concurrent := s.sequentialTaskIsolation(issue, tasks, task); !concurrent {
				return executionbiz.Reject(
					executionbiz.ErrScheduleRejected,
					executionbiz.RejectionParallelismRejected,
					task.TaskID,
				)
			}
		}
	}
	return nil
}

func (s IssueManagerService) prepareTuttiModeScheduleRuns(
	issue workspaceissues.Issue,
	tasks []workspaceissues.Task,
	taskIDs []string,
) ([]workspaceissues.Run, error) {
	if issue.PlanningSource != workspaceissues.PlanningSourceTuttiModePlan {
		return nil, executionbiz.Reject(
			executionbiz.ErrScheduleRejected,
			executionbiz.RejectionInactiveExecution,
			"",
		)
	}
	byID := make(map[string]workspaceissues.Task, len(tasks))
	for _, task := range tasks {
		byID[task.TaskID] = task
	}
	seen := make(map[string]struct{}, len(taskIDs))
	now := time.Now().UTC().UnixMilli()
	runs := make([]workspaceissues.Run, 0, len(taskIDs))
	for _, rawTaskID := range taskIDs {
		taskID := strings.TrimSpace(rawTaskID)
		task, ok := byID[taskID]
		if taskID == "" || !ok {
			return nil, executionbiz.Reject(
				executionbiz.ErrScheduleRejected,
				executionbiz.RejectionTaskNotFound,
				taskID,
			)
		}
		if _, duplicate := seen[taskID]; duplicate {
			return nil, executionbiz.Reject(
				executionbiz.ErrScheduleRejected,
				executionbiz.RejectionDuplicateTask,
				taskID,
			)
		}
		seen[taskID] = struct{}{}
		runID := uuid.NewString()
		executionDirectory := s.resolveIssueTaskBaseDirectory(issue, task)
		runs = append(runs, workspaceissues.Run{
			RunID:              runID,
			TaskID:             task.TaskID,
			IssueID:            issue.IssueID,
			WorkspaceID:        issue.WorkspaceID,
			RequesterUserID:    issueManagerLocalActorUserID,
			AgentUserID:        issueManagerLocalActorUserID,
			AgentTargetID:      task.AgentTargetID,
			AgentSessionID:     uuid.NewString(),
			AgentProvider:      strings.TrimPrefix(task.AgentTargetID, "local:"),
			ModelPlanID:        task.ModelPlanID,
			Model:              task.Model,
			ReasoningIntensity: issue.ExecutionProfile.ReasoningIntensity,
			Status:             workspaceissues.StatusRunning,
			ExecutionDirectory: executionDirectory,
			CreatedAtUnixMS:    now,
			StartedAtUnixMS:    now,
			UpdatedAtUnixMS:    now,
		})
	}
	return runs, nil
}

func (s IssueManagerService) tuttiModeLaunchesForRuns(
	ctx context.Context,
	issue workspaceissues.Issue,
	tasks []workspaceissues.Task,
	preparedRuns []executionbiz.PreparedRunLaunch,
) []IssueRunLaunch {
	byID := make(map[string]workspaceissues.Task, len(tasks))
	for _, task := range tasks {
		byID[task.TaskID] = task
	}
	launches := make([]IssueRunLaunch, 0, len(preparedRuns))
	for _, prepared := range preparedRuns {
		run := prepared.Run
		task, ok := byID[run.TaskID]
		if !ok {
			continue
		}
		isolation := issueTaskIsolation{}
		if task.Parallelizable {
			isolation, _ = s.sequentialTaskIsolation(issue, tasks, task)
		}
		executionDirectory := run.ExecutionDirectory
		worktreeBase := ""
		worktreeBranch := ""
		if isolation.worktreeBase != "" {
			worktreePath, branch := s.issueTaskRunWorktreePlan(issue.IssueID, task.TaskID, run.RunID)
			worktreeBase = isolation.worktreeBase
			worktreeBranch = branch
			executionDirectory = worktreePath
		}
		launches = append(launches, IssueRunLaunch{
			WorkspaceID:        run.WorkspaceID,
			ClientSubmitID:     prepared.ClientSubmitID,
			AgentSessionID:     run.AgentSessionID,
			AgentTargetID:      run.AgentTargetID,
			RunID:              run.RunID,
			TaskID:             run.TaskID,
			IssueID:            run.IssueID,
			Title:              task.Title,
			Prompt:             issueTaskPrompt(issue, task, executionDirectory, worktreeBase, worktreeBranch, s.dependencyWorktreeOutputs(ctx, issue, task, byID)),
			ExecutionDirectory: executionDirectory,
			ModelPlanID:        run.ModelPlanID,
			Model:              run.Model,
			ReasoningIntensity: run.ReasoningIntensity,
			ReasoningEffort:    task.ReasoningEffort,
			PermissionModeID:   task.PermissionModeID,
			WorktreeBase:       worktreeBase,
			WorktreeBranch:     worktreeBranch,
		})
	}
	return launches
}

func (s IssueManagerService) issueRunClientSubmitID(
	ctx context.Context,
	run workspaceissues.Run,
) (string, error) {
	detail, err := s.domainService().GetIssueDetail(ctx, run.WorkspaceID, run.IssueID)
	if err != nil {
		return "", err
	}
	if detail.Issue.PlanningSource != workspaceissues.PlanningSourceTuttiModePlan {
		return workspaceissues.IssueRunClientSubmitID(run.RunID), nil
	}
	if s.TuttiModeExecutions == nil {
		return "", tuttimodeexecutionservice.ErrServiceUnavailable
	}
	clientSubmitID, found, err := s.TuttiModeExecutions.GetRunLaunchClientSubmitID(
		ctx, run.WorkspaceID, run.IssueID, run.RunID,
	)
	if err != nil {
		return "", err
	}
	if !found || strings.TrimSpace(clientSubmitID) == "" {
		return "", executionbiz.ErrScheduleRejected
	}
	return clientSubmitID, nil
}

func (s IssueManagerService) launchScheduledTuttiModeRuns(
	ctx context.Context,
	launches []IssueRunLaunch,
) {
	for _, launch := range launches {
		leaseOwner := uuid.NewString()
		leaseDuration := s.tuttiModeRunLaunchLeaseDuration()
		claimed, err := s.TuttiModeExecutions.ClaimRunLaunch(
			ctx,
			launch.WorkspaceID,
			launch.IssueID,
			launch.RunID,
			leaseOwner,
			leaseDuration,
		)
		if err != nil || !claimed {
			continue
		}
		renewalInterval := leaseDuration / 3
		if renewalInterval <= 0 {
			renewalInterval = time.Nanosecond
		}
		stopRenewal := s.runLaunchLeaseRenewalScheduler().Start(
			ctx,
			renewalInterval,
			func() error {
				return s.TuttiModeExecutions.RenewRunLaunch(
					ctx,
					launch.WorkspaceID,
					launch.IssueID,
					launch.RunID,
					leaseOwner,
					leaseDuration,
				)
			},
		)
		release := func() {
			stopRenewal()
			_ = s.TuttiModeExecutions.ReleaseRunLaunch(
				ctx, launch.WorkspaceID, launch.IssueID, launch.RunID, leaseOwner,
			)
		}
		s.deliverIssueRunLaunch(ctx, launch, issueRunLaunchDeliveryOutcomes{
			onGateBusy: release,
			onRejected: func(issueRunLaunchDecision) {
				release()
			},
			onFailure: func(err error) {
				if !isIssueRunLaunchNotStartedError(err) {
					stopRenewal()
					cleanupCtx, cancel := durableIssueRunCleanupContext(ctx)
					defer cancel()
					if releaseErr := s.TuttiModeExecutions.ReleaseRunLaunch(
						cleanupCtx,
						launch.WorkspaceID,
						launch.IssueID,
						launch.RunID,
						leaseOwner,
					); releaseErr != nil {
						terminal, terminalErr := s.issueRunIsTerminal(cleanupCtx, launch)
						if terminalErr == nil && terminal {
							s.runLaunchGate().requestCancel(launch.WorkspaceID, launch.RunID)
						} else {
							s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
						}
					}
					return
				}
				stopRenewal()
				if _, _, failureErr := s.TuttiModeExecutions.FailRunLaunch(
					ctx, launch.WorkspaceID, launch.IssueID, launch.RunID,
					leaseOwner, err.Error(),
				); failureErr != nil {
					release()
					s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
					return
				}
				s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
					WorkspaceID: launch.WorkspaceID, IssueID: launch.IssueID,
					TaskID: launch.TaskID, RunID: launch.RunID,
					ChangeKind: eventstreamservice.WorkspaceIssueChangeRunCompleted,
				})
			},
			onDelivered: func() {
				stopRenewal()
				cleanupCtx, cancel := durableIssueRunCleanupContext(ctx)
				defer cancel()
				if err := s.TuttiModeExecutions.MarkRunLaunchDispatched(
					cleanupCtx,
					launch.WorkspaceID,
					launch.IssueID,
					launch.RunID,
					leaseOwner,
				); err != nil {
					terminal, terminalErr := s.issueRunIsTerminal(cleanupCtx, launch)
					if terminalErr == nil && terminal {
						s.runLaunchGate().requestCancel(launch.WorkspaceID, launch.RunID)
					} else {
						s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
					}
				}
			},
		})
		stopRenewal()
	}
}

func (s IssueManagerService) tuttiModeRunLaunchLeaseDuration() time.Duration {
	if s.TuttiModeRunLaunchLeaseDuration > 0 {
		return s.TuttiModeRunLaunchLeaseDuration
	}
	return tuttiModeRunLaunchLease
}

func (s IssueManagerService) runLaunchLeaseRenewalScheduler() IssueRunLaunchLeaseRenewalScheduler {
	if s.RunLaunchLeaseRenewalScheduler != nil {
		return s.RunLaunchLeaseRenewalScheduler
	}
	return issueRunLaunchTickerRenewalScheduler{}
}

func (s IssueManagerService) RequeueLeasedTuttiModeRunLaunchIntents(
	ctx context.Context,
	workspaceID string,
) error {
	if s.TuttiModeExecutions == nil {
		return tuttimodeexecutionservice.ErrServiceUnavailable
	}
	return s.TuttiModeExecutions.RequeueLeasedRunLaunches(ctx, workspaceID)
}

func (s IssueManagerService) RecoverTuttiModeRunLaunches(
	ctx context.Context,
	workspaceID string,
) error {
	if err := s.RequeueLeasedTuttiModeRunLaunchIntents(ctx, workspaceID); err != nil {
		return err
	}
	return s.RecoverTuttiModeRunLaunchIntents(ctx, workspaceID)
}

func (s IssueManagerService) RecoverTuttiModeRunLaunchIntents(
	ctx context.Context,
	workspaceID string,
) error {
	if s.TuttiModeExecutions == nil || s.RunLauncher == nil {
		return tuttimodeexecutionservice.ErrServiceUnavailable
	}
	runs, err := s.TuttiModeExecutions.ListPreparedRunLaunches(
		ctx,
		strings.TrimSpace(workspaceID),
		"",
		nil,
	)
	if err != nil {
		return err
	}
	byIssue := make(map[string][]executionbiz.PreparedRunLaunch)
	issueOrder := make([]string, 0)
	for _, prepared := range runs {
		if _, exists := byIssue[prepared.Run.IssueID]; !exists {
			issueOrder = append(issueOrder, prepared.Run.IssueID)
		}
		byIssue[prepared.Run.IssueID] = append(byIssue[prepared.Run.IssueID], prepared)
	}
	for _, issueID := range issueOrder {
		unlockIssue := s.MutationLocks.Lock(workspaceID, issueID)
		detail, getErr := s.domainService().GetIssueDetail(ctx, workspaceID, issueID)
		if getErr != nil {
			unlockIssue()
			return getErr
		}
		launches := s.tuttiModeLaunchesForRuns(ctx, detail.Issue, detail.Tasks, byIssue[issueID])
		unlockIssue()
		s.launchScheduledTuttiModeRuns(ctx, launches)
	}
	return nil
}
