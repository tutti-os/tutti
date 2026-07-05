import assert from "node:assert/strict";
import test from "node:test";
import type {
  IssueManagerIssueDetail,
  IssueManagerIssueSummary,
  IssueManagerNodeState,
  IssueManagerTaskDetail,
  IssueManagerTaskSummary
} from "../../contracts/index.ts";
import {
  applyIssueManagerIssueDeleted,
  applyIssueManagerIssueEditorModeToNodeState,
  applyIssueManagerIssueDetailResultToNodeState,
  applyIssueManagerIssueListResultToNodeState,
  applyIssueManagerIssueSelection,
  applyIssueManagerSelectedAgentTargetId,
  applyIssueManagerIssueSaved,
  applyIssueManagerTaskDeleted,
  applyIssueManagerTaskEditorModeToNodeState,
  applyIssueManagerTaskSaved,
  applyIssueManagerTaskSelection,
  createIssueManagerIssueDraftFromNodeState,
  createIssueManagerTaskDraftFromNodeState,
  persistIssueManagerIssueDraftContent,
  persistIssueManagerIssueDraftTitle,
  persistIssueManagerTaskDraftContent,
  persistIssueManagerTaskDraftTitle,
  syncIssueManagerIssueDraftFromDetail,
  syncIssueManagerTaskDraftFromDetail
} from "./controllerState.ts";

test("controllerState creates drafts from snapshot node state", () => {
  assert.deepEqual(createIssueManagerIssueDraftFromNodeState(null), {
    content: "",
    title: ""
  });
  assert.deepEqual(
    createIssueManagerIssueDraftFromNodeState({
      issueDraftContent: "Draft issue body",
      issueDraftTitle: "Draft issue"
    }),
    {
      content: "Draft issue body",
      title: "Draft issue"
    }
  );
  assert.deepEqual(
    createIssueManagerTaskDraftFromNodeState(
      {
        taskDraftContent: "Draft task body",
        taskDraftTitle: "Draft task"
      },
      "high"
    ),
    {
      content: "Draft task body",
      priority: "high",
      title: "Draft task"
    }
  );
});

test("controllerState merges issue list results into canonical node state", () => {
  const current = createNodeState({
    issueListNextPageToken: "stale-page",
    selectedIssueId: "missing-issue"
  });
  const issues = [
    createIssueSummary({
      issueId: "issue-1",
      title: "Plan migration"
    }),
    createIssueSummary({
      issueId: "issue-2",
      title: "Port renderer"
    })
  ];

  assert.deepEqual(
    applyIssueManagerIssueListResultToNodeState(current, {
      issues,
      nextPageToken: "page-2"
    }),
    createNodeState({
      issueListNextPageToken: "page-2",
      selectedIssueId: "issue-1"
    })
  );
  assert.deepEqual(
    applyIssueManagerIssueListResultToNodeState(
      createNodeState({
        selectedIssueId: "issue-2"
      }),
      {
        issues,
        nextPageToken: undefined
      }
    ),
    createNodeState({
      issueListNextPageToken: null,
      selectedIssueId: "issue-2"
    })
  );
});

test("controllerState merges issue detail results into canonical node state", () => {
  const tasks = [
    createTaskSummary({
      issueId: "issue-1",
      taskId: "task-1",
      title: "Draft plan"
    }),
    createTaskSummary({
      issueId: "issue-1",
      taskId: "task-2",
      title: "Port renderer"
    })
  ];

  assert.deepEqual(
    applyIssueManagerIssueDetailResultToNodeState(
      createNodeState({
        selectedIssueId: "issue-1",
        selectedTaskId: "missing-task"
      }),
      { tasks }
    ),
    createNodeState({
      selectedIssueId: "issue-1",
      selectedTaskId: null
    })
  );
  assert.deepEqual(
    applyIssueManagerIssueDetailResultToNodeState(
      createNodeState({
        selectedIssueId: "issue-1",
        selectedTaskId: "task-2"
      }),
      { tasks: [] }
    ),
    createNodeState({
      selectedIssueId: "issue-1",
      selectedTaskId: null
    })
  );
});

