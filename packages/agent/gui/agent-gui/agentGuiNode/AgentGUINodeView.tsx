import {
  Fragment,
  memo,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useSnapshot } from "valtio";
import { proxy } from "valtio/vanilla";
import {
  ChevronRight,
  ExternalLink,
  Info,
  Settings,
  Wrench
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "../../app/renderer/components/ui/popover";
import { AgentUsageMeter } from "./AgentUsageMeter";
import { openAgentEnvPanel } from "../../shared/agentEnv/agentEnvPanelStore";
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
  NewWorkspaceLinedIcon,
  ConfirmationDialog,
  toastVariants,
  cn
} from "@tutti-os/ui-system";
import { WorkspaceUserProjectSelect } from "@tutti-os/workspace-user-project/ui";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import type { WorkspaceFileManagerI18nRuntime } from "@tutti-os/workspace-file-manager";
import { BareIconButton, ScrollArea } from "@tutti-os/ui-system/components";
import { Button } from "../../app/renderer/components/ui/button";
import {
  CreateChatIcon,
  FolderIcon,
  MoreHorizontalIcon
} from "@tutti-os/ui-system/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "../../app/renderer/components/ui/dropdown-menu";
import { PinFilledIcon } from "../../app/renderer/components/icons/PinFilledIcon";
import { PinLinedIcon } from "../../app/renderer/components/icons/PinLinedIcon";
import { UnavailableChatIcon } from "../../app/renderer/components/icons/UnavailableChatIcon";
import {
  StatusDot,
  type StatusDotTone
} from "../../app/renderer/components/StatusDot";
import { AgentConversationFlow } from "../../shared/agentConversation/components/AgentConversationFlow";
import type { AgentConversationVM } from "../../shared/agentConversation/contracts/agentConversationVM";
import type { AgentPromptContentBlock } from "../../shared/contracts/dto";
import type { AgentComposerDraft } from "./model/agentGuiNodeTypes";
import { useProjectedAgentConversation } from "../../shared/agentConversation/projection/useProjectedAgentConversation";
import { normalizeOptionalWorkspaceAgentStatus } from "../../shared/workspaceAgentStatusNormalizer";
import {
  MANAGED_AGENT_ICON_FALLBACK_URL,
  MANAGED_AGENT_ICON_URLS
} from "../../shared/managedAgentIcons";
import type { UiLanguage } from "../../contexts/settings/domain/agentSettings";
import { normalizeManagedAgentProvider } from "../../shared/managedAgentProviders";
import { formatAgentSessionMentionText } from "../../shared/utils/agentSessionMentionText";
import { TaskSearchField } from "../RoomIssueNode/TaskSearchField";
import type { WorkspaceLinkAction } from "../../actions/workspaceLinkActions";
import type {
  AgentGUIProviderSkillOption,
  AgentGUINodeViewModel,
  AgentGUISessionChrome
} from "./model/agentGuiNodeTypes";
import { resolveAgentGUIConversationDisplayTitle } from "./model/agentGuiProviderIdentity";
import { CanvasNodeTrashLinedIcon } from "../shared/canvasNodeChromeIcons";
import { AgentSessionChrome } from "./AgentSessionChrome";
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
import { AgentInteractivePromptSurface } from "./AgentInteractivePromptSurface";
import { AgentConversationListSkeleton } from "./AgentConversationListSkeleton";
import { useAgentHostApi } from "../../agentActivityHost";
import {
  ConversationMeta,
  groupConversations,
  type ConversationSection
} from "./agentGuiNodeViewConversation";
import styles from "./AgentGUINode.styles";
import type { AgentContextMentionProvider } from "./agentContextMentionProvider";
import type {
  AgentContextMentionItem,
  AgentMentionWorkspaceReferenceItem
} from "./agentRichText/agentFileMentionExtension";
import { createRichTextMentionHref } from "@tutti-os/ui-rich-text/core";

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
const AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE = 5;

const AGENT_GUI_TIMELINE_SCROLL_AREA_CONTENT_STYLE: CSSProperties = {
  width: "100%",
  minWidth: "100%",
  display: "grid",
  gridTemplateColumns:
    "minmax(0, min(100%, var(--agent-gui-detail-flow-max-width)))",
  justifyContent: "center",
  gap: "24px"
};

const EMPTY_WORKSPACE_APP_ICONS: readonly AgentMessageMarkdownWorkspaceAppIcon[] =
  [];
const AGENT_GUI_CONFIRMATION_DIALOG_CLASS_NAME =
  "nodrag tsh-desktop-no-drag [-webkit-app-region:no-drag]";
const AGENT_GUI_CONFIRMATION_DIALOG_OVERLAY_CLASS_NAME =
  "nodrag tsh-desktop-no-drag [-webkit-app-region:no-drag]";

