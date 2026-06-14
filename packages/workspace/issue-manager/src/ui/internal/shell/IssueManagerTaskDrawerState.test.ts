import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const taskDrawerSectionsSource = readFileSync(
  new URL("./IssueManagerTaskDrawerSections.tsx", import.meta.url),
  "utf8"
);
const issueManagerBottomBarSource = readFileSync(
  new URL("./IssueManagerBottomBar.tsx", import.meta.url),
  "utf8"
);
const issueManagerRunSectionsSource = readFileSync(
  new URL("../task/IssueManagerRunSections.tsx", import.meta.url),
  "utf8"
);
const issueManagerPanelsSource = readFileSync(
  new URL("./IssueManagerPanels.tsx", import.meta.url),
  "utf8"
);
const issueManagerIssueSectionsSource = readFileSync(
  new URL("../issue/IssueManagerIssueSections.tsx", import.meta.url),
  "utf8"
);
const titleTooltipSource = readFileSync(
  new URL("../content/IssueManagerTitleTooltip.tsx", import.meta.url),
  "utf8"
);

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

test("task drawer run controls do not use the global running task lock", () => {
  assert.doesNotMatch(
    taskDrawerSectionsSource,
    /disabled=\{controller\.isRunningTask\}/
  );
  assert.doesNotMatch(
    issueManagerBottomBarSource,
    /disabled=\{controller\.isRunningTask\}/
  );
  assert.doesNotMatch(
    issueManagerRunSectionsSource,
    /controller\.isRunningTask/
  );
});

test("task drawer title wraps long unbroken text inside the panel", () => {
  assert.match(
    taskDrawerSectionsSource,
    /line-clamp-2 min-w-0 flex-1 whitespace-normal text-\[15px\] font-semibold leading-6 text-\[var\(--text-primary\)\] \[overflow-wrap:anywhere\]/
  );
  assert.match(
    taskDrawerSectionsSource,
    /line-clamp-2 min-w-0 flex-1 whitespace-normal text-\[15px\] font-semibold leading-\[1\.35\] text-\[var\(--text-primary\)\] \[overflow-wrap:anywhere\]/
  );
});

test("task drawer header exposes an explicit back control", () => {
  assert.match(taskDrawerSectionsSource, /ArrowLeftIcon/);
  assert.match(taskDrawerSectionsSource, /BareIconButton/);
  assert.match(
    taskDrawerSectionsSource,
    /aria-label=\{copy\.t\("actions\.closeTaskDetails"\)\}/
  );
  assert.match(
    taskDrawerSectionsSource,
    /title=\{copy\.t\("actions\.closeTaskDetails"\)\}/
  );
  assert.match(taskDrawerSectionsSource, /onClick=\{onClose\}/);
});

test("task delete confirmation wraps long unbroken titles", () => {
  assert.match(
    taskDrawerSectionsSource,
    /<span className="block max-w-full whitespace-normal \[overflow-wrap:anywhere\]">/
  );
  assert.match(taskDrawerSectionsSource, /description=\{\s*<span/);
});

test("clamped issue and task titles expose the full text in shared tooltips", () => {
  assert.match(
    titleTooltipSource,
    /const TRUNCATED_TITLE_TOOLTIP_DELAY_MS = 300;/
  );
  assert.match(
    titleTooltipSource,
    /<Tooltip delayDuration=\{TRUNCATED_TITLE_TOOLTIP_DELAY_MS\}>/
  );
  assert.match(titleTooltipSource, /TooltipTrigger asChild/);
  assert.match(titleTooltipSource, /TooltipContent/);
  assert.match(titleTooltipSource, /\[overflow-wrap:anywhere\]/);
  assert.match(
    taskDrawerSectionsSource,
    /<IssueManagerTitleTooltip title=\{view\.title\}>/
  );
  assert.match(
    issueManagerPanelsSource,
    /<IssueManagerTitleTooltip title=\{selectedIssue\.title\}>/
  );
  assert.match(
    issueManagerIssueSectionsSource,
    /<IssueManagerTitleTooltip title=\{task\.title\}>/
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
