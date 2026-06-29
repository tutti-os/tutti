package issuemanager

import (
	"context"
	"encoding/json"
	"fmt"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

type taskListInput struct {
	IssueID   string `cli:"issue-id" validate:"required"`
	Status    string `cli:"status"`
	Search    string `cli:"search"`
	PageSize  int    `cli:"page-size" validate:"min=1,max=100"`
	PageToken string `cli:"page-token"`
}

type issueTaskInput struct {
	IssueID string `cli:"issue-id" validate:"required"`
	TaskID  string `cli:"task-id" validate:"required"`
}

type taskCreateInput struct {
	IssueID   string `cli:"issue-id" validate:"required" description:"Issue that owns the task."`
	TaskID    string `cli:"task-id" description:"Stable task id to create; generated when omitted."`
	Title     string `cli:"title" validate:"required" description:"Task title."`
	Content   string `cli:"content" description:"Task instructions or notes."`
	Priority  string `cli:"priority" description:"Task priority: high, medium, or low."`
	DueAtUnix int64  `cli:"due-at-unix" description:"Due time as a Unix timestamp in seconds."`
}

type taskCreateBatchInput struct {
	IssueID   string `cli:"issue-id" validate:"required" description:"Issue that owns the tasks."`
	TasksJSON string `cli:"tasks-json" validate:"required" description:"JSON array of task objects with title, optional taskId, content, priority, and dueAtUnix."`
}

type taskCreateBatchItemInput struct {
	TaskID    string `json:"taskId"`
	Title     string `json:"title"`
	Content   string `json:"content"`
	Priority  string `json:"priority"`
	DueAtUnix int64  `json:"dueAtUnix"`
}

type taskUpdateInput struct {
	IssueID   string  `cli:"issue-id" validate:"required" description:"Issue that owns the task."`
	TaskID    string  `cli:"task-id" validate:"required" description:"Task to update."`
	Title     *string `cli:"title" description:"Replace the task title."`
	Content   *string `cli:"content" description:"Replace the task instructions or notes."`
	Status    *string `cli:"status" description:"Task status: not_started, running, pending_acceptance, completed, failed, or canceled."`
	Priority  *string `cli:"priority" description:"Task priority: high, medium, or low."`
	DueAtUnix *int64  `cli:"due-at-unix" description:"Set due time as a Unix timestamp in seconds."`
}

func (p Provider) newTaskListCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[taskListInput]{
		ID:          appID + ".issue.task.list",
		Path:        []string{"issue", "task", "list"},
		Summary:     "List issue tasks",
		Description: "List tasks under an issue. JSON output omits task content bodies.",
		Kind:        framework.KindList,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[taskListInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeTable,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			Table:       &framework.TableOutputSpec{Columns: taskColumns, Rows: func(result any) []map[string]any { return taskRows(result.(workspaceissues.TaskList).Items) }},
			JSONViews:   map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: taskListJSONValue},
			ListCompact: true,
		},
		Run: p.runTaskList,
	})
}

func (p Provider) newTaskGetCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueTaskInput]{
		ID:          appID + ".issue.task.get",
		Path:        []string{"issue", "task", "get"},
		Summary:     "Get issue task detail",
		Description: "Get task detail, latest run, recent runs, and latest outputs.",
		Kind:        framework.KindGet,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueTaskInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewDetail,
			JSON:        true,
			JSONViews:   map[framework.OutputView]func(any) map[string]any{framework.ViewDetail: taskDetailJSONValue},
		},
		Run: p.runTaskGet,
	})
}

func (p Provider) newTaskCreateCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[taskCreateInput]{
		ID:          appID + ".issue.task.create",
		Path:        []string{"issue", "task", "create"},
		Summary:     "Create an issue task",
		Description: "Create a child task under an issue. Use this to persist task breakdown output without creating a run.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[taskCreateInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					return map[string]any{"task": taskActionSummaryValue(result.(workspaceissues.Task))}
				},
			},
		},
		Run: p.runTaskCreate,
	})
}

func (p Provider) newTaskCreateBatchCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[taskCreateBatchInput]{
		ID:          appID + ".issue.task.create-batch",
		Path:        []string{"issue", "task", "create-batch"},
		Summary:     "Create ordered issue tasks",
		Description: "Create multiple child tasks under an issue in the JSON array order. Use this to persist task breakdown output without creating runs.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[taskCreateBatchInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					return map[string]any{"tasks": taskSummaryValues(result.([]workspaceissues.Task))}
				},
			},
		},
		Run: p.runTaskCreateBatch,
	})
}

func (p Provider) newTaskUpdateCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[taskUpdateInput]{
		ID:          appID + ".issue.task.update",
		Path:        []string{"issue", "task", "update"},
		Summary:     "Update an issue task",
		Description: "Update a task under an issue. Breakdown updates should edit task fields without creating or completing runs.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[taskUpdateInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					return map[string]any{"task": taskActionSummaryValue(result.(workspaceissues.Task))}
				},
			},
		},
		Run: p.runTaskUpdate,
	})
}

func (p Provider) newTaskDeleteCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[issueTaskInput]{
		ID:          appID + ".issue.task.delete",
		Path:        []string{"issue", "task", "delete"},
		Summary:     "Delete an issue task",
		Description: "Delete a task under an issue.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[issueTaskInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews:   map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: func(result any) map[string]any { return map[string]any{"removed": result.(bool)} }},
		},
		Run: p.runTaskDelete,
	})
}

