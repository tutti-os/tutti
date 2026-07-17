package workspaceissues

import (
	"context"
	"strings"
)

func (s Service) ListTasks(ctx context.Context, filter TaskListFilter) (TaskList, error) {
	store, err := s.store()
	if err != nil {
		return TaskList{}, err
	}
	filter.WorkspaceID = strings.TrimSpace(filter.WorkspaceID)
	filter.IssueID = strings.TrimSpace(filter.IssueID)
	if filter.WorkspaceID == "" || filter.IssueID == "" {
		return TaskList{}, ErrInvalidArgument
	}
	if filter.StatusFilter != "" {
		if _, ok := NormalizeStatus(string(filter.StatusFilter)); !ok {
			return TaskList{}, ErrInvalidArgument
		}
	}
	filter.SearchQuery = strings.TrimSpace(filter.SearchQuery)
	if _, err := store.GetIssue(ctx, filter.WorkspaceID, filter.IssueID); err != nil {
		return TaskList{}, err
	}
	list, err := store.ListTasks(ctx, filter)
	if err != nil {
		return TaskList{}, err
	}
	list.NextPageToken = EncodeTaskListCursorToken(list.NextCursor)
	return list, nil
}

func (s Service) CreateTask(ctx context.Context, input CreateTaskInput) (Task, error) {
	tasks, err := s.CreateTasks(ctx, CreateTasksInput{
		IssueID:     input.IssueID,
		WorkspaceID: input.WorkspaceID,
		ActorUserID: input.ActorUserID,
		Tasks: []CreateTaskItemInput{{
			TaskID:             input.TaskID,
			Title:              input.Title,
			Content:            input.Content,
			Priority:           input.Priority,
			DueAtUnixMS:        input.DueAtUnixMS,
			AgentTargetID:      input.AgentTargetID,
			ModelPlanID:        input.ModelPlanID,
			Model:              input.Model,
			PermissionModeID:   input.PermissionModeID,
			ReasoningEffort:    input.ReasoningEffort,
			ExecutionDirectory: input.ExecutionDirectory,
			DependencyTaskIDs:  input.DependencyTaskIDs,
			Parallelizable:     input.Parallelizable,
		}},
	})
	if err != nil {
		return Task{}, err
	}
	if len(tasks) != 1 {
		return Task{}, ErrInvalidArgument
	}
	return tasks[0], nil
}

