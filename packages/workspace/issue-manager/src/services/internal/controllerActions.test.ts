import assert from "node:assert/strict";
import test from "node:test";
import type {
  IssueManagerAddContextRefsInput,
  IssueManagerAgentBreakdownRequest,
  IssueManagerAgentSessionOpenInput,
  IssueManagerAnalyticsEvent,
  IssueManagerCreateIssueInput,
  IssueManagerAgentRunRequest,
  IssueManagerRemoveContextRefInput,
  IssueManagerUpdateIssueInput,
  IssueManagerUpdateTaskInput
} from "../../contracts/index.ts";
import {
  createControllerActionsHarness,
  createIssueDetail,
  createIssueContextRef,
  createIssueSummary,
  createRun,
  createTaskContextRef,
  createTaskSummary,
  installConfirm,
  installNavigatorClipboard
} from "./controllerActionTestHarness.ts";

test("controller actions insert references into the issue draft and clear the picker target", async () => {
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const harness = createControllerActionsHarness({
    analytics: {
      track(event) {
        analyticsEvents.push(event);
      }
    },
    issueDraft: {
      content: "Existing note",
      title: "Plan migration"
    },
    referenceTarget: {
      mode: "insert",
      parentKind: "issue"
    }
  });

  await harness.actions.submitReferenceSelection([
    {
      displayName: "README.md",
      kind: "file",
      path: "/workspace/docs/README.md"
    }
  ]);

  assert.equal(
    harness.issueDraftState.current.content,
    "Existing note [README.md](/workspace/docs/README.md)"
  );
  assert.equal(harness.referenceTargetState.current, null);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.context_ref_added",
      params: {
        refType: "file",
        targetType: "issue"
      }
    }
  ]);
});

test("controller actions attach task references through requestReferences and refresh details", async () => {
  const addContextRefsCalls: IssueManagerAddContextRefsInput[] = [];
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const harness = createControllerActionsHarness({
    analytics: {
      track(event) {
        analyticsEvents.push(event);
      }
    },
    backend: {
      async addContextRefs(input) {
        addContextRefsCalls.push(input);
        return [];
      }
    },
    fileAdapter: {
      async requestReferences() {
        return [
          {
            displayName: "docs",
            kind: "folder",
            path: "/workspace/docs"
          },
          {
            displayName: "spec.md",
            kind: "file",
            path: "/workspace/spec.md"
          },
          {
            displayName: "ignored",
            kind: "file",
            path: "   "
          }
        ];
      }
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-9"
    }
  });

  await harness.actions.attachReferences("task");

  assert.deepEqual(addContextRefsCalls, [
    {
      issueId: "issue-1",
      parentKind: "task",
      refs: [
        {
          displayName: "docs",
          path: "/workspace/docs",
          refType: "folder"
        },
        {
          displayName: "spec.md",
          path: "/workspace/spec.md",
          refType: "file"
        }
      ],
      taskId: "task-9",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.context_ref_added",
      params: {
        refType: "directory",
        targetType: "task"
      }
    },
    {
      name: "issue_manager.context_ref_added",
      params: {
        refType: "file",
        targetType: "task"
      }
    }
  ]);
  assert.equal(harness.referenceTargetState.current, null);
  assert.equal(harness.refreshDetailsCount, 1);
});

test("controller actions open the reference picker when the adapter supports browsing", async () => {
  const harness = createControllerActionsHarness({
    fileAdapter: {
      async listDirectory() {
        return {
          directoryPath: "/workspace",
          entries: []
        };
      }
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    }
  });

  await harness.actions.attachReferences("task");

  assert.deepEqual(harness.referenceTargetState.current, {
    mode: "attach",
    parentKind: "task",
    taskId: "task-1"
  });
  assert.equal(harness.refreshDetailsCount, 0);
});

