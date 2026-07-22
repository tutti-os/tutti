import type {
  IssueManagerContextRef,
  IssueManagerFileReference,
  IssueManagerIssueDetail,
  IssueManagerIssueSummary,
  IssueManagerTaskDetail,
  IssueManagerTaskSummary
} from "../../../contracts/index.ts";
import {
  extractIssueManagerWorkspaceFileLinksFromContent,
  normalizeIssueManagerContent,
  type IssueManagerFeature
} from "../../../core/index.ts";
import type { IssueManagerEditorMode } from "../model.ts";
import type { IssueDraft, TaskDraft } from "../controllerTypes.ts";

export async function executeIssueManagerSaveIssue(input: {
  activeTopicId: string;
  feature: IssueManagerFeature;
  issueDetail: IssueManagerIssueDetail | null;
  issueDraft: IssueDraft;
  issueEditorMode: IssueManagerEditorMode;
  selectedIssueId: string | null;
  workspaceId: string;
}): Promise<{
  addedContextRefs: IssueManagerFileReference[];
  content: string;
  removedContextRefs: IssueManagerContextRef[];
  savedIssue: IssueManagerIssueSummary;
}> {
  const content = normalizeIssueManagerContent(input.issueDraft.content);
  const savedIssue =
    input.issueEditorMode === "create"
      ? await input.feature.backend.createIssue({
          ...(input.issueDraft.budget === undefined
            ? {}
            : { budget: input.issueDraft.budget }),
          content,
          ...(input.issueDraft.executionProfile === undefined
            ? {}
            : { executionProfile: input.issueDraft.executionProfile }),
          title: input.issueDraft.title.trim(),
          topicId: input.activeTopicId,
          workspaceId: input.workspaceId
        })
      : await input.feature.backend.updateIssue({
          ...(input.issueDraft.budget === undefined
            ? {}
            : { budget: input.issueDraft.budget }),
          content,
          dispatchPaused: input.issueDraft.dispatchPaused ?? false,
          ...(input.issueDraft.executionProfile === undefined
            ? {}
            : { executionProfile: input.issueDraft.executionProfile }),
          issueId: input.selectedIssueId ?? "",
          title: input.issueDraft.title.trim(),
          workspaceId: input.workspaceId
        });

  const { addedContextRefs, removedContextRefs } =
    await syncIssueManagerContentReferences({
      backend: input.feature.backend,
      content,
      existingRefs:
        input.issueEditorMode === "create"
          ? []
          : (input.issueDetail?.contextRefs.filter(
              (ref) => ref.parentKind === "issue"
            ) ?? []),
      issueId: savedIssue.issueId,
      parentKind: "issue",
      previousContent:
        input.issueEditorMode === "create"
          ? ""
          : (input.issueDetail?.issue.content ?? ""),
      workspaceId: input.workspaceId
    });

  return {
    addedContextRefs,
    content,
    removedContextRefs,
    savedIssue
  };
}

