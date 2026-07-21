package api

import (
	"context"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	workspaceapi "github.com/tutti-os/tutti/services/tuttid/api/workspace"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

func (api DaemonAPI) ListWorkspaceIssues(ctx context.Context, request tuttigenerated.ListWorkspaceIssuesRequestObject) (tuttigenerated.ListWorkspaceIssuesResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.ListWorkspaceIssues503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}

	list, err := api.IssueService.ListIssues(ctx, string(request.WorkspaceID), issueManagerIssueListInputFromGenerated(request.Params))
	if err != nil {
		return writeListWorkspaceIssuesError(err), nil
	}
	return tuttigenerated.ListWorkspaceIssues200JSONResponse(
		workspaceapi.GeneratedIssueManagerIssueListResponseFromDomain(list),
	), nil
}

func (api DaemonAPI) ListWorkspaceIssueTopics(ctx context.Context, request tuttigenerated.ListWorkspaceIssueTopicsRequestObject) (tuttigenerated.ListWorkspaceIssueTopicsResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.ListWorkspaceIssueTopics503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}

	list, err := api.IssueService.ListTopics(ctx, string(request.WorkspaceID))
	if err != nil {
		return writeListWorkspaceIssueTopicsError(err), nil
	}
	return tuttigenerated.ListWorkspaceIssueTopics200JSONResponse(
		workspaceapi.GeneratedIssueManagerTopicListResponseFromDomain(list),
	), nil
}

func (api DaemonAPI) CreateWorkspaceIssueTopic(ctx context.Context, request tuttigenerated.CreateWorkspaceIssueTopicRequestObject) (tuttigenerated.CreateWorkspaceIssueTopicResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.CreateWorkspaceIssueTopic503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateWorkspaceIssueTopic400JSONResponse{InvalidRequestErrorJSONResponse: issueManagerEmptyBodyError()}, nil
	}

	topic, err := api.IssueService.CreateTopic(ctx, string(request.WorkspaceID), workspaceservice.CreateIssueManagerTopicInput{
		TopicID: optionalString(request.Body.TopicId),
		Title:   request.Body.Title,
		Summary: optionalString(request.Body.Summary),
	})
	if err != nil {
		return writeCreateWorkspaceIssueTopicError(err), nil
	}
	return tuttigenerated.CreateWorkspaceIssueTopic201JSONResponse(
		workspaceapi.GeneratedIssueManagerTopicResponseFromDomain(topic),
	), nil
}

func (api DaemonAPI) UpdateWorkspaceIssueTopic(ctx context.Context, request tuttigenerated.UpdateWorkspaceIssueTopicRequestObject) (tuttigenerated.UpdateWorkspaceIssueTopicResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.UpdateWorkspaceIssueTopic503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UpdateWorkspaceIssueTopic400JSONResponse{InvalidRequestErrorJSONResponse: issueManagerEmptyBodyError()}, nil
	}

	topic, err := api.IssueService.UpdateTopic(ctx, string(request.WorkspaceID), string(request.TopicID), workspaceservice.UpdateIssueManagerTopicInput{
		Title:      optionalString(request.Body.Title),
		HasTitle:   request.Body.Title != nil,
		Summary:    optionalString(request.Body.Summary),
		HasSummary: request.Body.Summary != nil,
		Pinned:     optionalBool(request.Body.Pinned),
		HasPinned:  request.Body.Pinned != nil,
	})
	if err != nil {
		return writeUpdateWorkspaceIssueTopicError(err), nil
	}
	return tuttigenerated.UpdateWorkspaceIssueTopic200JSONResponse(
		workspaceapi.GeneratedIssueManagerTopicResponseFromDomain(topic),
	), nil
}

func (api DaemonAPI) DeleteWorkspaceIssueTopic(ctx context.Context, request tuttigenerated.DeleteWorkspaceIssueTopicRequestObject) (tuttigenerated.DeleteWorkspaceIssueTopicResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.DeleteWorkspaceIssueTopic503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}

	removed, err := api.IssueService.DeleteTopic(ctx, string(request.WorkspaceID), string(request.TopicID))
	if err != nil {
		return writeDeleteWorkspaceIssueTopicError(err), nil
	}
	return tuttigenerated.DeleteWorkspaceIssueTopic200JSONResponse{Removed: removed}, nil
}

