package workspace

import (
	"context"
	"strings"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

const issueManagerLocalActorUserID = "local"

type IssueManagerService struct {
	AgentSessionReader agentservice.SessionReader
	Publisher          IssueManagerEventPublisher
	RunReconcileQueue  *IssueRunReconcileQueue
	Store              workspaceissues.Store
}

type IssueManagerEventPublisher interface {
	PublishWorkspaceIssueUpdated(context.Context, eventstreamservice.WorkspaceIssueUpdate) error
}

type ListIssueManagerItemsInput struct {
	PageSize     int
	PageToken    string
	TopicID      string
	StatusFilter string
	SearchQuery  string
}

type CreateIssueManagerIssueInput struct {
	IssueID             string
	TopicID             string
	Title               string
	Content             string
	PlanningSource      string
	SourceSessionID     string
	SequentialExecution bool
	ParallelExecution   bool
	ExecutionProfile    workspaceissues.ExecutionProfile
	HasExecutionProfile bool
	Budget              workspaceissues.Budget
	HasBudget           bool
	// TuttiModeWorkflowOwned is an internal authority marker. Transport and
	// generic CLI adapters never set it; only the accepted workflow materializer
	// may create an Issue in the reserved deterministic namespace.
	TuttiModeWorkflowOwned bool
}

type CreateIssueManagerIssueFromPlanInput struct {
	Issue CreateIssueManagerIssueInput
	Tasks []CreateIssueManagerTaskItemInput
}

type CreateIssueManagerTopicInput struct {
	TopicID string
	Title   string
	Summary string
}

type UpdateIssueManagerTopicInput struct {
	Title      string
	HasTitle   bool
	Summary    string
	HasSummary bool
	Pinned     bool
	HasPinned  bool
}

type UpdateIssueManagerIssueInput struct {
	Title      string
	HasTitle   bool
	Content    string
	HasContent bool
	Status     string
	HasStatus  bool
}

type CreateIssueManagerTaskInput struct {
	TaskID      string
	Title       string
	Content     string
	Priority    string
	DueAtUnixMS int64
}

type CreateIssueManagerTaskItemInput struct {
	TaskID             string
	Title              string
	Content            string
	Priority           string
	DueAtUnixMS        int64
	AgentTargetID      string
	ModelPlanID        string
	Model              string
	PermissionModeID   string
	ReasoningEffort    string
	ExecutionDirectory string
	DependencyTaskIDs  []string
}

type CreateIssueManagerTasksInput struct {
	Tasks []CreateIssueManagerTaskItemInput
}

type UpdateIssueManagerTaskInput struct {
	Title        string
	HasTitle     bool
	Content      string
	HasContent   bool
	Status       string
	HasStatus    bool
	Priority     string
	HasPriority  bool
	DueAtUnixMS  int64
	HasDueAt     bool
	SortIndex    int
	HasSortIndex bool
}

type AddIssueManagerContextRefsInput struct {
	Refs []workspaceissues.AddContextRefInput
}

type CreateIssueManagerRunInput struct {
	RunID              string
	AgentTargetID      string
	AgentProvider      string
	AgentUserID        string
	AgentSessionID     string
	ExecutionDirectory string
}

type CompleteIssueManagerRunInput struct {
	Status       string
	Summary      string
	ErrorMessage string
	Outputs      []workspaceissues.CompleteRunOutputInput
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
		HasTitle:    input.HasTitle,
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
		})
	}
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
	return s.GetIssueDetail(ctx, workspaceID, issue.IssueID)
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
		IssueID:     issueID,
		WorkspaceID: workspaceID,
		ActorUserID: issueManagerLocalActorUserID,
		Title:       input.Title,
		HasTitle:    input.HasTitle,
		Content:     input.Content,
		HasContent:  input.HasContent,
		Status:      input.Status,
		HasStatus:   input.HasStatus,
	})
	if err != nil {
		return workspaceissues.Issue{}, err
	}
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: issue.WorkspaceID,
		IssueID:     issue.IssueID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeIssueUpdated,
	})
	return issue, nil
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
			TaskID:      input.TaskID,
			Title:       input.Title,
			Content:     input.Content,
			Priority:    input.Priority,
			DueAtUnixMS: input.DueAtUnixMS,
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
	task, err := s.domainService().UpdateTask(ctx, workspaceissues.UpdateTaskInput{
		TaskID:       taskID,
		IssueID:      issueID,
		WorkspaceID:  workspaceID,
		ActorUserID:  issueManagerLocalActorUserID,
		Title:        input.Title,
		HasTitle:     input.HasTitle,
		Content:      input.Content,
		HasContent:   input.HasContent,
		Status:       input.Status,
		HasStatus:    input.HasStatus,
		Priority:     input.Priority,
		HasPriority:  input.HasPriority,
		DueAtUnixMS:  input.DueAtUnixMS,
		HasDueAt:     input.HasDueAt,
		SortIndex:    input.SortIndex,
		HasSortIndex: input.HasSortIndex,
	})
	if err != nil {
		return workspaceissues.Task{}, err
	}
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: task.WorkspaceID,
		IssueID:     task.IssueID,
		TaskID:      task.TaskID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeTaskUpdated,
	})
	return task, nil
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

func (s IssueManagerService) ListRuns(ctx context.Context, workspaceID string, issueID string, taskID string) ([]workspaceissues.Run, error) {
	s.reconcileWorkspaceRunsBestEffort(ctx, workspaceID)
	return s.domainService().ListRuns(ctx, workspaceID, issueID, taskID)
}

