import {
  Fragment,
  memo,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { AgentActivityGoalControlAction } from "@tutti-os/agent-activity-core";
import { useSnapshot } from "valtio";
import { proxy } from "valtio/vanilla";
import {
  ChevronRight,
  ChevronsDown,
  Coins,
  Crown,
  ExternalLink,
  Gift,
  Info,
  LogIn,
  LogOut,
  Settings,
  Wrench,
  X
} from "lucide-react";
import { AgentUsageMeter } from "./AgentUsageMeter";
import { AgentProbeUsageFreshness } from "./AgentProbeUsageFreshness";
import { AccountMembershipBadge } from "./AccountMembershipBadge";
import { openAgentEnvPanel } from "../../shared/agentEnv/agentEnvPanelStore";
import { openWorkspaceSettingsPanel } from "../../shared/workspaceSettingsPanel/workspaceSettingsPanelStore";
import {
  createDisabledPlaceholderAgentGUIProviderTarget,
  createLocalAgentGUIProviderTarget
} from "../../providerTargets";
import type {
  ReferenceLocateTarget,
  ReferenceNode,
  WorkspaceFileReference,
  WorkspaceFileReferenceAdapter,
  WorkspaceFileReferenceCopy
} from "@tutti-os/workspace-file-reference/contracts";
import {
  ReferenceSourcePicker,
  WorkspaceFileReferencePicker,
  type ReferenceGroupedSelection
} from "@tutti-os/workspace-file-reference/ui";
import type { ReferenceSourceAggregator } from "@tutti-os/workspace-file-reference/core";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  NewWorkspaceLinedIcon,
  ConfirmationDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  StatusDot,
  toastVariants,
  cn
} from "@tutti-os/ui-system";
import { WorkspaceUserProjectSelect } from "@tutti-os/workspace-user-project/ui";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import type { WorkspaceFileManagerI18nRuntime } from "@tutti-os/workspace-file-manager";
import type { WorkspaceFileEntry } from "@tutti-os/workspace-file-manager/services";
import { BareIconButton, ScrollArea } from "@tutti-os/ui-system/components";
import { Button } from "../../app/renderer/components/ui/button";
import {
  CreateChatIcon,
  FolderIcon,
  FolderOpenLinedIcon,
  MoreHorizontalIcon
} from "@tutti-os/ui-system/icons";
import { PinFilledIcon } from "../../app/renderer/components/icons/PinFilledIcon";
import { PinLinedIcon } from "../../app/renderer/components/icons/PinLinedIcon";
import { UnavailableChatIcon } from "../../app/renderer/components/icons/UnavailableChatIcon";
import { SettingsLinedIcon } from "../../app/renderer/components/icons/SettingsLinedIcon";
import { AgentConversationFlow } from "../../shared/agentConversation/components/AgentConversationFlow";
import type { AgentConversationVM } from "../../shared/agentConversation/contracts/agentConversationVM";
import type { AgentPromptContentBlock } from "../../shared/contracts/dto";
import type {
  AgentComposerDraft,
  AgentHomeSuggestionAction,
  AgentHomeSuggestionCategory
} from "./model/agentGuiNodeTypes";
import { AgentHomeSuggestions } from "./AgentHomeSuggestions";
import { AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT } from "../../workbench/contribution";
import { resolveAgentGuiWorkbenchProviderLabel } from "../../workbench/providerCatalog";
import { useProjectedAgentConversation } from "../../shared/agentConversation/projection/useProjectedAgentConversation";
import { normalizeOptionalWorkspaceAgentStatus } from "../../shared/workspaceAgentStatusNormalizer";
import {
  MANAGED_AGENT_ICON_FALLBACK_URL,
  MANAGED_AGENT_ICON_URLS,
  MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS
} from "../../shared/managedAgentIcons";
import type { UiLanguage } from "../../contexts/settings/domain/agentSettings";
import type {
  AgentGUIProvider,
  AgentGUIProviderRailAllPresentation,
  AgentGUIProviderReadinessGate,
  AgentGUIProviderTarget
} from "../../types";
import { normalizeManagedAgentProvider } from "../../shared/managedAgentProviders";
import { TaskSearchField } from "../RoomIssueNode/TaskSearchField";
import type { WorkspaceLinkAction } from "../../actions/workspaceLinkActions";
import type {
  AgentGUIProviderSkillOption,
  AgentGUINodeViewModel,
  AgentGUISessionChrome
} from "./model/agentGuiNodeTypes";
import { formatAgentGUIConversationPlainTitle } from "./model/agentGuiProviderIdentity";
import { CanvasNodeTrashLinedIcon } from "../shared/canvasNodeChromeIcons";
import { AgentSessionChrome } from "./AgentSessionChrome";
import type { AgentGUIAccountMenuState } from "./accountMenuState";
import {
  AgentGoalBanner,
  isGoalBannerVisible,
  type AgentGoalBannerLabels
} from "./AgentGoalBanner";
import {
  AgentComposer,
  type AgentComposerGitBranchLoader,
  type AgentComposerProps,
  type AgentComposerPromptTip,
  type AgentComposerSlashStatusLimit,
  type AgentComposerSlashStatus,
  type WorkspaceReferencePickResult
} from "./AgentComposer";
import {
  createAgentGUIBottomDockStore,
  syncAgentGUIBottomDockStore,
  type AgentGUIBottomDockStore,
  type AgentGUIBottomDockStoreSnapshot
} from "./AgentGUIBottomDockStore";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../shared/AgentMessageMarkdown";
import {
  AgentTargetPresentationProvider,
  type AgentMessageMarkdownAgentTarget
} from "../../shared/AgentTargetPresentationContext";
import { AgentInteractivePromptSurface } from "./AgentInteractivePromptSurface";
import { AgentConversationListSkeleton } from "./AgentConversationListSkeleton";
import {
  useAgentHostApi,
  useOptionalAgentHostApi
} from "../../agentActivityHost";
import {
  useAgentActivityRuntime,
  type AgentActivityRuntimeSessionPage,
  type AgentActivityRuntimeSessionSection
} from "../../agentActivityRuntime";
import {
  ConversationMeta,
  filterConversationSectionsBySearchMatches,
  groupConversations,
  normalizeConversationProjectPath,
  type ConversationSection
} from "./agentGuiNodeViewConversation";
import { buildAgentGUIConversationSummaries } from "./model/agentGuiConversationModel";
import { filterAgentGUIConversationSummaries } from "./model/agentGuiConversationFilter";
import {
  agentGUIProviderRailOrderStorageKey,
  applyAgentGUIProviderRailOrder,
  parseAgentGUIProviderRailOrder,
  reorderAgentGUIProviderRailOrder,
  serializeAgentGUIProviderRailOrder
} from "./model/agentGuiProviderRailOrder";
import styles from "./AgentGUINode.styles";
import type { AgentContextMentionProvider } from "./agentContextMentionProvider";
import type {
  AgentContextMentionItem,
  AgentMentionWorkspaceReferenceItem
} from "./agentRichText/agentFileMentionExtension";
import {
  createAgentSessionMarkdownLink,
  createAgentSessionMentionHref,
  formatAgentMentionMarkdown
} from "./agentRichText/agentFileMentionExtension";
import { AgentMentionTooltipProviderScope } from "./agentRichText/AgentMentionNodeView";
import { createRichTextMentionHref } from "@tutti-os/ui-rich-text/core";
import { resolveAgentGuiSessionProviderFlatIconUrl } from "../../agentGuiSessionProviderIconUrls";
import { agentColorfulUrl } from "../../managedAgentIconAssets";

type StatusDotTone = "neutral" | "green" | "blue" | "amber" | "red";

/**
 * 把 @ 面板里的任务/应用 mention 解析为引用 picker 的定位目标(sourceId + 语义 params)。
 * 由宿主(desktop)注入 —— 源 id 与 params 形态是宿主侧 reference source 的知识。
 */
export type AgentMentionReferenceTargetResolver = (
  item: AgentContextMentionItem
) => ReferenceLocateTarget | null;

export interface AgentWorkspaceReferenceInitialTargetInput {
  activeConversation: AgentGUINodeViewModel["activeConversation"];
  composerSelectedProjectPath: string | null;
  userProjects: AgentGUINodeViewModel["userProjects"];
}

export type AgentWorkspaceReferenceInitialTargetResolver = (
  input: AgentWorkspaceReferenceInitialTargetInput
) => ReferenceLocateTarget | null;

const AGENT_GUI_STICK_TO_BOTTOM_THRESHOLD_PX = 24;
const AGENT_GUI_TOP_HISTORY_PREFETCH_THRESHOLD_PX = 240;
const AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX = 1;
const AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE = 5;
const AGENT_GUI_CONVERSATION_RAIL_LOADING_SKELETON_DELAY_MS = 300;
const AGENT_GUI_CONVERSATION_RAIL_PROJECTION_PROVIDER: AgentGUIProvider =
  "codex";
const AGENT_GUI_TIMELINE_SCROLL_AREA_CONTENT_STYLE: CSSProperties = {
  width: "100%",
  minWidth: "100%",
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr)",
  gap: "24px"
};

const EMPTY_WORKSPACE_APP_ICONS: readonly AgentMessageMarkdownWorkspaceAppIcon[] =
  [];
const AGENT_GUI_CONFIRMATION_DIALOG_CLASS_NAME =
  "nodrag tsh-desktop-no-drag [-webkit-app-region:no-drag]";
const AGENT_GUI_CONFIRMATION_DIALOG_OVERLAY_CLASS_NAME =
  "nodrag tsh-desktop-no-drag [-webkit-app-region:no-drag]";

interface AgentGUIProviderIconPresentation {
  iconUrl: string;
  provider: string;
}

export function resolveAgentGUIHeroIconUrl(
  provider: string | undefined
): string {
  const normalizedProvider = normalizeManagedAgentProvider(provider);
  return (
    MANAGED_AGENT_ICON_URLS[normalizedProvider] ??
    MANAGED_AGENT_ICON_FALLBACK_URL
  );
}

function agentGUIProviderIconPresentation(
  provider: string | undefined,
  iconUrl?: string | null
): AgentGUIProviderIconPresentation {
  const normalizedProvider = normalizeManagedAgentProvider(provider);
  const providerRailIconUrl =
    MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS[normalizedProvider] ?? null;
  return {
    provider: normalizedProvider,
    iconUrl:
      (normalizedProvider === "cursor" ? providerRailIconUrl : null) ||
      iconUrl?.trim() ||
      resolveAgentGUIHeroIconUrl(normalizedProvider)
  };
}

function agentGUIProviderRailIconPresentation(
  provider: string | undefined,
  iconUrl?: string | null
): AgentGUIProviderIconPresentation {
  const normalizedProvider = normalizeManagedAgentProvider(provider);
  const providerRailIconUrl =
    MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS[normalizedProvider] ?? null;
  return {
    provider: normalizedProvider,
    iconUrl:
      (normalizedProvider === "cursor" ? providerRailIconUrl : null) ||
      iconUrl?.trim() ||
      providerRailIconUrl ||
      resolveAgentGUIHeroIconUrl(normalizedProvider)
  };
}

export function shouldEmphasizeEmptyHeroProvider(label: string): boolean {
  return label.trim().length > 0;
}

const fallbackWorkspaceFileReferenceCopy: WorkspaceFileReferenceCopy = {
  t(key, values) {
    return values ? `${key}:${JSON.stringify(values)}` : key;
  }
};

function agentGuiPerfNowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function useDelayedBoolean(value: boolean, delayMs: number): boolean {
  const [delayedValue, setDelayedValue] = useState(false);

  useEffect(() => {
    if (!value) {
      setDelayedValue(false);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setDelayedValue(true);
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [delayMs, value]);

  return delayedValue;
}

function roundAgentGuiPerfMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function isDifferentKnownConversationOwner(input: {
  conversationUserId?: string | null;
  currentUserId?: string | null;
}): boolean {
  const conversationUserId = input.conversationUserId?.trim() ?? "";
  const currentUserId = input.currentUserId?.trim() ?? "";
  if (
    !conversationUserId ||
    !currentUserId ||
    conversationUserId === "local" ||
    currentUserId === "local"
  ) {
    return false;
  }
  return conversationUserId !== currentUserId;
}

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
  noConversations: string;
  emptyProjectConversations: string;
  conversationFilterAll: string;
  conversationFilterCodex: string;
  conversationFilterClaudeCode: string;
  conversationFilterTutti: string;
  providerSwitchLabel: string;
  startConversation: string;
  selectConversation: string;
  loadingConversations: string;
  loadingConversation: string;
  scrollToBottom: string;
  searchNoConversations: string;
  conversationUnavailable: string;
  fallbackAgentTitle: string;
  searchPlaceholder: string;
  sectionConversations: string;
  sectionToday: string;
  sectionPinned: string;
  sectionYesterday: string;
  sectionEarlier: string;
  projectSectionEdit: string;
  projectSectionMoreActions: string;
  projectSectionViewFiles: string;
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
  waitingForBackgroundAgent: (count: number) => string;
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
  projectLocked: string;
  projectMissingDescription: string;
  syncPending: string;
  syncSynced: string;
  syncFailed: string;
  openclawGatewayStarting: string;
  openclawGatewayFailed: string;
  openclawGatewayRetry: string;
  promptTipsPrefix: string;
  promptTips: readonly AgentComposerPromptTip[];
  reviewPicker: AgentComposerProps["labels"]["reviewPicker"];
}

interface AgentGUINodeViewProps {
  viewModel: AgentGUINodeViewModel;
  renderSidebarFooter?: AgentGUISidebarFooterRenderer;
  /** Renders the provider rail empty state in "exact" mode. See the type doc. */
  renderProviderRailEmpty?: AgentGUIProviderRailEmptyRenderer;
  /**
   * Renders the main-pane state for a selected host-disabled provider target.
   * Other readiness gates keep the built-in AgentGUI flows.
   */
  renderProviderUnavailableState?: AgentGUIProviderUnavailableStateRenderer;
  /**
   * Renders host-owned main-pane readiness gates such as checking, install,
   * login, coming-soon, or unavailable. When omitted, AgentGUI uses its built-in
   * readiness gate pane.
   */
  renderProviderReadinessGateState?: AgentGUIProviderReadinessGateStateRenderer;
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
  composerFocusRequestSequence?: number | null;
  newConversationRequestSequence?: number | null;
  isAgentProviderReady: boolean;
  slashStatusLimits?: readonly AgentComposerSlashStatusLimit[];
  slashStatusLimitsLoading?: boolean;
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
  accountMenuState?: AgentGUIAccountMenuState | null;
  previewMode?: boolean;
  onAgentProviderLogin?: (provider?: string | null) => void;
  actions: {
    updateConversationFilter: (
      filter: AgentGUINodeViewModel["conversationFilter"]
    ) => void;
    selectConversationFilterTarget: (input: {
      provider: AgentGUIProvider;
      providerTargetId?: string | null;
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
    updateDraftContent: (draftContent: AgentComposerDraft) => void;
    updateSelectedProjectPath?: AgentComposerProps["onProjectPathChange"];
    updateComposerSettings: (settings: {
      model?: string | null;
      reasoningEffort?: string | null;
      planMode?: boolean;
      permissionMode?: string;
    }) => void;
    selectHomeComposerAgentTarget: (input: {
      provider: AgentGUIProvider;
      providerTargetId?: string | null;
    }) => void;
    sendQueuedPromptNext: (queuedPromptId: string) => void;
    removeQueuedPrompt: (queuedPromptId: string) => void;
    editQueuedPrompt: (queuedPromptId: string) => void;
    retryActivation: () => void;
    continueInNewConversation: () => void;
    retryOpenclawGateway: () => void;
    toggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
    markConversationUnread: (agentSessionId: string) => void;
    renameConversation: (
      agentSessionId: string,
      title: string
    ) => Promise<void>;
    removeProject: (path: string) => void;
    confirmDeleteProjectConversations: (path?: string) => void;
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

type SyncIndicatorStatus = "pending" | "synced" | "failed";

function isContextCanceledMessage(message: string | null | undefined): boolean {
  const normalized = message?.trim().toLowerCase() ?? "";
  return normalized === "context canceled";
}

function resolveSyncIndicatorStatus(
  status: string | undefined
): SyncIndicatorStatus {
  switch (status?.trim()) {
    case "pending":
      return "pending";
    case "failed":
      return "failed";
    case "synced":
    default:
      return "synced";
  }
}

function syncStateLabel(
  status: SyncIndicatorStatus,
  labels: AgentGUIViewLabels
): string {
  switch (status) {
    case "pending":
      return labels.syncPending;
    case "synced":
      return labels.syncSynced;
    case "failed":
      return labels.syncFailed;
  }
}

function syncStateTone(status: SyncIndicatorStatus): StatusDotTone {
  switch (status) {
    case "pending":
      return "blue";
    case "failed":
      return "red";
    case "synced":
      return "blue";
  }
}

function resolveConversationDetailStatus(
  detail: AgentGUINodeViewModel["conversationDetail"]
): AgentGUINodeViewModel["conversations"][number]["status"] | null {
  if (!detail) {
    return null;
  }
  const normalized = normalizeOptionalWorkspaceAgentStatus({
    lifecycleStatus: detail.session.lifecycleStatus,
    effectiveStatus: detail.session.effectiveStatus,
    status: detail.session.status,
    turnPhase: detail.session.turnPhase
  });
  switch (normalized?.kind) {
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    case "canceled":
      return "canceled";
    case "ready":
      return "ready";
    default:
      return null;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isAppServerStartupLoading(
  rawState: AgentGUISessionChrome["rawState"],
  key: "models" | "rateLimits"
): boolean {
  return (
    objectRecord(rawState?.runtimeContext?.appServerStartup)?.[key] ===
    "loading"
  );
}

function resolveSlashStatus({
  rawState,
  limits,
  limitsLoading
}: {
  rawState: AgentGUISessionChrome["rawState"];
  limits: readonly AgentComposerSlashStatusLimit[];
  limitsLoading: boolean;
}): AgentComposerSlashStatus {
  const usage = objectRecord(rawState?.runtimeContext?.usage);
  const contextWindow =
    objectRecord(usage?.contextWindow) ??
    objectRecord(usage?.context_window) ??
    (usage &&
    (usage.used !== undefined ||
      usage.size !== undefined ||
      usage.usedTokens !== undefined ||
      usage.totalTokens !== undefined)
      ? {
          usedTokens:
            numberValue(usage.usedTokens) ??
            numberValue(usage.used_tokens) ??
            numberValue(usage.used),
          totalTokens:
            numberValue(usage.totalTokens) ??
            numberValue(usage.total_tokens) ??
            numberValue(usage.size)
        }
      : null);
  const providerConfig = objectRecord(rawState?.runtimeContext?.providerConfig);
  return {
    agentSessionId: rawState?.agentSessionId ?? null,
    baseUrl: stringValue(providerConfig?.baseUrl) || null,
    limits,
    limitsLoading:
      limitsLoading || isAppServerStartupLoading(rawState, "rateLimits"),
    contextWindow: contextWindow
      ? {
          usedTokens:
            numberValue(contextWindow.usedTokens) ??
            numberValue(contextWindow.used_tokens),
          totalTokens:
            numberValue(contextWindow.totalTokens) ??
            numberValue(contextWindow.total_tokens)
        }
      : null
  };
}

function slashStatusLimitsEqual(
  left: readonly AgentComposerSlashStatusLimit[] | null | undefined,
  right: readonly AgentComposerSlashStatusLimit[] | null | undefined
): boolean {
  const leftLimits = left ?? [];
  const rightLimits = right ?? [];
  return (
    leftLimits.length === rightLimits.length &&
    leftLimits.every((limit, index) => {
      const rightLimit = rightLimits[index]!;
      return (
        limit.id === rightLimit.id &&
        limit.label === rightLimit.label &&
        (limit.percentRemaining ?? null) ===
          (rightLimit.percentRemaining ?? null) &&
        limit.value === rightLimit.value
      );
    })
  );
}

function slashStatusesEqual(
  left: AgentComposerSlashStatus,
  right: AgentComposerSlashStatus
): boolean {
  return (
    (left.agentSessionId ?? null) === (right.agentSessionId ?? null) &&
    (left.baseUrl ?? null) === (right.baseUrl ?? null) &&
    (left.contextWindow?.usedTokens ?? null) ===
      (right.contextWindow?.usedTokens ?? null) &&
    (left.contextWindow?.totalTokens ?? null) ===
      (right.contextWindow?.totalTokens ?? null) &&
    slashStatusLimitsEqual(left.limits, right.limits) &&
    Boolean(left.limitsLoading) === Boolean(right.limitsLoading)
  );
}

function useStableSlashStatus(
  status: AgentComposerSlashStatus
): AgentComposerSlashStatus {
  const statusRef = useRef<AgentComposerSlashStatus | null>(null);
  if (
    statusRef.current === null ||
    !slashStatusesEqual(statusRef.current, status)
  ) {
    statusRef.current = status;
  }
  return statusRef.current;
}

function conversationHasActiveWork(
  conversation: AgentConversationVM | null | undefined
): boolean {
  return (
    conversation?.rows.some((row) => {
      if (row.kind === "processing") {
        return true;
      }
      if (row.kind === "tool-group") {
        return row.calls.some(
          (call) =>
            call.statusKind === "working" || call.statusKind === "waiting"
        );
      }
      if (row.kind === "message") {
        return row.thinking.some(
          (thinking) =>
            thinking.statusKind === "working" ||
            thinking.statusKind === "waiting"
        );
      }
      return false;
    }) ?? false
  );
}

function isSettledConversationStatus(
  status:
    | AgentGUINodeViewModel["conversations"][number]["status"]
    | null
    | undefined
): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function resolveActiveConversationBusyStatus(input: {
  conversationStatus:
    | AgentGUINodeViewModel["conversations"][number]["status"]
    | undefined;
  detailStatus: AgentGUINodeViewModel["conversations"][number]["status"] | null;
  conversation: AgentConversationVM | null | undefined;
}): AgentGUINodeViewModel["conversations"][number]["status"] | null {
  if (
    input.conversationStatus === "waiting" ||
    input.detailStatus === "waiting"
  ) {
    return "waiting";
  }
  if (
    input.conversationStatus === "working" ||
    input.detailStatus === "working"
  ) {
    return "working";
  }
  if (
    isSettledConversationStatus(input.conversationStatus) ||
    isSettledConversationStatus(input.detailStatus)
  ) {
    return null;
  }
  if (conversationHasActiveWork(input.conversation)) {
    return "working";
  }
  return null;
}

function conversationPlainTitle(
  conversation: Pick<
    AgentGUINodeViewModel["conversations"][number],
    "title" | "titleFallback"
  >,
  labels: Pick<AgentGUIViewLabels, "fallbackAgentTitle">,
  uiLanguage: UiLanguage
): string {
  return formatAgentGUIConversationPlainTitle(conversation, {
    fallbackAgentLabel: labels.fallbackAgentTitle,
    language: uiLanguage
  });
}

function buildAgentConversationHandoffPrompt(input: {
  activeConversation: AgentGUINodeViewModel["activeConversation"];
  currentUserId?: string | null;
  labels: Pick<AgentGUIViewLabels, "fallbackAgentTitle">;
  selectedProviderTarget: AgentGUIProviderTarget | null;
  uiLanguage: UiLanguage;
  workspaceId: string;
}): string {
  const conversation = input.activeConversation;
  if (!conversation) {
    return "";
  }
  const sourceAgentLabel =
    input.selectedProviderTarget?.label?.trim() || conversation.provider;
  const title = conversationPlainTitle(
    conversation,
    input.labels,
    input.uiLanguage
  );
  const mentionLabel = `${sourceAgentLabel}${title ? ` ${title}` : ""}`.trim();
  const href = createAgentSessionMentionHref({
    agentTargetId: conversation.agentTargetId,
    agentSessionId: conversation.id,
    label: mentionLabel,
    workspaceId: input.workspaceId
  });
  return `${formatAgentMentionMarkdown({
    kind: "session",
    href,
    workspaceId: input.workspaceId,
    targetId: conversation.id,
    agentTargetId: conversation.agentTargetId ?? undefined,
    name: mentionLabel,
    title: title || sourceAgentLabel,
    scope: "my_sessions",
    initiatorName: input.currentUserId?.trim() || sourceAgentLabel,
    agentName: sourceAgentLabel,
    status: conversation.status,
    updatedAtUnixMs: conversation.updatedAtUnixMs
  })} `;
}

function handoffProjectPathForConversation(
  conversation: AgentGUINodeViewModel["activeConversation"]
): string | null {
  return (
    conversation?.project?.path?.trim() || conversation?.cwd?.trim() || null
  );
}

export interface AgentGUISidebarFooterContext {
  currentUserId?: string | null;
  activeConversation: AgentGUINodeViewModel["activeConversation"];
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
export type AgentGUIProviderRailEmptyRenderer = () => ReactNode;

export interface AgentGUIProviderUnavailableStateContext {
  provider: AgentGUIProvider;
  providerLabel: string;
  target: AgentGUIProviderTarget;
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

export interface AgentGUIProviderReadinessGateStateContext {
  provider: AgentGUIProvider;
  providerLabel: string;
  target: AgentGUIProviderTarget | null;
  iconUrl: string;
  gate: AgentGUIProviderReadinessGate;
  showAllProviders: boolean;
}

/**
 * Renders the main-pane state for a host-projected provider readiness gate.
 * Use this when a host has product-specific semantics for a readiness state,
 * for example a shared agent that is temporarily unavailable because the owner
 * is offline or sharing was revoked.
 */
export type AgentGUIProviderReadinessGateStateRenderer = (
  ctx: AgentGUIProviderReadinessGateStateContext
) => ReactNode;

export function AgentGUINodeView({
  viewModel,
  renderSidebarFooter,
  renderProviderRailEmpty,
  renderProviderUnavailableState,
  renderProviderReadinessGateState,
  providerRailAllPresentation,
  onLinkAction,
  onHandoffConversation,
  capabilityMenuState,
  onCapabilitySettingsRequest,
  isActive = true,
  composerFocusRequestSequence = null,
  newConversationRequestSequence = null,
  isAgentProviderReady,
  slashStatusLimits = [],
  slashStatusLimitsLoading = false,
  providerAuthAccountLabels,
  railConfigProvider,
  railSlashStatusLimits,
  slashStatusUsageCapturedAtUnixMs = null,
  slashStatusUsageDidFail = false,
  slashStatusUsageAttempted = false,
  onAgentConfigMenuOpen,
  onAgentUsageRefresh,
  accountMenuState = null,
  previewMode = false,
  onAgentProviderLogin,
  actions,
  conversationRailCollapsed,
  conversationRailWidthPx,
  conversationRailMinWidthPx,
  conversationRailMaxWidthPx,
  detailMinWidthPx,
  uiLanguage,
  onWorkspaceFileReferencesAdded,
  resolveDroppedFileReferences = null,
  onConversationRailWidthChanged,
  labels,
  workspaceUserProjectI18n,
  workspaceFileManagerCopy = null,
  workspaceFileReferenceAdapter = null,
  onOpenConversationWindow,
  selectProjectDirectory,
  workspaceFileReferenceCopy = null,
  onRequestGitBranches = null,
  contextMentionProviders,
  referenceSourceAggregator = null,
  resolveWorkspaceReferenceEntryIconUrl,
  resolveMentionReferenceTarget = null,
  resolveWorkspaceReferenceInitialTarget = null,
  workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS
}: AgentGUINodeViewProps): React.JSX.Element {
  "use memo";
  const layoutElementRef = useRef<HTMLDivElement | null>(null);
  const railResizeInteractionRef = useRef<{
    lastWidthPx: number;
    pointerId: number;
    startClientX: number;
    startWidthPx: number;
  } | null>(null);
  const [isRailResizing, setIsRailResizing] = useState(false);
  const [railResizeWidthPx, setRailResizeWidthPx] = useState<number | null>(
    null
  );
  const [workspaceReferencePickerOpen, setWorkspaceReferencePickerOpen] =
    useState(false);
  // 打开引用 picker 时的定位目标(点任务/应用行的产物图标时设置;「+」按钮则为 null)。
  const [workspaceReferencePickerTarget, setWorkspaceReferencePickerTarget] =
    useState<ReferenceLocateTarget | null>(null);
  const [
    localComposerFocusRequestSequence,
    setLocalComposerFocusRequestSequence
  ] = useState(0);
  const handledNewConversationRequestSequenceRef = useRef(
    newConversationRequestSequence
  );
  const workspaceReferencePickerResolverRef = useRef<
    ((result: WorkspaceReferencePickResult) => void) | null
  >(null);
  const emptyReferencePickResult: WorkspaceReferencePickResult = useMemo(
    () => ({ files: [], mentionItems: [] }),
    []
  );
  const hostLocalFileSourceId = "host-local-file";
  const isWorkspaceReferencePickerNodeSelectable = useCallback(
    (node: ReferenceNode) =>
      node.ref.sourceId !== hostLocalFileSourceId || node.kind === "file",
    [hostLocalFileSourceId]
  );
  const requestWorkspaceReferences = useCallback(
    async (
      entity?: AgentContextMentionItem | null
    ): Promise<WorkspaceReferencePickResult> => {
      if (previewMode) {
        return emptyReferencePickResult;
      }
      if (!workspaceFileReferenceAdapter && !referenceSourceAggregator) {
        return emptyReferencePickResult;
      }
      // 仅多源 picker(referenceSourceAggregator)支持定位;本地 picker 不支持。
      const target =
        entity && referenceSourceAggregator
          ? (resolveMentionReferenceTarget?.(entity) ?? null)
          : referenceSourceAggregator
            ? (resolveWorkspaceReferenceInitialTarget?.({
                activeConversation: viewModel.activeConversation,
                composerSelectedProjectPath:
                  viewModel.composerSettings.selectedProjectPath ?? null,
                userProjects: viewModel.userProjects
              }) ?? null)
            : null;
      setWorkspaceReferencePickerTarget(target);
      setWorkspaceReferencePickerOpen(true);
      return await new Promise<WorkspaceReferencePickResult>((resolve) => {
        workspaceReferencePickerResolverRef.current = resolve;
      });
    },
    [
      emptyReferencePickResult,
      previewMode,
      referenceSourceAggregator,
      resolveMentionReferenceTarget,
      resolveWorkspaceReferenceInitialTarget,
      viewModel.activeConversation,
      viewModel.composerSettings.selectedProjectPath,
      viewModel.userProjects,
      workspaceFileReferenceAdapter,
      workspaceFileReferenceCopy
    ]
  );
  const closeWorkspaceReferencePicker = useCallback(() => {
    workspaceReferencePickerResolverRef.current?.(emptyReferencePickResult);
    workspaceReferencePickerResolverRef.current = null;
    setWorkspaceReferencePickerOpen(false);
    setWorkspaceReferencePickerTarget(null);
  }, [emptyReferencePickResult]);
  const settleReferencePicker = useCallback(
    (
      result: WorkspaceReferencePickResult,
      addedFiles: WorkspaceFileReference[]
    ) => {
      workspaceReferencePickerResolverRef.current?.(result);
      workspaceReferencePickerResolverRef.current = null;
      setWorkspaceReferencePickerOpen(false);
      setWorkspaceReferencePickerTarget(null);
      if (addedFiles.length > 0) {
        void onWorkspaceFileReferencesAdded?.(addedFiles);
      }
    },
    [onWorkspaceFileReferencesAdded]
  );
  const confirmWorkspaceReferencePicker = useCallback(
    (refs: WorkspaceFileReference[]) => {
      settleReferencePicker({ files: refs, mentionItems: [] }, refs);
    },
    [settleReferencePicker]
  );
  // 「文件夹=一个 reference 节点」确认:navigable 源文件夹折叠成 workspace-reference
  // mention item(只携带可解析句柄 source+id+groupId,不展开文件);松散文件仍按 file
  // mention 插入。agent 收到 `mention://workspace-reference/...` 后经 skill+CLI 按需解析。
  const confirmWorkspaceReferenceBundles = useCallback(
    (result: ReferenceGroupedSelection) => {
      const workspaceRefs = result.files.filter(
        (ref) => ref.sourceId !== hostLocalFileSourceId
      );
      const mentionItems: AgentMentionWorkspaceReferenceItem[] = result.bundles
        .filter((bundle) => bundle.handle != null)
        .map((bundle) => {
          const handle = bundle.handle!;
          const bundleIconUrl = bundle.iconUrl ?? undefined;
          return {
            kind: "workspace-reference",
            href: createRichTextMentionHref({
              providerId: "workspace-reference",
              entityId: handle.id,
              label: bundle.displayName,
              scope: {
                workspaceId: viewModel.workspaceId,
                source: handle.source,
                ...(handle.groupId?.trim()
                  ? { groupId: handle.groupId.trim() }
                  : {}),
                ...(bundle.fileCount > 0
                  ? { count: String(bundle.fileCount) }
                  : {})
              }
            }),
            workspaceId: viewModel.workspaceId,
            targetId: handle.id,
            source: handle.source,
            ...(handle.groupId ? { groupId: handle.groupId } : {}),
            name: bundle.displayName,
            iconUrl: bundleIconUrl,
            fileCount: bundle.fileCount
          };
        });
      // bundle 不再展开文件,仅松散文件计入「最近引用」跟踪。
      settleReferencePicker(
        { files: result.files, mentionItems },
        workspaceRefs
      );
    },
    [hostLocalFileSourceId, settleReferencePicker]
  );
  const openclawGateway = useMemo(
    () =>
      viewModel.openclawGateway ??
      (viewModel.data.provider === "openclaw"
        ? { status: "starting" as const, error: null }
        : null),
    [viewModel.data.provider, viewModel.openclawGateway]
  );
  const isOpenclawGatewayBlocking =
    openclawGateway !== null && openclawGateway.status !== "ready";
  const createConversationDisabled =
    viewModel.isCreatingConversation ||
    viewModel.selectedProviderTarget.disabled === true ||
    isOpenclawGatewayBlocking;
  const createConversationAction = useStableEventCallback(
    actions.createConversation
  );
  const retryOpenclawGateway = useStableEventCallback(
    actions.retryOpenclawGateway
  );
  const selectConversation = useStableEventCallback(actions.selectConversation);
  const toggleConversationPinned = useStableEventCallback(
    actions.toggleConversationPinned
  );
  const removeProject = useStableEventCallback(actions.removeProject);
  const confirmDeleteProjectConversations = useStableEventCallback(
    actions.confirmDeleteProjectConversations
  );
  const confirmDeleteConversations = useStableEventCallback(
    actions.confirmDeleteConversations
  );
  const requestDeleteConversation = useStableEventCallback(
    actions.requestDeleteConversation
  );
  const cancelDeleteConversation = useStableEventCallback(
    actions.cancelDeleteConversation
  );
  const confirmDeleteConversation = useStableEventCallback(
    actions.confirmDeleteConversation
  );
  const openConversationWindow = useOptionalStableEventCallback(
    onOpenConversationWindow
  );
  const openProjectFiles = useOptionalStableEventCallback(onLinkAction);
  const detailComposerFocusRequestSequence =
    localComposerFocusRequestSequence === 0
      ? composerFocusRequestSequence
      : (composerFocusRequestSequence ?? 0) + localComposerFocusRequestSequence;
  const requestComposerFocus = useCallback(() => {
    setLocalComposerFocusRequestSequence((current) => current + 1);
  }, []);
  const requestCreateConversation = useCallback(
    (options?: { projectPath?: string | null; source?: string }) => {
      if (previewMode) {
        return;
      }
      const source = options?.source;
      if (options && "projectPath" in options) {
        createConversationAction(options);
      } else if (viewModel.composerSettings.selectedProjectPath) {
        createConversationAction({
          projectPath: viewModel.composerSettings.selectedProjectPath,
          source: source ?? "selected_project"
        });
      } else {
        createConversationAction({ source: source ?? "rail_toolbar" });
      }
      requestComposerFocus();
    },
    [
      createConversationAction,
      previewMode,
      requestComposerFocus,
      viewModel.composerSettings.selectedProjectPath
    ]
  );
  useEffect(() => {
    if (
      newConversationRequestSequence === null ||
      handledNewConversationRequestSequenceRef.current ===
        newConversationRequestSequence
    ) {
      return;
    }

    handledNewConversationRequestSequenceRef.current =
      newConversationRequestSequence;
    if (!createConversationDisabled) {
      requestCreateConversation({ source: "external_request" });
    }
  }, [
    createConversationDisabled,
    newConversationRequestSequence,
    requestCreateConversation
  ]);
  const effectiveWorkspaceAppIcons = useMemo(
    () =>
      mergeWorkspaceAppIconsFromCommands({
        commands: viewModel.availableCommands,
        workspaceAppIcons,
        workspaceId: viewModel.workspaceId
      }),
    [viewModel.availableCommands, viewModel.workspaceId, workspaceAppIcons]
  );

  const clampConversationRailWidth = useCallback(
    (widthPx: number) =>
      Math.min(
        conversationRailMaxWidthPx,
        Math.max(conversationRailMinWidthPx, widthPx)
      ),
    [conversationRailMaxWidthPx, conversationRailMinWidthPx]
  );

  const handleConversationRailResizePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (previewMode) {
        return;
      }
      if (conversationRailCollapsed || event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      railResizeInteractionRef.current = {
        lastWidthPx: conversationRailWidthPx,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startWidthPx: conversationRailWidthPx
      };
      setRailResizeWidthPx(conversationRailWidthPx);
      setIsRailResizing(true);
    },
    [conversationRailCollapsed, conversationRailWidthPx, previewMode]
  );

  const handleConversationRailResizePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (previewMode) {
        return;
      }
      const resizeState = railResizeInteractionRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) {
        return;
      }

      const nextWidthPx = clampConversationRailWidth(
        resizeState.startWidthPx + event.clientX - resizeState.startClientX
      );
      if (resizeState.lastWidthPx !== nextWidthPx) {
        resizeState.lastWidthPx = nextWidthPx;
        layoutElementRef.current?.style.setProperty(
          "--agent-gui-conversation-rail-width",
          `${nextWidthPx}px`
        );
        event.currentTarget.setAttribute("aria-valuenow", String(nextWidthPx));
      }
    },
    [clampConversationRailWidth, previewMode]
  );

  const endConversationRailResize = useCallback(
    (event?: PointerEvent<HTMLDivElement>): void => {
      const resizeState = railResizeInteractionRef.current;
      if (
        event &&
        resizeState?.pointerId === event.pointerId &&
        event.currentTarget.hasPointerCapture?.(event.pointerId)
      ) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
      railResizeInteractionRef.current = null;
      if (resizeState) {
        const nextWidthPx = resizeState.lastWidthPx;
        setRailResizeWidthPx(nextWidthPx);
        onConversationRailWidthChanged(nextWidthPx);
      } else {
        setRailResizeWidthPx(null);
      }
      setIsRailResizing(false);
    },
    [onConversationRailWidthChanged]
  );

  useEffect(() => {
    if (isRailResizing || railResizeWidthPx === null) {
      return;
    }
    if (
      conversationRailCollapsed ||
      conversationRailWidthPx === railResizeWidthPx
    ) {
      setRailResizeWidthPx(null);
    }
  }, [
    conversationRailCollapsed,
    conversationRailWidthPx,
    isRailResizing,
    railResizeWidthPx
  ]);

  const handleConversationRailResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (previewMode) {
        return;
      }
      if (conversationRailCollapsed) {
        return;
      }

      const stepPx = event.shiftKey ? 48 : 16;
      const direction =
        event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (direction === 0) {
        return;
      }

      event.preventDefault();
      onConversationRailWidthChanged(
        clampConversationRailWidth(conversationRailWidthPx + direction * stepPx)
      );
    },
    [
      clampConversationRailWidth,
      conversationRailCollapsed,
      conversationRailWidthPx,
      onConversationRailWidthChanged,
      previewMode
    ]
  );

  const visualConversationRailWidthPx = isRailResizing
    ? (railResizeInteractionRef.current?.lastWidthPx ?? conversationRailWidthPx)
    : (railResizeWidthPx ?? conversationRailWidthPx);
  const effectiveConversationRailWidthPx = conversationRailCollapsed
    ? 0
    : visualConversationRailWidthPx;
  const showProviderRail = true;
  const renderProviderRail = showProviderRail && !conversationRailCollapsed;

  const layoutStyle = {
    "--agent-gui-conversation-rail-width": `${effectiveConversationRailWidthPx}px`,
    "--agent-gui-conversation-rail-content-width": `${visualConversationRailWidthPx}px`,
    "--agent-gui-detail-min-width": `${detailMinWidthPx}px`,
    "--agent-gui-provider-rail-width": renderProviderRail ? "52px" : "0px",
    gridTemplateColumns: showProviderRail
      ? "var(--agent-gui-provider-rail-width) var(--agent-gui-conversation-rail-width) minmax(var(--agent-gui-detail-min-width), 1fr)"
      : "var(--agent-gui-conversation-rail-width) minmax(var(--agent-gui-detail-min-width), 1fr)"
  } as CSSProperties;
  const effectiveRailConfigProvider =
    railConfigProvider === undefined
      ? viewModel.data.provider
      : railConfigProvider;
  const effectiveRailSlashStatusLimits =
    railSlashStatusLimits ?? slashStatusLimits;
  const shouldShowProviderRailConfigButton =
    viewModel.conversationFilter.kind === "all" ||
    viewModel.selectedProviderTarget?.disabled !== true;
  const shouldShowProviderRailConfigMenu =
    shouldShowProviderRailConfigButton &&
    viewModel.conversationFilter.kind !== "all";
  const effectiveProviderAuthAccountLabel = useMemo(() => {
    const provider =
      (effectiveRailConfigProvider ?? viewModel.data.provider)?.trim() ?? "";
    if (!provider) {
      return null;
    }
    const label = providerAuthAccountLabels?.[provider]?.trim();
    return label || null;
  }, [
    effectiveRailConfigProvider,
    providerAuthAccountLabels,
    viewModel.data.provider
  ]);
  const enabledProviderTargets = viewModel.providerTargets.filter(
    (target) =>
      target.disabled !== true &&
      ((target.agentTargetId?.trim() ?? "") || (target.targetId?.trim() ?? ""))
  );
  const sectionAgentTargetFallbackId =
    enabledProviderTargets.length <= 1
      ? viewModel.selectedProviderTarget.agentTargetId?.trim() ||
        viewModel.selectedProviderTarget.targetId?.trim() ||
        null
      : null;
  const openAgentEnvSetup = useCallback(() => {
    // In the "All" filter there is no single rail provider; pass it through as
    // null so the env panel host falls back to the default provider.
    openAgentEnvPanel({ provider: effectiveRailConfigProvider, focus: null });
  }, [effectiveRailConfigProvider]);
  const openAgentSettings = useCallback(() => {
    openWorkspaceSettingsPanel({ section: "agent" });
  }, []);
  const [renameConversationTarget, setRenameConversationTarget] = useState<
    AgentGUINodeViewModel["conversations"][number] | null
  >(null);
  const [renameConversationDialogOpen, setRenameConversationDialogOpen] =
    useState(false);
  const requestRenameConversation = useStableEventCallback(
    (agentSessionId: string) => {
      const target =
        viewModel.conversations.find(
          (conversation) => conversation.id === agentSessionId
        ) ??
        (viewModel.activeConversation?.id === agentSessionId
          ? viewModel.activeConversation
          : null);
      if (target) {
        setRenameConversationTarget(target);
        setRenameConversationDialogOpen(true);
      }
    }
  );
  const conversationRailStoreState =
    useMemo<AgentGUIConversationRailStoreSnapshot>(
      () => ({
        activeConversationId: viewModel.activeConversationId,
        pendingDeleteConversationId:
          viewModel.pendingDeleteConversation?.id ?? null,
        isLoadingConversations: viewModel.isLoadingConversations,
        isDeletingConversation: viewModel.isDeletingConversation,
        isDeletingProjectConversations:
          viewModel.isDeletingProjectConversations,
        labels,
        workspaceUserProjectI18n,
        uiLanguage,
        previewMode,
        createConversationDisabled,
        openclawGateway,
        isCollapsed: conversationRailCollapsed,
        providerTargets: viewModel.providerTargets,
        providerTargetsLoading: viewModel.providerTargetsLoading,
        conversationFilter: viewModel.conversationFilter,
        sectionAgentTargetFallbackId,
        onCreateConversation: requestCreateConversation,
        onUpdateConversationFilter: actions.updateConversationFilter,
        onSelectConversationFilterTarget:
          actions.selectConversationFilterTarget,
        onRetryOpenclawGateway: retryOpenclawGateway,
        onSelectConversation: selectConversation,
        onToggleConversationPinned: toggleConversationPinned,
        onMarkConversationUnread: actions.markConversationUnread,
        onRemoveProject: removeProject,
        onConfirmDeleteProjectConversations: confirmDeleteProjectConversations,
        onConfirmDeleteConversations: confirmDeleteConversations,
        onRequestDeleteConversation: requestDeleteConversation,
        onRequestRenameConversation: requestRenameConversation,
        onCancelDeleteConversation: cancelDeleteConversation,
        onConfirmDeleteConversation: confirmDeleteConversation,
        onOpenProjectFiles: openProjectFiles,
        onOpenConversationWindow: openConversationWindow,
        selectProjectDirectory
      }),
      [
        cancelDeleteConversation,
        confirmDeleteConversation,
        confirmDeleteConversations,
        confirmDeleteProjectConversations,
        conversationRailCollapsed,
        createConversationDisabled,
        labels,
        openConversationWindow,
        openProjectFiles,
        openclawGateway,
        actions.markConversationUnread,
        actions.updateConversationFilter,
        previewMode,
        removeProject,
        requestCreateConversation,
        requestDeleteConversation,
        requestRenameConversation,
        retryOpenclawGateway,
        selectConversation,
        selectProjectDirectory,
        sectionAgentTargetFallbackId,
        viewModel.providerTargets,
        viewModel.providerTargetsLoading,
        toggleConversationPinned,
        uiLanguage,
        viewModel.conversationFilter,
        viewModel.activeConversationId,
        viewModel.isDeletingConversation,
        viewModel.isDeletingProjectConversations,
        viewModel.isLoadingConversations,
        viewModel.pendingDeleteConversation?.id,
        workspaceUserProjectI18n
      ]
    );
  const conversationRailStoreRef = useRef<AgentGUIConversationRailStore | null>(
    null
  );
  if (conversationRailStoreRef.current === null) {
    conversationRailStoreRef.current = createAgentGUIConversationRailStore(
      conversationRailStoreState
    );
  }
  const conversationRailStore = conversationRailStoreRef.current;
  syncAgentGUIConversationRailStore(
    conversationRailStore,
    conversationRailStoreState
  );
  const agentTargetPresentations = useMemo<
    readonly AgentMessageMarkdownAgentTarget[]
  >(
    () =>
      viewModel.providerTargets.flatMap((target) =>
        target.agentTargetId
          ? [
              {
                agentTargetId: target.agentTargetId,
                iconUrl: target.iconUrl ?? null,
                name: target.label,
                provider: target.provider,
                workspaceId: viewModel.workspaceId
              }
            ]
          : []
      ),
    [viewModel.providerTargets, viewModel.workspaceId]
  );

  const content = (
    <AgentTargetPresentationProvider agentTargets={agentTargetPresentations}>
      <div
        ref={layoutElementRef}
        className={styles.layout}
        data-agent-gui-preview={previewMode ? "true" : undefined}
        data-rail-resizing={isRailResizing ? "true" : undefined}
        inert={previewMode ? true : undefined}
        style={layoutStyle}
      >
        {showProviderRail ? (
          <aside
            className={`${styles.providerRailPanel} nodrag tsh-desktop-no-drag`}
            aria-label={labels.providerSwitchLabel}
            aria-hidden={conversationRailCollapsed ? "true" : undefined}
            inert={conversationRailCollapsed ? true : undefined}
          >
            <AgentGUIProviderRail
              conversationFilter={viewModel.conversationFilter}
              labels={labels}
              previewMode={previewMode}
              workspaceId={viewModel.workspaceId}
              selectedProviderTarget={viewModel.selectedProviderTarget}
              providerTargets={viewModel.providerTargets}
              providerTargetsLoading={viewModel.providerTargetsLoading}
              providerRailMode={viewModel.providerRailMode}
              renderProviderRailEmpty={renderProviderRailEmpty}
              providerRailAllPresentation={providerRailAllPresentation}
              comingSoonProviders={viewModel.comingSoonProviders}
              onSelectConversationFilterTarget={
                actions.selectConversationFilterTarget
              }
              onUpdateConversationFilter={actions.updateConversationFilter}
              onRequestComposerFocus={requestComposerFocus}
            />
            {renderSidebarFooter ? (
              <div
                className={`${styles.providerRailFooter} nodrag tsh-desktop-no-drag`}
                data-testid="agent-gui-sidebar-footer-slot"
              >
                {renderSidebarFooter({
                  currentUserId: viewModel.currentUserId,
                  activeConversation: viewModel.activeConversation
                })}
              </div>
            ) : null}
            {shouldShowProviderRailConfigButton ? (
              <div
                className={`${styles.providerRailFooter} nodrag tsh-desktop-no-drag`}
                data-testid="agent-gui-config-footer"
              >
                {shouldShowProviderRailConfigMenu ? (
                  <AgentGUIConfigMenu
                    labels={labels}
                    previewMode={previewMode}
                    slashStatusLimits={effectiveRailSlashStatusLimits}
                    slashStatusLimitsLoading={slashStatusLimitsLoading}
                    slashStatusUsageCapturedAtUnixMs={
                      slashStatusUsageCapturedAtUnixMs
                    }
                    slashStatusUsageDidFail={slashStatusUsageDidFail}
                    slashStatusUsageAttempted={slashStatusUsageAttempted}
                    providerAuthAccountLabel={effectiveProviderAuthAccountLabel}
                    onAgentConfigMenuOpen={onAgentConfigMenuOpen}
                    onAgentUsageRefresh={onAgentUsageRefresh}
                    onOpenAgentEnvSetup={openAgentEnvSetup}
                    onOpenAgentSettings={openAgentSettings}
                  />
                ) : (
                  <button
                    type="button"
                    aria-label={labels.agentSettingsMenu}
                    className={`${styles.providerRailConfigButton} nodrag tsh-desktop-no-drag`}
                    title={labels.agentSettingsMenu}
                    disabled={previewMode}
                    onClick={openAgentSettings}
                  >
                    <SettingsLinedIcon
                      aria-hidden="true"
                      width={18}
                      height={18}
                    />
                  </button>
                )}
              </div>
            ) : null}
          </aside>
        ) : null}
        <aside
          id="agent-gui-conversation-rail"
          className={`${styles.railPanel}${
            conversationRailCollapsed ? ` ${styles.railPanelCollapsed}` : ""
          }`}
          aria-hidden={conversationRailCollapsed ? "true" : undefined}
          inert={conversationRailCollapsed ? true : undefined}
        >
          <AgentGUIConversationRailStorePane
            conversations={viewModel.conversations}
            store={conversationRailStore}
            storeState={conversationRailStoreState}
            userProjects={viewModel.userProjects}
            workspaceId={viewModel.workspaceId}
            footer={
              accountMenuState?.user ? (
                <AgentGUIAccountRailMenu
                  accountMenuState={accountMenuState}
                  labels={labels}
                  previewMode={previewMode}
                />
              ) : null
            }
          />
        </aside>
        <div
          id="agent-gui-conversation-rail-resize"
          className={
            conversationRailCollapsed
              ? `${styles.railResizeHandle} ${styles.railResizeHandleCollapsed} nodrag pointer-events-none opacity-0`
              : `${styles.railResizeHandle} nodrag`
          }
          role="separator"
          aria-label={labels.conversationRailResizeAria}
          aria-hidden={conversationRailCollapsed ? "true" : undefined}
          aria-orientation="vertical"
          aria-valuemin={conversationRailMinWidthPx}
          aria-valuemax={conversationRailMaxWidthPx}
          aria-valuenow={
            conversationRailCollapsed
              ? undefined
              : visualConversationRailWidthPx
          }
          data-resizing={isRailResizing ? "true" : undefined}
          data-testid="agent-gui-conversation-rail-resize-handle"
          tabIndex={conversationRailCollapsed ? -1 : 0}
          onBlur={() => endConversationRailResize()}
          onKeyDown={handleConversationRailResizeKeyDown}
          onPointerCancel={endConversationRailResize}
          onPointerDown={handleConversationRailResizePointerDown}
          onLostPointerCapture={endConversationRailResize}
          onPointerMove={handleConversationRailResizePointerMove}
          onPointerUp={endConversationRailResize}
        />

        <section id="agent-gui-detail" className={styles.detailPanel}>
          <AgentGUIDetailPane
            viewModel={viewModel}
            actions={actions}
            labels={labels}
            uiLanguage={uiLanguage}
            hideDetailHeader={conversationRailCollapsed}
            isActive={isActive}
            workspaceReferencePickerOpen={workspaceReferencePickerOpen}
            composerFocusRequestSequence={detailComposerFocusRequestSequence}
            isAgentProviderReady={isAgentProviderReady}
            slashStatusLimits={slashStatusLimits}
            slashStatusLimitsLoading={slashStatusLimitsLoading}
            onLinkAction={onLinkAction}
            onHandoffConversation={onHandoffConversation}
            capabilityMenuState={capabilityMenuState}
            onCapabilitySettingsRequest={onCapabilitySettingsRequest}
            onAgentProviderLogin={onAgentProviderLogin}
            onRequestWorkspaceReferences={requestWorkspaceReferences}
            resolveDroppedFileReferences={resolveDroppedFileReferences}
            selectProjectDirectory={selectProjectDirectory}
            onRequestGitBranches={onRequestGitBranches}
            onRequestComposerFocus={requestComposerFocus}
            contextMentionProviders={contextMentionProviders}
            workspaceAppIcons={effectiveWorkspaceAppIcons}
            workspaceUserProjectI18n={workspaceUserProjectI18n}
            renderProviderUnavailableState={renderProviderUnavailableState}
            renderProviderReadinessGateState={renderProviderReadinessGateState}
            previewMode={previewMode}
          />
        </section>
      </div>
      {referenceSourceAggregator ? (
        <ReferenceSourcePicker
          aggregator={referenceSourceAggregator}
          copy={
            workspaceFileReferenceCopy ?? fallbackWorkspaceFileReferenceCopy
          }
          initialTarget={workspaceReferencePickerTarget}
          isNodeSelectable={isWorkspaceReferencePickerNodeSelectable}
          fileManagerCopy={workspaceFileManagerCopy ?? undefined}
          open={workspaceReferencePickerOpen}
          resolveEntryIconUrl={resolveWorkspaceReferenceEntryIconUrl}
          workspaceId={viewModel.workspaceId}
          onClose={closeWorkspaceReferencePicker}
          onConfirm={confirmWorkspaceReferencePicker}
          onConfirmBundles={confirmWorkspaceReferenceBundles}
        />
      ) : (
        <WorkspaceFileReferencePicker
          copy={
            workspaceFileReferenceCopy ?? fallbackWorkspaceFileReferenceCopy
          }
          fileAdapter={workspaceFileReferenceAdapter ?? undefined}
          initialPath={viewModel.composerSettings.selectedProjectPath}
          open={workspaceReferencePickerOpen}
          scoped
          workspaceId={viewModel.workspaceId}
          onClose={closeWorkspaceReferencePicker}
          onConfirm={confirmWorkspaceReferencePicker}
        />
      )}
      <AgentGUIRenameConversationDialog
        conversation={renameConversationTarget}
        open={renameConversationDialogOpen && renameConversationTarget !== null}
        labels={labels}
        uiLanguage={uiLanguage}
        onOpenChange={(open) => {
          setRenameConversationDialogOpen(open);
          if (!open) {
            setRenameConversationTarget(null);
          }
        }}
        onRename={actions.renameConversation}
      />
    </AgentTargetPresentationProvider>
  );

  return (
    <TooltipProvider>
      <AgentMentionTooltipProviderScope withTooltipProvider={false}>
        {content}
      </AgentMentionTooltipProviderScope>
    </TooltipProvider>
  );
}

interface AgentGUIRenameConversationDialogProps {
  conversation: AgentGUINodeViewModel["conversations"][number] | null;
  open: boolean;
  labels: AgentGUIViewLabels;
  uiLanguage: UiLanguage;
  onOpenChange: (open: boolean) => void;
  onRename: (agentSessionId: string, title: string) => Promise<void>;
}

const AgentGUIRenameConversationDialog = memo(
  function AgentGUIRenameConversationDialog({
    conversation,
    open,
    labels,
    uiLanguage,
    onOpenChange,
    onRename
  }: AgentGUIRenameConversationDialogProps): React.JSX.Element {
    "use memo";
    const [title, setTitle] = useState("");
    const [isSaving, setIsSaving] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const trimmedTitle = title.trim();
    useEffect(() => {
      if (!open || !conversation) {
        setTitle("");
        setIsSaving(false);
        return;
      }
      setTitle(conversationPlainTitle(conversation, labels, uiLanguage));
    }, [conversation, labels, open, uiLanguage]);
    useEffect(() => {
      if (!open) {
        return;
      }
      const timer = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(timer);
    }, [open, conversation?.id]);
    const closeRenameDialog = useCallback(() => {
      if (!isSaving) {
        onOpenChange(false);
      }
    }, [isSaving, onOpenChange]);
    const confirmRename = useCallback(() => {
      if (!conversation || isSaving || !trimmedTitle) {
        return;
      }
      setIsSaving(true);
      void onRename(conversation.id, trimmedTitle)
        .then(() => {
          onOpenChange(false);
        })
        .catch(() => {
          inputRef.current?.focus();
        })
        .finally(() => {
          setIsSaving(false);
        });
    }, [conversation, isSaving, onOpenChange, onRename, trimmedTitle]);
    return (
      <ConfirmationDialog
        cancelLabel={labels.cancel}
        className="sm:max-w-[480px]"
        confirmBusy={isSaving}
        confirmDisabled={!trimmedTitle}
        confirmLabel={labels.renameSessionSave}
        description={labels.renameSessionDescription}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              disabled={isSaving}
              size="dialog"
              type="button"
              variant="ghost"
              onClick={closeRenameDialog}
              onPointerUp={(event) => {
                if (event.button === 0) {
                  closeRenameDialog();
                }
              }}
            >
              {labels.cancel}
            </Button>
            <Button
              className="shadow-none"
              disabled={isSaving || !trimmedTitle}
              size="dialog"
              type="button"
              variant="default"
              onClick={confirmRename}
            >
              {labels.renameSessionSave}
            </Button>
          </div>
        }
        open={open}
        title={labels.renameSessionTitle}
        onConfirm={confirmRename}
        onOpenChange={onOpenChange}
      >
        <input
          ref={inputRef}
          aria-label={labels.renameSessionTitle}
          className="h-10 w-full rounded-md border border-border bg-background px-3 text-[14px] font-medium leading-5 text-text-primary shadow-none outline-none transition-colors placeholder:text-text-tertiary focus:border-primary"
          placeholder={labels.renameSessionPlaceholder}
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              confirmRename();
            }
          }}
        />
      </ConfirmationDialog>
    );
  }
);