func (api DaemonAPI) CreateWorkspaceIssue(ctx context.Context, request tuttigenerated.CreateWorkspaceIssueRequestObject) (tuttigenerated.CreateWorkspaceIssueResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.CreateWorkspaceIssue503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateWorkspaceIssue400JSONResponse{InvalidRequestErrorJSONResponse: issueManagerEmptyBodyError()}, nil
	}

	issue, err := api.IssueService.CreateIssue(ctx, string(request.WorkspaceID), issueManagerCreateIssueInputFromGenerated(*request.Body))
	if err != nil {
		return writeCreateWorkspaceIssueError(err), nil
	}
	return tuttigenerated.CreateWorkspaceIssue201JSONResponse(
		workspaceapi.GeneratedIssueManagerIssueResponseFromDomain(issue),
	), nil
}

func (api DaemonAPI) RemoveWorkspaceIssueContextRef(ctx context.Context, request tuttigenerated.RemoveWorkspaceIssueContextRefRequestObject) (tuttigenerated.RemoveWorkspaceIssueContextRefResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.RemoveWorkspaceIssueContextRef503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}

	removed, err := api.IssueService.RemoveIssueContextRef(ctx, string(request.WorkspaceID), string(request.IssueID), string(request.ContextRefID))
	if err != nil {
		return writeRemoveWorkspaceIssueContextRefError(err), nil
	}
	return tuttigenerated.RemoveWorkspaceIssueContextRef200JSONResponse{Removed: removed}, nil
}

func (api DaemonAPI) RemoveWorkspaceIssueTaskContextRef(ctx context.Context, request tuttigenerated.RemoveWorkspaceIssueTaskContextRefRequestObject) (tuttigenerated.RemoveWorkspaceIssueTaskContextRefResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.RemoveWorkspaceIssueTaskContextRef503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}

	removed, err := api.IssueService.RemoveTaskContextRef(ctx, string(request.WorkspaceID), string(request.IssueID), string(request.TaskID), string(request.ContextRefID))
	if err != nil {
		return writeRemoveWorkspaceIssueTaskContextRefError(err), nil
	}
	return tuttigenerated.RemoveWorkspaceIssueTaskContextRef200JSONResponse{Removed: removed}, nil
}

func (api DaemonAPI) DeleteWorkspaceIssue(ctx context.Context, request tuttigenerated.DeleteWorkspaceIssueRequestObject) (tuttigenerated.DeleteWorkspaceIssueResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.DeleteWorkspaceIssue503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}

	removed, err := api.IssueService.DeleteIssue(ctx, string(request.WorkspaceID), string(request.IssueID))
	if err != nil {
		return writeDeleteWorkspaceIssueError(err), nil
	}
	return tuttigenerated.DeleteWorkspaceIssue200JSONResponse{Removed: removed}, nil
}

func (api DaemonAPI) GetWorkspaceIssueDetail(ctx context.Context, request tuttigenerated.GetWorkspaceIssueDetailRequestObject) (tuttigenerated.GetWorkspaceIssueDetailResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.GetWorkspaceIssueDetail503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}

	detail, err := api.IssueService.GetIssueDetail(ctx, string(request.WorkspaceID), string(request.IssueID))
	if err != nil {
		return writeGetWorkspaceIssueDetailError(err), nil
	}
	return tuttigenerated.GetWorkspaceIssueDetail200JSONResponse(
		workspaceapi.GeneratedIssueManagerIssueDetailResponseFromDomain(detail),
	), nil
}

func (api DaemonAPI) SearchWorkspaceIssueReferences(ctx context.Context, request tuttigenerated.SearchWorkspaceIssueReferencesRequestObject) (tuttigenerated.SearchWorkspaceIssueReferencesResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.SearchWorkspaceIssueReferences503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.SearchWorkspaceIssueReferences400JSONResponse{InvalidRequestErrorJSONResponse: issueManagerEmptyBodyError()}, nil
	}

	var filters []string
	if request.Body.Filters != nil {
		filters = *request.Body.Filters
	}
	hits, err := api.IssueService.SearchIssueOutputs(ctx, workspaceissues.RunOutputSearchParams{
		WorkspaceID: string(request.WorkspaceID),
		Query:       request.Body.Query,
		Filters:     filters,
		IssueID:     optionalString(request.Body.IssueId),
		TopicID:     optionalString(request.Body.TopicId),
		Limit:       optionalInt(request.Body.Limit),
	})
	if err != nil {
		return writeSearchWorkspaceIssueReferencesError(err), nil
	}
	return tuttigenerated.SearchWorkspaceIssueReferences200JSONResponse(
		workspaceapi.GeneratedIssueManagerReferenceSearchResponseFromDomain(string(request.WorkspaceID), hits),
	), nil
}

