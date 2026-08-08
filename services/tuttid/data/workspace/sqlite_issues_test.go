package workspace

import (
	"context"
	"errors"
	"math"
	"strconv"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestSQLiteIssueStoreRejectsNonFinitePersistedBudgetOnRead(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-nonfinite", Name: "Nonfinite"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	issue, err := testIssueService(store).CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID: "ws-nonfinite", TopicID: workspaceissues.DefaultTopicID,
		ActorUserID: "user-1", Title: "Finite first",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `UPDATE workspace_issues SET budget_quota_waterline_percent = ? WHERE workspace_id = ? AND issue_id = ?`, math.Inf(1), "ws-nonfinite", issue.IssueID); err != nil {
		t.Fatalf("corrupt persisted budget: %v", err)
	}
	if _, err := store.GetIssue(ctx, "ws-nonfinite", issue.IssueID); err == nil {
		t.Fatal("GetIssue() error = nil, want invalid persisted budget")
	}
}

func TestSQLiteIssueStoreLifecycle(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-1",
		Name: "Issue Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	service := testIssueService(store)
	issue, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID: "ws-issue-1",
		TopicID:     workspaceissues.DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Ship issue manager",
		Content:     "Build local storage",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	task, err := service.CreateTask(ctx, workspaceissues.CreateTaskInput{
		WorkspaceID: "ws-issue-1",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Title:       "Wire SQLite store",
		Priority:    string(workspaceissues.PriorityHigh),
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}

	refs, err := service.AddContextRefs(ctx, workspaceissues.AddContextRefsInput{
		WorkspaceID: "ws-issue-1",
		IssueID:     issue.IssueID,
		TaskID:      task.TaskID,
		ParentKind:  string(workspaceissues.ContextRefParentTask),
		Refs: []workspaceissues.AddContextRefInput{{
			RefType: "file",
			Path:    "/workspace/README.md",
		}},
	})
	if err != nil {
		t.Fatalf("AddContextRefs() error = %v", err)
	}
	if len(refs) != 1 || refs[0].ContextRefID == "" {
		t.Fatalf("context refs = %+v", refs)
	}

	run, err := service.CreateRun(ctx, workspaceissues.CreateRunInput{
		WorkspaceID:   "ws-issue-1",
		IssueID:       issue.IssueID,
		TaskID:        task.TaskID,
		ActorUserID:   "user-1",
		AgentProvider: "codex",
		AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}
	completed, outputs, err := service.CompleteRun(ctx, workspaceissues.CompleteRunInput{
		WorkspaceID: "ws-issue-1",
		IssueID:     issue.IssueID,
		TaskID:      task.TaskID,
		RunID:       run.RunID,
		ActorUserID: "user-1",
		Status:      string(workspaceissues.StatusCompleted),
		Summary:     "Done",
		Outputs: []workspaceissues.CompleteRunOutputInput{{
			Path: "/workspace/out/result.md",
		}},
	})
	if err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}
	if completed.Status != workspaceissues.StatusCompleted || len(outputs) != 1 {
		t.Fatalf("completed run = %+v outputs = %+v", completed, outputs)
	}

	taskDetail, err := service.GetTaskDetail(ctx, "ws-issue-1", issue.IssueID, task.TaskID)
	if err != nil {
		t.Fatalf("GetTaskDetail() error = %v", err)
	}
	if taskDetail.Task.Status != workspaceissues.StatusPendingAcceptance {
		t.Fatalf("task status = %q", taskDetail.Task.Status)
	}
	if len(taskDetail.ContextRefs) != 1 || len(taskDetail.LatestOutputs) != 1 {
		t.Fatalf("task detail = %+v", taskDetail)
	}
}

func TestSQLiteIssueStoreSearchRunOutputs(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-search",
		Name: "Search Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	service := testIssueService(store)

	topicB, err := service.CreateTopic(ctx, workspaceissues.CreateTopicInput{
		WorkspaceID: "ws-search",
		ActorUserID: "user-1",
		Title:       "Topic B",
	})
	if err != nil {
		t.Fatalf("CreateTopic() error = %v", err)
	}

	createIssueWithOutputs := func(topicID string, title string, paths []string) string {
		t.Helper()
		issue, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
			WorkspaceID: "ws-search",
			TopicID:     topicID,
			ActorUserID: "user-1",
			Title:       title,
		})
		if err != nil {
			t.Fatalf("CreateIssue(%q) error = %v", title, err)
		}
		task, err := service.CreateTask(ctx, workspaceissues.CreateTaskInput{
			WorkspaceID: "ws-search",
			IssueID:     issue.IssueID,
			ActorUserID: "user-1",
			Title:       "task for " + title,
		})
		if err != nil {
			t.Fatalf("CreateTask(%q) error = %v", title, err)
		}
		run, err := service.CreateRun(ctx, workspaceissues.CreateRunInput{
			WorkspaceID:   "ws-search",
			IssueID:       issue.IssueID,
			TaskID:        task.TaskID,
			ActorUserID:   "user-1",
			AgentProvider: "codex",
			AgentTargetID: "local:codex",
		})
		if err != nil {
			t.Fatalf("CreateRun(%q) error = %v", title, err)
		}
		outputs := make([]workspaceissues.CompleteRunOutputInput, 0, len(paths))
		for _, p := range paths {
			outputs = append(outputs, workspaceissues.CompleteRunOutputInput{Path: p})
		}
		if _, _, err := service.CompleteRun(ctx, workspaceissues.CompleteRunInput{
			WorkspaceID: "ws-search",
			IssueID:     issue.IssueID,
			TaskID:      task.TaskID,
			RunID:       run.RunID,
			ActorUserID: "user-1",
			Status:      string(workspaceissues.StatusCompleted),
			Outputs:     outputs,
		}); err != nil {
			t.Fatalf("CompleteRun(%q) error = %v", title, err)
		}
		return issue.IssueID
	}

	issueA := createIssueWithOutputs(workspaceissues.DefaultTopicID, "Alpha issue",
		[]string{"/ws/a/alpha-report.md", "/ws/a/shared-notes.md"})
	createIssueWithOutputs(topicB.TopicID, "Beta issue",
		[]string{"/ws/b/beta-report.md", "/ws/b/shared-notes.md"})

	displayNames := func(hits []workspaceissues.RunOutputSearchHit) []string {
		names := make([]string, 0, len(hits))
		for _, hit := range hits {
			names = append(names, hit.Output.DisplayName)
		}
		return names
	}

	// Workspace-wide name match spans both issues and annotates issue titles.
	hits, err := store.SearchRunOutputs(ctx, workspaceissues.RunOutputSearchParams{
		WorkspaceID: "ws-search",
		Query:       "report",
		Limit:       50,
	})
	if err != nil {
		t.Fatalf("SearchRunOutputs(report) error = %v", err)
	}
	if got := displayNames(hits); len(got) != 2 {
		t.Fatalf("report hits = %v, want 2", got)
	}
	for _, hit := range hits {
		if hit.IssueTitle == "" {
			t.Fatalf("hit missing issue title: %+v", hit)
		}
	}

	// Case-insensitive match.
	hits, err = store.SearchRunOutputs(ctx, workspaceissues.RunOutputSearchParams{
		WorkspaceID: "ws-search",
		Query:       "ALPHA",
		Limit:       50,
	})
	if err != nil {
		t.Fatalf("SearchRunOutputs(ALPHA) error = %v", err)
	}
	if got := displayNames(hits); len(got) != 1 || got[0] != "alpha-report.md" {
		t.Fatalf("ALPHA hits = %v, want [alpha-report.md]", got)
	}

	// IssueID scope limits to one issue.
	hits, err = store.SearchRunOutputs(ctx, workspaceissues.RunOutputSearchParams{
		WorkspaceID: "ws-search",
		Query:       "notes",
		IssueID:     issueA,
		Limit:       50,
	})
	if err != nil {
		t.Fatalf("SearchRunOutputs(notes, issueA) error = %v", err)
	}
	if got := displayNames(hits); len(got) != 1 || hits[0].Output.IssueID != issueA {
		t.Fatalf("notes/issueA hits = %v (issue %q), want one under %q", got, hits[0].Output.IssueID, issueA)
	}

	// TopicID scope limits to issues under one topic.
	hits, err = store.SearchRunOutputs(ctx, workspaceissues.RunOutputSearchParams{
		WorkspaceID: "ws-search",
		Query:       "notes",
		TopicID:     topicB.TopicID,
		Limit:       50,
	})
	if err != nil {
		t.Fatalf("SearchRunOutputs(notes, topicB) error = %v", err)
	}
	if got := displayNames(hits); len(got) != 1 {
		t.Fatalf("notes/topicB hits = %v, want 1", got)
	}
}

