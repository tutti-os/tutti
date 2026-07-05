import { useEffect, useMemo, useState } from "react";
import type {
  RichTextMentionAttrs,
  RichTextTriggerProvider
} from "@tutti-os/ui-rich-text/types";
import type { WorkspaceUserProjectService } from "@tutti-os/workspace-user-project/contracts";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import type {
  IssueManagerAgentTargetOption,
  IssueManagerContextRef,
  IssueManagerFileReference,
  IssueManagerIssueDetail,
  IssueManagerIssueSummary,
  IssueManagerNodeState,
  IssueManagerOpenSource,
  IssueManagerPriority,
  IssueManagerReferenceBundle,
  IssueManagerRun,
  IssueManagerStatus,
  IssueManagerTaskDetail,
  IssueManagerTaskStatusUpdate,
  IssueManagerTopic,
  IssueManagerCreateTopicInput,
  IssueManagerUpdateTopicInput
} from "../../../../contracts/index.ts";
import type { IssueManagerFeature } from "../../../../core/index.ts";
import type { IssueManagerI18nRuntime } from "../../../../i18n/issueManagerI18n.ts";
import type { IssueManagerControllerService } from "../../../../services/issueManagerControllerService.interface.ts";
import {
  resolveIssueManagerAgentTargetOptions,
  resolveIssueManagerControllerCapabilities
} from "./IssueManagerControllerCapabilities.ts";
import type { IssueManagerFloatingNoticeViewState } from "../shell/IssueManagerNoticeState.ts";
import type {
  AsyncCollectionState,
  IssueDraft,
  IssueManagerNotificationState,
  TaskDraft
} from "../../../../services/controllerTypes.ts";
import type {
  IssueManagerEditorMode,
  IssueManagerReferenceTarget
} from "../../../../services/controllerModel.ts";
import { createIssueManagerControllerActionsBridge } from "./createIssueManagerControllerActionsBridge.ts";
import { createIssueManagerControllerBindings } from "./createIssueManagerControllerBindings.ts";
import { resolveIssueManagerTopicDeleteErrorMessage } from "../../../../services/internal/controllerUtils.ts";
import { useIssueManagerControllerRuntime } from "./useIssueManagerControllerRuntime.ts";
import type { IssueManagerDiagnostics } from "../../../../internal/issueManagerDiagnostics.ts";

export type IssueManagerRichTextSurface = "issue" | "task";

export interface UseIssueManagerControllerInput {
  diagnostics?: IssueManagerDiagnostics | null;
  feature: IssueManagerFeature;
  openSource?: IssueManagerOpenSource;
  onStateChange?: (state: IssueManagerNodeState) => void;
  resolveRichTextTriggerProviders?: (input: {
    surface: IssueManagerRichTextSurface;
    workspaceId: string;
  }) => readonly RichTextTriggerProvider[];
  service?: IssueManagerControllerService;
  state?: Partial<IssueManagerNodeState> | null;
  workspaceId: string;
}

