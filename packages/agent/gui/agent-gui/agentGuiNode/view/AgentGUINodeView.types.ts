import type { ReactNode } from "react";
import type { AgentActivityGoalControlAction } from "@tutti-os/agent-activity-core";
import type { AgentGuiWorkbenchCommandBridge } from "../../../workbench/commands";
import type { ReferenceSourceAggregator } from "@tutti-os/workspace-file-reference/core";
import type { ReferenceSourcePickerProps } from "@tutti-os/workspace-file-reference/ui";
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
  AgentGUIAgentTarget,
  AgentGUIAgentTargetInfoRenderer
} from "../../../types";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../../shared/AgentMessageMarkdown";
import type { PlanIssueBudgetPreset } from "../../../shared/agentConversation/planImplementationPresentation";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import type { AgentInteractionResponseInput } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type {
  AgentComposerGitBranchLoader,
  AgentComposerProps,
  AgentComposerReferenceProvenanceFilters,
  AgentComposerPromptTip,
  AgentComposerSlashStatusLimit
} from "../AgentComposer";
import type { AgentContextMentionItem } from "../agentRichText/agentFileMentionExtension";
import type {
  AgentComposerDraft,
  AgentHomeSuggestionCategory,
  AgentGUINodeViewModel
} from "../model/agentGuiNodeTypes";
import type { AgentGUIEngagementEventSink } from "../engagement/agentGUIEngagement.types";
import type { AgentGUIProviderReadinessLabels } from "../model/agentGuiProviderReadiness";
import type { OpenAgentEnvPanelInput } from "../../../shared/agentEnv";
import type {
  TuttiModePlanPanelLabels,
  TuttiPlanIssuePanelLabels
} from "../../../workspaceWorkflow";
import type { TuttiWorkflowDockLabels } from "../TuttiWorkflowDock";
import type { AgentGUIComposerFooterAccessoryRenderer } from "./AgentGUIComposerFooterAccessory.types";
import type { AgentGUISessionLaunchMode } from "../model/agentSessionLaunchMode";
import type { AgentProjectDropdownOptions } from "../AgentComposerProjectMenu";
import type { AgentGUISideConversationPresentation } from "../../../agentSideConversationPresentation";
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
export interface AgentGUIConversationRailLayout {
  providerRailWidthPx: number;
  conversationRailWidthPx: number;
  leftPanelWidthPx: number;
  resizing: boolean;
}
// Provider-gate labels live on AgentGUIProviderReadinessLabels; extend it
// rather than restating every key here.
export interface AgentGUIViewLabels extends AgentGUIProviderReadinessLabels {
  selectionAddToConversation: string;
  selectionAskInSide: string;
  initialPlaceholder: string;
  followupPlaceholder: string;
  installRequiredPlaceholder: string;
  installRequiredAction: string;
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
  composerOptionsLoadFailed?: string;
  composerOptionsRetry?: string;
  composerOptionsRetryTooltip?: string;
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
  permissionModeChangeUnavailableDuringTurn: string;
  modelDescriptions: {
    frontierComplexCoding: string;
    everydayCoding: string;
    smallFastCostEfficient: string;
    codingOptimized: string;
    ultraFastCoding: string;
    professionalLongRunning: string;
  };
  planModeLabel: string;
  codexSaverModeLabel: string;
  codexSaverModeDescription: string;
  rtkSaverModeLabel: string;
  rtkSaverModeDescription: string;
  normalModeLabel?: string;
  normalModeDescription?: string;
  tuttiModeLabel: string;
  tuttiModeDescription: string;
  tuttiModeRemove: string;
  tuttiBudgetTitle: string;
  tuttiBudgetEffectLabel: string;
  tuttiBudgetSpeedLabel: string;
  tuttiBudgetPreviewHint: string;
  tuttiBudgetPreviewCost: string;
  tuttiBudgetPreviewBalance: string;
  tuttiBudgetPreviewPowerful: string;
  tuttiBudgetModelPreferenceLabel: string;
  tuttiBudgetModelPreferenceCost: string;
  tuttiBudgetModelPreferenceBalance: string;
  tuttiBudgetModelPreferencePowerful: string;
  tuttiBudgetParallelismLabel: string;
  tuttiBudgetParallelismValue: (count: number) => string;
  tuttiModeUpdateFailed: string;
  tuttiModeUpdateUncertain: string;
  tuttiModePlanPanel: TuttiModePlanPanelLabels;
  tuttiWorkflowDock: TuttiWorkflowDockLabels;
  tuttiModePlanIssuePanel: TuttiPlanIssuePanelLabels;
  tuttiModePlanIssueAcceptPrompt: (reference: string) => string;
  tuttiModePlanIssueReworkPrompt: (reference: string) => string;
  tuttiModePlanSendAccept: string;
  tuttiModePlanSendRequestChanges: string;
  /** Auto feedback for an empty send after either preference diverged. */
  tuttiModePlanReplanFeedback: (
    fromEffect: string,
    fromSpeed: string,
    toEffect: string,
    toSpeed: string
  ) => string;
  /** Appended to typed feedback when either preference diverged. */
  tuttiModePlanReplanFeedbackSuffix: (effect: string, speed: string) => string;
  tuttiModePlanLoadFailed: string;
  tuttiModePlanRetry: string;
  /** Accepted plan whose Issue creation durably failed; message is the cause. */
  tuttiModePlanIssueCreateFailed: (message: string) => string;
  planModeDescription?: string;
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
  conversationsLoadFailed: string;
  loadingConversation: string;
  continuedFromTask: string;
  scrollToBottom: string;
  searchNoConversations: string;
  searchFailed: string;
  retryConversations: string;
  retrySearch: string;
  activityPriority: string;
  activityNothingNeedsAttention: string;
  activityToday: string;
  activityYesterday: string;
  activityConversationSource: string;
  activityStatusFailed: string;
  activityStatusRecentlyActive: string;
  activityStatusUnread: string;
  activityStatusWaiting: string;
  activityStatusWorking: string;
  viewActivity: string;
  viewActivityNeedsAttention: string;
  turnOffActivityView: string;
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
  returnToConversation?: string;
  continueAnswering?: string;
  thinkingLabel: string;
  toolCallsLabel: (count: number) => string;
  openConversationWindow: string;
  showMoreConversations: string;
  showLessConversations: string;
  deleteSession: string;
  pinSession: string;
  moreSessionActions: string;
  copyAsMarkdown: string;
  copyAsReference: string;
  conversationCopyImage: string;
  conversationCopyImagesOmitted: string;
  conversationCopyInProgress: string;
  conversationCopyMentionPrefix: string;
  conversationCopyFile: string;
  conversationCopyPreviousMessages: string;
  copiedToClipboard: string;
  copyFailed: string;
  sessionActionUnavailable: string;
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
  slashPaletteConnectorConnected: string;
  slashPaletteConnectorNotConnected: string;
  slashPaletteConnectorUnsupported: string;
  slashPaletteMcpGroup: string;
  slashCommandPresentation?: (commandName: string) => {
    description?: string;
    label?: string;
  };
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
  slashStatusProviderAccount: (provider: string) => string | null;
  slashStatusClose: string;
  slashStatusContextValue: (input: {
    percentLeft: number;
    usedTokens: string;
    totalTokens: string;
  }) => string;
  slashStatusContextUnavailable: string;
  slashStatusLimitsUnavailable: string;
  slashStatusEmptyValue: string;
  slashStatusUsageJustUpdated: string;
  slashStatusUsageMinutesAgo: (count: number) => string;
  slashStatusUsageHoursAgo: (count: number) => string;
  slashStatusUsageUpdating: string;
  slashStatusUsageRefreshFailed: string;
  slashStatusUsageRefreshAria: string;
  slashStatusUsageAuthRequired: string;
  slashStatusUsageSessionExpired: string;
  slashStatusUsageSubscriptionRequired: string;
  slashStatusUsageQuotaExhausted: string;
  slashStatusUsageParseFailed: string;
  slashStatusUsageError: string;
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
  addContentResourcePanel: string;
  addContentConnectors: string;
  addContentConnectorConnected: string;
  addContentConnectorConnect: string;
  addContentConnectorAuthorize: string;
  addContentConnectorEmpty: string;
  addContentConnectorLoading: string;
  addContentConnectorMore: string;
  addContentConnectorSelected: string;
  referenceWorkspaceFiles: string;
  handoffConversation: string;
  handoffConversationTooltip: string;
  handoffConversationMenu: string;
  handoffTargetDeviceSource: (deviceLabel: string) => string;
  handoffTargetSelf: string;
  handoffTargetShared: string;
  projectLocked: string;
  sessionLaunchModeLabel?: string;
  sessionLaunchModeLocal?: string;
  sessionLaunchModeWorktree?: string;
  projectMissingDescription: string;
  syncPending: string;
  syncSynced: string;
  syncFailed: string;
  promptTipsPrefix: string;
  promptTips: readonly AgentComposerPromptTip[];
  reviewPicker: AgentComposerProps["labels"]["reviewPicker"];
  quickPrompts: AgentComposerProps["labels"]["quickPrompts"];
}

