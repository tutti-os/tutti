import assert from "node:assert/strict";
import test from "node:test";
import type {
  IssueManagerIssueSummary,
  IssueManagerTaskSummary
} from "../../../contracts/index.ts";
import type { IssueManagerController } from "../../react/index.ts";
import {
  canIssueManagerSaveTask,
  isIssueManagerRunControlDisabled,
  resolveIssueManagerTaskDrawerViewState
} from "./IssueManagerTaskDrawerState.ts";

test("task drawer view state prefers create labels in create mode", () => {
  const view = resolveIssueManagerTaskDrawerViewState({
    controller: createController("create", "Draft title"),
    selectedTask: createTask("task-1", "Existing task")
  });

  assert.deepEqual(view, {
    bodyKind: "edit",
    isCreate: true,
    isEdit: false,
    isRead: false,
    isTaskTitleMissing: false,
    showEditFooter: true,
    showReadFooter: false,
    showTaskActions: false,
    showTaskMetadata: false,
    title: "actions.createTask"
  });
});

test("task drawer view state falls back to task details title in read mode", () => {
  const view = resolveIssueManagerTaskDrawerViewState({
    controller: createController("read", ""),
    selectedTask: null
  });

  assert.deepEqual(view, {
    bodyKind: "read",
    isCreate: false,
    isEdit: false,
    isRead: true,
    isTaskTitleMissing: true,
    showEditFooter: false,
    showReadFooter: false,
    showTaskActions: false,
    showTaskMetadata: false,
    title: "labels.taskDetails"
  });
});

test("task drawer view state prefers loading body while the read detail request is in flight", () => {
  const view = resolveIssueManagerTaskDrawerViewState({
    controller: createController("read", "", {
      isLoading: true,
      value: null
    }),
    selectedTask: createTask("task-1", "Existing task")
  });

  assert.equal(view.bodyKind, "loading");
  assert.equal(view.showTaskActions, true);
  assert.equal(view.showTaskMetadata, true);
});

test("canIssueManagerSaveTask requires both selected issue and title", () => {
  assert.equal(
    canIssueManagerSaveTask({
      selectedIssue: createIssue("issue-1"),
      view: { isTaskTitleMissing: false }
    }),
    true
  );
  assert.equal(
    canIssueManagerSaveTask({
      selectedIssue: null,
      view: { isTaskTitleMissing: false }
    }),
    false
  );
  assert.equal(
    canIssueManagerSaveTask({
      selectedIssue: createIssue("issue-1"),
      view: { isTaskTitleMissing: true }
    }),
    false
  );
});

test("run controls stay enabled for a not started task while another task is running", () => {
  assert.equal(
    isIssueManagerRunControlDisabled({
      selectedIssueStatus: "running",
      selectedTaskStatus: "not_started"
    }),
    false
  );
  assert.equal(
    isIssueManagerRunControlDisabled({
      selectedIssueStatus: "running",
      selectedTaskStatus: "running"
    }),
    true
  );
  assert.equal(
    isIssueManagerRunControlDisabled({
      selectedIssueStatus: "running",
      selectedTaskStatus: null
    }),
    true
  );
  assert.equal(
    isIssueManagerRunControlDisabled({
      disabled: true,
      selectedIssueStatus: "not_started",
      selectedTaskStatus: "not_started"
    }),
    true
  );
});

function createController(
  taskEditorMode: IssueManagerController["taskEditorMode"],
  title: string,
  taskDetail: Pick<
    IssueManagerController["taskDetail"],
    "isLoading" | "value"
  > = {
    isLoading: false,
    value: null
  }
): Pick<
  IssueManagerController,
  "copy" | "taskDetail" | "taskDraft" | "taskEditorMode"
> {
  return {
    copy: {
      t(key: string) {
        return key;
      }
    } as IssueManagerController["copy"],
    taskDraft: {
      content: "",
      priority: "medium",
      title
    },
    taskDetail: {
      error: null,
      isLoading: taskDetail.isLoading,
      value: taskDetail.value
    },
    taskEditorMode
  };
}

function createIssue(issueId: string): IssueManagerIssueSummary {
  return {
    creatorUserId: "local",
    issueId,
    status: "not_started",
    title: "Issue",
    topicId: "topic-1",
    workspaceId: "workspace-1"
  };
}

function createTask(taskId: string, title: string): IssueManagerTaskSummary {
  return {
    creatorUserId: "local",
    issueId: "issue-1",
    priority: "medium",
    status: "not_started",
    taskId,
    title,
    workspaceId: "workspace-1"
  };
}
