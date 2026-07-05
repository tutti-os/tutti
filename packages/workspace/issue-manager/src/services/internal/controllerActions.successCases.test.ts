import assert from "node:assert/strict";
import test from "node:test";
import type { IssueManagerAnalyticsEvent } from "../../contracts/adapters.ts";
import type {
  IssueManagerAddContextRefsInput,
  IssueManagerCreateTaskInput,
  IssueManagerUpdateIssueInput
} from "../../contracts/index.ts";
import {
  createControllerActionsHarness,
  createIssueContextRef,
  createIssueSummary,
  createTaskContextRef,
  createTaskSummary
} from "./controllerActionTestHarness.ts";

test("controller actions insert task references directly into the task draft", async () => {
  const harness = createControllerActionsHarness({
    fileAdapter: {
      async requestReferences() {
        return [
          {
            displayName: "README.md",
            kind: "file",
            path: "/workspace/docs/README.md"
          },
          {
            displayName: "design",
            kind: "folder",
            path: "/workspace/docs/design"
          }
        ];
      }
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    },
    taskDraft: {
      content: "Existing task note",
      priority: "high",
      title: "Port renderer"
    }
  });

  await harness.actions.insertReferences("task");

  assert.equal(
    harness.taskDraftState.current.content,
    "Existing task note [README.md](/workspace/docs/README.md) [design](/workspace/docs/design/)"
  );
  assert.equal(harness.referenceTargetState.current, null);
  assert.equal(harness.refreshDetailsCount, 0);
});

test("controller actions insert task references into created subtask drafts without a selected task", async () => {
  const harness = createControllerActionsHarness({
    fileAdapter: {
      async requestReferences() {
        return [
          {
            displayName: "plan.md",
            kind: "file",
            path: "/workspace/docs/plan.md"
          }
        ];
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
      content: "",
      priority: "medium",
      title: "Ship renderer"
    },
    taskEditorMode: "create"
  });

  await harness.actions.insertReferences("task");

  assert.equal(
    harness.taskDraftState.current.content,
    "[plan.md](/workspace/docs/plan.md)"
  );
});

test("controller actions upload task references into created subtask drafts", async () => {
  const uploadCalls: Array<{
    mode: "files" | "folder";
    targetDirectoryPath: string;
    workspaceId: string;
  }> = [];
  const refreshCalls: Array<{
    depth?: number;
    paths?: readonly string[];
    workspaceId: string;
  }> = [];
  const harness = createControllerActionsHarness({
    fileAdapter: {
      async refreshTree(input) {
        refreshCalls.push(input);
      },
      async requestUpload(input) {
        uploadCalls.push(input);
        return [
          {
            displayName: "brief.md",
            kind: "file",
            path: "/workspace/brief.md"
          }
        ];
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
      content: "Initial notes",
      priority: "medium",
      title: "Ship renderer"
    },
    taskEditorMode: "create"
  });

  await harness.actions.uploadReferences("task", "files");

  assert.deepEqual(uploadCalls, [
    {
      mode: "files",
      targetDirectoryPath: "/",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(refreshCalls, [
    {
      depth: 1,
      paths: ["/workspace/brief.md"],
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(
    harness.taskDraftState.current.content,
    "Initial notes [brief.md](/workspace/brief.md)"
  );
});

test("controller actions save edited issues and sync only issue-scoped missing references", async () => {
  const updateIssueCalls: IssueManagerUpdateIssueInput[] = [];
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
      async updateIssue(input) {
        updateIssueCalls.push(input);
        return createIssueSummary({
          issueId: "issue-1",
          title: "Plan migration"
        });
      }
    },
    issueDetail: {
      contextRefs: [
        createIssueContextRef({
          path: "/workspace/docs/spec.md"
        }),
        createTaskContextRef({
          path: "/workspace/docs/design.md",
          taskId: "task-7"
        })
      ],
      issue: createIssueSummary({
        issueId: "issue-1",
        title: "Plan migration"
      }),
      latestOutputs: [],
      recentRuns: [],
      tasks: []
    },
    issueDraft: {
      content:
        "[spec](/workspace/docs/spec.md)\n\n[design](/workspace/docs/design.md)",
      title: "Plan migration"
    },
    issueEditorMode: "edit",
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-7"
    }
  });

  await harness.actions.saveIssue();

  assert.deepEqual(updateIssueCalls, [
    {
      content:
        "[spec](/workspace/docs/spec.md)\n\n[design](/workspace/docs/design.md)",
      issueId: "issue-1",
      title: "Plan migration",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(addContextRefsCalls, [
    {
      issueId: "issue-1",
      parentKind: "issue",
      refs: [
        {
          displayName: "design",
          path: "/workspace/docs/design.md",
          refType: "file"
        }
      ],
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(harness.issueEditorModeState.current, "read");
  assert.equal(harness.notificationState.current, null);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.issue_saved",
      params: {
        contextRefCount: 2,
        hasDescription: true,
        issueId: "issue-1",
        taskCount: 0
      }
    }
  ]);
  assert.deepEqual(harness.nodeState.current, {
    issueDraftContent: null,
    issueDraftTitle: null,
    issueSearchQuery: "",
    issueStatusFilter: "all",
    selectedAgentTargetId: "local:codex",
    selectedIssueId: "issue-1",
    selectedTaskId: "task-7"
  });
  assert.equal(harness.refreshAllCount, 1);
});

test("controller actions save created tasks and attach extracted task references", async () => {
  const createTaskCalls: IssueManagerCreateTaskInput[] = [];
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
      async createTask(input) {
        createTaskCalls.push(input);
        return createTaskSummary({
          issueId: "issue-1",
          priority: "high",
          taskId: "task-2",
          title: "Ship renderer"
        });
      }
    },
    nodeState: {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: "issue-1",
      selectedTaskId: null,
      taskDraftContent: "persisted body",
      taskDraftTitle: "persisted title"
    },
    taskDraft: {
      content: "Implement [plan](/workspace/docs/plan.md)",
      priority: "high",
      title: "Ship renderer"
    },
    taskEditorMode: "create"
  });

  await harness.actions.saveTask();

  assert.deepEqual(createTaskCalls, [
    {
      content: "Implement [plan](/workspace/docs/plan.md)",
      issueId: "issue-1",
      priority: "high",
      title: "Ship renderer",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(addContextRefsCalls, [
    {
      issueId: "issue-1",
      parentKind: "task",
      refs: [
        {
          displayName: "plan",
          path: "/workspace/docs/plan.md",
          refType: "file"
        }
      ],
      taskId: "task-2",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(harness.taskEditorModeState.current, "read");
  assert.equal(harness.notificationState.current, null);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.task_created",
      params: {
        issueId: "issue-1",
        taskId: "task-2"
      }
    }
  ]);
  assert.deepEqual(harness.nodeState.current, {
    issueSearchQuery: "",
    issueStatusFilter: "all",
    selectedAgentTargetId: "local:codex",
    selectedIssueId: "issue-1",
    selectedTaskId: "task-2",
    taskDraftContent: null,
    taskDraftTitle: null
  });
  assert.equal(harness.refreshAllCount, 1);
});