func (api DaemonAPI) UpdateWorkspaceIssue(ctx context.Context, request tuttigenerated.UpdateWorkspaceIssueRequestObject) (tuttigenerated.UpdateWorkspaceIssueResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.UpdateWorkspaceIssue503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UpdateWorkspaceIssue400JSONResponse{InvalidRequestErrorJSONResponse: issueManagerEmptyBodyError()}, nil
	}

	issue, err := api.IssueService.UpdateIssue(ctx, string(request.WorkspaceID), string(request.IssueID), workspaceservice.UpdateIssueManagerIssueInput{
		Title:      optionalString(request.Body.Title),
		HasTitle:   request.Body.Title != nil,
		Content:    optionalString(request.Body.Content),
		HasContent: request.Body.Content != nil,
		Status:     optionalIssueManagerStatus(request.Body.Status),
		HasStatus:  request.Body.Status != nil,
	})
	if err != nil {
		return writeUpdateWorkspaceIssueError(err), nil
	}
	return tuttigenerated.UpdateWorkspaceIssue200JSONResponse(
		workspaceapi.GeneratedIssueManagerIssueResponseFromDomain(issue),
	), nil
}

func (api DaemonAPI) AddWorkspaceIssueContextRefs(ctx context.Context, request tuttigenerated.AddWorkspaceIssueContextRefsRequestObject) (tuttigenerated.AddWorkspaceIssueContextRefsResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.AddWorkspaceIssueContextRefs503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.AddWorkspaceIssueContextRefs400JSONResponse{InvalidRequestErrorJSONResponse: issueManagerEmptyBodyError()}, nil
	}

	refs, err := api.IssueService.AddIssueContextRefs(ctx, string(request.WorkspaceID), string(request.IssueID), workspaceservice.AddIssueManagerContextRefsInput{
		Refs: issueManagerContextRefsInputFromGenerated(request.Body.Refs),
	})
	if err != nil {
		return writeAddWorkspaceIssueContextRefsError(err), nil
	}
	return tuttigenerated.AddWorkspaceIssueContextRefs200JSONResponse(
		workspaceapi.GeneratedIssueManagerContextRefsResponseFromDomain(refs),
	), nil
}

func (api DaemonAPI) ListWorkspaceIssueTasks(ctx context.Context, request tuttigenerated.ListWorkspaceIssueTasksRequestObject) (tuttigenerated.ListWorkspaceIssueTasksResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.ListWorkspaceIssueTasks503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}

	list, err := api.IssueService.ListTasks(ctx, string(request.WorkspaceID), string(request.IssueID), issueManagerTaskListInputFromGenerated(request.Params))
	if err != nil {
		return writeListWorkspaceIssueTasksError(err), nil
	}
	return tuttigenerated.ListWorkspaceIssueTasks200JSONResponse(
		workspaceapi.GeneratedIssueManagerTaskListResponseFromDomain(list),
	), nil
}

func (api DaemonAPI) CreateWorkspaceIssueTask(ctx context.Context, request tuttigenerated.CreateWorkspaceIssueTaskRequestObject) (tuttigenerated.CreateWorkspaceIssueTaskResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.CreateWorkspaceIssueTask503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateWorkspaceIssueTask400JSONResponse{InvalidRequestErrorJSONResponse: issueManagerEmptyBodyError()}, nil
	}

	task, err := api.IssueService.CreateTask(ctx, string(request.WorkspaceID), string(request.IssueID), workspaceservice.CreateIssueManagerTaskInput{
		TaskID:      optionalString(request.Body.TaskId),
		Title:       request.Body.Title,
		Content:     optionalString(request.Body.Content),
		Priority:    optionalIssueManagerPriority(request.Body.Priority),
		DueAtUnixMS: optionalUnixMillis(request.Body.DueAtUnix),
	})
	if err != nil {
		return writeCreateWorkspaceIssueTaskError(err), nil
	}
	return tuttigenerated.CreateWorkspaceIssueTask201JSONResponse(
		workspaceapi.GeneratedIssueManagerTaskResponseFromDomain(task),
	), nil
}