func TestSQLiteIssueStoreRunLifecycleForIssueWithoutTasks(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-run",
		Name: "Issue Run Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	service := testIssueService(store)
	issue, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID: "ws-issue-run",
		TopicID:     workspaceissues.DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Say hello",
		Content:     "Say hello to me",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}

	run, err := service.CreateRun(ctx, workspaceissues.CreateRunInput{
		WorkspaceID:        "ws-issue-run",
		IssueID:            issue.IssueID,
		ActorUserID:        "user-1",
		RunID:              "run-issue-1",
		AgentProvider:      "codex",
		AgentTargetID:      "local:codex",
		ExecutionDirectory: "/Users/test/project",
	})
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}
	if run.TaskID == "" || run.OutputDir != "" || run.ExecutionDirectory != "/Users/test/project" {
		t.Fatalf("created run = %+v", run)
	}

	completed, outputs, err := service.CompleteRun(ctx, workspaceissues.CompleteRunInput{
		WorkspaceID: "ws-issue-run",
		IssueID:     issue.IssueID,
		TaskID:      run.TaskID,
		RunID:       run.RunID,
		ActorUserID: "user-1",
		Status:      string(workspaceissues.StatusCompleted),
		Summary:     "Done",
		Outputs: []workspaceissues.CompleteRunOutputInput{{
			Path: "/Users/test/project/summary.md",
		}},
	})
	if err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}
	if completed.TaskID != run.TaskID || completed.Status != workspaceissues.StatusCompleted {
		t.Fatalf("completed run = %+v", completed)
	}
	if len(outputs) != 1 || outputs[0].TaskID != run.TaskID {
		t.Fatalf("outputs = %+v", outputs)
	}

	detail, err := service.GetIssueDetail(ctx, "ws-issue-run", issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if detail.Issue.Status != workspaceissues.StatusPendingAcceptance || detail.Issue.TaskCount != 1 {
		t.Fatalf("issue detail = %+v", detail.Issue)
	}
	if detail.LatestRun == nil || detail.LatestRun.RunID != run.RunID || detail.LatestRun.TaskID != run.TaskID {
		t.Fatalf("latest run = %+v", detail.LatestRun)
	}
	if len(detail.LatestOutputs) != 1 || detail.LatestOutputs[0].TaskID != run.TaskID {
		t.Fatalf("latest outputs = %+v", detail.LatestOutputs)
	}
}