test("controller actions create task drafts from snapshot node state", () => {
  const harness = createControllerActionsHarness({
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1",
      taskDraftContent: "Resume task body",
      taskDraftTitle: "Resume task"
    },
    taskDraft: {
      content: "",
      priority: "low",
      title: ""
    }
  });

  harness.actions.createTaskDraft();

  assert.equal(harness.taskEditorModeState.current, "create");
  assert.deepEqual(harness.taskDraftState.current, {
    content: "Resume task body",
    priority: "medium",
    title: "Resume task"
  });
  assert.equal(harness.nodeState.current.selectedTaskId, null);
});

test("controller actions save created issues and sync extracted issue references", async () => {
  const createIssueCalls: IssueManagerCreateIssueInput[] = [];
  const addContextRefsCalls: IssueManagerAddContextRefsInput[] = [];
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const harness = createControllerActionsHarness({
    analytics: {
      track(event) {
        analyticsEvents.push(event);
      }
    },
    backend: {
      async addContextRefs(input) {
        addContextRefsCalls.push(input);
        return [];
      },
      async createIssue(input) {
        createIssueCalls.push(input);
        return createIssueSummary({
          issueId: "issue-2",
          title: "Plan migration"
        });
      }
    },
    issueDraft: {
      content: "Review [spec](/workspace/docs/spec.md)",
      title: "Plan migration"
    },
    issueEditorMode: "create"
  });

  await harness.actions.saveIssue();

  assert.deepEqual(createIssueCalls, [
    {
      content: "Review [spec](/workspace/docs/spec.md)",
      title: "Plan migration",
      topicId: "topic-1",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(addContextRefsCalls, [
    {
      issueId: "issue-2",
      parentKind: "issue",
      refs: [
        {
          displayName: "spec",
          path: "/workspace/docs/spec.md",
          refType: "file"
        }
      ],
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.issue_created",
      params: {
        issueId: "issue-2"
      }
    }
  ]);
  assert.equal(harness.issueEditorModeState.current, "read");
  assert.equal(harness.notificationState.current, null);
  assert.deepEqual(harness.nodeState.current, {
    issueDraftContent: null,
    issueDraftTitle: null,
    issueSearchQuery: "",
    issueStatusFilter: "all",
    selectedAgentProvider: "codex",
    selectedIssueId: "issue-2",
    selectedTaskId: null
  });
  assert.equal(harness.refreshAllCount, 1);
});

test("controller actions save edited issues without reporting created", async () => {
  const updateIssueCalls: IssueManagerUpdateIssueInput[] = [];
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const harness = createControllerActionsHarness({
    analytics: {
      track(event) {
        analyticsEvents.push(event);
      }
    },
    backend: {
      async updateIssue(input) {
        updateIssueCalls.push(input);
        return createIssueSummary({
          issueId: "issue-1",
          title: "Updated issue"
        });
      }
    },
    issueDetail: createIssueDetail(),
    issueDraft: {
      content: "Updated issue body",
      title: "Updated issue"
    },
    issueEditorMode: "edit",
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: null
    }
  });

  await harness.actions.saveIssue();

  assert.deepEqual(updateIssueCalls, [
    {
      content: "Updated issue body",
      issueId: "issue-1",
      title: "Updated issue",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.issue_saved",
      params: {
        contextRefCount: 0,
        hasDescription: true,
        issueId: "issue-1",
        taskCount: 0
      }
    }
  ]);
});

test("controller actions save edited issues removes stale content references without reporting delayed removals", async () => {
  const removeCalls: IssueManagerRemoveContextRefInput[] = [];
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const harness = createControllerActionsHarness({
    analytics: {
      track(event) {
        analyticsEvents.push(event);
      }
    },
    backend: {
      async removeContextRef(input) {
        removeCalls.push(input);
        return { removed: true };
      }
    },
    issueDetail: {
      ...createIssueDetail(),
      contextRefs: [
        createIssueContextRef({
          path: "/workspace/docs/keep.md"
        }),
        createIssueContextRef({
          path: "/workspace/docs/remove.md"
        })
      ],
      issue: createIssueSummary({
        content:
          "[keep](/workspace/docs/keep.md)\n\n[remove](/workspace/docs/remove.md)",
        issueId: "issue-1",
        title: "Updated issue"
      })
    },
    issueDraft: {
      content: "[keep](/workspace/docs/keep.md)",
      title: "Updated issue"
    },
    issueEditorMode: "edit",
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: null
    }
  });

  await harness.actions.saveIssue();

  assert.deepEqual(removeCalls, [
    {
      contextRefId: "issue:/workspace/docs/remove.md",
      issueId: "issue-1",
      parentKind: "issue",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.issue_saved",
      params: {
        contextRefCount: 1,
        hasDescription: true,
        issueId: "issue-1",
        taskCount: 0
      }
    }
  ]);
});

test("controller actions delete selected issues after confirmation", async (t) => {
  const deleteIssueCalls: Array<{ issueId: string; workspaceId: string }> = [];
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const restoreConfirm = installConfirm(() => true);
  t.after(restoreConfirm);
  const harness = createControllerActionsHarness({
    analytics: {
      track(event) {
        analyticsEvents.push(event);
      }
    },
    backend: {
      async deleteIssue(input) {
        deleteIssueCalls.push(input);
        return { removed: true };
      }
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    }
  });

  await harness.actions.deleteIssue();

  assert.deepEqual(deleteIssueCalls, [
    {
      issueId: "issue-1",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.issue_deleted",
      params: { issueId: "issue-1" }
    }
  ]);
  assert.equal(harness.notificationState.current, null);
  assert.deepEqual(harness.nodeState.current, {
    issueSearchQuery: "",
    issueStatusFilter: "all",
    selectedAgentProvider: "codex",
    selectedIssueId: null,
    selectedTaskId: null
  });
  assert.equal(harness.refreshAllCount, 1);
});

test("controller actions delete selected tasks after confirmation", async (t) => {
  const deleteTaskCalls: Array<{
    issueId: string;
    taskId: string;
    workspaceId: string;
  }> = [];
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const restoreConfirm = installConfirm(() => true);
  t.after(restoreConfirm);
  const harness = createControllerActionsHarness({
    analytics: {
      track(event) {
        analyticsEvents.push(event);
      }
    },
    backend: {
      async deleteTask(input) {
        deleteTaskCalls.push(input);
        return { removed: true };
      }
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-7"
    }
  });

  await harness.actions.deleteTask();

  assert.deepEqual(deleteTaskCalls, [
    {
      issueId: "issue-1",
      taskId: "task-7",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.task_deleted",
      params: {
        issueId: "issue-1",
        taskId: "task-7"
      }
    }
  ]);
  assert.equal(harness.notificationState.current, null);
  assert.deepEqual(harness.nodeState.current, {
    issueSearchQuery: "",
    issueStatusFilter: "all",
    selectedAgentProvider: "codex",
    selectedIssueId: "issue-1",
    selectedTaskId: null
  });
  assert.equal(harness.refreshAllCount, 1);
});

test("controller actions save edited tasks and only attach missing task references", async () => {
  const updateTaskCalls: IssueManagerUpdateTaskInput[] = [];
  const addContextRefsCalls: IssueManagerAddContextRefsInput[] = [];
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const harness = createControllerActionsHarness({
    analytics: {
      track(event) {
        analyticsEvents.push(event);
      }
    },
    backend: {
      async addContextRefs(input) {
        addContextRefsCalls.push(input);
        return [];
      },
      async updateTask(input) {
        updateTaskCalls.push(input);
        return createTaskSummary({
          issueId: "issue-1",
          priority: "high",
          status: "running",
          taskId: "task-1",
          title: "Port renderer"
        });
      }
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    },
    taskDetail: {
      contextRefs: [
        createTaskContextRef({
          path: "/workspace/docs/spec.md",
          taskId: "task-1"
        })
      ],
      latestOutputs: [],
      recentRuns: [],
      task: createTaskSummary({
        issueId: "issue-1",
        priority: "high",
        status: "running",
        taskId: "task-1",
        title: "Port renderer"
      })
    },
    taskDraft: {
      content:
        "[spec](/workspace/docs/spec.md)\n\n[design](/workspace/docs/design.md)",
      priority: "high",
      title: "Port renderer"
    },
    taskEditorMode: "edit"
  });

  await harness.actions.saveTask();

  assert.deepEqual(updateTaskCalls, [
    {
      content:
        "[spec](/workspace/docs/spec.md)\n\n[design](/workspace/docs/design.md)",
      issueId: "issue-1",
      priority: "high",
      taskId: "task-1",
      title: "Port renderer",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(addContextRefsCalls, [
    {
      issueId: "issue-1",
      parentKind: "task",
      refs: [
        {
          displayName: "design",
          path: "/workspace/docs/design.md",
          refType: "file"
        }
      ],
      taskId: "task-1",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(harness.taskEditorModeState.current, "read");
  assert.equal(harness.notificationState.current, null);
  assert.equal(harness.nodeState.current.selectedTaskId, "task-1");
  assert.equal(harness.nodeState.current.taskDraftContent, null);
  assert.equal(harness.nodeState.current.taskDraftTitle, null);
  assert.equal(harness.refreshAllCount, 1);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.task_saved",
      params: {
        contextRefCount: 2,
        hasDescription: true,
        issueId: "issue-1",
        taskId: "task-1"
      }
    }
  ]);
});

test("controller actions save edited tasks removes stale content references without reporting delayed removals", async () => {
  const removeCalls: IssueManagerRemoveContextRefInput[] = [];
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const harness = createControllerActionsHarness({
    analytics: {
      track(event) {
        analyticsEvents.push(event);
      }
    },
    backend: {
      async removeContextRef(input) {
        removeCalls.push(input);
        return { removed: true };
      }
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    },
    taskDetail: {
      contextRefs: [
        createTaskContextRef({
          path: "/workspace/docs/keep.md",
          taskId: "task-1"
        }),
        createTaskContextRef({
          path: "/workspace/docs/remove.md",
          taskId: "task-1"
        })
      ],
      latestOutputs: [],
      recentRuns: [],
      task: createTaskSummary({
        content:
          "[keep](/workspace/docs/keep.md)\n\n[remove](/workspace/docs/remove.md)",
        issueId: "issue-1",
        priority: "medium",
        taskId: "task-1",
        title: "Port renderer"
      })
    },
    taskDraft: {
      content: "[keep](/workspace/docs/keep.md)",
      priority: "medium",
      title: "Port renderer"
    },
    taskEditorMode: "edit"
  });

  await harness.actions.saveTask();

  assert.deepEqual(removeCalls, [
    {
      contextRefId: "task-1:/workspace/docs/remove.md",
      issueId: "issue-1",
      parentKind: "task",
      taskId: "task-1",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.task_saved",
      params: {
        contextRefCount: 1,
        hasDescription: true,
        issueId: "issue-1",
        taskId: "task-1"
      }
    }
  ]);
});

test("controller actions remove issue and task context refs with canonical payloads", async () => {
  const removeCalls: IssueManagerRemoveContextRefInput[] = [];
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const harness = createControllerActionsHarness({
    analytics: {
      track(event) {
        analyticsEvents.push(event);
      }
    },
    backend: {
      async removeContextRef(input) {
        removeCalls.push(input);
        return { removed: true };
      }
    }
  });

  await harness.actions.removeContextRef(
    createIssueContextRef({
      path: "/workspace/docs/spec.md"
    })
  );
  await harness.actions.removeContextRef(
    createTaskContextRef({
      path: "/workspace/docs/design.md",
      taskId: "task-3"
    })
  );

  assert.deepEqual(removeCalls, [
    {
      contextRefId: "issue:/workspace/docs/spec.md",
      issueId: "issue-1",
      parentKind: "issue",
      workspaceId: "workspace-1"
    },
    {
      contextRefId: "task-3:/workspace/docs/design.md",
      issueId: "issue-1",
      parentKind: "task",
      taskId: "task-3",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(harness.refreshDetailsCount, 2);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.context_ref_removed",
      params: { targetType: "issue" }
    },
    {
      name: "issue_manager.context_ref_removed",
      params: { targetType: "task" }
    }
  ]);
});

test("controller actions open references through the file adapter when available", async () => {
  const openCalls: Array<{
    displayName?: string;
    kind: string;
    path: string;
  }> = [];
  const harness = createControllerActionsHarness({
    fileAdapter: {
      async openReference(reference) {
        openCalls.push(reference);
      }
    }
  });

  await harness.actions.openReference({
    displayName: "README.md",
    kind: "file",
    path: "/workspace/docs/README.md"
  });

  assert.deepEqual(openCalls, [
    {
      displayName: "README.md",
      kind: "file",
      path: "/workspace/docs/README.md"
    }
  ]);
});

test("controller actions open agent sessions from issue runs", async () => {
  const openCalls: IssueManagerAgentSessionOpenInput[] = [];
  const harness = createControllerActionsHarness({
    agentSessionOpener: {
      openSession(input) {
        openCalls.push(input);
      }
    }
  });

  await harness.actions.openAgentSession(
    createRun({
      agentProvider: "codex",
      agentSessionId: " 11111111-1111-4111-8111-111111111111 ",
      issueId: "issue-1",
      runId: "run-1",
      status: "completed"
    })
  );

  assert.deepEqual(openCalls, [
    {
      agentSessionId: "11111111-1111-4111-8111-111111111111",
      provider: "codex",
      workspaceId: "workspace-1"
    }
  ]);
});

test("controller actions ignore runs without agent session ids", async () => {
  const openCalls: IssueManagerAgentSessionOpenInput[] = [];
  const harness = createControllerActionsHarness({
    agentSessionOpener: {
      openSession(input) {
        openCalls.push(input);
      }
    }
  });

  await harness.actions.openAgentSession(
    createRun({
      agentSessionId: "   ",
      issueId: "issue-1",
      runId: "run-1",
      status: "completed"
    })
  );

  assert.deepEqual(openCalls, []);
});

test("controller actions update an issue-level execution task status without selecting it", async () => {
  const updateTaskCalls: IssueManagerUpdateTaskInput[] = [];
  const harness = createControllerActionsHarness({
    backend: {
      async updateTask(input) {
        updateTaskCalls.push(input);
        return createTaskSummary({
          issueId: input.issueId,
          status: input.status,
          taskId: input.taskId,
          title: ""
        });
      }
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: null
    }
  });

  await harness.actions.setTaskStatus("task-acceptance", "completed");

  assert.deepEqual(updateTaskCalls, [
    {
      issueId: "issue-1",
      status: "completed",
      taskId: "task-acceptance",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(harness.nodeState.current.selectedTaskId, null);
});

test("controller actions run selected task through task-scoped handoff", async () => {
  const runnerCalls: IssueManagerAgentRunRequest[] = [];
  const createRunCalls: unknown[] = [];
  const completeRunCalls: unknown[] = [];
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const issue = createIssueSummary({
    content: "Issue content",
    issueId: "issue-1",
    status: "running",
    title: "Plan migration"
  });
  const task = createTaskSummary({
    content: "Task content",
    issueId: "issue-1",
    priority: "high",
    status: "not_started",
    taskId: "task-1",
    title: "Port renderer"
  });
  const harness = createControllerActionsHarness({
    analytics: {
      track(event) {
        analyticsEvents.push(event);
      }
    },
    agentRunner: {
      async runTask(input) {
        runnerCalls.push(input);
        return {
          status: "opened"
        };
      }
    },
    backend: {
      async completeRun(input) {
        completeRunCalls.push(input);
        return {
          outputs: [],
          run: createRun({
            issueId: input.issueId,
            runId: input.runId,
            status: input.status,
            taskId: input.taskId
          })
        };
      },
      async createRun(input) {
        createRunCalls.push(input);
        return createRun({
          issueId: input.issueId,
          runId: "run-1",
          status: "running",
          taskId: input.taskId
        });
      }
    },
    issueDetail: {
      contextRefs: [],
      issue,
      latestOutputs: [],
      recentRuns: [],
      tasks: [task]
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    },
    taskDetail: {
      contextRefs: [],
      latestOutputs: [],
      recentRuns: [],
      task
    }
  });

  await harness.actions.runTask();

  assert.equal(runnerCalls.length, 1);
  assert.match(runnerCalls[0]?.agentSessionId ?? "", /^[0-9a-f-]{36}$/);
  assert.deepEqual(runnerCalls[0]?.issue, issue);
  assert.equal(runnerCalls[0]?.provider, "codex");
  assert.deepEqual(runnerCalls[0]?.task, task);
  assert.equal(runnerCalls[0]?.workspaceId, "workspace-1");
  assert.deepEqual(createRunCalls, []);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.task_run_initiated",
      params: {
        hasExecutionDirectory: false,
        issueId: "issue-1",
        provider: "codex",
        taskId: "task-1"
      }
    }
  ]);
  assert.deepEqual(completeRunCalls, []);
  assert.deepEqual(harness.isRunningTaskState.history, [true, false]);
  assert.deepEqual(harness.notificationState.history, []);
  assert.equal(harness.refreshDetailsCount, 1);
});

test("controller actions run selected issues without selected subtasks", async () => {
  const runnerCalls: IssueManagerAgentRunRequest[] = [];
  const createRunCalls: unknown[] = [];
  const completeRunCalls: unknown[] = [];
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const issue = createIssueSummary({
    content: "Issue content",
    issueId: "issue-1",
    status: "not_started",
    title: "Plan migration"
  });
  const harness = createControllerActionsHarness({
    analytics: {
      track(event) {
        analyticsEvents.push(event);
      }
    },
    agentRunner: {
      async runTask(input) {
        runnerCalls.push(input);
        return {
          status: "opened"
        };
      }
    },
    backend: {
      async completeRun(input) {
        completeRunCalls.push(input);
        return {
          outputs: [],
          run: createRun({
            issueId: input.issueId,
            runId: input.runId,
            status: input.status
          })
        };
      },
      async createRun(input) {
        createRunCalls.push(input);
        return createRun({
          issueId: input.issueId,
          runId: "run-issue-1",
          status: "running"
        });
      }
    },
    issueDetail: {
      contextRefs: [],
      issue,
      latestOutputs: [],
      recentRuns: [],
      tasks: []
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: null
    },
    taskDetail: null
  });

  await harness.actions.runTask();

  assert.equal(runnerCalls.length, 1);
  assert.match(runnerCalls[0]?.agentSessionId ?? "", /^[0-9a-f-]{36}$/);
  assert.deepEqual(runnerCalls[0]?.issue, issue);
  assert.equal(runnerCalls[0]?.provider, "codex");
  assert.equal(runnerCalls[0]?.task, undefined);
  assert.equal(runnerCalls[0]?.workspaceId, "workspace-1");
  assert.deepEqual(createRunCalls, []);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.task_run_initiated",
      params: {
        hasExecutionDirectory: false,
        issueId: "issue-1",
        provider: "codex",
        taskId: null
      }
    }
  ]);
  assert.deepEqual(completeRunCalls, []);
  assert.deepEqual(harness.isRunningTaskState.history, [true, false]);
  assert.deepEqual(harness.notificationState.history, []);
  assert.equal(harness.refreshDetailsCount, 1);
});

test("controller actions run issue once when no task is selected", async () => {
  const runnerCalls: IssueManagerAgentRunRequest[] = [];
  const createRunCalls: unknown[] = [];
  const issue = createIssueSummary({
    issueId: "issue-1",
    title: "Plan migration"
  });
  const firstTask = createTaskSummary({
    issueId: "issue-1",
    taskId: "task-1",
    title: "Port renderer"
  });
  const secondTask = createTaskSummary({
    issueId: "issue-1",
    taskId: "task-2",
    title: "Port tests"
  });
  const harness = createControllerActionsHarness({
    agentRunner: {
      async runTask(input) {
        runnerCalls.push(input);
        return {
          status: "opened"
        };
      }
    },
    backend: {
      async createRun(input) {
        createRunCalls.push(input);
        return createRun({
          issueId: input.issueId,
          runId: `run-${input.taskId}`,
          status: "running",
          taskId: input.taskId
        });
      }
    },
    issueDetail: {
      contextRefs: [],
      issue,
      latestOutputs: [],
      recentRuns: [],
      tasks: [firstTask, secondTask]
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: null
    },
    taskDetail: null
  });

  await harness.actions.runTask();

  assert.deepEqual(createRunCalls, []);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0]?.task, undefined);
  assert.deepEqual(harness.isRunningTaskState.history, [true, false]);
  assert.equal(harness.refreshDetailsCount, 1);
});