test("controllerState applies issue and task selection in canonical order", () => {
  const current = createNodeState({
    selectedIssueId: "issue-1",
    selectedTaskId: "task-2"
  });

  assert.deepEqual(
    applyIssueManagerIssueSelection(current, "issue-3"),
    createNodeState({
      selectedIssueId: "issue-3",
      selectedTaskId: null
    })
  );
  assert.deepEqual(
    applyIssueManagerTaskSelection(current, "task-9"),
    createNodeState({
      selectedIssueId: "issue-1",
      selectedTaskId: "task-9"
    })
  );
  assert.deepEqual(
    applyIssueManagerIssueDeleted(current),
    createNodeState({
      selectedIssueId: null,
      selectedTaskId: null
    })
  );
  assert.deepEqual(
    applyIssueManagerTaskDeleted(current),
    createNodeState({
      selectedIssueId: "issue-1",
      selectedTaskId: null
    })
  );
  assert.deepEqual(
    applyIssueManagerSelectedAgentTargetId(current, "local:claude-code"),
    createNodeState({
      selectedAgentTargetId: "local:claude-code",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-2"
    })
  );
});

test("controllerState applies canonical save transitions", () => {
  const current = createNodeState({
    issueDraftContent: "Draft issue body",
    issueDraftTitle: "Draft issue",
    selectedIssueId: "issue-1",
    selectedTaskId: "task-2",
    taskDraftContent: "Draft task body",
    taskDraftTitle: "Draft task"
  });

  assert.deepEqual(
    applyIssueManagerIssueSaved(current, "issue-3"),
    createNodeState({
      issueDraftContent: null,
      issueDraftTitle: null,
      selectedIssueId: "issue-3",
      selectedTaskId: "task-2",
      taskDraftContent: "Draft task body",
      taskDraftTitle: "Draft task"
    })
  );
  assert.deepEqual(
    applyIssueManagerTaskSaved(current, "task-8"),
    createNodeState({
      issueDraftContent: "Draft issue body",
      issueDraftTitle: "Draft issue",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-8",
      taskDraftContent: null,
      taskDraftTitle: null
    })
  );
});

test("controllerState syncs issue drafts from detail only in read mode", () => {
  const current = {
    content: "Unsaved issue draft",
    title: "Working copy"
  };
  const detail = createIssueDetail({
    issue: createIssueSummary({
      content:
        '  {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Plan migration"}]}]}  ',
      issueId: "issue-1",
      title: "Plan migration"
    })
  });

  assert.deepEqual(
    syncIssueManagerIssueDraftFromDetail(current, detail, "read"),
    {
      content: "Plan migration",
      title: "Plan migration"
    }
  );
  assert.equal(
    syncIssueManagerIssueDraftFromDetail(current, detail, "edit"),
    current
  );
  assert.equal(
    syncIssueManagerIssueDraftFromDetail(current, detail, "create"),
    current
  );
});

test("controllerState syncs task drafts from detail only in read mode", () => {
  const current = {
    content: "Unsaved task draft",
    priority: "low" as const,
    title: "Working task"
  };
  const detail = createTaskDetail({
    task: createTaskSummary({
      content: "\nTask body\n",
      issueId: "issue-1",
      priority: "high",
      taskId: "task-1",
      title: "Port renderer"
    })
  });

  assert.deepEqual(
    syncIssueManagerTaskDraftFromDetail(current, detail, "read"),
    {
      content: "Task body",
      priority: "high",
      title: "Port renderer"
    }
  );
  assert.equal(
    syncIssueManagerTaskDraftFromDetail(current, detail, "edit"),
    current
  );
  assert.equal(
    syncIssueManagerTaskDraftFromDetail(current, detail, "create"),
    current
  );
  assert.deepEqual(syncIssueManagerTaskDraftFromDetail(current, null, "read"), {
    content: "",
    priority: "medium",
    title: ""
  });
});