export function resolveAgentGUIHeroIconUrl(
  provider: string | undefined
): string {
  const normalizedProvider = normalizeManagedAgentProvider(provider);
  return (
    MANAGED_AGENT_ICON_URLS[normalizedProvider] ??
    MANAGED_AGENT_ICON_FALLBACK_URL
  );
}

export function shouldEmphasizeEmptyHeroProvider(label: string): boolean {
  return !/[\u3400-\u9fff]/u.test(label);
}

const fallbackWorkspaceFileReferenceCopy: WorkspaceFileReferenceCopy = {
  t(key, values) {
    return values ? `${key}:${JSON.stringify(values)}` : key;
  }
};

function agentGuiPerfNowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
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
  emptyProvider?: string;
  conversations: string;
  newConversation: string;
  agentConfig: string;
  agentEnvSetup: string;
  noConversations: string;
  emptyProjectConversations: string;
  startConversation: string;
  selectConversation: string;
  loadingConversations: string;
  loadingConversation: string;
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
  approvalRequired: string;
  approvalUnavailable: string;
  authRequired: string;
  authLogin: string;
  activatingSession: string;
  cancellingSession: string;
  retryActivation: string;
  continueInNewConversation: string;
  goalLabel: string;
  goalStatusActive: string;
  goalStatusPaused: string;
  goalStatusBlocked: string;
  goalStatusUsageLimited: string;
  goalStatusBudgetLimited: string;
  goalStatusComplete: string;
  goalBudgetUsage: (used: number, budget: number) => string;
  goalClearHint: string;
  processing: string;
  turnSummary: string;
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
  unpinSession: string;
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
  slashStatusClose: string;
  slashStatusContextValue: (input: {
    percentLeft: number;
    usedTokens: string;
    totalTokens: string;
  }) => string;
  slashStatusContextUnavailable: string;
  slashStatusLimitsUnavailable: string;
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
  removeMention: string;
  addReference: string;
  referenceWorkspaceFiles: string;
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
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  capabilityMenuState?: AgentComposerProps["capabilityMenuState"];
  onCapabilitySettingsRequest?: AgentComposerProps["onCapabilitySettingsRequest"];
  isActive?: boolean;
  composerFocusRequestSequence?: number | null;
  newConversationRequestSequence?: number | null;
  isAgentProviderReady: boolean;
  slashStatusLimits?: readonly AgentComposerSlashStatusLimit[];
  slashStatusLimitsLoading?: boolean;
  previewMode?: boolean;
  onAgentProviderLogin?: (provider?: string | null) => void;
  actions: {
    createConversation: (options?: {
      projectPath?: string | null;
      source?: string;
    }) => void;
    selectConversation: (agentSessionId: string) => void;
    submitPrompt: (
      content: AgentPromptContentBlock[],
      displayPrompt?: string
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
    sendQueuedPromptNext: (queuedPromptId: string) => void;
    removeQueuedPrompt: (queuedPromptId: string) => void;
    editQueuedPrompt: (queuedPromptId: string) => void;
    retryActivation: () => void;
    continueInNewConversation: () => void;
    retryOpenclawGateway: () => void;
    toggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
    removeProject: (path: string) => void;
    confirmDeleteProjectConversations: (path?: string) => void;
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

function conversationDisplayTitle(
  conversation: Pick<
    AgentGUINodeViewModel["conversations"][number],
    "title" | "titleFallback"
  >,
  labels: Pick<AgentGUIViewLabels, "fallbackAgentTitle">
): string {
  return resolveAgentGUIConversationDisplayTitle(
    conversation,
    labels.fallbackAgentTitle
  );
}

function conversationPlainTitle(
  conversation: Pick<
    AgentGUINodeViewModel["conversations"][number],
    "title" | "titleFallback"
  >,
  labels: Pick<AgentGUIViewLabels, "fallbackAgentTitle">,
  uiLanguage: UiLanguage
): string {
  return formatAgentSessionMentionText(
    conversationDisplayTitle(conversation, labels),
    {
      language: uiLanguage
    }
  );
}

export function AgentGUINodeView({
  viewModel,
  onLinkAction,
  capabilityMenuState,
  onCapabilitySettingsRequest,
  isActive = true,
  composerFocusRequestSequence = null,
  newConversationRequestSequence = null,
  isAgentProviderReady,
  slashStatusLimits = [],
  slashStatusLimitsLoading = false,
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
    viewModel.isCreatingConversation || isOpenclawGatewayBlocking;
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
      setLocalComposerFocusRequestSequence((current) => current + 1);
    },
    [
      createConversationAction,
      previewMode,
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

  const layoutStyle = {
    "--agent-gui-conversation-rail-width": `${visualConversationRailWidthPx}px`,
    "--agent-gui-detail-min-width": `${detailMinWidthPx}px`,
    gridTemplateColumns: conversationRailCollapsed
      ? "0 minmax(var(--agent-gui-detail-min-width), 1fr)"
      : "var(--agent-gui-conversation-rail-width) minmax(var(--agent-gui-detail-min-width), 1fr)"
  } as CSSProperties;
  const openAgentEnvSetup = useCallback(() => {
    openAgentEnvPanel({ provider: viewModel.data.provider, focus: null });
  }, [viewModel.data.provider]);
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
        slashStatusLimits,
        onCreateConversation: requestCreateConversation,
        onOpenAgentEnvSetup: openAgentEnvSetup,
        onRetryOpenclawGateway: retryOpenclawGateway,
        onSelectConversation: selectConversation,
        onToggleConversationPinned: toggleConversationPinned,
        onRemoveProject: removeProject,
        onConfirmDeleteProjectConversations: confirmDeleteProjectConversations,
        onRequestDeleteConversation: requestDeleteConversation,
        onCancelDeleteConversation: cancelDeleteConversation,
        onConfirmDeleteConversation: confirmDeleteConversation,
        onOpenProjectFiles: openProjectFiles,
        onOpenConversationWindow: openConversationWindow,
        selectProjectDirectory
      }),
      [
        cancelDeleteConversation,
        confirmDeleteConversation,
        confirmDeleteProjectConversations,
        conversationRailCollapsed,
        createConversationDisabled,
        labels,
        openAgentEnvSetup,
        openConversationWindow,
        openProjectFiles,
        openclawGateway,
        previewMode,
        removeProject,
        requestCreateConversation,
        requestDeleteConversation,
        retryOpenclawGateway,
        selectConversation,
        selectProjectDirectory,
        slashStatusLimits,
        toggleConversationPinned,
        uiLanguage,
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

  const content = (
    <>
      <div
        ref={layoutElementRef}
        className={styles.layout}
        data-agent-gui-preview={previewMode ? "true" : undefined}
        data-rail-resizing={isRailResizing ? "true" : undefined}
        inert={previewMode ? true : undefined}
        style={layoutStyle}
      >
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
            composerFocusRequestSequence={detailComposerFocusRequestSequence}
            isAgentProviderReady={isAgentProviderReady}
            slashStatusLimits={slashStatusLimits}
            slashStatusLimitsLoading={slashStatusLimitsLoading}
            onLinkAction={onLinkAction}
            capabilityMenuState={capabilityMenuState}
            onCapabilitySettingsRequest={onCapabilitySettingsRequest}
            onAgentProviderLogin={onAgentProviderLogin}
            onRequestWorkspaceReferences={requestWorkspaceReferences}
            selectProjectDirectory={selectProjectDirectory}
            onRequestGitBranches={onRequestGitBranches}
            contextMentionProviders={contextMentionProviders}
            workspaceAppIcons={effectiveWorkspaceAppIcons}
            workspaceUserProjectI18n={workspaceUserProjectI18n}
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
    </>
  );

  return previewMode ? content : <TooltipProvider>{content}</TooltipProvider>;
}

interface AgentGUIDetailPaneProps {
  viewModel: AgentGUINodeViewModel;
  actions: AgentGUINodeViewProps["actions"];
  labels: AgentGUIViewLabels;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
  uiLanguage: UiLanguage;
  hideDetailHeader: boolean;
  isActive: boolean;
  previewMode: boolean;
  composerFocusRequestSequence: number | null;
  isAgentProviderReady: boolean;
  slashStatusLimits: readonly AgentComposerSlashStatusLimit[];
  slashStatusLimitsLoading: boolean;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  capabilityMenuState?: AgentComposerProps["capabilityMenuState"];
  onCapabilitySettingsRequest?: AgentComposerProps["onCapabilitySettingsRequest"];
  onAgentProviderLogin?: (provider?: string | null) => void;
  onRequestWorkspaceReferences?:
    | ((
        entity?: AgentContextMentionItem | null
      ) => Promise<WorkspaceReferencePickResult>)
    | null;
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  onRequestGitBranches?: AgentComposerGitBranchLoader | null;
  contextMentionProviders?: readonly AgentContextMentionProvider[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
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
  composerFocusRequestSequence,
  isAgentProviderReady,
  slashStatusLimits,
  slashStatusLimitsLoading,
  onLinkAction,
  capabilityMenuState,
  onCapabilitySettingsRequest,
  onAgentProviderLogin,
  onRequestWorkspaceReferences,
  selectProjectDirectory,
  onRequestGitBranches,
  contextMentionProviders,
  workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS
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
  const pendingPrependScrollAnchorRef = useRef<{
    conversationId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
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
    viewModel.isSubmitting || derivedBusyStatus !== null;
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
    !isAgentProviderReady && !isCollaboratorConversation;
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
      turnSummary: labels.turnSummary
    }),
    [
      labels.processing,
      labels.thinkingLabel,
      labels.toolCallsLabel,
      labels.turnSummary
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
      goalLabel: labels.goalLabel,
      statusActive: labels.goalStatusActive,
      statusPaused: labels.goalStatusPaused,
      statusBlocked: labels.goalStatusBlocked,
      statusUsageLimited: labels.goalStatusUsageLimited,
      statusBudgetLimited: labels.goalStatusBudgetLimited,
      statusComplete: labels.goalStatusComplete,
      budgetUsage: labels.goalBudgetUsage,
      clearHint: labels.goalClearHint
    }),
    [
      labels.goalLabel,
      labels.goalStatusActive,
      labels.goalStatusPaused,
      labels.goalStatusBlocked,
      labels.goalStatusUsageLimited,
      labels.goalStatusBudgetLimited,
      labels.goalStatusComplete,
      labels.goalBudgetUsage,
      labels.goalClearHint
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
      removeMention: labels.removeMention,
      addReference: labels.addReference,
      referenceWorkspaceFiles: labels.referenceWorkspaceFiles,
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
      labels.deleteQueuedPrompt,
      labels.editQueuedPrompt,
      labels.fileMentionEmpty,
      labels.fileMentionError,
      labels.fileMentionLoading,
      labels.fileMentionPalette,
      labels.fileMentionTabHint,
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
      labels.projectLocked,
      labels.projectMissingDescription,
      labels.promptTipsPrefix,
      labels.reviewPicker,
      labels.queuedLabel,
      labels.queuedPromptMoreActions,
      labels.referenceWorkspaceFiles,
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
  const submitPrompt = useStableEventCallback(actions.submitPrompt);
  const submitGuidancePrompt = useStableEventCallback(
    actions.submitGuidancePrompt
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
  const bottomDockComposerProps = useMemo<AgentComposerProps>(
    () => ({
      workspaceId: viewModel.workspaceId,
      workspacePath: viewModel.workspacePath,
      currentUserId: viewModel.currentUserId,
      provider: viewModel.data.provider,
      slashStatus,
      usage: viewModel.usage,
      draftContent: viewModel.draftContent,
      availableCommands: viewModel.availableCommands,
      hasCompactableContext: viewModel.hasSentUserMessage,
      compactSupported: viewModel.compactSupported,
      availableSkills: viewModel.availableSkills,
      disabled: composerDisabled,
      disabledReason: composerDisabledReason,
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
      // Plan decisions replace the composer via bottomDockReplacementPrompt;
      // approval / ask-user embed here (composerActivePrompt encodes that).
      activePrompt: composerActivePrompt,
      activePromptKeyboardShortcutsEnabled: isActive,
      promptTips: labels.promptTips,
      composerFocusRequestSequence,
      isActive,
      promptImagesSupported: viewModel.promptImagesSupported,
      isInterrupting: viewModel.isInterrupting,
      isSendingTurn: isComposerSending,
      isSubmittingPrompt: viewModel.isRespondingApproval,
      labels: composerLabels,
      workspaceUserProjectI18n,
      capabilityMenuState,
      onDraftContentChange: updateDraftContent,
      onProjectPathChange: updateSelectedProjectPath,
      onSettingsChange: updateComposerSettings,
      onSubmit: submitPrompt,
      onSubmitGuidance: submitGuidancePrompt,
      onPromptImagesUnsupported: showPromptImagesUnsupported,
      onSendQueuedPromptNext: sendQueuedPromptNext,
      onRemoveQueuedPrompt: removeQueuedPrompt,
      onEditQueuedPrompt: editQueuedPrompt,
      onInterruptCurrentTurn: handleInterruptCurrentTurn,
      onSubmitInteractivePrompt: submitInteractivePrompt,
      onCapabilitySettingsRequest,
      onLinkAction: stableLinkAction,
      onRequestWorkspaceReferences: stableRequestWorkspaceReferences,
      selectProjectDirectory: stableSelectProjectDirectory,
      onRequestGitBranches: stableRequestGitBranches,
      contextMentionProviders
    }),
    [
      canQueueWhileBusy,
      capabilityMenuState,
      composerDisabled,
      composerDisabledReason,
      composerFocusRequestSequence,
      composerLabels,
      handleInterruptCurrentTurn,
      isActive,
      isComposerSending,
      labels.followupPlaceholder,
      labels.initialPlaceholder,
      labels.promptTips,
      previewMode,
      composerActivePrompt,
      editQueuedPrompt,
      onCapabilitySettingsRequest,
      contextMentionProviders,
      removeQueuedPrompt,
      sendQueuedPromptNext,
      showPromptImagesUnsupported,
      showStopButton,
      slashStatus,
      submitDisabled,
      submitInteractivePrompt,
      submitPrompt,
      submitGuidancePrompt,
      stableLinkAction,
      stableRequestGitBranches,
      stableSelectProjectDirectory,
      stableRequestWorkspaceReferences,
      updateComposerSettings,
      updateDraftContent,
      updateSelectedProjectPath,
      viewModel.availableCommands,
      viewModel.availableSkills,
      viewModel.compactSupported,
      viewModel.composerSettings,
      viewModel.currentUserId,
      viewModel.data.provider,
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
      workspaceAppIcons
    ]
  );
  const emptyHeroComposerProps = useMemo<AgentComposerProps>(
    () => ({
      ...bottomDockComposerProps,
      layoutMode: "hero"
    }),
    [bottomDockComposerProps]
  );
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
      return;
    }

    const maxScrollTop = Math.max(
      0,
      timeline.scrollHeight - timeline.clientHeight
    );
    const anchor = timelineScrollAnchorRef.current;
    const prependAnchor = pendingPrependScrollAnchorRef.current;
    let nextScrollTop = timeline.scrollTop;

    if (!anchor || anchor.conversationId !== activeConversationId) {
      timeline.scrollTop = maxScrollTop;
      nextScrollTop = maxScrollTop;
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
      });
    };

    syncBottomDockSpace();
    if (typeof ResizeObserver === "undefined") {
      return () => {
        timeline.style.removeProperty("--agent-gui-bottom-dock-safe-area");
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
      timelineScrollAnchorRef.current = {
        conversationId: activeConversationId,
        scrollHeight: timeline.scrollHeight,
        scrollTop: timeline.scrollTop,
        clientHeight: timeline.clientHeight
      };
      if (
        viewModel.hasOlderMessages &&
        !viewModel.isLoadingOlderMessages &&
        timeline.scrollTop <= AGENT_GUI_TOP_HISTORY_PREFETCH_THRESHOLD_PX
      ) {
        pendingPrependScrollAnchorRef.current = {
          conversationId: activeConversationId,
          scrollHeight: timeline.scrollHeight,
          scrollTop: timeline.scrollTop
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
            className={styles.providerSetupNoticeAction}
            data-testid="agent-gui-provider-setup-notice-action"
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
        className="min-h-0 flex-1 [&_[data-orientation=vertical][data-slot=scroll-area-scrollbar]]:opacity-100"
        viewportRef={timelineRef}
        viewportTestId="agent-gui-timeline"
        viewportClassName={`${styles.timeline} ${
          hasActiveConversation
            ? styles.timelineWithComposer
            : styles.timelineCentered
        } ${showUnavailableChatEmpty ? styles.timelineUnavailableChatEmpty : ""}`.trim()}
        viewportContentStyle={AGENT_GUI_TIMELINE_SCROLL_AREA_CONTENT_STYLE}
      >
        {!hasActiveConversation ? (
          <AgentGUIEmptyHeroPane
            provider={viewModel.data.provider}
            emptyLabel={labels.empty}
            emptyProvider={labels.emptyProvider ?? ""}
            inlineNoticeChrome={inlineNoticeChrome}
            isRespondingApproval={viewModel.isRespondingApproval}
            onSubmitApprovalOption={submitApprovalOption}
            onRetryActivation={retryActivation}
            onAuthLogin={authLogin}
            onContinueInNewConversation={continueInNewConversation}
            chromeLabels={chromeLabels}
            composerProps={emptyHeroComposerProps}
          />
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

interface AgentGUIEmptyHeroPaneProps {
  provider: AgentGUINodeViewModel["data"]["provider"];
  emptyLabel: string;
  emptyProvider: string;
  inlineNoticeChrome: AgentGUISessionChrome | null;
  isRespondingApproval: boolean;
  onSubmitApprovalOption: AgentGUINodeViewProps["actions"]["submitApprovalOption"];
  onAuthLogin?: (provider?: string | null) => void;
  onRetryActivation: AgentGUINodeViewProps["actions"]["retryActivation"];
  onContinueInNewConversation: AgentGUINodeViewProps["actions"]["continueInNewConversation"];
  chromeLabels: ChromeLabels;
  composerProps: AgentComposerProps;
}

const AgentGUIEmptyHeroPane = memo(function AgentGUIEmptyHeroPane({
  provider,
  emptyLabel,
  emptyProvider,
  inlineNoticeChrome,
  isRespondingApproval,
  onSubmitApprovalOption,
  onAuthLogin,
  onRetryActivation,
  onContinueInNewConversation,
  chromeLabels,
  composerProps
}: AgentGUIEmptyHeroPaneProps): React.JSX.Element {
  "use memo";

  const heroIconUrl = resolveAgentGUIHeroIconUrl(provider);

  return (
    <div className={styles.emptyHero}>
      <div className={styles.emptyHeroBody}>
        <img
          aria-hidden="true"
          className={styles.emptyHeroIconEffect}
          draggable={false}
          src={heroIconUrl}
          alt=""
        />
        <h2 className={styles.emptyHeroTitle}>
          <EmptyHeroTitle label={emptyLabel} providerLabel={emptyProvider} />
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
      </div>
    </div>
  );
});

function EmptyHeroTitle({
  label,
  providerLabel
}: {
  label: string;
  providerLabel: string;
}): React.JSX.Element {
  const providerStart = providerLabel ? label.indexOf(providerLabel) : -1;

  if (!shouldEmphasizeEmptyHeroProvider(label) || providerStart < 0) {
    return <>{label}</>;
  }

  const providerEnd = providerStart + providerLabel.length;

  return (
    <>
      {label.slice(0, providerStart)}
      <span className={styles.emptyHeroProvider}>
        {label.slice(providerStart, providerEnd)}
      </span>
      {label.slice(providerEnd)}
    </>
  );
}

interface AgentGUIBottomDockPaneProps {
  bottomDockRef: React.RefObject<HTMLDivElement | null>;
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
}

const AgentGUIBottomDockPane = memo(function AgentGUIBottomDockPane({
  bottomDockRef,
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
  onSubmitBottomDockInteractivePrompt
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
  const showGoalBanner = isGoalBannerVisible(goalObjective, goalStatus);

  return (
    <div
      ref={bottomDockRef}
      className={styles.bottomDock}
      data-testid="agent-gui-bottom-dock"
    >
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
          labels={goalBannerLabels}
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
  slashStatusLimits: readonly AgentComposerSlashStatusLimit[];
  onCreateConversation: (options?: {
    projectPath?: string | null;
    source?: string;
  }) => void;
  onOpenAgentEnvSetup: () => void;
  onRetryOpenclawGateway: () => void;
  onSelectConversation: (agentSessionId: string) => void;
  onToggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
  onOpenProjectFiles?: ((action: WorkspaceLinkAction) => void) | null;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  onRemoveProject: (path: string) => void;
  onConfirmDeleteProjectConversations: (path?: string) => void;
  onRequestDeleteConversation: (agentSessionId: string) => void;
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
  "conversations" | "userProjects"
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
    current.onCreateConversation === next.onCreateConversation &&
    current.onOpenAgentEnvSetup === next.onOpenAgentEnvSetup &&
    current.onRetryOpenclawGateway === next.onRetryOpenclawGateway &&
    current.onSelectConversation === next.onSelectConversation &&
    current.onToggleConversationPinned === next.onToggleConversationPinned &&
    current.onOpenProjectFiles === next.onOpenProjectFiles &&
    current.onOpenConversationWindow === next.onOpenConversationWindow &&
    current.selectProjectDirectory === next.selectProjectDirectory &&
    current.onRemoveProject === next.onRemoveProject &&
    current.onConfirmDeleteProjectConversations ===
      next.onConfirmDeleteProjectConversations &&
    current.onRequestDeleteConversation === next.onRequestDeleteConversation &&
    current.onCancelDeleteConversation === next.onCancelDeleteConversation &&
    current.onConfirmDeleteConversation === next.onConfirmDeleteConversation
  );
}

interface AgentGUIConversationRailStorePaneProps {
  conversations: AgentGUINodeViewModel["conversations"];
  store: AgentGUIConversationRailStore;
  storeState: AgentGUIConversationRailStoreSnapshot;
  userProjects: AgentGUINodeViewModel["userProjects"];
}

const AgentGUIConversationRailStorePane = memo(
  function AgentGUIConversationRailStorePane({
    conversations,
    store,
    storeState: _storeState,
    userProjects
  }: AgentGUIConversationRailStorePaneProps): React.JSX.Element {
    "use memo";
    const state = useSnapshot(store) as AgentGUIConversationRailStoreSnapshot;
    return (
      <AgentGUIConversationRailPane
        {...state}
        conversations={conversations}
        userProjects={userProjects}
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
      if (previousItem !== item) {
        changed = true;
      }
      return previousItem;
    }
    changed = true;
    return item;
  });
  return changed ? stable : previous;
}

function conversationSummariesRenderEqual(
  left: AgentGUINodeViewModel["conversations"][number],
  right: AgentGUINodeViewModel["conversations"][number]
): boolean {
  return (
    left.id === right.id &&
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

const AgentGUIConversationRailPane = memo(
  function AgentGUIConversationRailPane({
    conversations,
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
    slashStatusLimits,
    onCreateConversation,
    onOpenAgentEnvSetup,
    onRetryOpenclawGateway,
    onSelectConversation,
    onToggleConversationPinned,
    onOpenProjectFiles,
    onOpenConversationWindow,
    selectProjectDirectory,
    onRemoveProject,
    onConfirmDeleteProjectConversations,
    onRequestDeleteConversation,
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
    const groupedConversationsRef = useRef<ConversationSection[] | null>(null);

    useEffect(() => {
      const timer = window.setInterval(() => {
        setCurrentTimeMs(Date.now());
      }, 60_000);
      return () => {
        window.clearInterval(timer);
      };
    }, []);

    const filteredConversationResult = useMemo(() => {
      const startedAtMs = agentGuiPerfNowMs();
      const query = conversationQuery.trim().toLowerCase();
      const items = !query
        ? conversations
        : conversations.filter((candidate) =>
            conversationPlainTitle(candidate, labels, uiLanguage)
              .toLowerCase()
              .includes(query)
          );
      return {
        items,
        filterMs: roundAgentGuiPerfMs(agentGuiPerfNowMs() - startedAtMs)
      };
    }, [conversationQuery, conversations, labels, uiLanguage]);
    const filteredConversations = filteredConversationResult.items;
    const groupedConversationResult = useMemo(() => {
      const startedAtMs = agentGuiPerfNowMs();
      const rawGroups = groupConversations(
        filteredConversations,
        labels,
        conversationQuery.trim() ? [] : userProjects,
        { includeEmptyConversations: !conversationQuery.trim() }
      );
      const groups = stabilizeConversationSections(
        groupedConversationsRef.current,
        rawGroups
      );
      groupedConversationsRef.current = groups;
      return {
        groups,
        groupMs: roundAgentGuiPerfMs(agentGuiPerfNowMs() - startedAtMs)
      };
    }, [conversationQuery, filteredConversations, labels, userProjects]);
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
      for (const conversation of conversations) {
        const normalizedPath = normalizeConversationRailProjectPath(
          conversation.project?.path
        );
        if (!normalizedPath) {
          continue;
        }
        counts.set(normalizedPath, (counts.get(normalizedPath) ?? 0) + 1);
      }
      return counts;
    }, [conversations]);
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
      if (!activeConversationId) {
        return;
      }
      conversationItemElementsRef.current
        .get(activeConversationId)
        ?.scrollIntoView({ block: "nearest" });
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
        {openclawGateway?.status === "starting" ? (
          <div className={styles.gatewayStatus} data-state="starting">
            <StatusDot
              tone="blue"
              pulse
              size="sm"
              ariaLabel={labels.openclawGatewayStarting}
            />
            <span>{labels.openclawGatewayStarting}</span>
          </div>
        ) : openclawGateway?.status === "failed" ? (
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
          {isLoadingConversations && conversations.length === 0 ? (
            <AgentConversationListSkeleton
              label={labels.loadingConversations}
            />
          ) : groupedConversations.length === 0 ? (
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
                    isSectionCollapsed={isSectionCollapsed}
                    labels={labels}
                    pendingDeleteConversationId={pendingDeleteConversationId}
                    previewMode={previewMode}
                    projectConversationCount={projectConversationCount}
                    projectLabel={projectLabel}
                    projectPath={projectPath}
                    registerItemElement={registerConversationItemElement}
                    section={section}
                    uiLanguage={uiLanguage}
                    onCancelDeleteConversation={onCancelDeleteConversation}
                    onConfirmDeleteConversation={onConfirmDeleteConversation}
                    onCreateConversation={onCreateConversation}
                    onRequestDeleteConversation={onRequestDeleteConversation}
                    onSelectConversation={onSelectConversation}
                    setPendingProjectAction={setPendingProjectAction}
                    onToggleConversationPinned={onToggleConversationPinned}
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
        <div className="shrink-0 border-t border-[var(--border-1)] px-2 py-1.5">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="flex w-full items-center justify-start gap-2 text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                title={labels.agentConfig}
                disabled={previewMode}
              >
                <Settings aria-hidden="true" size={16} strokeWidth={1.8} />
                <span>{labels.agentConfig}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              className="w-[300px] max-w-[calc(100vw-32px)] gap-3 text-xs"
              data-testid="agent-gui-config-menu"
            >
              <div className="flex min-w-0 flex-col gap-3">
                {slashStatusLimits.length > 0 ? (
                  <>
                    <div className="flex min-w-0 flex-col gap-2">
                      <span className="text-[13px] font-semibold leading-4">
                        {labels.slashStatusLimits}
                      </span>
                      {slashStatusLimits.map((limit) => (
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
                      ))}
                    </div>
                    <span className="h-px bg-[var(--border-1)]" />
                  </>
                ) : null}
                <button
                  type="button"
                  data-testid="agent-gui-config-env-setup"
                  className="nodrag -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-[6px] px-2 py-1 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-background-hover hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]"
                  disabled={previewMode}
                  onClick={() => onOpenAgentEnvSetup()}
                >
                  <Wrench aria-hidden="true" size={16} strokeWidth={1.8} />
                  <span>{labels.agentEnvSetup}</span>
                </button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <ConfirmationDialog
          cancelLabel={labels.cancel}
          className={AGENT_GUI_CONFIRMATION_DIALOG_CLASS_NAME}
          confirmBusy={
            pendingProjectAction?.kind === "batch-delete" &&
            isDeletingProjectConversations
          }
          confirmLabel={
            pendingProjectAction?.kind === "batch-delete"
              ? labels.batchDeleteProjectSessionsConfirm
              : labels.removeProject
          }
          description={
            pendingProjectAction?.kind === "batch-delete"
              ? labels.batchDeleteProjectSessionsBody(
                  pendingProjectAction.conversationCount,
                  pendingProjectAction.label
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
  createConversationDisabled: boolean;
  currentTimeMs: number;
  labels: AgentGUIViewLabels;
  uiLanguage: UiLanguage;
  registerItemElement: (itemId: string, element: HTMLDivElement | null) => void;
  onCreateConversation: (options?: {
    projectPath?: string | null;
    source?: string;
  }) => void;
  onToggleProjectSectionCollapsed: (sectionId: string) => void;
  setPendingProjectAction: (action: AgentGUIProjectActionDialog | null) => void;
  onSelectConversation: (agentSessionId: string) => void;
  onToggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
  onOpenProjectFiles?: ((action: WorkspaceLinkAction) => void) | null;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  onRequestDeleteConversation: (agentSessionId: string) => void;
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
    createConversationDisabled,
    currentTimeMs,
    labels,
    uiLanguage,
    registerItemElement,
    onCreateConversation,
    onToggleProjectSectionCollapsed,
    onSelectConversation,
    setPendingProjectAction,
    onToggleConversationPinned,
    onOpenProjectFiles,
    onOpenConversationWindow,
    onRequestDeleteConversation,
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
    const visibleItems = isSectionCollapsed
      ? []
      : section.items.slice(0, visibleItemCount);
    const canShowMore =
      !isSectionCollapsed && visibleItemCount < section.items.length;
    const canShowLess =
      !isSectionCollapsed &&
      visibleItemCount > AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE;
    const showMoreConversations = useCallback(() => {
      setVisibleItemLimit((current) =>
        Math.min(
          section.items.length,
          current + AGENT_GUI_CONVERSATION_RAIL_SECTION_PAGE_SIZE
        )
      );
    }, [section.items.length]);
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
                <FolderIcon
                  aria-hidden="true"
                  className={styles.conversationSectionLabelIcon}
                />
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
                onCancelDeleteConversation={onCancelDeleteConversation}
                onConfirmDeleteConversation={onConfirmDeleteConversation}
                onRequestDeleteConversation={onRequestDeleteConversation}
                onSelectConversation={onSelectConversation}
                onToggleConversationPinned={onToggleConversationPinned}
                onOpenConversationWindow={onOpenConversationWindow}
              />
            ))}
            {canShowMore || canShowLess ? (
              <div className={styles.conversationSectionPagination}>
                {canShowMore ? (
                  <button
                    type="button"
                    className={styles.conversationSectionPaginationButton}
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
  registerItemElement: (itemId: string, element: HTMLDivElement | null) => void;
  onSelectConversation: (agentSessionId: string) => void;
  onToggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  onRequestDeleteConversation: (agentSessionId: string) => void;
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
    registerItemElement,
    onSelectConversation,
    onToggleConversationPinned,
    onOpenConversationWindow,
    onRequestDeleteConversation,
    onCancelDeleteConversation,
    onConfirmDeleteConversation
  }: AgentGUIConversationRailItemProps): React.JSX.Element {
    "use memo";
    const pinned = (item.pinnedAtUnixMs ?? 0) > 0;
    const setItemElement = useCallback(
      (element: HTMLDivElement | null) => {
        registerItemElement(item.id, element);
      },
      [item.id, registerItemElement]
    );
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
    const handleOpenConversationWindow = useCallback(() => {
      onOpenConversationWindow?.(item.id);
    }, [item.id, onOpenConversationWindow]);
    const handleRequestDelete = useCallback(() => {
      onRequestDeleteConversation(item.id);
    }, [item.id, onRequestDeleteConversation]);

    return (
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
        >
          <span className={styles.conversationTitle}>
            {conversationPlainTitle(item, labels, uiLanguage)}
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