interface AgentGUIDetailPaneProps {
  viewModel: AgentGUINodeViewModel;
  actions: AgentGUINodeViewProps["actions"];
  labels: AgentGUIViewLabels;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
  uiLanguage: UiLanguage;
  hideDetailHeader: boolean;
  isActive: boolean;
  previewMode: boolean;
  workspaceReferencePickerOpen: boolean;
  composerFocusRequestSequence: number | null;
  isAgentProviderReady: boolean;
  slashStatusLimits: readonly AgentComposerSlashStatusLimit[];
  slashStatusLimitsLoading: boolean;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onHandoffConversation?: AgentGUINodeViewProps["onHandoffConversation"];
  capabilityMenuState?: AgentComposerProps["capabilityMenuState"];
  onCapabilitySettingsRequest?: AgentComposerProps["onCapabilitySettingsRequest"];
  onAgentProviderLogin?: (provider?: string | null) => void;
  onRequestWorkspaceReferences?:
    | ((
        entity?: AgentContextMentionItem | null
      ) => Promise<WorkspaceReferencePickResult>)
    | null;
  resolveDroppedFileReferences?: AgentComposerProps["resolveDroppedFileReferences"];
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  onRequestGitBranches?: AgentComposerGitBranchLoader | null;
  onRequestComposerFocus: () => void;
  contextMentionProviders?: readonly AgentContextMentionProvider[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  renderProviderUnavailableState?: AgentGUIProviderUnavailableStateRenderer;
  renderProviderReadinessGateState?: AgentGUIProviderReadinessGateStateRenderer;
}

function mergeWorkspaceAppIconsFromCommands(input: {
  commands: AgentGUINodeViewModel["availableCommands"];
  workspaceAppIcons: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  workspaceId: string;
}): readonly AgentMessageMarkdownWorkspaceAppIcon[] {
  const seen = new Set(
    input.workspaceAppIcons.flatMap((icon) => {
      const appId = icon.appId.trim();
      const iconUrl = icon.iconUrl?.trim() ?? "";
      if (!appId || !iconUrl) {
        return [];
      }
      return [
        workspaceAppIconKey(appId, icon.workspaceId?.trim() ?? ""),
        workspaceAppIconKey(appId, "")
      ];
    })
  );
  let next: AgentMessageMarkdownWorkspaceAppIcon[] | null = null;
  for (const command of input.commands) {
    const source = commandAppSource(command);
    if (!source) {
      continue;
    }
    const appId = stringValue(source.appId).trim();
    const iconUrl = stringValue(source.iconUrl).trim();
    if (!appId || !iconUrl) {
      continue;
    }
    const key = workspaceAppIconKey(appId, input.workspaceId);
    if (seen.has(key)) {
      continue;
    }
    if (!next) {
      next = [...input.workspaceAppIcons];
    }
    next.push({
      appId,
      iconUrl,
      workspaceId: input.workspaceId
    });
    seen.add(key);
  }
  return next ?? input.workspaceAppIcons;
}

function commandAppSource(command: unknown): Record<string, unknown> | null {
  if (!command || typeof command !== "object" || !("source" in command)) {
    return null;
  }
  const source = (command as { source?: unknown }).source;
  if (!source || typeof source !== "object") {
    return null;
  }
  const sourceRecord = source as Record<string, unknown>;
  return sourceRecord.kind === "app" ? sourceRecord : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function workspaceAppIconKey(appId: string, workspaceId: string): string {
  return `${workspaceId}\u0000${appId}`;
}

const AgentGUIDetailPane = memo(function AgentGUIDetailPane({
  viewModel,
  actions,
  labels,
  workspaceUserProjectI18n,
  uiLanguage,
  hideDetailHeader,
  isActive,
  previewMode,
  workspaceReferencePickerOpen,
  composerFocusRequestSequence,
  isAgentProviderReady,
  slashStatusLimits,
  slashStatusLimitsLoading,
  onLinkAction,
  onHandoffConversation,
  capabilityMenuState,
  onCapabilitySettingsRequest,
  onAgentProviderLogin,
  onRequestWorkspaceReferences,
  resolveDroppedFileReferences = null,
  selectProjectDirectory,
  onRequestGitBranches,
  onRequestComposerFocus,
  contextMentionProviders,
  workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS,
  renderProviderUnavailableState,
  renderProviderReadinessGateState
}: AgentGUIDetailPaneProps): React.JSX.Element {
  "use memo";
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const bottomDockRef = useRef<HTMLDivElement | null>(null);
  const timelineScrollAnchorRef = useRef<{
    conversationId: string;
    scrollHeight: number;
    scrollTop: number;
    clientHeight: number;
  } | null>(null);
  const submittedPromptScrollConversationRef = useRef<string | null>(null);
  const pendingPrependScrollAnchorRef = useRef<{
    conversationId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  // Remembers, per conversation, the last scroll position the user left off at
  // so switching back to a conversation the user had manually scrolled away
  // from restores that position instead of snapping to the bottom.
  const timelineScrollPositionsRef = useRef<
    Map<string, { scrollTop: number; atBottom: boolean }>
  >(new Map());
  // Deferred restore target used when a conversation is switched to while its
  // content is still loading (skeleton) and scrollHeight is not yet final.
  const pendingRestoreScrollRef = useRef<{
    conversationId: string;
    scrollTop: number;
  } | null>(null);
  const [isTimelineScrolledToTop, setIsTimelineScrolledToTop] = useState(true);
  const [isTimelineScrolledToBottom, setIsTimelineScrolledToBottom] =
    useState(true);
  const [
    bottomDockDismissedPromptRequestId,
    setBottomDockDismissedPromptRequestId
  ] = useState<string | null>(null);
  const conversation = useProjectedAgentConversation({
    conversation: viewModel.conversation,
    detail: viewModel.conversationDetail,
    avoidGroupingEdits: viewModel.avoidGroupingEdits
  });
  const hasActiveConversation = viewModel.activeConversationId !== null;
  const selectedProviderTargetComingSoon =
    viewModel.selectedProviderTarget?.disabled === true;
  const emptyProviderReadinessGate = !hasActiveConversation
    ? selectedProviderTargetComingSoon
      ? ({ status: "coming_soon" } satisfies AgentGUIProviderReadinessGate)
      : viewModel.providerReadinessGate
    : null;
  const activePrompt =
    viewModel.pendingInteractivePrompt ?? viewModel.pendingApproval;
  const activePromptRequestId = activePrompt?.requestId ?? null;
  const sessionChrome = useMemo<AgentGUISessionChrome>(
    () => ({ ...viewModel.sessionChrome, approval: null }),
    [viewModel.sessionChrome]
  );
  const rawSlashStatus = useMemo(
    () =>
      resolveSlashStatus({
        rawState: viewModel.sessionChrome.rawState,
        limits: slashStatusLimits,
        limitsLoading: slashStatusLimitsLoading
      }),
    [
      slashStatusLimits,
      slashStatusLimitsLoading,
      viewModel.sessionChrome.rawState
    ]
  );
  const slashStatus = useStableSlashStatus(rawSlashStatus);
  const displayedInlineNotice = useMemo(() => {
    const inlineNotice = viewModel.inlineNotice;
    const inlineNoticeMessage = inlineNotice?.message.trim() ?? "";
    if (!inlineNotice || inlineNoticeMessage === "") {
      return null;
    }

    if (
      isContextCanceledMessage(inlineNoticeMessage) &&
      viewModel.activeConversation?.status === "completed" &&
      viewModel.activeLiveState !== "failed"
    ) {
      return null;
    }

    const chromeMessages = [
      sessionChrome.auth?.message,
      sessionChrome.recovery?.message
    ].flatMap((message) => {
      const normalizedMessage = message?.trim() ?? "";
      return normalizedMessage === "" ? [] : [normalizedMessage];
    });

    return chromeMessages.includes(inlineNoticeMessage)
      ? null
      : { ...inlineNotice, message: inlineNoticeMessage };
  }, [
    sessionChrome.auth?.message,
    sessionChrome.recovery?.message,
    viewModel.activeConversation?.status,
    viewModel.activeLiveState,
    viewModel.inlineNotice
  ]);
  const inlineNoticeChrome = useMemo<AgentGUISessionChrome | null>(() => {
    if (!displayedInlineNotice) {
      return null;
    }
    return {
      auth: null,
      approval: null,
      recovery: {
        kind: displayedInlineNotice.tone === "warning" ? "warning" : "failed",
        message: displayedInlineNotice.message,
        canRetry: false
      },
      rawState: null
    };
  }, [displayedInlineNotice]);
  // Plan decisions (claude-code exit-plan + codex plan-implementation) replace
  // the composer in the bottom dock: the decision card takes the input box slot
  // and the composer hides until it is acted on (optimistically cleared via
  // bottomDockDismissedPromptRequestId) or otherwise resolves.
  const activePromptIsPlanDecision =
    activePrompt?.kind === "exit-plan" ||
    activePrompt?.kind === "plan-implementation";
  const activePromptIsVisible =
    activePrompt !== null &&
    bottomDockDismissedPromptRequestId !== activePromptRequestId;
  const bottomDockReplacementPrompt =
    activePromptIsPlanDecision && activePromptIsVisible ? activePrompt : null;
  // Approval / ask-user prompts keep the original layout: they lift above the
  // inline notice when one is present, otherwise they embed in the composer
  // (which stays visible). Only plan decisions replace the composer.
  const shouldLiftActivePromptAboveInlineNotice = inlineNoticeChrome !== null;
  const bottomDockLiftedPrompt =
    !activePromptIsPlanDecision &&
    shouldLiftActivePromptAboveInlineNotice &&
    activePromptIsVisible
      ? activePrompt
      : null;
  const composerActivePrompt =
    activePromptIsPlanDecision || shouldLiftActivePromptAboveInlineNotice
      ? null
      : activePrompt;
  const showTimelineSkeleton =
    viewModel.isLoadingMessages &&
    (!conversation || conversation.rows.length === 0);
  const showUnavailableChatEmpty =
    hasActiveConversation &&
    !showTimelineSkeleton &&
    (!conversation || conversation.rows.length === 0);
  const activeDetailStatus = resolveConversationDetailStatus(
    viewModel.conversationDetail
  );
  const derivedBusyStatus = resolveActiveConversationBusyStatus({
    conversationStatus: viewModel.activeConversation?.status,
    detailStatus: activeDetailStatus,
    conversation
  });
  const activeConversationTurnBusy =
    viewModel.isSubmitting ||
    viewModel.activeConversationBusy ||
    derivedBusyStatus !== null;
  const isComposerSending =
    viewModel.isSubmitting ||
    activeConversationTurnBusy ||
    (!hasActiveConversation && viewModel.isCreatingConversation);
  const isCollaboratorConversation = isDifferentKnownConversationOwner({
    conversationUserId: viewModel.activeConversation?.userId,
    currentUserId: viewModel.currentUserId
  });
  const canQueueWhileBusy =
    viewModel.canQueueWhileBusy &&
    isAgentProviderReady &&
    !isCollaboratorConversation;
  const composerDisabledReason = isCollaboratorConversation
    ? labels.collaboratorSessionReadOnlyPlaceholder
    : isAgentProviderReady
      ? null
      : labels.installRequiredPlaceholder;
  const showProviderSetupNotice =
    !emptyProviderReadinessGate &&
    !isAgentProviderReady &&
    !isCollaboratorConversation;
  const submitDisabled =
    isCollaboratorConversation ||
    !isAgentProviderReady ||
    (!viewModel.canSubmit && !canQueueWhileBusy);
  const hasNonRetryableRecoveryFailure =
    sessionChrome.recovery?.kind === "failed" &&
    sessionChrome.recovery.canRetry === false;
  const composerDisabled =
    hasNonRetryableRecoveryFailure ||
    isCollaboratorConversation ||
    !isAgentProviderReady ||
    (!canQueueWhileBusy &&
      (viewModel.pendingApproval !== null ||
        viewModel.pendingInteractivePrompt !== null ||
        viewModel.isSubmitting ||
        viewModel.isInterrupting ||
        viewModel.isCreatingConversation));
  const showStopButton =
    !viewModel.isSubmitting &&
    viewModel.activeLiveState !== "failed" &&
    sessionChrome.auth === null &&
    (activeConversationTurnBusy ||
      viewModel.pendingApproval !== null ||
      viewModel.pendingInteractivePrompt !== null ||
      viewModel.isInterrupting);
  const syncStatus = resolveSyncIndicatorStatus(
    viewModel.activeConversation?.syncState?.status
  );
  const syncLabel = syncStateLabel(syncStatus, labels);
  const showSyncIndicator = Boolean(viewModel.activeConversation?.syncState);
  const showFailedSyncLabel = showSyncIndicator && syncStatus === "failed";
  const conversationFlowLabels = useMemo(
    () => ({
      thinkingLabel: labels.thinkingLabel,
      toolCallsLabel: labels.toolCallsLabel,
      processing: labels.processing,
      turnSummary: labels.turnSummary,
      userMessageLocator: labels.userMessageLocator
    }),
    [
      labels.processing,
      labels.thinkingLabel,
      labels.toolCallsLabel,
      labels.turnSummary,
      labels.userMessageLocator
    ]
  );
  const conversationFlowEmpty = useMemo(
    () => (
      <div
        className={styles.unavailableChatEmpty}
        data-testid="agent-gui-unavailable-chat-empty"
      >
        <UnavailableChatIcon className={styles.unavailableChatEmptyIcon} />
        <span className={styles.unavailableChatEmptyText}>
          {labels.conversationUnavailable}
        </span>
      </div>
    ),
    [labels.conversationUnavailable]
  );
  const chromeLabels = useMemo(
    () => ({
      approvalRequired: labels.approvalRequired,
      authRequired: labels.authRequired,
      authLogin: labels.authLogin,
      // While connecting, if the user already requested a cancel that is waiting
      // for the session to come up, show "cancelling" instead of "connecting".
      activatingSession: viewModel.isCancelPending
        ? labels.cancellingSession
        : labels.activatingSession,
      retryActivation: labels.retryActivation,
      continueInNewConversation: labels.continueInNewConversation
    }),
    [
      labels.activatingSession,
      labels.cancellingSession,
      labels.approvalRequired,
      labels.authRequired,
      labels.continueInNewConversation,
      labels.retryActivation,
      viewModel.isCancelPending
    ]
  );
  const goalBannerLabels = useMemo<AgentGoalBannerLabels>(
    () => ({
      titleActive: labels.goalTitleActive,
      titlePaused: labels.goalTitlePaused,
      titleBlocked: labels.goalTitleBlocked,
      titleUsageLimited: labels.goalTitleUsageLimited,
      titleBudgetLimited: labels.goalTitleBudgetLimited,
      titleComplete: labels.goalTitleComplete,
      budgetUsage: labels.goalBudgetUsage,
      clearHint: labels.goalClearHint,
      editAction: labels.goalEditAction,
      pauseAction: labels.goalPauseAction,
      resumeAction: labels.goalResumeAction,
      clearAction: labels.goalClearAction
    }),
    [
      labels.goalTitleActive,
      labels.goalTitlePaused,
      labels.goalTitleBlocked,
      labels.goalTitleUsageLimited,
      labels.goalTitleBudgetLimited,
      labels.goalTitleComplete,
      labels.goalBudgetUsage,
      labels.goalClearHint,
      labels.goalEditAction,
      labels.goalPauseAction,
      labels.goalResumeAction,
      labels.goalClearAction
    ]
  );
  const interactivePromptLabels = useMemo(
    () => ({
      approvalLead: labels.approvalRequired,
      planLead: labels.planLead,
      planModes: labels.planModes,
      stayInPlan: labels.stayInPlan,
      sendFeedback: labels.sendFeedback,
      feedbackPlaceholder: labels.feedbackPlaceholder,
      previousQuestion: labels.previousQuestion,
      nextQuestion: labels.nextQuestion,
      submitAnswers: labels.submitAnswers,
      answerPlaceholder: labels.answerPlaceholder,
      waitingForAnswer: labels.waitingForAnswer,
      planImplementationLead: labels.planImplementationLead,
      planImplementationConfirm: labels.planImplementationConfirm,
      planImplementationFeedbackPlaceholder:
        labels.planImplementationFeedbackPlaceholder,
      planImplementationSend: labels.planImplementationSend,
      planImplementationSkip: labels.planImplementationSkip
    }),
    [
      labels.answerPlaceholder,
      labels.approvalRequired,
      labels.feedbackPlaceholder,
      labels.nextQuestion,
      labels.planLead,
      labels.planModes,
      labels.previousQuestion,
      labels.sendFeedback,
      labels.stayInPlan,
      labels.submitAnswers,
      labels.waitingForAnswer,
      labels.planImplementationLead,
      labels.planImplementationConfirm,
      labels.planImplementationFeedbackPlaceholder,
      labels.planImplementationSend,
      labels.planImplementationSkip
    ]
  );
  const composerLabels = useMemo(
    () => ({
      send: labels.send,
      modelLabel: labels.modelLabel,
      modelSelectionLabel: labels.modelSelectionLabel,
      modelContextWindowSuffix: labels.modelContextWindowSuffix,
      modelTooltipVersionLabel: labels.modelTooltipVersionLabel,
      defaultModel: labels.defaultModel,
      loadingOptions: labels.loadingOptions,
      inheritedUnavailable: labels.inheritedUnavailable,
      loadingConversation: labels.loadingConversation,
      reasoningLabel: labels.reasoningLabel,
      reasoningDegreeLabel: labels.reasoningDegreeLabel,
      reasoningOptionDefault: labels.reasoningOptionDefault,
      reasoningOptionMinimal: labels.reasoningOptionMinimal,
      reasoningOptionLow: labels.reasoningOptionLow,
      reasoningOptionMedium: labels.reasoningOptionMedium,
      reasoningOptionHigh: labels.reasoningOptionHigh,
      reasoningOptionXHigh: labels.reasoningOptionXHigh,
      reasoningOptionMax: labels.reasoningOptionMax,
      speedLabel: labels.speedLabel,
      speedSelectionLabel: labels.speedSelectionLabel,
      speedOptionStandard: labels.speedOptionStandard,
      speedOptionStandardDescription: labels.speedOptionStandardDescription,
      speedOptionFast: labels.speedOptionFast,
      speedOptionFastDescription: labels.speedOptionFastDescription,
      permissionLabel: labels.permissionLabel,
      permissionModeReadOnly: labels.permissionModeReadOnly,
      permissionModeAuto: labels.permissionModeAuto,
      permissionModeFullAccess: labels.permissionModeFullAccess,
      modelDescriptions: labels.modelDescriptions,
      planModeLabel: labels.planModeLabel,
      planModeOnLabel: labels.planModeOnLabel,
      planModeOffLabel: labels.planModeOffLabel,
      planUnavailable: labels.planUnavailable,
      goalLabel: labels.goalLabel,
      queuedLabel: labels.queuedLabel,
      sendQueuedPromptNext: labels.sendQueuedPromptNext,
      editQueuedPrompt: labels.editQueuedPrompt,
      deleteQueuedPrompt: labels.deleteQueuedPrompt,
      queuedPromptMoreActions: labels.queuedPromptMoreActions,
      stop: labels.stop,
      stopping: labels.stopping,
      slashCommandPalette: labels.slashCommandPalette,
      skillPickerPalette: labels.skillPickerPalette,
      slashPaletteCommandsGroup: labels.slashPaletteCommandsGroup,
      slashPaletteCapabilitiesGroup: labels.slashPaletteCapabilitiesGroup,
      slashPaletteSkillsGroup: labels.slashPaletteSkillsGroup,
      slashPalettePluginsGroup: labels.slashPalettePluginsGroup,
      slashPaletteConnectorsGroup: labels.slashPaletteConnectorsGroup,
      slashPaletteMcpGroup: labels.slashPaletteMcpGroup,
      slashCommandCompactLabel: labels.slashCommandCompactLabel,
      slashCommandContextLabel: labels.slashCommandContextLabel,
      slashCommandFastLabel: labels.slashCommandFastLabel,
      slashCommandGoalLabel: labels.slashCommandGoalLabel,
      slashCommandInitLabel: labels.slashCommandInitLabel,
      slashCommandPlanLabel: labels.slashCommandPlanLabel,
      slashCommandReviewLabel: labels.slashCommandReviewLabel,
      slashCommandStatusLabel: labels.slashCommandStatusLabel,
      slashCommandUsageLabel: labels.slashCommandUsageLabel,
      slashCommandCompactDescription: labels.slashCommandCompactDescription,
      slashCommandContextDescription: labels.slashCommandContextDescription,
      slashCommandFastDescription: labels.slashCommandFastDescription,
      slashCommandGoalDescription: labels.slashCommandGoalDescription,
      slashCommandInitDescription: labels.slashCommandInitDescription,
      slashCommandPlanDescription: labels.slashCommandPlanDescription,
      slashCommandReviewDescription: labels.slashCommandReviewDescription,
      slashCommandStatusDescription: labels.slashCommandStatusDescription,
      slashCommandUsageDescription: labels.slashCommandUsageDescription,
      browserUseCapabilityLabel: labels.browserUseCapabilityLabel,
      browserUseCapabilityDescription: labels.browserUseCapabilityDescription,
      browserUseCapabilityDescriptionAutoConnect:
        labels.browserUseCapabilityDescriptionAutoConnect,
      browserUseCapabilityDescriptionIsolated:
        labels.browserUseCapabilityDescriptionIsolated,
      browserUseCapabilitySettingsLabel:
        labels.browserUseCapabilitySettingsLabel,
      browserUseCapabilitySettingsDescription:
        labels.browserUseCapabilitySettingsDescription,
      capabilityInlineSettingsLabel: labels.capabilityInlineSettingsLabel,
      computerUseCapabilityLabel: labels.computerUseCapabilityLabel,
      computerUseCapabilityDescription: labels.computerUseCapabilityDescription,
      computerUseCapabilitySetupRequiredDescription:
        labels.computerUseCapabilitySetupRequiredDescription,
      computerUseCapabilityAuthorizationRequiredDescription:
        labels.computerUseCapabilityAuthorizationRequiredDescription,
      computerUseCapabilityAuthorizationUnknownDescription:
        labels.computerUseCapabilityAuthorizationUnknownDescription,
      computerUseCapabilitySettingsLabel:
        labels.computerUseCapabilitySettingsLabel,
      computerUseCapabilitySettingsDescription:
        labels.computerUseCapabilitySettingsDescription,
      slashStatusTitle: labels.slashStatusTitle,
      slashStatusSession: labels.slashStatusSession,
      slashStatusBaseUrl: labels.slashStatusBaseUrl,
      slashStatusContext: labels.slashStatusContext,
      slashStatusLimits: labels.slashStatusLimits,
      slashStatusAccount: labels.slashStatusAccount,
      slashStatusClose: labels.slashStatusClose,
      slashStatusContextValue: labels.slashStatusContextValue,
      slashStatusContextUnavailable: labels.slashStatusContextUnavailable,
      slashStatusLimitsUnavailable: labels.slashStatusLimitsUnavailable,
      usageChipLabel: labels.usageChipLabel,
      usageTooltipLabel: labels.usageTooltipLabel,
      usagePopoverTitle: labels.usagePopoverTitle,
      usageContextWindowLabel: labels.usageContextWindowLabel,
      usageTokensLabel: labels.usageTokensLabel,
      usageLimitsLabel: labels.usageLimitsLabel,
      usageCompactAction: labels.usageCompactAction,
      fileMentionPalette: labels.fileMentionPalette,
      fileMentionLoading: labels.fileMentionLoading,
      fileMentionEmpty: labels.fileMentionEmpty,
      fileMentionError: labels.fileMentionError,
      fileMentionTabHint: labels.fileMentionTabHint,
      fileDropHint: labels.fileDropHint,
      mentionPalette: labels.mentionPalette,
      removeMention: labels.removeMention,
      addReference: labels.addReference,
      addContent: labels.addContent,
      referenceWorkspaceFiles: labels.referenceWorkspaceFiles,
      handoffConversation: labels.handoffConversation,
      handoffConversationTooltip: labels.handoffConversationTooltip,
      handoffConversationMenu: labels.handoffConversationMenu,
      providerSwitchLabel: labels.providerSwitchLabel,
      projectLocked: labels.projectLocked,
      projectMissingDescription: labels.projectMissingDescription,
      promptTipsPrefix: labels.promptTipsPrefix,
      reviewPicker: labels.reviewPicker,
      ...interactivePromptLabels
    }),
    [
      interactivePromptLabels,
      labels.defaultModel,
      labels.addReference,
      labels.addContent,
      labels.deleteQueuedPrompt,
      labels.editQueuedPrompt,
      labels.fileMentionEmpty,
      labels.fileMentionError,
      labels.fileMentionLoading,
      labels.fileMentionPalette,
      labels.fileMentionTabHint,
      labels.fileDropHint,
      labels.handoffConversation,
      labels.handoffConversationTooltip,
      labels.handoffConversationMenu,
      labels.inheritedUnavailable,
      labels.loadingConversation,
      labels.modelLabel,
      labels.modelContextWindowSuffix,
      labels.modelDescriptions,
      labels.modelSelectionLabel,
      labels.modelTooltipVersionLabel,
      labels.permissionLabel,
      labels.permissionModeAuto,
      labels.permissionModeFullAccess,
      labels.permissionModeReadOnly,
      labels.planModeLabel,
      labels.planModeOffLabel,
      labels.planModeOnLabel,
      labels.planUnavailable,
      labels.goalLabel,
      labels.projectLocked,
      labels.projectMissingDescription,
      labels.promptTipsPrefix,
      labels.reviewPicker,
      labels.queuedLabel,
      labels.queuedPromptMoreActions,
      labels.referenceWorkspaceFiles,
      labels.providerSwitchLabel,
      labels.removeMention,
      labels.reasoningDegreeLabel,
      labels.reasoningLabel,
      labels.reasoningOptionDefault,
      labels.reasoningOptionHigh,
      labels.reasoningOptionLow,
      labels.reasoningOptionMax,
      labels.reasoningOptionMedium,
      labels.reasoningOptionMinimal,
      labels.reasoningOptionXHigh,
      labels.speedLabel,
      labels.speedSelectionLabel,
      labels.speedOptionStandard,
      labels.speedOptionStandardDescription,
      labels.speedOptionFast,
      labels.speedOptionFastDescription,
      labels.send,
      labels.sendQueuedPromptNext,
      labels.slashCommandPalette,
      labels.browserUseCapabilityDescription,
      labels.browserUseCapabilityDescriptionAutoConnect,
      labels.browserUseCapabilityDescriptionIsolated,
      labels.browserUseCapabilityLabel,
      labels.browserUseCapabilitySettingsDescription,
      labels.browserUseCapabilitySettingsLabel,
      labels.capabilityInlineSettingsLabel,
      labels.computerUseCapabilityDescription,
      labels.computerUseCapabilityAuthorizationRequiredDescription,
      labels.computerUseCapabilityAuthorizationUnknownDescription,
      labels.computerUseCapabilitySetupRequiredDescription,
      labels.computerUseCapabilityLabel,
      labels.computerUseCapabilitySettingsDescription,
      labels.computerUseCapabilitySettingsLabel,
      labels.slashPaletteCapabilitiesGroup,
      labels.slashPaletteCommandsGroup,
      labels.slashPaletteConnectorsGroup,
      labels.slashCommandCompactLabel,
      labels.slashCommandContextLabel,
      labels.slashCommandFastLabel,
      labels.slashCommandGoalLabel,
      labels.slashCommandInitLabel,
      labels.slashCommandPlanLabel,
      labels.slashCommandReviewLabel,
      labels.slashCommandStatusLabel,
      labels.slashCommandUsageLabel,
      labels.slashCommandCompactDescription,
      labels.slashCommandContextDescription,
      labels.slashCommandFastDescription,
      labels.slashCommandGoalDescription,
      labels.slashCommandInitDescription,
      labels.slashCommandPlanDescription,
      labels.slashCommandReviewDescription,
      labels.slashCommandStatusDescription,
      labels.slashCommandUsageDescription,
      labels.slashPaletteMcpGroup,
      labels.slashPalettePluginsGroup,
      labels.slashPaletteSkillsGroup,
      labels.slashStatusClose,
      labels.slashStatusContext,
      labels.slashStatusContextUnavailable,
      labels.slashStatusContextValue,
      labels.slashStatusBaseUrl,
      labels.slashStatusLimits,
      labels.slashStatusLimitsUnavailable,
      labels.slashStatusSession,
      labels.slashStatusTitle,
      labels.usageChipLabel,
      labels.usageContextWindowLabel,
      labels.usageLimitsLabel,
      labels.usageCompactAction,
      labels.usagePopoverTitle,
      labels.usageTokensLabel,
      labels.stop,
      labels.stopping
    ]
  );
  const handleInterruptCurrentTurn = useCallback(() => {
    actions.interruptCurrentTurn(labels.noRunningResponse);
  }, [actions.interruptCurrentTurn, labels.noRunningResponse]);
  const submitApprovalOption = useStableEventCallback(
    actions.submitApprovalOption
  );
  const retryActivation = useStableEventCallback(actions.retryActivation);
  const continueInNewConversation = useStableEventCallback(
    actions.continueInNewConversation
  );
  const updateDraftContent = useStableEventCallback(actions.updateDraftContent);
  const updateSelectedProjectPath = useOptionalStableEventCallback(
    actions.updateSelectedProjectPath
  );
  const updateComposerSettings = useStableEventCallback(
    actions.updateComposerSettings
  );
  const selectHomeComposerAgentTarget = useStableEventCallback(
    actions.selectHomeComposerAgentTarget
  );
  const selectHomeComposerAgentTargetAndFocus = useCallback(
    (input: Parameters<typeof selectHomeComposerAgentTarget>[0]) => {
      selectHomeComposerAgentTarget(input);
      onRequestComposerFocus();
    },
    [onRequestComposerFocus, selectHomeComposerAgentTarget]
  );
  const handleSelectHomeSuggestion = useCallback(
    (prompt: string) => {
      // Don't request focus here: replacing the draft already makes the composer
      // focus the filled prompt (focusAtStart). A second focus (focusAtEnd) would
      // race it and make the cursor/scroll jump — a visible flicker on fill.
      updateDraftContent({ ...viewModel.draftContent, prompt });
    },
    [updateDraftContent, viewModel.draftContent]
  );
  const handleHomeSuggestionAction = useCallback(
    (action: AgentHomeSuggestionAction) => {
      if (action === "import-session") {
        // The host chrome owns the external-agent import wizard; let it open.
        window.dispatchEvent(
          new CustomEvent(AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT)
        );
      }
    },
    []
  );
  const submitPrompt = useStableEventCallback(actions.submitPrompt);
  const goalControl = useStableEventCallback(actions.goalControl);
  const submitGuidancePrompt = useStableEventCallback(
    actions.submitGuidancePrompt
  );
  const requestSubmittedPromptScrollToBottom = useCallback(() => {
    const activeConversationId = viewModel.activeConversationId;
    if (!activeConversationId) {
      return;
    }
    submittedPromptScrollConversationRef.current = activeConversationId;
    pendingPrependScrollAnchorRef.current = null;
  }, [viewModel.activeConversationId]);
  const submitPromptAndScrollToBottom = useCallback(
    (content: AgentPromptContentBlock[], displayPrompt?: string): void => {
      requestSubmittedPromptScrollToBottom();
      if (displayPrompt === undefined) {
        submitPrompt(content);
        return;
      }
      submitPrompt(content, displayPrompt);
    },
    [requestSubmittedPromptScrollToBottom, submitPrompt]
  );
  const submitGuidancePromptAndScrollToBottom = useCallback(
    (content: AgentPromptContentBlock[], displayPrompt?: string): void => {
      requestSubmittedPromptScrollToBottom();
      if (displayPrompt === undefined) {
        submitGuidancePrompt(content);
        return;
      }
      submitGuidancePrompt(content, displayPrompt);
    },
    [requestSubmittedPromptScrollToBottom, submitGuidancePrompt]
  );
  const showPromptImagesUnsupported = useStableEventCallback(
    actions.showPromptImagesUnsupported
  );
  const sendQueuedPromptNext = useStableEventCallback(
    actions.sendQueuedPromptNext
  );
  const removeQueuedPrompt = useStableEventCallback(actions.removeQueuedPrompt);
  const editQueuedPrompt = useStableEventCallback(actions.editQueuedPrompt);
  const submitInteractivePrompt = useStableEventCallback(
    actions.submitInteractivePrompt
  );
  const stableLinkAction = useOptionalStableEventCallback(onLinkAction);
  const stableRequestWorkspaceReferences = useOptionalStableEventCallback(
    onRequestWorkspaceReferences
  );
  const stableSelectProjectDirectory = useOptionalStableEventCallback(
    selectProjectDirectory
  );
  const stableRequestGitBranches =
    useOptionalStableEventCallback(onRequestGitBranches);
  const authLogin = useOptionalStableEventCallback(onAgentProviderLogin);
  const backgroundAgentStatusText =
    viewModel.backgroundAgentCount > 0
      ? labels.waitingForBackgroundAgent(viewModel.backgroundAgentCount)
      : null;
  const submitBottomDockInteractivePrompt = useCallback(
    (input: {
      requestId: string;
      action?: string;
      optionId?: string;
      payload?: Record<string, unknown>;
    }) => {
      submitInteractivePrompt(input);
      setBottomDockDismissedPromptRequestId(input.requestId);
    },
    [submitInteractivePrompt]
  );
  const canSwitchComposerProvider = true;
  const composerProviderTargets = viewModel.providerTargets;
  const composerHandoffProviderTargets = viewModel.handoffProviderTargets;
  const composerProvider =
    viewModel.activeConversationId === null
      ? (viewModel.selectedProviderTarget?.provider ?? viewModel.data.provider)
      : viewModel.data.provider;
  const composerSelectedProviderTarget =
    viewModel.activeConversationId === null
      ? viewModel.selectedProviderTarget
      : (viewModel.providerTargets.find((target) => {
          if (target.provider !== viewModel.data.provider) {
            return false;
          }
          const agentTargetId = viewModel.data.agentTargetId;
          return (
            !agentTargetId ||
            target.targetId === agentTargetId ||
            target.agentTargetId === agentTargetId
          );
        }) ?? viewModel.selectedProviderTarget);
  const bottomDockComposerProps = useMemo<AgentComposerProps>(
    () => ({
      workspaceId: viewModel.workspaceId,
      workspacePath: viewModel.workspacePath,
      currentUserId: viewModel.currentUserId,
      provider: composerProvider,
      slashStatus,
      usage: viewModel.usage,
      draftContent: viewModel.draftContent,
      availableCommands: viewModel.availableCommands,
      hasCompactableContext: viewModel.hasSentUserMessage,
      compactSupported: viewModel.compactSupported,
      availableSkills: viewModel.availableSkills,
      selectedProviderTarget: composerSelectedProviderTarget,
      providerTargets: composerProviderTargets,
      handoffProviderTargets: composerHandoffProviderTargets,
      providerSelectReadonly:
        !canSwitchComposerProvider || viewModel.activeConversationId !== null,
      onProviderSelect:
        canSwitchComposerProvider && viewModel.activeConversationId === null
          ? selectHomeComposerAgentTargetAndFocus
          : undefined,
      disabled: composerDisabled,
      disabledReason: composerDisabledReason,
      hasActiveConversation: viewModel.activeConversationId !== null,
      submitDisabled,
      composerSettings: viewModel.composerSettings,
      queuedPrompts: viewModel.queuedPrompts,
      drainingQueuedPromptId: viewModel.drainingQueuedPromptId,
      workspaceAppIcons,
      canQueueWhileBusy,
      placeholder: viewModel.hasSentUserMessage
        ? labels.followupPlaceholder
        : labels.initialPlaceholder,
      showStopButton,
      previewMode,
      workspaceReferencePickerOpen,
      // Plan decisions replace the composer via bottomDockReplacementPrompt;
      // approval / ask-user embed here (composerActivePrompt encodes that).
      activePrompt: composerActivePrompt,
      backgroundAgentStatusText,
      activePromptKeyboardShortcutsEnabled: isActive,
      promptTips: labels.promptTips,
      composerFocusRequestSequence,
      isActive,
      promptImagesSupported: viewModel.promptImagesSupported,
      providerSelectLabel: labels.providerSwitchLabel,
      handoffLabel: labels.handoffConversation,
      handoffMenuLabel: labels.handoffConversationMenu,
      isInterrupting: viewModel.isInterrupting,
      isSendingTurn: isComposerSending,
      isSubmittingPrompt: viewModel.isRespondingApproval,
      uiLanguage,
      labels: composerLabels,
      workspaceUserProjectI18n,
      capabilityMenuState,
      onDraftContentChange: updateDraftContent,
      onProjectPathChange: updateSelectedProjectPath,
      onSettingsChange: updateComposerSettings,
      onSubmit: submitPromptAndScrollToBottom,
      onSubmitGuidance: submitGuidancePromptAndScrollToBottom,
      onPromptImagesUnsupported: showPromptImagesUnsupported,
      onSendQueuedPromptNext: sendQueuedPromptNext,
      onRemoveQueuedPrompt: removeQueuedPrompt,
      onEditQueuedPrompt: editQueuedPrompt,
      onInterruptCurrentTurn: handleInterruptCurrentTurn,
      onSubmitInteractivePrompt: submitInteractivePrompt,
      onCapabilitySettingsRequest,
      onLinkAction: stableLinkAction,
      onHandoffConversation:
        onHandoffConversation && viewModel.activeConversationId !== null
          ? (target) =>
              onHandoffConversation({
                agentTargetId: target.agentTargetId ?? target.targetId,
                draftPrompt: buildAgentConversationHandoffPrompt({
                  activeConversation: viewModel.activeConversation,
                  currentUserId: viewModel.currentUserId,
                  labels,
                  selectedProviderTarget: composerSelectedProviderTarget,
                  uiLanguage,
                  workspaceId: viewModel.workspaceId
                }),
                provider: target.provider,
                userProjectPath: handoffProjectPathForConversation(
                  viewModel.activeConversation
                )
              })
          : undefined,
      onRequestWorkspaceReferences: stableRequestWorkspaceReferences,
      resolveDroppedFileReferences,
      selectProjectDirectory: stableSelectProjectDirectory,
      onRequestGitBranches: stableRequestGitBranches,
      contextMentionProviders
    }),
    [
      canQueueWhileBusy,
      backgroundAgentStatusText,
      capabilityMenuState,
      canSwitchComposerProvider,
      composerDisabled,
      composerDisabledReason,
      composerFocusRequestSequence,
      composerHandoffProviderTargets,
      composerLabels,
      composerProviderTargets,
      composerSelectedProviderTarget,
      handleInterruptCurrentTurn,
      isActive,
      isComposerSending,
      labels.followupPlaceholder,
      labels.handoffConversation,
      labels.handoffConversationTooltip,
      labels.handoffConversationMenu,
      labels.initialPlaceholder,
      labels.promptTips,
      labels.providerSwitchLabel,
      labels,
      onHandoffConversation,
      previewMode,
      workspaceReferencePickerOpen,
      composerActivePrompt,
      editQueuedPrompt,
      onCapabilitySettingsRequest,
      contextMentionProviders,
      removeQueuedPrompt,
      resolveDroppedFileReferences,
      sendQueuedPromptNext,
      showPromptImagesUnsupported,
      showStopButton,
      slashStatus,
      submitDisabled,
      submitInteractivePrompt,
      submitPromptAndScrollToBottom,
      submitGuidancePromptAndScrollToBottom,
      uiLanguage,
      stableLinkAction,
      stableRequestGitBranches,
      stableSelectProjectDirectory,
      stableRequestWorkspaceReferences,
      updateComposerSettings,
      updateDraftContent,
      updateSelectedProjectPath,
      viewModel.activeConversationId,
      viewModel.availableCommands,
      viewModel.availableSkills,
      viewModel.activeConversationId,
      viewModel.compactSupported,
      viewModel.composerSettings,
      viewModel.currentUserId,
      viewModel.activeConversationId,
      viewModel.activeConversation,
      composerProvider,
      viewModel.draftContent,
      viewModel.draftPrompt,
      viewModel.drainingQueuedPromptId,
      viewModel.hasSentUserMessage,
      viewModel.isInterrupting,
      viewModel.isRespondingApproval,
      viewModel.promptImagesSupported,
      viewModel.queuedPrompts,
      viewModel.usage,
      viewModel.workspaceId,
      viewModel.workspacePath,
      workspaceUserProjectI18n,
      workspaceAppIcons,
      selectHomeComposerAgentTargetAndFocus
    ]
  );
  const emptyHeroComposerProps = useMemo<AgentComposerProps>(
    () => ({
      ...bottomDockComposerProps,
      layoutMode: "hero"
    }),
    [bottomDockComposerProps]
  );
  const emptyHeroProvider =
    viewModel.selectedProviderTarget?.provider ?? viewModel.data.provider;
  const emptyHeroProviderLabel =
    labels.emptyProviderForProvider?.(emptyHeroProvider) ??
    labels.emptyProvider ??
    "";
  const emptyHeroLabel =
    labels.emptyForProvider?.(emptyHeroProvider) ?? labels.empty;
  const emptyHeroIconPresentations = useMemo(
    () =>
      viewModel.conversationFilter.kind === "all"
        ? agentGUILaunchpadIconPresentations()
        : [agentGUIProviderIconPresentation(emptyHeroProvider)],
    [emptyHeroProvider, viewModel.conversationFilter]
  );
  const disabledProviderTarget = selectedProviderTargetComingSoon
    ? (viewModel.selectedProviderTarget ?? null)
    : null;
  const shouldRenderProviderUnavailableState =
    !hasActiveConversation &&
    disabledProviderTarget !== null &&
    renderProviderUnavailableState !== undefined;
  const shouldRenderProviderReadinessGateState =
    !hasActiveConversation &&
    emptyProviderReadinessGate !== null &&
    renderProviderReadinessGateState !== undefined;
  const bottomDockStoreState = useMemo<AgentGUIBottomDockStoreSnapshot>(
    () => ({
      // The lifted prompt is rendered from props on the pane; the store still
      // carries it so the snapshot revision tracks prompt changes.
      bottomDockActivePrompt: bottomDockLiftedPrompt,
      composerProps: bottomDockComposerProps,
      inlineNoticeChrome,
      isRespondingApproval: viewModel.isRespondingApproval,
      sessionChrome
    }),
    [
      bottomDockLiftedPrompt,
      bottomDockComposerProps,
      inlineNoticeChrome,
      sessionChrome,
      viewModel.isRespondingApproval
    ]
  );
  const bottomDockStoreRef = useRef<AgentGUIBottomDockStore | null>(null);
  if (bottomDockStoreRef.current === null) {
    bottomDockStoreRef.current =
      createAgentGUIBottomDockStore(bottomDockStoreState);
  }
  const bottomDockStore = bottomDockStoreRef.current;
  syncAgentGUIBottomDockStore(bottomDockStore, bottomDockStoreState);
  const bottomDockStoreRevision = [
    bottomDockLiftedPrompt?.requestId ?? "",
    bottomDockReplacementPrompt?.requestId ?? "",
    inlineNoticeChrome?.recovery?.message ?? "",
    sessionChrome.auth?.message ?? "",
    sessionChrome.recovery?.kind ?? "",
    sessionChrome.recovery?.message ?? "",
    backgroundAgentStatusText ?? "",
    viewModel.queuedPrompts.map((prompt) => prompt.id).join(","),
    viewModel.drainingQueuedPromptId ?? "",
    viewModel.isRespondingApproval ? "1" : "0"
  ].join("|");

  useEffect(() => {
    setBottomDockDismissedPromptRequestId(null);
  }, [activePromptRequestId]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    const activeConversationId = viewModel.activeConversationId;
    if (!activeConversationId) {
      timelineScrollAnchorRef.current = null;
      pendingPrependScrollAnchorRef.current = null;
      submittedPromptScrollConversationRef.current = null;
      setIsTimelineScrolledToTop(true);
      setIsTimelineScrolledToBottom(true);
      return;
    }

    const maxScrollTop = Math.max(
      0,
      timeline.scrollHeight - timeline.clientHeight
    );
    const anchor = timelineScrollAnchorRef.current;
    const prependAnchor = pendingPrependScrollAnchorRef.current;
    const shouldScrollSubmittedPromptToBottom =
      submittedPromptScrollConversationRef.current === activeConversationId;
    let nextScrollTop = timeline.scrollTop;

    const savedScrollPosition = shouldScrollSubmittedPromptToBottom
      ? undefined
      : timelineScrollPositionsRef.current.get(activeConversationId);

    if (
      !anchor ||
      anchor.conversationId !== activeConversationId ||
      shouldScrollSubmittedPromptToBottom
    ) {
      if (
        savedScrollPosition &&
        !savedScrollPosition.atBottom &&
        !showTimelineSkeleton
      ) {
        // Returning to a conversation the user had manually scrolled away
        // from: restore that position instead of snapping to the bottom.
        nextScrollTop = Math.min(maxScrollTop, savedScrollPosition.scrollTop);
        timeline.scrollTop = nextScrollTop;
        pendingRestoreScrollRef.current = null;
      } else if (savedScrollPosition && !savedScrollPosition.atBottom) {
        // Content isn't rendered yet (skeleton) so scrollHeight is not final:
        // defer the restore until the real messages have laid out.
        pendingRestoreScrollRef.current = {
          conversationId: activeConversationId,
          scrollTop: savedScrollPosition.scrollTop
        };
        setTimelineScrollTopInstantly(timeline, maxScrollTop);
        nextScrollTop = maxScrollTop;
      } else {
        setTimelineScrollTopInstantly(timeline, maxScrollTop);
        nextScrollTop = maxScrollTop;
        pendingRestoreScrollRef.current = null;
      }
      submittedPromptScrollConversationRef.current = null;
      if (shouldScrollSubmittedPromptToBottom) {
        pendingPrependScrollAnchorRef.current = null;
      }
    } else if (
      pendingRestoreScrollRef.current?.conversationId === activeConversationId
    ) {
      if (showTimelineSkeleton) {
        // Still loading: keep pinned to the bottom until content is ready so
        // the deferred restore can target the final scrollHeight.
        setTimelineScrollTopInstantly(timeline, maxScrollTop);
        nextScrollTop = maxScrollTop;
      } else {
        nextScrollTop = Math.min(
          maxScrollTop,
          pendingRestoreScrollRef.current.scrollTop
        );
        timeline.scrollTop = nextScrollTop;
        pendingRestoreScrollRef.current = null;
      }
    } else if (prependAnchor?.conversationId === activeConversationId) {
      const nextScrollHeight = timeline.scrollHeight;
      const delta = nextScrollHeight - prependAnchor.scrollHeight;
      nextScrollTop = Math.max(0, prependAnchor.scrollTop + delta);
      timeline.scrollTop = nextScrollTop;
      if (viewModel.isLoadingOlderMessages) {
        pendingPrependScrollAnchorRef.current = {
          conversationId: activeConversationId,
          scrollHeight: nextScrollHeight,
          scrollTop: nextScrollTop
        };
      } else {
        pendingPrependScrollAnchorRef.current = null;
      }
    } else {
      const distanceFromBottom =
        anchor.scrollHeight - anchor.scrollTop - anchor.clientHeight;
      if (distanceFromBottom <= AGENT_GUI_STICK_TO_BOTTOM_THRESHOLD_PX) {
        setTimelineScrollTopInstantly(timeline, maxScrollTop);
        nextScrollTop = maxScrollTop;
      } else {
        nextScrollTop = Math.min(maxScrollTop, anchor.scrollTop);
        timeline.scrollTop = nextScrollTop;
      }
    }

    timelineScrollAnchorRef.current = {
      conversationId: activeConversationId,
      scrollHeight: timeline.scrollHeight,
      scrollTop: nextScrollTop,
      clientHeight: timeline.clientHeight
    };
    setIsTimelineScrolledToTop(
      nextScrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
    );
    setIsTimelineScrolledToBottom(
      maxScrollTop - nextScrollTop <= AGENT_GUI_STICK_TO_BOTTOM_THRESHOLD_PX
    );
  }, [
    conversation,
    showTimelineSkeleton,
    viewModel.activeConversationId,
    viewModel.isLoadingOlderMessages
  ]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    const bottomDock = bottomDockRef.current;
    const activeConversationId = viewModel.activeConversationId;
    if (!timeline || !bottomDock || !activeConversationId) {
      return;
    }

    let animationFrameId: number | null = null;

    const syncBottomDockSafeArea = (): void => {
      const bottomDockRect = bottomDock.getBoundingClientRect();
      let visualTop = bottomDockRect.top;
      bottomDock.querySelectorAll("*").forEach((element) => {
        if (element.closest(`.${styles.bottomDockScrollToBottom}`)) {
          return;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          visualTop = Math.min(visualTop, rect.top);
        }
      });
      const overflowHeight = Math.max(
        0,
        Math.ceil(bottomDockRect.top - visualTop)
      );
      timeline.style.setProperty(
        "--agent-gui-bottom-dock-safe-area",
        `${overflowHeight}px`
      );
      bottomDock.style.setProperty(
        "--agent-gui-bottom-dock-floating-safe-area",
        `${overflowHeight}px`
      );
    };

    const syncBottomDockSpace = (): void => {
      syncBottomDockSafeArea();

      const anchor = timelineScrollAnchorRef.current;
      if (!anchor || anchor.conversationId !== activeConversationId) {
        return;
      }

      const distanceFromBottom =
        anchor.scrollHeight - anchor.scrollTop - anchor.clientHeight;
      if (distanceFromBottom > AGENT_GUI_STICK_TO_BOTTOM_THRESHOLD_PX) {
        return;
      }

      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        const maxScrollTop = Math.max(
          0,
          timeline.scrollHeight - timeline.clientHeight
        );
        timeline.scrollTop = maxScrollTop;
        timelineScrollAnchorRef.current = {
          conversationId: activeConversationId,
          scrollHeight: timeline.scrollHeight,
          scrollTop: maxScrollTop,
          clientHeight: timeline.clientHeight
        };
        setIsTimelineScrolledToTop(
          maxScrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
        );
        setIsTimelineScrolledToBottom(true);
      });
    };

    syncBottomDockSpace();
    if (typeof ResizeObserver === "undefined") {
      return () => {
        timeline.style.removeProperty("--agent-gui-bottom-dock-safe-area");
        bottomDock.style.removeProperty(
          "--agent-gui-bottom-dock-floating-safe-area"
        );
        if (animationFrameId !== null) {
          window.cancelAnimationFrame(animationFrameId);
        }
      };
    }

    const observer = new ResizeObserver(syncBottomDockSpace);
    observer.observe(bottomDock);
    const promptInputArea = bottomDock.querySelector(
      ".agent-gui-node__composer-prompt-input-area"
    );
    if (promptInputArea instanceof Element) {
      observer.observe(promptInputArea);
    }
    return () => {
      timeline.style.removeProperty("--agent-gui-bottom-dock-safe-area");
      bottomDock.style.removeProperty(
        "--agent-gui-bottom-dock-floating-safe-area"
      );
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      observer.disconnect();
    };
  }, [bottomDockStoreRevision, viewModel.activeConversationId]);