func (api DaemonAPI) CreateWorkspaceIssueTasks(ctx context.Context, request tuttigenerated.CreateWorkspaceIssueTasksRequestObject) (tuttigenerated.CreateWorkspaceIssueTasksResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.CreateWorkspaceIssueTasks503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateWorkspaceIssueTasks400JSONResponse{InvalidRequestErrorJSONResponse: issueManagerEmptyBodyError()}, nil
	}

	tasksInput := make([]workspaceservice.CreateIssueManagerTaskItemInput, 0, len(request.Body.Tasks))
	for _, task := range request.Body.Tasks {
		tasksInput = append(tasksInput, workspaceservice.CreateIssueManagerTaskItemInput{
			TaskID:      optionalString(task.TaskId),
			Title:       task.Title,
			Content:     optionalString(task.Content),
			Priority:    optionalIssueManagerPriority(task.Priority),
			DueAtUnixMS: optionalUnixMillis(task.DueAtUnix),
		})
	}
	tasks, err := api.IssueService.CreateTasks(ctx, string(request.WorkspaceID), string(request.IssueID), workspaceservice.CreateIssueManagerTasksInput{
		Tasks: tasksInput,
	})
	if err != nil {
		return writeCreateWorkspaceIssueTasksError(err), nil
	}
	return tuttigenerated.CreateWorkspaceIssueTasks201JSONResponse(
		workspaceapi.GeneratedIssueManagerTasksResponseFromDomain(tasks),
	), nil
}

func (api DaemonAPI) DeleteWorkspaceIssueTask(ctx context.Context, request tuttigenerated.DeleteWorkspaceIssueTaskRequestObject) (tuttigenerated.DeleteWorkspaceIssueTaskResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.DeleteWorkspaceIssueTask503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}

	removed, err := api.IssueService.DeleteTask(ctx, string(request.WorkspaceID), string(request.IssueID), string(request.TaskID))
	if err != nil {
		return writeDeleteWorkspaceIssueTaskError(err), nil
	}
	return tuttigenerated.DeleteWorkspaceIssueTask200JSONResponse{Removed: removed}, nil
}

func (api DaemonAPI) GetWorkspaceIssueTaskDetail(ctx context.Context, request tuttigenerated.GetWorkspaceIssueTaskDetailRequestObject) (tuttigenerated.GetWorkspaceIssueTaskDetailResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.GetWorkspaceIssueTaskDetail503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}

	detail, err := api.IssueService.GetTaskDetail(ctx, string(request.WorkspaceID), string(request.IssueID), string(request.TaskID))
	if err != nil {
		return writeGetWorkspaceIssueTaskDetailError(err), nil
	}
	return tuttigenerated.GetWorkspaceIssueTaskDetail200JSONResponse(
		workspaceapi.GeneratedIssueManagerTaskDetailResponseFromDomain(detail),
	), nil
}

func (api DaemonAPI) UpdateWorkspaceIssueTask(ctx context.Context, request tuttigenerated.UpdateWorkspaceIssueTaskRequestObject) (tuttigenerated.UpdateWorkspaceIssueTaskResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.UpdateWorkspaceIssueTask503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UpdateWorkspaceIssueTask400JSONResponse{InvalidRequestErrorJSONResponse: issueManagerEmptyBodyError()}, nil
	}

	task, err := api.IssueService.UpdateTask(ctx, string(request.WorkspaceID), string(request.IssueID), string(request.TaskID), workspaceservice.UpdateIssueManagerTaskInput{
		Title:             optionalString(request.Body.Title),
		HasTitle:          request.Body.Title != nil,
		Content:           optionalString(request.Body.Content),
		HasContent:        request.Body.Content != nil,
		Status:            optionalIssueManagerStatus(request.Body.Status),
		HasStatus:         request.Body.Status != nil,
		Priority:          optionalIssueManagerPriority(request.Body.Priority),
		HasPriority:       request.Body.Priority != nil,
		DueAtUnixMS:       optionalUnixMillis(request.Body.DueAtUnix),
		HasDueAt:          request.Body.DueAtUnix != nil,
		SortIndex:         optionalInt(request.Body.SortIndex),
		HasSortIndex:      request.Body.SortIndex != nil,
		Parallelizable:    request.Body.Parallelizable != nil && *request.Body.Parallelizable,
		HasParallelizable: request.Body.Parallelizable != nil,
	})
	if err != nil {
		return writeUpdateWorkspaceIssueTaskError(err), nil
	}
	return tuttigenerated.UpdateWorkspaceIssueTask200JSONResponse(
		workspaceapi.GeneratedIssueManagerTaskResponseFromDomain(task),
	), nil
}