test("controller actions honor provider overrides from the run entry menu", async () => {
  const runnerCalls: IssueManagerAgentRunRequest[] = [];
  const createRunCalls: unknown[] = [];
  const issue = createIssueSummary({
    issueId: "issue-1",
    title: "Plan migration"
  });
  const task = createTaskSummary({
    issueId: "issue-1",
    taskId: "task-1",
    title: "Port renderer"
  });
  const harness = createControllerActionsHarness({
    agentRunner: {
      async runTask(input) {
        runnerCalls.push(input);
        return {
          status: "opened"
        };
      }
    },
    backend: {
      async createRun(input) {
        createRunCalls.push(input);
        return createRun({
          issueId: input.issueId,
          runId: "run-1",
          status: "running",
          taskId: input.taskId
        });
      }
    },
    issueDetail: {
      contextRefs: [],
      issue,
      latestOutputs: [],
      recentRuns: [],
      tasks: [task]
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    },
    taskDetail: {
      contextRefs: [],
      latestOutputs: [],
      recentRuns: [],
      task
    }
  });

  await harness.actions.runTask("claude");

  assert.equal(runnerCalls.length, 1);
  assert.match(runnerCalls[0]?.agentSessionId ?? "", /^[0-9a-f-]{36}$/);
  assert.deepEqual(runnerCalls[0]?.issue, issue);
  assert.equal(runnerCalls[0]?.provider, "claude");
  assert.deepEqual(runnerCalls[0]?.task, task);
  assert.deepEqual(createRunCalls, []);
  assert.equal(harness.nodeState.current.selectedAgentProvider, "claude");
});