export interface IssueManagerController {
  attachReferences: (parentKind: "issue" | "task") => Promise<void>;
  canOpenAgentSessions: boolean;
  canSelectExecutionDirectory: boolean;
  canInviteCollaborators: boolean;
  canReferenceWorkspaceFiles: boolean;
  canUploadWorkspaceFiles: boolean;
  copy: IssueManagerI18nRuntime;
  diagnostics: IssueManagerDiagnostics | null;
  createTopic: (
    input: Omit<IssueManagerCreateTopicInput, "workspaceId">
  ) => Promise<void>;
  deleteTopic: (topicId: string) => Promise<void>;
  createTaskDraft: () => void;
  deleteIssue: (options?: { skipConfirmation?: boolean }) => Promise<void>;
  deleteTask: (options?: { skipConfirmation?: boolean }) => Promise<void>;
  dismissNotification: () => void;
  insertReferences: (parentKind: "issue" | "task") => Promise<void>;
  issueDetail: AsyncCollectionState<IssueManagerIssueDetail | null>;
  issueDraft: IssueDraft;
  issueEditorMode: IssueManagerEditorMode;
  floatingNotice: IssueManagerFloatingNoticeViewState | null;
  issues: AsyncCollectionState<IssueManagerIssueSummary[]>;
  isRunningTask: boolean;
  nodeState: IssueManagerNodeState;
  notification: IssueManagerNotificationState | null;
  openAgentSession: (run: IssueManagerRun) => Promise<void>;
  openMention: (mention: RichTextMentionAttrs) => Promise<void>;
  openReference: (reference: IssueManagerFileReference) => Promise<void>;
  moveTask: (input: {
    targetIndex: number;
    targetStatus: IssueManagerStatus;
    taskId: string;
    visibleTaskIds?: readonly string[];
  }) => Promise<void>;
  agentTargetOptions: readonly IssueManagerAgentTargetOption[];
  executionDirectoryProjectService: WorkspaceUserProjectService | null;
  reportIssueSearchUsage: (query: string) => void;
  refreshAll: () => void;
  referenceTarget: IssueManagerReferenceTarget | null;
  removeContextRef: (ref: IssueManagerContextRef) => Promise<void>;
  runTask: (agentTargetIdOverride?: string) => Promise<void>;
  saveIssue: () => Promise<void>;
  saveTask: () => Promise<void>;
  setTaskStatus: (
    taskId: string,
    status: IssueManagerTaskStatusUpdate
  ) => Promise<void>;
  setSelectedTaskStatus: (
    status: IssueManagerTaskStatusUpdate
  ) => Promise<void>;
  resolveRichTextTriggerProviders: (
    surface: IssueManagerRichTextSurface
  ) => readonly RichTextTriggerProvider[];
  selectIssue: (issueId: string | null) => void;
  selectTask: (taskId: string | null) => void;
  selectTopic: (topicId: string) => void;
  setIssueContent: (content: string) => void;
  setIssueDraft: (patch: Partial<IssueDraft>) => void;
  setIssueEditorMode: (mode: IssueManagerEditorMode) => void;
  setIssueSearchQuery: (query: string) => void;
  setIssueStatusFilter: (
    value: IssueManagerNodeState["issueStatusFilter"]
  ) => void;
  setIssueTitle: (title: string) => void;
  setReferenceTarget: (target: IssueManagerReferenceTarget | null) => void;
  setSelectedAgentTargetId: (agentTargetId: string) => void;
  useExecutionDirectory: (path: string | null) => Promise<void>;
  setTaskContent: (content: string) => void;
  setTaskDraft: (patch: Partial<TaskDraft>) => void;
  setTaskEditorMode: (mode: IssueManagerEditorMode) => void;
  setTaskListCollapsed: (collapsed: boolean) => void;
  setTaskPriority: (priority: IssueManagerPriority) => void;
  setTaskTitle: (title: string) => void;
  shareSelection: () => Promise<void>;
  startTaskBreakdown: (agentTargetIdOverride?: string) => Promise<void>;
  submitReferenceSelection: (
    refs: IssueManagerFileReference[]
  ) => Promise<void>;
  submitReferenceBundleSelection: (input: {
    files: IssueManagerFileReference[];
    bundles: IssueManagerReferenceBundle[];
  }) => Promise<void>;
  taskDetail: AsyncCollectionState<IssueManagerTaskDetail | null>;
  taskDraft: TaskDraft;
  taskEditorMode: IssueManagerEditorMode;
  topics: AsyncCollectionState<IssueManagerTopic[]>;
  updateTopic: (
    input: Omit<IssueManagerUpdateTopicInput, "workspaceId">
  ) => Promise<void>;
  uploadReferences: (
    parentKind: "issue" | "task",
    mode: "files" | "folder"
  ) => Promise<void>;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
  workspaceId: string;
}

