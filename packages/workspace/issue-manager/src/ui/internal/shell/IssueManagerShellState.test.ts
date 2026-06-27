import assert from "node:assert/strict";
import test from "node:test";
import type {
  IssueManagerIssueSummary,
  IssueManagerTaskSummary
} from "../../../contracts/index.ts";
import type { IssueManagerI18nRuntime } from "../../../i18n/issueManagerI18n.ts";
import {
  buildIssueManagerStatusCounts,
  resolveIssueManagerStatusCounts,
  resolveIssueManagerShellContentViewState,
  resolveIssueManagerSubtaskProgress,
  resolveIssueManagerSubtaskProgressByIssueId,
  resolveIssueManagerSubtaskProgressFromTasks,
  resolveIssueManagerSidebarViewState
} from "./IssueManagerShellState.ts";

test("sidebar view state prefers loading when the first list request is in flight", () => {
  assert.deepEqual(
    resolveIssueManagerSidebarViewState({
      copy: createCopy(),
      issues: {
        error: null,
        isLoading: true,
        value: []
      }
    }),
    {
      kind: "loading"
    }
  );
});

test("sidebar view state keeps empty state while a resolved list refreshes", () => {
  assert.deepEqual(
    resolveIssueManagerSidebarViewState({
      copy: createCopy(),
      issues: {
        error: null,
        hasResolved: true,
        isLoading: true,
        value: []
      }
    }),
    {
      body: "messages.noIssuesForFilterBody",
      kind: "empty",
      title: "messages.noIssuesForFilterTitle"
    }
  );
});

test("sidebar view state prefers error over empty when the request fails", () => {
  assert.deepEqual(
    resolveIssueManagerSidebarViewState({
      copy: createCopy(),
      issues: {
        error: "Workspace issues request failed.",
        isLoading: false,
        value: []
      }
    }),
    {
      kind: "error",
      retryLabel: "actions.refresh",
      title: "messages.issueRefreshFailed"
    }
  );
});

test("sidebar view state falls back to empty only when there is no error", () => {
  assert.deepEqual(
    resolveIssueManagerSidebarViewState({
      copy: createCopy(),
      issues: {
        error: null,
        isLoading: false,
        value: []
      }
    }),
    {
      body: "messages.noIssuesForFilterBody",
      kind: "empty",
      title: "messages.noIssuesForFilterTitle"
    }
  );
});

test("sidebar view state keeps rendered issues when data is available", () => {
  const issues = [
    createIssueSummary({
      issueId: "issue-1",
      title: "Plan migration"
    })
  ];

  assert.deepEqual(
    resolveIssueManagerSidebarViewState({
      copy: createCopy(),
      issues: {
        error: null,
        isLoading: false,
        value: issues
      }
    }),
    {
      issues,
      kind: "list"
    }
  );
});

test("buildIssueManagerStatusCounts includes all issues and status buckets", () => {
  const issues = [
    createIssueSummary({
      issueId: "issue-1",
      status: "running",
      title: "Plan migration"
    }),
    createIssueSummary({
      issueId: "issue-2",
      status: "completed",
      title: "Port renderer"
    })
  ];

  assert.deepEqual(buildIssueManagerStatusCounts(issues), {
    all: 2,
    canceled: 0,
    completed: 1,
    failed: 0,
    not_started: 0,
    pending_acceptance: 0,
    running: 1
  });
});

test("resolveIssueManagerStatusCounts prefers backend totals over current filtered issues", () => {
  assert.deepEqual(
    resolveIssueManagerStatusCounts({
      error: null,
      isLoading: false,
      statusCounts: {
        all: 2,
        canceled: 0,
        completed: 0,
        failed: 0,
        notStarted: 2,
        pendingAcceptance: 0,
        running: 0
      },
      value: []
    }),
    {
      all: 2,
      canceled: 0,
      completed: 0,
      failed: 0,
      not_started: 2,
      pending_acceptance: 0,
      running: 0
    }
  );
});

test("subtask progress is hidden when an issue has no subtasks", () => {
  assert.equal(
    resolveIssueManagerSubtaskProgress(
      createIssueSummary({ issueId: "issue-1", taskCount: 0 })
    ),
    null
  );
});

test("subtask progress clamps completed count to the available total", () => {
  assert.deepEqual(
    resolveIssueManagerSubtaskProgress(
      createIssueSummary({
        completedCount: 9,
        issueId: "issue-1",
        taskCount: 7
      })
    ),
    {
      completed: 7,
      percent: 100,
      total: 7
    }
  );
});

