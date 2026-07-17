import type { ReactNode } from "react";
import type { AgentActivityGoalControlAction } from "@tutti-os/agent-activity-core";
import type { ReferenceSourceAggregator } from "@tutti-os/workspace-file-reference/core";
import type {
  ReferenceLocateTarget,
  WorkspaceFileReference,
  WorkspaceFileReferenceAdapter,
  WorkspaceFileReferenceCopy
} from "@tutti-os/workspace-file-reference/contracts";
import type { WorkspaceFileManagerI18nRuntime } from "@tutti-os/workspace-file-manager";
import type { WorkspaceFileEntry } from "@tutti-os/workspace-file-manager/services";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import type {
  AgentGUIProvider,
  AgentGUIProviderRailAllPresentation,
  AgentGUIAgentTarget
} from "../../../types";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../../shared/AgentMessageMarkdown";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import type { AgentGUIAccountMenuState } from "../accountMenuState";
import type {
  AgentComposerGitBranchLoader,
  AgentComposerProps,
  AgentComposerReferenceProvenanceFilter,
  AgentComposerPromptTip,
  AgentComposerSlashStatusLimit
} from "../AgentComposer";
import type { AgentContextMentionProvider } from "../agentContextMentionProvider";
import type { AgentContextMentionItem } from "../agentRichText/agentFileMentionExtension";
import type {
  AgentComposerDraft,
  AgentHomeSuggestionCategory,
  AgentGUINodeViewModel
} from "../model/agentGuiNodeTypes";
import type { AgentGUIEngagementEventSink } from "../engagement/agentGUIEngagement.types";

export type AgentMentionReferenceTargetResolver = (
  item: AgentContextMentionItem
) => ReferenceLocateTarget | null;

export interface AgentWorkspaceReferenceInitialTargetInput {
  activeConversation: AgentGUINodeViewModel["rail"]["activeConversation"];
  composerSelectedProjectPath: string | null;
  userProjects: AgentGUINodeViewModel["rail"]["userProjects"];
}

export type AgentWorkspaceReferenceInitialTargetResolver = (
  input: AgentWorkspaceReferenceInitialTargetInput
) => ReferenceLocateTarget | null;