test("controller actions open agent task breakdown with a provider override", async () => {
  const breakdownCalls: IssueManagerAgentBreakdownRequest[] = [];
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const issue = createIssueSummary({
    content: "Move the renderer to the new shell.",
    issueId: "issue-1",
    title: "Plan migration"
  });
  const task = createTaskSummary({
    issueId: "issue-1",
    taskId: "task-1",
    title: "Audit current shell"
  });
  const harness = createControllerActionsHarness({
    analytics: {
      track(event) {
        analyticsEvents.push(event);
      }
    },
    agentBreakdownLauncher: {
      async startBreakdown(input) {
        breakdownCalls.push(input);
        return {
          status: "opened"
        };
      }
    },
    issueDetail: {
      contextRefs: [createIssueContextRef({ path: "/workspace/spec.md" })],
      issue,
      latestOutputs: [],
      recentRuns: [],
      tasks: [task]
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedExecutionDirectory: "/Users/example/project/tutti",
      selectedIssueId: "issue-1",
      selectedTaskId: null
    }
  });

  await harness.actions.startTaskBreakdown("gemini");

  assert.deepEqual(breakdownCalls, [
    {
      executionDirectory: "/Users/example/project/tutti",
      issueDetail: {
        contextRefs: [createIssueContextRef({ path: "/workspace/spec.md" })],
        issue,
        latestOutputs: [],
        recentRuns: [],
        tasks: [task]
      },
      provider: "gemini",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.issue_breakdown_initiated",
      params: {
        issueId: "issue-1",
        provider: "gemini"
      }
    }
  ]);
  assert.equal(harness.nodeState.current.selectedAgentProvider, "gemini");
  assert.deepEqual(harness.isRunningTaskState.history, [true, false]);
  assert.deepEqual(harness.notificationState.history, []);
});

