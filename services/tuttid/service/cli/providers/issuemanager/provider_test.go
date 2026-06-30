package issuemanager

import (
	"context"
	"errors"
	"strings"
	"testing"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

type fakeWorkspaceCatalog struct {
	startup workspacebiz.Summary
}

func (f fakeWorkspaceCatalog) Startup(context.Context) (*workspacebiz.Summary, error) {
	return &f.startup, nil
}

func (fakeWorkspaceCatalog) Get(_ context.Context, workspaceID string) (workspacebiz.Summary, error) {
	return workspacebiz.Summary{ID: workspaceID, Name: "requested"}, nil
}

type fakeIssueManager struct {
	workspaceID string
	topicID     string
	status      string
	search      string
	pageSize    int
	topicUpdate workspaceservice.UpdateIssueManagerTopicInput
	issueUpdate workspaceservice.UpdateIssueManagerIssueInput
	updated     workspaceservice.UpdateIssueManagerTaskInput
	tasks       workspaceservice.CreateIssueManagerTasksInput
	created     workspaceservice.CreateIssueManagerRunInput
	completed   workspaceservice.CompleteIssueManagerRunInput
}

func (*fakeIssueManager) ListTopics(context.Context, string) (workspaceissues.TopicList, error) {
	return workspaceissues.TopicList{Items: []workspaceissues.Topic{
		{TopicID: workspaceissues.DefaultTopicID, WorkspaceID: "workspace-1", Title: "Default", IsDefault: true},
		{TopicID: "topic-1", WorkspaceID: "workspace-1", Title: "Launch", Summary: "Launch work", PinnedAtUnixMS: 1700000000000},
	}}, nil
}

func (*fakeIssueManager) CreateTopic(_ context.Context, workspaceID string, input workspaceservice.CreateIssueManagerTopicInput) (workspaceissues.Topic, error) {
	return workspaceissues.Topic{TopicID: "topic-1", WorkspaceID: workspaceID, Title: input.Title, Summary: input.Summary}, nil
}

func (f *fakeIssueManager) UpdateTopic(_ context.Context, workspaceID string, topicID string, input workspaceservice.UpdateIssueManagerTopicInput) (workspaceissues.Topic, error) {
	f.topicUpdate = input
	pinnedAt := int64(0)
	if input.Pinned {
		pinnedAt = 1700000000000
	}
	return workspaceissues.Topic{TopicID: topicID, WorkspaceID: workspaceID, Title: input.Title, Summary: input.Summary, PinnedAtUnixMS: pinnedAt}, nil
}

func (*fakeIssueManager) DeleteTopic(context.Context, string, string) (bool, error) {
	return true, nil
}

func (f *fakeIssueManager) ListIssues(_ context.Context, workspaceID string, input workspaceservice.ListIssueManagerItemsInput) (workspaceissues.IssueList, error) {
	f.workspaceID = workspaceID
	f.topicID = input.TopicID
	f.status = input.StatusFilter
	f.search = input.SearchQuery
	f.pageSize = input.PageSize
	return workspaceissues.IssueList{
		Items:      []workspaceissues.Issue{{IssueID: "ISS-1", TopicID: input.TopicID, WorkspaceID: workspaceID, Title: "Fix startup", Status: workspaceissues.StatusNotStarted, UpdatedAtUnixMS: 1700000000000}},
		TotalCount: 1,
	}, nil
}

func (*fakeIssueManager) CreateIssue(context.Context, string, workspaceservice.CreateIssueManagerIssueInput) (workspaceissues.Issue, error) {
	return workspaceissues.Issue{IssueID: "ISS-1", Title: "created"}, nil
}

func (*fakeIssueManager) GetIssueDetail(context.Context, string, string) (workspaceissues.IssueDetail, error) {
	return workspaceissues.IssueDetail{
		Issue: workspaceissues.Issue{IssueID: "ISS-1", Title: "Issue"},
		Tasks: []workspaceissues.Task{{TaskID: "TASK-1", IssueID: "ISS-1", Title: "Task"}},
	}, nil
}

func (f *fakeIssueManager) UpdateIssue(_ context.Context, _ string, _ string, input workspaceservice.UpdateIssueManagerIssueInput) (workspaceissues.Issue, error) {
	f.issueUpdate = input
	return workspaceissues.Issue{IssueID: "ISS-1", Title: input.Title, Status: workspaceissues.Status(input.Status)}, nil
}

func (*fakeIssueManager) DeleteIssue(context.Context, string, string) (bool, error) {
	return true, nil
}

func (*fakeIssueManager) ListTasks(context.Context, string, string, workspaceservice.ListIssueManagerItemsInput) (workspaceissues.TaskList, error) {
	return workspaceissues.TaskList{Items: []workspaceissues.Task{{
		TaskID:             "TASK-1",
		IssueID:            "ISS-1",
		WorkspaceID:        "workspace-1",
		Title:              "Task",
		Content:            "hidden",
		CreatorUserID:      "user-1",
		CreatorDisplayName: "User",
		CreatorAvatarURL:   "https://example.invalid/avatar.png",
	}}}, nil
}

func (*fakeIssueManager) CreateTask(context.Context, string, string, workspaceservice.CreateIssueManagerTaskInput) (workspaceissues.Task, error) {
	return workspaceissues.Task{
		TaskID:             "TASK-1",
		IssueID:            "ISS-1",
		WorkspaceID:        "workspace-1",
		Title:              "created",
		Content:            "",
		Priority:           workspaceissues.PriorityMedium,
		CreatorUserID:      "user-1",
		CreatorDisplayName: "User",
		CreatorAvatarURL:   "https://example.invalid/avatar.png",
		CreatedAtUnixMS:    1700000000000,
		UpdatedAtUnixMS:    1700000000000,
	}, nil
}

func (f *fakeIssueManager) CreateTasks(_ context.Context, workspaceID string, issueID string, input workspaceservice.CreateIssueManagerTasksInput) ([]workspaceissues.Task, error) {
	f.tasks = input
	tasks := make([]workspaceissues.Task, 0, len(input.Tasks))
	for index, task := range input.Tasks {
		tasks = append(tasks, workspaceissues.Task{
			TaskID:      task.TaskID,
			IssueID:     issueID,
			WorkspaceID: workspaceID,
			Title:       task.Title,
			Content:     task.Content,
			Priority:    workspaceissues.NormalizePriority(task.Priority),
			SortIndex:   index + 1,
		})
	}
	return tasks, nil
}

func (*fakeIssueManager) GetTaskDetail(context.Context, string, string, string) (workspaceissues.TaskDetail, error) {
	run := workspaceissues.Run{RunID: "RUN-1", TaskID: "TASK-1", IssueID: "ISS-1", AgentSessionID: "SESSION-1"}
	return workspaceissues.TaskDetail{
		Task:          workspaceissues.Task{TaskID: "TASK-1", IssueID: "ISS-1", Title: "Task", Content: "visible content", LatestRunID: "RUN-1"},
		LatestRun:     &run,
		RecentRuns:    []workspaceissues.Run{run},
		LatestOutputs: []workspaceissues.RunOutput{{OutputID: "OUT-1", Path: "/tmp/report.md", DisplayName: "report.md"}},
	}, nil
}

func (f *fakeIssueManager) UpdateTask(_ context.Context, _ string, _ string, _ string, input workspaceservice.UpdateIssueManagerTaskInput) (workspaceissues.Task, error) {
	f.updated = input
	return workspaceissues.Task{TaskID: "TASK-1", IssueID: "ISS-1", Title: input.Title, Status: workspaceissues.Status(input.Status)}, nil
}

func (*fakeIssueManager) DeleteTask(context.Context, string, string, string) (bool, error) {
	return true, nil
}

func (*fakeIssueManager) ListRuns(context.Context, string, string, string) ([]workspaceissues.Run, error) {
	return []workspaceissues.Run{{RunID: "RUN-1", TaskID: "TASK-1", IssueID: "ISS-1", Status: workspaceissues.StatusRunning}}, nil
}

func (f *fakeIssueManager) CreateRun(_ context.Context, _ string, _ string, taskID string, input workspaceservice.CreateIssueManagerRunInput) (workspaceissues.Run, error) {
	f.created = input
	return workspaceissues.Run{
		RunID:              "RUN-1",
		TaskID:             taskID,
		IssueID:            "ISS-1",
		WorkspaceID:        "workspace-1",
		RequesterUserID:    "requester-1",
		AgentUserID:        input.AgentUserID,
		AgentProvider:      input.AgentProvider,
		AgentSessionID:     input.AgentSessionID,
		Status:             workspaceissues.StatusRunning,
		OutputDir:          "/tmp/output",
		ExecutionDirectory: "/tmp/work",
	}, nil
}

func (*fakeIssueManager) GetRunDetail(context.Context, string, string, string, string) (workspaceissues.RunDetail, error) {
	return workspaceissues.RunDetail{Run: workspaceissues.Run{RunID: "RUN-1"}, Outputs: []workspaceissues.RunOutput{{OutputID: "OUT-1", Path: "/tmp/report.md"}}}, nil
}

func (f *fakeIssueManager) CompleteRun(_ context.Context, _ string, _ string, _ string, _ string, input workspaceservice.CompleteIssueManagerRunInput) (workspaceissues.RunDetail, error) {
	f.completed = input
	outputs := make([]workspaceissues.RunOutput, 0, len(input.Outputs))
	for _, output := range input.Outputs {
		outputs = append(outputs, workspaceissues.RunOutput{
			OutputID:    "OUT-1",
			Path:        output.Path,
			DisplayName: output.DisplayName,
			MediaType:   output.MediaType,
		})
	}
	return workspaceissues.RunDetail{Run: workspaceissues.Run{RunID: "RUN-1", Status: workspaceissues.Status(input.Status)}, Outputs: outputs}, nil
}

func (*fakeIssueManager) SearchIssueOutputs(context.Context, workspaceissues.RunOutputSearchParams) ([]workspaceissues.RunOutputSearchHit, error) {
	return nil, nil
}

func TestCommandsExposeIssueManagerAsWorkspaceAppSource(t *testing.T) {
	commands := NewProvider(fakeWorkspaceCatalog{}, &fakeIssueManager{}, nil).Commands()

	if len(commands) == 0 {
		t.Fatal("Commands() returned no commands")
	}
	for _, command := range commands {
		source := command.Capability.Source
		if source.Kind != cliservice.CapabilitySourceApp {
			t.Fatalf("%s source kind = %q, want app", command.Capability.ID, source.Kind)
		}
		if source.AppID != appID {
			t.Fatalf("%s app id = %q, want %q", command.Capability.ID, source.AppID, appID)
		}
		if source.AppName != "Task Manager" {
			t.Fatalf("%s app name = %q, want Task Manager", command.Capability.ID, source.AppName)
		}
		if source.CLIDescription == "" {
			t.Fatalf("%s missing CLI description", command.Capability.ID)
		}
	}
}

func TestIssueListCommandUsesStartupWorkspace(t *testing.T) {
	issues := &fakeIssueManager{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, issues, nil).newIssueListCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"topic-id": workspaceissues.DefaultTopicID, "status": "closed", "search": "startup", "page-size": "25"},
		OutputMode: cliservice.OutputModeTable,
		Context:    cliservice.InvokeContext{Source: "cli"},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if issues.workspaceID != "workspace-1" || issues.topicID != workspaceissues.DefaultTopicID || issues.status != "closed" || issues.search != "startup" || issues.pageSize != 25 {
		t.Fatalf("recorded input = %#v", issues)
	}
	if len(output.Rows) != 1 || output.Rows[0]["id"] != "ISS-1" {
		t.Fatalf("rows = %#v", output.Rows)
	}
}

