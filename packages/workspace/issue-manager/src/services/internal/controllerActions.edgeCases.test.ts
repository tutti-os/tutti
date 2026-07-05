import assert from "node:assert/strict";
import test from "node:test";
import {
  createControllerActionsHarness,
  createIssueContextRef,
  createIssueSummary,
  createTaskSummary,
  installConfirm,
  installNavigatorValue
} from "./controllerActionTestHarness.ts";

test("controller actions skip attachReferences when task selection is missing", async () => {
  let requestCount = 0;
  const harness = createControllerActionsHarness({
    fileAdapter: {
      async requestReferences() {
        requestCount += 1;
        return [];
      }
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: "issue-1",
      selectedTaskId: null
    }
  });

  await harness.actions.attachReferences("task");

  assert.equal(requestCount, 0);
  assert.equal(harness.referenceTargetState.current, null);
  assert.equal(harness.refreshDetailsCount, 0);
});

test("controller actions skip insertReferences when no file adapter exists", async () => {
  const harness = createControllerActionsHarness({
    issueDraft: {
      content: "Issue draft",
      title: "Issue"
    }
  });

  await harness.actions.insertReferences("issue");

  assert.equal(harness.issueDraftState.current.content, "Issue draft");
  assert.equal(harness.referenceTargetState.current, null);
});

test("controller actions stop deleteIssue when confirmation is rejected", async (t) => {
  let deleteCalls = 0;
  const restoreConfirm = installConfirm(() => false);
  t.after(restoreConfirm);
  const harness = createControllerActionsHarness({
    backend: {
      async deleteIssue() {
        deleteCalls += 1;
        return { removed: true };
      }
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    }
  });

  await harness.actions.deleteIssue();

  assert.equal(deleteCalls, 0);
  assert.equal(harness.notificationState.current, null);
  assert.equal(harness.refreshAllCount, 0);
  assert.equal(harness.nodeState.current.selectedIssueId, "issue-1");
  assert.equal(harness.nodeState.current.selectedTaskId, "task-1");
});

test("controller actions stop deleteTask when confirmation is rejected", async (t) => {
  let deleteCalls = 0;
  const restoreConfirm = installConfirm(() => false);
  t.after(restoreConfirm);
  const harness = createControllerActionsHarness({
    backend: {
      async deleteTask() {
        deleteCalls += 1;
        return { removed: true };
      }
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    }
  });

  await harness.actions.deleteTask();

  assert.equal(deleteCalls, 0);
  assert.equal(harness.notificationState.current, null);
  assert.equal(harness.refreshDetailsCount, 0);
  assert.equal(harness.nodeState.current.selectedTaskId, "task-1");
});

test("controller actions localize removeContextRef errors", async () => {
  const harness = createControllerActionsHarness({
    backend: {
      async removeContextRef() {
        throw new Error("issue_manager.workspace_path_unavailable");
      }
    }
  });

  await harness.actions.removeContextRef(
    createIssueContextRef({
      path: "/workspace/docs/spec.md"
    })
  );

  assert.equal(
    harness.notificationState.current,
    "messages.workspacePathUnavailable"
  );
  assert.equal(harness.refreshDetailsCount, 0);
});

test("controller actions surface clipboard unavailable errors", async (t) => {
  const restoreNavigator = installNavigatorValue({});
  t.after(restoreNavigator);
  const harness = createControllerActionsHarness({
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    },
    shareAdapter: {
      async createIssueLink() {
        return "tutti://workspace/workspace-1/issues/issue-1/tasks/task-1";
      }
    }
  });

  await harness.actions.shareSelection();

  assert.equal(
    harness.notificationState.current,
    "messages.clipboardUnavailable"
  );
});

test("controller actions show a validation tip when the issue title is missing", async () => {
  let createIssueCalls = 0;
  const issueHarness = createControllerActionsHarness({
    backend: {
      async createIssue() {
        createIssueCalls += 1;
        return createIssueSummary({
          issueId: "issue-2",
          title: "Created"
        });
      }
    },
    issueDraft: {
      content: "Issue body",
      title: "   "
    },
    issueEditorMode: "create"
  });

  await issueHarness.actions.saveIssue();

  assert.equal(createIssueCalls, 0);
  assert.equal(
    issueHarness.notificationState.current,
    "messages.titleRequired"
  );
  assert.equal(issueHarness.refreshAllCount, 0);
});

test("controller actions skip saveTask when the selected issue is missing", async () => {
  let createTaskCalls = 0;
  const taskHarness = createControllerActionsHarness({
    backend: {
      async createTask() {
        createTaskCalls += 1;
        return createTaskSummary({
          issueId: "issue-1",
          taskId: "task-2",
          title: "Created task"
        });
      }
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: null,
      selectedTaskId: null
    },
    taskDraft: {
      content: "Task body",
      priority: "high",
      title: "Task title"
    },
    taskEditorMode: "create"
  });

  await taskHarness.actions.saveTask();

  assert.equal(createTaskCalls, 0);
  assert.equal(taskHarness.notificationState.current, null);
  assert.equal(taskHarness.refreshDetailsCount, 0);
});

test("controller actions show a validation tip when the task title is missing", async () => {
  let createTaskCalls = 0;
  const taskHarness = createControllerActionsHarness({
    backend: {
      async createTask() {
        createTaskCalls += 1;
        return createTaskSummary({
          issueId: "issue-1",
          taskId: "task-2",
          title: "Created task"
        });
      }
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: "issue-1",
      selectedTaskId: null
    },
    taskDraft: {
      content: "Task body",
      priority: "high",
      title: "   "
    },
    taskEditorMode: "create"
  });

  await taskHarness.actions.saveTask();

  assert.equal(createTaskCalls, 0);
  assert.equal(taskHarness.notificationState.current, "messages.titleRequired");
  assert.equal(taskHarness.refreshDetailsCount, 0);
});

test("controller actions skip runTask when issue detail is missing", async () => {
  let runnerCalls = 0;
  const harness = createControllerActionsHarness({
    agentRunner: {
      async runTask() {
        runnerCalls += 1;
        return {
          status: "completed"
        };
      }
    },
    issueDetail: null,
    taskDetail: null
  });

  await harness.actions.runTask();

  assert.equal(runnerCalls, 0);
  assert.deepEqual(harness.isRunningTaskState.history, []);
  assert.equal(harness.notificationState.current, null);
  assert.equal(harness.refreshDetailsCount, 0);
});
