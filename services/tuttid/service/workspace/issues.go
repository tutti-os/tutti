package workspace

import (
	"context"
	"strings"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

const issueManagerLocalActorUserID = "local"

type IssueManagerService struct {
	RunLauncher                    IssueRunLauncher
	RunReconciler                  IssueRunReconciler
	SourceSessionDirectoryResolver IssueSourceSessionDirectoryResolver
	Publisher                      IssueManagerEventPublisher
	RunReconcileQueue              *IssueRunReconcileQueue
	Store                          workspaceissues.Store
	AgentTargetReader              IssueAssignmentAgentTargetReader
	PlanningTimeline               IssuePlanningTimelineReporter
	// TaskWorktreeRoot overrides where per-run task worktrees are created;
	// empty falls back to <state dir>/task-worktrees.
	TaskWorktreeRoot string
	// CompletionNotifier hands control back to the planning conversation once
	// every task of a tutti-mode-plan Issue is completed and accepted.
	CompletionNotifier TuttiPlanIssueCompletionNotifier
	// MutationLocks serializes task/run mutations per Issue so the concurrent
	// settle paths cannot interleave read-modify-write cycles into
	// contradictory task states. Nil (bare test services) means no locking.
	MutationLocks *IssueMutationLocks
	// RunOperationLocks fences lock-free external launch/cancel operations for
	// one durable Run without holding a mutex across Agent or filesystem work.
	RunLaunchGate *IssueRunLaunchGate
	// RunCancellationRequester compensates a launch when Stop arrived while
	// the external Agent create call was already in flight.
	RunCancellationRequester IssueRunSessionCanceller
}

type TuttiPlanIssueCompletionNotifier interface {
	NotifyTuttiPlanIssueCompleted(
		ctx context.Context,
		workspaceID string,
		issue workspaceissues.Issue,
		tasks []workspaceissues.Task,
	)
	// NotifyTuttiPlanIssueTaskFailed reports a failed task run back to the
	// planning conversation so execution problems never leave it silent.
	NotifyTuttiPlanIssueTaskFailed(
		ctx context.Context,
		workspaceID string,
		issue workspaceissues.Issue,
		task workspaceissues.Task,
		run workspaceissues.Run,
	)
	// NotifyTuttiPlanIssueTaskSettled wakes the planning conversation after a
	// successful task run settles. The planning agent — not a mechanical
	// daemon chain — decides how execution advances: it reviews the result,
	// accepts or reworks a task that is pending acceptance, and can reshape
	// the remaining graph through the Issue CLI. decisionNeeded is true when
	// the settled task parked at pending_acceptance (no autoAccept), so the
	// planning agent is now the acceptance authority.
	NotifyTuttiPlanIssueTaskSettled(
		ctx context.Context,
		workspaceID string,
		issue workspaceissues.Issue,
		task workspaceissues.Task,
		run workspaceissues.Run,
		allTasks []workspaceissues.Task,
		decisionNeeded bool,
	)
}

type IssueManagerEventPublisher interface {
	PublishWorkspaceIssueUpdated(context.Context, eventstreamservice.WorkspaceIssueUpdate) error
}

type IssuePlanningTimelineReporter interface {
	ReportIssuePlanningLink(
		context.Context,
		string,
		string,
		string,
		string,
		string,
		time.Time,
	)
}

func (s IssueManagerService) ListIssues(ctx context.Context, workspaceID string, input ListIssueManagerItemsInput) (workspaceissues.IssueList, error) {
	s.reconcileWorkspaceRunsBestEffort(ctx, workspaceID)
	service := s.domainService()
	cursor, err := workspaceissues.DecodeIssueListCursorToken(input.PageToken)
	if err != nil {
		return workspaceissues.IssueList{}, err
	}
	statusFilter, err := issueManagerStatusFilter(input.StatusFilter)
	if err != nil {
		return workspaceissues.IssueList{}, err
	}
	list, err := service.ListIssues(ctx, workspaceissues.IssueListFilter{
		WorkspaceID:  workspaceID,
		TopicID:      input.TopicID,
		PageSize:     input.PageSize,
		Cursor:       cursor,
		StatusFilter: statusFilter,
		SearchQuery:  input.SearchQuery,
		ReturnAll:    false,
	})
	if err != nil {
		return workspaceissues.IssueList{}, err
	}
	if err := s.applyVisibleIssueSubtaskCounts(ctx, &list); err != nil {
		return workspaceissues.IssueList{}, err
	}
	return list, nil
}

func (s IssueManagerService) ListTopics(ctx context.Context, workspaceID string) (workspaceissues.TopicList, error) {
	return s.domainService().ListTopics(ctx, workspaceID)
}

func (s IssueManagerService) CreateTopic(ctx context.Context, workspaceID string, input CreateIssueManagerTopicInput) (workspaceissues.Topic, error) {
	return s.domainService().CreateTopic(ctx, workspaceissues.CreateTopicInput{
		TopicID:     input.TopicID,
		WorkspaceID: workspaceID,
		ActorUserID: issueManagerLocalActorUserID,
		Title:       input.Title,
		Summary:     input.Summary,
	})
}

func (s IssueManagerService) UpdateTopic(ctx context.Context, workspaceID string, topicID string, input UpdateIssueManagerTopicInput) (workspaceissues.Topic, error) {
	return s.domainService().UpdateTopic(ctx, workspaceissues.UpdateTopicInput{
		TopicID:     topicID,
		WorkspaceID: workspaceID,
		ActorUserID: issueManagerLocalActorUserID,
		Title:       input.Title,
		Summary:     input.Summary,
		HasSummary:  input.HasSummary,
		Pinned:      input.Pinned,
		HasPinned:   input.HasPinned,
	})
}

func (s IssueManagerService) DeleteTopic(ctx context.Context, workspaceID string, topicID string) (bool, error) {
	return s.domainService().DeleteTopic(ctx, workspaceID, topicID, issueManagerLocalActorUserID)
}

func (s IssueManagerService) CreateIssue(ctx context.Context, workspaceID string, input CreateIssueManagerIssueInput) (workspaceissues.Issue, error) {
	if workflowbiz.IsReservedTuttiModePlanIssueID(input.IssueID) ||
		input.PlanningSource == string(workspaceissues.PlanningSourceTuttiModePlan) {
		return workspaceissues.Issue{}, workspaceissues.ErrInvalidArgument
	}
	issue, err := s.domainService().CreateIssue(ctx, workspaceissues.CreateIssueInput{
		IssueID:             input.IssueID,
		TopicID:             input.TopicID,
		WorkspaceID:         workspaceID,
		ActorUserID:         issueManagerLocalActorUserID,
		Title:               input.Title,
		Content:             input.Content,
		PlanningSource:      input.PlanningSource,
		SourceSessionID:     input.SourceSessionID,
		SequentialExecution: input.SequentialExecution,
		ParallelExecution:   input.ParallelExecution,
		ExecutionProfile:    input.ExecutionProfile,
		HasExecutionProfile: input.HasExecutionProfile,
		Budget:              input.Budget,
		HasBudget:           input.HasBudget,
	})
	if err != nil {
		return workspaceissues.Issue{}, err
	}
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: issue.WorkspaceID,
		IssueID:     issue.IssueID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeIssueCreated,
	})
	return issue, nil
}

