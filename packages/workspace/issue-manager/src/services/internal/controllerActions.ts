import type { Dispatch, SetStateAction } from "react";
import type {
  IssueManagerContextRef,
  IssueManagerFileReference,
  IssueManagerIssueDetail,
  IssueManagerRun,
  IssueManagerNodeState,
  IssueManagerTaskDetail
} from "../../contracts/index.ts";
import {
  extractIssueManagerWorkspaceFileLinksFromContent,
  type IssueManagerFeature
} from "../../core/index.ts";
import type { IssueManagerI18nRuntime } from "../../i18n/issueManagerI18n.ts";
import type {
  IssueManagerEditorMode,
  IssueManagerReferenceTarget
} from "./model.ts";
import {
  applyIssueManagerControllerOutcome,
  createIssueManagerRunTaskSuccessOutcome,
  createIssueManagerSaveIssueSuccessOutcome,
  createIssueManagerSaveTaskSuccessOutcome,
  type IssueManagerControllerOutcome
} from "./controllerOutcomes.ts";
import {
  createIssueManagerAttachReferencesOutcome,
  createIssueManagerInsertReferencesOutcome,
  createIssueManagerOpenReferencePickerOutcome
} from "./reference/controllerReferenceOutcomes.ts";
import {
  createIssueManagerRunTaskPlan,
  createIssueManagerSaveIssuePlan,
  createIssueManagerSaveTaskPlan
} from "./controllerPlans.ts";
import {
  createIssueManagerAttachReferencesPlan,
  createIssueManagerInsertReferenceTarget,
  createIssueManagerInsertReferencesPlan
} from "./reference/controllerReferencePlans.ts";
import {
  canIssueManagerOpenReferences,
  canIssueManagerRequestReferencesDirectly,
  canIssueManagerUploadReferences,
  executeIssueManagerAttachReferences,
  executeIssueManagerOpenReference,
  executeIssueManagerRequestReferences,
  executeIssueManagerRemoveContextRef,
  executeIssueManagerUploadReferences
} from "./reference/controllerReferenceCommands.ts";
import { executeIssueManagerRunTask } from "./run/controllerRunCommands.ts";
import {
  executeIssueManagerSaveIssue,
  executeIssueManagerSaveTask
} from "./save/controllerSaveCommands.ts";
import {
  canIssueManagerCreateShareLink,
  executeIssueManagerShareSelection
} from "./share/controllerShareCommands.ts";
import type {
  IssueDraft,
  IssueManagerNotificationTone,
  TaskDraft
} from "./controllerTypes.ts";
import {
  confirmIssueManagerMessage,
  defaultTaskPriority,
  resolveIssueManagerErrorMessage
} from "./controllerUtils.ts";
import {
  applyIssueManagerIssueDeleted,
  applyIssueManagerSelectedAgentProvider,
  applyIssueManagerSelectedExecutionDirectory,
  applyIssueManagerTaskDeleted
} from "./controllerState.ts";
import {
  trackIssueManagerAnalytics,
  trackIssueManagerContextRefsAdded
} from "./controllerAnalytics.ts";

interface CreateIssueManagerControllerActionsInput {
  copy: IssueManagerI18nRuntime;
  feature: IssueManagerFeature;
  issueDetail: {
    value: IssueManagerIssueDetail | null;
  };
  issueDraft: IssueDraft;
  issueEditorMode: IssueManagerEditorMode;
  nodeState: IssueManagerNodeState;
  referenceTarget: IssueManagerReferenceTarget | null;
  refreshAll: () => void;
  refreshDetails: () => void;
  setNotification: (input: {
    title: string;
    tone?: IssueManagerNotificationTone;
  }) => void;
  setIsRunningTask: Dispatch<SetStateAction<boolean>>;
  setIssueDraftInternal: Dispatch<SetStateAction<IssueDraft>>;
  setIssueEditorModeState: Dispatch<SetStateAction<IssueManagerEditorMode>>;
  setReferenceTarget: Dispatch<
    SetStateAction<IssueManagerReferenceTarget | null>
  >;
  setTaskDraftInternal: Dispatch<SetStateAction<TaskDraft>>;
  setTaskEditorModeState: Dispatch<SetStateAction<IssueManagerEditorMode>>;
  taskDetail: {
    value: IssueManagerTaskDetail | null;
  };
  taskDraft: TaskDraft;
  taskEditorMode: IssueManagerEditorMode;
  updateNodeState: (
    updater:
      | Partial<IssueManagerNodeState>
      | ((current: IssueManagerNodeState) => IssueManagerNodeState)
  ) => void;
  workspaceId: string;
}