func TestTopicListCommandReturnsWorkspaceTopics(t *testing.T) {
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, &fakeIssueManager{}, nil).newTopicListCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		OutputMode: cliservice.OutputModeJSON,
		Context:    cliservice.InvokeContext{Source: "cli"},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	topics := output.Value["topics"].([]any)
	if len(topics) != 2 {
		t.Fatalf("topics = %#v", topics)
	}
	first := topics[0].(map[string]any)
	second := topics[1].(map[string]any)
	if first["topicId"] != workspaceissues.DefaultTopicID || second["title"] != "Launch" || second["pinned"] != true {
		t.Fatalf("topics = %#v", topics)
	}
	if _, ok := second["summary"]; ok {
		t.Fatalf("topic summary should omit summary: %#v", second)
	}
}

func TestTopicUpdateTracksPinnedFalse(t *testing.T) {
	issues := &fakeIssueManager{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, issues, nil).newTopicUpdateCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"topic-id": "topic-1", "pinned": "false"},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if !issues.topicUpdate.HasPinned || issues.topicUpdate.Pinned {
		t.Fatalf("topicUpdate = %#v", issues.topicUpdate)
	}
	if output.Value["topic"].(map[string]any)["pinned"] != false {
		t.Fatalf("output = %#v", output.Value)
	}
}