func (s IssueManagerService) CreateIssueFromPlan(ctx context.Context, workspaceID string, input CreateIssueManagerIssueFromPlanInput) (workspaceissues.IssueDetail, error) {
	if input.Issue.PlanningSource != string(workspaceissues.PlanningSourceTuttiModePlan) && input.Issue.PlanningSource != string(workspaceissues.PlanningSourceTraditionalPlan) {
		return workspaceissues.IssueDetail{}, workspaceissues.ErrInvalidArgument
	}
	if len(input.Tasks) == 0 {
		return workspaceissues.IssueDetail{}, workspaceissues.ErrInvalidArgument
	}
	reservedTuttiID := workflowbiz.IsReservedTuttiModePlanIssueID(input.Issue.IssueID)
	tuttiPlanningSource := input.Issue.PlanningSource == string(workspaceissues.PlanningSourceTuttiModePlan)
	if reservedTuttiID != input.Issue.TuttiModeWorkflowOwned || tuttiPlanningSource != input.Issue.TuttiModeWorkflowOwned {
		return workspaceissues.IssueDetail{}, workspaceissues.ErrInvalidArgument
	}
	if input.Issue.ParallelExecution && !parallelIssueTasksAreIsolated(input.Tasks) {
		return workspaceissues.IssueDetail{}, workspaceissues.ErrInvalidArgument
	}
	taskItems := make([]workspaceissues.CreateTaskItemInput, 0, len(input.Tasks))
	for _, task := range input.Tasks {
		taskItems = append(taskItems, workspaceissues.CreateTaskItemInput{
			TaskID:             task.TaskID,
			Title:              task.Title,
			Content:            task.Content,
			Priority:           task.Priority,
			DueAtUnixMS:        task.DueAtUnixMS,
			AgentTargetID:      task.AgentTargetID,
			ModelPlanID:        task.ModelPlanID,
			Model:              task.Model,
			PermissionModeID:   task.PermissionModeID,
			ReasoningEffort:    task.ReasoningEffort,
			ExecutionDirectory: task.ExecutionDirectory,
			DependencyTaskIDs:  task.DependencyTaskIDs,
			Parallelizable:     task.Parallelizable,
			AutoAccept:         task.AutoAccept,
		})
	}
	normalizeParallelizableAgainstDependencies(taskItems)
	issue, tasks, err := s.domainService().CreateIssueWithTasks(ctx, workspaceissues.CreateIssueWithTasksInput{
		Issue: workspaceissues.CreateIssueInput{
			IssueID:             input.Issue.IssueID,
			TopicID:             input.Issue.TopicID,
			WorkspaceID:         workspaceID,
			ActorUserID:         issueManagerLocalActorUserID,
			Title:               input.Issue.Title,
			Content:             input.Issue.Content,
			PlanningSource:      input.Issue.PlanningSource,
			SourceSessionID:     input.Issue.SourceSessionID,
			SequentialExecution: input.Issue.SequentialExecution,
			ParallelExecution:   input.Issue.ParallelExecution,
			ExecutionProfile:    input.Issue.ExecutionProfile,
			HasExecutionProfile: input.Issue.HasExecutionProfile,
			Budget:              input.Issue.Budget,
			HasBudget:           input.Issue.HasBudget,
			AutoTokenBudgetHistoryHint: s.historicalAutoTokenBudgetHint(
				ctx,
				workspaceID,
				input.Tasks,
			),
		},
		Tasks: taskItems,
	})
	if err != nil {
		return workspaceissues.IssueDetail{}, err
	}
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: issue.WorkspaceID,
		IssueID:     issue.IssueID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeIssueCreated,
	})
	for _, task := range tasks {
		s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
			WorkspaceID: task.WorkspaceID,
			IssueID:     task.IssueID,
			TaskID:      task.TaskID,
			ChangeKind:  eventstreamservice.WorkspaceIssueChangeTaskCreated,
		})
	}
	if s.PlanningTimeline != nil && strings.TrimSpace(issue.SourceSessionID) != "" {
		s.PlanningTimeline.ReportIssuePlanningLink(
			ctx,
			issue.WorkspaceID,
			issue.SourceSessionID,
			issue.IssueID,
			issue.TopicID,
			issue.Title,
			time.UnixMilli(issue.CreatedAtUnixMS).UTC(),
		)
	}
	if input.Issue.SequentialExecution || input.Issue.ParallelExecution {
		s.dispatchEligibleIssueTasks(ctx, workspaceID, issue.IssueID)
	}
	return s.GetIssueDetail(ctx, workspaceID, issue.IssueID)
}