func TestSQLiteIssueStoreListRunningRunsFiltersByWorkspaceAndSession(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	for _, workspaceID := range []string{"ws-running-1", "ws-running-2"} {
		if err := store.Create(ctx, workspacebiz.Summary{
			ID:   workspaceID,
			Name: workspaceID,
		}); err != nil {
			t.Fatalf("Create() workspace %s error = %v", workspaceID, err)
		}
	}

	service := testIssueService(store)
	issue, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID: "ws-running-1",
		TopicID:     workspaceissues.DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Running runs",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	task, err := service.CreateTask(ctx, workspaceissues.CreateTaskInput{
		WorkspaceID: "ws-running-1",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Title:       "Task",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	running, err := service.CreateRun(ctx, workspaceissues.CreateRunInput{
		WorkspaceID:    "ws-running-1",
		IssueID:        issue.IssueID,
		TaskID:         task.TaskID,
		ActorUserID:    "user-1",
		RunID:          "run-running",
		AgentProvider:  "codex",
		AgentTargetID:  "local:codex",
		AgentSessionID: "session-1",
	})
	if err != nil {
		t.Fatalf("CreateRun() running error = %v", err)
	}
	withoutSession, err := service.CreateRun(ctx, workspaceissues.CreateRunInput{
		WorkspaceID:   "ws-running-1",
		IssueID:       issue.IssueID,
		TaskID:        task.TaskID,
		ActorUserID:   "user-1",
		RunID:         "run-no-session",
		AgentProvider: "codex",
		AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatalf("CreateRun() no session error = %v", err)
	}
	if _, _, err := service.CompleteRun(ctx, workspaceissues.CompleteRunInput{
		WorkspaceID: "ws-running-1",
		IssueID:     issue.IssueID,
		TaskID:      task.TaskID,
		RunID:       withoutSession.RunID,
		ActorUserID: "user-1",
		Status:      string(workspaceissues.StatusFailed),
	}); err != nil {
		t.Fatalf("CompleteRun() error = %v", err)
	}

	runs, err := store.ListRunningRuns(ctx, "ws-running-1", 10)
	if err != nil {
		t.Fatalf("ListRunningRuns() error = %v", err)
	}
	if len(runs) != 1 || runs[0].RunID != running.RunID {
		t.Fatalf("running runs = %+v, want only %q", runs, running.RunID)
	}
}

func TestSQLiteIssueStoreListIssuesPagination(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-list",
		Name: "Issue List Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	service := testIssueService(store)
	for _, title := range []string{"First", "Second"} {
		if _, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
			WorkspaceID: "ws-issue-list",
			TopicID:     workspaceissues.DefaultTopicID,
			ActorUserID: "user-1",
			Title:       title,
		}); err != nil {
			t.Fatalf("CreateIssue(%q) error = %v", title, err)
		}
	}

	firstPage, err := service.ListIssues(ctx, workspaceissues.IssueListFilter{
		WorkspaceID: "ws-issue-list",
		TopicID:     workspaceissues.DefaultTopicID,
		PageSize:    1,
	})
	if err != nil {
		t.Fatalf("ListIssues() first page error = %v", err)
	}
	if len(firstPage.Items) != 1 || firstPage.NextPageToken == "" {
		t.Fatalf("first page = %+v", firstPage)
	}

	cursor, err := workspaceissues.DecodeIssueListCursorToken(firstPage.NextPageToken)
	if err != nil {
		t.Fatalf("DecodeIssueListCursorToken() error = %v", err)
	}
	secondPage, err := service.ListIssues(ctx, workspaceissues.IssueListFilter{
		WorkspaceID: "ws-issue-list",
		TopicID:     workspaceissues.DefaultTopicID,
		PageSize:    1,
		Cursor:      cursor,
	})
	if err != nil {
		t.Fatalf("ListIssues() second page error = %v", err)
	}
	if len(secondPage.Items) != 1 || secondPage.NextPageToken != "" {
		t.Fatalf("second page = %+v", secondPage)
	}
	if firstPage.Items[0].IssueID == secondPage.Items[0].IssueID {
		t.Fatalf("pagination repeated issue id %q", firstPage.Items[0].IssueID)
	}
}

