import type { Dispatch, SetStateAction } from "react";
import type {
  IssueManagerContextRef,
  IssueManagerFileReference,
  IssueManagerIssueDetail,
  IssueManagerReferenceBundle,
  IssueManagerRun,
  IssueManagerNodeState,
  IssueManagerStatus,
  IssueManagerTaskDetail,
  IssueManagerTaskSummary,
  IssueManagerTaskStatusUpdate
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
  createIssueManagerInsertReferenceBundlesOutcome,
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
  applyIssueManagerSelectedAgentTargetId,
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

export interface IssueManagerMoveTaskInput {
  targetIndex: number;
  targetStatus: IssueManagerStatus;
  taskId: string;
  visibleTaskIds?: readonly string[];
}

export type { IssueManagerDeleteOptions };

function resolveIssueManagerTaskStatusBucket(
  status: IssueManagerStatus
): string {
  return status;
}

function resolveIssueManagerMovedTaskOrder(input: {
  targetIndex: number;
  targetStatus: IssueManagerStatus;
  taskId: string;
  tasks: readonly IssueManagerTaskSummary[];
}): IssueManagerTaskSummary[] | null {
  const normalizedTaskId = input.taskId.trim();
  const targetStatus = resolveIssueManagerTaskStatusBucket(input.targetStatus);
  const sourceTask = input.tasks.find(
    (task) => task.taskId === normalizedTaskId
  );
  if (!sourceTask || !targetStatus) {
    return null;
  }

  const tasksWithoutMoved = input.tasks.filter(
    (task) => task.taskId !== normalizedTaskId
  );
  const targetTasks = tasksWithoutMoved.filter(
    (task) => resolveIssueManagerTaskStatusBucket(task.status) === targetStatus
  );
  const targetIndex = Math.min(
    Math.max(0, Math.trunc(input.targetIndex)),
    targetTasks.length
  );
  const targetTaskAtIndex = targetTasks[targetIndex];
  const previousTargetTask = targetTasks[targetIndex - 1];
  const sourceStatus =
    resolveIssueManagerTaskStatusBucket(sourceTask.status) === targetStatus
      ? sourceTask.status
      : input.targetStatus;
  const nextTask = {
    ...sourceTask,
    status: sourceStatus
  };
  const insertIndex = targetTaskAtIndex
    ? tasksWithoutMoved.findIndex(
        (task) => task.taskId === targetTaskAtIndex.taskId
      )
    : previousTargetTask
      ? tasksWithoutMoved.findIndex(
          (task) => task.taskId === previousTargetTask.taskId
        ) + 1
      : tasksWithoutMoved.length;

  const normalizedInsertIndex =
    insertIndex < 0 ? tasksWithoutMoved.length : insertIndex;
  return [
    ...tasksWithoutMoved.slice(0, normalizedInsertIndex),
    nextTask,
    ...tasksWithoutMoved.slice(normalizedInsertIndex)
  ];
}

/**
 * Resolves the execution directory (project path) to run a task/breakdown in.
 *
 * The user's explicit per-issue selection (`selectedExecutionDirectory`)
 * always wins. Otherwise this falls back to the same remembered "default
 * project" that ad-hoc new agent-GUI sessions use, so a task run/breakdown
 * launched without the user ever touching the execution-directory picker
 * still gets associated with a real project instead of silently landing in
 * the agent runtime's internal session-storage directory (which then shows
 * up as the session's project path in both the session window and the
 * message center).
 */
async function resolveIssueManagerExecutionDirectory(input: {
  feature: IssueManagerFeature;
  selectedExecutionDirectory: string | null | undefined;
}): Promise<string | null> {
  const selected = input.selectedExecutionDirectory?.trim();
  if (selected) {
    return selected;
  }
  try {
    const defaultSelection =
      await input.feature.executionDirectoryPicker?.service?.getDefaultSelection?.();
    return defaultSelection?.path?.trim() || null;
  } catch {
    return null;
  }
}

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
    status: IssueManagerTaskStatusUpdate,
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

    async moveTask(move: IssueManagerMoveTaskInput) {
      const selectedIssueId = nodeState.selectedIssueId;
      const normalizedTaskId = move.taskId.trim();
      const allTasks = issueDetail.value?.tasks ?? [];
      const visibleTaskIds = new Set(
        move.visibleTaskIds
          ?.map((taskId) => taskId.trim())
          .filter((taskId) => taskId.length > 0)
      );
      const currentTasks =
        visibleTaskIds.size > 0
          ? allTasks.filter((task) => visibleTaskIds.has(task.taskId))
          : allTasks;
      if (!selectedIssueId || !normalizedTaskId || currentTasks.length === 0) {
        return;
      }

      const nextTasks = resolveIssueManagerMovedTaskOrder({
        targetIndex: move.targetIndex,
        targetStatus: move.targetStatus,
        taskId: normalizedTaskId,
        tasks: currentTasks
      });
      if (!nextTasks) {
        return;
      }
      const nextVisibleTasks = [...nextTasks];
      const orderedTasks =
        visibleTaskIds.size > 0
          ? allTasks.map((task) =>
              visibleTaskIds.has(task.taskId)
                ? (nextVisibleTasks.shift() ?? task)
                : task
            )
          : nextTasks;

      const previousById = new Map(
        allTasks.map((task, index) => [
          task.taskId,
          {
            sortIndex: task.sortIndex ?? index + 1,
            status: task.status
          }
        ])
      );
      const updates = orderedTasks
        .map((task, index) => {
          const previous = previousById.get(task.taskId);
          const sortIndex = index + 1;
          if (
            previous &&
            previous.sortIndex === sortIndex &&
            previous.status === task.status
          ) {
            return null;
          }
          return {
            sortIndex,
            status: task.status,
            taskId: task.taskId
          };
        })
        .filter(
          (
            update
          ): update is {
            sortIndex: number;
            status: IssueManagerStatus;
            taskId: string;
          } => update !== null
        );
      if (updates.length === 0) {
        return;
      }

      try {
        await Promise.all(
          updates.map((update) =>
            feature.backend.updateTask({
              issueId: selectedIssueId,
              sortIndex: update.sortIndex,
              status: update.status,
              taskId: update.taskId,
              workspaceId
            })
          )
        );
        applyOutcome({
          refreshAll: true
        });
      } catch (error) {
        notifyError(error, "messages.taskSaveFailed");
      }
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
          agentTargetId: run.agentTargetId,
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

    async runTask(agentTargetIdOverride?: string) {
      const runPlan = createIssueManagerRunTaskPlan({
        agentTargetOptions: feature.agentTargetOptions?.getOptions(),
        agentTargetIdOverride,
        issueDetail: issueDetail.value,
        selectedAgentTargetId: nodeState.selectedAgentTargetId,
        taskDetail: taskDetail.value
      });
      if (runPlan.kind === "blocked") {
        notifyTip(copy.t(runPlan.notificationKey));
        return;
      }
      if (runPlan.kind !== "ready") {
        return;
      }
      const currentIssueDetail = issueDetail.value;
      const currentTaskDetail = taskDetail.value;
      if (!currentIssueDetail) {
        return;
      }
      if (runPlan.shouldUpdateSelectedAgentTargetId) {
        updateNodeState((current) =>
          applyIssueManagerSelectedAgentTargetId(current, runPlan.agentTargetId)
        );
      }

      setIsRunningTask(true);
      try {
        const executionDirectory = await resolveIssueManagerExecutionDirectory({
          feature,
          selectedExecutionDirectory: nodeState.selectedExecutionDirectory
        });
        trackIssueManagerAnalytics(feature, {
          name: "issue_manager.task_run_initiated",
          params: {
            hasExecutionDirectory: Boolean(executionDirectory),
            issueId: currentIssueDetail.issue.issueId,
            provider: runPlan.provider,
            taskId: currentTaskDetail?.task.taskId ?? null
          }
        });
        const result = await executeIssueManagerRunTask({
          agentTargetId: runPlan.agentTargetId,
          feature,
          issue: currentIssueDetail.issue,
          provider: runPlan.provider,
          executionDirectory,
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

    async startTaskBreakdown(agentTargetIdOverride?: string) {
      const breakdownPlan = createIssueManagerRunTaskPlan({
        agentTargetOptions: feature.agentTargetOptions?.getOptions(),
        agentTargetIdOverride,
        issueDetail: issueDetail.value,
        selectedAgentTargetId: nodeState.selectedAgentTargetId,
        taskDetail: taskDetail.value
      });
      if (breakdownPlan.kind === "blocked") {
        notifyTip(copy.t(breakdownPlan.notificationKey));
        return;
      }
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
      if (breakdownPlan.shouldUpdateSelectedAgentTargetId) {
        updateNodeState((current) =>
          applyIssueManagerSelectedAgentTargetId(
            current,
            breakdownPlan.agentTargetId
          )
        );
      }

      setIsRunningTask(true);
      try {
        const executionDirectory = await resolveIssueManagerExecutionDirectory({
          feature,
          selectedExecutionDirectory: nodeState.selectedExecutionDirectory
        });
        trackIssueManagerAnalytics(feature, {
          name: "issue_manager.issue_breakdown_initiated",
          params: {
            issueId: currentIssueDetail.issue.issueId,
            provider: breakdownPlan.provider
          }
        });
        const result = await breakdownLauncher.startBreakdown({
          agentTargetId: breakdownPlan.agentTargetId,
          ...(executionDirectory ? { executionDirectory } : {}),
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

    async setTaskStatus(taskId: string, status: IssueManagerTaskStatusUpdate) {
      await updateTaskStatus(taskId, status, { selectTaskOnSuccess: false });
    },

    async setSelectedTaskStatus(status: IssueManagerTaskStatusUpdate) {
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
    },

    async submitReferenceBundleSelection(input: {
      files: IssueManagerFileReference[];
      bundles: IssueManagerReferenceBundle[];
    }) {
      const target = referenceTarget;
      if (!target) {
        applyOutcome({ referenceTarget: null });
        return;
      }

      // 项目/分组(bundle)只在插入模式下折叠成 chip 追加到草稿;附加到已存在事项
      // 的后端 context-ref 仍是按路径存储,暂不支持句柄,故附加模式只提交松散文件。
      if (target.mode === "insert" && input.bundles.length > 0) {
        applyOutcome(
          createIssueManagerInsertReferenceBundlesOutcome({
            bundles: input.bundles,
            files: input.files,
            target,
            workspaceId
          })
        );
        trackIssueManagerContextRefsAdded({
          feature,
          refs: input.files,
          targetType: target.parentKind
        });
        return;
      }

      await submitReferences(input.files, target);
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