// EstimateAutoTokenBudget exposes the same compiler used by atomic Plan
// conversion without persisting the proposed Issue. This keeps the mandatory
// review value and the eventual durable budget identical for the same graph.
func (s IssueManagerService) EstimateAutoTokenBudget(ctx context.Context, workspaceID string, input EstimateIssueManagerAutoTokenBudgetInput) (IssueManagerAutoTokenBudgetEstimate, error) {
	profile, ok := workspaceissues.NormalizeExecutionProfile(input.ExecutionProfile)
	if !ok || len(input.Tasks) == 0 {
		return IssueManagerAutoTokenBudgetEstimate{}, workspaceissues.ErrInvalidArgument
	}
	historical, matched := s.historicalAutoTokenBudgetEstimate(ctx, workspaceID, input.Tasks)
	deterministic := workspaceissues.CompileAutoTokenBudget(len(input.Tasks), profile)
	return IssueManagerAutoTokenBudgetEstimate{
		TokenLimit:                 workspaceissues.CompileAutoTokenBudgetWithHistory(len(input.Tasks), profile, historical),
		DeterministicTokenLimit:    deterministic,
		HistoricalTokenEstimate:    historical,
		MatchedHistoricalTaskCount: matched,
	}, nil
}

func (s IssueManagerService) GetIssueDetail(ctx context.Context, workspaceID string, issueID string) (workspaceissues.IssueDetail, error) {
	s.reconcileWorkspaceRunsBestEffort(ctx, workspaceID)
	detail, err := s.domainService().GetIssueDetail(ctx, workspaceID, issueID)
	if err != nil {
		return workspaceissues.IssueDetail{}, err
	}
	applyVisibleIssueSubtaskCount(&detail.Issue, detail.Tasks, detail.LatestRun)
	return detail, nil
}

