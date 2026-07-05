import assert from "node:assert/strict";
import test from "node:test";
import type {
  IssueManagerAnalyticsEvent,
  IssueManagerNodeState
} from "../../../../contracts/index.ts";
import type { IssueManagerFeature } from "../../../../core/index.ts";
import type {
  IssueManagerControllerSession,
  TaskDraft
} from "../../../../services/issueManagerControllerService.interface.ts";
import { createIssueManagerTaskBindings } from "./createIssueManagerTaskBindings.ts";

test("task bindings seed the draft from node state when create mode opens", () => {
  const harness = createTaskHarness({
    taskDraftContent: "Saved task content",
    taskDraftTitle: "Saved task title"
  });

  harness.bindings.setTaskEditorMode("create");

  assert.equal(harness.taskEditorMode, "create");
  assert.deepEqual(harness.taskDraft, {
    content: "Saved task content",
    priority: "medium",
    title: "Saved task title"
  });
});

test("task bindings switch back to read mode after selection", () => {
  const harness = createTaskHarness();

  harness.bindings.selectTask("task-7");

  assert.equal(harness.taskEditorMode, "read");
  assert.equal(harness.nodeState.selectedTaskId, "task-7");
});

test("task bindings close the task drawer in a single selection transition", () => {
  const harness = createTaskHarness({
    selectedTaskId: "task-7"
  });

  harness.bindings.selectTask(null);

  assert.equal(harness.taskEditorMode, "read");
  assert.equal(harness.nodeState.selectedTaskId, null);
});

test("task bindings keep title changes in the session draft", () => {
  const harness = createTaskHarness();

  harness.bindings.setTaskTitle("Renamed task");

  assert.equal(harness.taskDraft.title, "Renamed task");
  assert.equal(harness.nodeState.taskDraftTitle, null);
});

test("task bindings report context reference changes when content changes", () => {
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const harness = createTaskHarness(
    {},
    {
      analytics: {
        track(event: IssueManagerAnalyticsEvent) {
          analyticsEvents.push(event);
        }
      },
      initialTaskDraft: {
        content: "[old](/workspace/old.md)",
        priority: "medium",
        title: ""
      },
      taskEditorMode: "edit"
    }
  );

  harness.bindings.setTaskContent("[new](/workspace/new.md)");

  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.context_ref_added",
      params: { refType: "file", targetType: "task" }
    },
    {
      name: "issue_manager.context_ref_removed",
      params: { targetType: "task" }
    }
  ]);
});

function createTaskHarness(
  nodeStatePatch?: Partial<IssueManagerNodeState>,
  options?: {
    analytics?: { track(event: IssueManagerAnalyticsEvent): void };
    initialTaskDraft?: TaskDraft;
    taskEditorMode?: "create" | "edit" | "read";
  }
) {
  let taskDraft: TaskDraft = {
    content: "",
    priority: "medium",
    title: "",
    ...options?.initialTaskDraft
  };
  let taskEditorMode: "create" | "edit" | "read" =
    options?.taskEditorMode ?? "edit";
  let nodeState: IssueManagerNodeState = {
    issueDraftContent: null,
    issueDraftTitle: null,
    issueSearchQuery: "",
    issueStatusFilter: "all",
    selectedAgentTargetId: "local:codex",
    selectedIssueId: "issue-1",
    selectedTaskId: null,
    taskDraftContent: null,
    taskDraftTitle: null,
    taskListCollapsed: false,
    ...nodeStatePatch
  };

  const session = {
    setTaskDraftInternal(update) {
      taskDraft = typeof update === "function" ? update(taskDraft) : update;
    },
    setTaskEditorModeState(update) {
      taskEditorMode =
        typeof update === "function" ? update(taskEditorMode) : update;
    },
    updateNodeState(update) {
      nodeState =
        typeof update === "function"
          ? update(nodeState)
          : { ...nodeState, ...update };
    }
  } as Pick<
    IssueManagerControllerSession,
    "setTaskDraftInternal" | "setTaskEditorModeState" | "updateNodeState"
  > as IssueManagerControllerSession;

  return {
    bindings: createIssueManagerTaskBindings({
      controllerSession: session,
      feature: {
        analytics: options?.analytics
      } as IssueManagerFeature,
      nodeState,
      taskEditorMode
    }),
    get nodeState() {
      return nodeState;
    },
    get taskDraft() {
      return taskDraft;
    },
    get taskEditorMode() {
      return taskEditorMode;
    }
  };
}