test("controllerState clears persisted drafts when leaving create mode", () => {
  const current = createNodeState({
    issueDraftContent: "Draft issue body",
    issueDraftTitle: "Draft issue",
    taskDraftContent: "Draft task body",
    taskDraftTitle: "Draft task"
  });

  assert.equal(
    applyIssueManagerIssueEditorModeToNodeState(current, "create"),
    current
  );
  assert.deepEqual(
    applyIssueManagerIssueEditorModeToNodeState(current, "read"),
    createNodeState({
      issueDraftContent: null,
      issueDraftTitle: null,
      taskDraftContent: "Draft task body",
      taskDraftTitle: "Draft task"
    })
  );
  assert.deepEqual(
    applyIssueManagerIssueEditorModeToNodeState(current, "edit"),
    createNodeState({
      issueDraftContent: null,
      issueDraftTitle: null,
      taskDraftContent: "Draft task body",
      taskDraftTitle: "Draft task"
    })
  );
  assert.equal(
    applyIssueManagerTaskEditorModeToNodeState(current, "create"),
    current
  );
  assert.deepEqual(
    applyIssueManagerTaskEditorModeToNodeState(current, "read"),
    createNodeState({
      issueDraftContent: "Draft issue body",
      issueDraftTitle: "Draft issue",
      taskDraftContent: null,
      taskDraftTitle: null
    })
  );
  assert.deepEqual(
    applyIssueManagerTaskEditorModeToNodeState(current, "edit"),
    createNodeState({
      issueDraftContent: "Draft issue body",
      issueDraftTitle: "Draft issue",
      taskDraftContent: null,
      taskDraftTitle: null
    })
  );
});

test("controllerState only persists draft fields while create mode is active", () => {
  const current = createNodeState();

  assert.equal(
    persistIssueManagerIssueDraftContent(current, "read", "Issue body"),
    current
  );
  assert.equal(
    persistIssueManagerIssueDraftContent(current, "edit", "Issue body"),
    current
  );
  assert.equal(
    persistIssueManagerIssueDraftTitle(current, "read", "Issue title"),
    current
  );
  assert.equal(
    persistIssueManagerIssueDraftTitle(current, "edit", "Issue title"),
    current
  );
  assert.equal(
    persistIssueManagerTaskDraftContent(current, "read", "Task body"),
    current
  );
  assert.equal(
    persistIssueManagerTaskDraftContent(current, "edit", "Task body"),
    current
  );
  assert.equal(
    persistIssueManagerTaskDraftTitle(current, "read", "Task title"),
    current
  );
  assert.equal(
    persistIssueManagerTaskDraftTitle(current, "edit", "Task title"),
    current
  );

  assert.deepEqual(
    persistIssueManagerIssueDraftContent(current, "create", "Issue body"),
    createNodeState({
      issueDraftContent: "Issue body"
    })
  );
  assert.deepEqual(
    persistIssueManagerIssueDraftTitle(current, "create", "Issue title"),
    createNodeState({
      issueDraftTitle: "Issue title"
    })
  );
  assert.deepEqual(
    persistIssueManagerTaskDraftContent(current, "create", "Task body"),
    createNodeState({
      taskDraftContent: "Task body"
    })
  );
  assert.deepEqual(
    persistIssueManagerTaskDraftTitle(current, "create", "Task title"),
    createNodeState({
      taskDraftTitle: "Task title"
    })
  );
});

function createNodeState(
  input?: Partial<IssueManagerNodeState>
): IssueManagerNodeState {
  return {
    issueSearchQuery: "",
    issueStatusFilter: "all",
    selectedAgentTargetId: "local:codex",
    selectedIssueId: null,
    selectedTaskId: null,
    ...input
  };
}

function createIssueSummary(
  input?: Partial<IssueManagerIssueSummary>
): IssueManagerIssueSummary {
  return {
    creatorUserId: "local",
    issueId: "issue-1",
    status: "not_started",
    title: "Issue",
    topicId: input?.topicId ?? "topic-1",
    workspaceId: "workspace-1",
    ...input
  };
}

function createTaskSummary(
  input?: Partial<IssueManagerTaskSummary>
): IssueManagerTaskSummary {
  return {
    creatorUserId: "local",
    issueId: "issue-1",
    priority: "medium",
    status: "not_started",
    taskId: "task-1",
    title: "Task",
    workspaceId: "workspace-1",
    ...input
  };
}

function createIssueDetail(
  input?: Partial<IssueManagerIssueDetail>
): IssueManagerIssueDetail {
  return {
    contextRefs: [],
    issue: createIssueSummary(),
    latestOutputs: [],
    recentRuns: [],
    tasks: [],
    ...input
  };
}

function createTaskDetail(
  input?: Partial<IssueManagerTaskDetail>
): IssueManagerTaskDetail {
  return {
    contextRefs: [],
    latestOutputs: [],
    recentRuns: [],
    task: createTaskSummary(),
    ...input
  };
}