func (s IssueManagerService) SearchIssueOutputs(ctx context.Context, params workspaceissues.RunOutputSearchParams) ([]workspaceissues.RunOutputSearchHit, error) {
	return s.domainService().SearchIssueOutputs(ctx, params)
}

func (s IssueManagerService) UpdateIssue(ctx context.Context, workspaceID string, issueID string, input UpdateIssueManagerIssueInput) (workspaceissues.Issue, error) {
	issue, err := s.domainService().UpdateIssue(ctx, workspaceissues.UpdateIssueInput{
		IssueID:             issueID,
		WorkspaceID:         workspaceID,
		ActorUserID:         issueManagerLocalActorUserID,
		Title:               input.Title,
		HasTitle:            input.HasTitle,
		Content:             input.Content,
		HasContent:          input.HasContent,
		Status:              input.Status,
		HasStatus:           input.HasStatus,
		DispatchPaused:      input.DispatchPaused,
		HasDispatchPaused:   input.HasDispatchPaused,
		ExecutionProfile:    input.ExecutionProfile,
		HasExecutionProfile: input.HasExecutionProfile,
		Budget:              input.Budget,
		HasBudget:           input.HasBudget,
	})
	if err != nil {
		return workspaceissues.Issue{}, err
	}
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: issue.WorkspaceID,
		IssueID:     issue.IssueID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeIssueUpdated,
	})
	if !issue.DispatchPaused && issue.Budget.Status == workspaceissues.BudgetStatusActive &&
		(issue.SequentialExecution || issue.ParallelExecution) {
		s.dispatchEligibleIssueTasks(ctx, workspaceID, issueID)
	}
	return issue, nil
}