func (api DaemonAPI) AddWorkspaceIssueTaskContextRefs(ctx context.Context, request tuttigenerated.AddWorkspaceIssueTaskContextRefsRequestObject) (tuttigenerated.AddWorkspaceIssueTaskContextRefsResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.AddWorkspaceIssueTaskContextRefs503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.AddWorkspaceIssueTaskContextRefs400JSONResponse{InvalidRequestErrorJSONResponse: issueManagerEmptyBodyError()}, nil
	}

	refs, err := api.IssueService.AddTaskContextRefs(ctx, string(request.WorkspaceID), string(request.IssueID), string(request.TaskID), workspaceservice.AddIssueManagerContextRefsInput{
		Refs: issueManagerContextRefsInputFromGenerated(request.Body.Refs),
	})
	if err != nil {
		return writeAddWorkspaceIssueTaskContextRefsError(err), nil
	}
	return tuttigenerated.AddWorkspaceIssueTaskContextRefs200JSONResponse(
		workspaceapi.GeneratedIssueManagerContextRefsResponseFromDomain(refs),
	), nil
}

func (api DaemonAPI) ListWorkspaceIssueRuns(ctx context.Context, request tuttigenerated.ListWorkspaceIssueRunsRequestObject) (tuttigenerated.ListWorkspaceIssueRunsResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.ListWorkspaceIssueRuns503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}

	runs, err := api.IssueService.ListRuns(ctx, string(request.WorkspaceID), string(request.IssueID), "")
	if err != nil {
		return writeListWorkspaceIssueRunsError(err), nil
	}
	return tuttigenerated.ListWorkspaceIssueRuns200JSONResponse(
		workspaceapi.GeneratedIssueManagerRunListResponseFromDomain(runs),
	), nil
}

func (api DaemonAPI) CreateWorkspaceIssueRun(ctx context.Context, request tuttigenerated.CreateWorkspaceIssueRunRequestObject) (tuttigenerated.CreateWorkspaceIssueRunResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.CreateWorkspaceIssueRun503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateWorkspaceIssueRun400JSONResponse{InvalidRequestErrorJSONResponse: issueManagerEmptyBodyError()}, nil
	}

	run, err := api.IssueService.CreateRun(ctx, string(request.WorkspaceID), string(request.IssueID), "", workspaceservice.CreateIssueManagerRunInput{
		RunID:              optionalString(request.Body.RunId),
		AgentTargetID:      request.Body.AgentTargetId,
		AgentProvider:      optionalString(request.Body.AgentProvider),
		AgentUserID:        optionalString(request.Body.AgentUserId),
		AgentSessionID:     optionalString(request.Body.AgentSessionId),
		ExecutionDirectory: optionalString(request.Body.ExecutionDirectory),
	})
	if err != nil {
		return writeCreateWorkspaceIssueRunError(err), nil
	}
	return tuttigenerated.CreateWorkspaceIssueRun201JSONResponse(
		workspaceapi.GeneratedIssueManagerRunResponseFromDomain(run),
	), nil
}

func (api DaemonAPI) GetWorkspaceIssueRun(ctx context.Context, request tuttigenerated.GetWorkspaceIssueRunRequestObject) (tuttigenerated.GetWorkspaceIssueRunResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.GetWorkspaceIssueRun503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}

	detail, err := api.IssueService.GetRunDetail(ctx, string(request.WorkspaceID), string(request.IssueID), "", string(request.RunID))
	if err != nil {
		return writeGetWorkspaceIssueRunError(err), nil
	}
	return tuttigenerated.GetWorkspaceIssueRun200JSONResponse(
		workspaceapi.GeneratedIssueManagerRunEnvelopeFromDomain(detail),
	), nil
}