export async function executeIssueManagerSaveTask(input: {
  feature: IssueManagerFeature;
  selectedIssueId: string;
  selectedTaskId: string | null;
  taskDetail: IssueManagerTaskDetail | null;
  taskDraft: TaskDraft;
  taskEditorMode: IssueManagerEditorMode;
  workspaceId: string;
}): Promise<{
  addedContextRefs: IssueManagerFileReference[];
  content: string;
  removedContextRefs: IssueManagerContextRef[];
  savedTask: IssueManagerTaskSummary;
}> {
  const content = normalizeIssueManagerContent(input.taskDraft.content);
  const savedTask =
    input.taskEditorMode === "create"
      ? await input.feature.backend.createTask({
          ...(input.taskDraft.agentTargetId === undefined
            ? {}
            : { agentTargetId: input.taskDraft.agentTargetId }),
          content,
          ...(input.taskDraft.dependencyTaskIds === undefined
            ? {}
            : { dependencyTaskIds: input.taskDraft.dependencyTaskIds }),
          ...(input.taskDraft.executionDirectory === undefined
            ? {}
            : { executionDirectory: input.taskDraft.executionDirectory }),
          issueId: input.selectedIssueId,
          ...(input.taskDraft.model === undefined
            ? {}
            : { model: input.taskDraft.model }),
          ...(input.taskDraft.modelPlanId === undefined
            ? {}
            : { modelPlanId: input.taskDraft.modelPlanId }),
          priority: input.taskDraft.priority,
          title: input.taskDraft.title.trim(),
          workspaceId: input.workspaceId
        })
      : await input.feature.backend.updateTask({
          ...(input.taskDraft.agentTargetId === undefined
            ? {}
            : { agentTargetId: input.taskDraft.agentTargetId }),
          content,
          ...(input.taskDraft.dependencyTaskIds === undefined
            ? {}
            : { dependencyTaskIds: input.taskDraft.dependencyTaskIds }),
          ...(input.taskDraft.executionDirectory === undefined
            ? {}
            : { executionDirectory: input.taskDraft.executionDirectory }),
          issueId: input.selectedIssueId,
          ...(input.taskDraft.model === undefined
            ? {}
            : { model: input.taskDraft.model }),
          ...(input.taskDraft.modelPlanId === undefined
            ? {}
            : { modelPlanId: input.taskDraft.modelPlanId }),
          priority: input.taskDraft.priority,
          taskId: input.selectedTaskId ?? "",
          title: input.taskDraft.title.trim(),
          workspaceId: input.workspaceId
        });

  const { addedContextRefs, removedContextRefs } =
    await syncIssueManagerContentReferences({
      backend: input.feature.backend,
      content,
      existingRefs:
        input.taskEditorMode === "create"
          ? []
          : (input.taskDetail?.contextRefs.filter(
              (ref) => ref.parentKind === "task"
            ) ?? []),
      issueId: input.selectedIssueId,
      parentKind: "task",
      previousContent:
        input.taskEditorMode === "create"
          ? ""
          : (input.taskDetail?.task.content ?? ""),
      taskId: savedTask.taskId,
      workspaceId: input.workspaceId
    });

  return {
    addedContextRefs,
    content,
    removedContextRefs,
    savedTask
  };
}

interface IssueManagerContentReferenceSyncResult {
  addedContextRefs: IssueManagerFileReference[];
  removedContextRefs: IssueManagerContextRef[];
}

async function syncIssueManagerContentReferences(input: {
  backend: IssueManagerFeature["backend"];
  content: string;
  existingRefs: IssueManagerContextRef[];
  issueId: string;
  parentKind: "issue" | "task";
  previousContent: string;
  taskId?: string;
  workspaceId: string;
}): Promise<IssueManagerContentReferenceSyncResult> {
  const existingPaths = new Set(
    input.existingRefs
      .map((ref) => ref.path.trim())
      .filter((path) => path.length > 0)
  );
  const contentRefs = extractIssueManagerWorkspaceFileLinksFromContent(
    input.content
  );
  const contentPaths = new Set(
    contentRefs.map((ref) => ref.path.trim()).filter((path) => path.length > 0)
  );
  const previousContentPaths = new Set(
    extractIssueManagerWorkspaceFileLinksFromContent(input.previousContent)
      .map((ref) => ref.path.trim())
      .filter((path) => path.length > 0)
  );
  const addedContextRefs = contentRefs.filter((ref) => {
    const path = ref.path.trim();
    return path.length > 0 && !existingPaths.has(path);
  });
  const removedContextRefs = input.existingRefs.filter((ref) => {
    const path = ref.path.trim();
    return previousContentPaths.has(path) && !contentPaths.has(path);
  });
  const missingRefs = addedContextRefs.map((ref) => ({
    displayName: ref.name,
    path: ref.path,
    refType: ref.kind
  }));

  if (missingRefs.length > 0) {
    await input.backend.addContextRefs(
      input.parentKind === "task"
        ? {
            issueId: input.issueId,
            parentKind: "task",
            refs: missingRefs,
            taskId: input.taskId ?? "",
            workspaceId: input.workspaceId
          }
        : {
            issueId: input.issueId,
            parentKind: "issue",
            refs: missingRefs,
            workspaceId: input.workspaceId
          }
    );
  }

  for (const ref of removedContextRefs) {
    await input.backend.removeContextRef(
      ref.parentKind === "task"
        ? {
            contextRefId: ref.contextRefId,
            issueId: ref.issueId,
            parentKind: "task",
            taskId: ref.taskId,
            workspaceId: input.workspaceId
          }
        : {
            contextRefId: ref.contextRefId,
            issueId: ref.issueId,
            parentKind: "issue",
            workspaceId: input.workspaceId
          }
    );
  }

  return {
    addedContextRefs: addedContextRefs.map((ref) => ({
      displayName: ref.name,
      kind: ref.kind,
      path: ref.path
    })),
    removedContextRefs
  };
}