test("controller actions report unavailable agent task breakdown", async () => {
  const harness = createControllerActionsHarness({
    issueDetail: {
      contextRefs: [],
      issue: createIssueSummary({
        issueId: "issue-1",
        title: "Plan migration"
      }),
      latestOutputs: [],
      recentRuns: [],
      tasks: []
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: null
    }
  });

  await harness.actions.startTaskBreakdown();

  assert.deepEqual(harness.notificationState.history, [
    "messages.breakdownUnavailable"
  ]);
});

test("controller actions report run result error messages", async () => {
  const harness = createControllerActionsHarness({
    agentRunner: {
      async runTask() {
        return {
          errorMessage: "issue_manager.agent_gui_launch_unavailable",
          status: "failed"
        };
      }
    },
    issueDetail: {
      contextRefs: [],
      issue: createIssueSummary({
        issueId: "issue-1",
        title: "Plan migration"
      }),
      latestOutputs: [],
      recentRuns: [],
      tasks: [
        createTaskSummary({
          issueId: "issue-1",
          taskId: "task-1",
          title: "Port renderer"
        })
      ]
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    },
    taskDetail: {
      contextRefs: [],
      latestOutputs: [],
      recentRuns: [],
      task: createTaskSummary({
        issueId: "issue-1",
        taskId: "task-1",
        title: "Port renderer"
      })
    }
  });

  await harness.actions.runTask();

  assert.deepEqual(harness.notificationState.history, [
    "issue_manager.agent_gui_launch_unavailable"
  ]);
  assert.deepEqual(harness.isRunningTaskState.history, [true, false]);
  assert.equal(harness.refreshDetailsCount, 1);
});