func (api DaemonAPI) CompleteWorkspaceIssueRun(ctx context.Context, request tuttigenerated.CompleteWorkspaceIssueRunRequestObject) (tuttigenerated.CompleteWorkspaceIssueRunResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.CompleteWorkspaceIssueRun503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CompleteWorkspaceIssueRun400JSONResponse{InvalidRequestErrorJSONResponse: issueManagerEmptyBodyError()}, nil
	}

	detail, err := api.IssueService.CompleteRun(ctx, string(request.WorkspaceID), string(request.IssueID), "", string(request.RunID), workspaceservice.CompleteIssueManagerRunInput{
		Status:       string(request.Body.Status),
		Summary:      optionalString(request.Body.Summary),
		ErrorMessage: optionalString(request.Body.ErrorMessage),
		Outputs:      issueManagerRunOutputsInputFromGenerated(request.Body.Outputs),
	})
	if err != nil {
		return writeCompleteWorkspaceIssueRunError(err), nil
	}
	return tuttigenerated.CompleteWorkspaceIssueRun200JSONResponse(
		workspaceapi.GeneratedIssueManagerRunEnvelopeFromDomain(detail),
	), nil
}

func (api DaemonAPI) ListWorkspaceIssueTaskRuns(ctx context.Context, request tuttigenerated.ListWorkspaceIssueTaskRunsRequestObject) (tuttigenerated.ListWorkspaceIssueTaskRunsResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.ListWorkspaceIssueTaskRuns503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}

	runs, err := api.IssueService.ListRuns(ctx, string(request.WorkspaceID), string(request.IssueID), string(request.TaskID))
	if err != nil {
		return writeListWorkspaceIssueTaskRunsError(err), nil
	}
	return tuttigenerated.ListWorkspaceIssueTaskRuns200JSONResponse(
		workspaceapi.GeneratedIssueManagerRunListResponseFromDomain(runs),
	), nil
}

func (api DaemonAPI) CreateWorkspaceIssueTaskRun(ctx context.Context, request tuttigenerated.CreateWorkspaceIssueTaskRunRequestObject) (tuttigenerated.CreateWorkspaceIssueTaskRunResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.CreateWorkspaceIssueTaskRun503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateWorkspaceIssueTaskRun400JSONResponse{InvalidRequestErrorJSONResponse: issueManagerEmptyBodyError()}, nil
	}

	run, err := api.IssueService.CreateRun(ctx, string(request.WorkspaceID), string(request.IssueID), string(request.TaskID), workspaceservice.CreateIssueManagerRunInput{
		RunID:              optionalString(request.Body.RunId),
		AgentTargetID:      request.Body.AgentTargetId,
		AgentProvider:      optionalString(request.Body.AgentProvider),
		AgentUserID:        optionalString(request.Body.AgentUserId),
		AgentSessionID:     optionalString(request.Body.AgentSessionId),
		ExecutionDirectory: optionalString(request.Body.ExecutionDirectory),
	})
	if err != nil {
		return writeCreateWorkspaceIssueTaskRunError(err), nil
	}
	return tuttigenerated.CreateWorkspaceIssueTaskRun201JSONResponse(
		workspaceapi.GeneratedIssueManagerRunResponseFromDomain(run),
	), nil
}

func (api DaemonAPI) GetWorkspaceIssueTaskRun(ctx context.Context, request tuttigenerated.GetWorkspaceIssueTaskRunRequestObject) (tuttigenerated.GetWorkspaceIssueTaskRunResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.GetWorkspaceIssueTaskRun503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}

	detail, err := api.IssueService.GetRunDetail(ctx, string(request.WorkspaceID), string(request.IssueID), string(request.TaskID), string(request.RunID))
	if err != nil {
		return writeGetWorkspaceIssueTaskRunError(err), nil
	}
	return tuttigenerated.GetWorkspaceIssueTaskRun200JSONResponse(
		workspaceapi.GeneratedIssueManagerRunEnvelopeFromDomain(detail),
	), nil
}