func (s IssueManagerService) CreateRun(ctx context.Context, workspaceID string, issueID string, taskID string, input CreateIssueManagerRunInput) (workspaceissues.Run, error) {
	run, err := s.domainService().CreateRun(ctx, workspaceissues.CreateRunInput{
		RunID:              input.RunID,
		TaskID:             taskID,
		IssueID:            issueID,
		WorkspaceID:        workspaceID,
		ActorUserID:        issueManagerLocalActorUserID,
		AgentTargetID:      input.AgentTargetID,
		AgentProvider:      input.AgentProvider,
		AgentUserID:        input.AgentUserID,
		AgentSessionID:     input.AgentSessionID,
		ExecutionDirectory: input.ExecutionDirectory,
	})
	if err != nil {
		return workspaceissues.Run{}, err
	}
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: run.WorkspaceID,
		IssueID:     run.IssueID,
		TaskID:      run.TaskID,
		RunID:       run.RunID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeRunCreated,
	})
	s.enqueueWorkspaceRunReconcile(run.WorkspaceID)
	return run, nil
}

func (s IssueManagerService) GetRunDetail(ctx context.Context, workspaceID string, issueID string, taskID string, runID string) (workspaceissues.RunDetail, error) {
	return s.domainService().GetRunDetail(ctx, workspaceID, issueID, taskID, runID)
}

func (s IssueManagerService) CompleteRun(ctx context.Context, workspaceID string, issueID string, taskID string, runID string, input CompleteIssueManagerRunInput) (workspaceissues.RunDetail, error) {
	run, outputs, err := s.domainService().CompleteRun(ctx, workspaceissues.CompleteRunInput{
		RunID:        runID,
		TaskID:       taskID,
		IssueID:      issueID,
		WorkspaceID:  workspaceID,
		ActorUserID:  issueManagerLocalActorUserID,
		Status:       input.Status,
		Summary:      input.Summary,
		ErrorMessage: input.ErrorMessage,
		Outputs:      input.Outputs,
	})
	if err != nil {
		return workspaceissues.RunDetail{}, err
	}
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: run.WorkspaceID,
		IssueID:     run.IssueID,
		TaskID:      run.TaskID,
		RunID:       run.RunID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeRunCompleted,
	})
	return workspaceissues.RunDetail{Run: run, Outputs: outputs}, nil
}

func (s IssueManagerService) applyVisibleIssueSubtaskCounts(ctx context.Context, list *workspaceissues.IssueList) error {
	if list == nil || len(list.Items) == 0 {
		return nil
	}

	service := s.domainService()
	for index := range list.Items {
		issue := &list.Items[index]
		tasks, err := service.ListTasks(ctx, workspaceissues.TaskListFilter{
			WorkspaceID: issue.WorkspaceID,
			IssueID:     issue.IssueID,
			ReturnAll:   true,
		})
		if err != nil {
			return err
		}
		runs, err := service.ListRuns(ctx, issue.WorkspaceID, issue.IssueID, "")
		if err != nil {
			return err
		}
		var latestRun *workspaceissues.Run
		if len(runs) > 0 {
			latestRun = &runs[0]
		}
		applyVisibleIssueSubtaskCount(issue, tasks.Items, latestRun)
	}
	return nil
}

func applyVisibleIssueSubtaskCount(issue *workspaceissues.Issue, tasks []workspaceissues.Task, latestRun *workspaceissues.Run) {
	if issue == nil {
		return
	}
	counts := countVisibleIssueSubtaskStatuses(*issue, tasks, latestRun)
	issue.TaskCount = counts.All
	issue.NotStartedCount = counts.NotStarted
	issue.RunningCount = counts.Running
	issue.PendingAcceptanceCount = counts.PendingAcceptance
	issue.CompletedCount = counts.Completed + counts.PendingAcceptance
	issue.FailedCount = counts.Failed
	issue.CanceledCount = counts.Canceled
}

func countVisibleIssueSubtaskStatuses(issue workspaceissues.Issue, tasks []workspaceissues.Task, latestRun *workspaceissues.Run) workspaceissues.StatusCounts {
	hiddenTaskID := hiddenIssueRunTaskID(issue, tasks, latestRun)
	var counts workspaceissues.StatusCounts
	for _, task := range tasks {
		if task.TaskID == hiddenTaskID {
			continue
		}
		incrementIssueManagerStatusCount(&counts, task.Status)
	}
	return counts
}

func hiddenIssueRunTaskID(issue workspaceissues.Issue, tasks []workspaceissues.Task, latestRun *workspaceissues.Run) string {
	if latestRun == nil {
		return ""
	}
	taskID := strings.TrimSpace(latestRun.TaskID)
	if taskID == "" {
		return ""
	}
	issueTitle := strings.TrimSpace(issue.Title)
	for _, task := range tasks {
		if task.TaskID != taskID {
			continue
		}
		taskTitle := strings.TrimSpace(task.Title)
		if taskTitle != "" && taskTitle != issueTitle {
			return ""
		}
		return taskID
	}
	return ""
}

func incrementIssueManagerStatusCount(counts *workspaceissues.StatusCounts, status workspaceissues.Status) {
	counts.All++
	switch status {
	case workspaceissues.StatusNotStarted:
		counts.NotStarted++
	case workspaceissues.StatusRunning:
		counts.Running++
	case workspaceissues.StatusPendingAcceptance:
		counts.PendingAcceptance++
	case workspaceissues.StatusCompleted:
		counts.Completed++
	case workspaceissues.StatusFailed:
		counts.Failed++
	case workspaceissues.StatusCanceled:
		counts.Canceled++
	default:
		counts.NotStarted++
	}
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
	if strings.TrimSpace(workspaceID) == "" || s.AgentSessionReader == nil {
		return
	}
	reconcileCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	_, _ = s.ReconcileRunningRuns(reconcileCtx, workspaceID)
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