func (s Service) CreateTasks(ctx context.Context, input CreateTasksInput) ([]Task, error) {
	store, err := s.store()
	if err != nil {
		return nil, err
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	issueID := strings.TrimSpace(input.IssueID)
	actorUserID := strings.TrimSpace(input.ActorUserID)
	if workspaceID == "" || issueID == "" || actorUserID == "" || len(input.Tasks) == 0 {
		return nil, ErrInvalidArgument
	}
	issue, err := store.GetIssue(ctx, workspaceID, issueID)
	if err != nil {
		return nil, err
	}
	tasks, err := s.buildTasks(issue, actorUserID, input.Tasks)
	if err != nil {
		return nil, err
	}
	existing, err := store.ListTasks(ctx, TaskListFilter{WorkspaceID: workspaceID, IssueID: issueID, ReturnAll: true})
	if err != nil {
		return nil, err
	}
	graph := append(append([]Task(nil), existing.Items...), tasks...)
	if !ValidateTaskDependencyGraph(graph) {
		return nil, ErrInvalidArgument
	}
	created, err := store.AppendTasks(ctx, tasks)
	if err != nil {
		return nil, err
	}
	projected, err := store.RecalculateIssueProjection(ctx, workspaceID, issueID)
	if err != nil {
		return nil, err
	}
	if projected.Budget.Mode == BudgetModeAuto {
		projected.Budget.TokenLimit = CompileAutoTokenBudget(projected.TaskCount, projected.ExecutionProfile)
		if _, err := store.UpdateIssue(ctx, projected); err != nil {
			return nil, err
		}
	}
	if err := store.TouchTopicActivity(ctx, workspaceID, issue.TopicID, s.nowUnixMS()); err != nil {
		return nil, err
	}
	return created, nil
}

func (s Service) buildTasks(issue Issue, actorUserID string, items []CreateTaskItemInput) ([]Task, error) {
	now := s.nowUnixMS()
	tasks := make([]Task, 0, len(items))
	for _, item := range items {
		title := strings.TrimSpace(item.Title)
		if title == "" {
			return nil, ErrInvalidArgument
		}
		agentTargetID := strings.TrimSpace(item.AgentTargetID)
		modelPlanID := strings.TrimSpace(item.ModelPlanID)
		model := strings.TrimSpace(item.Model)
		if agentTargetID == "" && (modelPlanID != "" || model != "") {
			return nil, ErrInvalidArgument
		}
		task := Task{
			TaskID:             s.resolveID(IDKindTask, item.TaskID),
			IssueID:            issue.IssueID,
			WorkspaceID:        issue.WorkspaceID,
			Title:              title,
			Content:            strings.TrimSpace(item.Content),
			SearchText:         TrimSearchText(item.Content),
			Status:             StatusNotStarted,
			Priority:           NormalizePriority(item.Priority),
			DueAtUnixMS:        maxInt64(item.DueAtUnixMS, 0),
			AgentTargetID:      agentTargetID,
			ModelPlanID:        modelPlanID,
			Model:              model,
			PermissionModeID:   strings.TrimSpace(item.PermissionModeID),
			ReasoningEffort:    strings.TrimSpace(item.ReasoningEffort),
			ExecutionDirectory: strings.TrimSpace(item.ExecutionDirectory),
			DependencyTaskIDs:  NormalizeDependencyTaskIDs(item.DependencyTaskIDs),
			Parallelizable:     item.Parallelizable,
			AcceptanceState:    AcceptanceAgentClaimed,
			CreatorUserID:      actorUserID,
			CreatedAtUnixMS:    now,
			UpdatedAtUnixMS:    now,
		}
		if task.TaskID == "" {
			return nil, ErrInvalidArgument
		}
		tasks = append(tasks, task)
	}
	return tasks, nil
}

func (s Service) UpdateTask(ctx context.Context, input UpdateTaskInput) (Task, error) {
	store, err := s.store()
	if err != nil {
		return Task{}, err
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	issueID := strings.TrimSpace(input.IssueID)
	taskID := strings.TrimSpace(input.TaskID)
	if workspaceID == "" || issueID == "" || taskID == "" || strings.TrimSpace(input.ActorUserID) == "" {
		return Task{}, ErrInvalidArgument
	}
	issue, err := store.GetIssue(ctx, workspaceID, issueID)
	if err != nil {
		return Task{}, err
	}
	task, err := store.GetTask(ctx, workspaceID, issueID, taskID)
	if err != nil {
		return Task{}, err
	}
	if input.HasTitle {
		title := strings.TrimSpace(input.Title)
		if title == "" {
			return Task{}, ErrInvalidArgument
		}
		task.Title = title
	}
	if input.HasContent {
		task.Content = strings.TrimSpace(input.Content)
		task.SearchText = TrimSearchText(input.Content)
	}
	if input.HasStatus {
		status, ok := NormalizeStatus(input.Status)
		if !ok {
			return Task{}, ErrInvalidArgument
		}
		task.Status = status
	}
	if input.HasPriority {
		task.Priority = NormalizePriority(input.Priority)
	}
	if input.HasDueAt {
		task.DueAtUnixMS = input.DueAtUnixMS
	}
	if input.HasSortIndex {
		if input.SortIndex < 0 {
			return Task{}, ErrInvalidArgument
		}
		task.SortIndex = input.SortIndex
	}
	if input.HasParallelizable {
		task.Parallelizable = input.Parallelizable
	}
	if task.AcceptanceState == "" {
		if task.Status == StatusCompleted || task.Status == StatusPendingAcceptance {
			task.AcceptanceState = AcceptanceAutoChecked
		} else {
			task.AcceptanceState = AcceptanceAgentClaimed
		}
	}
	if input.HasAcceptanceState {
		next, ok := NormalizeAcceptanceState(input.AcceptanceState)
		if !ok || !CanTransitionAcceptance(task.AcceptanceState, next) {
			return Task{}, ErrInvalidArgument
		}
		task.AcceptanceState = next
	}
	if input.HasAcceptanceSummary {
		task.AcceptanceSummary = strings.TrimSpace(input.AcceptanceSummary)
	}
	if input.HasStatus {
		switch task.Status {
		case StatusCompleted:
			if !input.HasAcceptanceState && CanTransitionAcceptance(task.AcceptanceState, AcceptanceUserAccepted) {
				task.AcceptanceState = AcceptanceUserAccepted
			}
			if task.AcceptanceState != AcceptanceUserAccepted {
				return Task{}, ErrInvalidArgument
			}
		case StatusNotStarted:
			task.AcceptanceState = AcceptanceAgentClaimed
			task.AcceptanceSummary = ""
		}
	}
	task.UpdatedAtUnixMS = s.nowUnixMS()
	updated, err := store.UpdateTask(ctx, task)
	if err != nil {
		return Task{}, err
	}
	if _, err := store.RecalculateIssueProjection(ctx, workspaceID, issueID); err != nil {
		return Task{}, err
	}
	if err := store.TouchTopicActivity(ctx, workspaceID, issue.TopicID, task.UpdatedAtUnixMS); err != nil {
		return Task{}, err
	}
	return updated, nil
}

func (s Service) GetTaskDetail(ctx context.Context, workspaceID string, issueID string, taskID string) (TaskDetail, error) {
	store, err := s.store()
	if err != nil {
		return TaskDetail{}, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	issueID = strings.TrimSpace(issueID)
	taskID = strings.TrimSpace(taskID)
	if workspaceID == "" || issueID == "" || taskID == "" {
		return TaskDetail{}, ErrInvalidArgument
	}
	task, err := store.GetTask(ctx, workspaceID, issueID, taskID)
	if err != nil {
		return TaskDetail{}, err
	}
	refs, err := store.ListContextRefs(ctx, workspaceID, issueID, taskID, ContextRefParentTask)
	if err != nil {
		return TaskDetail{}, err
	}
	runs, err := store.ListRuns(ctx, workspaceID, issueID, taskID)
	if err != nil {
		return TaskDetail{}, err
	}
	var latestRun *Run
	if len(runs) > 0 {
		latestRun = &runs[0]
	}
	outputs, err := store.ListLatestRunOutputs(ctx, workspaceID, issueID, taskID)
	if err != nil {
		return TaskDetail{}, err
	}
	return TaskDetail{
		Task:          task,
		ContextRefs:   refs,
		LatestRun:     latestRun,
		RecentRuns:    runs,
		LatestOutputs: outputs,
	}, nil
}

func (s Service) DeleteTask(ctx context.Context, workspaceID string, issueID string, taskID string, actorUserID string) (bool, error) {
	store, err := s.store()
	if err != nil {
		return false, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	issueID = strings.TrimSpace(issueID)
	taskID = strings.TrimSpace(taskID)
	actorUserID = strings.TrimSpace(actorUserID)
	if workspaceID == "" || issueID == "" || taskID == "" || actorUserID == "" {
		return false, ErrInvalidArgument
	}
	issue, err := store.GetIssue(ctx, workspaceID, issueID)
	if err != nil {
		return false, err
	}
	removed, err := store.DeleteTask(ctx, workspaceID, issueID, taskID, actorUserID)
	if err != nil {
		return false, err
	}
	if !removed {
		return false, ErrTaskNotFound
	}
	if _, err := store.RecalculateIssueProjection(ctx, workspaceID, issueID); err != nil {
		return false, err
	}
	if err := store.TouchTopicActivity(ctx, workspaceID, issue.TopicID, s.nowUnixMS()); err != nil {
		return false, err
	}
	return true, nil
}