func (api DaemonAPI) CompleteWorkspaceIssueTaskRun(ctx context.Context, request tuttigenerated.CompleteWorkspaceIssueTaskRunRequestObject) (tuttigenerated.CompleteWorkspaceIssueTaskRunResponseObject, error) {
	if api.IssueService == nil {
		return tuttigenerated.CompleteWorkspaceIssueTaskRun503JSONResponse{ServiceUnavailableErrorJSONResponse: issueManagerServiceUnavailableError()}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CompleteWorkspaceIssueTaskRun400JSONResponse{InvalidRequestErrorJSONResponse: issueManagerEmptyBodyError()}, nil
	}

	detail, err := api.IssueService.CompleteRun(ctx, string(request.WorkspaceID), string(request.IssueID), string(request.TaskID), string(request.RunID), workspaceservice.CompleteIssueManagerRunInput{
		Status:       string(request.Body.Status),
		Summary:      optionalString(request.Body.Summary),
		ErrorMessage: optionalString(request.Body.ErrorMessage),
		Outputs:      issueManagerRunOutputsInputFromGenerated(request.Body.Outputs),
	})
	if err != nil {
		return writeCompleteWorkspaceIssueTaskRunError(err), nil
	}
	return tuttigenerated.CompleteWorkspaceIssueTaskRun200JSONResponse(
		workspaceapi.GeneratedIssueManagerRunEnvelopeFromDomain(detail),
	), nil
}

func issueManagerIssueListInputFromGenerated(params tuttigenerated.ListWorkspaceIssuesParams) workspaceservice.ListIssueManagerItemsInput {
	input := workspaceservice.ListIssueManagerItemsInput{
		TopicID: string(params.TopicId),
	}
	if params.PageSize != nil {
		input.PageSize = int(*params.PageSize)
	}
	if params.PageToken != nil {
		input.PageToken = string(*params.PageToken)
	}
	if params.StatusFilter != nil {
		input.StatusFilter = string(*params.StatusFilter)
	}
	if params.SearchQuery != nil {
		input.SearchQuery = string(*params.SearchQuery)
	}
	return input
}

func issueManagerTaskListInputFromGenerated(params tuttigenerated.ListWorkspaceIssueTasksParams) workspaceservice.ListIssueManagerItemsInput {
	input := workspaceservice.ListIssueManagerItemsInput{}
	if params.PageSize != nil {
		input.PageSize = int(*params.PageSize)
	}
	if params.PageToken != nil {
		input.PageToken = string(*params.PageToken)
	}
	if params.StatusFilter != nil {
		input.StatusFilter = string(*params.StatusFilter)
	}
	if params.SearchQuery != nil {
		input.SearchQuery = string(*params.SearchQuery)
	}
	return input
}

func issueManagerCreateIssueInputFromGenerated(item tuttigenerated.CreateIssueManagerIssueRequest) workspaceservice.CreateIssueManagerIssueInput {
	return workspaceservice.CreateIssueManagerIssueInput{
		IssueID:             optionalString(item.IssueId),
		TopicID:             item.TopicId,
		Title:               item.Title,
		Content:             optionalString(item.Content),
		PlanningSource:      optionalPlanningSource(item.PlanningSource),
		SourceSessionID:     optionalString(item.SourceSessionId),
		SequentialExecution: optionalBool(item.SequentialExecution),
		ParallelExecution:   optionalBool(item.ParallelExecution),
		ExecutionProfile:    issueManagerExecutionProfileFromGenerated(item.ExecutionProfile),
		HasExecutionProfile: item.ExecutionProfile != nil,
		Budget:              issueManagerBudgetFromGenerated(item.Budget),
		HasBudget:           item.Budget != nil,
	}
}

func issueManagerCreateTaskInputFromGenerated(item tuttigenerated.CreateIssueManagerTaskRequest) workspaceservice.CreateIssueManagerTaskItemInput {
	return workspaceservice.CreateIssueManagerTaskItemInput{
		TaskID:             optionalString(item.TaskId),
		Title:              item.Title,
		Content:            optionalString(item.Content),
		Priority:           optionalIssueManagerPriority(item.Priority),
		DueAtUnixMS:        optionalUnixMillis(item.DueAtUnix),
		AgentTargetID:      optionalString(item.AgentTargetId),
		ModelPlanID:        optionalString(item.ModelPlanId),
		Model:              optionalString(item.Model),
		ExecutionDirectory: optionalString(item.ExecutionDirectory),
		DependencyTaskIDs:  issueManagerOptionalStringSlice(item.DependencyTaskIds),
		Parallelizable:     item.Parallelizable != nil && *item.Parallelizable,
	}
}