interface IssueManagerDeleteOptions {
  skipConfirmation?: boolean;
}

export type { IssueManagerDeleteOptions };

export function createIssueManagerControllerActions(
  input: CreateIssueManagerControllerActionsInput
) {
  const {
    copy,
    feature,
    issueDetail,
    issueDraft,
    issueEditorMode,
    nodeState,
    referenceTarget,
    refreshAll,
    refreshDetails,
    setNotification,
    setIsRunningTask,
    setIssueDraftInternal,
    setIssueEditorModeState,
    setReferenceTarget,
    setTaskDraftInternal,
    setTaskEditorModeState,
    taskDetail,
    taskDraft,
    taskEditorMode,
    updateNodeState,
    workspaceId
  } = input;

  const notifyTip = (
    message: string,
    tone: IssueManagerNotificationTone = "destructive"
  ) => {
    setNotification({
      title: message,
      tone
    });
  };

  const notifyError = (error: unknown, fallbackKey: string) => {
    setNotification({
      title: resolveIssueManagerErrorMessage(error, copy, fallbackKey),
      tone: "destructive"
    });
  };

  const applyOutcome = (outcome: IssueManagerControllerOutcome) => {
    applyIssueManagerControllerOutcome({
      notify: notifyTip,
      outcome,
      refreshAll,
      refreshDetails,
      setIssueDraftInternal,
      setIssueEditorModeState,
      setReferenceTarget: (target) => setReferenceTarget(target),
      setTaskDraftInternal,
      setTaskEditorModeState,
      translate: (key) => copy.t(key),
      updateNodeState
    });
  };

  const submitReferences = async (
    refs: IssueManagerFileReference[],
    target: IssueManagerReferenceTarget | null = referenceTarget
  ) => {
    if (!target) {
      applyOutcome({
        referenceTarget: null
      });
      return;
    }

    if (target.mode === "insert") {
      applyOutcome(
        createIssueManagerInsertReferencesOutcome({
          refs,
          target
        })
      );
      trackIssueManagerContextRefsAdded({
        feature,
        refs,
        targetType: target.parentKind
      });
      return;
    }

    const attached = await executeIssueManagerAttachReferences({
      backend: feature.backend,
      refs,
      selectedIssueId: nodeState.selectedIssueId,
      target,
      workspaceId
    });
    if (attached) {
      trackIssueManagerContextRefsAdded({
        feature,
        refs,
        targetType: target.parentKind
      });
    }
    applyOutcome(createIssueManagerAttachReferencesOutcome(attached));
  };

  const updateTaskStatus = async (
    taskId: string | null | undefined,
    status: "completed" | "not_started",
    options: { selectTaskOnSuccess: boolean }
  ) => {
    const selectedIssueId = nodeState.selectedIssueId;
    const normalizedTaskId = taskId?.trim() ?? "";
    if (!selectedIssueId || !normalizedTaskId) {
      return;
    }

    try {
      const task = await feature.backend.updateTask({
        issueId: selectedIssueId,
        status,
        taskId: normalizedTaskId,
        workspaceId
      });
      applyOutcome(
        options.selectTaskOnSuccess
          ? createIssueManagerSaveTaskSuccessOutcome(task.taskId)
          : {
              refreshAll: true
            }
      );
    } catch (error) {
      notifyError(error, "messages.taskSaveFailed");
    }
  };

  return {
    async attachReferences(parentKind: "issue" | "task") {
      const fileAdapter = feature.fileAdapter;
      const attachPlan = createIssueManagerAttachReferencesPlan({
        hasFileAdapter: Boolean(fileAdapter),
        parentKind,
        requestReferencesDirectly:
          canIssueManagerRequestReferencesDirectly(fileAdapter),
        selectedTaskId: nodeState.selectedTaskId
      });
      if (attachPlan.kind === "skip") {
        return;
      }
      if (attachPlan.kind === "request_directly") {
        if (!canIssueManagerRequestReferencesDirectly(fileAdapter)) {
          return;
        }
        const refs = await executeIssueManagerRequestReferences({
          fileAdapter,
          workspaceId
        });
        await submitReferences(refs, attachPlan.target);
        return;
      }

      applyOutcome(
        createIssueManagerOpenReferencePickerOutcome(attachPlan.target)
      );
    },

    createTaskDraft() {
      setTaskEditorModeState("create");
      setTaskDraftInternal({
        content: nodeState.taskDraftContent ?? "",
        priority: defaultTaskPriority,
        title: nodeState.taskDraftTitle ?? ""
      });
      updateNodeState((current) => ({
        ...current,
        selectedTaskId: null
      }));
    },

    async deleteIssue(options?: IssueManagerDeleteOptions) {
      const selectedIssueId = nodeState.selectedIssueId;
      if (
        !selectedIssueId ||
        (options?.skipConfirmation !== true &&
          !confirmIssueManagerMessage(copy.t("confirmations.deleteIssue")))
      ) {
        return;
      }
      try {
        await feature.backend.deleteIssue({
          issueId: selectedIssueId,
          workspaceId
        });
        trackIssueManagerAnalytics(feature, {
          name: "issue_manager.issue_deleted",
          params: { issueId: selectedIssueId }
        });
        setIssueEditorModeState("read");
        setTaskEditorModeState("read");
        updateNodeState((current) => applyIssueManagerIssueDeleted(current));
        refreshAll();
      } catch (error) {
        notifyError(error, "messages.issueDeleteFailed");
      }
    },

    async deleteTask(options?: IssueManagerDeleteOptions) {
      const selectedIssueId = nodeState.selectedIssueId;
      const selectedTaskId = nodeState.selectedTaskId;
      if (
        !selectedIssueId ||
        !selectedTaskId ||
        (options?.skipConfirmation !== true &&
          !confirmIssueManagerMessage(copy.t("confirmations.deleteTask")))
      ) {
        return;
      }

      try {
        await feature.backend.deleteTask({
          issueId: selectedIssueId,
          taskId: selectedTaskId,
          workspaceId
        });
        trackIssueManagerAnalytics(feature, {
          name: "issue_manager.task_deleted",
          params: { issueId: selectedIssueId, taskId: selectedTaskId }
        });
        setTaskEditorModeState("read");
        updateNodeState((current) => applyIssueManagerTaskDeleted(current));
        refreshAll();
      } catch (error) {
        notifyError(error, "messages.taskDeleteFailed");
      }
    },

    async insertReferences(parentKind: "issue" | "task") {
      const fileAdapter = feature.fileAdapter;
      const insertPlan = createIssueManagerInsertReferencesPlan({
        hasFileAdapter: Boolean(fileAdapter),
        parentKind,
        requestReferencesDirectly:
          canIssueManagerRequestReferencesDirectly(fileAdapter),
        selectedTaskId: nodeState.selectedTaskId,
        taskEditorMode
      });
      if (insertPlan.kind === "skip") {
        return;
      }
      if (insertPlan.kind === "request_directly") {
        if (!canIssueManagerRequestReferencesDirectly(fileAdapter)) {
          return;
        }
        const refs = await executeIssueManagerRequestReferences({
          fileAdapter,
          workspaceId
        });
        await submitReferences(refs, insertPlan.target);
        return;
      }

      applyOutcome(
        createIssueManagerOpenReferencePickerOutcome(insertPlan.target)
      );
    },

    async uploadReferences(
      parentKind: "issue" | "task",
      mode: "files" | "folder"
    ) {
      const fileAdapter = feature.fileAdapter;
      if (!canIssueManagerUploadReferences(fileAdapter)) {
        return;
      }

      const refs = await executeIssueManagerUploadReferences({
        fileAdapter,
        mode,
        workspaceId
      });
      if (refs.length === 0) {
        return;
      }
      await submitReferences(
        refs,
        createIssueManagerInsertReferenceTarget(
          parentKind,
          nodeState.selectedTaskId
        )
      );
    },

    async openReference(reference: IssueManagerFileReference) {
      const fileAdapter = feature.fileAdapter;
      if (!canIssueManagerOpenReferences(fileAdapter)) {
        return;
      }

      await executeIssueManagerOpenReference({
        fileAdapter,
        reference
      });
    },

    async openAgentSession(run: IssueManagerRun) {
      const agentSessionId = run.agentSessionId?.trim() ?? "";
      if (!agentSessionId || !feature.agentSessionOpener?.openSession) {
        return;
      }

      try {
        await feature.agentSessionOpener.openSession({
          agentSessionId,
          provider: run.agentProvider,
          workspaceId
        });
      } catch (error) {
        notifyTip(
          resolveIssueManagerErrorMessage(
            error,
            copy,
            "messages.agentSessionOpenFailed"
          )
        );
      }
    },

    async removeContextRef(ref: IssueManagerContextRef) {
      try {
        await executeIssueManagerRemoveContextRef({
          backend: feature.backend,
          ref,
          workspaceId
        });
        trackIssueManagerAnalytics(feature, {
          name: "issue_manager.context_ref_removed",
          params: {
            targetType: ref.parentKind
          }
        });
        refreshDetails();
      } catch (error) {
        notifyError(error, "messages.referenceRemoveFailed");
      }
    },

    async useExecutionDirectory(path: string | null) {
      const executionDirectory = path?.trim() || null;
      updateNodeState((current) =>
        applyIssueManagerSelectedExecutionDirectory(current, executionDirectory)
      );
      if (!executionDirectory) {
        return;
      }

      try {
        await feature.executionDirectoryPicker?.use?.({
          path: executionDirectory
        });
      } catch {
        // The selected directory is still valid even if recency tracking fails.
      }
    },

    async runTask(providerOverride?: string) {
      const runPlan = createIssueManagerRunTaskPlan({
        issueDetail: issueDetail.value,
        providerOverride,
        selectedAgentProvider: nodeState.selectedAgentProvider,
        taskDetail: taskDetail.value
      });
      if (runPlan.kind !== "ready") {
        return;
      }
      const currentIssueDetail = issueDetail.value;
      const currentTaskDetail = taskDetail.value;
      if (!currentIssueDetail) {
        return;
      }
      if (runPlan.shouldUpdateSelectedAgentProvider) {
        updateNodeState((current) =>
          applyIssueManagerSelectedAgentProvider(current, runPlan.provider)
        );
      }

      setIsRunningTask(true);
      try {
        trackIssueManagerAnalytics(feature, {
          name: "issue_manager.task_run_initiated",
          params: {
            hasExecutionDirectory: Boolean(
              nodeState.selectedExecutionDirectory?.trim()
            ),
            issueId: currentIssueDetail.issue.issueId,
            provider: runPlan.provider,
            taskId: currentTaskDetail?.task.taskId ?? null
          }
        });
        const result = await executeIssueManagerRunTask({
          feature,
          issue: currentIssueDetail.issue,
          provider: runPlan.provider,
          executionDirectory: nodeState.selectedExecutionDirectory,
          task: currentTaskDetail?.task,
          workspaceId
        });
        const outcome = createIssueManagerRunTaskSuccessOutcome({
          status: result.status
        });
        if (outcome.notificationKey && result.errorMessage?.trim()) {
          notifyTip(result.errorMessage.trim());
        } else {
          applyOutcome(outcome);
        }
      } catch (error) {
        notifyTip(
          resolveIssueManagerErrorMessage(error, copy, "messages.runFailed")
        );
      } finally {
        setIsRunningTask(false);
        refreshDetails();
      }
    },

    async startTaskBreakdown(providerOverride?: string) {
      const breakdownPlan = createIssueManagerRunTaskPlan({
        issueDetail: issueDetail.value,
        providerOverride,
        selectedAgentProvider: nodeState.selectedAgentProvider,
        taskDetail: taskDetail.value
      });
      if (breakdownPlan.kind !== "ready") {
        return;
      }
      const currentIssueDetail = issueDetail.value;
      if (!currentIssueDetail) {
        return;
      }
      const breakdownLauncher = feature.agentBreakdownLauncher;
      if (!breakdownLauncher) {
        notifyTip(copy.t("messages.breakdownUnavailable"));
        return;
      }
      if (breakdownPlan.shouldUpdateSelectedAgentProvider) {
        updateNodeState((current) =>
          applyIssueManagerSelectedAgentProvider(
            current,
            breakdownPlan.provider
          )
        );
      }

      setIsRunningTask(true);
      try {
        trackIssueManagerAnalytics(feature, {
          name: "issue_manager.issue_breakdown_initiated",
          params: {
            issueId: currentIssueDetail.issue.issueId,
            provider: breakdownPlan.provider
          }
        });
        const result = await breakdownLauncher.startBreakdown({
          ...(nodeState.selectedExecutionDirectory?.trim()
            ? {
                executionDirectory: nodeState.selectedExecutionDirectory.trim()
              }
            : {}),
          issueDetail: currentIssueDetail,
          provider: breakdownPlan.provider,
          workspaceId
        });
        if (result.status === "failed") {
          notifyTip(
            result.errorMessage || copy.t("messages.breakdownOpenFailed")
          );
        }
      } catch (error) {
        notifyTip(
          resolveIssueManagerErrorMessage(
            error,
            copy,
            "messages.breakdownOpenFailed"
          )
        );
      } finally {
        setIsRunningTask(false);
      }
    },

    async saveIssue() {
      const savePlan = createIssueManagerSaveIssuePlan({
        activeTopicId: nodeState.activeTopicId ?? null,
        issueDraft
      });
      if (savePlan.kind === "blocked") {
        notifyTip(copy.t(savePlan.notificationKey));
        return;
      }

      try {
        const wasCreate = issueEditorMode === "create";
        const { content, removedContextRefs, savedIssue } =
          await executeIssueManagerSaveIssue({
            activeTopicId: savePlan.activeTopicId,
            feature,
            issueDetail: issueDetail.value,
            issueDraft,
            issueEditorMode,
            selectedIssueId: nodeState.selectedIssueId,
            workspaceId
          });
        if (wasCreate) {
          trackIssueManagerAnalytics(feature, {
            name: "issue_manager.issue_created",
            params: { issueId: savedIssue.issueId }
          });
        } else {
          trackIssueManagerAnalytics(feature, {
            name: "issue_manager.issue_saved",
            params: {
              contextRefCount: countIssueManagerContextRefs({
                content,
                refs: removeIssueManagerContextRefsFromCount(
                  issueDetail.value?.contextRefs.filter(
                    (ref) => ref.parentKind === "issue"
                  ),
                  removedContextRefs
                )
              }),
              hasDescription: hasIssueManagerDescription(content),
              issueId: savedIssue.issueId,
              taskCount: issueDetail.value?.tasks.length ?? 0
            }
          });
        }
        const outcome = createIssueManagerSaveIssueSuccessOutcome(
          savedIssue.issueId
        );
        applyOutcome(outcome);
      } catch (error) {
        notifyError(error, "messages.issueSaveFailed");
      }
    },

    async saveTask() {
      const savePlan = createIssueManagerSaveTaskPlan({
        selectedIssueId: nodeState.selectedIssueId,
        taskDraft
      });
      if (savePlan.kind === "skip") {
        return;
      }
      if (savePlan.kind === "blocked") {
        notifyTip(copy.t(savePlan.notificationKey));
        return;
      }

      try {
        const wasCreate = taskEditorMode === "create";
        const { content, removedContextRefs, savedTask } =
          await executeIssueManagerSaveTask({
            feature,
            selectedIssueId: savePlan.selectedIssueId,
            selectedTaskId: nodeState.selectedTaskId,
            taskDetail: taskDetail.value,
            taskDraft,
            taskEditorMode,
            workspaceId
          });
        if (wasCreate) {
          trackIssueManagerAnalytics(feature, {
            name: "issue_manager.task_created",
            params: {
              issueId: savePlan.selectedIssueId,
              taskId: savedTask.taskId
            }
          });
        } else {
          trackIssueManagerAnalytics(feature, {
            name: "issue_manager.task_saved",
            params: {
              contextRefCount: countIssueManagerContextRefs({
                content,
                refs: removeIssueManagerContextRefsFromCount(
                  taskDetail.value?.contextRefs.filter(
                    (ref) => ref.parentKind === "task"
                  ),
                  removedContextRefs
                )
              }),
              hasDescription: hasIssueManagerDescription(content),
              issueId: savePlan.selectedIssueId,
              taskId: savedTask.taskId
            }
          });
        }
        const outcome = createIssueManagerSaveTaskSuccessOutcome(
          savedTask.taskId
        );
        applyOutcome(outcome);
      } catch (error) {
        notifyError(error, "messages.taskSaveFailed");
      }
    },

    async setTaskStatus(taskId: string, status: "completed" | "not_started") {
      await updateTaskStatus(taskId, status, { selectTaskOnSuccess: false });
    },

    async setSelectedTaskStatus(status: "completed" | "not_started") {
      await updateTaskStatus(nodeState.selectedTaskId, status, {
        selectTaskOnSuccess: true
      });
    },

    async shareSelection() {
      const selectedIssueId = nodeState.selectedIssueId;
      const shareAdapter = feature.shareAdapter;
      if (!canIssueManagerCreateShareLink(shareAdapter) || !selectedIssueId) {
        return;
      }

      try {
        await executeIssueManagerShareSelection({
          issueId: selectedIssueId,
          shareAdapter,
          taskId: nodeState.selectedTaskId,
          workspaceId
        });
      } catch (error) {
        notifyError(error, "messages.copyShareLinkFailed");
      }
    },

    async submitReferenceSelection(refs: IssueManagerFileReference[]) {
      await submitReferences(refs);
    }
  };
}

function hasIssueManagerDescription(content: string): boolean {
  return content.trim().length > 0;
}

function countIssueManagerContextRefs(input: {
  content: string;
  refs?: readonly { path: string }[];
}): number {
  const paths = new Set<string>();
  for (const ref of input.refs ?? []) {
    const path = ref.path.trim();
    if (path) {
      paths.add(path);
    }
  }
  for (const ref of extractIssueManagerWorkspaceFileLinksFromContent(
    input.content
  )) {
    const path = ref.path.trim();
    if (path) {
      paths.add(path);
    }
  }
  return paths.size;
}

function removeIssueManagerContextRefsFromCount<
  T extends { contextRefId: string }
>(
  refs: readonly T[] | undefined,
  removedRefs: readonly { contextRefId: string }[]
): T[] {
  if (!refs?.length || removedRefs.length === 0) {
    return [...(refs ?? [])];
  }
  const removedIDs = new Set(removedRefs.map((ref) => ref.contextRefId));
  return refs.filter((ref) => !removedIDs.has(ref.contextRefId));
}