// dispatchEligibleIssueTasks is the lock-acquiring entry for callers that do
// not already hold the Issue mutation lock.
func (s IssueManagerService) dispatchEligibleIssueTasks(ctx context.Context, workspaceID, issueID string) {
	unlock := s.MutationLocks.Lock(workspaceID, issueID)
	launches := s.claimEligibleIssueRunsLocked(ctx, workspaceID, issueID)
	unlock()
	for _, launch := range launches {
		s.publishRunCreated(ctx, workspaceissues.Run{
			WorkspaceID:    launch.WorkspaceID,
			IssueID:        launch.IssueID,
			TaskID:         launch.TaskID,
			RunID:          launch.RunID,
			AgentSessionID: launch.AgentSessionID,
		})
	}
	s.launchClaimedIssueRuns(ctx, launches)
}

func (s IssueManagerService) DeleteIssue(ctx context.Context, workspaceID string, issueID string) (bool, error) {
	removed, err := s.domainService().DeleteIssue(ctx, workspaceID, issueID, issueManagerLocalActorUserID)
	if err != nil {
		return false, err
	}
	if removed {
		s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
			WorkspaceID: workspaceID,
			IssueID:     issueID,
			ChangeKind:  eventstreamservice.WorkspaceIssueChangeIssueDeleted,
		})
	}
	return removed, nil
}

func (s IssueManagerService) AddIssueContextRefs(ctx context.Context, workspaceID string, issueID string, input AddIssueManagerContextRefsInput) ([]workspaceissues.ContextRef, error) {
	refs, err := s.domainService().AddContextRefs(ctx, workspaceissues.AddContextRefsInput{
		WorkspaceID: workspaceID,
		IssueID:     issueID,
		ParentKind:  string(workspaceissues.ContextRefParentIssue),
		Refs:        input.Refs,
	})
	if err != nil {
		return nil, err
	}
	if len(refs) > 0 {
		s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
			WorkspaceID: workspaceID,
			IssueID:     issueID,
			ChangeKind:  eventstreamservice.WorkspaceIssueChangeIssueContextRefsUpdated,
		})
	}
	return refs, nil
}

func (s IssueManagerService) ListTasks(ctx context.Context, workspaceID string, issueID string, input ListIssueManagerItemsInput) (workspaceissues.TaskList, error) {
	service := s.domainService()
	cursor, err := workspaceissues.DecodeTaskListCursorToken(input.PageToken)
	if err != nil {
		return workspaceissues.TaskList{}, err
	}
	statusFilter, err := issueManagerStatusFilter(input.StatusFilter)
	if err != nil {
		return workspaceissues.TaskList{}, err
	}
	return service.ListTasks(ctx, workspaceissues.TaskListFilter{
		WorkspaceID:  workspaceID,
		IssueID:      issueID,
		PageSize:     input.PageSize,
		Cursor:       cursor,
		StatusFilter: statusFilter,
		SearchQuery:  input.SearchQuery,
		ReturnAll:    false,
	})
}

func (s IssueManagerService) CreateTask(ctx context.Context, workspaceID string, issueID string, input CreateIssueManagerTaskInput) (workspaceissues.Task, error) {
	tasks, err := s.CreateTasks(ctx, workspaceID, issueID, CreateIssueManagerTasksInput{
		Tasks: []CreateIssueManagerTaskItemInput{{
			TaskID:             input.TaskID,
			Title:              input.Title,
			Content:            input.Content,
			Priority:           input.Priority,
			DueAtUnixMS:        input.DueAtUnixMS,
			AgentTargetID:      input.AgentTargetID,
			ModelPlanID:        input.ModelPlanID,
			Model:              input.Model,
			ExecutionDirectory: input.ExecutionDirectory,
			DependencyTaskIDs:  input.DependencyTaskIDs,
			Parallelizable:     input.Parallelizable,
			AutoAccept:         input.AutoAccept,
		}},
	})
	if err != nil {
		return workspaceissues.Task{}, err
	}
	if len(tasks) != 1 {
		return workspaceissues.Task{}, workspaceissues.ErrInvalidArgument
	}
	return tasks[0], nil
}