func TestSQLiteIssueStoreListSearchMatchesTitlesOnly(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-title-search",
		Name: "Title Search Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	service := testIssueService(store)
	titleMatch, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID: "ws-title-search",
		TopicID:     workspaceissues.DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Build a toy website",
		Content:     "Read the project first",
	})
	if err != nil {
		t.Fatalf("CreateIssue() title match error = %v", err)
	}
	if _, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID: "ws-title-search",
		TopicID:     workspaceissues.DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Read the project",
		Content:     "Build a toy website",
	}); err != nil {
		t.Fatalf("CreateIssue() content-only match error = %v", err)
	}

	issues, err := service.ListIssues(ctx, workspaceissues.IssueListFilter{
		WorkspaceID: "ws-title-search",
		TopicID:     workspaceissues.DefaultTopicID,
		SearchQuery: "TOY",
	})
	if err != nil {
		t.Fatalf("ListIssues() error = %v", err)
	}
	if len(issues.Items) != 1 || issues.Items[0].IssueID != titleMatch.IssueID {
		t.Fatalf("ListIssues() items = %+v, want only title match %q", issues.Items, titleMatch.IssueID)
	}
	if issues.TotalCount != 1 || issues.StatusCounts.All != 1 {
		t.Fatalf("ListIssues() counts = total:%d statuses:%+v, want one", issues.TotalCount, issues.StatusCounts)
	}

	titleTask, err := service.CreateTask(ctx, workspaceissues.CreateTaskInput{
		WorkspaceID: "ws-title-search",
		IssueID:     titleMatch.IssueID,
		ActorUserID: "user-1",
		Title:       "Paint the toy model",
		Content:     "Use the reference image",
	})
	if err != nil {
		t.Fatalf("CreateTask() title match error = %v", err)
	}
	if _, err := service.CreateTask(ctx, workspaceissues.CreateTaskInput{
		WorkspaceID: "ws-title-search",
		IssueID:     titleMatch.IssueID,
		ActorUserID: "user-1",
		Title:       "Read the reference image",
		Content:     "Paint the toy model",
	}); err != nil {
		t.Fatalf("CreateTask() content-only match error = %v", err)
	}

	tasks, err := service.ListTasks(ctx, workspaceissues.TaskListFilter{
		WorkspaceID: "ws-title-search",
		IssueID:     titleMatch.IssueID,
		SearchQuery: "TOY",
	})
	if err != nil {
		t.Fatalf("ListTasks() error = %v", err)
	}
	if len(tasks.Items) != 1 || tasks.Items[0].TaskID != titleTask.TaskID {
		t.Fatalf("ListTasks() items = %+v, want only title match %q", tasks.Items, titleTask.TaskID)
	}
	if tasks.TotalCount != 1 || tasks.StatusCounts.All != 1 {
		t.Fatalf("ListTasks() counts = total:%d statuses:%+v, want one", tasks.TotalCount, tasks.StatusCounts)
	}
}