  useEffect(() => {
    const timeline = timelineRef.current;
    const activeConversationId = viewModel.activeConversationId;
    if (!timeline || !activeConversationId) {
      return;
    }

    const captureScrollAnchor = (): void => {
      const scrollTop = timeline.scrollTop;
      timelineScrollAnchorRef.current = {
        conversationId: activeConversationId,
        scrollHeight: timeline.scrollHeight,
        scrollTop,
        clientHeight: timeline.clientHeight
      };
      const atBottom =
        timeline.scrollHeight - scrollTop - timeline.clientHeight <=
        AGENT_GUI_STICK_TO_BOTTOM_THRESHOLD_PX;
      setIsTimelineScrolledToTop(
        scrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
      );
      setIsTimelineScrolledToBottom(atBottom);
      // Remember where the user left off so returning to this conversation can
      // restore the position. Skip while a deferred restore is pending so the
      // synchronous jump-to-bottom (during skeleton) doesn't clobber it.
      if (
        pendingRestoreScrollRef.current?.conversationId !== activeConversationId
      ) {
        timelineScrollPositionsRef.current.set(activeConversationId, {
          scrollTop,
          atBottom
        });
      }
      if (
        viewModel.hasOlderMessages &&
        !viewModel.isLoadingOlderMessages &&
        scrollTop <= AGENT_GUI_TOP_HISTORY_PREFETCH_THRESHOLD_PX
      ) {
        pendingPrependScrollAnchorRef.current = {
          conversationId: activeConversationId,
          scrollHeight: timeline.scrollHeight,
          scrollTop
        };
        actions.loadOlderConversationMessages();
      }
    };

    captureScrollAnchor();
    timeline.addEventListener("scroll", captureScrollAnchor, { passive: true });
    return () => {
      timeline.removeEventListener("scroll", captureScrollAnchor);
    };
  }, [
    actions,
    viewModel.activeConversationId,
    viewModel.hasOlderMessages,
    viewModel.isLoadingOlderMessages
  ]);

  const scrollTimelineToBottom = useCallback(() => {
    const timeline = timelineRef.current;
    const activeConversationId = viewModel.activeConversationId;
    if (!timeline || !activeConversationId) {
      return;
    }

    const maxScrollTop = Math.max(
      0,
      timeline.scrollHeight - timeline.clientHeight
    );
    setTimelineScrollTopWithUserTransition(timeline, maxScrollTop);
    timelineScrollAnchorRef.current = {
      conversationId: activeConversationId,
      scrollHeight: timeline.scrollHeight,
      scrollTop: maxScrollTop,
      clientHeight: timeline.clientHeight
    };
    setIsTimelineScrolledToTop(
      maxScrollTop <= AGENT_GUI_TOP_MASK_SCROLL_EPSILON_PX
    );
    setIsTimelineScrolledToBottom(true);
  }, [viewModel.activeConversationId]);

  return (
    <main className={styles.detail}>
      <AgentGUIDetailHeader
        activeConversation={viewModel.activeConversation}
        hidden={hideDetailHeader}
        labels={labels}
        uiLanguage={uiLanguage}
        showSyncIndicator={showSyncIndicator}
        syncStatus={syncStatus}
        syncLabel={syncLabel}
        showFailedSyncLabel={showFailedSyncLabel}
        previewMode={previewMode}
      />
      {showProviderSetupNotice ? (
        <div
          className={cn(
            toastVariants({ variant: "default" }),
            styles.providerSetupNotice
          )}
          data-slot="toast"
          data-testid="agent-gui-provider-setup-notice"
          role="status"
        >
          <span className="inline-flex max-w-full items-center justify-center gap-[6px] text-center text-[13px] font-normal leading-normal">
            <span className="min-w-0 break-words">
              {labels.installRequiredPlaceholder}
            </span>
          </span>
          <button
            type="button"
            className={cn(
              styles.providerSetupNoticeAction,
              "nodrag tsh-desktop-no-drag [-webkit-app-region:no-drag]"
            )}
            data-testid="agent-gui-provider-setup-notice-action"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() =>
              openAgentEnvPanel({
                provider: viewModel.data.provider,
                focus: "detect"
              })
            }
          >
            {labels.installRequiredAction}
          </button>
        </div>
      ) : null}
      <ScrollArea
        scrollbarMode="native"
        className="flex h-full min-h-0 flex-1 flex-col [&_[data-orientation=vertical][data-slot=scroll-area-scrollbar]]:opacity-100"
        viewportRef={timelineRef}
        viewportTestId="agent-gui-timeline"
        viewportClassName={`${styles.timeline} ${
          hasActiveConversation
            ? styles.timelineWithComposer
            : styles.timelineCentered
        } ${
          !isTimelineScrolledToTop ? styles.timelineScrolledFromTop : ""
        } ${showUnavailableChatEmpty ? styles.timelineUnavailableChatEmpty : ""}`.trim()}
        viewportContentStyle={AGENT_GUI_TIMELINE_SCROLL_AREA_CONTENT_STYLE}
      >
        {!hasActiveConversation ? (
          shouldRenderProviderUnavailableState && disabledProviderTarget ? (
            <>
              {renderProviderUnavailableState?.({
                provider: disabledProviderTarget.provider,
                providerLabel:
                  labels.emptyProviderForProvider?.(
                    disabledProviderTarget.provider
                  ) ??
                  resolveAgentGuiWorkbenchProviderLabel(
                    disabledProviderTarget.provider
                  ),
                target: disabledProviderTarget,
                iconUrl: resolveAgentGUIHeroIconUrl(
                  disabledProviderTarget.provider
                ),
                unavailableReason:
                  disabledProviderTarget.unavailableReason ?? null
              })}
            </>
          ) : emptyProviderReadinessGate ? (
            shouldRenderProviderReadinessGateState ? (
              <>
                {renderProviderReadinessGateState?.({
                  provider: emptyHeroProvider,
                  providerLabel:
                    emptyHeroProviderLabel ||
                    resolveAgentGuiWorkbenchProviderLabel(emptyHeroProvider),
                  target: viewModel.selectedProviderTarget ?? null,
                  iconUrl: resolveAgentGUIHeroIconUrl(emptyHeroProvider),
                  gate: emptyProviderReadinessGate,
                  showAllProviders: viewModel.conversationFilter.kind === "all"
                })}
              </>
            ) : (
              <AgentGUIProviderReadinessGatePane
                provider={emptyHeroProvider}
                gate={emptyProviderReadinessGate}
                showAllProviders={viewModel.conversationFilter.kind === "all"}
                labels={labels}
              />
            )
          ) : (
            <AgentGUIEmptyHeroPane
              provider={emptyHeroProvider}
              emptyLabel={emptyHeroLabel}
              emptyProvider={emptyHeroProviderLabel}
              iconPresentations={emptyHeroIconPresentations}
              inlineNoticeChrome={inlineNoticeChrome}
              isRespondingApproval={viewModel.isRespondingApproval}
              onSubmitApprovalOption={submitApprovalOption}
              onRetryActivation={retryActivation}
              onAuthLogin={authLogin}
              onContinueInNewConversation={continueInNewConversation}
              onProviderSelect={
                canSwitchComposerProvider &&
                viewModel.activeConversationId === null
                  ? selectHomeComposerAgentTargetAndFocus
                  : undefined
              }
              providerTargets={composerProviderTargets}
              selectedProviderTarget={viewModel.selectedProviderTarget}
              chromeLabels={chromeLabels}
              composerProps={emptyHeroComposerProps}
              providerSelectLabel={labels.providerSwitchLabel}
              suggestions={labels.homeSuggestions ?? EMPTY_HOME_SUGGESTIONS}
              suggestionsCloseLabel={labels.homeSuggestionsClose}
              onSelectSuggestion={handleSelectHomeSuggestion}
              onSelectSuggestionAction={handleHomeSuggestionAction}
            />
          )
        ) : (
          <AgentGUIConversationTimelinePane
            conversation={conversation}
            isLoading={showTimelineSkeleton}
            isLoadingOlderMessages={viewModel.isLoadingOlderMessages}
            loadingLabel={labels.loadingConversation}
            empty={conversationFlowEmpty}
            onLinkAction={stableLinkAction}
            onAuthLogin={authLogin}
            availableSkills={viewModel.availableSkills}
            workspaceAppIcons={workspaceAppIcons}
            previewMode={previewMode}
            labels={conversationFlowLabels}
          />
        )}
      </ScrollArea>
      {hasActiveConversation ? (
        <AgentGUIBottomDockPane
          bottomDockRef={bottomDockRef}
          showScrollToBottom={!isTimelineScrolledToBottom}
          scrollToBottomLabel={labels.scrollToBottom}
          onScrollToBottom={scrollTimelineToBottom}
          bottomDockLiftedPrompt={bottomDockLiftedPrompt}
          bottomDockReplacementPrompt={bottomDockReplacementPrompt}
          store={bottomDockStore}
          storeRevision={bottomDockStoreRevision}
          keyboardShortcutsEnabled={isActive}
          chromeLabels={chromeLabels}
          goalBannerLabels={goalBannerLabels}
          promptLabels={interactivePromptLabels}
          onSubmitApprovalOption={submitApprovalOption}
          onRetryActivation={retryActivation}
          onAuthLogin={authLogin}
          onContinueInNewConversation={continueInNewConversation}
          onSubmitBottomDockInteractivePrompt={
            submitBottomDockInteractivePrompt
          }
          onGoalControl={goalControl}
          goalPauseSupported={viewModel.goalPauseSupported}
        />
      ) : null}
    </main>
  );
});

interface AgentGUIDetailHeaderProps {
  activeConversation: AgentGUINodeViewModel["activeConversation"];
  hidden: boolean;
  labels: Pick<AgentGUIViewLabels, "fallbackAgentTitle">;
  uiLanguage: UiLanguage;
  showSyncIndicator: boolean;
  syncStatus: SyncIndicatorStatus;
  syncLabel: string;
  showFailedSyncLabel: boolean;
  previewMode: boolean;
}

const AgentGUIDetailHeader = memo(function AgentGUIDetailHeader({
  activeConversation,
  hidden,
  labels,
  uiLanguage,
  showSyncIndicator,
  syncStatus,
  syncLabel,
  showFailedSyncLabel,
  previewMode
}: AgentGUIDetailHeaderProps): React.JSX.Element | null {
  "use memo";

  if (hidden || !activeConversation) {
    return null;
  }

  const runPath = activeConversation.cwd.trim();
  const statusTitle = showSyncIndicator ? syncLabel : undefined;

  return (
    <div className={styles.detailHeader}>
      <span className={styles.detailHeaderTitleGroup}>
        <span className={styles.detailHeaderTitle}>
          {conversationPlainTitle(activeConversation, labels, uiLanguage)}
        </span>
        {runPath ? (
          <AgentRunPathInfo path={runPath} previewMode={previewMode} />
        ) : null}
      </span>
      <span
        className="inline-flex flex-none items-center gap-2 whitespace-nowrap"
        title={statusTitle}
      >
        {showSyncIndicator ? (
          <StatusDot
            tone={syncStateTone(syncStatus)}
            pulse={syncStatus === "pending"}
            size="sm"
            ariaLabel={syncLabel}
            title={syncLabel}
          />
        ) : null}
        {showFailedSyncLabel ? (
          <span className="text-[13px] font-semibold leading-[18px] text-shell-warning">
            {syncLabel}
          </span>
        ) : null}
      </span>
    </div>
  );
});

function AgentRunPathInfo({
  path,
  previewMode
}: {
  path: string;
  previewMode: boolean;
}): React.JSX.Element {
  "use memo";

  const trigger = (
    <button
      type="button"
      className={styles.detailHeaderPathInfo}
      aria-label={path}
    >
      <Info size={14} strokeWidth={2} aria-hidden="true" />
    </button>
  );

  if (previewMode) {
    return trigger;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="max-w-[320px] text-[11px] [overflow-wrap:anywhere]"
      >
        {path}
      </TooltipContent>
    </Tooltip>
  );
}

type ChromeLabels = {
  approvalRequired: string;
  authRequired: string;
  activatingSession: string;
  retryActivation: string;
  continueInNewConversation: string;
};

type InteractivePromptLabels = {
  approvalLead: string;
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
  planImplementationLead: string;
  planImplementationConfirm: string;
  planImplementationFeedbackPlaceholder: string;
  planImplementationSend: string;
  planImplementationSkip: string;
};

function useStableEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

function useOptionalStableEventCallback<Args extends unknown[], Result>(
  callback: ((...args: Args) => Result) | null | undefined
): ((...args: Args) => Result) | undefined {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useMemo(() => {
    if (callback == null) {
      return undefined;
    }
    return (...args: Args) => callbackRef.current?.(...args) as Result;
  }, [callback != null]);
}

const EMPTY_HOME_SUGGESTIONS: readonly AgentHomeSuggestionCategory[] =
  Object.freeze([]);

interface AgentGUIEmptyHeroPaneProps {
  provider: AgentGUINodeViewModel["data"]["provider"];
  emptyLabel: string;
  emptyProvider: string;
  iconPresentations: readonly AgentGUIProviderIconPresentation[];
  inlineNoticeChrome: AgentGUISessionChrome | null;
  isRespondingApproval: boolean;
  onSubmitApprovalOption: AgentGUINodeViewProps["actions"]["submitApprovalOption"];
  onAuthLogin?: (provider?: string | null) => void;
  onRetryActivation: AgentGUINodeViewProps["actions"]["retryActivation"];
  onContinueInNewConversation: AgentGUINodeViewProps["actions"]["continueInNewConversation"];
  onProviderSelect?: AgentGUINodeViewProps["actions"]["selectHomeComposerAgentTarget"];
  providerTargets: readonly AgentGUIProviderTarget[];
  selectedProviderTarget: AgentGUIProviderTarget | null;
  chromeLabels: ChromeLabels;
  composerProps: AgentComposerProps;
  providerSelectLabel: string;
  suggestions: readonly AgentHomeSuggestionCategory[];
  suggestionsCloseLabel?: string;
  onSelectSuggestion: (prompt: string) => void;
  onSelectSuggestionAction?: (action: AgentHomeSuggestionAction) => void;
}

const AgentGUIEmptyHeroPane = memo(function AgentGUIEmptyHeroPane({
  provider,
  emptyLabel,
  emptyProvider,
  iconPresentations,
  inlineNoticeChrome,
  isRespondingApproval,
  onSubmitApprovalOption,
  onAuthLogin,
  onRetryActivation,
  onContinueInNewConversation,
  onProviderSelect,
  providerTargets,
  selectedProviderTarget,
  chromeLabels,
  composerProps,
  providerSelectLabel,
  suggestions,
  suggestionsCloseLabel,
  onSelectSuggestion,
  onSelectSuggestionAction
}: AgentGUIEmptyHeroPaneProps): React.JSX.Element {
  "use memo";

  const heroIconPresentations =
    iconPresentations.length > 0
      ? iconPresentations
      : [agentGUIProviderIconPresentation(provider)];
  const heroIconAnimationKey = heroIconPresentations
    .map((icon) => `${icon.provider}:${icon.iconUrl}`)
    .join("|");

  return (
    <div className={styles.emptyHero}>
      <div className={styles.emptyHeroBody}>
        <div className={styles.emptyHeroIconSlot}>
          {heroIconPresentations.length > 1 ? (
            <AgentGUIAllProviderGridIcon
              key={heroIconAnimationKey}
              activeProvider={provider}
              className={styles.emptyHeroLaunchpadIcon}
              icons={heroIconPresentations}
            />
          ) : (
            <AgentGUIProviderIconVisual
              key={heroIconAnimationKey}
              ariaHidden
              imageClassName={styles.emptyHeroIconEffect}
              icon={heroIconPresentations[0]!}
            />
          )}
        </div>
        <h2 className={styles.emptyHeroTitle}>
          <EmptyHeroTitle
            label={emptyLabel}
            providerLabel={emptyProvider}
            providerSelectLabel={providerSelectLabel}
            providerTargets={providerTargets}
            selectedProviderTarget={selectedProviderTarget}
            onProviderSelect={onProviderSelect}
          />
        </h2>
        {inlineNoticeChrome ? (
          <AgentSessionChrome
            chrome={inlineNoticeChrome}
            isRespondingApproval={isRespondingApproval}
            onSubmitApprovalOption={onSubmitApprovalOption}
            onAuthLogin={onAuthLogin}
            onRetryActivation={onRetryActivation}
            onContinueInNewConversation={onContinueInNewConversation}
            labels={chromeLabels}
          />
        ) : null}
        <AgentComposer {...composerProps} />
        <AgentHomeSuggestions
          categories={suggestions}
          onSelectSuggestion={onSelectSuggestion}
          onSelectAction={onSelectSuggestionAction}
          closeLabel={suggestionsCloseLabel}
        />
      </div>
    </div>
  );
});

