package workspaceissues

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestServiceCreateIssueAndTaskProjection(t *testing.T) {
	store := newFakeStore()
	service := testService(store)
	ctx := context.Background()

	issue, err := service.CreateIssue(ctx, CreateIssueInput{
		WorkspaceID: "workspace-1",
		TopicID:     DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Checkout flow",
		Content:     "Plan the checkout work",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	if issue.IssueID == "" || issue.Status != StatusNotStarted {
		t.Fatalf("created issue = %+v", issue)
	}

	task, err := service.CreateTask(ctx, CreateTaskInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Title:       "Wire payment form",
		Priority:    "urgent",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	if task.Priority != PriorityMedium {
		t.Fatalf("task priority = %q, want %q", task.Priority, PriorityMedium)
	}
	if task.SortIndex != 1 {
		t.Fatalf("task sort index = %d, want 1", task.SortIndex)
	}

	detail, err := service.GetIssueDetail(ctx, "workspace-1", issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if len(detail.Tasks) != 1 {
		t.Fatalf("detail tasks len = %d, want 1", len(detail.Tasks))
	}
	if detail.Issue.TaskCount != 1 || detail.Issue.NotStartedCount != 1 {
		t.Fatalf("issue projection = %+v", detail.Issue)
	}
}

func TestServiceCreateTasksAppendsInInputOrder(t *testing.T) {
	store := newFakeStore()
	service := testService(store)
	ctx := context.Background()

	issue, err := service.CreateIssue(ctx, CreateIssueInput{
		WorkspaceID: "workspace-1",
		TopicID:     DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "AgentGUI stability",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}

	first, err := service.CreateTask(ctx, CreateTaskInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Title:       "Existing baseline",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	if first.SortIndex != 1 {
		t.Fatalf("first sort index = %d, want 1", first.SortIndex)
	}

	created, err := service.CreateTasks(ctx, CreateTasksInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Tasks: []CreateTaskItemInput{
			{TaskID: "task-a", Title: "2. Define metrics"},
			{TaskID: "task-b", Title: "3. Build checks"},
			{TaskID: "task-c", Title: "4. Document baseline"},
		},
	})
	if err != nil {
		t.Fatalf("CreateTasks() error = %v", err)
	}
	if len(created) != 3 {
		t.Fatalf("created tasks len = %d, want 3", len(created))
	}
	for index, task := range created {
		if task.SortIndex != index+2 {
			t.Fatalf("created[%d].SortIndex = %d, want %d", index, task.SortIndex, index+2)
		}
	}

	detail, err := service.GetIssueDetail(ctx, "workspace-1", issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	titles := make([]string, 0, len(detail.Tasks))
	for _, task := range detail.Tasks {
		titles = append(titles, task.Title)
	}
	want := []string{"Existing baseline", "2. Define metrics", "3. Build checks", "4. Document baseline"}
	if strings.Join(titles, "\n") != strings.Join(want, "\n") {
		t.Fatalf("task titles = %#v, want %#v", titles, want)
	}
}

func TestServiceUpdateIssueStatus(t *testing.T) {
	store := newFakeStore()
	service := testService(store)
	ctx := context.Background()

	issue, err := service.CreateIssue(ctx, CreateIssueInput{
		WorkspaceID: "workspace-1",
		TopicID:     DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Say hello",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}

	updated, err := service.UpdateIssue(ctx, UpdateIssueInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Status:      string(StatusCompleted),
		HasStatus:   true,
	})
	if err != nil {
		t.Fatalf("UpdateIssue() error = %v", err)
	}
	if updated.Status != StatusCompleted {
		t.Fatalf("status = %q, want %q", updated.Status, StatusCompleted)
	}
}

func TestServiceDeleteTopic(t *testing.T) {
	store := newFakeStore()
	service := testService(store)
	ctx := context.Background()

	topic, err := service.CreateTopic(ctx, CreateTopicInput{
		WorkspaceID: "workspace-1",
		ActorUserID: "user-1",
		Title:       "Launch plan",
		Summary:     "Track launch work",
	})
	if err != nil {
		t.Fatalf("CreateTopic() error = %v", err)
	}

	removed, err := service.DeleteTopic(ctx, "workspace-1", topic.TopicID, "user-1")
	if err != nil {
		t.Fatalf("DeleteTopic() error = %v", err)
	}
	if !removed {
		t.Fatal("DeleteTopic() removed = false, want true")
	}
	if _, err := store.GetTopic(ctx, "workspace-1", topic.TopicID); !errors.Is(err, ErrTopicNotFound) {
		t.Fatalf("GetTopic() after delete error = %v, want ErrTopicNotFound", err)
	}
}

func TestServiceDeleteTopicRejectsDefaultAndNonEmptyTopics(t *testing.T) {
	store := newFakeStore()
	service := testService(store)
	ctx := context.Background()

	if _, err := service.DeleteTopic(ctx, "workspace-1", DefaultTopicID, "user-1"); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("DeleteTopic(default) error = %v, want ErrInvalidArgument", err)
	}

	topic, err := service.CreateTopic(ctx, CreateTopicInput{
		WorkspaceID: "workspace-1",
		ActorUserID: "user-1",
		Title:       "Refactor",
	})
	if err != nil {
		t.Fatalf("CreateTopic() error = %v", err)
	}
	if _, err := service.CreateIssue(ctx, CreateIssueInput{
		WorkspaceID: "workspace-1",
		TopicID:     topic.TopicID,
		ActorUserID: "user-1",
		Title:       "Refactor sidebar",
	}); err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}

	removed, err := service.DeleteTopic(ctx, "workspace-1", topic.TopicID, "user-1")
	if !errors.Is(err, ErrTopicNotEmpty) {
		t.Fatalf("DeleteTopic(non-empty) error = %v, want ErrTopicNotEmpty", err)
	}
	if removed {
		t.Fatal("DeleteTopic(non-empty) removed = true, want false")
	}
}

func TestServiceRunLifecycleTransitionsTaskAndIssue(t *testing.T) {
	store := newFakeStore()
	service := testService(store)
	ctx := context.Background()

	issue, err := service.CreateIssue(ctx, CreateIssueInput{
		WorkspaceID: "workspace-1",
		TopicID:     DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Editor polish",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	task, err := service.CreateTask(ctx, CreateTaskInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Title:       "Fix selection highlight",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}

	run, err := service.CreateRun(ctx, CreateRunInput{
		WorkspaceID:   "workspace-1",
		IssueID:       issue.IssueID,
		TaskID:        task.TaskID,
		ActorUserID:   "user-1",
		AgentProvider: "Codex",
		AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}
	if run.Status != StatusRunning || run.AgentProvider != "codex" {
		t.Fatalf("created run = %+v", run)
	}
	runningTask, err := store.GetTask(ctx, "workspace-1", issue.IssueID, task.TaskID)
	if err != nil {
		t.Fatalf("GetTask() error = %v", err)
	}
	if runningTask.Status != StatusRunning || runningTask.LatestRunID != run.RunID {
		t.Fatalf("running task = %+v", runningTask)
	}

	completed, outputs, err := service.CompleteRun(ctx, CompleteRunInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		TaskID:      task.TaskID,
		RunID:       run.RunID,
		ActorUserID: "user-1",
		Status:      "completed",
		Summary:     "Ready for review",
		Outputs: []CompleteRunOutputInput{{
			Path: "/workspace/out/report.md",
		}},
	})
	if err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}
	if completed.Status != StatusCompleted || completed.CompletedAtUnixMS == 0 {
		t.Fatalf("completed run = %+v", completed)
	}
	if len(outputs) != 1 || outputs[0].DisplayName != "report.md" {
		t.Fatalf("outputs = %+v", outputs)
	}
	detail, err := service.GetTaskDetail(ctx, "workspace-1", issue.IssueID, task.TaskID)
	if err != nil {
		t.Fatalf("GetTaskDetail() error = %v", err)
	}
	if detail.Task.Status != StatusPendingAcceptance {
		t.Fatalf("task status = %q, want %q", detail.Task.Status, StatusPendingAcceptance)
	}
	issueDetail, err := service.GetIssueDetail(ctx, "workspace-1", issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if issueDetail.Issue.PendingAcceptanceCount != 1 || issueDetail.Issue.RunningCount != 0 {
		t.Fatalf("issue projection = %+v", issueDetail.Issue)
	}
}

func TestServiceCreateRunDerivesProviderFromAgentTargetID(t *testing.T) {
	store := newFakeStore()
	service := testService(store)
	ctx := context.Background()

	issue, err := service.CreateIssue(ctx, CreateIssueInput{
		WorkspaceID: "workspace-1",
		TopicID:     DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Editor polish",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	task, err := service.CreateTask(ctx, CreateTaskInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Title:       "Fix selection highlight",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}

	run, err := service.CreateRun(ctx, CreateRunInput{
		WorkspaceID:   "workspace-1",
		IssueID:       issue.IssueID,
		TaskID:        task.TaskID,
		ActorUserID:   "user-1",
		AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}
	if run.AgentProvider != "codex" {
		t.Fatalf("agent provider = %q, want codex", run.AgentProvider)
	}
}

func TestServiceGetIssueDetailIncludesOutputsFromAllIssueTasks(t *testing.T) {
	store := newFakeStore()
	service := testService(store)
	ctx := context.Background()

	issue, err := service.CreateIssue(ctx, CreateIssueInput{
		WorkspaceID: "workspace-1",
		TopicID:     DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Collect all outputs",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	firstTask, err := service.CreateTask(ctx, CreateTaskInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Title:       "Main task",
	})
	if err != nil {
		t.Fatalf("CreateTask(first) error = %v", err)
	}
	secondTask, err := service.CreateTask(ctx, CreateTaskInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Title:       "Child task",
	})
	if err != nil {
		t.Fatalf("CreateTask(second) error = %v", err)
	}
	for _, item := range []struct {
		taskID string
		runID  string
		path   string
	}{
		{taskID: firstTask.TaskID, runID: "run-main", path: "/workspace/main.md"},
		{taskID: secondTask.TaskID, runID: "run-child", path: "/workspace/child.md"},
	} {
		run, err := service.CreateRun(ctx, CreateRunInput{
			WorkspaceID:   "workspace-1",
			IssueID:       issue.IssueID,
			TaskID:        item.taskID,
			RunID:         item.runID,
			ActorUserID:   "user-1",
			AgentProvider: "codex",
			AgentTargetID: "local:codex",
		})
		if err != nil {
			t.Fatalf("CreateRun(%s) error = %v", item.runID, err)
		}
		if _, _, err := service.CompleteRun(ctx, CompleteRunInput{
			WorkspaceID: "workspace-1",
			IssueID:     issue.IssueID,
			TaskID:      run.TaskID,
			RunID:       run.RunID,
			ActorUserID: "user-1",
			Status:      "completed",
			Summary:     "Done",
			Outputs: []CompleteRunOutputInput{{
				Path: item.path,
			}},
		}); err != nil {
			t.Fatalf("CompleteRun(%s) error = %v", item.runID, err)
		}
	}

	detail, err := service.GetIssueDetail(ctx, "workspace-1", issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	paths := make([]string, 0, len(detail.LatestOutputs))
	for _, output := range detail.LatestOutputs {
		paths = append(paths, output.Path)
	}
	sort.Strings(paths)
	want := []string{"/workspace/child.md", "/workspace/main.md"}
	if strings.Join(paths, "\n") != strings.Join(want, "\n") {
		t.Fatalf("issue detail outputs = %+v, want paths %v", detail.LatestOutputs, want)
	}
}

func TestServiceGetIssueDetailDeduplicatesOutputsByPath(t *testing.T) {
	store := newFakeStore()
	service := testService(store)
	ctx := context.Background()

	issue, err := service.CreateIssue(ctx, CreateIssueInput{
		WorkspaceID: "workspace-1",
		TopicID:     DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Regenerate output",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	task, err := service.CreateTask(ctx, CreateTaskInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Title:       "Write package",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	for _, item := range []struct {
		displayName string
		runID       string
	}{
		{runID: "run-old", displayName: "old.md"},
		{runID: "run-new", displayName: "new.md"},
	} {
		run, err := service.CreateRun(ctx, CreateRunInput{
			WorkspaceID:   "workspace-1",
			IssueID:       issue.IssueID,
			TaskID:        task.TaskID,
			RunID:         item.runID,
			ActorUserID:   "user-1",
			AgentProvider: "codex",
			AgentTargetID: "local:codex",
		})
		if err != nil {
			t.Fatalf("CreateRun(%s) error = %v", item.runID, err)
		}
		if _, _, err := service.CompleteRun(ctx, CompleteRunInput{
			WorkspaceID: "workspace-1",
			IssueID:     issue.IssueID,
			TaskID:      run.TaskID,
			RunID:       run.RunID,
			ActorUserID: "user-1",
			Status:      "completed",
			Summary:     "Done",
			Outputs: []CompleteRunOutputInput{{
				DisplayName: item.displayName,
				Path:        "/workspace/package.md",
			}},
		}); err != nil {
			t.Fatalf("CompleteRun(%s) error = %v", item.runID, err)
		}
	}

	detail, err := service.GetIssueDetail(ctx, "workspace-1", issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if len(detail.LatestOutputs) != 1 {
		t.Fatalf("issue detail outputs = %+v, want one deduplicated output", detail.LatestOutputs)
	}
	if detail.LatestOutputs[0].RunID != "run-new" || detail.LatestOutputs[0].DisplayName != "new.md" {
		t.Fatalf("issue detail output = %+v, want latest run output", detail.LatestOutputs[0])
	}
}

func TestServiceCompleteRunDoesNotOverwriteTerminalRun(t *testing.T) {
	store := newFakeStore()
	service := testService(store)
	ctx := context.Background()

	issue, err := service.CreateIssue(ctx, CreateIssueInput{
		WorkspaceID: "workspace-1",
		TopicID:     DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Keep original result",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	task, err := service.CreateTask(ctx, CreateTaskInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Title:       "Ship once",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	run, err := service.CreateRun(ctx, CreateRunInput{
		WorkspaceID:   "workspace-1",
		IssueID:       issue.IssueID,
		TaskID:        task.TaskID,
		ActorUserID:   "user-1",
		AgentProvider: "codex",
		AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}
	completed, outputs, err := service.CompleteRun(ctx, CompleteRunInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		TaskID:      task.TaskID,
		RunID:       run.RunID,
		ActorUserID: "user-1",
		Status:      "completed",
		Summary:     "Original summary",
		Outputs: []CompleteRunOutputInput{{
			Path: "/workspace/original.md",
		}},
	})
	if err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}
	repeated, repeatedOutputs, err := service.CompleteRun(ctx, CompleteRunInput{
		WorkspaceID:  "workspace-1",
		IssueID:      issue.IssueID,
		TaskID:       task.TaskID,
		RunID:        run.RunID,
		ActorUserID:  "user-1",
		Status:       "failed",
		Summary:      "Overwritten summary",
		ErrorMessage: "should not win",
		Outputs: []CompleteRunOutputInput{{
			Path: "/workspace/overwritten.md",
		}},
	})
	if err != nil {
		t.Fatalf("CompleteRun() repeated error = %v", err)
	}
	if repeated.Status != completed.Status || repeated.Summary != "Original summary" || repeated.ErrorMessage != "" {
		t.Fatalf("repeated run = %+v, want original terminal run", repeated)
	}
	if len(repeatedOutputs) != len(outputs) || repeatedOutputs[0].Path != "/workspace/original.md" {
		t.Fatalf("repeated outputs = %+v, want original outputs %+v", repeatedOutputs, outputs)
	}
}

func TestServiceRunLifecycleTransitionsIssueWithoutTasks(t *testing.T) {
	store := newFakeStore()
	service := testService(store)
	ctx := context.Background()

	issue, err := service.CreateIssue(ctx, CreateIssueInput{
		WorkspaceID: "workspace-1",
		TopicID:     DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Say hello",
		Content:     "Say hello to me",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}

	run, err := service.CreateRun(ctx, CreateRunInput{
		WorkspaceID:   "workspace-1",
		IssueID:       issue.IssueID,
		ActorUserID:   "user-1",
		RunID:         "run-issue-1",
		AgentProvider: "codex",
		AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}
	if run.TaskID == "" {
		t.Fatal("run task id is empty, want generated task id")
	}
	if run.OutputDir != "" {
		t.Fatalf("run output dir = %q, want empty", run.OutputDir)
	}

	detail, err := service.GetIssueDetail(ctx, "workspace-1", issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if detail.Issue.Status != StatusRunning || detail.Issue.TaskCount != 1 || detail.Issue.RunningCount != 1 {
		t.Fatalf("running issue detail = %+v", detail.Issue)
	}
	if len(detail.Tasks) != 1 || detail.Tasks[0].TaskID != run.TaskID {
		t.Fatalf("detail tasks = %+v, run task id = %q", detail.Tasks, run.TaskID)
	}

	completed, outputs, err := service.CompleteRun(ctx, CompleteRunInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		TaskID:      run.TaskID,
		RunID:       run.RunID,
		ActorUserID: "user-1",
		Status:      "completed",
		Summary:     "Ready for review",
		Outputs: []CompleteRunOutputInput{{
			Path: "/Users/test/project/summary.md",
		}},
	})
	if err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}
	if completed.TaskID != run.TaskID || completed.Status != StatusCompleted {
		t.Fatalf("completed run = %+v", completed)
	}
	if len(outputs) != 1 || outputs[0].TaskID != run.TaskID {
		t.Fatalf("outputs = %+v", outputs)
	}

	detail, err = service.GetIssueDetail(ctx, "workspace-1", issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() after complete error = %v", err)
	}
	if detail.Issue.Status != StatusPendingAcceptance || detail.Issue.TaskCount != 1 {
		t.Fatalf("completed issue detail = %+v", detail.Issue)
	}
	if len(detail.LatestOutputs) != 1 || detail.LatestOutputs[0].TaskID != run.TaskID {
		t.Fatalf("issue latest outputs = %+v", detail.LatestOutputs)
	}
}

func TestServiceCreateIssueRunCreatesTaskRunWhenIssueHasNoTasks(t *testing.T) {
	store := newFakeStore()
	service := testService(store)
	ctx := context.Background()

	issue, err := service.CreateIssue(ctx, CreateIssueInput{
		WorkspaceID: "workspace-1",
		TopicID:     DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Generate story",
		Content:     "Write a story",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}

	run, err := service.CreateRun(ctx, CreateRunInput{
		WorkspaceID:        "workspace-1",
		IssueID:            issue.IssueID,
		ActorUserID:        "user-1",
		RunID:              "run-issue-1",
		AgentProvider:      "codex",
		AgentTargetID:      "local:codex",
		AgentSessionID:     "agent-session-1",
		ExecutionDirectory: "/Users/test/project",
	})
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}
	if run.TaskID == "" {
		t.Fatalf("run task id is empty, want generated task id")
	}
	if run.OutputDir != "" {
		t.Fatalf("run output dir = %q, want empty", run.OutputDir)
	}
	if run.ExecutionDirectory != "/Users/test/project" {
		t.Fatalf("run execution directory = %q", run.ExecutionDirectory)
	}

	detail, err := service.GetIssueDetail(ctx, "workspace-1", issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if detail.Issue.Status != StatusRunning || detail.Issue.TaskCount != 1 || detail.Issue.RunningCount != 1 {
		t.Fatalf("running issue projection = %+v", detail.Issue)
	}
	if len(detail.Tasks) != 1 || detail.Tasks[0].TaskID != run.TaskID {
		t.Fatalf("detail tasks = %+v, run task id = %q", detail.Tasks, run.TaskID)
	}
	if detail.LatestRun == nil || detail.LatestRun.RunID != run.RunID || detail.LatestRun.TaskID != run.TaskID {
		t.Fatalf("issue latest run = %+v, want run %+v", detail.LatestRun, run)
	}
}

func TestProjectIssueStatusUsesRunningForPartialWork(t *testing.T) {
	tests := []struct {
		name   string
		counts StatusCounts
		want   Status
	}{
		{
			name: "pending acceptance and not started is running",
			counts: StatusCounts{
				All:               2,
				NotStarted:        1,
				PendingAcceptance: 1,
			},
			want: StatusRunning,
		},
		{
			name: "completed and not started is running",
			counts: StatusCounts{
				All:        2,
				NotStarted: 1,
				Completed:  1,
			},
			want: StatusRunning,
		},
		{
			name: "running outranks failed",
			counts: StatusCounts{
				All:     2,
				Running: 1,
				Failed:  1,
			},
			want: StatusRunning,
		},
		{
			name: "failed outranks pending acceptance",
			counts: StatusCounts{
				All:               2,
				PendingAcceptance: 1,
				Failed:            1,
			},
			want: StatusFailed,
		},
		{
			name: "pending acceptance only when all active work is completed or pending acceptance",
			counts: StatusCounts{
				All:               2,
				PendingAcceptance: 1,
				Completed:         1,
			},
			want: StatusPendingAcceptance,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ProjectIssueStatus(tt.counts); got != tt.want {
				t.Fatalf("ProjectIssueStatus(%+v) = %q, want %q", tt.counts, got, tt.want)
			}
		})
	}
}

func TestServiceAddContextRefs(t *testing.T) {
	store := newFakeStore()
	service := testService(store)
	ctx := context.Background()

	issue, err := service.CreateIssue(ctx, CreateIssueInput{
		WorkspaceID: "workspace-1",
		TopicID:     DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Context refs",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	task, err := service.CreateTask(ctx, CreateTaskInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Title:       "Collect files",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}

	refs, err := service.AddContextRefs(ctx, AddContextRefsInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		TaskID:      task.TaskID,
		ParentKind:  string(ContextRefParentTask),
		Refs: []AddContextRefInput{{
			RefType: "file",
			Path:    "/workspace/README.md",
		}},
	})
	if err != nil {
		t.Fatalf("AddContextRefs() error = %v", err)
	}
	if len(refs) != 1 || refs[0].DisplayName != "README.md" {
		t.Fatalf("refs = %+v", refs)
	}
	detail, err := service.GetTaskDetail(ctx, "workspace-1", issue.IssueID, task.TaskID)
	if err != nil {
		t.Fatalf("GetTaskDetail() error = %v", err)
	}
	if len(detail.ContextRefs) != 1 {
		t.Fatalf("detail context refs len = %d, want 1", len(detail.ContextRefs))
	}
}

func TestServiceDeleteTaskRecalculatesIssueProjection(t *testing.T) {
	store := newFakeStore()
	service := testService(store)
	ctx := context.Background()

	issue, err := service.CreateIssue(ctx, CreateIssueInput{
		WorkspaceID: "workspace-1",
		TopicID:     DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Delete task",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	task, err := service.CreateTask(ctx, CreateTaskInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Title:       "Remove me",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}

	removed, err := service.DeleteTask(ctx, "workspace-1", issue.IssueID, task.TaskID, "user-1")
	if err != nil {
		t.Fatalf("DeleteTask() error = %v", err)
	}
	if !removed {
		t.Fatal("DeleteTask() removed = false, want true")
	}
	detail, err := service.GetIssueDetail(ctx, "workspace-1", issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if detail.Issue.TaskCount != 0 || detail.Issue.Status != StatusNotStarted {
		t.Fatalf("issue projection after delete = %+v", detail.Issue)
	}
}

func TestServiceRemoveContextRefUsesParentScope(t *testing.T) {
	store := newFakeStore()
	service := testService(store)
	ctx := context.Background()

	issue, err := service.CreateIssue(ctx, CreateIssueInput{
		WorkspaceID: "workspace-1",
		TopicID:     DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Scoped refs",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	task, err := service.CreateTask(ctx, CreateTaskInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Title:       "Task ref",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	refs, err := service.AddContextRefs(ctx, AddContextRefsInput{
		WorkspaceID: "workspace-1",
		IssueID:     issue.IssueID,
		TaskID:      task.TaskID,
		ParentKind:  string(ContextRefParentTask),
		Refs: []AddContextRefInput{{
			ContextRefID: "ref-task-1",
			RefType:      "file",
			Path:         "/workspace/README.md",
		}},
	})
	if err != nil {
		t.Fatalf("AddContextRefs() error = %v", err)
	}
	if len(refs) != 1 {
		t.Fatalf("refs len = %d, want 1", len(refs))
	}

	removed, err := service.RemoveContextRef(ctx, RemoveContextRefInput{
		WorkspaceID:  "workspace-1",
		IssueID:      issue.IssueID,
		ParentKind:   string(ContextRefParentIssue),
		ContextRefID: refs[0].ContextRefID,
	})
	if !errors.Is(err, ErrContextRefNotFound) {
		t.Fatalf("RemoveContextRef() error = %v, want ErrContextRefNotFound", err)
	}
	if removed {
		t.Fatal("RemoveContextRef() removed = true, want false")
	}

	detail, err := service.GetTaskDetail(ctx, "workspace-1", issue.IssueID, task.TaskID)
	if err != nil {
		t.Fatalf("GetTaskDetail() error = %v", err)
	}
	if len(detail.ContextRefs) != 1 {
		t.Fatalf("detail context refs len = %d, want 1", len(detail.ContextRefs))
	}
}

func TestIssueListCursorTokenRoundTrip(t *testing.T) {
	cursor := &IssueListCursor{UpdatedAtUnixMS: 1_700_000_000_000, ID: 42}
	token := EncodeIssueListCursorToken(cursor)
	if token == "" {
		t.Fatal("EncodeIssueListCursorToken() returned empty token")
	}
	decoded, err := DecodeIssueListCursorToken(token)
	if err != nil {
		t.Fatalf("DecodeIssueListCursorToken() error = %v", err)
	}
	if *decoded != *cursor {
		t.Fatalf("decoded cursor = %+v, want %+v", decoded, cursor)
	}
	if _, err := DecodeIssueListCursorToken("not-a-valid-token"); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("DecodeIssueListCursorToken() error = %v, want ErrInvalidArgument", err)
	}
}

func testService(store Store) Service {
	counters := map[IDKind]int{}
	return Service{
		Clock: func() time.Time {
			return time.UnixMilli(1_700_000_000_000)
		},
		IDGenerator: func(kind IDKind) string {
			counters[kind]++
			return string(kind) + "-" + strconv.Itoa(counters[kind])
		},
		Store: store,
	}
}

type fakeStore struct {
	nextID uint64
	topics map[string]Topic
	issues map[string]Issue
	tasks  map[string]Task
	runs   map[string]Run
	output map[string][]RunOutput
	refs   map[string][]ContextRef
}

func newFakeStore() *fakeStore {
	store := &fakeStore{
		topics: map[string]Topic{},
		issues: map[string]Issue{},
		tasks:  map[string]Task{},
		runs:   map[string]Run{},
		output: map[string][]RunOutput{},
		refs:   map[string][]ContextRef{},
	}
	store.topics[topicKey("workspace-1", DefaultTopicID)] = Topic{
		ID:                   1,
		TopicID:              DefaultTopicID,
		WorkspaceID:          "workspace-1",
		Title:                "default",
		IsDefault:            true,
		LastActivityAtUnixMS: 1_700_000_000_000,
		CreatedAtUnixMS:      1_700_000_000_000,
		UpdatedAtUnixMS:      1_700_000_000_000,
	}
	return store
}

func (s *fakeStore) ListTopics(_ context.Context, workspaceID string) (TopicList, error) {
	items := make([]Topic, 0)
	for _, topic := range s.topics {
		if topic.WorkspaceID == workspaceID {
			items = append(items, topic)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].PinnedAtUnixMS > 0 || items[j].PinnedAtUnixMS > 0 {
			return items[i].PinnedAtUnixMS > items[j].PinnedAtUnixMS
		}
		return items[i].LastActivityAtUnixMS > items[j].LastActivityAtUnixMS
	})
	return TopicList{Items: items}, nil
}

func (s *fakeStore) CreateTopic(_ context.Context, topic Topic) (Topic, error) {
	key := topicKey(topic.WorkspaceID, topic.TopicID)
	if _, ok := s.topics[key]; ok {
		return Topic{}, ErrTopicAlreadyExists
	}
	s.nextID++
	topic.ID = s.nextID
	s.topics[key] = topic
	return topic, nil
}

func (s *fakeStore) GetTopic(_ context.Context, workspaceID string, topicID string) (Topic, error) {
	topic, ok := s.topics[topicKey(workspaceID, topicID)]
	if !ok {
		return Topic{}, ErrTopicNotFound
	}
	return topic, nil
}

func (s *fakeStore) UpdateTopic(_ context.Context, topic Topic) (Topic, error) {
	key := topicKey(topic.WorkspaceID, topic.TopicID)
	if _, ok := s.topics[key]; !ok {
		return Topic{}, ErrTopicNotFound
	}
	s.topics[key] = topic
	return topic, nil
}

func (s *fakeStore) DeleteTopic(_ context.Context, workspaceID string, topicID string) (bool, error) {
	key := topicKey(workspaceID, topicID)
	if _, ok := s.topics[key]; !ok {
		return false, ErrTopicNotFound
	}
	delete(s.topics, key)
	return true, nil
}

func (s *fakeStore) TouchTopicActivity(_ context.Context, workspaceID string, topicID string, atUnixMS int64) error {
	key := topicKey(workspaceID, topicID)
	topic, ok := s.topics[key]
	if !ok {
		return ErrTopicNotFound
	}
	topic.LastActivityAtUnixMS = atUnixMS
	topic.UpdatedAtUnixMS = atUnixMS
	s.topics[key] = topic
	return nil
}

func (s *fakeStore) ListIssues(_ context.Context, filter IssueListFilter) (IssueList, error) {
	items := make([]Issue, 0)
	for _, issue := range s.issues {
		if issue.WorkspaceID != filter.WorkspaceID || issue.TopicID != filter.TopicID {
			continue
		}
		if filter.StatusFilter != "" && issue.Status != filter.StatusFilter {
			continue
		}
		if !matchesSearch(filter.SearchQuery, issue.Title, issue.SearchText) {
			continue
		}
		items = append(items, issue)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].UpdatedAtUnixMS == items[j].UpdatedAtUnixMS {
			return items[i].ID < items[j].ID
		}
		return items[i].UpdatedAtUnixMS > items[j].UpdatedAtUnixMS
	})
	return IssueList{
		Items:        items,
		TotalCount:   len(items),
		StatusCounts: countIssueStatuses(items),
	}, nil
}

func (s *fakeStore) CreateIssue(_ context.Context, issue Issue) (Issue, error) {
	s.nextID++
	issue.ID = s.nextID
	s.issues[issueKey(issue.WorkspaceID, issue.IssueID)] = issue
	return issue, nil
}

func (s *fakeStore) GetIssue(_ context.Context, workspaceID string, issueID string) (Issue, error) {
	issue, ok := s.issues[issueKey(workspaceID, issueID)]
	if !ok {
		return Issue{}, ErrIssueNotFound
	}
	return issue, nil
}

func (s *fakeStore) UpdateIssue(_ context.Context, issue Issue) (Issue, error) {
	key := issueKey(issue.WorkspaceID, issue.IssueID)
	if _, ok := s.issues[key]; !ok {
		return Issue{}, ErrIssueNotFound
	}
	s.issues[key] = issue
	return issue, nil
}

func (s *fakeStore) DeleteIssue(_ context.Context, workspaceID string, issueID string, _ string) (bool, error) {
	key := issueKey(workspaceID, issueID)
	if _, ok := s.issues[key]; !ok {
		return false, nil
	}
	delete(s.issues, key)
	return true, nil
}

func (s *fakeStore) RecalculateIssueProjection(_ context.Context, workspaceID string, issueID string) (Issue, error) {
	key := issueKey(workspaceID, issueID)
	issue, ok := s.issues[key]
	if !ok {
		return Issue{}, ErrIssueNotFound
	}
	tasks := make([]Task, 0)
	for _, task := range s.tasks {
		if task.WorkspaceID == workspaceID && task.IssueID == issueID {
			tasks = append(tasks, task)
		}
	}
	counts := countTaskStatuses(tasks)
	issue.TaskCount = counts.All
	issue.NotStartedCount = counts.NotStarted
	issue.RunningCount = counts.Running
	issue.PendingAcceptanceCount = counts.PendingAcceptance
	issue.CompletedCount = counts.Completed
	issue.FailedCount = counts.Failed
	issue.CanceledCount = counts.Canceled
	issue.Status = projectedIssueStatus(counts)
	s.issues[key] = issue
	return issue, nil
}

func (s *fakeStore) ListTasks(_ context.Context, filter TaskListFilter) (TaskList, error) {
	items := make([]Task, 0)
	for _, task := range s.tasks {
		if task.WorkspaceID != filter.WorkspaceID || task.IssueID != filter.IssueID {
			continue
		}
		if filter.StatusFilter != "" && task.Status != filter.StatusFilter {
			continue
		}
		if !matchesSearch(filter.SearchQuery, task.Title, task.SearchText) {
			continue
		}
		items = append(items, task)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].SortIndex == items[j].SortIndex {
			return items[i].ID < items[j].ID
		}
		return items[i].SortIndex < items[j].SortIndex
	})
	return TaskList{
		Items:        items,
		TotalCount:   len(items),
		StatusCounts: countTaskStatuses(items),
	}, nil
}

func (s *fakeStore) AppendTasks(_ context.Context, tasks []Task) ([]Task, error) {
	if len(tasks) == 0 {
		return []Task{}, nil
	}
	workspaceID := tasks[0].WorkspaceID
	issueID := tasks[0].IssueID
	if _, ok := s.issues[issueKey(workspaceID, issueID)]; !ok {
		return nil, ErrIssueNotFound
	}
	next := 1
	for _, task := range s.tasks {
		if task.WorkspaceID == workspaceID && task.IssueID == issueID && task.SortIndex >= next {
			next = task.SortIndex + 1
		}
	}
	created := make([]Task, 0, len(tasks))
	for index, task := range tasks {
		if task.WorkspaceID != workspaceID || task.IssueID != issueID {
			return nil, ErrInvalidArgument
		}
		key := taskKey(task.WorkspaceID, task.IssueID, task.TaskID)
		if _, ok := s.tasks[key]; ok {
			return nil, ErrTaskAlreadyExists
		}
		s.nextID++
		task.ID = s.nextID
		task.SortIndex = next + index
		s.tasks[key] = task
		created = append(created, task)
	}
	return created, nil
}

func (s *fakeStore) CreateTask(_ context.Context, task Task) (Task, error) {
	if _, ok := s.issues[issueKey(task.WorkspaceID, task.IssueID)]; !ok {
		return Task{}, ErrIssueNotFound
	}
	s.nextID++
	task.ID = s.nextID
	s.tasks[taskKey(task.WorkspaceID, task.IssueID, task.TaskID)] = task
	return task, nil
}

func (s *fakeStore) GetTask(_ context.Context, workspaceID string, issueID string, taskID string) (Task, error) {
	task, ok := s.tasks[taskKey(workspaceID, issueID, taskID)]
	if !ok {
		return Task{}, ErrTaskNotFound
	}
	return task, nil
}

func (s *fakeStore) UpdateTask(_ context.Context, task Task) (Task, error) {
	key := taskKey(task.WorkspaceID, task.IssueID, task.TaskID)
	if _, ok := s.tasks[key]; !ok {
		return Task{}, ErrTaskNotFound
	}
	s.tasks[key] = task
	return task, nil
}

func (s *fakeStore) DeleteTask(_ context.Context, workspaceID string, issueID string, taskID string, _ string) (bool, error) {
	key := taskKey(workspaceID, issueID, taskID)
	if _, ok := s.tasks[key]; !ok {
		return false, nil
	}
	delete(s.tasks, key)
	return true, nil
}

func (s *fakeStore) AddContextRefs(_ context.Context, refs []ContextRef) ([]ContextRef, error) {
	saved := make([]ContextRef, 0, len(refs))
	for _, ref := range refs {
		s.nextID++
		ref.ID = s.nextID
		key := contextRefBucketKey(ref.WorkspaceID, ref.IssueID, ref.TaskID, ref.ParentKind)
		s.refs[key] = append(s.refs[key], ref)
		saved = append(saved, ref)
	}
	return saved, nil
}

func (s *fakeStore) ListContextRefs(_ context.Context, workspaceID string, issueID string, taskID string, parentKind ContextRefParentKind) ([]ContextRef, error) {
	refs := s.refs[contextRefBucketKey(workspaceID, issueID, taskID, parentKind)]
	return append([]ContextRef(nil), refs...), nil
}

func (s *fakeStore) RemoveContextRef(_ context.Context, workspaceID string, issueID string, taskID string, parentKind ContextRefParentKind, contextRefID string) (bool, error) {
	key := contextRefBucketKey(workspaceID, issueID, taskID, parentKind)
	refs := s.refs[key]
	next := refs[:0]
	removed := false
	for _, ref := range refs {
		if ref.WorkspaceID == workspaceID && ref.IssueID == issueID && ref.TaskID == taskID && ref.ParentKind == parentKind && ref.ContextRefID == contextRefID {
			removed = true
			continue
		}
		next = append(next, ref)
	}
	if removed {
		s.refs[key] = next
		return true, nil
	}
	return false, nil
}

func (s *fakeStore) CreateRun(_ context.Context, run Run) (Run, error) {
	if run.TaskID != "" {
		if _, ok := s.tasks[taskKey(run.WorkspaceID, run.IssueID, run.TaskID)]; !ok {
			return Run{}, ErrTaskNotFound
		}
	} else if _, ok := s.issues[issueKey(run.WorkspaceID, run.IssueID)]; !ok {
		return Run{}, ErrTaskNotFound
	}
	s.nextID++
	run.ID = s.nextID
	s.runs[runKey(run.WorkspaceID, run.IssueID, run.TaskID, run.RunID)] = run
	return run, nil
}

func (s *fakeStore) CompleteRun(_ context.Context, run Run, outputs []RunOutput) (Run, []RunOutput, error) {
	key := runKey(run.WorkspaceID, run.IssueID, run.TaskID, run.RunID)
	if _, ok := s.runs[key]; !ok {
		return Run{}, nil, ErrRunNotFound
	}
	s.runs[key] = run
	saved := make([]RunOutput, 0, len(outputs))
	for _, output := range outputs {
		s.nextID++
		output.ID = s.nextID
		saved = append(saved, output)
	}
	s.output[key] = saved
	return run, saved, nil
}

func (s *fakeStore) ListRuns(_ context.Context, workspaceID string, issueID string, taskID string) ([]Run, error) {
	runs := make([]Run, 0)
	for _, run := range s.runs {
		if run.WorkspaceID == workspaceID && run.IssueID == issueID && (taskID == "" || run.TaskID == taskID) {
			runs = append(runs, run)
		}
	}
	sort.Slice(runs, func(i, j int) bool {
		if runs[i].CreatedAtUnixMS == runs[j].CreatedAtUnixMS {
			return runs[i].ID > runs[j].ID
		}
		return runs[i].CreatedAtUnixMS > runs[j].CreatedAtUnixMS
	})
	return runs, nil
}

func (s *fakeStore) ListRunningRuns(_ context.Context, workspaceID string, limit int) ([]Run, error) {
	runs := make([]Run, 0)
	for _, run := range s.runs {
		if run.WorkspaceID == workspaceID && run.Status == StatusRunning && strings.TrimSpace(run.AgentSessionID) != "" {
			runs = append(runs, run)
			if limit > 0 && len(runs) >= limit {
				break
			}
		}
	}
	return runs, nil
}

func (s *fakeStore) GetRun(_ context.Context, workspaceID string, issueID string, taskID string, runID string) (Run, error) {
	run, ok := s.runs[runKey(workspaceID, issueID, taskID, runID)]
	if !ok {
		return Run{}, ErrRunNotFound
	}
	return run, nil
}

func (s *fakeStore) ListRunOutputs(_ context.Context, workspaceID string, issueID string, taskID string, runID string) ([]RunOutput, error) {
	outputs := s.output[runKey(workspaceID, issueID, taskID, runID)]
	return append([]RunOutput(nil), outputs...), nil
}

func (s *fakeStore) ListLatestRunOutputs(_ context.Context, workspaceID string, issueID string, taskID string) ([]RunOutput, error) {
	runs, err := s.ListRuns(context.Background(), workspaceID, issueID, taskID)
	if err != nil {
		return nil, err
	}
	if len(runs) == 0 {
		return nil, nil
	}
	return s.ListRunOutputs(context.Background(), workspaceID, issueID, runs[0].TaskID, runs[0].RunID)
}

func (s *fakeStore) SearchRunOutputs(_ context.Context, params RunOutputSearchParams) ([]RunOutputSearchHit, error) {
	query := strings.ToLower(params.Query)
	matches := make([]RunOutput, 0)
	for _, outputs := range s.output {
		for _, output := range outputs {
			if output.WorkspaceID != params.WorkspaceID {
				continue
			}
			if !strings.Contains(strings.ToLower(output.DisplayName), query) {
				continue
			}
			if params.IssueID != "" {
				if output.IssueID != params.IssueID {
					continue
				}
			} else if params.TopicID != "" {
				if s.issues[issueKey(output.WorkspaceID, output.IssueID)].TopicID != params.TopicID {
					continue
				}
			}
			matches = append(matches, output)
		}
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].CreatedAtUnixMS != matches[j].CreatedAtUnixMS {
			return matches[i].CreatedAtUnixMS > matches[j].CreatedAtUnixMS
		}
		return matches[i].ID > matches[j].ID
	})
	hits := make([]RunOutputSearchHit, 0)
	seenPaths := map[string]struct{}{}
	for _, output := range matches {
		if params.Limit > 0 && len(hits) >= params.Limit {
			break
		}
		if _, exists := seenPaths[output.Path]; exists {
			continue
		}
		seenPaths[output.Path] = struct{}{}
		hits = append(hits, RunOutputSearchHit{
			Output:     output,
			IssueTitle: s.issues[issueKey(output.WorkspaceID, output.IssueID)].Title,
		})
	}
	return hits, nil
}

func issueKey(workspaceID string, issueID string) string {
	return strings.Join([]string{workspaceID, issueID}, "\x00")
}

func topicKey(workspaceID string, topicID string) string {
	return strings.Join([]string{workspaceID, topicID}, "\x00")
}

func taskKey(workspaceID string, issueID string, taskID string) string {
	return strings.Join([]string{workspaceID, issueID, taskID}, "\x00")
}

func runKey(workspaceID string, issueID string, taskID string, runID string) string {
	return strings.Join([]string{workspaceID, issueID, taskID, runID}, "\x00")
}

func contextRefBucketKey(workspaceID string, issueID string, taskID string, parentKind ContextRefParentKind) string {
	return strings.Join([]string{workspaceID, issueID, taskID, string(parentKind)}, "\x00")
}

func matchesSearch(query string, values ...string) bool {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return true
	}
	for _, value := range values {
		if strings.Contains(strings.ToLower(value), query) {
			return true
		}
	}
	return false
}

func countIssueStatuses(items []Issue) StatusCounts {
	counts := StatusCounts{All: len(items)}
	for _, item := range items {
		incrementStatus(&counts, item.Status)
	}
	return counts
}

func countTaskStatuses(items []Task) StatusCounts {
	counts := StatusCounts{All: len(items)}
	for _, item := range items {
		incrementStatus(&counts, item.Status)
	}
	return counts
}

func incrementStatus(counts *StatusCounts, status Status) {
	switch status {
	case StatusRunning:
		counts.Running++
	case StatusPendingAcceptance:
		counts.PendingAcceptance++
	case StatusCompleted:
		counts.Completed++
	case StatusFailed:
		counts.Failed++
	case StatusCanceled:
		counts.Canceled++
	default:
		counts.NotStarted++
	}
}

func projectedIssueStatus(counts StatusCounts) Status {
	return ProjectIssueStatus(counts)
}

var _ Store = (*fakeStore)(nil)

func TestFakeStoreNotFoundSentinels(t *testing.T) {
	store := newFakeStore()
	if _, err := store.GetIssue(context.Background(), "workspace-1", "missing"); !errors.Is(err, ErrIssueNotFound) {
		t.Fatalf("GetIssue() error = %v, want ErrIssueNotFound", err)
	}
}
