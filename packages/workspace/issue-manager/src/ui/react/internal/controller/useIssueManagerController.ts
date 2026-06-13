import { useEffect, useMemo, useState } from "react";
import type { RichTextAtProvider } from "@tutti-os/ui-rich-text/types";
import type { WorkspaceUserProjectService } from "@tutti-os/workspace-user-project/contracts";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import type {
  IssueManagerAgentProviderOption,
  IssueManagerContextRef,
  IssueManagerFileReference,
  IssueManagerIssueDetail,
  IssueManagerIssueSummary,
  IssueManagerNodeState,
  IssueManagerOpenSource,
  IssueManagerPriority,
  IssueManagerRun,
  IssueManagerTaskDetail,
  IssueManagerTopic,
  IssueManagerCreateTopicInput,
  IssueManagerUpdateTopicInput
} from "../../../../contracts/index.ts";
import type { IssueManagerFeature } from "../../../../core/index.ts";
import type { IssueManagerI18nRuntime } from "../../../../i18n/issueManagerI18n.ts";
import type { IssueManagerControllerService } from "../../../../services/issueManagerControllerService.interface.ts";
import {
  resolveIssueManagerAgentProviderOptions,
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

export type IssueManagerRichTextSurface = "issue" | "task";

export interface UseIssueManagerControllerInput {
  feature: IssueManagerFeature;
  openSource?: IssueManagerOpenSource;
  onStateChange?: (state: IssueManagerNodeState) => void;
  resolveRichTextAtProviders?: (input: {
    surface: IssueManagerRichTextSurface;
    workspaceId: string;
  }) => readonly RichTextAtProvider[];
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
  openReference: (reference: IssueManagerFileReference) => Promise<void>;
  providerOptions: readonly IssueManagerAgentProviderOption[];
  executionDirectoryProjectService: WorkspaceUserProjectService | null;
  reportIssueSearchUsage: (query: string) => void;
  refreshAll: () => void;
  referenceTarget: IssueManagerReferenceTarget | null;
  removeContextRef: (ref: IssueManagerContextRef) => Promise<void>;
  runTask: (providerOverride?: string) => Promise<void>;
  saveIssue: () => Promise<void>;
  saveTask: () => Promise<void>;
  setTaskStatus: (
    taskId: string,
    status: "completed" | "not_started"
  ) => Promise<void>;
  setSelectedTaskStatus: (status: "completed" | "not_started") => Promise<void>;
  resolveRichTextAtProviders: (
    surface: IssueManagerRichTextSurface
  ) => readonly RichTextAtProvider[];
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
  setSelectedAgentProvider: (provider: string) => void;
  useExecutionDirectory: (path: string | null) => Promise<void>;
  setTaskContent: (content: string) => void;
  setTaskDraft: (patch: Partial<TaskDraft>) => void;
  setTaskEditorMode: (mode: IssueManagerEditorMode) => void;
  setTaskListCollapsed: (collapsed: boolean) => void;
  setTaskPriority: (priority: IssueManagerPriority) => void;
  setTaskTitle: (title: string) => void;
  shareSelection: () => Promise<void>;
  startTaskBreakdown: (providerOverride?: string) => Promise<void>;
  submitReferenceSelection: (
    refs: IssueManagerFileReference[]
  ) => Promise<void>;
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
  feature,
  openSource,
  onStateChange,
  resolveRichTextAtProviders,
  service,
  state,
  workspaceId
}: UseIssueManagerControllerInput): IssueManagerController {
  const copy = feature.i18n;
  const { controllerSession, floatingNotice, snapshot } =
    useIssueManagerControllerRuntime({
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
  const [providerOptions, setProviderOptions] = useState(() =>
    resolveIssueManagerAgentProviderOptions(feature)
  );

  useEffect(() => {
    setProviderOptions(resolveIssueManagerAgentProviderOptions(feature));
    return feature.agentProviderOptions?.subscribe?.(() => {
      setProviderOptions(resolveIssueManagerAgentProviderOptions(feature));
    });
  }, [feature]);

  const actions = createIssueManagerControllerActionsBridge({
    controllerSession,
    copy,
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
    feature,
    issueEditorMode,
    nodeState,
    onResolveRichTextAtProviders: resolveRichTextAtProviders,
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
    providerOptions,
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