export interface AgentGUIViewLabels {
  initialPlaceholder: string;
  followupPlaceholder: string;
  installRequiredPlaceholder: string;
  installRequiredAction: string;
  providerGateCheckingTitle: string;
  providerGateCheckingDescription: string;
  providerGateCheckingAgentsDescription: string;
  providerGateInstallTitle: string;
  providerGateInstallDescription: string;
  providerGateInstallAction: string;
  providerGateLoginTitle: string;
  providerGateLoginDescription: string;
  providerGateLoginAction: string;
  providerGateComingSoonTitle: string;
  providerGateComingSoonDescription: string;
  providerGateComingSoonAction: string;
  providerGateUnavailableTitle: string;
  providerGateUnavailableDescription: string;
  providerGateRetryAction: string;
  providerGatePendingInstall: string;
  providerGatePendingLogin: string;
  providerGatePendingRefresh: string;
  collaboratorSessionReadOnlyPlaceholder: string;
  send: string;
  modelLabel: string;
  modelSelectionLabel: string;
  modelContextWindowSuffix: string;
  modelTooltipVersionLabel: string;
  defaultModel: string;
  loadingOptions: string;
  inheritedUnavailable: string;
  reasoningLabel: string;
  reasoningDegreeLabel: string;
  reasoningOptionDefault: string;
  reasoningOptionMinimal: string;
  reasoningOptionLow: string;
  reasoningOptionMedium: string;
  reasoningOptionHigh: string;
  reasoningOptionXHigh: string;
  reasoningOptionMax: string;
  reasoningOptionUltra: string;
  speedLabel: string;
  speedSelectionLabel: string;
  speedOptionStandard: string;
  speedOptionStandardDescription: string;
  speedOptionFast: string;
  speedOptionFastDescription: string;
  permissionLabel: string;
  permissionModeReadOnly: string;
  permissionModeAuto: string;
  permissionModeFullAccess: string;
  modelDescriptions: {
    frontierComplexCoding: string;
    everydayCoding: string;
    smallFastCostEfficient: string;
    codingOptimized: string;
    ultraFastCoding: string;
    professionalLongRunning: string;
  };
  planModeLabel: string;
  planModeOnLabel: string;
  planModeOffLabel: string;
  planUnavailable: string;
  queuedLabel: string;
  queuePausedByUserLabel: string;
  sendQueuedPromptNext: string;
  editQueuedPrompt: string;
  deleteQueuedPrompt: string;
  queuedPromptMoreActions: string;
  stop: string;
  stopping: string;
  noRunningResponse: string;
  empty: string;
  emptyForProvider?: (provider: string) => string;
  emptyProvider?: string;
  emptyProviderForProvider?: (provider: string) => string;
  /** Starter-prompt suggestion categories shown under the new-session composer. */
  homeSuggestions?: readonly AgentHomeSuggestionCategory[];
  /** Accessible label for the button that dismisses an expanded suggestion category. */
  homeSuggestionsClose?: string;
  conversations: string;
  newConversation: string;
  accountMenuTitle: string;
  accountMenuMember: string;
  accountMenuUpgrade: string;
  accountMenuCreditsBalance: string;
  accountMenuAccountCenter: string;
  accountMenuSettings: string;
  accountMenuFree: string;
  accountMenuSignIn: string;
  accountMenuSignOut: string;
  accountMenuLoading: string;
  accountMenuUnavailable: string;
  accountMenuDataUnavailable: string;
  accountRewardToastTitle: string;
  accountRewardToastCreditsUnit: string;
  accountRewardToastDescription: string;
  accountRewardToastClose: string;
  agentConfig: string;
  agentSettingsMenu: string;
  agentEnvSetup: string;
  manageAgents: string;
  manageAgentsTitle: string;
  manageAgentsDescription: string;
  manageAgentsAvailable: string;
  manageAgentsDisabled: string;
  manageAgentsNoAvailable: string;
  manageAgentsNoDisabled: string;
  manageAgentsKeepOneAvailable: string;
  manageAgentsRunningBlocked: (agent: string) => string;
  removeAgentFromSidebar: (agent: string) => string;
  addAgentToSidebar: (agent: string) => string;
  dragAgentToReorder: (agent: string) => string;
  noConversations: string;
  emptyProjectConversations: string;
  conversationFilterAll: string;
  conversationFilterCodex: string;
  conversationFilterClaudeCode: string;
  conversationFilterTutti: string;
  providerSwitchLabel: string;
  sharedAgentOwnerSeparator: string;
  startConversation: string;
  selectConversation: string;
  loadingConversations: string;
  loadingConversation: string;
  scrollToBottom: string;
  searchNoConversations: string;
  searchFailed: string;
  retrySearch: string;
  conversationUnavailable: string;
  fallbackAgentTitle: string;
  untitledConversationTitle: string;
  searchPlaceholder: string;
  sectionConversations: string;
  sectionToday: string;
  sectionPinned: string;
  sectionYesterday: string;
  sectionEarlier: string;
  projectSectionEdit: string;
  projectSectionMoreActions: string;
  projectSectionViewFiles: string;
  pinProject: string;
  unpinProject: string;
  pinnedProjectAccessibleName: (projectLabel: string) => string;
  projectRailCreateProject: string;
  projectRailLinkExistingProject: string;
  removeProject: string;
  removeProjectConfirmDescription: (projectLabel: string) => string;
  removeProjectConfirmTitle: string;
  batchDeleteProjectSessions: string;
  batchDeleteProjectSessionsTitle: string;
  batchDeleteProjectSessionsBody: (count: number, project: string) => string;
  batchDeleteProjectSessionsConfirm: string;
  conversationsSectionMoreActions: string;
  batchDeleteConversations: string;
  batchDeleteConversationsTitle: string;
  batchDeleteConversationsBody: (count: number) => string;
  batchDeleteConversationsConfirm: string;
  approvalRequired: string;
  fileChangeApprovalRequired: string;
  approvalUnavailable: string;
  authRequired: string;
  authLogin: string;
  activatingSession: string;
  cancellingSession: string;
  retryActivation: string;
  continueInNewConversation: string;
  goalLabel: string;
  goalTitleActive: string;
  goalTitlePaused: string;
  goalTitleBlocked: string;
  goalTitleUsageLimited: string;
  goalTitleBudgetLimited: string;
  goalTitleComplete: string;
  goalBudgetUsage: (used: number, budget: number) => string;
  goalClearHint: string;
  goalEditAction: string;
  goalPauseAction: string;
  goalResumeAction: string;
  goalClearAction: string;
  goalRemoved: string;
  processing: string;
  turnSummary: string;
  userMessageLocator: string;
  planLead: string;
  planModes: Array<{ id: string; label: string; description: string }>;
  stayInPlan: string;
  sendFeedback: string;
  feedbackPlaceholder: string;
  previousQuestion: string;
  nextQuestion: string;
  submitAnswers: string;
  answerPlaceholder: string;
  waitingForAnswer: string;
  thinkingLabel: string;
  toolCallsLabel: (count: number) => string;
  openConversationWindow: string;
  showMoreConversations: string;
  showLessConversations: string;
  deleteSession: string;
  pinSession: string;
  copySessionLink: string;
  renameSession: string;
  renameSessionTitle: string;
  renameSessionDescription: string;
  renameSessionPlaceholder: string;
  renameSessionSave: string;
  unpinSession: string;
  markSessionUnread: string;
  deleteSessionTitle: string;
  deleteSessionBody: string;
  deleteSessionConfirm: string;
  cancel: string;
  conversationRailResizeAria: string;
  relativeTimeJustNow: string;
  relativeTimeMinutes: (count: number) => string;
  relativeTimeHours: (count: number) => string;
  relativeTimeDays: (count: number) => string;
  relativeTimeMonths: (count: number) => string;
  relativeTimeYears: (count: number) => string;
  slashCommandPalette: string;
  skillPickerPalette: string;
  slashPaletteCommandsGroup: string;
  slashPaletteCapabilitiesGroup: string;
  slashPaletteCapabilitiesLoading: string;
  slashPaletteSkillsGroup: string;
  slashPalettePluginsGroup: string;
  slashPaletteConnectorsGroup: string;
  slashPaletteMcpGroup: string;
  slashCommandCompactLabel: string;
  slashCommandContextLabel: string;
  slashCommandFastLabel: string;
  slashCommandGoalLabel: string;
  slashCommandInitLabel: string;
  slashCommandPlanLabel: string;
  slashCommandReviewLabel: string;
  slashCommandStatusLabel: string;
  slashCommandUsageLabel: string;
  slashCommandCompactDescription: string;
  slashCommandContextDescription: string;
  slashCommandFastDescription: string;
  slashCommandGoalDescription: string;
  slashCommandInitDescription: string;
  slashCommandPlanDescription: string;
  slashCommandReviewDescription: string;
  slashCommandStatusDescription: string;
  slashCommandUsageDescription: string;
  browserUseCapabilityLabel: string;
  browserUseCapabilityDescription: string;
  browserUseCapabilityDescriptionAutoConnect: string;
  browserUseCapabilityDescriptionIsolated: string;
  browserUseCapabilitySettingsLabel: string;
  browserUseCapabilitySettingsDescription: string;
  capabilityInlineSettingsLabel: string;
  computerUseCapabilityLabel: string;
  computerUseCapabilityDescription: string;
  computerUseCapabilitySetupRequiredDescription: string;
  computerUseCapabilityAuthorizationRequiredDescription: string;
  computerUseCapabilityAuthorizationUnknownDescription: string;
  computerUseCapabilitySettingsLabel: string;
  computerUseCapabilitySettingsDescription: string;
  slashStatusTitle: string;
  slashStatusSession: string;
  slashStatusBaseUrl: string;
  slashStatusContext: string;
  slashStatusLimits: string;
  slashStatusAccount: string;
  slashStatusClose: string;
  slashStatusContextValue: (input: {
    percentLeft: number;
    usedTokens: string;
    totalTokens: string;
  }) => string;
  slashStatusContextUnavailable: string;
  slashStatusLimitsUnavailable: string;
  slashStatusUsageJustUpdated: string;
  slashStatusUsageMinutesAgo: (count: number) => string;
  slashStatusUsageHoursAgo: (count: number) => string;
  slashStatusUsageUpdating: string;
  slashStatusUsageRefreshFailed: string;
  slashStatusUsageRefreshAria: string;
  usageChipLabel: (input: { percent: number }) => string;
  usageTooltipLabel: string;
  usagePopoverTitle: string;
  usageContextWindowLabel: string;
  usageTokensLabel: string;
  usageLimitsLabel: string;
  usageCompactAction: string;
  planImplementationLead: string;
  planImplementationConfirm: string;
  planImplementationFeedbackPlaceholder: string;
  planImplementationSend: string;
  planImplementationSkip: string;
  fileMentionPalette: string;
  fileMentionLoading: string;
  fileMentionEmpty: string;
  fileMentionError: string;
  fileMentionTabHint: string;
  fileDropHint: string;
  mentionPalette: string;
  removeMention: string;
  addReference: string;
  addContent: string;
  referenceWorkspaceFiles: string;
  handoffConversation: string;
  handoffConversationTooltip: string;
  handoffConversationMenu: string;
  handoffTargetSelf: string;
  handoffTargetShared: string;
  projectLocked: string;
  projectMissingDescription: string;
  syncPending: string;
  syncSynced: string;
  syncFailed: string;
  promptTipsPrefix: string;
  promptTips: readonly AgentComposerPromptTip[];
  reviewPicker: AgentComposerProps["labels"]["reviewPicker"];
}