func TestTaskGetIncludesLatestRunAndOutputs(t *testing.T) {
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, &fakeIssueManager{}, nil).newTaskGetCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"issue-id": "ISS-1", "task-id": "TASK-1"},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	detail := output.Value["detail"].(map[string]any)
	latestRun := detail["latestRun"].(map[string]any)
	if latestRun["agentSessionId"] != "SESSION-1" {
		t.Fatalf("latestRun = %#v", latestRun)
	}
	if detail["task"].(map[string]any)["content"] != "visible content" {
		t.Fatalf("detail = %#v", detail)
	}
	if len(detail["latestOutputs"].([]any)) != 1 {
		t.Fatalf("detail = %#v", detail)
	}
}

func TestTaskCreateReturnsSummaryJSON(t *testing.T) {
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, &fakeIssueManager{}, nil).newTaskCreateCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"issue-id": "ISS-1", "title": "Task"},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	task := output.Value["task"].(map[string]any)
	if task["taskId"] != "TASK-1" || task["issueId"] != "ISS-1" || task["priority"] != "medium" {
		t.Fatalf("task = %#v", task)
	}
	assertAbsent(t, task, creatorFieldKeys()...)
	assertAbsent(t, task, "workspaceId", "createdAtUnixMs", "updatedAtUnixMs", "content")
}