export type ChromeLabels = {
  approvalRequired: string;
  authRequired: string;
  activatingSession: string;
  retryActivation: string;
  continueInNewConversation: string;
};
export type InteractivePromptLabels = {
  approvalLead: string;
  fileChangeApprovalLead: string;
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
  conversationReturn?: {
    continueAnswering: string;
    returnToConversation: string;
  };
  planImplementationLead: string;
  planImplementationConfirm: string;
  planImplementationFeedbackPlaceholder: string;
  planImplementationSend: string;
  planImplementationSkip: string;
};

export type AgentGUIConversationRailLabels = Pick<
  AgentGUIViewLabels,
  | "batchDeleteConversations"
  | "activityPriority"
  | "activityNothingNeedsAttention"
  | "activityToday"
  | "activityYesterday"
  | "activityConversationSource"
  | "activityStatusFailed"
  | "activityStatusRecentlyActive"
  | "activityStatusUnread"
  | "activityStatusWaiting"
  | "activityStatusWorking"
  | "batchDeleteConversationsBody"
  | "batchDeleteConversationsConfirm"
  | "batchDeleteConversationsTitle"
  | "batchDeleteProjectSessions"
  | "batchDeleteProjectSessionsBody"
  | "batchDeleteProjectSessionsConfirm"
  | "batchDeleteProjectSessionsTitle"
  | "cancel"
  | "conversationUnavailable"
  | "conversationsSectionMoreActions"
  | "copyAsMarkdown"
  | "copyAsReference"
  | "conversationCopyFile"
  | "conversationCopyImage"
  | "conversationCopyImagesOmitted"
  | "conversationCopyInProgress"
  | "conversationCopyMentionPrefix"
  | "conversationCopyPreviousMessages"
  | "copiedToClipboard"
  | "copyFailed"
  | "conversationsLoadFailed"
  | "moreSessionActions"
  | "deleteSession"
  | "deleteSessionConfirm"
  | "emptyProjectConversations"
  | "loadingConversations"
  | "markSessionUnread"
  | "newConversation"
  | "noConversations"
  | "openConversationWindow"
  | "pinProject"
  | "pinSession"
  | "pinnedProjectAccessibleName"
  | "projectRailCreateProject"
  | "projectRailLinkExistingProject"
  | "projectSectionEdit"
  | "projectSectionMoreActions"
  | "projectSectionViewFiles"
  | "relativeTimeDays"
  | "relativeTimeHours"
  | "relativeTimeJustNow"
  | "relativeTimeMinutes"
  | "relativeTimeMonths"
  | "relativeTimeYears"
  | "removeProject"
  | "removeProjectConfirmDescription"
  | "removeProjectConfirmTitle"
  | "renameSession"
  | "retryConversations"
  | "retrySearch"
  | "searchFailed"
  | "searchNoConversations"
  | "searchPlaceholder"
  | "sectionConversations"
  | "sectionPinned"
  | "selectConversation"
  | "showLessConversations"
  | "showMoreConversations"
  | "startConversation"
  | "turnOffActivityView"
  | "unpinProject"
  | "unpinSession"
  | "untitledConversationTitle"
  | "viewActivity"
  | "viewActivityNeedsAttention"