export interface AgentGUINodeViewProps {
  viewModel: AgentGUINodeViewModel;
  referenceProvenanceFilter?: AgentComposerReferenceProvenanceFilter | null;
  renderSidebarFooter?: AgentGUISidebarFooterRenderer;
  /** Renders the provider rail empty state in "exact" mode. See the type doc. */
  renderProviderRailEmpty?: AgentGUIAgentsEmptyRenderer;
  /**
   * Renders the main-pane state for a selected host-disabled provider target.
   * Other readiness gates keep the built-in AgentGUI flows.
   */
  renderProviderUnavailableState?: AgentGUIProviderUnavailableStateRenderer;
  providerRailAllPresentation?: AgentGUIProviderRailAllPresentation | null;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onHandoffConversation?: (input: {
    agentTargetId?: string | null;
    draftPrompt: string;
    provider: AgentGUIProvider;
    userProjectPath?: string | null;
  }) => void | Promise<void>;
  capabilityMenuState?: AgentComposerProps["capabilityMenuState"];
  onCapabilitySettingsRequest?: AgentComposerProps["onCapabilitySettingsRequest"];
  isActive?: boolean;
  isVisible?: boolean;
  onEngagementEvent?: AgentGUIEngagementEventSink;
  composerFocusRequestSequence?: number | null;
  newConversationRequestSequence?: number | null;
  slashStatusLimits?: readonly AgentComposerSlashStatusLimit[];
  slashStatusLimitsLoading?: boolean;
  slashStatusLimitsUnavailable?: boolean;
  providerAuthAccountLabels?: Partial<Record<string, string>>;
  railConfigProvider?: string | null;
  railSlashStatusLimits?: readonly AgentComposerSlashStatusLimit[];
  /** Capture time of the usage/limits shown in the rail config menu (for the
   * freshness indicator). Null when no usage snapshot is available. */
  slashStatusUsageCapturedAtUnixMs?: number | null;
  /** True when the latest usage probe fetch failed (drives the retry state). */
  slashStatusUsageDidFail?: boolean;
  /** True once a usage probe has run for this provider (snapshot or error), so
   * the config menu shows a "no limits / retry" row rather than hiding the
   * whole section when there are no meters to display. */
  slashStatusUsageAttempted?: boolean;
  onAgentConfigMenuOpen?: () => void;
  /** Forces a fresh usage probe from the config menu's refresh control. */
  onAgentUsageRefresh?: () => void;
  onSlashStatusOpen?: AgentComposerProps["onSlashStatusOpen"];
  accountMenuState?: AgentGUIAccountMenuState | null;
  previewMode?: boolean;
  onAgentProviderLogin?: (provider?: string | null) => void;
  actions: {
    updateConversationFilter: (
      filter: AgentGUINodeViewModel["rail"]["conversationFilter"]
    ) => void;
    selectConversationFilterTarget: (input: {
      provider: AgentGUIProvider;
      agentTargetId: string;
    }) => void;
    createConversation: (options?: {
      projectPath?: string | null;
      source?: string;
    }) => void;
    selectConversation: (agentSessionId: string) => void;
    submitPrompt: (
      content: AgentPromptContentBlock[],
      displayPrompt?: string,
      options?: Parameters<AgentComposerProps["onSubmit"]>[2]
    ) => void;
    goalControl: (
      action: AgentActivityGoalControlAction,
      objective?: string
    ) => void;
    submitGuidancePrompt: (
      content: AgentPromptContentBlock[],
      displayPrompt?: string
    ) => void;
    loadOlderConversationMessages: () => void;
    showPromptImagesUnsupported: () => void;
    submitApprovalOption: (requestId: string, optionId: string) => void;
    submitInteractivePrompt: (input: {
      requestId: string;
      action?: string;
      optionId?: string;
      payload?: Record<string, unknown>;
    }) => void;
    interruptCurrentTurn: (noRunningResponseMessage: string) => void;
    updateDraftContent: (
      draftContent: AgentComposerDraft,
      sourceScopeKey?: string
    ) => void;
    updateSelectedProjectPath?: AgentComposerProps["onProjectPathChange"];
    updateComposerSettings: (settings: {
      model?: string | null;
      reasoningEffort?: string | null;
      planMode?: boolean;
      permissionMode?: string;
    }) => void;
    selectHomeComposerAgentTarget: (input: {
      provider: AgentGUIProvider;
      agentTargetId?: string | null;
    }) => void;
    sendQueuedPromptNext: (queuedPromptId: string) => void;
    removeQueuedPrompt: (queuedPromptId: string) => void;
    editQueuedPrompt: (queuedPromptId: string) => void;
    retryActivation: () => void;
    continueInNewConversation: () => void;
    toggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
    markConversationUnread: (agentSessionId: string) => void;
    renameConversation: (
      agentSessionId: string,
      title: string
    ) => Promise<void>;
    removeProject: (path: string) => void;
    moveProject: (
      projectId: string,
      beforeProjectId: string | null
    ) => Promise<void>;
    toggleProjectPinned: (projectId: string, pinned: boolean) => Promise<void>;
    confirmDeleteProjectConversations: (
      sectionKey?: string,
      agentTargetId?: string | null
    ) => Promise<string[]>;
    confirmDeleteConversations: (agentSessionIds: string[]) => void;
    requestDeleteConversation: (agentSessionId: string) => void;
    cancelDeleteConversation: () => void;
    confirmDeleteConversation: () => void;
  };
  conversationRailCollapsed: boolean;
  conversationRailWidthPx: number;
  conversationRailMinWidthPx: number;
  conversationRailMaxWidthPx: number;
  detailMinWidthPx: number;
  uiLanguage: UiLanguage;
  onWorkspaceFileReferencesAdded?: (
    references: readonly WorkspaceFileReference[]
  ) => void | Promise<void>;
  resolveDroppedFileReferences?: AgentComposerProps["resolveDroppedFileReferences"];
  onConversationRailWidthChanged: (widthPx: number) => void;
  labels: AgentGUIViewLabels;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
  workspaceFileManagerCopy?: WorkspaceFileManagerI18nRuntime | null;
  workspaceFileReferenceAdapter?: WorkspaceFileReferenceAdapter | null;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  onRequestGitBranches?: AgentComposerGitBranchLoader | null;
  workspaceFileReferenceCopy?: WorkspaceFileReferenceCopy | null;
  contextMentionProviders?: readonly AgentContextMentionProvider[];
  referenceSourceAggregator?: ReferenceSourceAggregator | null;
  resolveWorkspaceReferenceEntryIconUrl?: (
    entry: WorkspaceFileEntry
  ) => Promise<string | null | undefined>;
  resolveMentionReferenceTarget?: AgentMentionReferenceTargetResolver | null;
  resolveWorkspaceReferenceInitialTarget?: AgentWorkspaceReferenceInitialTargetResolver | null;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
}

export interface AgentGUISidebarFooterContext {
  currentUserId?: string | null;
  activeConversation: AgentGUINodeViewModel["rail"]["activeConversation"];
}

export type AgentGUISidebarFooterRenderer = (
  ctx: AgentGUISidebarFooterContext
) => ReactNode;

/**
 * Renders the provider rail body when the rail is in "exact" mode and the
 * host-provided target list is empty (and not loading). Lets the host fully own
 * the empty state (e.g. a "no shared agents" message or a create-agent prompt)
 * instead of the library falling back to the static local catalog.
 */
export type AgentGUIAgentsEmptyRenderer = () => ReactNode;

export interface AgentGUIProviderUnavailableStateContext {
  provider: AgentGUIProvider;
  providerLabel: string;
  target: AgentGUIAgentTarget;
  iconUrl: string;
  unavailableReason: string | null;
}

/**
 * Renders the main-pane unavailable state for a selected provider target that
 * the host explicitly marks as disabled. This does not replace install,
 * login, checking, or retry readiness gates.
 */
export type AgentGUIProviderUnavailableStateRenderer = (
  ctx: AgentGUIProviderUnavailableStateContext
) => ReactNode;