func TestTaskCreateBatchUsesJSONArrayOrder(t *testing.T) {
	issues := &fakeIssueManager{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, issues, nil).newTaskCreateBatchCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"issue-id": "ISS-1",
			"tasks-json": `[
				{"taskId":"TASK-1","title":"1. Baseline","content":"Capture current state","priority":"high"},
				{"taskId":"TASK-2","title":"2. Metrics","content":"Define indicators","priority":"low","dueAtUnix":1700000000}
			]`,
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if len(issues.tasks.Tasks) != 2 {
		t.Fatalf("tasks input = %#v", issues.tasks)
	}
	if issues.tasks.Tasks[0].Title != "1. Baseline" || issues.tasks.Tasks[1].DueAtUnixMS != 1700000000000 {
		t.Fatalf("tasks input = %#v", issues.tasks.Tasks)
	}
	tasks := output.Value["tasks"].([]any)
	first := tasks[0].(map[string]any)
	second := tasks[1].(map[string]any)
	if first["taskId"] != "TASK-1" || first["sortIndex"] != 1 || second["taskId"] != "TASK-2" || second["sortIndex"] != 2 {
		t.Fatalf("tasks = %#v", tasks)
	}
}

func TestTaskListReturnsSummaryItems(t *testing.T) {
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, &fakeIssueManager{}, nil).newTaskListCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input:      map[string]any{"issue-id": "ISS-1"},
		OutputMode: cliservice.OutputModeJSON,
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	tasks := output.Value["tasks"].([]any)
	task := tasks[0].(map[string]any)
	if task["taskId"] != "TASK-1" || task["title"] != "Task" {
		t.Fatalf("task = %#v", task)
	}
	assertAbsent(t, task, "content")
	assertAbsent(t, task, creatorFieldKeys()...)
}

func TestIssueUpdateTracksStatus(t *testing.T) {
	issues := &fakeIssueManager{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, issues, nil).newIssueUpdateCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"issue-id": "ISS-1", "status": "completed"},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if !issues.issueUpdate.HasStatus || issues.issueUpdate.Status != "completed" {
		t.Fatalf("issueUpdate = %#v", issues.issueUpdate)
	}
	if output.Value["issue"].(map[string]any)["status"] != "completed" {
		t.Fatalf("output = %#v", output.Value)
	}
}