export function useIssueManagerController({
  diagnostics,
  feature,
  openSource,
  onStateChange,
  resolveRichTextTriggerProviders,
  service,
  state,
  workspaceId
}: UseIssueManagerControllerInput): IssueManagerController {
  const copy = feature.i18n;
  const { controllerSession, floatingNotice, snapshot } =
    useIssueManagerControllerRuntime({
      diagnostics,
      feature,
      openSource,
      onStateChange,
      service,
      state,
      workspaceId
    });
  const {
    issueDetail,
    issueDraft,
    issueEditorMode,
    issues,
    isRunningTask,
    nodeState,
    notification,
    referenceTarget,
    taskDetail,
    taskDraft,
    taskEditorMode,
    topics
  } = snapshot;
  const {
    canOpenAgentSessions,
    canInviteCollaborators,
    canReferenceWorkspaceFiles,
    canSelectExecutionDirectory,
    canUploadWorkspaceFiles
  } = useMemo(
    () => resolveIssueManagerControllerCapabilities(feature),
    [feature]
  );
  const [agentTargetOptions, setAgentTargetOptions] = useState(() =>
    resolveIssueManagerAgentTargetOptions(feature)
  );

  useEffect(() => {
    setAgentTargetOptions(resolveIssueManagerAgentTargetOptions(feature));
    return feature.agentTargetOptions?.subscribe?.(() => {
      setAgentTargetOptions(resolveIssueManagerAgentTargetOptions(feature));
    });
  }, [feature]);

  const actions = createIssueManagerControllerActionsBridge({
    controllerSession,
    copy,
    diagnostics,
    feature,
    issueDetail,
    issueDraft,
    issueEditorMode,
    nodeState,
    referenceTarget,
    taskDetail,
    taskDraft,
    taskEditorMode,
    workspaceId
  });
  const bindings = createIssueManagerControllerBindings({
    controllerSession,
    diagnostics,
    feature,
    issueEditorMode,
    nodeState,
    onResolveRichTextTriggerProviders: resolveRichTextTriggerProviders,
    taskEditorMode,
    workspaceId
  });
  const notifyTopicOperationFailure = (message: string) => {
    feature.notifications?.tips(message);
    controllerSession.setNotification((current) => ({
      id: (current?.id ?? 0) + 1,
      title: message,
      tone: "destructive"
    }));
  };

  return {
    ...actions,
    ...bindings,
    canOpenAgentSessions,
    canInviteCollaborators,
    canReferenceWorkspaceFiles,
    canSelectExecutionDirectory,
    canUploadWorkspaceFiles,
    copy,
    diagnostics: diagnostics ?? null,
    async createTopic(topicInput) {
      try {
        const topic = await feature.backend.createTopic({
          ...topicInput,
          workspaceId
        });
        controllerSession.updateNodeState((current) => ({
          ...current,
          activeTopicId: topic.topicId
        }));
        controllerSession.refreshAll();
      } catch {
        notifyTopicOperationFailure(copy.t("messages.topicCreateFailed"));
      }
    },
    async deleteTopic(topicId) {
      const trimmedTopicId = topicId.trim();
      if (!trimmedTopicId) {
        return;
      }
      try {
        await feature.backend.deleteTopic({
          topicId: trimmedTopicId,
          workspaceId
        });
        if (nodeState.activeTopicId === trimmedTopicId) {
          controllerSession.updateNodeState((current) => ({
            ...current,
            activeTopicId: null,
            selectedIssueId: null,
            selectedTaskId: null
          }));
        }
        controllerSession.refreshAll();
      } catch (error) {
        notifyTopicOperationFailure(
          resolveIssueManagerTopicDeleteErrorMessage(error, copy)
        );
      }
    },
    issueDetail,
    issueDraft,
    issueEditorMode,
    floatingNotice,
    issues,
    isRunningTask,
    nodeState,
    notification,
    async openMention(mention) {
      await feature.mentionActionHandler?.openMention({
        mention,
        workspaceId
      });
    },
    agentTargetOptions,
    executionDirectoryProjectService:
      feature.executionDirectoryPicker?.service ?? null,
    workspaceUserProjectI18n: feature.workspaceUserProjectI18n,
    referenceTarget,
    selectTopic(topicId: string) {
      const trimmedTopicId = topicId.trim();
      if (!trimmedTopicId) {
        return;
      }
      if (nodeState.activeTopicId !== trimmedTopicId) {
        void Promise.resolve(
          feature.analytics?.track({
            name: "issue_manager.topic_changed",
            params: {}
          })
        ).catch(() => undefined);
      }
      controllerSession.updateNodeState((current) => ({
        ...current,
        activeTopicId: trimmedTopicId
      }));
    },
    taskDetail,
    taskDraft,
    taskEditorMode,
    topics,
    async updateTopic(topicInput) {
      try {
        await feature.backend.updateTopic({
          ...topicInput,
          workspaceId
        });
        controllerSession.refreshAll();
      } catch {
        notifyTopicOperationFailure(copy.t("messages.topicUpdateFailed"));
      }
    },
    workspaceId
  };
}
