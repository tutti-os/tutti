import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { RichTextMentionAttrs } from "@tutti-os/ui-rich-text/types";
import {
  createWorkspaceUserProjectI18nRuntime,
  type WorkspaceUserProjectI18nRuntime
} from "@tutti-os/workspace-user-project/i18n";
import type { ReferenceSourceAggregator } from "@tutti-os/workspace-file-reference/core";
import {
  createIssueManagerI18nRuntime,
  type IssueManagerI18nRuntime
} from "../i18n/issueManagerI18n.ts";
import type {
  IssueManagerAgentBreakdownLauncher,
  IssueManagerAgentTargetOptionsAdapter,
  IssueManagerAnalyticsAdapter,
  IssueManagerExecutionDirectoryPicker,
  IssueManagerAgentSessionOpener,
  IssueManagerAgentRunner,
  IssueManagerBackend,
  IssueManagerEventSource,
  IssueManagerFileAdapter,
  IssueManagerIdentityAdapter,
  IssueManagerNodeState,
  IssueManagerShareAdapter
} from "../contracts/index.ts";

export interface IssueManagerNotificationSink {
  tips(title: string): void;
}

export interface IssueManagerMentionActionHandler {
  openMention(input: {
    mention: RichTextMentionAttrs;
    workspaceId: string;
  }): Promise<void> | void;
}

export interface IssueManagerFeatureUIConfig {
  showInviteCollaborator: boolean;
}

export interface IssueManagerFeature {
  agentBreakdownLauncher?: IssueManagerAgentBreakdownLauncher;
  analytics?: IssueManagerAnalyticsAdapter;
  agentTargetOptions?: IssueManagerAgentTargetOptionsAdapter;
  agentSessionOpener?: IssueManagerAgentSessionOpener;
  agentRunner: IssueManagerAgentRunner;
  backend: IssueManagerBackend;
  eventSource?: IssueManagerEventSource;
  executionDirectoryPicker?: IssueManagerExecutionDirectoryPicker;
  fileAdapter?: IssueManagerFileAdapter;
  i18n: IssueManagerI18nRuntime;
  identityAdapter: IssueManagerIdentityAdapter;
  mentionActionHandler?: IssueManagerMentionActionHandler;
  notifications?: IssueManagerNotificationSink;
  referenceSourceAggregator?: ReferenceSourceAggregator;
  shareAdapter?: IssueManagerShareAdapter;
  ui: IssueManagerFeatureUIConfig;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
}

export interface CreateIssueManagerFeatureInput {
  agentBreakdownLauncher?: IssueManagerAgentBreakdownLauncher;
  analytics?: IssueManagerAnalyticsAdapter;
  agentTargetOptions?: IssueManagerAgentTargetOptionsAdapter;
  agentSessionOpener?: IssueManagerAgentSessionOpener;
  agentRunner: IssueManagerAgentRunner;
  backend: IssueManagerBackend;
  eventSource?: IssueManagerEventSource;
  executionDirectoryPicker?: IssueManagerExecutionDirectoryPicker;
  fileAdapter?: IssueManagerFileAdapter;
  i18n?: I18nRuntime<string>;
  identityAdapter: IssueManagerIdentityAdapter;
  mentionActionHandler?: IssueManagerMentionActionHandler;
  notifications?: IssueManagerNotificationSink;
  referenceSourceAggregator?: ReferenceSourceAggregator;
  shareAdapter?: IssueManagerShareAdapter;
  ui?: Partial<IssueManagerFeatureUIConfig>;
}

export const defaultIssueManagerNodeState: IssueManagerNodeState = {
  activeTopicId: null,
  issueSearchQuery: "",
  issueStatusFilter: "all",
  selectedAgentTargetId: "local:codex",
  selectedExecutionDirectory: null,
  selectedIssueId: null,
  selectedTaskId: null,
  taskListCollapsed: false
};

export function createIssueManagerFeature(
  input: CreateIssueManagerFeatureInput
): IssueManagerFeature {
  return {
    agentBreakdownLauncher: input.agentBreakdownLauncher,
    analytics: input.analytics,
    agentTargetOptions: input.agentTargetOptions,
    agentSessionOpener: input.agentSessionOpener,
    agentRunner: input.agentRunner,
    backend: input.backend,
    eventSource: input.eventSource,
    executionDirectoryPicker: input.executionDirectoryPicker,
    fileAdapter: input.fileAdapter,
    i18n: createIssueManagerI18nRuntime(input.i18n),
    identityAdapter: input.identityAdapter,
    mentionActionHandler: input.mentionActionHandler,
    notifications: input.notifications,
    referenceSourceAggregator: input.referenceSourceAggregator,
    shareAdapter: input.shareAdapter,
    ui: {
      showInviteCollaborator: input.ui?.showInviteCollaborator ?? true
    },
    workspaceUserProjectI18n: createWorkspaceUserProjectI18nRuntime(input.i18n)
  };
}

export function normalizeIssueManagerNodeState(
  state: Partial<IssueManagerNodeState> | null | undefined
): IssueManagerNodeState {
  return {
    ...defaultIssueManagerNodeState,
    ...state,
    activeTopicId: normalizeNullableString(state?.activeTopicId),
    issueSearchQuery: state?.issueSearchQuery?.trim() ?? "",
    issueStatusFilter: state?.issueStatusFilter ?? "all",
    selectedAgentTargetId:
      state?.selectedAgentTargetId?.trim() ||
      legacySelectedAgentTargetId(state) ||
      "local:codex",
    selectedExecutionDirectory: normalizeNullableString(
      state?.selectedExecutionDirectory
    ),
    selectedIssueId: normalizeNullableString(state?.selectedIssueId),
    selectedTaskId: normalizeNullableString(state?.selectedTaskId),
    taskListCollapsed: state?.taskListCollapsed === true
  };
}

function legacySelectedAgentTargetId(
  state: Partial<IssueManagerNodeState> | null | undefined
): string | null {
  const legacyProvider = (
    state as { selectedAgentProvider?: string | null } | null | undefined
  )?.selectedAgentProvider?.trim();
  return legacyProvider ? `local:${legacyProvider}` : null;
}

function normalizeNullableString(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