func TestTaskUpdateTracksOnlyPassedFields(t *testing.T) {
	issues := &fakeIssueManager{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, issues, nil).newTaskUpdateCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"issue-id": "ISS-1", "task-id": "TASK-1", "status": "completed"},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if issues.updated.HasTitle || !issues.updated.HasStatus || issues.updated.Status != "completed" {
		t.Fatalf("updated = %#v", issues.updated)
	}
}

func TestRunCompleteParsesFlexibleOutputs(t *testing.T) {
	issues := &fakeIssueManager{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, issues, nil).newRunCompleteCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"issue-id": "ISS-1",
			"task-id":  "TASK-1",
			"run-id":   "RUN-1",
			"status":   "completed",
			"outputs":  `[{"path":"/tmp/report.md","title":"Report"}]`,
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if len(issues.completed.Outputs) != 1 || issues.completed.Outputs[0].DisplayName != "Report" || issues.completed.Outputs[0].MediaType != "text/markdown; charset=utf-8" {
		t.Fatalf("outputs = %#v", issues.completed.Outputs)
	}
	if output.Value["run"].(map[string]any)["status"] != "completed" {
		t.Fatalf("output = %#v", output.Value)
	}
}

func TestIssueRunCreateDoesNotRequireTaskID(t *testing.T) {
	issues := &fakeIssueManager{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, issues, nil).newIssueRunCreateCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Context: cliservice.InvokeContext{
			AgentSessionID: "SESSION-1",
		},
		Input: map[string]any{
			"issue-id":       "ISS-1",
			"agent-provider": "codex",
			"agent-user-id":  "local",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if issues.created.AgentProvider != "codex" || issues.created.AgentSessionID != "SESSION-1" || issues.created.AgentUserID != "local" {
		t.Fatalf("created = %#v", issues.created)
	}
	run := output.Value["run"].(map[string]any)
	if run["taskId"] != "" || run["status"] != "running" {
		t.Fatalf("run = %#v", run)
	}
	assertAbsent(t, run, "requesterUserId", "agentUserId", "outputDir", "executionDirectory")
}

func TestTaskRunCreateDefaultsAgentSessionIDFromInvokeContext(t *testing.T) {
	issues := &fakeIssueManager{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, issues, nil).newRunCreateCommand()

	required, ok := command.Capability.InputSchema["required"].([]string)
	if !ok {
		t.Fatalf("required schema = %#v", command.Capability.InputSchema["required"])
	}
	for _, field := range required {
		if field == "agent-session-id" {
			t.Fatalf("agent-session-id should not be required: %#v", required)
		}
	}

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Context: cliservice.InvokeContext{
			AgentSessionID: "SESSION-CONTEXT",
		},
		Input: map[string]any{
			"issue-id":       "ISS-1",
			"task-id":        "TASK-1",
			"agent-provider": "codex",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if issues.created.AgentSessionID != "SESSION-CONTEXT" {
		t.Fatalf("created = %#v, want context agent session id", issues.created)
	}
}

func TestIssueRunCompleteDoesNotRequireTaskID(t *testing.T) {
	issues := &fakeIssueManager{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, issues, nil).newIssueRunCompleteCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"issue-id": "ISS-1",
			"run-id":   "RUN-1",
			"status":   "completed",
			"summary":  "Done",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if issues.completed.Status != "completed" || issues.completed.Summary != "Done" || len(issues.completed.Outputs) != 0 {
		t.Fatalf("completed = %#v", issues.completed)
	}
	if output.Value["run"].(map[string]any)["status"] != "completed" {
		t.Fatalf("output = %#v", output.Value)
	}
}

func TestIssueListReportsMissingTopicID(t *testing.T) {
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, &fakeIssueManager{}, nil).newIssueListCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{},
	})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
	if !strings.Contains(err.Error(), `required input "topic-id" is missing`) {
		t.Fatalf("err = %q", err.Error())
	}
}

func assertAbsent(t *testing.T, value map[string]any, keys ...string) {
	t.Helper()
	for _, key := range keys {
		if _, ok := value[key]; ok {
			t.Fatalf("value should omit %q: %#v", key, value)
		}
	}
}

func creatorFieldKeys() []string {
	return []string{"creator" + "AvatarUrl", "creator" + "DisplayName", "creator" + "UserId"}
}
