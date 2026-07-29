import type {
  IssueManagerIssueDetail,
  IssueManagerListIssuesResult,
  IssueManagerNodeState,
  IssueManagerPriority,
  IssueManagerTaskDetail
} from "../../contracts/index.ts";
import { normalizeIssueManagerContent } from "../../core/index.ts";
import type { IssueManagerEditorMode } from "./model.ts";
import type { IssueDraft, TaskDraft } from "./controllerTypes.ts";
import {
  defaultTaskPriority,
  resolveIssueManagerSelectedIssueId,
  resolveIssueManagerSelectedTaskId
} from "./controllerUtils.ts";

export function createIssueManagerIssueDraftFromNodeState(
  state:
    | Pick<IssueManagerNodeState, "issueDraftContent" | "issueDraftTitle">
    | null
    | undefined
): IssueDraft {
  return {
    content: state?.issueDraftContent ?? "",
    title: state?.issueDraftTitle ?? ""
  };
}

export function createIssueManagerTaskDraftFromNodeState(
  state:
    | Pick<IssueManagerNodeState, "taskDraftContent" | "taskDraftTitle">
    | null
    | undefined,
  priority: IssueManagerPriority = defaultTaskPriority
): TaskDraft {
  return {
    content: state?.taskDraftContent ?? "",
    priority,
    title: state?.taskDraftTitle ?? ""
  };
}

export function applyIssueManagerIssueSelection(
  current: IssueManagerNodeState,
  issueId: string | null
): IssueManagerNodeState {
  return {
    ...current,
    selectedIssueId: issueId,
    selectedTaskId: null
  };
}

export function applyIssueManagerTaskSelection(
  current: IssueManagerNodeState,
  taskId: string | null
): IssueManagerNodeState {
  return {
    ...current,
    selectedTaskId: taskId
  };
}

export function applyIssueManagerIssueDeleted(
  current: IssueManagerNodeState
): IssueManagerNodeState {
  return {
    ...current,
    selectedIssueId: null,
    selectedTaskId: null
  };
}

export function applyIssueManagerTaskDeleted(
  current: IssueManagerNodeState
): IssueManagerNodeState {
  return {
    ...current,
    selectedTaskId: null
  };
}

export function applyIssueManagerSelectedAgentTargetId(
  current: IssueManagerNodeState,
  agentTargetId: string
): IssueManagerNodeState {
  return {
    ...current,
    selectedAgentTargetId: agentTargetId
  };
}

export function applyIssueManagerSelectedExecutionDirectory(
  current: IssueManagerNodeState,
  executionDirectory: string | null
): IssueManagerNodeState {
  return {
    ...current,
    selectedExecutionDirectory: executionDirectory?.trim() || null
  };
}

export function applyIssueManagerIssueListResultToNodeState(
  current: IssueManagerNodeState,
  result: Pick<IssueManagerListIssuesResult, "issues" | "nextPageToken">
): IssueManagerNodeState {
  return {
    ...current,
    issueListNextPageToken: result.nextPageToken ?? null,
    selectedIssueId: resolveIssueManagerSelectedIssueId(
      current.selectedIssueId,
      result.issues
    )
  };
}

export function applyIssueManagerIssueDetailResultToNodeState(
  current: IssueManagerNodeState,
  detail: Pick<IssueManagerIssueDetail, "tasks">
): IssueManagerNodeState {
  return {
    ...current,
    selectedTaskId: resolveIssueManagerSelectedTaskId(
      current.selectedTaskId,
      detail.tasks
    )
  };
}

export function syncIssueManagerIssueDraftFromDetail(
  current: IssueDraft,
  detail: IssueManagerIssueDetail | null,
  editorMode: IssueManagerEditorMode
): IssueDraft {
  if (editorMode !== "read") {
    return current;
  }
  return {
    ...(detail?.issue.budget === undefined
      ? {}
      : { budget: detail.issue.budget }),
    content: normalizeIssueManagerContent(detail?.issue.content ?? ""),
    dispatchPaused: detail?.issue.dispatchPaused ?? false,
    ...(detail?.issue.executionProfile === undefined
      ? {}
      : { executionProfile: detail.issue.executionProfile }),
    title: detail?.issue.title ?? ""
  };
}

export function syncIssueManagerTaskDraftFromDetail(
  current: TaskDraft,
  detail: IssueManagerTaskDetail | null,
  editorMode: IssueManagerEditorMode
): TaskDraft {
  if (editorMode !== "read") {
    return current;
  }
  return {
    ...(detail?.task.agentTargetId === undefined
      ? {}
      : { agentTargetId: detail.task.agentTargetId }),
    content: normalizeIssueManagerContent(detail?.task.content ?? ""),
    ...(detail?.task.dependencyTaskIds === undefined
      ? {}
      : { dependencyTaskIds: detail.task.dependencyTaskIds }),
    ...(detail?.task.executionDirectory === undefined
      ? {}
      : { executionDirectory: detail.task.executionDirectory }),
    ...(detail?.task.model === undefined ? {} : { model: detail.task.model }),
    ...(detail?.task.modelPlanId === undefined
      ? {}
      : { modelPlanId: detail.task.modelPlanId }),
    priority: detail?.task.priority ?? defaultTaskPriority,
    title: detail?.task.title ?? ""
  };
}

export function applyIssueManagerIssueEditorModeToNodeState(
  current: IssueManagerNodeState,
  editorMode: IssueManagerEditorMode
): IssueManagerNodeState {
  if (editorMode === "create") {
    return current;
  }
  return {
    ...current,
    issueDraftContent: null,
    issueDraftTitle: null
  };
}

export function applyIssueManagerTaskEditorModeToNodeState(
  current: IssueManagerNodeState,
  editorMode: IssueManagerEditorMode
): IssueManagerNodeState {
  if (editorMode === "create") {
    return current;
  }
  return {
    ...current,
    taskDraftContent: null,
    taskDraftTitle: null
  };
}

export function applyIssueManagerIssueSaved(
  current: IssueManagerNodeState,
  issueId: string
): IssueManagerNodeState {
  return {
    ...current,
    issueDraftContent: null,
    issueDraftTitle: null,
    selectedIssueId: issueId
  };
}

export function applyIssueManagerTaskSaved(
  current: IssueManagerNodeState,
  taskId: string
): IssueManagerNodeState {
  return {
    ...current,
    selectedTaskId: taskId,
    taskDraftContent: null,
    taskDraftTitle: null
  };
}

export function persistIssueManagerIssueDraftContent(
  current: IssueManagerNodeState,
  editorMode: IssueManagerEditorMode,
  content: string
): IssueManagerNodeState {
  if (editorMode !== "create") {
    return current;
  }
  return {
    ...current,
    issueDraftContent: content
  };
}

export function persistIssueManagerIssueDraftTitle(
  current: IssueManagerNodeState,
  editorMode: IssueManagerEditorMode,
  title: string
): IssueManagerNodeState {
  if (editorMode !== "create") {
    return current;
  }
  return {
    ...current,
    issueDraftTitle: title
  };
}

export function persistIssueManagerTaskDraftContent(
  current: IssueManagerNodeState,
  editorMode: IssueManagerEditorMode,
  content: string
): IssueManagerNodeState {
  if (editorMode !== "create") {
    return current;
  }
  return {
    ...current,
    taskDraftContent: content
  };
}

export function persistIssueManagerTaskDraftTitle(
  current: IssueManagerNodeState,
  editorMode: IssueManagerEditorMode,
  title: string
): IssueManagerNodeState {
  if (editorMode !== "create") {
    return current;
  }
  return {
    ...current,
    taskDraftTitle: title
  };
}