test("controller actions report run failures when the runner throws", async () => {
  const completeRunCalls: unknown[] = [];
  const harness = createControllerActionsHarness({
    agentRunner: {
      async runTask() {
        throw new Error("runner failed");
      }
    },
    backend: {
      async completeRun(input) {
        completeRunCalls.push(input);
        return {
          outputs: [],
          run: createRun({
            issueId: input.issueId,
            runId: input.runId,
            status: input.status,
            taskId: input.taskId
          })
        };
      },
      async createRun(input) {
        return createRun({
          issueId: input.issueId,
          runId: "run-failed-1",
          status: "running",
          taskId: input.taskId
        });
      }
    },
    issueDetail: {
      contextRefs: [],
      issue: createIssueSummary({
        issueId: "issue-1",
        title: "Plan migration"
      }),
      latestOutputs: [],
      recentRuns: [],
      tasks: [
        createTaskSummary({
          issueId: "issue-1",
          taskId: "task-1",
          title: "Port renderer"
        })
      ]
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    },
    taskDetail: {
      contextRefs: [],
      latestOutputs: [],
      recentRuns: [],
      task: createTaskSummary({
        issueId: "issue-1",
        taskId: "task-1",
        title: "Port renderer"
      })
    }
  });

  await harness.actions.runTask();

  assert.deepEqual(harness.notificationState.history, ["messages.runFailed"]);
  assert.deepEqual(completeRunCalls, []);
  assert.deepEqual(harness.isRunningTaskState.history, [true, false]);
  assert.equal(harness.refreshDetailsCount, 1);
});

test("controller actions share the selected issue and task through the clipboard", async (t) => {
  const shareCalls: Array<{
    issueId: string;
    taskId?: string;
    workspaceId: string;
  }> = [];
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  let copiedText: string | null = null;
  const restoreNavigator = installNavigatorClipboard(async (value) => {
    copiedText = value;
  });
  t.after(restoreNavigator);

  const harness = createControllerActionsHarness({
    analytics: {
      track(event) {
        analyticsEvents.push(event);
      }
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentProvider: "codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    },
    shareAdapter: {
      async createIssueLink(input) {
        shareCalls.push(input);
        return "tutti://workspace/workspace-1/issues/issue-1/tasks/task-1";
      }
    }
  });

  await harness.actions.shareSelection();

  assert.deepEqual(shareCalls, [
    {
      issueId: "issue-1",
      taskId: "task-1",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(
    copiedText,
    "tutti://workspace/workspace-1/issues/issue-1/tasks/task-1"
  );
  assert.deepEqual(analyticsEvents, []);
  assert.equal(harness.notificationState.current, null);
});