>;
type AgentGUIComposerExternalPromptProps = Pick<
  AgentComposerProps,
  | "resolveExternalPromptEntries"
  | "prepareExternalPromptFiles"
  | "resolvePastedPath"
  | "promptAssetLimit"
>;
export interface AgentGUINodeViewProps extends AgentGUIComposerExternalPromptProps {
  viewModel: AgentGUINodeViewModel;
  /** Complete presentation-only catalog for exact Agent mention identity. */
  mentionAgentTargets?: readonly AgentGUIAgentTarget[];
  /** Host-owned mention categories to omit from the palette. */
  hiddenMentionFilterIds?: readonly string[];
  referenceProvenanceFilters?: AgentComposerReferenceProvenanceFilters | null;
  sessionInputHistoryEnabled?: boolean;
  sideConversationEnabled?: boolean;
  sideConversationPresentation?: AgentGUISideConversationPresentation | null;
  sessionWorktreeEnabled?: boolean;
  sessionLaunchModesByProjectSectionKey?: Readonly<
    Record<string, AgentGUISessionLaunchMode>
  >;
  onSessionLaunchModePreferenceChange?: (input: {
    mode: AgentGUISessionLaunchMode;
    projectSectionKey: string;
  }) => void | Promise<void>;
  /** Host-owned presentation for exact Agent targets; tooltip behavior stays AgentGUI-owned. */
  renderAgentTargetInfo?: AgentGUIAgentTargetInfoRenderer;
  renderProjectDirectoryPickerHeaderActions?: ReferenceSourcePickerProps["renderHeaderActions"];
  projectSelectOptions?: AgentProjectDropdownOptions;
  renderReferencePickerSidebarActions?: (
    context: Parameters<
      NonNullable<ReferenceSourcePickerProps["renderSidebarActions"]>
    >[0] & {
      purpose: "directory" | "reference";
    }
  ) => ReactNode;
  renderSidebarFooter?: AgentGUISidebarFooterRenderer;
  /** Renders the provider rail empty state in "exact" mode. See the type doc. */
  renderProviderRailEmpty?: AgentGUIAgentsEmptyRenderer;
  providerRailAllPresentation?: AgentGUIProviderRailAllPresentation | null;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onHandoffConversation?: (input: {
    agentTargetId?: string | null;
    draftPrompt: string;
    provider: AgentGUIProvider;
    sourceAgentSessionId: string;
    userProjectPath?: string | null;
  }) => void | Promise<void>;
  showHandoffTargetOwnershipLabels?: boolean;
  capabilityMenuState?: AgentComposerProps["capabilityMenuState"];
  capabilityControlsReadOnly?: AgentComposerProps["capabilityControlsReadOnly"];
  onCapabilitySettingsRequest?: AgentComposerProps["onCapabilitySettingsRequest"];
  isActive?: boolean;
  isVisible?: boolean;
  onEngagementEvent?: AgentGUIEngagementEventSink;
  composerFocusRequestSequence?: number | null;
  workbenchCommandBridge?: AgentGuiWorkbenchCommandBridge | null;
  slashStatusLimits?: readonly AgentComposerSlashStatusLimit[];
  slashStatusLimitsLoading?: boolean;
  slashStatusLimitsUnavailable?: boolean;
  slashStatusOverride?: AgentComposerProps["slashStatus"];
  providerAuthAccountLabels?: Partial<Record<string, string>>;
  railConfigProvider?: string | null;
  railSlashStatusLimits?: readonly AgentComposerSlashStatusLimit[];
  slashStatusLimitsResolvedEmpty?: boolean;
  /** Usage capture time; null without a snapshot. */
  slashStatusUsageCapturedAtUnixMs?: number | null;
  /** True when the latest usage probe fetch failed (drives the retry state). */
  slashStatusUsageDidFail?: boolean;
  /** Localized account/usage error projected from a stable Host error code. */
  slashStatusUsageErrorMessage?: string | null;
  /** True once a usage probe has run for this provider (snapshot or error), so
   * the config menu shows a "no limits / retry" row rather than hiding the
   * whole section when there are no meters to display. */
  slashStatusUsageAttempted?: boolean;
  /** Host-rendered account/Commerce chrome for the exact selected target. */
  agentConfigAccountContent?: ReactNode;
  /** Host-rendered system actions appended to the Agent config menu. */
  agentConfigSystemActionsContent?: ReactNode;
  onAgentConfigMenuClose?: () => void;
  onAgentConfigMenuOpen?: () => void;
  /** Forces a fresh usage probe from the config menu's refresh control. */
  onAgentUsageRefresh?: () => void;
  /** Places the usage refresh control in the limits header when explicitly enabled. */
  accountUsageRefreshInline?: boolean;
  onSlashStatusOpen?: AgentComposerProps["onSlashStatusOpen"];
  onSlashStatusClose?: AgentComposerProps["onSlashStatusClose"];
  onSlashStatusRefresh?: AgentComposerProps["onSlashStatusRefresh"];
  onAgentProviderLogin?: (provider?: string | null) => void;
  onAgentEnvPanelOpen?: (input?: OpenAgentEnvPanelInput) => void;
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
      displayPrompt?: string,
      options?: Parameters<AgentComposerProps["onSubmit"]>[2]
    ) => void;
    loadOlderConversationMessages: () => void;
    showPromptImagesUnsupported: () => void;
    submitApprovalOption: (input: AgentInteractionResponseInput) => boolean;
    submitInteractivePrompt: (input: AgentInteractionResponseInput) => boolean;
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
    /** Re-issues the composer-options load after a terminal error state. */
    retryComposerOptions: NonNullable<
      AgentComposerProps["onRetryComposerOptions"]
    >;
    setTuttiModeActive: (active: boolean) => void;
    setTuttiModeEffect: (value: number) => void;
    setTuttiModeSpeed: (value: number) => void;
    retryTuttiModeActivation: () => void;
    updatePlanIssueBudgetPreset: (preset: PlanIssueBudgetPreset) => void;
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
    forkConversationThroughTurn: (
      agentSessionId: string,
      turnId: string
    ) => Promise<void>;
    openForkSourceConversation: (agentSessionId: string) => Promise<void>;
    removeProject: (path: string) => Promise<boolean>;
    moveProject: (
      projectId: string,
      beforeProjectId: string | null
    ) => Promise<void>;
    toggleProjectPinned: (projectId: string, pinned: boolean) => Promise<void>;
    confirmDeleteProjectConversations: (
      sectionKey?: string,
      agentTargetId?: string | null
    ) => Promise<string[]>;
    confirmDeleteConversations: (agentSessionIds: string[]) => Promise<boolean>;
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
  onConversationRailWidthChanged: (widthPx: number) => void;
  onConversationRailLayoutChange?: (
    layout: AgentGUIConversationRailLayout
  ) => void;
  labels: AgentGUIViewLabels;
  conversationRailLabels: AgentGUIConversationRailLabels;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
  workspaceFileManagerCopy?: WorkspaceFileManagerI18nRuntime | null;
  workspaceFileReferenceAdapter?: WorkspaceFileReferenceAdapter | null;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  onRequestGitBranches?: AgentComposerGitBranchLoader | null;
  workspaceFileReferenceCopy?: WorkspaceFileReferenceCopy | null;
  projectDirectorySourceAggregator?: ReferenceSourceAggregator | null;
  referenceSourceAggregator?: ReferenceSourceAggregator | null;
  resolveReferenceContentErrorAction?: ReferenceSourcePickerProps["resolveContentErrorAction"];
  resolveWorkspaceReferenceEntryIconUrl?: (
    entry: WorkspaceFileEntry
  ) => Promise<string | null | undefined>;
  resolveMentionReferenceTarget?: AgentMentionReferenceTargetResolver | null;
  resolveWorkspaceReferenceInitialTarget?: AgentWorkspaceReferenceInitialTargetResolver | null;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  renderComposerFooterAccessory?: AgentGUIComposerFooterAccessoryRenderer;
}
export type { AgentGUIDetailPaneProps } from "./AgentGUIDetailPane.types";

export interface AgentGUISidebarFooterContext {
  currentUserId?: string | null;
  activeConversation: AgentGUINodeViewModel["rail"]["activeConversation"];
}
export type AgentGUISidebarFooterRenderer = (
  ctx: AgentGUISidebarFooterContext
) => ReactNode;
/** Renders the host-owned empty state for an exact provider rail. */
export type AgentGUIAgentsEmptyRenderer = () => ReactNode;