func (s IssueManagerService) CreateTasks(ctx context.Context, workspaceID string, issueID string, input CreateIssueManagerTasksInput) ([]workspaceissues.Task, error) {
	items := make([]workspaceissues.CreateTaskItemInput, 0, len(input.Tasks))
	for _, task := range input.Tasks {
		items = append(items, workspaceissues.CreateTaskItemInput{
			TaskID:             task.TaskID,
			Title:              task.Title,
			Content:            task.Content,
			Priority:           task.Priority,
			DueAtUnixMS:        task.DueAtUnixMS,
			AgentTargetID:      task.AgentTargetID,
			ModelPlanID:        task.ModelPlanID,
			Model:              task.Model,
			PermissionModeID:   task.PermissionModeID,
			ReasoningEffort:    task.ReasoningEffort,
			ExecutionDirectory: task.ExecutionDirectory,
			DependencyTaskIDs:  task.DependencyTaskIDs,
			Parallelizable:     task.Parallelizable,
			AutoAccept:         task.AutoAccept,
		})
	}
	tasks, err := s.domainService().CreateTasks(ctx, workspaceissues.CreateTasksInput{
		IssueID:     issueID,
		WorkspaceID: workspaceID,
		ActorUserID: issueManagerLocalActorUserID,
		Tasks:       items,
	})
	if err != nil {
		return nil, err
	}
	for _, task := range tasks {
		s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
			WorkspaceID: task.WorkspaceID,
			IssueID:     task.IssueID,
			TaskID:      task.TaskID,
			ChangeKind:  eventstreamservice.WorkspaceIssueChangeTaskCreated,
		})
	}
	return tasks, nil
}

func (s IssueManagerService) GetTaskDetail(ctx context.Context, workspaceID string, issueID string, taskID string) (workspaceissues.TaskDetail, error) {
	s.reconcileWorkspaceRunsBestEffort(ctx, workspaceID)
	return s.domainService().GetTaskDetail(ctx, workspaceID, issueID, taskID)
}

func (s IssueManagerService) UpdateTask(ctx context.Context, workspaceID string, issueID string, taskID string, input UpdateIssueManagerTaskInput) (workspaceissues.Task, error) {
	unlock := s.MutationLocks.Lock(workspaceID, issueID)
	task, err := s.updateTaskLocked(ctx, workspaceID, issueID, taskID, input)
	unlock()
	if err != nil {
		return workspaceissues.Task{}, err
	}
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: task.WorkspaceID,
		IssueID:     task.IssueID,
		TaskID:      task.TaskID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeTaskUpdated,
	})
	if task.Status == workspaceissues.StatusCompleted && task.AcceptanceState == workspaceissues.AcceptanceUserAccepted {
		s.dispatchEligibleIssueTasks(ctx, workspaceID, issueID)
		s.notifyTuttiPlanIssueCompletedBestEffort(ctx, workspaceID, issueID)
	}
	// A rework (back to not_started) re-opens the execution frontier; without
	// this the rejected head of a sequential Issue waits for an unrelated event.
	if input.HasStatus && task.Status == workspaceissues.StatusNotStarted {
		s.dispatchEligibleIssueTasks(ctx, workspaceID, issueID)
	}
	return task, nil
}