func TestSQLiteIssueStoreListStatusCountsIgnoreStatusFilter(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-counts",
		Name: "Issue Counts Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	service := testIssueService(store)
	runningIssue, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID: "ws-issue-counts",
		TopicID:     workspaceissues.DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Run renderer migration",
	})
	if err != nil {
		t.Fatalf("CreateIssue() running issue error = %v", err)
	}
	runningTask, err := service.CreateTask(ctx, workspaceissues.CreateTaskInput{
		WorkspaceID: "ws-issue-counts",
		IssueID:     runningIssue.IssueID,
		ActorUserID: "user-1",
		Title:       "Execute migration",
	})
	if err != nil {
		t.Fatalf("CreateTask() running task error = %v", err)
	}
	if _, err := service.UpdateTask(ctx, workspaceissues.UpdateTaskInput{
		WorkspaceID: "ws-issue-counts",
		IssueID:     runningIssue.IssueID,
		TaskID:      runningTask.TaskID,
		ActorUserID: "user-1",
		Status:      string(workspaceissues.StatusRunning),
		HasStatus:   true,
	}); err != nil {
		t.Fatalf("UpdateTask() running status error = %v", err)
	}
	notStartedIssue, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID: "ws-issue-counts",
		TopicID:     workspaceissues.DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Write release notes",
	})
	if err != nil {
		t.Fatalf("CreateIssue() not started issue error = %v", err)
	}
	if _, err := service.CreateTask(ctx, workspaceissues.CreateTaskInput{
		WorkspaceID: "ws-issue-counts",
		IssueID:     runningIssue.IssueID,
		ActorUserID: "user-1",
		Title:       "Draft rollout notes",
	}); err != nil {
		t.Fatalf("CreateTask() not started task error = %v", err)
	}
	if _, err := service.CreateTask(ctx, workspaceissues.CreateTaskInput{
		WorkspaceID: "ws-issue-counts",
		IssueID:     notStartedIssue.IssueID,
		ActorUserID: "user-1",
		Title:       "Collect approvals",
	}); err != nil {
		t.Fatalf("CreateTask() not started issue task error = %v", err)
	}

	issueList, err := service.ListIssues(ctx, workspaceissues.IssueListFilter{
		WorkspaceID:  "ws-issue-counts",
		TopicID:      workspaceissues.DefaultTopicID,
		StatusFilter: workspaceissues.StatusRunning,
	})
	if err != nil {
		t.Fatalf("ListIssues() error = %v", err)
	}
	if issueList.TotalCount != 1 || len(issueList.Items) != 1 {
		t.Fatalf("issue list = %+v", issueList)
	}
	if issueList.StatusCounts.All != 2 ||
		issueList.StatusCounts.Running != 1 ||
		issueList.StatusCounts.NotStarted != 1 {
		t.Fatalf("issue status counts = %+v", issueList.StatusCounts)
	}

	taskList, err := service.ListTasks(ctx, workspaceissues.TaskListFilter{
		WorkspaceID:  "ws-issue-counts",
		IssueID:      runningIssue.IssueID,
		StatusFilter: workspaceissues.StatusRunning,
	})
	if err != nil {
		t.Fatalf("ListTasks() error = %v", err)
	}
	if taskList.TotalCount != 1 || len(taskList.Items) != 1 {
		t.Fatalf("task list = %+v", taskList)
	}
	if taskList.StatusCounts.All != 2 ||
		taskList.StatusCounts.Running != 1 ||
		taskList.StatusCounts.NotStarted != 1 {
		t.Fatalf("task status counts = %+v", taskList.StatusCounts)
	}
	if taskList.Items[0].TaskID != runningTask.TaskID {
		t.Fatalf("task list item = %+v", taskList.Items[0])
	}
}

