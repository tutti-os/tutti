import assert from "node:assert/strict";
import test from "node:test";
import type { IssueManagerNodeState } from "../../contracts/index.ts";
import type { TaskDraft } from "./controllerTypes.ts";
import {
  applyIssueManagerControllerOutcome,
  createIssueManagerRunTaskSuccessOutcome,
  createIssueManagerSaveIssueSuccessOutcome,
  createIssueManagerSaveTaskSuccessOutcome
} from "./controllerOutcomes.ts";
import {
  createIssueManagerAttachReferencesOutcome,
  createIssueManagerInsertReferencesOutcome,
  createIssueManagerOpenReferencePickerOutcome
} from "./reference/controllerReferenceOutcomes.ts";

test("controllerOutcomes describe run-task notifications and refresh behavior", () => {
  assert.deepEqual(
    createIssueManagerRunTaskSuccessOutcome({ status: "completed" }),
    {
      notificationKey: undefined
    }
  );
  assert.deepEqual(
    createIssueManagerRunTaskSuccessOutcome({ status: "failed" }),
    {
      notificationKey: "messages.runFailed"
    }
  );
});

test("controllerOutcomes applies controller glue in one place", () => {
  const notifications: string[] = [];
  const issueEditorModes: string[] = [];
  const taskEditorModes: string[] = [];
  let refreshAllCount = 0;
  let refreshDetailsCount = 0;
  let referenceTarget = null;
  let issueDraft = {
    content: "Issue draft",
    title: "Title"
  };
  let taskDraft: TaskDraft = {
    content: "Task draft",
    priority: "medium" as const,
    title: "Task"
  };
  let currentNodeState: IssueManagerNodeState = {
    issueSearchQuery: "",
    issueStatusFilter: "all" as const,
    selectedAgentTargetId: "local:codex",
    selectedIssueId: "issue-1",
    selectedTaskId: "task-1"
  };

  applyIssueManagerControllerOutcome({
    notify(title) {
      notifications.push(title);
    },
    outcome: {
      issueDraft: (current) => ({
        ...current,
        title: "Updated title"
      }),
      issueEditorMode: "read",
      nodeState: (current) => ({
        ...current,
        selectedIssueId: "issue-9"
      }),
      notificationKey: "messages.runFailed",
      referenceTarget: {
        mode: "attach",
        parentKind: "issue"
      },
      refreshAll: true,
      refreshDetails: true,
      taskDraft: (current) => ({
        ...current,
        title: "Updated task"
      }),
      taskEditorMode: "edit"
    },
    refreshAll() {
      refreshAllCount += 1;
    },
    refreshDetails() {
      refreshDetailsCount += 1;
    },
    setIssueDraftInternal(updater) {
      issueDraft = updater(issueDraft);
    },
    setIssueEditorModeState(mode) {
      issueEditorModes.push(mode);
    },
    setReferenceTarget(target) {
      referenceTarget = target;
    },
    setTaskDraftInternal(updater) {
      taskDraft = updater(taskDraft);
    },
    setTaskEditorModeState(mode) {
      taskEditorModes.push(mode);
    },
    translate(key) {
      return `translated:${key}`;
    },
    updateNodeState(updater) {
      currentNodeState = updater(currentNodeState);
    }
  });

  assert.deepEqual(notifications, ["translated:messages.runFailed"]);
  assert.deepEqual(issueEditorModes, ["read"]);
  assert.deepEqual(taskEditorModes, ["edit"]);
  assert.equal(refreshAllCount, 1);
  assert.equal(refreshDetailsCount, 1);
  assert.deepEqual(referenceTarget, {
    mode: "attach",
    parentKind: "issue"
  });
  assert.equal(issueDraft.title, "Updated title");
  assert.equal(taskDraft.title, "Updated task");
  assert.equal(currentNodeState.selectedIssueId, "issue-9");
});

test("controllerOutcomes describe reference picker and insert transitions", () => {
  assert.deepEqual(
    createIssueManagerOpenReferencePickerOutcome({
      mode: "insert",
      parentKind: "task",
      taskId: "task-3"
    }),
    {
      referenceTarget: {
        mode: "insert",
        parentKind: "task",
        taskId: "task-3"
      }
    }
  );
  assert.deepEqual(createIssueManagerAttachReferencesOutcome(true), {
    referenceTarget: null,
    refreshDetails: true
  });
  const insertOutcome = createIssueManagerInsertReferencesOutcome({
    refs: [
      {
        displayName: "README.md",
        kind: "file",
        path: "/workspace/docs/README.md"
      }
    ],
    target: {
      mode: "insert",
      parentKind: "issue"
    }
  });
  assert.equal(insertOutcome.referenceTarget, null);
  assert.equal(
    insertOutcome.issueDraft?.({
      content: "Draft",
      title: "Issue"
    }).content,
    "Draft [README.md](/workspace/docs/README.md)"
  );
});

test("controllerOutcomes describe issue-save local transitions", () => {
  const outcome = createIssueManagerSaveIssueSuccessOutcome("issue-9");

  assert.equal(outcome.issueEditorMode, "read");
  assert.equal(outcome.refreshAll, true);
  assert.deepEqual(
    outcome.nodeState!({
      issueDraftContent: "Draft",
      issueDraftTitle: "Draft title",
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-2"
    }),
    {
      issueDraftContent: null,
      issueDraftTitle: null,
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: "issue-9",
      selectedTaskId: "task-2"
    }
  );
});

test("controllerOutcomes describe task-save local transitions", () => {
  const outcome = createIssueManagerSaveTaskSuccessOutcome("task-9");

  assert.equal(outcome.taskEditorMode, "read");
  assert.equal(outcome.refreshAll, true);
  assert.deepEqual(
    outcome.nodeState!({
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-2",
      taskDraftContent: "Draft",
      taskDraftTitle: "Draft title"
    }),
    {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-9",
      taskDraftContent: null,
      taskDraftTitle: null
    }
  );
});