interface AgentGUIProviderReadinessGatePaneProps {
  provider: AgentGUINodeViewModel["data"]["provider"];
  gate: AgentGUIProviderReadinessGate;
  showAllProviders?: boolean;
  labels: Pick<
    AgentGUIViewLabels,
    | "providerGateCheckingTitle"
    | "providerGateCheckingDescription"
    | "providerGateCheckingAgentsDescription"
    | "providerGateInstallTitle"
    | "providerGateInstallDescription"
    | "providerGateInstallAction"
    | "providerGateLoginTitle"
    | "providerGateLoginDescription"
    | "providerGateLoginAction"
    | "providerGateComingSoonTitle"
    | "providerGateComingSoonDescription"
    | "providerGateComingSoonAction"
    | "providerGateUnavailableTitle"
    | "providerGateUnavailableDescription"
    | "providerGateRetryAction"
    | "providerGatePendingInstall"
    | "providerGatePendingLogin"
    | "providerGatePendingRefresh"
  >;
}

const AgentGUIProviderReadinessGatePane = memo(
  function AgentGUIProviderReadinessGatePane({
    provider,
    gate,
    showAllProviders = false,
    labels
  }: AgentGUIProviderReadinessGatePaneProps): React.JSX.Element {
    "use memo";

    const heroIconUrl = resolveAgentGUIHeroIconUrl(provider);
    const launchpadIconPresentations = useMemo(
      () => agentGUILaunchpadIconPresentations(),
      []
    );
    const pendingAction = gate.pendingAction ?? null;
    const isPending = pendingAction !== null;
    const showAllProvidersChecking =
      showAllProviders && gate.status === "checking";
    const content = providerGateContent(gate.status, labels, {
      showAllProviders: showAllProvidersChecking
    });
    const action = providerGateAction(gate.status);
    const pendingLabel =
      pendingAction === "install"
        ? labels.providerGatePendingInstall
        : pendingAction === "login"
          ? labels.providerGatePendingLogin
          : pendingAction === "refresh"
            ? labels.providerGatePendingRefresh
            : null;

    return (
      <div className={styles.emptyHero}>
        <div
          className={cn(styles.emptyHeroBody, styles.emptyProviderGate)}
          data-testid="agent-gui-provider-readiness-gate"
          role="status"
        >
          {showAllProvidersChecking ? (
            <AgentGUIAllProviderGridIcon
              className={styles.emptyHeroLaunchpadIcon}
              icons={launchpadIconPresentations}
            />
          ) : (
            <img
              aria-hidden="true"
              className={styles.emptyHeroIconEffect}
              draggable={false}
              src={heroIconUrl}
              alt=""
            />
          )}
          <h2 className={styles.emptyHeroTitle}>{content.title}</h2>
          <p className={styles.emptyProviderGateDescription}>
            {content.description}
          </p>
          {pendingLabel && !action ? (
            <div
              className={styles.emptyProviderGateStatus}
              data-testid="agent-gui-provider-readiness-gate-pending"
            >
              {pendingLabel}
            </div>
          ) : null}
          {action ? (
            <Button
              type="button"
              className={cn(
                styles.emptyProviderGateAction,
                "nodrag tsh-desktop-no-drag [-webkit-app-region:no-drag]"
              )}
              data-testid="agent-gui-provider-readiness-gate-action"
              disabled={isPending}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                if (isPending) {
                  return;
                }
                gate.onAction?.(provider, action);
              }}
            >
              {isPending && pendingLabel ? pendingLabel : content.actionLabel}
            </Button>
          ) : content.actionLabel ? (
            <Button
              type="button"
              className={cn(
                styles.emptyProviderGateAction,
                "nodrag tsh-desktop-no-drag [-webkit-app-region:no-drag]"
              )}
              data-testid="agent-gui-provider-readiness-gate-action"
              disabled
              onPointerDown={(event) => event.stopPropagation()}
            >
              {content.actionLabel}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
);

function providerGateContent(
  status: AgentGUIProviderReadinessGate["status"],
  labels: AgentGUIProviderReadinessGatePaneProps["labels"],
  options: { showAllProviders?: boolean } = {}
): { title: string; description: string; actionLabel?: string } {
  switch (status) {
    case "checking":
      return {
        title: labels.providerGateCheckingTitle,
        description:
          options.showAllProviders === true
            ? labels.providerGateCheckingAgentsDescription
            : labels.providerGateCheckingDescription
      };
    case "not_installed":
      return {
        title: labels.providerGateInstallTitle,
        description: labels.providerGateInstallDescription,
        actionLabel: labels.providerGateInstallAction
      };
    case "auth_required":
      return {
        title: labels.providerGateLoginTitle,
        description: labels.providerGateLoginDescription,
        actionLabel: labels.providerGateLoginAction
      };
    case "coming_soon":
      return {
        title: labels.providerGateComingSoonTitle,
        description: labels.providerGateComingSoonDescription,
        actionLabel: labels.providerGateComingSoonAction
      };
    case "unavailable":
      return {
        title: labels.providerGateUnavailableTitle,
        description: labels.providerGateUnavailableDescription,
        actionLabel: labels.providerGateRetryAction
      };
  }
}

function providerGateAction(
  status: AgentGUIProviderReadinessGate["status"]
): AgentGUIProviderReadinessGate["pendingAction"] {
  switch (status) {
    case "not_installed":
      return "install";
    case "auth_required":
      return "login";
    case "unavailable":
      return "refresh";
    case "coming_soon":
    case "checking":
      return null;
  }
}

function AgentGUIAllProviderGridIcon({
  activeProvider,
  className,
  icons
}: {
  activeProvider?: string;
  className?: string;
  icons: readonly AgentGUIProviderIconPresentation[];
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={[styles.providerRailAvatar, className]
        .filter(Boolean)
        .join(" ")}
    >
      <AgentGUILaunchpadIconGrid
        activeProvider={activeProvider}
        icons={icons}
      />
    </span>
  );
}

function AgentGUIUnifiedProviderIcon({
  presentation
}: {
  presentation?: AgentGUIProviderRailAllPresentation | null;
}): React.JSX.Element {
  const iconUrl = presentation?.iconUrl?.trim() || agentColorfulUrl;
  return (
    <span aria-hidden="true" className={styles.providerRailAvatar}>
      <img
        alt=""
        className={styles.providerRailAvatarImage}
        draggable={false}
        src={iconUrl}
      />
    </span>
  );
}

function AgentGUILaunchpadIconGrid({
  activeProvider,
  icons
}: {
  activeProvider?: string;
  icons: readonly AgentGUIProviderIconPresentation[];
}): React.JSX.Element {
  const normalizedActiveProvider = activeProvider
    ? normalizeManagedAgentProvider(activeProvider)
    : null;
  return (
    <span aria-hidden="true" className={styles.providerRailLaunchpadIcon}>
      {icons.map((icon) => {
        return (
          <span
            key={`${icon.provider}:${icon.iconUrl}`}
            className={styles.providerRailLaunchpadItem}
            data-provider-active={
              normalizedActiveProvider === null
                ? undefined
                : normalizeManagedAgentProvider(icon.provider) ===
                  normalizedActiveProvider
            }
          >
            <AgentGUIProviderIconVisual imageClassName="" icon={icon} />
          </span>
        );
      })}
    </span>
  );
}

function AgentGUIProviderIconVisual({
  ariaHidden = false,
  icon,
  imageClassName
}: {
  ariaHidden?: boolean;
  icon: AgentGUIProviderIconPresentation;
  imageClassName: string;
}): React.JSX.Element {
  return (
    <img
      alt=""
      aria-hidden={ariaHidden ? "true" : undefined}
      className={imageClassName}
      draggable={false}
      src={icon.iconUrl}
    />
  );
}

function EmptyHeroTitle({
  label,
  providerLabel,
  providerSelectLabel,
  providerTargets = [],
  selectedProviderTarget = null,
  onProviderSelect
}: {
  label: string;
  providerLabel: string;
  providerSelectLabel: string;
  providerTargets?: readonly AgentGUIProviderTarget[];
  selectedProviderTarget?: AgentGUIProviderTarget | null;
  onProviderSelect?: AgentGUINodeViewProps["actions"]["selectHomeComposerAgentTarget"];
}): React.JSX.Element {
  const providerStart = providerLabel ? label.indexOf(providerLabel) : -1;

  if (!shouldEmphasizeEmptyHeroProvider(label) || providerStart < 0) {
    return <>{label}</>;
  }

  const providerEnd = providerStart + providerLabel.length;
  const selectedProviderTargetId =
    selectedProviderTarget?.targetId ??
    `local:${selectedProviderTarget?.provider ?? ""}`;
  const enabledProviderTargets = providerTargets.filter(
    (target) => target.disabled !== true
  );
  const canSwitchProvider =
    enabledProviderTargets.length > 1 &&
    selectedProviderTarget &&
    onProviderSelect;
  const providerName = label.slice(providerStart, providerEnd);

  return (
    <>
      {label.slice(0, providerStart)}
      {canSwitchProvider ? (
        <Select
          value={selectedProviderTargetId}
          onValueChange={(nextTargetId) => {
            const target = enabledProviderTargets.find(
              (candidate) => candidate.targetId === nextTargetId
            );
            if (!target) {
              return;
            }
            onProviderSelect({
              provider: target.provider,
              providerTargetId: target.targetId
            });
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={providerSelectLabel}
            title={providerSelectLabel}
            className={styles.emptyHeroProviderSelect}
          >
            <span className={styles.emptyHeroProvider}>{providerName}</span>
          </SelectTrigger>
          <SelectContent
            align="center"
            className={cn(styles.composerMenuContent, "min-w-[190px]")}
          >
            {enabledProviderTargets.map((target) => (
              <SelectItem
                key={`${target.provider}:${target.targetId}`}
                value={target.targetId}
                className={cn(styles.composerMenuItem, "gap-2")}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <img
                    alt=""
                    aria-hidden="true"
                    className="size-4 shrink-0 rounded-[4px]"
                    src={
                      agentGUIProviderRailIconPresentation(
                        target.provider,
                        target.iconUrl
                      ).iconUrl
                    }
                  />
                  <span className="min-w-0 truncate">{target.label}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className={styles.emptyHeroProvider}>{providerName}</span>
      )}
      {label.slice(providerEnd)}
    </>
  );
}

interface AgentGUIBottomDockPaneProps {
  bottomDockRef: React.RefObject<HTMLDivElement | null>;
  showScrollToBottom: boolean;
  scrollToBottomLabel: string;
  onScrollToBottom: () => void;
  // Approval / ask-user prompts lifted above the inline notice (composer stays
  // visible below). Mutually exclusive with bottomDockReplacementPrompt.
  bottomDockLiftedPrompt:
    | AgentGUIDetailPaneProps["viewModel"]["pendingApproval"]
    | AgentGUIDetailPaneProps["viewModel"]["pendingInteractivePrompt"];
  // When set, this interactive prompt takes the composer's slot in the bottom
  // dock (the composer is hidden) for both claude-code exit-plan and codex
  // plan-implementation decisions. Closing the prompt returns the composer.
  bottomDockReplacementPrompt:
    | AgentGUIDetailPaneProps["viewModel"]["pendingApproval"]
    | AgentGUIDetailPaneProps["viewModel"]["pendingInteractivePrompt"];
  // composerProps / inlineNoticeChrome / sessionChrome / isRespondingApproval
  // are read from the bottom-dock store snapshot below.
  store: AgentGUIBottomDockStore;
  storeRevision: string;
  keyboardShortcutsEnabled: boolean;
  chromeLabels: ChromeLabels;
  goalBannerLabels: AgentGoalBannerLabels;
  promptLabels: InteractivePromptLabels;
  onSubmitApprovalOption: AgentGUINodeViewProps["actions"]["submitApprovalOption"];
  onAuthLogin?: (provider?: string | null) => void;
  onRetryActivation: AgentGUINodeViewProps["actions"]["retryActivation"];
  onContinueInNewConversation: AgentGUINodeViewProps["actions"]["continueInNewConversation"];
  onSubmitBottomDockInteractivePrompt: AgentGUINodeViewProps["actions"]["submitInteractivePrompt"];
  onGoalControl: AgentGUINodeViewProps["actions"]["goalControl"];
  goalPauseSupported: boolean;
}

const AgentGUIBottomDockPane = memo(function AgentGUIBottomDockPane({
  bottomDockRef,
  showScrollToBottom,
  scrollToBottomLabel,
  onScrollToBottom,
  bottomDockLiftedPrompt,
  bottomDockReplacementPrompt,
  store,
  storeRevision: _storeRevision,
  keyboardShortcutsEnabled,
  chromeLabels,
  goalBannerLabels,
  promptLabels,
  onSubmitApprovalOption,
  onAuthLogin,
  onRetryActivation,
  onContinueInNewConversation,
  onSubmitBottomDockInteractivePrompt,
  onGoalControl,
  goalPauseSupported
}: AgentGUIBottomDockPaneProps): React.JSX.Element {
  "use memo";
  const state = useSnapshot(store) as AgentGUIBottomDockStoreSnapshot;
  const {
    composerProps,
    inlineNoticeChrome,
    isRespondingApproval,
    sessionChrome
  } = state;
  const previewMode = composerProps.previewMode === true;

  // Active thread goal rides the same runtimeContext channel as account /
  // rateLimits, so we read it straight off the session chrome's raw state.
  const goal = objectRecord(sessionChrome.rawState?.runtimeContext?.goal);
  const goalObjective = goal ? stringValue(goal.objective) : "";
  const goalStatus = goal ? stringValue(goal.status) : "";
  const goalTokenBudget = goal ? numberValue(goal.tokenBudget) : null;
  const goalTokensUsed = goal ? numberValue(goal.tokensUsed) : null;
  const goalTimeUsedSeconds = goal ? numberValue(goal.timeUsedSeconds) : null;
  const showGoalBanner = isGoalBannerVisible(goalObjective, goalStatus);

  return (
    <div
      ref={bottomDockRef}
      className={styles.bottomDock}
      data-testid="agent-gui-bottom-dock"
    >
      {showScrollToBottom ? (
        <button
          type="button"
          className={cn(
            styles.bottomDockScrollToBottom,
            "nodrag tsh-desktop-no-drag [-webkit-app-region:no-drag]"
          )}
          data-testid="agent-gui-scroll-to-bottom"
          aria-label={scrollToBottomLabel}
          title={scrollToBottomLabel}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onScrollToBottom}
        >
          <ChevronsDown aria-hidden="true" size={15} strokeWidth={2.2} />
        </button>
      ) : null}
      {bottomDockLiftedPrompt ? (
        <div
          className={styles.bottomDockPrompt}
          data-testid="agent-gui-bottom-dock-active-prompt"
        >
          <AgentInteractivePromptSurface
            prompt={bottomDockLiftedPrompt}
            embedded={true}
            edgeGlow={true}
            keyboardShortcuts={keyboardShortcutsEnabled}
            previewMode={previewMode}
            isSubmitting={isRespondingApproval}
            onSubmit={onSubmitBottomDockInteractivePrompt}
            labels={promptLabels}
          />
        </div>
      ) : null}
      {inlineNoticeChrome ? (
        <AgentSessionChrome
          chrome={inlineNoticeChrome}
          isRespondingApproval={isRespondingApproval}
          onSubmitApprovalOption={onSubmitApprovalOption}
          onAuthLogin={onAuthLogin}
          onRetryActivation={onRetryActivation}
          onContinueInNewConversation={onContinueInNewConversation}
          labels={chromeLabels}
        />
      ) : null}
      <AgentSessionChrome
        chrome={sessionChrome}
        isRespondingApproval={isRespondingApproval}
        onSubmitApprovalOption={onSubmitApprovalOption}
        onAuthLogin={onAuthLogin}
        onRetryActivation={onRetryActivation}
        onContinueInNewConversation={onContinueInNewConversation}
        labels={chromeLabels}
      />
      {showGoalBanner ? (
        <AgentGoalBanner
          objective={goalObjective}
          status={goalStatus}
          tokenBudget={goalTokenBudget ?? undefined}
          tokensUsed={goalTokensUsed ?? undefined}
          timeUsedSeconds={goalTimeUsedSeconds ?? undefined}
          labels={goalBannerLabels}
          onPauseGoal={
            goalPauseSupported ? () => onGoalControl("pause") : undefined
          }
          onResumeGoal={
            goalPauseSupported ? () => onGoalControl("resume") : undefined
          }
          onClearGoal={() => onGoalControl("clear")}
        />
      ) : null}
      {bottomDockReplacementPrompt ? (
        <div
          className={styles.bottomDockPrompt}
          data-testid="agent-gui-bottom-dock-active-prompt"
        >
          <AgentInteractivePromptSurface
            prompt={bottomDockReplacementPrompt}
            embedded={true}
            edgeGlow={true}
            keyboardShortcuts={keyboardShortcutsEnabled}
            previewMode={previewMode}
            isSubmitting={isRespondingApproval}
            onSubmit={onSubmitBottomDockInteractivePrompt}
            labels={promptLabels}
          />
        </div>
      ) : (
        <AgentComposer {...composerProps} />
      )}
    </div>
  );
});

interface AgentGUIConversationRailPaneProps {
  conversations: AgentGUINodeViewModel["conversations"];
  footer?: React.ReactNode;
  workspaceId: string;
  userProjects: AgentGUINodeViewModel["userProjects"];
  activeConversationId: string | null;
  pendingDeleteConversationId: string | null;
  isLoadingConversations: boolean;
  isDeletingConversation: boolean;
  isDeletingProjectConversations: boolean;
  labels: AgentGUIViewLabels;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
  uiLanguage: UiLanguage;
  previewMode: boolean;
  createConversationDisabled: boolean;
  openclawGateway: OpenclawGatewayViewModel | null;
  isCollapsed: boolean;
  providerTargets: AgentGUINodeViewModel["providerTargets"];
  providerTargetsLoading: AgentGUINodeViewModel["providerTargetsLoading"];
  conversationFilter: AgentGUINodeViewModel["conversationFilter"];
  sectionAgentTargetFallbackId: string | null;
  onUpdateConversationFilter: (
    filter: AgentGUINodeViewModel["conversationFilter"]
  ) => void;
  onSelectConversationFilterTarget: AgentGUINodeViewProps["actions"]["selectConversationFilterTarget"];
  onCreateConversation: (options?: {
    projectPath?: string | null;
    source?: string;
  }) => void;
  onRetryOpenclawGateway: () => void;
  onSelectConversation: (agentSessionId: string) => void;
  onToggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
  onMarkConversationUnread: (agentSessionId: string) => void;
  onOpenProjectFiles?: ((action: WorkspaceLinkAction) => void) | null;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  onRemoveProject: (path: string) => void;
  onConfirmDeleteProjectConversations: (path?: string) => void;
  onConfirmDeleteConversations: (agentSessionIds: string[]) => void;
  onRequestDeleteConversation: (agentSessionId: string) => void;
  onRequestRenameConversation: (agentSessionId: string) => void;
  onCancelDeleteConversation: () => void;
  onConfirmDeleteConversation: () => void;
}

type AgentGUIProjectActionDialog =
  | {
      kind: "batch-delete";
      conversationCount: number;
      label: string;
      path: string;
    }
  | {
      kind: "batch-delete-conversations";
      conversationCount: number;
      label: string;
      sessionIds: string[];
    }
  | {
      kind: "remove";
      label: string;
      path: string;
    };

type OpenclawGatewayViewModel =
  | NonNullable<AgentGUINodeViewModel["openclawGateway"]>
  | {
      status: "starting";
      error: null;
    };

type AgentGUIConversationRailDataProps = Pick<
  AgentGUIConversationRailPaneProps,
  "conversations" | "userProjects" | "workspaceId"
>;

type AgentGUIConversationRailStoreSnapshot = Omit<
  AgentGUIConversationRailPaneProps,
  keyof AgentGUIConversationRailDataProps
>;

type AgentGUIConversationRailStore = AgentGUIConversationRailStoreSnapshot;

function createAgentGUIConversationRailStore(
  initialState: AgentGUIConversationRailStoreSnapshot
): AgentGUIConversationRailStore {
  return proxy<AgentGUIConversationRailStoreSnapshot>(initialState);
}

function syncAgentGUIConversationRailStore(
  store: AgentGUIConversationRailStore,
  next: AgentGUIConversationRailStoreSnapshot
): void {
  if (agentGUIConversationRailStoreSnapshotsEqual(store, next)) {
    return;
  }
  Object.assign(store, next);
}

function agentGUIConversationRailStoreSnapshotsEqual(
  current: AgentGUIConversationRailStoreSnapshot,
  next: AgentGUIConversationRailStoreSnapshot
): boolean {
  return (
    current.activeConversationId === next.activeConversationId &&
    current.pendingDeleteConversationId === next.pendingDeleteConversationId &&
    current.isLoadingConversations === next.isLoadingConversations &&
    current.isDeletingConversation === next.isDeletingConversation &&
    current.isDeletingProjectConversations ===
      next.isDeletingProjectConversations &&
    current.labels === next.labels &&
    current.workspaceUserProjectI18n === next.workspaceUserProjectI18n &&
    current.uiLanguage === next.uiLanguage &&
    current.previewMode === next.previewMode &&
    current.createConversationDisabled === next.createConversationDisabled &&
    current.openclawGateway === next.openclawGateway &&
    current.isCollapsed === next.isCollapsed &&
    current.providerTargets === next.providerTargets &&
    current.providerTargetsLoading === next.providerTargetsLoading &&
    current.conversationFilter === next.conversationFilter &&
    current.sectionAgentTargetFallbackId ===
      next.sectionAgentTargetFallbackId &&
    current.onUpdateConversationFilter === next.onUpdateConversationFilter &&
    current.onSelectConversationFilterTarget ===
      next.onSelectConversationFilterTarget &&
    current.onCreateConversation === next.onCreateConversation &&
    current.onRetryOpenclawGateway === next.onRetryOpenclawGateway &&
    current.onSelectConversation === next.onSelectConversation &&
    current.onToggleConversationPinned === next.onToggleConversationPinned &&
    current.onMarkConversationUnread === next.onMarkConversationUnread &&
    current.onOpenProjectFiles === next.onOpenProjectFiles &&
    current.onOpenConversationWindow === next.onOpenConversationWindow &&
    current.selectProjectDirectory === next.selectProjectDirectory &&
    current.onRemoveProject === next.onRemoveProject &&
    current.onConfirmDeleteProjectConversations ===
      next.onConfirmDeleteProjectConversations &&
    current.onRequestDeleteConversation === next.onRequestDeleteConversation &&
    current.onRequestRenameConversation === next.onRequestRenameConversation &&
    current.onCancelDeleteConversation === next.onCancelDeleteConversation &&
    current.onConfirmDeleteConversation === next.onConfirmDeleteConversation
  );
}

interface AgentGUIConversationRailStorePaneProps {
  conversations: AgentGUINodeViewModel["conversations"];
  footer?: React.ReactNode;
  store: AgentGUIConversationRailStore;
  storeState: AgentGUIConversationRailStoreSnapshot;
  userProjects: AgentGUINodeViewModel["userProjects"];
  workspaceId: string;
}

const AgentGUIConversationRailStorePane = memo(
  function AgentGUIConversationRailStorePane({
    conversations,
    footer,
    store,
    storeState: _storeState,
    userProjects,
    workspaceId
  }: AgentGUIConversationRailStorePaneProps): React.JSX.Element {
    "use memo";
    const state = useSnapshot(store) as AgentGUIConversationRailStoreSnapshot;
    return (
      <AgentGUIConversationRailPane
        {...state}
        conversations={conversations}
        footer={footer}
        userProjects={userProjects}
        workspaceId={workspaceId}
      />
    );
  }
);

function normalizeConversationRailProjectPath(
  path: string | null | undefined
): string {
  const normalized = path?.trim().replaceAll("\\", "/") ?? "";
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\/+$/, "") || "/";
}

interface ConversationRailSectionPageState {
  hasMore: boolean;
  isLoading: boolean;
  nextCursor: string | null;
}

function conversationRailPageCursor(
  conversations: readonly AgentGUINodeViewModel["conversations"][number][]
): string | null {
  let boundary: AgentGUINodeViewModel["conversations"][number] | null = null;
  for (const conversation of conversations) {
    if (!conversation.id.trim()) {
      continue;
    }
    if (!boundary) {
      boundary = conversation;
      continue;
    }
    if (
      conversation.updatedAtUnixMs < boundary.updatedAtUnixMs ||
      (conversation.updatedAtUnixMs === boundary.updatedAtUnixMs &&
        conversation.id.trim() > boundary.id.trim())
    ) {
      boundary = conversation;
    }
  }
  if (!boundary) {
    return null;
  }
  return `${boundary.updatedAtUnixMs}|${boundary.id.trim()}`;
}

function mergeConversationRailPageItems(
  base: AgentGUINodeViewModel["conversations"],
  loaded: AgentGUINodeViewModel["conversations"]
): AgentGUINodeViewModel["conversations"] {
  if (loaded.length === 0) {
    return base;
  }
  const ids = new Set(base.map((conversation) => conversation.id));
  const merged = [...base];
  for (const conversation of loaded) {
    if (ids.has(conversation.id)) {
      continue;
    }
    ids.add(conversation.id);
    merged.push(conversation);
  }
  return merged;
}

function stabilizeConversationSections(
  previous: readonly ConversationSection[] | null,
  next: readonly ConversationSection[]
): ConversationSection[] {
  if (!previous) {
    return [...next];
  }
  const previousById = new Map(
    previous.map((section) => [section.id, section])
  );
  let changed = previous.length !== next.length;
  const stable = next.map((section, index) => {
    const previousSection = previousById.get(section.id) ?? null;
    if (!previousSection) {
      changed = true;
      return section;
    }
    const items = stabilizeConversationSectionItems(
      previousSection.items,
      section.items
    );
    const canReuseSection =
      previousSection.kind === section.kind &&
      previousSection.label === section.label &&
      conversationProjectsRenderEqual(
        previousSection.project,
        section.project
      ) &&
      items === previousSection.items;
    if (canReuseSection) {
      if (previous[index] !== previousSection) {
        changed = true;
      }
      return previousSection;
    }
    changed = true;
    return { ...section, items };
  });
  return changed ? stable : (previous as ConversationSection[]);
}

function stabilizeConversationSectionItems(
  previous: AgentGUINodeViewModel["conversations"],
  next: AgentGUINodeViewModel["conversations"]
): AgentGUINodeViewModel["conversations"] {
  if (previous.length !== next.length) {
    const previousById = new Map<
      string,
      AgentGUINodeViewModel["conversations"][number]
    >();
    for (const item of previous) {
      if (!previousById.has(item.id)) {
        previousById.set(item.id, item);
      }
    }
    return next.map((item) => {
      const previousItem = previousById.get(item.id);
      return previousItem &&
        conversationSummariesRenderEqual(previousItem, item)
        ? previousItem
        : item;
    });
  }
  let changed = false;
  const stable = next.map((item, index) => {
    const previousItem = previous[index];
    if (previousItem && conversationSummariesRenderEqual(previousItem, item)) {
      return previousItem;
    }
    changed = true;
    return item;
  });
  return changed ? stable : previous;
}

export function updateConversationSectionsFromSummaries(
  previous: ConversationSection[] | null,
  conversations: readonly AgentGUINodeViewModel["conversations"][number][],
  options: { sectionConversationsLabel: string; sectionPinnedLabel?: string }
): ConversationSection[] | null {
  if (!previous || conversations.length === 0) {
    return previous;
  }
  const summariesById = new Map(
    conversations.map((conversation) => [conversation.id, conversation])
  );
  const summarySectionItemsById = new Map<
    string,
    AgentGUINodeViewModel["conversations"]
  >();
  for (const conversation of conversations) {
    if ((conversation.pinnedAtUnixMs ?? 0) > 0) {
      continue;
    }
    const sectionId = conversation.project
      ? `project:${normalizeConversationProjectPath(conversation.project.path)}`
      : "conversations";
    const items = summarySectionItemsById.get(sectionId) ?? [];
    items.push(conversation);
    summarySectionItemsById.set(sectionId, items);
  }
  const seenIds = new Set<string>();
  let changed = false;
  const nextSections = previous.map((section) => {
    let sectionChanged = false;
    if (section.kind === "pinned") {
      const pinnedSummaryItems = conversations.filter(
        (conversation) => (conversation.pinnedAtUnixMs ?? 0) > 0
      );
      const items = section.items
        .map((item) => {
          seenIds.add(item.id);
          const summary = summariesById.get(item.id);
          if (!summary) {
            return item;
          }
          if ((summary.pinnedAtUnixMs ?? 0) <= 0) {
            sectionChanged = true;
            return null;
          }
          if (conversationSummariesRenderEqual(item, summary)) {
            return item;
          }
          sectionChanged = true;
          return summary;
        })
        .filter(
          (item): item is AgentGUINodeViewModel["conversations"][number] =>
            item !== null
        );
      const existingIds = new Set(items.map((item) => item.id));
      const mergedItems = [
        ...items,
        ...pinnedSummaryItems.filter((item) => !existingIds.has(item.id))
      ];
      if (mergedItems.length !== items.length) {
        sectionChanged = true;
      }
      for (const item of pinnedSummaryItems) {
        seenIds.add(item.id);
      }
      const stableItems = stabilizeConversationSectionItems(
        section.items,
        sortPinnedConversations(mergedItems)
      );
      if (!sectionChanged && stableItems === section.items) {
        return section;
      }
      changed = true;
      return {
        ...section,
        items: stableItems
      };
    }
    const summaryItems = summarySectionItemsById.get(section.id) ?? [];
    const summaryIdsForSection = new Set(summaryItems.map((item) => item.id));
    const items = section.items
      .map((item) => {
        seenIds.add(item.id);
        const summary = summariesById.get(item.id);
        if (!summary) {
          return item;
        }
        const nextItem = section.project
          ? {
              ...summary,
              project: section.project
            }
          : summary;
        if (conversationSummariesRenderEqual(item, nextItem)) {
          return item;
        }
        sectionChanged = true;
        return nextItem;
      })
      .filter((item) => {
        const summary = summariesById.get(item.id);
        if (!summary || summaryIdsForSection.has(item.id)) {
          return true;
        }
        sectionChanged = true;
        return false;
      });
    const nextSection = sectionChanged
      ? {
          ...section,
          items
        }
      : section;
    if (summaryItems.length === 0) {
      if (sectionChanged) {
        changed = true;
      }
      return nextSection;
    }
    const summaryIds = new Set(summaryItems.map((item) => item.id));
    const mergedItems = [
      ...summaryItems.map((item) =>
        section.project ? { ...item, project: section.project } : item
      ),
      ...items.filter((item) => !summaryIds.has(item.id))
    ];
    const stableItems = stabilizeConversationSectionItems(
      section.items,
      mergedItems
    );
    if (stableItems === section.items) {
      if (sectionChanged) {
        changed = true;
      }
      return nextSection;
    }
    changed = true;
    return {
      ...nextSection,
      items: stableItems
    };
  });

  // A conversation can go from not-existing to existing between two runtime
  // section fetches (e.g. the optimistic pre-activation entry created by
  // the first-message flow, whose id never changes once the real backend
  // session lands). The loop above only patches items that are already
  // present in some section; without this, such a conversation would never
  // appear in the sidebar until the next full runtimeListSessionSections
  // refetch happens to include it, which -- because that refetch is keyed
  // off conversation membership -- may never happen again for the same id.
  const existingSectionIds = new Set(nextSections.map((section) => section.id));
  const newPinnedConversations =
    existingSectionIds.has("pinned") || !options.sectionPinnedLabel
      ? []
      : conversations.filter(
          (conversation) =>
            (conversation.pinnedAtUnixMs ?? 0) > 0 &&
            !seenIds.has(conversation.id)
        );
  const newConversations = [...summarySectionItemsById.entries()].flatMap(
    ([sectionId, items]) =>
      existingSectionIds.has(sectionId)
        ? []
        : items.filter((conversation) => !seenIds.has(conversation.id))
  );
  if (newPinnedConversations.length === 0 && newConversations.length === 0) {
    return changed ? nextSections : previous;
  }

  const sectionsWithInsertions = [...nextSections];
  if (newPinnedConversations.length > 0 && options.sectionPinnedLabel) {
    sectionsWithInsertions.unshift({
      id: "pinned",
      kind: "pinned",
      label: options.sectionPinnedLabel,
      project: null,
      items: sortPinnedConversations(newPinnedConversations)
    });
  }
  for (const conversation of newConversations) {
    const targetSectionId = conversation.project
      ? `project:${normalizeConversationProjectPath(conversation.project.path)}`
      : "conversations";
    const targetIndex = sectionsWithInsertions.findIndex(
      (section) => section.id === targetSectionId
    );
    const target =
      targetIndex !== -1 ? sectionsWithInsertions[targetIndex] : undefined;
    if (targetIndex !== -1 && target) {
      sectionsWithInsertions[targetIndex] = {
        ...target,
        items: [...target.items, conversation]
      };
      continue;
    }
    sectionsWithInsertions.push({
      id: targetSectionId,
      kind: conversation.project ? "project" : "conversations",
      label: conversation.project?.label ?? options.sectionConversationsLabel,
      project: conversation.project ?? null,
      items: [conversation]
    });
  }
  return sectionsWithInsertions;
}

function sortPinnedConversations(
  conversations: AgentGUINodeViewModel["conversations"]
): AgentGUINodeViewModel["conversations"] {
  return [...conversations].sort(
    (left, right) =>
      (right.pinnedAtUnixMs ?? 0) - (left.pinnedAtUnixMs ?? 0) ||
      (right.sortTimeUnixMs ?? right.updatedAtUnixMs) -
        (left.sortTimeUnixMs ?? left.updatedAtUnixMs) ||
      left.id.localeCompare(right.id)
  );
}

function projectRuntimeSectionsToConversationSections(input: {
  conversationFilter: Parameters<
    typeof buildAgentGUIConversationSummaries
  >[0]["conversationFilter"];
  labels: Pick<AgentGUIViewLabels, "sectionPinned" | "sectionConversations">;
  pinned?: AgentActivityRuntimeSessionPage;
  sections: readonly AgentActivityRuntimeSessionSection[];
  workspaceId: string;
}): ConversationSection[] {
  const pinned: AgentGUINodeViewModel["conversations"] = input.pinned
    ? buildAgentGUIConversationSummaries({
        conversationFilter: input.conversationFilter,
        provider: AGENT_GUI_CONVERSATION_RAIL_PROJECTION_PROVIDER,
        snapshot: {
          composerOptionsByProvider: {},
          presences: [],
          sessionMessagesById: {},
          sessions: input.pinned.sessions,
          workspaceId: input.workspaceId
        },
        userProjects: []
      }).filter((conversation) => (conversation.pinnedAtUnixMs ?? 0) > 0)
    : [];
  const result: ConversationSection[] = [];
  for (const section of input.sections) {
    const project = section.userProject
      ? {
          createdAtUnixMs: section.userProject.createdAtUnixMs,
          id: section.userProject.id,
          label: section.userProject.label,
          lastUsedAtUnixMs: section.userProject.lastUsedAtUnixMs,
          path: section.userProject.path,
          updatedAtUnixMs: section.userProject.updatedAtUnixMs
        }
      : null;
    const conversations = buildAgentGUIConversationSummaries({
      conversationFilter: input.conversationFilter,
      provider: AGENT_GUI_CONVERSATION_RAIL_PROJECTION_PROVIDER,
      snapshot: {
        composerOptionsByProvider: {},
        presences: [],
        sessionMessagesById: {},
        sessions: section.sessions,
        workspaceId: input.workspaceId
      },
      userProjects: []
    }).map((conversation) => ({
      ...conversation,
      project: section.kind === "project" ? project : null
    }));
    const items = conversations.filter((conversation) => {
      if ((conversation.pinnedAtUnixMs ?? 0) > 0) {
        pinned.push(conversation);
        return false;
      }
      return true;
    });
    result.push({
      id: section.sectionKey,
      kind: section.kind,
      label:
        section.kind === "project"
          ? (section.userProject?.label ?? section.sectionKey)
          : input.labels.sectionConversations,
      project,
      items
    });
  }
  if (pinned.length > 0) {
    const pinnedById = new Map<
      string,
      AgentGUINodeViewModel["conversations"][number]
    >();
    for (const conversation of pinned) {
      pinnedById.set(conversation.id, conversation);
    }
    result.unshift({
      id: "pinned",
      kind: "pinned",
      label: input.labels.sectionPinned,
      project: null,
      items: sortPinnedConversations([...pinnedById.values()])
    });
  }
  return result;
}

function conversationSummariesRenderEqual(
  left: AgentGUINodeViewModel["conversations"][number],
  right: AgentGUINodeViewModel["conversations"][number]
): boolean {
  return (
    left.id === right.id &&
    left.agentTargetId === right.agentTargetId &&
    left.provider === right.provider &&
    left.title === right.title &&
    left.titleFallback === right.titleFallback &&
    left.status === right.status &&
    left.cwd === right.cwd &&
    left.pinnedAtUnixMs === right.pinnedAtUnixMs &&
    left.sortTimeUnixMs === right.sortTimeUnixMs &&
    left.updatedAtUnixMs === right.updatedAtUnixMs &&
    left.isImported === right.isImported &&
    left.hasUnreadCompletion === right.hasUnreadCompletion &&
    left.unreadCompletionKey === right.unreadCompletionKey &&
    conversationProjectsRenderEqual(left.project, right.project) &&
    conversationSyncStatesRenderEqual(left.syncState, right.syncState)
  );
}

function conversationSyncStatesRenderEqual(
  left: AgentGUINodeViewModel["conversations"][number]["syncState"],
  right: AgentGUINodeViewModel["conversations"][number]["syncState"]
): boolean {
  return (
    left === right ||
    (!left || !right
      ? (left ?? null) === (right ?? null)
      : left.workspaceId === right.workspaceId &&
        left.agentSessionId === right.agentSessionId &&
        left.status === right.status &&
        left.pendingTimelineItemCount === right.pendingTimelineItemCount &&
        left.pendingStatePatchCount === right.pendingStatePatchCount &&
        left.attemptCount === right.attemptCount &&
        left.failedReportCount === right.failedReportCount &&
        left.lastError === right.lastError &&
        left.lastAttemptAtUnixMs === right.lastAttemptAtUnixMs &&
        left.lastSyncedAtUnixMs === right.lastSyncedAtUnixMs &&
        left.updatedAtUnixMs === right.updatedAtUnixMs)
  );
}

function conversationProjectsRenderEqual(
  left: AgentGUINodeViewModel["conversations"][number]["project"],
  right: AgentGUINodeViewModel["conversations"][number]["project"]
): boolean {
  return (
    left === right ||
    (!left || !right
      ? !left && !right
      : left.id === right.id &&
        left.path === right.path &&
        left.label === right.label &&
        left.createdAtUnixMs === right.createdAtUnixMs &&
        left.updatedAtUnixMs === right.updatedAtUnixMs &&
        left.lastUsedAtUnixMs === right.lastUsedAtUnixMs)
  );
}

const agentGUIProviderRailOrder: readonly AgentGUIProvider[] = [
  "codex",
  "claude-code",
  "cursor",
  "opencode",
  "tutti-agent",
  "nexight",
  "hermes",
  "openclaw"
];

const agentGUIProviderRailDefaultProviders = [
  "codex",
  "claude-code",
  "cursor",
  "hermes",
  "openclaw"
] as const satisfies readonly AgentGUIProvider[];

const agentGUIProviderRailDisabledProviders = new Set<AgentGUIProvider>([
  "nexight",
  "hermes",
  "openclaw"
]);

function agentGUIProviderRailOrderIndex(provider: AgentGUIProvider): number {
  const index = agentGUIProviderRailOrder.indexOf(provider);
  return index < 0 ? agentGUIProviderRailOrder.length : index;
}

function agentGUILaunchpadIconPresentations(): readonly AgentGUIProviderIconPresentation[] {
  return [
    agentGUIProviderRailIconPresentation("codex"),
    agentGUIProviderRailIconPresentation("claude-code"),
    agentGUIProviderRailIconPresentation("cursor"),
    agentGUIProviderRailIconPresentation("tutti")
  ];
}

function agentGUIConversationProviderIconUrl(
  provider: string | undefined
): string | null {
  return resolveAgentGuiSessionProviderFlatIconUrl(provider);
}

function agentGUIProviderRailLabel(
  provider: AgentGUIProvider,
  targetLabel: string,
  labels: AgentGUIViewLabels
): string {
  if (provider === "nexight" && targetLabel === "Tutti Agent") {
    return labels.conversationFilterTutti;
  }
  if (targetLabel.trim() && targetLabel !== provider) {
    return targetLabel;
  }
  if (provider === "codex") {
    return labels.conversationFilterCodex;
  }
  if (provider === "claude-code") {
    return labels.conversationFilterClaudeCode;
  }
  return targetLabel;
}

function agentGUIProviderRailAriaLabel(
  label: string,
  badgeLabel: string | null | undefined
): string {
  const normalizedBadgeLabel = badgeLabel?.trim() ?? "";
  if (!normalizedBadgeLabel || normalizedBadgeLabel === label) {
    return label;
  }
  return `${label}, ${normalizedBadgeLabel}`;
}

function agentGUIProviderTargetMatchesConversationFilter(
  target: AgentGUINodeViewModel["providerTargets"][number],
  filter: AgentGUINodeViewModel["conversationFilter"]
): boolean {
  return (
    filter.kind === "agentTarget" &&
    (target.agentTargetId?.trim() ?? "") === filter.agentTargetId
  );
}

function agentGUIProviderRailTargets(
  providerTargets: AgentGUINodeViewModel["providerTargets"],
  providerTargetsLoading: boolean,
  comingSoonProviders: AgentGUINodeViewModel["comingSoonProviders"],
  providerRailMode: AgentGUINodeViewModel["providerRailMode"]
): AgentGUINodeViewModel["providerTargets"] {
  if (providerTargetsLoading) {
    return [];
  }
  // Exact mode renders precisely the provided targets — no backfilling to the
  // default provider catalog, no local/placeholder padding.
  if (providerRailMode === "exact") {
    return providerTargets;
  }
  const comingSoon = new Set(comingSoonProviders);
  const source =
    providerTargets.length > 0 &&
    !agentGUIProviderRailTargetsAreFullLocalFallback(providerTargets)
      ? providerTargets
      : [];
  const seenProviders = new Set(source.map((target) => target.provider));
  const missingDefaultProviders = agentGUIProviderRailDefaultProviders.filter(
    (provider) => !seenProviders.has(provider)
  );
  if (source.length > 0 && missingDefaultProviders.length === 0) {
    return source;
  }
  return [
    ...source,
    ...missingDefaultProviders.map((provider) =>
      agentGUIProviderRailDisabledProviders.has(provider) ||
      comingSoon.has(provider)
        ? createDisabledPlaceholderAgentGUIProviderTarget(provider)
        : createLocalAgentGUIProviderTarget(provider)
    )
  ];
}

function agentGUIProviderRailTargetsAreFullLocalFallback(
  providerTargets: AgentGUINodeViewModel["providerTargets"]
): boolean {
  if (providerTargets.length !== agentGUIProviderRailOrder.length) {
    return false;
  }
  const fallbackProviders = new Set(agentGUIProviderRailOrder);
  return providerTargets.every(
    (target) =>
      fallbackProviders.has(target.provider) &&
      target.ref.kind === "local" &&
      target.ref.provider === target.provider &&
      target.targetId === `local:${target.provider}`
  );
}

interface AgentGUIProviderRailProps {
  conversationFilter: AgentGUINodeViewModel["conversationFilter"];
  labels: AgentGUIViewLabels;
  previewMode: boolean;
  workspaceId: string;
  selectedProviderTarget: AgentGUINodeViewModel["selectedProviderTarget"];
  providerTargets: AgentGUINodeViewModel["providerTargets"];
  providerTargetsLoading: AgentGUINodeViewModel["providerTargetsLoading"];
  providerRailMode: AgentGUINodeViewModel["providerRailMode"];
  renderProviderRailEmpty?: AgentGUIProviderRailEmptyRenderer;
  providerRailAllPresentation?: AgentGUIProviderRailAllPresentation | null;
  comingSoonProviders: AgentGUINodeViewModel["comingSoonProviders"];
  onRequestComposerFocus: () => void;
  onSelectConversationFilterTarget: AgentGUINodeViewProps["actions"]["selectConversationFilterTarget"];
  onUpdateConversationFilter: (
    filter: AgentGUINodeViewModel["conversationFilter"]
  ) => void;
}

const AGENT_GUI_PROVIDER_RAIL_DRAG_HYSTERESIS_PX = 8;

type AgentGUIProviderRailDragState = {
  draggedTargetId: string;
  overTargetId: string | null;
  position: "before" | "after" | null;
};

const AgentGUIProviderRail = memo(function AgentGUIProviderRail({
  conversationFilter,
  labels,
  previewMode,
  workspaceId,
  selectedProviderTarget,
  providerTargets,
  providerTargetsLoading,
  providerRailMode,
  renderProviderRailEmpty,
  providerRailAllPresentation,
  comingSoonProviders,
  onRequestComposerFocus,
  onSelectConversationFilterTarget,
  onUpdateConversationFilter
}: AgentGUIProviderRailProps): React.JSX.Element {
  "use memo";
  const providerRailOrderStorageKey = useMemo(
    () => agentGUIProviderRailOrderStorageKey(workspaceId),
    [workspaceId]
  );
  const [providerRailOrder, setProviderRailOrder] = useState<readonly string[]>(
    () =>
      parseAgentGUIProviderRailOrder(
        globalThis.localStorage?.getItem(providerRailOrderStorageKey)
      )
  );
  const [dragState, setDragState] =
    useState<AgentGUIProviderRailDragState | null>(null);
  const dragStateRef = useRef<AgentGUIProviderRailDragState | null>(null);
  const setProviderRailDragState = useCallback(
    (nextDragState: AgentGUIProviderRailDragState | null) => {
      dragStateRef.current = nextDragState;
      setDragState(nextDragState);
    },
    []
  );

  useEffect(() => {
    setProviderRailOrder(
      parseAgentGUIProviderRailOrder(
        globalThis.localStorage?.getItem(providerRailOrderStorageKey)
      )
    );
  }, [providerRailOrderStorageKey]);

  const persistProviderRailOrder = useCallback(
    (nextOrder: readonly string[]) => {
      setProviderRailOrder(nextOrder);
      globalThis.localStorage?.setItem(
        providerRailOrderStorageKey,
        serializeAgentGUIProviderRailOrder(nextOrder)
      );
    },
    [providerRailOrderStorageKey]
  );

  const railProviderTargets = useMemo(
    () =>
      agentGUIProviderRailTargets(
        providerTargets,
        providerTargetsLoading,
        comingSoonProviders,
        providerRailMode
      ),
    [
      comingSoonProviders,
      providerRailMode,
      providerTargets,
      providerTargetsLoading
    ]
  );
  const providerTiles = useMemo(() => {
    const targets = [...railProviderTargets];
    const orderedTargets =
      providerRailMode === "exact"
        ? targets
        : (() => {
            const originalIndexByTarget = new Map<string, number>();
            targets.forEach((target, index) => {
              originalIndexByTarget.set(
                `${target.provider}\u0000${target.targetId}`,
                index
              );
            });
            return targets.sort((left, right) => {
              const orderDelta =
                agentGUIProviderRailOrderIndex(left.provider) -
                agentGUIProviderRailOrderIndex(right.provider);
              if (orderDelta !== 0) {
                return orderDelta;
              }
              return (
                (originalIndexByTarget.get(
                  `${left.provider}\u0000${left.targetId}`
                ) ?? 0) -
                (originalIndexByTarget.get(
                  `${right.provider}\u0000${right.targetId}`
                ) ?? 0)
              );
            });
          })();
    return applyAgentGUIProviderRailOrder(orderedTargets, providerRailOrder);
  }, [providerRailMode, providerRailOrder, railProviderTargets]);
  const visibleProviderTiles = useMemo(() => {
    if (!providerTiles.some((target) => target.provider === "tutti-agent")) {
      return providerTiles;
    }
    return providerTiles.filter(
      (target) => target.provider !== "nexight" || target.disabled !== true
    );
  }, [providerTiles]);
  const selectedProviderTargetIsPlaceholder =
    selectedProviderTarget?.disabled === true;
  const allTileSelected =
    conversationFilter.kind === "all" && !selectedProviderTargetIsPlaceholder;
  const selectAllProviders = useCallback(() => {
    onUpdateConversationFilter({ kind: "all" });
    if (selectedProviderTargetIsPlaceholder) {
      const fallbackTarget =
        railProviderTargets.find((target) => target.disabled !== true) ?? null;
      if (fallbackTarget) {
        onSelectConversationFilterTarget({
          provider: fallbackTarget.provider,
          providerTargetId: fallbackTarget.targetId
        });
      }
    }
    onRequestComposerFocus();
  }, [
    onSelectConversationFilterTarget,
    onRequestComposerFocus,
    onUpdateConversationFilter,
    railProviderTargets,
    selectedProviderTargetIsPlaceholder
  ]);
  const selectAgentTargetTile = useCallback(
    (target: AgentGUINodeViewModel["providerTargets"][number]) => {
      onSelectConversationFilterTarget({
        provider: target.provider,
        providerTargetId: target.targetId
      });
      onRequestComposerFocus();
    },
    [onRequestComposerFocus, onSelectConversationFilterTarget]
  );
  const clearProviderRailDragState = useCallback(() => {
    setProviderRailDragState(null);
  }, [setProviderRailDragState]);
  const handleProviderRailDragStart = useCallback(
    (
      event: DragEvent<HTMLButtonElement>,
      target: AgentGUINodeViewModel["providerTargets"][number]
    ) => {
      if (previewMode || providerTargetsLoading) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", target.targetId);
      setProviderRailDragState({
        draggedTargetId: target.targetId,
        overTargetId: null,
        position: null
      });
    },
    [previewMode, providerTargetsLoading, setProviderRailDragState]
  );
  const handleProviderRailDragOver = useCallback(
    (
      event: DragEvent<HTMLButtonElement>,
      target: AgentGUINodeViewModel["providerTargets"][number]
    ) => {
      if (previewMode || providerTargetsLoading || !dragState) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (dragState.draggedTargetId === target.targetId) {
        return;
      }
      const bounds = event.currentTarget.getBoundingClientRect();
      const midpointY = bounds.top + bounds.height / 2;
      let position: "before" | "after";
      if (dragState.overTargetId === target.targetId && dragState.position) {
        if (
          dragState.position === "before" &&
          event.clientY <=
            midpointY + AGENT_GUI_PROVIDER_RAIL_DRAG_HYSTERESIS_PX
        ) {
          position = "before";
        } else if (
          dragState.position === "after" &&
          event.clientY >=
            midpointY - AGENT_GUI_PROVIDER_RAIL_DRAG_HYSTERESIS_PX
        ) {
          position = "after";
        } else {
          position = event.clientY > midpointY ? "after" : "before";
        }
      } else {
        position = event.clientY > midpointY ? "after" : "before";
      }
      setProviderRailDragState({
        draggedTargetId: dragState.draggedTargetId,
        overTargetId: target.targetId,
        position
      });
    },
    [dragState, previewMode, providerTargetsLoading, setProviderRailDragState]
  );
  const commitProviderRailDragDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const fallbackDraggedTargetId = event.dataTransfer
        .getData("text/plain")
        .trim();
      const activeDragState =
        dragStateRef.current ??
        dragState ??
        (fallbackDraggedTargetId
          ? {
              draggedTargetId: fallbackDraggedTargetId,
              overTargetId: null,
              position: null
            }
          : null);
      if (previewMode || providerTargetsLoading || !activeDragState) {
        clearProviderRailDragState();
        return;
      }
      let overTargetId = activeDragState.overTargetId;
      let dropPosition = activeDragState.position ?? "before";
      if (!overTargetId || overTargetId === activeDragState.draggedTargetId) {
        const dropTargets = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "[data-provider-tile='true']"
          )
        )
          .map((element) => {
            const targetId = element.dataset.providerTargetId?.trim() ?? "";
            if (!targetId || targetId === activeDragState.draggedTargetId) {
              return null;
            }
            const bounds = element.getBoundingClientRect();
            const midpointY = bounds.top + bounds.height / 2;
            return {
              midpointY,
              targetId
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .sort((left, right) => left.midpointY - right.midpointY);
        const firstTarget = dropTargets[0];
        const lastTarget = dropTargets[dropTargets.length - 1];
        if (firstTarget && lastTarget) {
          const inferredTarget =
            event.clientY <= firstTarget.midpointY
              ? firstTarget
              : event.clientY >= lastTarget.midpointY
                ? lastTarget
                : (dropTargets.find(
                    (entry) => event.clientY <= entry.midpointY
                  ) ?? lastTarget);
          overTargetId = inferredTarget.targetId;
          dropPosition =
            event.clientY > inferredTarget.midpointY ? "after" : "before";
        }
      }
      if (!overTargetId || overTargetId === activeDragState.draggedTargetId) {
        const droppedOnRailGap = event.target === event.currentTarget;
        const finalTargetId = visibleProviderTiles
          .map((tile) => tile.targetId)
          .filter((targetId) => targetId !== activeDragState.draggedTargetId)
          .at(-1);
        if (droppedOnRailGap && finalTargetId) {
          overTargetId = finalTargetId;
          dropPosition = "after";
        }
      }
      if (!overTargetId || overTargetId === activeDragState.draggedTargetId) {
        clearProviderRailDragState();
        return;
      }
      event.preventDefault();
      const nextOrder = reorderAgentGUIProviderRailOrder({
        currentTargetIds: visibleProviderTiles.map((tile) => tile.targetId),
        draggedTargetId: activeDragState.draggedTargetId,
        dropPosition,
        overTargetId
      });
      persistProviderRailOrder(nextOrder);
      clearProviderRailDragState();
    },
    [
      clearProviderRailDragState,
      dragState,
      persistProviderRailOrder,
      previewMode,
      providerTargetsLoading,
      visibleProviderTiles
    ]
  );
  const handleProviderRailContainerDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const activeDragState = dragStateRef.current ?? dragState;
      if (!activeDragState || previewMode || providerTargetsLoading) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const tileElements = Array.from(
        event.currentTarget.querySelectorAll<HTMLButtonElement>(
          "[data-provider-tile='true']"
        )
      );
      const dropTargets = tileElements
        .map((element) => {
          const targetId = element.dataset.providerTargetId?.trim() ?? "";
          if (!targetId || targetId === activeDragState.draggedTargetId) {
            return null;
          }
          const bounds = element.getBoundingClientRect();
          const midpointY = bounds.top + bounds.height / 2;
          return {
            distance: Math.abs(event.clientY - midpointY),
            midpointY,
            targetId
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort((left, right) => left.midpointY - right.midpointY);
      if (dropTargets.length === 0) {
        return;
      }
      const firstTarget = dropTargets[0];
      const lastTarget = dropTargets[dropTargets.length - 1];
      if (!firstTarget || !lastTarget) {
        return;
      }
      const inferredTarget =
        event.clientY <= firstTarget.midpointY
          ? firstTarget
          : event.clientY >= lastTarget.midpointY
            ? lastTarget
            : (dropTargets.find((entry) => event.clientY <= entry.midpointY) ??
              lastTarget);
      const position =
        event.clientY > inferredTarget.midpointY ? "after" : "before";
      setProviderRailDragState({
        draggedTargetId: activeDragState.draggedTargetId,
        overTargetId: inferredTarget.targetId,
        position
      });
    },
    [dragState, previewMode, providerTargetsLoading, setProviderRailDragState]
  );

  // Exact mode with no targets (and not loading): hand the rail body to the
  // host-provided empty renderer instead of the static local catalog fallback.
  if (
    providerRailMode === "exact" &&
    !providerTargetsLoading &&
    visibleProviderTiles.length === 0 &&
    renderProviderRailEmpty
  ) {
    return (
      <div
        className={styles.providerRail}
        role="tablist"
        aria-label={labels.providerSwitchLabel}
        aria-busy={providerTargetsLoading}
        data-empty="true"
      >
        {renderProviderRailEmpty()}
      </div>
    );
  }

  return (
    <div className={styles.providerRail}>
      <div
        className="flex min-h-0 w-full flex-col items-center"
        role="tablist"
        aria-label={labels.providerSwitchLabel}
        aria-busy={providerTargetsLoading}
        onDragOver={handleProviderRailContainerDragOver}
        onDrop={commitProviderRailDragDrop}
      >
        <button
          type="button"
          role="tab"
          aria-label={labels.conversationFilterAll}
          aria-selected={allTileSelected}
          className={styles.providerRailTile}
          data-selected={allTileSelected ? "true" : "false"}
          disabled={previewMode}
          onClick={selectAllProviders}
        >
          <AgentGUIUnifiedProviderIcon
            presentation={providerRailAllPresentation}
          />
          <span className={styles.providerRailTileLabel}>
            {labels.conversationFilterAll}
          </span>
        </button>
        <span aria-hidden="true" className={styles.providerRailSeparator} />
        {providerTargetsLoading
          ? [0, 1, 2].map((index) => (
              <button
                key={`provider-target-loading-${index}`}
                type="button"
                role="tab"
                aria-selected="false"
                className={styles.providerRailTile}
                data-loading="true"
                data-selected="false"
                disabled
              >
                <span
                  aria-hidden="true"
                  className={styles.providerRailAvatar}
                />
              </button>
            ))
          : null}
        {visibleProviderTiles.map((target) => {
          const providerSelected =
            target.disabled === true
              ? selectedProviderTarget?.provider === target.provider &&
                selectedProviderTarget?.targetId === target.targetId
              : agentGUIProviderTargetMatchesConversationFilter(
                  target,
                  conversationFilter
                );
          const label = agentGUIProviderRailLabel(
            target.provider,
            target.label,
            labels
          );
          const ariaLabel = agentGUIProviderRailAriaLabel(
            label,
            target.badge?.label
          );
          const tile = (
            <button
              key={`${target.provider}:${target.targetId}`}
              type="button"
              role="tab"
              aria-label={ariaLabel}
              aria-selected={providerSelected}
              className={styles.providerRailTile}
              data-disabled={target.disabled === true ? "true" : undefined}
              data-drag-over={
                dragState?.overTargetId === target.targetId
                  ? dragState.position
                  : undefined
              }
              data-dragging={
                dragState?.draggedTargetId === target.targetId
                  ? "true"
                  : undefined
              }
              data-provider-tile="true"
              data-provider-target-id={target.targetId}
              data-selected={providerSelected ? "true" : "false"}
              disabled={previewMode}
              draggable={!previewMode && !providerTargetsLoading}
              onClick={() => selectAgentTargetTile(target)}
              onDragEnd={clearProviderRailDragState}
              onDragOver={(event) => handleProviderRailDragOver(event, target)}
              onDragStart={(event) =>
                handleProviderRailDragStart(event, target)
              }
            >
              <span className={styles.providerRailAvatar}>
                <AgentGUIProviderIconVisual
                  ariaHidden
                  imageClassName={styles.providerRailAvatarImage}
                  icon={agentGUIProviderRailIconPresentation(
                    target.provider,
                    target.iconUrl
                  )}
                />
                {target.badge?.iconUrl ? (
                  <span aria-hidden="true" className={styles.providerRailBadge}>
                    <img
                      alt=""
                      className={styles.providerRailBadgeImage}
                      draggable={false}
                      src={target.badge.iconUrl}
                    />
                  </span>
                ) : null}
              </span>
            </button>
          );
          if (previewMode) {
            return tile;
          }
          return (
            <Tooltip key={`${target.provider}:${target.targetId}:tooltip`}>
              <TooltipTrigger asChild>{tile}</TooltipTrigger>
              <TooltipContent side="right" sideOffset={-4}>
                {label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
});

interface AgentGUIAccountRailMenuProps {
  accountMenuState: AgentGUIAccountMenuState;
  labels: AgentGUIViewLabels;
  previewMode: boolean;
}

interface AgentGUIAccountRewardToastProps {
  toast: NonNullable<AgentGUIAccountMenuState["registrationCreditsToast"]>;
  labels: Pick<
    AgentGUIViewLabels,
    | "accountRewardToastTitle"
    | "accountRewardToastCreditsUnit"
    | "accountRewardToastDescription"
    | "accountRewardToastClose"
  >;
}

const accountRewardToastAutoDismissMs = 120_000;

const AgentGUIAccountRewardToast = memo(function AgentGUIAccountRewardToast({
  toast,
  labels
}: AgentGUIAccountRewardToastProps): React.JSX.Element | null {
  "use memo";
  useEffect(() => {
    if (!toast.visible) {
      return;
    }
    const timeout = window.setTimeout(
      toast.onDismiss,
      toast.autoDismissMs ?? accountRewardToastAutoDismissMs
    );
    return () => {
      window.clearTimeout(timeout);
    };
  }, [toast.autoDismissMs, toast.onDismiss, toast.visible]);

  if (!toast.visible) {
    return null;
  }

  return (
    <div
      className="agent-gui-node__account-reward-toast nodrag relative mx-3 mb-1 w-[calc(100%-24px)] max-w-[calc(100%-24px)] overflow-hidden rounded-[14px] p-2.5 pr-9 text-white [-webkit-app-region:no-drag]"
      data-testid="agent-gui-account-reward-toast"
      role="status"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/90 to-transparent" />
      <div className="relative flex min-w-0 items-center gap-2.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-[rgba(250,255,236,0.78)] text-emerald-400 shadow-[0_9px_18px_rgba(20,184,166,0.18),0_0_0_1px_rgba(255,255,255,0.5)_inset]">
          <Gift aria-hidden="true" size={23} strokeWidth={2} />
        </span>
        <span
          aria-hidden="true"
          className="absolute left-[40px] top-0 h-2 w-2 rounded-full bg-white/85 shadow-[0_0_10px_rgba(255,255,255,0.7)]"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-semibold leading-4 text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.22)]">
            {labels.accountRewardToastTitle}
          </span>
          <span className="block truncate text-[20px] font-semibold leading-6 text-white drop-shadow-[0_2px_5px_rgba(0,0,0,0.22)]">
            +{toast.creditsLabel} {labels.accountRewardToastCreditsUnit}
          </span>
          <span className="block truncate text-[11px] font-medium leading-4 text-white/88 drop-shadow-[0_1px_3px_rgba(0,0,0,0.18)]">
            {labels.accountRewardToastDescription}
          </span>
        </span>
      </div>
      <button
        type="button"
        aria-label={labels.accountRewardToastClose}
        className="nodrag absolute right-2.5 top-2.5 grid h-6 w-6 place-items-center rounded-[7px] text-white/85 hover:bg-white/18 hover:text-white [-webkit-app-region:no-drag]"
        onClick={toast.onDismiss}
      >
        <X aria-hidden="true" size={16} strokeWidth={2} />
      </button>
    </div>
  );
});

const AgentGUIAccountRailMenu = memo(function AgentGUIAccountRailMenu({
  accountMenuState,
  labels,
  previewMode
}: AgentGUIAccountRailMenuProps): React.JSX.Element {
  "use memo";
  const userLabel = agentGUIAccountUserLabel(accountMenuState, labels);
  const initials = agentGUIAccountInitials(userLabel);
  const membershipLabel =
    accountMenuState.membershipLabel.trim() || labels.accountMenuFree;
  const creditsLabel =
    accountMenuState.loading && !accountMenuState.creditsLabel
      ? labels.accountMenuLoading
      : (accountMenuState.creditsLabel ?? labels.accountMenuUnavailable);
  const errorLabel =
    accountMenuState.error ||
    (accountMenuState.partialError ? labels.accountMenuDataUnavailable : null);
  const openExternal = useCallback(
    (url: string) => {
      accountMenuState.onOpenExternal(url);
    },
    [accountMenuState]
  );
  return (
    <div className="flex min-w-0 flex-col">
      {accountMenuState.registrationCreditsToast ? (
        <AgentGUIAccountRewardToast
          labels={labels}
          toast={accountMenuState.registrationCreditsToast}
        />
      ) : null}
      <Popover onOpenChange={accountMenuState.onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={userLabel}
            className="nodrag mx-2 mt-2 flex min-h-12 w-[calc(100%-16px)] min-w-0 items-center gap-2 rounded-[8px] px-2 text-left text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] disabled:opacity-50 [-webkit-app-region:no-drag]"
            data-account-menu-trigger="true"
            disabled={previewMode}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--background-fronted)] text-[13px] font-semibold">
              {accountMenuState.user?.avatar ? (
                <img
                  alt=""
                  className="h-full w-full object-cover"
                  src={accountMenuState.user.avatar}
                />
              ) : (
                <span aria-hidden="true">{initials}</span>
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold leading-4">
                {userLabel}
              </span>
              <AccountMembershipBadge
                className="mt-0.5"
                label={membershipLabel}
              />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="right"
          align="end"
          sideOffset={8}
          className="w-[232px] max-w-[calc(100vw-32px)] p-1 text-xs"
          data-testid="agent-gui-account-menu"
        >
          <div className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-center gap-2 px-2 py-2">
              <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-[8px] bg-[var(--background-fronted)] text-[13px] font-semibold text-[var(--text-primary)]">
                {accountMenuState.user?.avatar ? (
                  <img
                    alt=""
                    className="h-full w-full object-cover"
                    src={accountMenuState.user.avatar}
                  />
                ) : (
                  initials
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-[var(--text-primary)]">
                  {userLabel}
                </span>
                <AccountMembershipBadge
                  className="mt-1"
                  label={membershipLabel}
                />
              </span>
            </div>
            <span
              aria-hidden="true"
              className="mx-2 h-px bg-[var(--border-1)]"
            />
            {accountMenuState.user ? (
              <>
                <button
                  type="button"
                  className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                  onClick={() => openExternal(accountMenuState.links.planUrl)}
                >
                  <Crown aria-hidden="true" size={15} strokeWidth={1.8} />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {labels.accountMenuMember}
                  </span>
                  <span className="shrink-0 rounded-[6px] bg-[color-mix(in_srgb,var(--tutti-purple)_24%,transparent)] px-2 py-0.5 text-[12px] font-semibold text-[var(--tutti-purple)]">
                    {labels.accountMenuUpgrade}
                  </span>
                </button>
                <button
                  type="button"
                  className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                  onClick={() => openExternal(accountMenuState.links.usageUrl)}
                >
                  <Coins aria-hidden="true" size={15} strokeWidth={1.8} />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {labels.accountMenuCreditsBalance}
                  </span>
                  <span className="truncate text-[var(--text-secondary)]">
                    {creditsLabel}
                  </span>
                </button>
                <button
                  type="button"
                  className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                  onClick={() =>
                    openExternal(accountMenuState.links.settingsUrl)
                  }
                >
                  <Settings aria-hidden="true" size={15} strokeWidth={1.8} />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {labels.accountMenuAccountCenter}
                  </span>
                  <ExternalLink
                    aria-hidden="true"
                    size={14}
                    strokeWidth={1.8}
                  />
                </button>
                {accountMenuState.onSettings ? (
                  <button
                    type="button"
                    className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                    onClick={accountMenuState.onSettings}
                  >
                    <Settings aria-hidden="true" size={15} strokeWidth={1.8} />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {labels.accountMenuSettings}
                    </span>
                  </button>
                ) : null}
                {accountMenuState.onLogout ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="mx-2 my-1 h-px bg-[var(--border-1)]"
                    />
                    <button
                      type="button"
                      className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                      onClick={accountMenuState.onLogout}
                    >
                      <LogOut aria-hidden="true" size={15} strokeWidth={1.8} />
                      <span className="truncate">
                        {labels.accountMenuSignOut}
                      </span>
                    </button>
                  </>
                ) : null}
              </>
            ) : (
              <button
                type="button"
                className="nodrag flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] [-webkit-app-region:no-drag]"
                onClick={accountMenuState.onLogin}
              >
                <LogIn aria-hidden="true" size={15} strokeWidth={1.8} />
                <span className="truncate">{labels.accountMenuSignIn}</span>
              </button>
            )}
            {errorLabel ? (
              <span className="px-2 py-1 text-[11px] leading-4 text-[var(--text-danger)]">
                {errorLabel}
              </span>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
});

function agentGUIAccountUserLabel(
  accountMenuState: AgentGUIAccountMenuState,
  labels: Pick<AgentGUIViewLabels, "accountMenuTitle">
): string {
  const user = accountMenuState.user;
  return (
    user?.name?.trim() ||
    user?.email?.trim() ||
    user?.userId?.trim() ||
    labels.accountMenuTitle
  );
}

function agentGUIAccountInitials(label: string): string {
  const normalized = label.trim();
  if (!normalized) {
    return "T";
  }
  return normalized.slice(0, 2).toUpperCase();
}

interface AgentGUIConfigMenuProps {
  labels: AgentGUIViewLabels;
  previewMode: boolean;
  slashStatusLimits: readonly AgentComposerSlashStatusLimit[];
  slashStatusLimitsLoading: boolean;
  slashStatusUsageCapturedAtUnixMs: number | null;
  slashStatusUsageDidFail: boolean;
  slashStatusUsageAttempted: boolean;
  providerAuthAccountLabel?: string | null;
  onAgentConfigMenuOpen?: () => void;
  onAgentUsageRefresh?: () => void;
  onOpenAgentEnvSetup: () => void;
  onOpenAgentSettings: () => void;
}

function AgentGUIConfigMenu({
  labels,
  previewMode,
  slashStatusLimits,
  slashStatusLimitsLoading,
  slashStatusUsageCapturedAtUnixMs,
  slashStatusUsageDidFail,
  slashStatusUsageAttempted,
  providerAuthAccountLabel,
  onAgentConfigMenuOpen,
  onAgentUsageRefresh,
  onOpenAgentEnvSetup,
  onOpenAgentSettings
}: AgentGUIConfigMenuProps): React.JSX.Element {
  return (
    <Popover
      onOpenChange={(open) => {
        // Refresh the underlying probe on open, the same way the window-title
        // info tooltip does; otherwise a stale/empty fetch can sit here until
        // something unrelated refreshes it.
        if (open) {
          onAgentConfigMenuOpen?.();
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={labels.agentConfig}
          className={`${styles.providerRailConfigButton} nodrag tsh-desktop-no-drag`}
          title={labels.agentConfig}
          disabled={previewMode}
        >
          <SettingsLinedIcon aria-hidden="true" width={18} height={18} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="end"
        className="w-[300px] max-w-[calc(100vw-32px)] gap-3 p-1 text-xs"
        data-testid="agent-gui-config-menu"
      >
        <div className="flex min-w-0 flex-col gap-3">
          {providerAuthAccountLabel ? (
            <>
              <div className="flex min-w-0 flex-col gap-2 p-2">
                <span className="text-[13px] font-semibold leading-4">
                  {labels.slashStatusAccount}
                </span>
                <span className="text-[13px] leading-5 text-[var(--text-secondary)]">
                  {providerAuthAccountLabel}
                </span>
              </div>
              {slashStatusLimits.length > 0 ||
              slashStatusUsageAttempted ||
              slashStatusLimitsLoading ? (
                <div className="px-2">
                  <span className="block h-px bg-[var(--border-1)]" />
                </div>
              ) : null}
            </>
          ) : null}
          {slashStatusLimits.length > 0 ||
          slashStatusUsageAttempted ||
          slashStatusLimitsLoading ? (
            <>
              <div className="flex min-w-0 flex-col gap-2 p-2">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[13px] font-semibold leading-4">
                    {labels.slashStatusLimits}
                  </span>
                  <AgentProbeUsageFreshness
                    testId="agent-gui-config-usage-refresh"
                    capturedAtUnixMs={slashStatusUsageCapturedAtUnixMs}
                    isLoading={slashStatusLimitsLoading}
                    didFail={slashStatusUsageDidFail}
                    disabled={previewMode || !onAgentUsageRefresh}
                    onRefresh={() => onAgentUsageRefresh?.()}
                    labels={{
                      justUpdated: labels.slashStatusUsageJustUpdated,
                      minutesAgo: labels.slashStatusUsageMinutesAgo,
                      hoursAgo: labels.slashStatusUsageHoursAgo,
                      updating: labels.slashStatusUsageUpdating,
                      refreshFailed: labels.slashStatusUsageRefreshFailed,
                      refreshAria: labels.slashStatusUsageRefreshAria
                    }}
                  />
                </div>
                {slashStatusLimits.length > 0 ? (
                  slashStatusLimits.map((limit) => (
                    <AgentUsageMeter
                      key={limit.id}
                      label={limit.label}
                      value={`${limit.value}${limit.reset ? ` (${limit.reset})` : ""}`}
                      percent={
                        typeof limit.percentRemaining === "number" &&
                        Number.isFinite(limit.percentRemaining)
                          ? limit.percentRemaining
                          : null
                      }
                    />
                  ))
                ) : slashStatusLimitsLoading ? null : (
                  <span
                    className="text-[var(--text-tertiary)]"
                    data-testid="agent-gui-config-usage-unavailable"
                  >
                    {labels.slashStatusLimitsUnavailable}
                  </span>
                )}
              </div>
              <div className="px-2">
                <span className="block h-px bg-[var(--border-1)]" />
              </div>
            </>
          ) : null}
          <div className="flex min-w-0 flex-col gap-1">
            <button
              type="button"
              data-testid="agent-gui-config-settings"
              className="nodrag flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:text-[var(--text-tertiary)] [-webkit-app-region:no-drag]"
              disabled={previewMode}
              onClick={() => onOpenAgentSettings()}
            >
              <SettingsLinedIcon aria-hidden="true" width={16} height={16} />
              <span>{labels.agentSettingsMenu}</span>
            </button>
            <button
              type="button"
              data-testid="agent-gui-config-env-setup"
              className="nodrag flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:text-[var(--text-tertiary)] [-webkit-app-region:no-drag]"
              disabled={previewMode}
              onClick={() => onOpenAgentEnvSetup()}
            >
              <Wrench aria-hidden="true" size={16} strokeWidth={1.8} />
              <span>{labels.agentEnvSetup}</span>
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface AgentGUIConversationRailInput {
  conversationFilter: AgentGUINodeViewModel["conversationFilter"];
  conversationQuery: string;
  conversations: AgentGUINodeViewModel["conversations"];
  labels: AgentGUIViewLabels;
  previewMode: boolean;
  sectionAgentTargetFallbackId: string | null;
  userProjects: AgentGUINodeViewModel["userProjects"];
  workspaceId: string;
}

function useAgentGUIConversationRail({
  conversationFilter,
  conversationQuery,
  conversations,
  labels,
  previewMode,
  sectionAgentTargetFallbackId,
  userProjects,
  workspaceId
}: AgentGUIConversationRailInput): {
  loadMoreSectionConversations: (section: ConversationSection) => void;
  runtimeSectionsEnabled: boolean;
  runtimeRailSections: ConversationSection[] | null;
  runtimeRailSectionsPending: boolean;
  sectionPageStates: ReadonlyMap<string, ConversationRailSectionPageState>;
} {
  const agentActivityRuntime = useAgentActivityRuntime();
  const [runtimeRailSections, setRuntimeRailSections] = useState<
    ConversationSection[] | null
  >(null);
  const [runtimeRailSectionsPending, setRuntimeRailSectionsPending] =
    useState(false);
  const [sectionPageStates, setSectionPageStates] = useState<
    ReadonlyMap<string, ConversationRailSectionPageState>
  >(() => new Map());
  const conversationsRef = useRef(conversations);
  const pagingRequestSequenceRef = useRef(0);
  const pagingAbortControllersRef = useRef(new Map<string, AbortController>());
  const workspaceIdRef = useRef(workspaceId);
  const runtimeListSessionSections = agentActivityRuntime.listSessionSections;
  const runtimeListSessionSectionPage =
    agentActivityRuntime.listSessionSectionPage;
  const runtimeListPinnedSessionsPage =
    agentActivityRuntime.listPinnedSessionsPage;
  const runtimeSectionsEnabled =
    !previewMode &&
    Boolean(runtimeListSessionSections) &&
    Boolean(runtimeListSessionSectionPage);
  const sectionAgentTargetId =
    conversationFilter.kind === "agentTarget"
      ? conversationFilter.agentTargetId.trim()
      : (sectionAgentTargetFallbackId?.trim() ?? "");
  const userProjectPaths = useMemo(
    () =>
      userProjects
        .map((project) => project.path.trim())
        .filter((path) => path.length > 0),
    [userProjects]
  );
  const userProjectPathKey = useMemo(
    () => JSON.stringify(userProjectPaths),
    [userProjectPaths]
  );
  const sectionProjectionLabels = useMemo(
    () => ({
      sectionConversations: labels.sectionConversations,
      sectionPinned: labels.sectionPinned
    }),
    [labels.sectionConversations, labels.sectionPinned]
  );

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    const workspaceChanged = workspaceIdRef.current !== workspaceId;
    workspaceIdRef.current = workspaceId;
    pagingRequestSequenceRef.current += 1;
    for (const controller of pagingAbortControllersRef.current.values()) {
      controller.abort();
    }
    pagingAbortControllersRef.current.clear();
    if (workspaceChanged) {
      setRuntimeRailSections(null);
    }
    setSectionPageStates(new Map());
    return () => {
      pagingRequestSequenceRef.current += 1;
      for (const controller of pagingAbortControllersRef.current.values()) {
        controller.abort();
      }
      pagingAbortControllersRef.current.clear();
    };
  }, [conversationFilter, userProjectPathKey, workspaceId]);

  const conversationMembershipKey = useMemo(
    () =>
      conversations
        .map(
          (conversation) =>
            `${conversation.id}:${conversation.pinnedAtUnixMs ?? 0}`
        )
        .join("|"),
    [conversations]
  );

  useEffect(() => {
    if (!runtimeSectionsEnabled || !runtimeListSessionSections) {
      setRuntimeRailSectionsPending(false);
      return;
    }
    const requestSequence = pagingRequestSequenceRef.current;
    const abortController = new AbortController();
    setRuntimeRailSectionsPending(true);
    void runtimeListSessionSections({
      agentTargetId: sectionAgentTargetId || undefined,
      limitPerSection: AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE,
      signal: abortController.signal,
      workspaceId
    })
      .then((page) => {
        if (
          abortController.signal.aborted ||
          requestSequence !== pagingRequestSequenceRef.current
        ) {
          return;
        }
        const sections = projectRuntimeSectionsToConversationSections({
          conversationFilter,
          labels: sectionProjectionLabels,
          pinned: page.pinned,
          sections: page.sections,
          workspaceId: page.workspaceId
        });
        const sectionsWithSummaries = updateConversationSectionsFromSummaries(
          sections,
          conversationsRef.current,
          {
            sectionConversationsLabel: labels.sectionConversations,
            sectionPinnedLabel: labels.sectionPinned
          }
        );
        setRuntimeRailSections((current) =>
          stabilizeConversationSections(
            current,
            sectionsWithSummaries ?? sections
          )
        );
        setRuntimeRailSectionsPending(false);
        setSectionPageStates(() => {
          const next = new Map<string, ConversationRailSectionPageState>();
          if (page.pinned) {
            next.set("pinned", {
              hasMore: page.pinned.hasMore,
              isLoading: false,
              nextCursor: page.pinned.nextCursor ?? null
            });
          }
          for (const section of page.sections) {
            next.set(section.sectionKey, {
              hasMore: section.hasMore,
              isLoading: false,
              nextCursor: section.nextCursor ?? null
            });
          }
          return next;
        });
      })
      .catch(() => {
        if (
          abortController.signal.aborted ||
          requestSequence !== pagingRequestSequenceRef.current
        ) {
          return;
        }
        setRuntimeRailSections([]);
        setRuntimeRailSectionsPending(false);
      });
    return () => {
      abortController.abort();
    };
  }, [
    conversationFilter,
    conversationMembershipKey,
    labels.sectionConversations,
    runtimeListSessionSections,
    runtimeSectionsEnabled,
    sectionProjectionLabels,
    sectionAgentTargetId,
    userProjectPathKey,
    workspaceId
  ]);

  useEffect(() => {
    if (!runtimeSectionsEnabled) {
      return;
    }
    const filteredConversations = filterAgentGUIConversationSummaries(
      conversations,
      conversationFilter
    );
    setRuntimeRailSections((current) =>
      updateConversationSectionsFromSummaries(current, filteredConversations, {
        sectionConversationsLabel: labels.sectionConversations,
        sectionPinnedLabel: labels.sectionPinned
      })
    );
  }, [
    conversationFilter,
    conversations,
    labels.sectionConversations,
    labels.sectionPinned,
    runtimeSectionsEnabled
  ]);

  const loadMoreSectionConversations = useCallback(
    (section: ConversationSection) => {
      if (previewMode || conversationQuery.trim()) {
        return;
      }
      const currentPageState = sectionPageStates.get(section.id);
      if (currentPageState?.isLoading || currentPageState?.hasMore === false) {
        return;
      }
      if (section.kind === "pinned" && !runtimeListPinnedSessionsPage) {
        return;
      }
      if (section.kind !== "pinned" && !runtimeListSessionSectionPage) {
        return;
      }
      const fallbackCursor = conversationRailPageCursor(section.items);
      const cursor = currentPageState?.nextCursor ?? fallbackCursor;
      const requestSequence = pagingRequestSequenceRef.current;
      const abortController = new AbortController();
      pagingAbortControllersRef.current.set(section.id, abortController);
      setSectionPageStates((current) => {
        const next = new Map(current);
        next.set(section.id, {
          hasMore: currentPageState?.hasMore ?? true,
          isLoading: true,
          nextCursor: currentPageState?.nextCursor ?? null
        });
        return next;
      });
      if (section.kind === "pinned") {
        const listPinnedSessionsPage = runtimeListPinnedSessionsPage;
        if (!listPinnedSessionsPage) {
          return;
        }
        void listPinnedSessionsPage({
          agentTargetId: sectionAgentTargetId || undefined,
          cursor: cursor || undefined,
          limit: AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE,
          signal: abortController.signal,
          workspaceId
        })
          .then((page) => {
            if (
              abortController.signal.aborted ||
              requestSequence !== pagingRequestSequenceRef.current
            ) {
              return;
            }
            const pageConversations = buildAgentGUIConversationSummaries({
              conversationFilter,
              provider: AGENT_GUI_CONVERSATION_RAIL_PROJECTION_PROVIDER,
              snapshot: {
                composerOptionsByProvider: {},
                presences: [],
                sessionMessagesById: {},
                sessions: page.sessions,
                workspaceId
              },
              userProjects: []
            }).filter((conversation) => (conversation.pinnedAtUnixMs ?? 0) > 0);
            setRuntimeRailSections((current) => {
              if (!current) {
                return current;
              }
              return current.map((candidate) =>
                candidate.id === section.id
                  ? {
                      ...candidate,
                      items: mergeConversationRailPageItems(
                        candidate.items,
                        pageConversations
                      )
                    }
                  : candidate
              );
            });
            setSectionPageStates((current) => {
              const next = new Map(current);
              next.set(section.id, {
                hasMore: page.hasMore,
                isLoading: false,
                nextCursor: page.nextCursor ?? null
              });
              return next;
            });
          })
          .catch(() => {
            if (
              abortController.signal.aborted ||
              requestSequence !== pagingRequestSequenceRef.current
            ) {
              return;
            }
            setSectionPageStates((current) => {
              const next = new Map(current);
              const existing = next.get(section.id);
              next.set(section.id, {
                hasMore: existing?.hasMore ?? true,
                isLoading: false,
                nextCursor: existing?.nextCursor ?? null
              });
              return next;
            });
          })
          .finally(() => {
            if (
              pagingAbortControllersRef.current.get(section.id) ===
              abortController
            ) {
              pagingAbortControllersRef.current.delete(section.id);
            }
          });
        return;
      }
      const listSessionSectionPage = runtimeListSessionSectionPage;
      if (!listSessionSectionPage) {
        return;
      }
      void listSessionSectionPage({
        agentTargetId: sectionAgentTargetId || undefined,
        cursor: cursor || undefined,
        limit: AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE,
        sectionKey: section.id,
        signal: abortController.signal,
        workspaceId
      })
        .then((pageSection) => {
          if (
            abortController.signal.aborted ||
            requestSequence !== pagingRequestSequenceRef.current
          ) {
            return;
          }
          const pageConversations = buildAgentGUIConversationSummaries({
            conversationFilter,
            provider: AGENT_GUI_CONVERSATION_RAIL_PROJECTION_PROVIDER,
            snapshot: {
              composerOptionsByProvider: {},
              presences: [],
              sessionMessagesById: {},
              sessions: pageSection.sessions,
              workspaceId
            },
            userProjects: []
          }).map((conversation) => ({
            ...conversation,
            project: section.kind === "project" ? section.project : null
          }));
          setRuntimeRailSections((current) => {
            if (!current) {
              return current;
            }
            return current.map((candidate) =>
              candidate.id === section.id
                ? {
                    ...candidate,
                    items: mergeConversationRailPageItems(
                      candidate.items,
                      pageConversations
                    )
                  }
                : candidate
            );
          });
          setSectionPageStates((current) => {
            const next = new Map(current);
            next.set(section.id, {
              hasMore: pageSection.hasMore,
              isLoading: false,
              nextCursor: pageSection.nextCursor ?? null
            });
            return next;
          });
        })
        .catch(() => {
          if (
            abortController.signal.aborted ||
            requestSequence !== pagingRequestSequenceRef.current
          ) {
            return;
          }
          setSectionPageStates((current) => {
            const next = new Map(current);
            const existing = next.get(section.id);
            next.set(section.id, {
              hasMore: existing?.hasMore ?? true,
              isLoading: false,
              nextCursor: existing?.nextCursor ?? null
            });
            return next;
          });
        })
        .finally(() => {
          if (
            pagingAbortControllersRef.current.get(section.id) ===
            abortController
          ) {
            pagingAbortControllersRef.current.delete(section.id);
          }
        });
    },
    [
      conversationFilter,
      conversationQuery,
      previewMode,
      runtimeListPinnedSessionsPage,
      runtimeListSessionSectionPage,
      sectionAgentTargetId,
      sectionPageStates,
      workspaceId
    ]
  );

  return {
    loadMoreSectionConversations,
    runtimeSectionsEnabled,
    runtimeRailSections,
    runtimeRailSectionsPending,
    sectionPageStates
  };
}

const AgentGUIConversationRailPane = memo(
  function AgentGUIConversationRailPane({
    conversations,
    footer,
    workspaceId,
    userProjects,
    activeConversationId,
    pendingDeleteConversationId,
    isLoadingConversations,
    isDeletingConversation,
    isDeletingProjectConversations,
    labels,
    workspaceUserProjectI18n,
    uiLanguage,
    previewMode,
    createConversationDisabled,
    openclawGateway,
    isCollapsed,
    conversationFilter,
    sectionAgentTargetFallbackId,
    onCreateConversation,
    onRetryOpenclawGateway,
    onSelectConversation,
    onToggleConversationPinned,
    onMarkConversationUnread,
    onOpenProjectFiles,
    onOpenConversationWindow,
    selectProjectDirectory,
    onRemoveProject,
    onConfirmDeleteProjectConversations,
    onConfirmDeleteConversations,
    onRequestDeleteConversation,
    onRequestRenameConversation,
    onCancelDeleteConversation,
    onConfirmDeleteConversation
  }: AgentGUIConversationRailPaneProps): React.JSX.Element {
    "use memo";
    const [conversationQuery, setConversationQuery] = useState("");
    const [collapsedProjectSectionIds, setCollapsedProjectSectionIds] =
      useState<ReadonlySet<string>>(() => new Set());
    const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now());
    const [pendingProjectAction, setPendingProjectAction] =
      useState<AgentGUIProjectActionDialog | null>(null);
    const railElementRef = useRef<HTMLElement | null>(null);
    const conversationListRef = useRef<HTMLDivElement | null>(null);
    const conversationItemElementsRef = useRef(
      new Map<string, HTMLDivElement>()
    );
    const activeConversationScrollCompletedRef = useRef<string | null>(null);
    const previousActiveConversationIdRef = useRef<string | null>(null);
    const groupedConversationsRef = useRef<ConversationSection[] | null>(null);
    const {
      loadMoreSectionConversations,
      runtimeSectionsEnabled,
      runtimeRailSections,
      runtimeRailSectionsPending,
      sectionPageStates
    } = useAgentGUIConversationRail({
      conversationFilter,
      conversationQuery,
      conversations,
      labels,
      previewMode,
      sectionAgentTargetFallbackId,
      userProjects,
      workspaceId
    });

    useEffect(() => {
      const timer = window.setInterval(() => {
        setCurrentTimeMs(Date.now());
      }, 60_000);
      return () => {
        window.clearInterval(timer);
      };
    }, []);

    const displayConversations = useMemo(
      () =>
        runtimeSectionsEnabled
          ? (runtimeRailSections?.flatMap((section) => section.items) ?? [])
          : runtimeRailSections
            ? runtimeRailSections.flatMap((section) => section.items)
            : conversations,
      [conversations, runtimeRailSections, runtimeSectionsEnabled]
    );

    const filteredConversationResult = useMemo(() => {
      const startedAtMs = agentGuiPerfNowMs();
      const query = conversationQuery.trim().toLowerCase();
      const items = !query
        ? displayConversations
        : displayConversations.filter((candidate) =>
            conversationPlainTitle(candidate, labels, uiLanguage)
              .toLowerCase()
              .includes(query)
          );
      return {
        items,
        filterMs: roundAgentGuiPerfMs(agentGuiPerfNowMs() - startedAtMs)
      };
    }, [conversationQuery, displayConversations, labels, uiLanguage]);
    const filteredConversations = filteredConversationResult.items;
    const groupedConversationResult = useMemo(() => {
      const startedAtMs = agentGuiPerfNowMs();
      const query = conversationQuery.trim();
      const rawGroups =
        runtimeSectionsEnabled || runtimeRailSections
          ? runtimeRailSections
            ? !query
              ? runtimeRailSections
              : filterConversationSectionsBySearchMatches(
                  runtimeRailSections,
                  filteredConversations
                )
            : []
          : groupConversations(filteredConversations, labels, userProjects, {
              includeEmptyConversations: !query
            });
      const groups = stabilizeConversationSections(
        groupedConversationsRef.current,
        rawGroups
      );
      groupedConversationsRef.current = groups;
      return {
        groups,
        groupMs: roundAgentGuiPerfMs(agentGuiPerfNowMs() - startedAtMs)
      };
    }, [
      conversationQuery,
      filteredConversations,
      labels,
      runtimeRailSections,
      runtimeSectionsEnabled,
      userProjects
    ]);
    const groupedConversations = groupedConversationResult.groups;
    const toggleProjectSectionCollapsed = useCallback((sectionId: string) => {
      setCollapsedProjectSectionIds((current) => {
        const next = new Set(current);
        if (next.has(sectionId)) {
          next.delete(sectionId);
        } else {
          next.add(sectionId);
        }
        return next;
      });
    }, []);
    const groupedConversationIdentityKey = useMemo(
      () =>
        groupedConversations
          .map(
            (section) =>
              `${section.id}:${section.items.map((item) => item.id).join(",")}`
          )
          .join("|"),
      [groupedConversations]
    );
    const projectConversationCountsByPath = useMemo(() => {
      const counts = new Map<string, number>();
      for (const conversation of displayConversations) {
        const normalizedPath = normalizeConversationRailProjectPath(
          conversation.project?.path
        );
        if (!normalizedPath) {
          continue;
        }
        counts.set(normalizedPath, (counts.get(normalizedPath) ?? 0) + 1);
      }
      return counts;
    }, [displayConversations]);
    const isRuntimeRailLoading =
      runtimeSectionsEnabled &&
      (runtimeRailSections === null || runtimeRailSectionsPending);
    const isConversationRailListLoading =
      isRuntimeRailLoading ||
      (isLoadingConversations && conversations.length === 0);
    const shouldShowConversationSkeleton = useDelayedBoolean(
      isConversationRailListLoading,
      AGENT_GUI_CONVERSATION_RAIL_LOADING_SKELETON_DELAY_MS
    );
    const shouldShowConversationEmptyState =
      !isConversationRailListLoading && groupedConversations.length === 0;
    const registerConversationItemElement = useCallback(
      (itemId: string, element: HTMLDivElement | null) => {
        if (element) {
          conversationItemElementsRef.current.set(itemId, element);
        } else {
          conversationItemElementsRef.current.delete(itemId);
        }
      },
      []
    );

    useLayoutEffect(() => {
      const activeId = activeConversationId?.trim() ?? "";
      if (!activeId) {
        previousActiveConversationIdRef.current = null;
        activeConversationScrollCompletedRef.current = null;
        return;
      }
      if (previousActiveConversationIdRef.current !== activeId) {
        previousActiveConversationIdRef.current = activeId;
        activeConversationScrollCompletedRef.current = null;
      }
      if (activeConversationScrollCompletedRef.current === activeId) {
        return;
      }
      const activeElement = conversationItemElementsRef.current.get(activeId);
      if (!activeElement) {
        return;
      }
      activeElement.scrollIntoView({ block: "nearest" });
      activeConversationScrollCompletedRef.current = activeId;
    }, [activeConversationId, groupedConversationIdentityKey]);

    return (
      <aside
        ref={railElementRef}
        className={styles.rail}
        aria-hidden={isCollapsed ? "true" : undefined}
      >
        <div className={styles.railToolbar}>
          <TaskSearchField
            value={conversationQuery}
            placeholder={labels.searchPlaceholder}
            onChange={setConversationQuery}
          />
          <Button
            type="button"
            variant="secondary"
            size="dialog"
            className={styles.newConversationIconButton}
            title={labels.newConversation}
            disabled={createConversationDisabled}
            onClick={() => onCreateConversation()}
          >
            <CreateChatIcon aria-hidden="true" />
            <span>{labels.newConversation}</span>
          </Button>
        </div>
        {openclawGateway?.status === "failed" ? (
          <div className={styles.gatewayStatus} data-state="failed">
            <span>{openclawGateway.error || labels.openclawGatewayFailed}</span>
            <button
              type="button"
              className={styles.gatewayRetryButton}
              onClick={onRetryOpenclawGateway}
            >
              {labels.openclawGatewayRetry}
            </button>
          </div>
        ) : null}
        <ScrollArea
          scrollbarMode="native"
          className="min-h-0 flex-1 [&_[data-orientation=vertical][data-slot=scroll-area-scrollbar]]:opacity-100"
          viewportRef={conversationListRef}
          viewportClassName={styles.conversationList}
        >
          {shouldShowConversationSkeleton ? (
            <AgentConversationListSkeleton
              label={labels.loadingConversations}
            />
          ) : shouldShowConversationEmptyState ? (
            <div className={styles.emptyState}>
              <span>
                {conversations.length === 0
                  ? labels.noConversations
                  : conversationQuery.trim()
                    ? labels.searchNoConversations
                    : labels.conversationUnavailable}
              </span>
            </div>
          ) : (
            groupedConversations.map((section, sectionIndex) => {
              const projectPath =
                section.kind === "project" ? (section.project?.path ?? "") : "";
              const normalizedProjectPath =
                normalizeConversationRailProjectPath(projectPath);
              const projectLabel =
                section.kind === "project" ? section.label : "";
              const isProjectSection = section.kind === "project";
              const showProjectRailHeader =
                !conversationQuery.trim() &&
                section.kind !== "pinned" &&
                (sectionIndex === 0 ||
                  groupedConversations[sectionIndex - 1]?.kind === "pinned");
              const isSectionCollapsed =
                isProjectSection && collapsedProjectSectionIds.has(section.id);
              const projectConversationCount = normalizedProjectPath
                ? (projectConversationCountsByPath.get(normalizedProjectPath) ??
                  0)
                : 0;
              const sectionPageState = sectionPageStates.get(section.id);
              const sectionHasMore =
                !conversationQuery.trim() && sectionPageState?.hasMore === true;
              return (
                <Fragment key={section.id}>
                  {showProjectRailHeader ? (
                    <AgentGUIProjectRailHeader
                      labels={labels}
                      selectProjectDirectory={selectProjectDirectory}
                      workspaceUserProjectI18n={workspaceUserProjectI18n}
                    />
                  ) : null}
                  <AgentGUIConversationRailSection
                    activeConversationId={activeConversationId}
                    createConversationDisabled={createConversationDisabled}
                    currentTimeMs={currentTimeMs}
                    isDeletingConversation={isDeletingConversation}
                    isLoadingMoreConversations={
                      sectionPageState?.isLoading ?? false
                    }
                    isSectionCollapsed={isSectionCollapsed}
                    labels={labels}
                    pendingDeleteConversationId={pendingDeleteConversationId}
                    previewMode={previewMode}
                    projectConversationCount={projectConversationCount}
                    projectLabel={projectLabel}
                    projectPath={projectPath}
                    registerItemElement={registerConversationItemElement}
                    section={section}
                    sectionHasMore={sectionHasMore}
                    uiLanguage={uiLanguage}
                    workspaceId={workspaceId}
                    onCancelDeleteConversation={onCancelDeleteConversation}
                    onConfirmDeleteConversation={onConfirmDeleteConversation}
                    onCreateConversation={onCreateConversation}
                    onLoadMoreConversations={loadMoreSectionConversations}
                    onRequestDeleteConversation={onRequestDeleteConversation}
                    onRequestRenameConversation={onRequestRenameConversation}
                    onSelectConversation={onSelectConversation}
                    setPendingProjectAction={setPendingProjectAction}
                    onToggleConversationPinned={onToggleConversationPinned}
                    onMarkConversationUnread={onMarkConversationUnread}
                    onOpenProjectFiles={onOpenProjectFiles}
                    onOpenConversationWindow={onOpenConversationWindow}
                    onToggleProjectSectionCollapsed={
                      toggleProjectSectionCollapsed
                    }
                  />
                </Fragment>
              );
            })
          )}
        </ScrollArea>
        {footer ? <div className="shrink-0 pb-2">{footer}</div> : null}
        <ConfirmationDialog
          cancelLabel={labels.cancel}
          className={AGENT_GUI_CONFIRMATION_DIALOG_CLASS_NAME}
          confirmBusy={
            (pendingProjectAction?.kind === "batch-delete" ||
              pendingProjectAction?.kind === "batch-delete-conversations") &&
            isDeletingProjectConversations
          }
          confirmLabel={
            pendingProjectAction?.kind === "batch-delete"
              ? labels.batchDeleteProjectSessionsConfirm
              : pendingProjectAction?.kind === "batch-delete-conversations"
                ? labels.batchDeleteConversationsConfirm
                : labels.removeProject
          }
          description={
            pendingProjectAction?.kind === "batch-delete"
              ? labels.batchDeleteProjectSessionsBody(
                  pendingProjectAction.conversationCount,
                  pendingProjectAction.label
                )
              : pendingProjectAction?.kind === "batch-delete-conversations"
                ? labels.batchDeleteConversationsBody(
                    pendingProjectAction.conversationCount
                  )
                : pendingProjectAction
                  ? labels.removeProjectConfirmDescription(
                      pendingProjectAction.label
                    )
                  : undefined
          }
          onCancel={() => setPendingProjectAction(null)}
          onConfirm={() => {
            const action = pendingProjectAction;
            setPendingProjectAction(null);
            if (!action) {
              return;
            }
            if (action.kind === "batch-delete") {
              onConfirmDeleteProjectConversations(action.path);
              return;
            }
            if (action.kind === "batch-delete-conversations") {
              onConfirmDeleteConversations(action.sessionIds);
              return;
            }
            onRemoveProject(action.path);
          }}
          onOpenChange={(open) => {
            if (!open) {
              setPendingProjectAction(null);
            }
          }}
          open={pendingProjectAction !== null}
          overlayClassName={AGENT_GUI_CONFIRMATION_DIALOG_OVERLAY_CLASS_NAME}
          title={
            pendingProjectAction?.kind === "batch-delete"
              ? labels.batchDeleteProjectSessionsTitle
              : pendingProjectAction?.kind === "batch-delete-conversations"
                ? labels.batchDeleteConversationsTitle
                : labels.removeProjectConfirmTitle
          }
          tone="destructive"
        />
      </aside>
    );
  }
);

interface AgentGUIConversationRailSectionProps {
  section: ConversationSection;
  projectPath: string;
  projectLabel: string;
  projectConversationCount: number;
  isSectionCollapsed: boolean;
  activeConversationId: string | null;
  pendingDeleteConversationId: string | null;
  previewMode: boolean;
  isDeletingConversation: boolean;
  isLoadingMoreConversations: boolean;
  sectionHasMore: boolean;
  createConversationDisabled: boolean;
  currentTimeMs: number;
  labels: AgentGUIViewLabels;
  uiLanguage: UiLanguage;
  workspaceId: string;
  registerItemElement: (itemId: string, element: HTMLDivElement | null) => void;
  onCreateConversation: (options?: {
    projectPath?: string | null;
    source?: string;
  }) => void;
  onToggleProjectSectionCollapsed: (sectionId: string) => void;
  setPendingProjectAction: (action: AgentGUIProjectActionDialog | null) => void;
  onSelectConversation: (agentSessionId: string) => void;
  onLoadMoreConversations: (section: ConversationSection) => void;
  onToggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
  onMarkConversationUnread: (agentSessionId: string) => void;
  onOpenProjectFiles?: ((action: WorkspaceLinkAction) => void) | null;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  onRequestDeleteConversation: (agentSessionId: string) => void;
  onRequestRenameConversation: (agentSessionId: string) => void;
  onCancelDeleteConversation: () => void;
  onConfirmDeleteConversation: () => void;
}

const AgentGUIConversationRailSection = memo(
  function AgentGUIConversationRailSection({
    section,
    projectPath,
    projectLabel,
    projectConversationCount,
    isSectionCollapsed,
    activeConversationId,
    pendingDeleteConversationId,
    previewMode,
    isDeletingConversation,
    isLoadingMoreConversations,
    sectionHasMore,
    createConversationDisabled,
    currentTimeMs,
    labels,
    uiLanguage,
    workspaceId,
    registerItemElement,
    onCreateConversation,
    onToggleProjectSectionCollapsed,
    onSelectConversation,
    onLoadMoreConversations,
    setPendingProjectAction,
    onToggleConversationPinned,
    onMarkConversationUnread,
    onOpenProjectFiles,
    onOpenConversationWindow,
    onRequestDeleteConversation,
    onRequestRenameConversation,
    onCancelDeleteConversation,
    onConfirmDeleteConversation
  }: AgentGUIConversationRailSectionProps): React.JSX.Element {
    "use memo";
    const isProjectSection = section.kind === "project";
    const [visibleItemLimit, setVisibleItemLimit] = useState(
      AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE
    );
    const visibleItemCount = isSectionCollapsed
      ? 0
      : Math.min(visibleItemLimit, section.items.length);
    const visibleItems = useMemo(() => {
      if (isSectionCollapsed) {
        return [];
      }
      const baseItems = section.items.slice(0, visibleItemCount);
      const activeId = activeConversationId?.trim() ?? "";
      if (!activeId || baseItems.some((item) => item.id === activeId)) {
        return baseItems;
      }
      const activeItem = section.items.find((item) => item.id === activeId);
      return activeItem ? [...baseItems, activeItem] : baseItems;
    }, [
      activeConversationId,
      isSectionCollapsed,
      section.items,
      visibleItemCount
    ]);
    const canShowMore =
      !isSectionCollapsed &&
      (visibleItemCount < section.items.length || sectionHasMore);
    const canShowLess =
      !isSectionCollapsed &&
      visibleItemCount > AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE;
    const showMoreConversations = useCallback(() => {
      if (visibleItemCount >= section.items.length && sectionHasMore) {
        onLoadMoreConversations(section);
        setVisibleItemLimit(
          (current) => current + AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE
        );
        return;
      }
      setVisibleItemLimit((current) =>
        Math.min(
          section.items.length,
          current + AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE
        )
      );
    }, [
      onLoadMoreConversations,
      section,
      section.items.length,
      sectionHasMore,
      visibleItemCount
    ]);
    const showLessConversations = useCallback(() => {
      setVisibleItemLimit(AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE);
    }, []);

    const canCreateConversationFromSection =
      section.kind === "conversations" || Boolean(projectPath);
    const createConversationLabel = projectPath
      ? labels.projectSectionEdit
      : labels.newConversation;
    const handleCreateConversation = useCallback(() => {
      if (projectPath) {
        onCreateConversation({ projectPath, source: "project_section" });
        return;
      }
      onCreateConversation({
        projectPath: null,
        source: "unscoped_section"
      });
    }, [onCreateConversation, projectPath]);

    return (
      <section
        className={styles.conversationSection}
        data-collapsed={isSectionCollapsed}
        data-kind={section.kind}
      >
        <div className={styles.conversationSectionHeader}>
          {isProjectSection ? (
            <button
              type="button"
              className={styles.conversationSectionToggle}
              aria-expanded={!isSectionCollapsed}
              onClick={() => onToggleProjectSectionCollapsed(section.id)}
            >
              <ChevronRight
                aria-hidden="true"
                className={styles.conversationSectionChevron}
              />
              <span className={styles.conversationSectionLabel}>
                {isSectionCollapsed ? (
                  <FolderIcon
                    aria-hidden="true"
                    className={styles.conversationSectionLabelIcon}
                  />
                ) : (
                  <FolderOpenLinedIcon
                    aria-hidden="true"
                    className={styles.conversationSectionLabelIcon}
                  />
                )}
                <span>{section.label}</span>
              </span>
            </button>
          ) : (
            <div className={styles.conversationSectionToggle}>
              <span className={styles.conversationSectionLabel}>
                <span>{section.label}</span>
              </span>
            </div>
          )}
          {canCreateConversationFromSection ? (
            <div className={styles.conversationSectionActions}>
              {previewMode ? (
                <span className={styles.conversationSectionActionTooltipWrap}>
                  <BareIconButton
                    className={styles.conversationSectionMoreButton}
                    aria-label={createConversationLabel}
                    size="sm"
                    disabled={createConversationDisabled}
                    onClick={handleCreateConversation}
                  >
                    <CreateChatIcon aria-hidden="true" />
                  </BareIconButton>
                </span>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={styles.conversationSectionActionTooltipWrap}
                    >
                      <BareIconButton
                        className={styles.conversationSectionMoreButton}
                        aria-label={createConversationLabel}
                        size="sm"
                        disabled={createConversationDisabled}
                        onClick={handleCreateConversation}
                      >
                        <CreateChatIcon aria-hidden="true" />
                      </BareIconButton>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    sideOffset={6}
                    className={styles.conversationSectionActionTooltip}
                  >
                    {createConversationLabel}
                  </TooltipContent>
                </Tooltip>
              )}
              {projectPath ? (
                <DropdownMenu>
                  {previewMode ? (
                    <DropdownMenuTrigger asChild>
                      <span
                        className={styles.conversationSectionActionTooltipWrap}
                      >
                        <BareIconButton
                          className={styles.conversationSectionMoreButton}
                          aria-label={labels.projectSectionMoreActions}
                          size="sm"
                        >
                          <MoreHorizontalIcon aria-hidden="true" />
                        </BareIconButton>
                      </span>
                    </DropdownMenuTrigger>
                  ) : (
                    <Tooltip>
                      <DropdownMenuTrigger asChild>
                        <TooltipTrigger asChild>
                          <span
                            className={
                              styles.conversationSectionActionTooltipWrap
                            }
                          >
                            <BareIconButton
                              className={styles.conversationSectionMoreButton}
                              aria-label={labels.projectSectionMoreActions}
                              size="sm"
                            >
                              <MoreHorizontalIcon aria-hidden="true" />
                            </BareIconButton>
                          </span>
                        </TooltipTrigger>
                      </DropdownMenuTrigger>
                      <TooltipContent
                        side="right"
                        sideOffset={6}
                        className={styles.conversationSectionActionTooltip}
                      >
                        {labels.projectSectionMoreActions}
                      </TooltipContent>
                    </Tooltip>
                  )}
                  <DropdownMenuContent
                    align="end"
                    className={`${styles.composerMenuContent} nodrag [-webkit-app-region:no-drag]`}
                    sideOffset={6}
                  >
                    <DropdownMenuItem
                      className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
                      disabled={!onOpenProjectFiles}
                      onSelect={() => {
                        onOpenProjectFiles?.({
                          directoryPath: projectPath,
                          mode: "open-directory",
                          path: projectPath,
                          source: "agent-project-menu",
                          type: "open-workspace-file",
                          workspaceRoot: projectPath
                        });
                      }}
                    >
                      <span>{labels.projectSectionViewFiles}</span>
                    </DropdownMenuItem>
                    {projectConversationCount > 0 ? (
                      <DropdownMenuItem
                        className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
                        onSelect={() => {
                          const label = projectLabel || projectPath;
                          setPendingProjectAction({
                            kind: "batch-delete",
                            conversationCount: projectConversationCount,
                            label,
                            path: projectPath
                          });
                        }}
                      >
                        <span>{labels.batchDeleteProjectSessions}</span>
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem
                      className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
                      onSelect={() => {
                        const label = projectLabel || projectPath;
                        setPendingProjectAction({
                          kind: "remove",
                          label,
                          path: projectPath
                        });
                      }}
                    >
                      <span>{labels.removeProject}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {!projectPath &&
              section.kind === "conversations" &&
              section.items.length > 0 ? (
                <DropdownMenu>
                  {previewMode ? (
                    <DropdownMenuTrigger asChild>
                      <span
                        className={styles.conversationSectionActionTooltipWrap}
                      >
                        <BareIconButton
                          className={styles.conversationSectionMoreButton}
                          aria-label={labels.conversationsSectionMoreActions}
                          size="sm"
                        >
                          <MoreHorizontalIcon aria-hidden="true" />
                        </BareIconButton>
                      </span>
                    </DropdownMenuTrigger>
                  ) : (
                    <Tooltip>
                      <DropdownMenuTrigger asChild>
                        <TooltipTrigger asChild>
                          <span
                            className={
                              styles.conversationSectionActionTooltipWrap
                            }
                          >
                            <BareIconButton
                              className={styles.conversationSectionMoreButton}
                              aria-label={
                                labels.conversationsSectionMoreActions
                              }
                              size="sm"
                            >
                              <MoreHorizontalIcon aria-hidden="true" />
                            </BareIconButton>
                          </span>
                        </TooltipTrigger>
                      </DropdownMenuTrigger>
                      <TooltipContent
                        side="right"
                        sideOffset={6}
                        className={styles.conversationSectionActionTooltip}
                      >
                        {labels.conversationsSectionMoreActions}
                      </TooltipContent>
                    </Tooltip>
                  )}
                  <DropdownMenuContent
                    align="end"
                    className={`${styles.composerMenuContent} nodrag [-webkit-app-region:no-drag]`}
                    sideOffset={6}
                  >
                    <DropdownMenuItem
                      className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
                      onSelect={() => {
                        setPendingProjectAction({
                          kind: "batch-delete-conversations",
                          conversationCount: section.items.length,
                          label: section.label,
                          sessionIds: section.items.map((item) => item.id)
                        });
                      }}
                    >
                      <span>{labels.batchDeleteConversations}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          ) : null}
        </div>
        <div
          className={styles.conversationSectionItems}
          aria-hidden={isSectionCollapsed ? "true" : undefined}
        >
          <div className={styles.conversationSectionItemsInner}>
            {!isSectionCollapsed && section.items.length === 0 ? (
              <div className={styles.conversationSectionEmpty}>
                {labels.emptyProjectConversations}
              </div>
            ) : null}
            {visibleItems.map((item) => (
              <AgentGUIConversationRailItem
                key={item.id}
                active={item.id === activeConversationId}
                currentTimeMs={currentTimeMs}
                isDeletingConversation={isDeletingConversation}
                isPendingDeleteConversation={
                  pendingDeleteConversationId === item.id
                }
                item={item}
                labels={labels}
                previewMode={previewMode}
                registerItemElement={registerItemElement}
                uiLanguage={uiLanguage}
                workspaceId={workspaceId}
                onCancelDeleteConversation={onCancelDeleteConversation}
                onConfirmDeleteConversation={onConfirmDeleteConversation}
                onRequestDeleteConversation={onRequestDeleteConversation}
                onRequestRenameConversation={onRequestRenameConversation}
                onSelectConversation={onSelectConversation}
                onToggleConversationPinned={onToggleConversationPinned}
                onMarkConversationUnread={onMarkConversationUnread}
                onOpenConversationWindow={onOpenConversationWindow}
              />
            ))}
            {canShowMore || canShowLess ? (
              <div className={styles.conversationSectionPagination}>
                {canShowMore ? (
                  <button
                    type="button"
                    className={styles.conversationSectionPaginationButton}
                    disabled={isLoadingMoreConversations}
                    onClick={showMoreConversations}
                  >
                    {labels.showMoreConversations}
                  </button>
                ) : null}
                {canShowLess ? (
                  <button
                    type="button"
                    className={styles.conversationSectionPaginationButton}
                    onClick={showLessConversations}
                  >
                    {labels.showLessConversations}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </section>
    );
  }
);

interface AgentGUIConversationRailItemProps {
  item: AgentGUINodeViewModel["conversations"][number];
  active: boolean;
  isPendingDeleteConversation: boolean;
  isDeletingConversation: boolean;
  currentTimeMs: number;
  labels: AgentGUIViewLabels;
  previewMode: boolean;
  uiLanguage: UiLanguage;
  workspaceId: string;
  registerItemElement: (itemId: string, element: HTMLDivElement | null) => void;
  onSelectConversation: (agentSessionId: string) => void;
  onToggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
  onMarkConversationUnread: (agentSessionId: string) => void;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  onRequestDeleteConversation: (agentSessionId: string) => void;
  onRequestRenameConversation: (agentSessionId: string) => void;
  onCancelDeleteConversation: () => void;
  onConfirmDeleteConversation: () => void;
}

const AgentGUIConversationRailItem = memo(
  function AgentGUIConversationRailItem({
    item,
    active,
    isPendingDeleteConversation,
    isDeletingConversation,
    currentTimeMs,
    labels,
    previewMode,
    uiLanguage,
    workspaceId,
    registerItemElement,
    onSelectConversation,
    onToggleConversationPinned,
    onMarkConversationUnread,
    onOpenConversationWindow,
    onRequestDeleteConversation,
    onRequestRenameConversation,
    onCancelDeleteConversation,
    onConfirmDeleteConversation
  }: AgentGUIConversationRailItemProps): React.JSX.Element {
    "use memo";
    const pinned = (item.pinnedAtUnixMs ?? 0) > 0;
    const providerIconUrl = agentGUIConversationProviderIconUrl(item.provider);
    const setItemElement = useCallback(
      (element: HTMLDivElement | null) => {
        registerItemElement(item.id, element);
      },
      [item.id, registerItemElement]
    );
    const [contextMenuResetKey, setContextMenuResetKey] = useState(0);
    const contextMenuRenameRequestedRef = useRef(false);
    const contextMenuOpenConversationWindowRequestedRef = useRef(false);
    const contextMenuCopySessionLinkRequestedRef = useRef(false);
    const agentHostApi = useOptionalAgentHostApi();
    const handleMouseLeave = useCallback(() => {
      if (isPendingDeleteConversation) {
        onCancelDeleteConversation();
      }
    }, [isPendingDeleteConversation, onCancelDeleteConversation]);
    const handleSelect = useCallback(() => {
      onSelectConversation(item.id);
    }, [item.id, onSelectConversation]);
    const handleTogglePinned = useCallback(() => {
      onToggleConversationPinned(item.id, !pinned);
    }, [item.id, onToggleConversationPinned, pinned]);
    const canMarkUnread = Boolean(
      !previewMode &&
      !item.hasUnreadCompletion &&
      item.isImported !== true &&
      (item.unreadCompletionKey ||
        item.status === "completed" ||
        item.status === "ready")
    );
    const handleMarkUnread = useCallback(() => {
      if (!canMarkUnread) {
        return;
      }
      onMarkConversationUnread(item.id);
    }, [canMarkUnread, item.id, onMarkConversationUnread]);
    const handleOpenConversationWindow = useCallback(() => {
      onOpenConversationWindow?.(item.id);
    }, [item.id, onOpenConversationWindow]);
    const handleRequestDelete = useCallback(() => {
      onRequestDeleteConversation(item.id);
    }, [item.id, onRequestDeleteConversation]);
    const handleRequestRename = useCallback(() => {
      onRequestRenameConversation(item.id);
    }, [item.id, onRequestRenameConversation]);
    const handleContextMenuRename = useCallback(() => {
      if (contextMenuRenameRequestedRef.current) {
        return;
      }
      contextMenuRenameRequestedRef.current = true;
      setContextMenuResetKey((key) => key + 1);
      window.setTimeout(() => {
        handleRequestRename();
        contextMenuRenameRequestedRef.current = false;
      }, 0);
    }, [handleRequestRename]);
    const handleContextMenuOpenConversationWindow = useCallback(() => {
      if (contextMenuOpenConversationWindowRequestedRef.current) {
        return;
      }
      contextMenuOpenConversationWindowRequestedRef.current = true;
      setContextMenuResetKey((key) => key + 1);
      window.setTimeout(() => {
        handleOpenConversationWindow();
        contextMenuOpenConversationWindowRequestedRef.current = false;
      }, 0);
    }, [handleOpenConversationWindow]);
    const handleContextMenuCopySessionLink = useCallback(() => {
      if (contextMenuCopySessionLinkRequestedRef.current) {
        return;
      }
      contextMenuCopySessionLinkRequestedRef.current = true;
      setContextMenuResetKey((key) => key + 1);
      window.setTimeout(() => {
        if (!agentHostApi?.clipboard?.writeText) {
          contextMenuCopySessionLinkRequestedRef.current = false;
          return;
        }
        const title = conversationPlainTitle(item, labels, uiLanguage);
        const markdown = createAgentSessionMarkdownLink({
          agentSessionId: item.id,
          agentTargetId: item.agentTargetId,
          label: title,
          workspaceId,
          withAtPrefix: false
        });
        void agentHostApi.clipboard
          .writeText(markdown)
          .catch(() => undefined)
          .finally(() => {
            contextMenuCopySessionLinkRequestedRef.current = false;
          });
      }, 0);
    }, [agentHostApi, item, labels, uiLanguage, workspaceId]);
    const row = (
      <div
        ref={setItemElement}
        className={styles.conversationItem}
        data-active={active}
        data-pinned={pinned}
        data-pending-delete={isPendingDeleteConversation}
        data-testid={`agent-gui-conversation-item-${item.id}`}
        onMouseLeave={handleMouseLeave}
      >
        <button
          type="button"
          className={styles.conversationSelect}
          onClick={handleSelect}
          onDoubleClick={(event) => {
            event.preventDefault();
            handleRequestRename();
          }}
        >
          <span className={styles.conversationTitleRow}>
            {providerIconUrl ? (
              <span
                aria-hidden="true"
                className={styles.conversationProviderIcon}
                style={
                  {
                    "--agent-gui-conversation-provider-icon-url": `url("${providerIconUrl}")`
                  } as CSSProperties
                }
              />
            ) : null}
            <span className={styles.conversationTitle}>
              {conversationPlainTitle(item, labels, uiLanguage)}
            </span>
          </span>
          <ConversationMeta item={item} nowMs={currentTimeMs} labels={labels} />
        </button>
        {previewMode ? null : (
          <div className={styles.conversationActions}>
            {isPendingDeleteConversation ? (
              <button
                type="button"
                className={styles.conversationDeleteButton}
                aria-label={labels.deleteSessionConfirm}
                title={labels.deleteSessionConfirm}
                disabled={isDeletingConversation}
                onClick={(event) => {
                  event.stopPropagation();
                  onConfirmDeleteConversation();
                }}
              >
                <span className={styles.conversationDeleteConfirmText}>
                  {labels.deleteSessionConfirm}
                </span>
              </button>
            ) : (
              <>
                {onOpenConversationWindow ? (
                  <BareIconButton
                    className={styles.conversationOpenWindowButton}
                    aria-label={labels.openConversationWindow}
                    title={labels.openConversationWindow}
                    size="md"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleOpenConversationWindow();
                    }}
                  >
                    <ExternalLink aria-hidden="true" />
                  </BareIconButton>
                ) : null}
                <BareIconButton
                  className={styles.conversationPinButton}
                  aria-label={pinned ? labels.unpinSession : labels.pinSession}
                  title={pinned ? labels.unpinSession : labels.pinSession}
                  size="md"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleTogglePinned();
                  }}
                >
                  {pinned ? (
                    <PinFilledIcon aria-hidden="true" />
                  ) : (
                    <PinLinedIcon aria-hidden="true" />
                  )}
                </BareIconButton>
                <BareIconButton
                  className={styles.conversationDeleteButton}
                  aria-label={labels.deleteSession}
                  title={labels.deleteSession}
                  size="md"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleRequestDelete();
                  }}
                >
                  <CanvasNodeTrashLinedIcon aria-hidden="true" />
                </BareIconButton>
              </>
            )}
          </div>
        )}
      </div>
    );
    if (previewMode) {
      return row;
    }
    return (
      <ContextMenu key={contextMenuResetKey}>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent
          className={`${styles.composerMenuContent} nodrag [-webkit-app-region:no-drag]`}
        >
          <ContextMenuItem
            className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
            onClick={handleContextMenuRename}
            onPointerUp={(event) => {
              if (event.button === 0) {
                handleContextMenuRename();
              }
            }}
            onSelect={handleContextMenuRename}
          >
            <span>{labels.renameSession}</span>
          </ContextMenuItem>
          {onOpenConversationWindow ? (
            <ContextMenuItem
              className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
              onClick={handleContextMenuOpenConversationWindow}
              onPointerUp={(event) => {
                if (event.button === 0) {
                  handleContextMenuOpenConversationWindow();
                }
              }}
              onSelect={handleContextMenuOpenConversationWindow}
            >
              <span>{labels.openConversationWindow}</span>
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem
            className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
            onClick={handleContextMenuCopySessionLink}
            onPointerUp={(event) => {
              if (event.button === 0) {
                handleContextMenuCopySessionLink();
              }
            }}
            onSelect={handleContextMenuCopySessionLink}
          >
            <span>{labels.copySessionLink}</span>
          </ContextMenuItem>
          <ContextMenuItem
            className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
            disabled={!canMarkUnread}
            onSelect={handleMarkUnread}
          >
            <span>{labels.markSessionUnread}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }
);

function AgentGUIProjectRailHeader({
  labels,
  selectProjectDirectory,
  workspaceUserProjectI18n
}: {
  labels: Pick<
    AgentGUIViewLabels,
    "projectRailCreateProject" | "projectRailLinkExistingProject"
  >;
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
}): React.JSX.Element {
  "use memo";
  const agentHostApi = useAgentHostApi();
  const userProjectApi = useMemo(
    () =>
      agentHostApi.userProjects
        ? {
            ...agentHostApi.userProjects,
            selectDirectory:
              selectProjectDirectory ?? agentHostApi.workspace.selectDirectory
          }
        : null,
    [
      agentHostApi.userProjects,
      agentHostApi.workspace.selectDirectory,
      selectProjectDirectory
    ]
  );

  return (
    <div className={styles.projectRailHeader}>
      <div className={styles.projectRailTitle}>
        <span>
          {workspaceUserProjectI18n.tFirst(["projectSelect.projectLabel"])}
        </span>
      </div>
      <div className={styles.projectRailAddProject}>
        <WorkspaceUserProjectSelect
          api={userProjectApi}
          classNames={{
            content: cn(
              styles.composerMenuContent,
              "w-[240px] min-w-[240px] nodrag [-webkit-app-region:no-drag]"
            ),
            item: cn(
              styles.composerMenuItem,
              "nodrag [-webkit-app-region:no-drag]"
            ),
            trigger: cn(
              styles.projectRailAddProjectTrigger,
              "nodrag [-webkit-app-region:no-drag]"
            )
          }}
          contentAlign="end"
          contentSide="bottom"
          contentSideOffset={6}
          i18n={workspaceUserProjectI18n}
          labels={{
            addProject: labels.projectRailCreateProject,
            createProjectTitle: labels.projectRailCreateProject,
            linkExistingProject: labels.projectRailLinkExistingProject,
            projectLabel: workspaceUserProjectI18n.tFirst([
              "projectSelect.addProject"
            ])
          }}
          renderAddProjectIcon={() => (
            <NewWorkspaceLinedIcon
              aria-hidden
              data-workspace-user-project-add-icon="true"
              size={15}
            />
          )}
          selectedProjectPath={null}
          service={agentHostApi.userProjects?.service ?? null}
          shouldApplyPreparedSelection={false}
          showCreateProjectAction
          showKnownProjectOptions={false}
          showNoProjectAction={false}
          onProjectPathChange={() => {}}
        />
        <NewWorkspaceLinedIcon
          aria-hidden
          className={styles.projectRailAddProjectIcon}
        />
      </div>
    </div>
  );
}

interface AgentGUIConversationTimelinePaneProps {
  conversation: AgentConversationVM | null;
  isLoading: boolean;
  isLoadingOlderMessages: boolean;
  loadingLabel: string;
  empty: React.JSX.Element;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onAuthLogin?: (provider?: string | null) => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  previewMode?: boolean;
  labels: {
    thinkingLabel: string;
    toolCallsLabel: (count: number) => string;
    processing: string;
    turnSummary: string;
    userMessageLocator: string;
  };
}

const AgentGUIConversationTimelinePane = memo(
  function AgentGUIConversationTimelinePane({
    conversation,
    isLoading,
    isLoadingOlderMessages,
    loadingLabel,
    empty,
    onLinkAction,
    onAuthLogin,
    availableSkills,
    workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS,
    previewMode = false,
    labels
  }: AgentGUIConversationTimelinePaneProps): React.JSX.Element {
    "use memo";

    return (
      <>
        {isLoadingOlderMessages && !isLoading ? (
          <div
            className="mx-auto flex h-8 items-center justify-center text-[12px] text-[var(--text-secondary)]"
            data-testid="agent-gui-older-messages-loading"
            role="status"
          >
            <span className="tsh-inline-loading-ellipsis">{loadingLabel}</span>
          </div>
        ) : null}
        <AgentConversationFlow
          conversation={conversation}
          isLoading={isLoading}
          loadingLabel={loadingLabel}
          empty={empty}
          onLinkAction={onLinkAction}
          onAuthLogin={onAuthLogin}
          availableSkills={availableSkills}
          workspaceAppIcons={workspaceAppIcons}
          previewMode={previewMode}
          labels={labels}
        />
      </>
    );
  }
);

function setTimelineScrollTopInstantly(
  element: HTMLElement,
  top: number
): void {
  // Timeline anchoring runs for high-frequency streaming updates. Smooth scrolling
  // queues animations that can overlap with incoming layout commits and make the transcript flicker.
  element.scrollTop = top;
}

function setTimelineScrollTopWithUserTransition(
  element: HTMLElement,
  top: number
): void {
  const reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof element.scrollTo === "function") {
    element.scrollTo({
      top,
      behavior: reducedMotion ? "auto" : "smooth"
    });
    return;
  }
  element.scrollTop = top;
}