func TestSQLiteIssueStoreRemoveContextRefUsesScopedParent(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-scope",
		Name: "Issue Scope Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	service := testIssueService(store)
	issue, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID: "ws-issue-scope",
		TopicID:     workspaceissues.DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Scoped refs",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	task, err := service.CreateTask(ctx, workspaceissues.CreateTaskInput{
		WorkspaceID: "ws-issue-scope",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		Title:       "Task ref",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	issueRefs, err := service.AddContextRefs(ctx, workspaceissues.AddContextRefsInput{
		WorkspaceID: "ws-issue-scope",
		IssueID:     issue.IssueID,
		ParentKind:  string(workspaceissues.ContextRefParentIssue),
		Refs: []workspaceissues.AddContextRefInput{{
			ContextRefID: "issue-ref-1",
			RefType:      "file",
			Path:         "/workspace/docs/plan.md",
		}},
	})
	if err != nil {
		t.Fatalf("AddContextRefs() issue error = %v", err)
	}
	taskRefs, err := service.AddContextRefs(ctx, workspaceissues.AddContextRefsInput{
		WorkspaceID: "ws-issue-scope",
		IssueID:     issue.IssueID,
		TaskID:      task.TaskID,
		ParentKind:  string(workspaceissues.ContextRefParentTask),
		Refs: []workspaceissues.AddContextRefInput{{
			ContextRefID: "task-ref-1",
			RefType:      "file",
			Path:         "/workspace/docs/task.md",
		}},
	})
	if err != nil {
		t.Fatalf("AddContextRefs() task error = %v", err)
	}
	if len(issueRefs) != 1 || len(taskRefs) != 1 {
		t.Fatalf("issueRefs = %+v taskRefs = %+v", issueRefs, taskRefs)
	}

	removed, err := service.RemoveContextRef(ctx, workspaceissues.RemoveContextRefInput{
		WorkspaceID:  "ws-issue-scope",
		IssueID:      issue.IssueID,
		ParentKind:   string(workspaceissues.ContextRefParentIssue),
		ContextRefID: taskRefs[0].ContextRefID,
	})
	if !errors.Is(err, workspaceissues.ErrContextRefNotFound) {
		t.Fatalf("RemoveContextRef() error = %v, want ErrContextRefNotFound", err)
	}
	if removed {
		t.Fatal("RemoveContextRef() removed = true, want false")
	}

	removed, err = service.RemoveContextRef(ctx, workspaceissues.RemoveContextRefInput{
		WorkspaceID:  "ws-issue-scope",
		IssueID:      issue.IssueID,
		TaskID:       task.TaskID,
		ParentKind:   string(workspaceissues.ContextRefParentTask),
		ContextRefID: taskRefs[0].ContextRefID,
	})
	if err != nil {
		t.Fatalf("RemoveContextRef() task error = %v", err)
	}
	if !removed {
		t.Fatal("RemoveContextRef() task removed = false, want true")
	}

	issueDetail, err := service.GetIssueDetail(ctx, "ws-issue-scope", issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if len(issueDetail.ContextRefs) != 1 {
		t.Fatalf("issue context refs len = %d, want 1", len(issueDetail.ContextRefs))
	}

	taskDetail, err := service.GetTaskDetail(ctx, "ws-issue-scope", issue.IssueID, task.TaskID)
	if err != nil {
		t.Fatalf("GetTaskDetail() error = %v", err)
	}
	if len(taskDetail.ContextRefs) != 0 {
		t.Fatalf("task context refs len = %d, want 0", len(taskDetail.ContextRefs))
	}
}

func TestSQLiteIssueStoreDuplicateResourceIDsReturnTypedErrors(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-dup",
		Name: "Issue Duplicate Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	service := testIssueService(store)
	issue, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID: "ws-issue-dup",
		TopicID:     workspaceissues.DefaultTopicID,
		ActorUserID: "user-1",
		IssueID:     "issue-fixed",
		Title:       "Fixed issue id",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	if _, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID: "ws-issue-dup",
		TopicID:     workspaceissues.DefaultTopicID,
		ActorUserID: "user-1",
		IssueID:     "issue-fixed",
		Title:       "Duplicate issue id",
	}); !errors.Is(err, workspaceissues.ErrIssueAlreadyExists) {
		t.Fatalf("CreateIssue() duplicate error = %v, want ErrIssueAlreadyExists", err)
	}

	task, err := service.CreateTask(ctx, workspaceissues.CreateTaskInput{
		WorkspaceID: "ws-issue-dup",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		TaskID:      "task-fixed",
		Title:       "Fixed task id",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	if _, err := service.CreateTask(ctx, workspaceissues.CreateTaskInput{
		WorkspaceID: "ws-issue-dup",
		IssueID:     issue.IssueID,
		ActorUserID: "user-1",
		TaskID:      "task-fixed",
		Title:       "Duplicate task id",
	}); !errors.Is(err, workspaceissues.ErrTaskAlreadyExists) {
		t.Fatalf("CreateTask() duplicate error = %v, want ErrTaskAlreadyExists", err)
	}

	if _, err := service.AddContextRefs(ctx, workspaceissues.AddContextRefsInput{
		WorkspaceID: "ws-issue-dup",
		IssueID:     issue.IssueID,
		TaskID:      task.TaskID,
		ParentKind:  string(workspaceissues.ContextRefParentTask),
		Refs: []workspaceissues.AddContextRefInput{{
			ContextRefID: "ref-fixed",
			RefType:      "file",
			Path:         "/workspace/docs/ref.md",
		}},
	}); err != nil {
		t.Fatalf("AddContextRefs() error = %v", err)
	}
	if _, err := service.AddContextRefs(ctx, workspaceissues.AddContextRefsInput{
		WorkspaceID: "ws-issue-dup",
		IssueID:     issue.IssueID,
		TaskID:      task.TaskID,
		ParentKind:  string(workspaceissues.ContextRefParentTask),
		Refs: []workspaceissues.AddContextRefInput{{
			ContextRefID: "ref-fixed",
			RefType:      "file",
			Path:         "/workspace/docs/ref-again.md",
		}},
	}); !errors.Is(err, workspaceissues.ErrContextRefAlreadyExists) {
		t.Fatalf("AddContextRefs() duplicate error = %v, want ErrContextRefAlreadyExists", err)
	}

	if _, err := service.CreateRun(ctx, workspaceissues.CreateRunInput{
		WorkspaceID:   "ws-issue-dup",
		IssueID:       issue.IssueID,
		TaskID:        task.TaskID,
		ActorUserID:   "user-1",
		RunID:         "run-fixed",
		AgentProvider: "codex",
		AgentTargetID: "local:codex",
	}); err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}
	if _, err := service.CreateRun(ctx, workspaceissues.CreateRunInput{
		WorkspaceID:   "ws-issue-dup",
		IssueID:       issue.IssueID,
		TaskID:        task.TaskID,
		ActorUserID:   "user-1",
		RunID:         "run-fixed",
		AgentProvider: "codex",
		AgentTargetID: "local:codex",
	}); !errors.Is(err, workspaceissues.ErrRunAlreadyExists) {
		t.Fatalf("CreateRun() duplicate error = %v, want ErrRunAlreadyExists", err)
	}
}