func (p Provider) runTaskList(ctx context.Context, invoke framework.InvokeContext, input taskListInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	return p.issues.ListTasks(ctx, invoke.WorkspaceID, input.IssueID, workspaceservice.ListIssueManagerItemsInput{
		StatusFilter: input.Status,
		SearchQuery:  input.Search,
		PageSize:     input.PageSize,
		PageToken:    input.PageToken,
	})
}

func taskListJSONValue(result any) map[string]any {
	list := result.(workspaceissues.TaskList)
	value := map[string]any{
		"tasks":        taskSummaryValues(list.Items),
		"totalCount":   list.TotalCount,
		"statusCounts": statusCountsValue(list.StatusCounts),
	}
	maybeAddNextPageToken(value, list.NextPageToken)
	return value
}

// taskGetResult carries the task detail plus its resolved referenced input files (see issueGetResult).
type taskGetResult struct {
	detail     workspaceissues.TaskDetail
	references []issueReferenceFile
}

func (p Provider) runTaskGet(ctx context.Context, invoke framework.InvokeContext, input issueTaskInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	detail, err := p.issues.GetTaskDetail(ctx, invoke.WorkspaceID, input.IssueID, input.TaskID)
	if err != nil {
		return nil, err
	}
	return taskGetResult{
		detail:     detail,
		references: p.collectTaskReferences(ctx, invoke.WorkspaceID, detail),
	}, nil
}

func taskDetailJSONValue(result any) map[string]any {
	res := result.(taskGetResult)
	detail := res.detail
	var latestRun any
	if detail.LatestRun != nil {
		latestRun = runSummaryValue(*detail.LatestRun)
	}
	return map[string]any{
		"detail": map[string]any{
			"task":          taskDetailValue(detail.Task),
			"latestRun":     latestRun,
			"recentRuns":    runSummaryValues(detail.RecentRuns),
			"latestOutputs": runOutputValues(detail.LatestOutputs),
			"references":    referenceFileValues(res.references),
		},
	}
}

func (p Provider) runTaskCreate(ctx context.Context, invoke framework.InvokeContext, input taskCreateInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	return p.issues.CreateTask(ctx, invoke.WorkspaceID, input.IssueID, workspaceservice.CreateIssueManagerTaskInput{
		TaskID:      input.TaskID,
		Title:       input.Title,
		Content:     input.Content,
		Priority:    input.Priority,
		DueAtUnixMS: input.DueAtUnix * 1000,
	})
}

func (p Provider) runTaskCreateBatch(ctx context.Context, invoke framework.InvokeContext, input taskCreateBatchInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	var parsed []taskCreateBatchItemInput
	if err := json.Unmarshal([]byte(input.TasksJSON), &parsed); err != nil {
		return nil, fmt.Errorf("%w: invalid tasks-json", cliservice.ErrInvalidInput)
	}
	if len(parsed) == 0 {
		return nil, fmt.Errorf("%w: tasks-json must include at least one task", cliservice.ErrInvalidInput)
	}
	tasks := make([]workspaceservice.CreateIssueManagerTaskItemInput, 0, len(parsed))
	for _, item := range parsed {
		tasks = append(tasks, workspaceservice.CreateIssueManagerTaskItemInput{
			TaskID:      item.TaskID,
			Title:       item.Title,
			Content:     item.Content,
			Priority:    item.Priority,
			DueAtUnixMS: item.DueAtUnix * 1000,
		})
	}
	return p.issues.CreateTasks(ctx, invoke.WorkspaceID, input.IssueID, workspaceservice.CreateIssueManagerTasksInput{
		Tasks: tasks,
	})
}

func (p Provider) runTaskUpdate(ctx context.Context, invoke framework.InvokeContext, input taskUpdateInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	if input.Title == nil && input.Content == nil && input.Status == nil && input.Priority == nil && input.DueAtUnix == nil {
		return nil, workspaceissues.ErrInvalidArgument
	}
	update := workspaceservice.UpdateIssueManagerTaskInput{
		HasTitle:    input.Title != nil,
		HasContent:  input.Content != nil,
		HasStatus:   input.Status != nil,
		HasPriority: input.Priority != nil,
		HasDueAt:    input.DueAtUnix != nil,
	}
	if input.Title != nil {
		update.Title = *input.Title
	}
	if input.Content != nil {
		update.Content = *input.Content
	}
	if input.Status != nil {
		update.Status = *input.Status
	}
	if input.Priority != nil {
		update.Priority = *input.Priority
	}
	if input.DueAtUnix != nil {
		update.DueAtUnixMS = *input.DueAtUnix * 1000
	}
	return p.issues.UpdateTask(ctx, invoke.WorkspaceID, input.IssueID, input.TaskID, update)
}

func (p Provider) runTaskDelete(ctx context.Context, invoke framework.InvokeContext, input issueTaskInput) (any, error) {
	if err := p.requireIssueManager(); err != nil {
		return nil, err
	}
	return p.issues.DeleteTask(ctx, invoke.WorkspaceID, input.IssueID, input.TaskID)
}