func (s IssueManagerService) updateTaskLocked(ctx context.Context, workspaceID string, issueID string, taskID string, input UpdateIssueManagerTaskInput) (workspaceissues.Task, error) {
	task, err := s.domainService().UpdateTask(ctx, workspaceissues.UpdateTaskInput{
		TaskID:                taskID,
		IssueID:               issueID,
		WorkspaceID:           workspaceID,
		ActorUserID:           issueManagerLocalActorUserID,
		Title:                 input.Title,
		HasTitle:              input.HasTitle,
		Content:               input.Content,
		HasContent:            input.HasContent,
		Status:                input.Status,
		HasStatus:             input.HasStatus,
		Priority:              input.Priority,
		HasPriority:           input.HasPriority,
		DueAtUnixMS:           input.DueAtUnixMS,
		HasDueAt:              input.HasDueAt,
		SortIndex:             input.SortIndex,
		HasSortIndex:          input.HasSortIndex,
		AgentTargetID:         input.AgentTargetID,
		HasAgentTargetID:      input.HasAgentTargetID,
		ModelPlanID:           input.ModelPlanID,
		HasModelPlanID:        input.HasModelPlanID,
		Model:                 input.Model,
		HasModel:              input.HasModel,
		ExecutionDirectory:    input.ExecutionDirectory,
		HasExecutionDirectory: input.HasExecutionDirectory,
		DependencyTaskIDs:     input.DependencyTaskIDs,
		HasDependencyTaskIDs:  input.HasDependencyTaskIDs,
		Parallelizable:        input.Parallelizable,
		HasParallelizable:     input.HasParallelizable,
		AutoAccept:            input.AutoAccept,
		HasAutoAccept:         input.HasAutoAccept,
		AcceptanceState:       input.AcceptanceState,
		HasAcceptanceState:    input.HasAcceptanceState,
		AcceptanceSummary:     input.AcceptanceSummary,
		HasAcceptanceSummary:  input.HasAcceptanceSummary,
	})
	if err != nil {
		return workspaceissues.Task{}, err
	}
	return task, nil
}

// normalizeParallelizableAgainstDependencies keeps the durable parallelizable
// flag honest: a task that depends on a member of its own consecutive
// parallelizable group can never actually run alongside it — dependencies
// always outrank the flag at dispatch — so the misleading flag is stripped and
// the group splits there. Dependencies are never touched; they are the safe
// side of the contradiction.
func normalizeParallelizableAgainstDependencies(items []workspaceissues.CreateTaskItemInput) {
	group := make(map[string]struct{})
	for index := range items {
		if !items[index].Parallelizable {
			group = make(map[string]struct{})
			continue
		}
		conflicted := false
		for _, dependencyID := range items[index].DependencyTaskIDs {
			if _, inGroup := group[dependencyID]; inGroup {
				conflicted = true
				break
			}
		}
		if conflicted {
			items[index].Parallelizable = false
			group = make(map[string]struct{})
			continue
		}
		group[items[index].TaskID] = struct{}{}
	}
}

// notifyTuttiPlanIssueCompletedBestEffort hands control back to the planning
// conversation once every task of a tutti-mode-plan Issue is completed and
// user-accepted. The acceptance that crosses the finish line triggers it —
// including programmatic auto-accepts.
func (s IssueManagerService) notifyTuttiPlanIssueCompletedBestEffort(ctx context.Context, workspaceID string, issueID string) {
	if s.CompletionNotifier == nil {
		return
	}
	detail, err := s.domainService().GetIssueDetail(ctx, workspaceID, issueID)
	if err != nil ||
		detail.Issue.PlanningSource != workspaceissues.PlanningSourceTuttiModePlan ||
		strings.TrimSpace(detail.Issue.SourceSessionID) == "" ||
		len(detail.Tasks) == 0 {
		return
	}
	for _, task := range detail.Tasks {
		if task.Status == workspaceissues.StatusCanceled {
			continue
		}
		if task.Status != workspaceissues.StatusCompleted ||
			task.AcceptanceState != workspaceissues.AcceptanceUserAccepted {
			return
		}
	}
	s.CompletionNotifier.NotifyTuttiPlanIssueCompleted(ctx, workspaceID, detail.Issue, detail.Tasks)
}

func (s IssueManagerService) DeleteTask(ctx context.Context, workspaceID string, issueID string, taskID string) (bool, error) {
	removed, err := s.domainService().DeleteTask(ctx, workspaceID, issueID, taskID, issueManagerLocalActorUserID)
	if err != nil {
		return false, err
	}
	if removed {
		s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
			WorkspaceID: workspaceID,
			IssueID:     issueID,
			TaskID:      taskID,
			ChangeKind:  eventstreamservice.WorkspaceIssueChangeTaskDeleted,
		})
	}
	return removed, nil
}