func TestSQLiteIssueStoreRollsBackIssueWhenBatchTaskInsertFails(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-batch-rollback",
		Name: "Batch Rollback Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	service := testIssueService(store)
	_, _, err := service.CreateIssueWithTasks(ctx, workspaceissues.CreateIssueWithTasksInput{
		Issue: workspaceissues.CreateIssueInput{
			WorkspaceID:    "ws-issue-batch-rollback",
			TopicID:        workspaceissues.DefaultTopicID,
			ActorUserID:    "user-1",
			IssueID:        "issue-batch-rollback",
			Title:          "Atomic Plan issue",
			PlanningSource: string(workspaceissues.PlanningSourceTuttiModePlan),
		},
		Tasks: []workspaceissues.CreateTaskItemInput{
			{TaskID: "duplicate-task", Title: "First"},
			{TaskID: "duplicate-task", Title: "Second"},
		},
	})
	if !errors.Is(err, workspaceissues.ErrTaskAlreadyExists) {
		t.Fatalf("CreateIssueWithTasks() error = %v, want ErrTaskAlreadyExists", err)
	}
	if _, err := store.GetIssue(ctx, "ws-issue-batch-rollback", "issue-batch-rollback"); !errors.Is(err, workspaceissues.ErrIssueNotFound) {
		t.Fatalf("GetIssue() after rollback error = %v, want ErrIssueNotFound", err)
	}
}

func TestSQLiteIssueStoreRollsBackIssueWhenContextRefInsertFails(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "ws-issue-attachment-rollback"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Attachment rollback"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	service := testIssueService(store)
	_, _, err := service.CreateIssueWithContextRefs(ctx, workspaceissues.CreateIssueWithContextRefsInput{
		Issue: workspaceissues.CreateIssueInput{
			WorkspaceID: workspaceID,
			TopicID:     workspaceissues.DefaultTopicID,
			ActorUserID: "user-1",
			IssueID:     "issue-attachment-rollback",
			Title:       "Atomic attachment issue",
		},
		Refs: []workspaceissues.AddContextRefInput{
			{ContextRefID: "duplicate-ref", RefType: "image/png", Path: "/managed/first.png"},
			{ContextRefID: "duplicate-ref", RefType: "image/png", Path: "/managed/second.png"},
		},
	})
	if !errors.Is(err, workspaceissues.ErrContextRefAlreadyExists) {
		t.Fatalf("CreateIssueWithContextRefs() error = %v, want ErrContextRefAlreadyExists", err)
	}
	if _, err := store.GetIssue(ctx, workspaceID, "issue-attachment-rollback"); !errors.Is(err, workspaceissues.ErrIssueNotFound) {
		t.Fatalf("GetIssue() after rollback error = %v, want ErrIssueNotFound", err)
	}
}