func issueManagerExecutionProfileFromGenerated(value *tuttigenerated.IssueManagerExecutionProfile) workspaceissues.ExecutionProfile {
	if value == nil {
		return workspaceissues.ExecutionProfile{}
	}
	return workspaceissues.ExecutionProfile{ReasoningIntensity: value.ReasoningIntensity, OrchestrationIntensity: value.OrchestrationIntensity}
}

func issueManagerBudgetFromGenerated(value *tuttigenerated.IssueManagerBudget) workspaceissues.Budget {
	if value == nil {
		return workspaceissues.Budget{}
	}
	return workspaceissues.Budget{Mode: workspaceissues.BudgetMode(value.Mode), TokenLimit: value.TokenLimit, ConsumedTokens: value.ConsumedTokens, QuotaWaterlinePercent: value.QuotaWaterlinePercent, RemainingQuotaPercent: optionalFloat64(value.RemainingQuotaPercent), HasRemainingQuota: value.RemainingQuotaPercent != nil, Status: workspaceissues.BudgetStatus(value.Status)}
}

func issueManagerTokenUsageFromGenerated(value *tuttigenerated.IssueManagerTokenUsage) workspaceissues.TokenUsage {
	if value == nil {
		return workspaceissues.TokenUsage{}
	}
	return workspaceissues.TokenUsage{InputTokens: value.InputTokens, OutputTokens: value.OutputTokens, CacheReadTokens: value.CacheReadTokens, CacheWriteTokens: value.CacheWriteTokens}
}

func issueManagerCostFromGenerated(value *tuttigenerated.IssueManagerCost) workspaceissues.Cost {
	if value == nil {
		return workspaceissues.Cost{}
	}
	return workspaceissues.Cost{Currency: value.Currency, EstimatedMicros: value.EstimatedMicros, ActualMicros: value.ActualMicros}
}

func optionalFloat64(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}

func issueManagerOptionalStringSlice(value *[]string) []string {
	if value == nil {
		return nil
	}
	return append([]string(nil), (*value)...)
}

func optionalPlanningSource(value *tuttigenerated.IssueManagerPlanningSource) string {
	if value == nil {
		return ""
	}
	return string(*value)
}

func issueManagerContextRefsInputFromGenerated(items []tuttigenerated.AddIssueManagerContextRefItem) []workspaceissues.AddContextRefInput {
	refs := make([]workspaceissues.AddContextRefInput, 0, len(items))
	for _, item := range items {
		refs = append(refs, workspaceissues.AddContextRefInput{
			ContextRefID: optionalString(item.ContextRefId),
			RefType:      item.RefType,
			Path:         item.Path,
			DisplayName:  optionalString(item.DisplayName),
		})
	}
	return refs
}

func issueManagerRunOutputsInputFromGenerated(items []tuttigenerated.CompleteIssueManagerRunOutputItem) []workspaceissues.CompleteRunOutputInput {
	outputs := make([]workspaceissues.CompleteRunOutputInput, 0, len(items))
	for _, item := range items {
		outputs = append(outputs, workspaceissues.CompleteRunOutputInput{
			OutputID:    optionalString(item.OutputId),
			Path:        item.Path,
			DisplayName: optionalString(item.DisplayName),
			MediaType:   optionalString(item.MediaType),
			SizeBytes:   optionalInt64(item.SizeBytes),
		})
	}
	return outputs
}

func issueManagerEmptyBodyError() tuttigenerated.InvalidRequestErrorJSONResponse {
	return invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body")))
}

func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func optionalInt64(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func optionalInt(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

func optionalBool(value *bool) bool {
	if value == nil {
		return false
	}
	return *value
}

func optionalUnixMillis(value *int64) int64 {
	return workspaceapi.UnixMillisFromSeconds(optionalInt64(value))
}

func optionalIssueManagerStatus(value *tuttigenerated.IssueManagerStatus) string {
	if value == nil {
		return ""
	}
	return string(*value)
}

func optionalIssueManagerPriority(value *tuttigenerated.IssueManagerPriority) string {
	if value == nil {
		return ""
	}
	return string(*value)
}