test("subtask progress uses completed subtasks over total subtasks", () => {
  assert.deepEqual(
    resolveIssueManagerSubtaskProgress(
      createIssueSummary({
        completedCount: 2,
        issueId: "issue-1",
        taskCount: 7
      })
    ),
    {
      completed: 2,
      percent: 28.57142857142857,
      total: 7
    }
  );
});

test("subtask progress from visible tasks is hidden when all subtasks are filtered out", () => {
  assert.equal(resolveIssueManagerSubtaskProgressFromTasks([]), null);
});

test("subtask progress from visible tasks counts review-ready subtasks as completed", () => {
  assert.deepEqual(
    resolveIssueManagerSubtaskProgressFromTasks([
      createTaskSummary({ status: "completed", taskId: "task-1" }),
      createTaskSummary({ status: "pending_acceptance", taskId: "task-2" }),
      createTaskSummary({ status: "running", taskId: "task-3" })
    ]),
    {
      completed: 2,
      percent: 66.66666666666666,
      total: 3
    }
  );
});

test("subtask progress override hides summary progress when visible subtasks are empty", () => {
  assert.deepEqual(
    resolveIssueManagerSubtaskProgressByIssueId({
      issueId: "issue-1",
      visibleTasks: []
    }),
    {
      "issue-1": null
    }
  );
});

test("subtask progress override is omitted when no issue detail is available", () => {
  assert.deepEqual(
    resolveIssueManagerSubtaskProgressByIssueId({
      issueId: null,
      visibleTasks: null
    }),
    {}
  );
});

test("shell content view state prefers issue editing over task flows", () => {
  assert.deepEqual(
    resolveIssueManagerShellContentViewState({
      issueEditorMode: "edit",
      selectedIssue: createIssueSummary({
        issueId: "issue-1",
        title: "Plan migration"
      }),
      selectedTaskPresent: true,
      taskEditorMode: "edit"
    }),
    {
      isIssueEditing: true,
      isTaskCreating: false,
      isTaskDrawerOpen: false,
      showBottomBar: false
    }
  );
});

test("shell content view state opens the task drawer for selected tasks in read mode", () => {
  assert.deepEqual(
    resolveIssueManagerShellContentViewState({
      issueEditorMode: "read",
      selectedIssue: createIssueSummary({
        issueId: "issue-1",
        title: "Plan migration"
      }),
      selectedTaskPresent: true,
      taskEditorMode: "read"
    }),
    {
      isIssueEditing: false,
      isTaskCreating: false,
      isTaskDrawerOpen: true,
      showBottomBar: true
    }
  );
});

test("shell content view state keeps the bottom bar while editing a selected task", () => {
  assert.deepEqual(
    resolveIssueManagerShellContentViewState({
      issueEditorMode: "read",
      selectedIssue: createIssueSummary({
        issueId: "issue-1",
        title: "Plan migration"
      }),
      selectedTaskPresent: true,
      taskEditorMode: "edit"
    }),
    {
      isIssueEditing: false,
      isTaskCreating: false,
      isTaskDrawerOpen: true,
      showBottomBar: true
    }
  );
});

function createCopy(): IssueManagerI18nRuntime {
  return {
    t(key: string) {
      return key;
    }
  } as IssueManagerI18nRuntime;
}

function createIssueSummary(
  input: Pick<IssueManagerIssueSummary, "issueId"> &
    Partial<Pick<IssueManagerIssueSummary, "title">> &
    Partial<
      Pick<IssueManagerIssueSummary, "completedCount" | "status" | "taskCount">
    >
): IssueManagerIssueSummary {
  return {
    completedCount: input.completedCount,
    creatorUserId: "local",
    issueId: input.issueId,
    status: input.status ?? "not_started",
    taskCount: input.taskCount,
    title: input.title ?? "Task",
    topicId: "topic-1",
    workspaceId: "workspace-1"
  };
}

function createTaskSummary(
  input: Pick<IssueManagerTaskSummary, "status" | "taskId">
): IssueManagerTaskSummary {
  return {
    creatorUserId: "local",
    issueId: "issue-1",
    priority: "medium",
    status: input.status,
    taskId: input.taskId,
    title: "Task",
    workspaceId: "workspace-1"
  };
}