func TestSQLiteIssueStoreRollsBackImplicitTaskWhenLaunchIntentAdmissionFails(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "ws-explicit-launch-admission-rollback"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Launch admission rollback"}); err != nil {
		t.Fatal(err)
	}
	service := testIssueService(store)
	issue, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID: workspaceID,
		TopicID:     workspaceissues.DefaultTopicID,
		ActorUserID: "user-1",
		Title:       "Atomic implicit task",
	})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := service.PrepareRun(ctx, workspaceissues.CreateRunInput{
		WorkspaceID:   workspaceID,
		IssueID:       issue.IssueID,
		ActorUserID:   "user-1",
		RunID:         "run-admission-rollback",
		AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !prepared.TaskIsNew {
		t.Fatal("PrepareRun() TaskIsNew = false, want true")
	}
	if _, err := store.writeDB.ExecContext(ctx, `
CREATE TRIGGER reject_explicit_launch_intent_admission
BEFORE INSERT ON workspace_issue_run_launch_intents
BEGIN
  SELECT RAISE(ABORT, 'injected launch intent admission failure');
END;
`); err != nil {
		t.Fatal(err)
	}

	if _, err := store.CreateIssueRunWithLaunchIntent(
		ctx,
		prepared,
		workspaceissues.IssueRunClientSubmitID(prepared.Run.RunID),
		`{}`,
	); err == nil {
		t.Fatal("CreateIssueRunWithLaunchIntent() error = nil, want injected rollback")
	}
	tasks, err := store.ListTasks(ctx, workspaceissues.TaskListFilter{
		WorkspaceID: workspaceID,
		IssueID:     issue.IssueID,
		ReturnAll:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks.Items) != 0 {
		t.Fatalf("tasks after rollback = %+v, want none", tasks.Items)
	}
	if _, err := store.GetRun(
		ctx,
		workspaceID,
		issue.IssueID,
		prepared.Task.TaskID,
		prepared.Run.RunID,
	); !errors.Is(err, workspaceissues.ErrRunNotFound) {
		t.Fatalf("GetRun() after rollback error = %v, want ErrRunNotFound", err)
	}
	detail, err := service.GetIssueDetail(ctx, workspaceID, issue.IssueID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Issue.TaskCount != 0 || detail.Issue.RunningCount != 0 {
		t.Fatalf("Issue projection after rollback = %+v", detail.Issue)
	}
}

func TestSQLiteIssueStoreSettlesExplicitLaunchAtomically(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "ws-explicit-launch-settlement"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Launch settlement"}); err != nil {
		t.Fatal(err)
	}
	service := testIssueService(store)
	issue, err := service.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID: workspaceID, TopicID: workspaceissues.DefaultTopicID,
		ActorUserID: "user-1", Title: "Atomic launch settlement",
	})
	if err != nil {
		t.Fatal(err)
	}
	task, err := service.CreateTask(ctx, workspaceissues.CreateTaskInput{
		WorkspaceID: workspaceID, IssueID: issue.IssueID,
		ActorUserID: "user-1", Title: "Launch", AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := service.PrepareRun(ctx, workspaceissues.CreateRunInput{
		WorkspaceID: workspaceID, IssueID: issue.IssueID, TaskID: task.TaskID,
		ActorUserID: "user-1", RunID: "run-atomic-settlement",
		AgentTargetID: "local:codex", AgentSessionID: "session-atomic-settlement",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateIssueRunWithLaunchIntent(
		ctx, prepared, "issue-run:run-atomic-settlement",
		`{"title":"Atomic launch settlement","prompt":"Original prompt"}`,
	); err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_700_000_200_000).UTC()
	claimed, err := store.ClaimIssueRunLaunchIntent(
		ctx, workspaceID, issue.IssueID, prepared.Run.RunID, "owner-1", now, now.Add(time.Minute),
	)
	if err != nil || !claimed {
		t.Fatalf("ClaimIssueRunLaunchIntent() claimed=%v error=%v", claimed, err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
CREATE TRIGGER reject_explicit_launch_task_settlement
BEFORE UPDATE ON workspace_issue_tasks
WHEN NEW.status = 'failed'
BEGIN
  SELECT RAISE(ABORT, 'injected explicit settlement failure');
END;
`); err != nil {
		t.Fatal(err)
	}
	settlement := workspaceissues.RunLaunchSettlement{
		WorkspaceID: workspaceID, IssueID: issue.IssueID, RunID: prepared.Run.RunID,
		LeaseOwner: "owner-1", Status: workspaceissues.StatusFailed,
		ErrorMessage: "definite pre-delivery failure", NowUnixMS: now.Add(time.Second).UnixMilli(),
	}
	if _, err := store.SettleIssueRunLaunch(ctx, settlement); err == nil {
		t.Fatal("SettleIssueRunLaunch() error = nil, want injected rollback")
	}
	run, err := store.GetRun(ctx, workspaceID, issue.IssueID, task.TaskID, prepared.Run.RunID)
	if err != nil || run.Status != workspaceissues.StatusRunning {
		t.Fatalf("Run after rollback = %#v, error = %v", run, err)
	}
	if err := store.RequeueLeasedIssueRunLaunchIntents(ctx, workspaceID, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	launches, err := store.ListPreparedIssueRunLaunches(ctx, workspaceID)
	if err != nil || len(launches) != 1 {
		t.Fatalf("prepared launches after rollback = %#v, error = %v", launches, err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `DROP TRIGGER reject_explicit_launch_task_settlement`); err != nil {
		t.Fatal(err)
	}
	claimed, err = store.ClaimIssueRunLaunchIntent(
		ctx, workspaceID, issue.IssueID, prepared.Run.RunID, "owner-2",
		now.Add(2*time.Minute), now.Add(3*time.Minute),
	)
	if err != nil || !claimed {
		t.Fatalf("ClaimIssueRunLaunchIntent(retry) claimed=%v error=%v", claimed, err)
	}
	settlement.LeaseOwner = "owner-2"
	settled, err := store.SettleIssueRunLaunch(ctx, settlement)
	if err != nil || settled.Status != workspaceissues.StatusFailed {
		t.Fatalf("SettleIssueRunLaunch(retry) Run=%#v error=%v", settled, err)
	}
	task, err = store.GetTask(ctx, workspaceID, issue.IssueID, task.TaskID)
	if err != nil || task.Status != workspaceissues.StatusFailed {
		t.Fatalf("Task after settlement = %#v, error = %v", task, err)
	}
}

func testIssueService(store workspaceissues.Store) workspaceissues.Service {
	counters := map[workspaceissues.IDKind]int{}
	return workspaceissues.Service{
		Clock: func() time.Time {
			return time.UnixMilli(1_700_000_000_000)
		},
		IDGenerator: func(kind workspaceissues.IDKind) string {
			counters[kind]++
			return string(kind) + "-" + strconv.Itoa(counters[kind])
		},
		Store: store,
	}
}