func (s IssueManagerService) AddTaskContextRefs(ctx context.Context, workspaceID string, issueID string, taskID string, input AddIssueManagerContextRefsInput) ([]workspaceissues.ContextRef, error) {
	refs, err := s.domainService().AddContextRefs(ctx, workspaceissues.AddContextRefsInput{
		WorkspaceID: workspaceID,
		IssueID:     issueID,
		TaskID:      taskID,
		ParentKind:  string(workspaceissues.ContextRefParentTask),
		Refs:        input.Refs,
	})
	if err != nil {
		return nil, err
	}
	if len(refs) > 0 {
		s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
			WorkspaceID: workspaceID,
			IssueID:     issueID,
			TaskID:      taskID,
			ChangeKind:  eventstreamservice.WorkspaceIssueChangeTaskContextRefsUpdated,
		})
	}
	return refs, nil
}

func (s IssueManagerService) RemoveIssueContextRef(ctx context.Context, workspaceID string, issueID string, contextRefID string) (bool, error) {
	removed, err := s.domainService().RemoveContextRef(ctx, workspaceissues.RemoveContextRefInput{
		WorkspaceID:  workspaceID,
		IssueID:      issueID,
		ParentKind:   string(workspaceissues.ContextRefParentIssue),
		ContextRefID: contextRefID,
	})
	if err != nil {
		return false, err
	}
	if removed {
		s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
			WorkspaceID: workspaceID,
			IssueID:     issueID,
			ChangeKind:  eventstreamservice.WorkspaceIssueChangeIssueContextRefsUpdated,
		})
	}
	return removed, nil
}

func (s IssueManagerService) RemoveTaskContextRef(ctx context.Context, workspaceID string, issueID string, taskID string, contextRefID string) (bool, error) {
	removed, err := s.domainService().RemoveContextRef(ctx, workspaceissues.RemoveContextRefInput{
		WorkspaceID:  workspaceID,
		IssueID:      issueID,
		TaskID:       taskID,
		ParentKind:   string(workspaceissues.ContextRefParentTask),
		ContextRefID: contextRefID,
	})
	if err != nil {
		return false, err
	}
	if removed {
		s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
			WorkspaceID: workspaceID,
			IssueID:     issueID,
			TaskID:      taskID,
			ChangeKind:  eventstreamservice.WorkspaceIssueChangeTaskContextRefsUpdated,
		})
	}
	return removed, nil
}

func (s IssueManagerService) domainService() workspaceissues.Service {
	return workspaceissues.Service{Store: s.Store}
}

func (s IssueManagerService) enqueueWorkspaceRunReconcile(workspaceID string) {
	if s.RunReconcileQueue == nil {
		return
	}
	s.RunReconcileQueue.Enqueue(workspaceID)
}

func (s IssueManagerService) reconcileWorkspaceRunsBestEffort(ctx context.Context, workspaceID string) {
	if strings.TrimSpace(workspaceID) == "" || s.RunReconciler == nil {
		return
	}
	reconcileCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	_, _ = s.RunReconciler.ReconcileRunningRuns(reconcileCtx, workspaceID)
}

func (s IssueManagerService) publishWorkspaceIssueUpdated(ctx context.Context, update eventstreamservice.WorkspaceIssueUpdate) {
	if s.Publisher == nil {
		return
	}
	_ = s.Publisher.PublishWorkspaceIssueUpdated(ctx, update)
}

func issueManagerStatusFilter(raw string) (workspaceissues.Status, error) {
	raw = strings.ToLower(strings.TrimSpace(raw))
	if raw == "" || raw == "all" {
		return "", nil
	}
	status, ok := workspaceissues.NormalizeStatus(raw)
	if !ok {
		return "", workspaceissues.ErrInvalidArgument
	}
	return status, nil
}
