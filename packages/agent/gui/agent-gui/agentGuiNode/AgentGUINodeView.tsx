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
import { ChevronRight, Info, X } from "lucide-react";
import type {
  WorkspaceFileReference,
  WorkspaceFileReferenceAdapter,
  WorkspaceFileReferenceCopy
} from "@tutti-os/workspace-file-reference/contracts";
import { WorkspaceFileReferencePicker } from "@tutti-os/workspace-file-reference/ui";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  NewWorkspaceLinedIcon,
  ConfirmationDialog,
  cn
} from "@tutti-os/ui-system";
import { WorkspaceUserProjectSelect } from "@tutti-os/workspace-user-project/ui";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import {
  Badge,
  BareIconButton,
  Button as UiSystemButton,
  ScrollArea
} from "@tutti-os/ui-system/components";
import { Button } from "../../app/renderer/components/ui/button";
import {
  EditIcon,
  FolderIcon,
  MoreHorizontalIcon
} from "@tutti-os/ui-system/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "../../app/renderer/components/ui/dropdown-menu";
import { CreateChatIcon } from "../../app/renderer/components/icons/CreateChatIcon";
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
  AgentComposer,
  formatSlashStatusTokenCount,
  type AgentComposerGitBranchLoader,
  type AgentComposerProps,
  type AgentComposerPromptTip,
  type AgentComposerSlashStatusLimit,
  type AgentComposerSlashStatus
} from "./AgentComposer";
import type { AgentActivityUsage } from "@tutti-os/agent-activity-core";
import {
  USAGE_CRITICAL_PERCENT,
  USAGE_WARN_PERCENT
} from "./model/agentUsageThresholds";
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
  groupConversations
} from "./agentGuiNodeViewConversation";
import styles from "./AgentGUINode.styles";
import type { AgentRichTextAtProvider } from "./agentRichTextAtProvider";

const AGENT_GUI_STICK_TO_BOTTOM_THRESHOLD_PX = 24;

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
  collaboratorSessionReadOnlyPlaceholder: string;
  send: string;
  modelLabel: string;
  modelSelectionLabel: string;
  defaultModel: string;
  inheritedUnavailable: string;
  reasoningLabel: string;
  reasoningDegreeLabel: string;
  reasoningOptionMinimal: string;
  reasoningOptionLow: string;
  reasoningOptionMedium: string;
  reasoningOptionHigh: string;
  reasoningOptionXHigh: string;
  speedLabel: string;
  speedSelectionLabel: string;
  speedOptionStandard: string;
  speedOptionFast: string;
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
  retryActivation: string;
  continueInNewConversation: string;
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
  browserUseCapabilityLabel: string;
  browserUseCapabilityDescription: string;
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
  usagePopoverTitle: string;
  usageTokensLabel: string;
  usageLimitsLabel: string;
  usageCompactAction: string;
  usageCompactTooltip: string;
  usageAlertWarnMessage: (input: { percent: number }) => string;
  usageAlertCriticalMessage: (input: { percent: number }) => string;
  usageAlertDismiss: string;
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
  statusWorking: string;
  statusWaiting: string;
  statusReady: string;
  statusCompleted: string;
  statusFailed: string;
  statusCanceled: string;
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
  isActive?: boolean;
  composerFocusRequestSequence?: number | null;
  isAgentProviderReady: boolean;
  slashStatusLimits?: readonly AgentComposerSlashStatusLimit[];
  slashStatusLimitsLoading?: boolean;
  previewMode?: boolean;
  showProjectSelector?: boolean;
  onAgentProviderLogin?: (provider?: string | null) => void;
  actions: {
    createConversation: (options?: { projectPath?: string | null }) => void;
    selectConversation: (agentSessionId: string) => void;
    submitPrompt: (content: AgentPromptContentBlock[]) => void;
    submitCompact: () => Promise<void> | void;
    dismissUsageAlert: () => void;
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
  workspaceFileReferenceAdapter?: WorkspaceFileReferenceAdapter | null;
  onRequestGitBranches?: AgentComposerGitBranchLoader | null;
  workspaceFileReferenceCopy?: WorkspaceFileReferenceCopy | null;
  richTextAtProviders?: readonly AgentRichTextAtProvider[];
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

function conversationStatusTone(
  status: AgentGUINodeViewModel["conversations"][number]["status"] | undefined
): StatusDotTone {
  switch (status) {
    case "working":
      return "blue";
    case "waiting":
      return "amber";
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "canceled":
      return "amber";
    case "ready":
    default:
      return "green";
  }
}

function conversationStatusPulse(
  status: AgentGUINodeViewModel["conversations"][number]["status"] | undefined
): boolean {
  switch (status) {
    case "working":
    case "waiting":
    case "ready":
    case undefined:
      return true;
    case "completed":
    case "failed":
    case "canceled":
    default:
      return false;
  }
}

function conversationStatusLabel(
  status: AgentGUINodeViewModel["conversations"][number]["status"] | undefined,
  labels: Pick<
    AgentGUIViewLabels,
    | "statusWorking"
    | "statusWaiting"
    | "statusReady"
    | "statusCompleted"
    | "statusFailed"
    | "statusCanceled"
  >
): string {
  switch (status) {
    case "working":
      return labels.statusWorking;
    case "waiting":
      return labels.statusWaiting;
    case "completed":
      return labels.statusCompleted;
    case "failed":
      return labels.statusFailed;
    case "canceled":
      return labels.statusCanceled;
    case "ready":
    default:
      return labels.statusReady;
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
    null;
  const providerConfig = objectRecord(rawState?.runtimeContext?.providerConfig);
  return {
    agentSessionId: rawState?.agentSessionId ?? null,
    baseUrl: stringValue(providerConfig?.baseUrl) || null,
    limits,
    limitsLoading,
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
  isActive = true,
  composerFocusRequestSequence = null,
  isAgentProviderReady,
  slashStatusLimits = [],
  slashStatusLimitsLoading = false,
  previewMode = false,
  showProjectSelector = true,
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
  workspaceFileReferenceAdapter = null,
  workspaceFileReferenceCopy = null,
  onRequestGitBranches = null,
  richTextAtProviders,
  workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS
}: AgentGUINodeViewProps): React.JSX.Element {
  "use memo";
  const railResizeInteractionRef = useRef<{
    pointerId: number;
    startClientX: number;
    startWidthPx: number;
  } | null>(null);
  const [isRailResizing, setIsRailResizing] = useState(false);
  const [workspaceReferencePickerOpen, setWorkspaceReferencePickerOpen] =
    useState(false);
  const [
    localComposerFocusRequestSequence,
    setLocalComposerFocusRequestSequence
  ] = useState(0);
  const workspaceReferencePickerResolverRef = useRef<
    ((refs: WorkspaceFileReference[]) => void) | null
  >(null);
  const requestWorkspaceReferences = useCallback(async () => {
    if (previewMode) {
      return [];
    }
    if (!workspaceFileReferenceAdapter || !workspaceFileReferenceCopy) {
      return [];
    }
    setWorkspaceReferencePickerOpen(true);
    return await new Promise<WorkspaceFileReference[]>((resolve) => {
      workspaceReferencePickerResolverRef.current = resolve;
    });
  }, [previewMode, workspaceFileReferenceAdapter, workspaceFileReferenceCopy]);
  const closeWorkspaceReferencePicker = useCallback(() => {
    workspaceReferencePickerResolverRef.current?.([]);
    workspaceReferencePickerResolverRef.current = null;
    setWorkspaceReferencePickerOpen(false);
  }, []);
  const confirmWorkspaceReferencePicker = useCallback(
    (refs: WorkspaceFileReference[]) => {
      workspaceReferencePickerResolverRef.current?.(refs);
      workspaceReferencePickerResolverRef.current = null;
      setWorkspaceReferencePickerOpen(false);
      if (refs.length > 0) {
        void onWorkspaceFileReferencesAdded?.(refs);
      }
    },
    [onWorkspaceFileReferencesAdded]
  );
  const openclawGateway =
    viewModel.openclawGateway ??
    (viewModel.data.provider === "openclaw"
      ? { status: "starting" as const, error: null }
      : null);
  const isOpenclawGatewayBlocking =
    openclawGateway !== null && openclawGateway.status !== "ready";
  const createConversationDisabled =
    viewModel.isCreatingConversation || isOpenclawGatewayBlocking;
  const detailComposerFocusRequestSequence =
    localComposerFocusRequestSequence === 0
      ? composerFocusRequestSequence
      : (composerFocusRequestSequence ?? 0) + localComposerFocusRequestSequence;
  const requestCreateConversation = useCallback(
    (options?: { projectPath?: string | null }) => {
      if (previewMode) {
        return;
      }
      if (options) {
        actions.createConversation(options);
      } else {
        actions.createConversation();
      }
      setLocalComposerFocusRequestSequence((current) => current + 1);
    },
    [actions, previewMode]
  );
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
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startWidthPx: conversationRailWidthPx
      };
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
      onConversationRailWidthChanged(nextWidthPx);
    },
    [clampConversationRailWidth, onConversationRailWidthChanged, previewMode]
  );

  const endConversationRailResize = useCallback(
    (event?: PointerEvent<HTMLDivElement>): void => {
      if (
        event &&
        railResizeInteractionRef.current?.pointerId === event.pointerId &&
        event.currentTarget.hasPointerCapture?.(event.pointerId)
      ) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
      railResizeInteractionRef.current = null;
      setIsRailResizing(false);
    },
    []
  );

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

  const layoutStyle = {
    "--agent-gui-conversation-rail-width": `${conversationRailWidthPx}px`,
    "--agent-gui-detail-min-width": `${detailMinWidthPx}px`,
    gridTemplateColumns: conversationRailCollapsed
      ? "0 minmax(var(--agent-gui-detail-min-width), 1fr)"
      : "var(--agent-gui-conversation-rail-width) minmax(var(--agent-gui-detail-min-width), 1fr)"
  } as CSSProperties;

  return (
    <TooltipProvider>
      <div
        className={styles.layout}
        data-agent-gui-preview={previewMode ? "true" : undefined}
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
          <AgentGUIConversationRailPane
            conversations={viewModel.conversations}
            userProjects={viewModel.userProjects}
            activeConversationId={viewModel.activeConversationId}
            pendingDeleteConversationId={
              viewModel.pendingDeleteConversation?.id ?? null
            }
            isLoadingConversations={viewModel.isLoadingConversations}
            isDeletingConversation={viewModel.isDeletingConversation}
            isDeletingProjectConversations={
              viewModel.isDeletingProjectConversations
            }
            labels={labels}
            workspaceUserProjectI18n={workspaceUserProjectI18n}
            uiLanguage={uiLanguage}
            showProjectSelector={showProjectSelector}
            createConversationDisabled={createConversationDisabled}
            openclawGateway={openclawGateway}
            isCollapsed={conversationRailCollapsed}
            onCreateConversation={requestCreateConversation}
            onRetryOpenclawGateway={actions.retryOpenclawGateway}
            onSelectConversation={actions.selectConversation}
            onToggleConversationPinned={actions.toggleConversationPinned}
            onRemoveProject={actions.removeProject}
            onConfirmDeleteProjectConversations={
              actions.confirmDeleteProjectConversations
            }
            onRequestDeleteConversation={actions.requestDeleteConversation}
            onCancelDeleteConversation={actions.cancelDeleteConversation}
            onConfirmDeleteConversation={actions.confirmDeleteConversation}
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
            conversationRailCollapsed ? undefined : conversationRailWidthPx
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
            isActive={isActive}
            composerFocusRequestSequence={detailComposerFocusRequestSequence}
            isAgentProviderReady={isAgentProviderReady}
            slashStatusLimits={slashStatusLimits}
            slashStatusLimitsLoading={slashStatusLimitsLoading}
            showProjectSelector={showProjectSelector}
            onLinkAction={onLinkAction}
            onAgentProviderLogin={onAgentProviderLogin}
            onRequestWorkspaceReferences={requestWorkspaceReferences}
            onRequestGitBranches={onRequestGitBranches}
            richTextAtProviders={richTextAtProviders}
            workspaceAppIcons={effectiveWorkspaceAppIcons}
            workspaceUserProjectI18n={workspaceUserProjectI18n}
          />
        </section>
      </div>
      <WorkspaceFileReferencePicker
        copy={workspaceFileReferenceCopy ?? fallbackWorkspaceFileReferenceCopy}
        fileAdapter={workspaceFileReferenceAdapter ?? undefined}
        initialPath={viewModel.composerSettings.selectedProjectPath}
        open={workspaceReferencePickerOpen}
        workspaceId={viewModel.workspaceId}
        onClose={closeWorkspaceReferencePicker}
        onConfirm={confirmWorkspaceReferencePicker}
      />
    </TooltipProvider>
  );
}

interface AgentGUIDetailPaneProps {
  viewModel: AgentGUINodeViewModel;
  actions: AgentGUINodeViewProps["actions"];
  labels: AgentGUIViewLabels;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
  uiLanguage: UiLanguage;
  isActive: boolean;
  composerFocusRequestSequence: number | null;
  isAgentProviderReady: boolean;
  slashStatusLimits: readonly AgentComposerSlashStatusLimit[];
  slashStatusLimitsLoading: boolean;
  showProjectSelector: boolean;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onAgentProviderLogin?: (provider?: string | null) => void;
  onRequestWorkspaceReferences?:
    | (() => Promise<WorkspaceFileReference[]>)
    | null;
  onRequestGitBranches?: AgentComposerGitBranchLoader | null;
  richTextAtProviders?: readonly AgentRichTextAtProvider[];
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
  isActive,
  composerFocusRequestSequence,
  isAgentProviderReady,
  slashStatusLimits,
  slashStatusLimitsLoading,
  showProjectSelector,
  onLinkAction,
  onAgentProviderLogin,
  onRequestWorkspaceReferences,
  onRequestGitBranches,
  richTextAtProviders,
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
  const displayConversationStatus = viewModel.isSubmitting
    ? "working"
    : (derivedBusyStatus ?? viewModel.activeConversation?.status);
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
  const activeConversationStatusLabel = conversationStatusLabel(
    displayConversationStatus,
    labels
  );
  const statusGroupTitle = showSyncIndicator
    ? `${activeConversationStatusLabel} · ${syncLabel}`
    : activeConversationStatusLabel;
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
      activatingSession: labels.activatingSession,
      retryActivation: labels.retryActivation,
      continueInNewConversation: labels.continueInNewConversation
    }),
    [
      labels.activatingSession,
      labels.approvalRequired,
      labels.authRequired,
      labels.continueInNewConversation,
      labels.retryActivation
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
      defaultModel: labels.defaultModel,
      inheritedUnavailable: labels.inheritedUnavailable,
      loadingConversation: labels.loadingConversation,
      reasoningLabel: labels.reasoningLabel,
      reasoningDegreeLabel: labels.reasoningDegreeLabel,
      reasoningOptionMinimal: labels.reasoningOptionMinimal,
      reasoningOptionLow: labels.reasoningOptionLow,
      reasoningOptionMedium: labels.reasoningOptionMedium,
      reasoningOptionHigh: labels.reasoningOptionHigh,
      reasoningOptionXHigh: labels.reasoningOptionXHigh,
      speedLabel: labels.speedLabel,
      speedSelectionLabel: labels.speedSelectionLabel,
      speedOptionStandard: labels.speedOptionStandard,
      speedOptionFast: labels.speedOptionFast,
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
      browserUseCapabilityLabel: labels.browserUseCapabilityLabel,
      browserUseCapabilityDescription: labels.browserUseCapabilityDescription,
      slashStatusTitle: labels.slashStatusTitle,
      slashStatusSession: labels.slashStatusSession,
      slashStatusBaseUrl: labels.slashStatusBaseUrl,
      slashStatusContext: labels.slashStatusContext,
      slashStatusLimits: labels.slashStatusLimits,
      slashStatusClose: labels.slashStatusClose,
      slashStatusContextValue: labels.slashStatusContextValue,
      slashStatusContextUnavailable: labels.slashStatusContextUnavailable,
      slashStatusLimitsUnavailable: labels.slashStatusLimitsUnavailable,
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
      labels.modelDescriptions,
      labels.modelSelectionLabel,
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
      labels.reasoningOptionHigh,
      labels.reasoningOptionLow,
      labels.reasoningOptionMedium,
      labels.reasoningOptionMinimal,
      labels.reasoningOptionXHigh,
      labels.speedLabel,
      labels.speedSelectionLabel,
      labels.speedOptionStandard,
      labels.speedOptionFast,
      labels.send,
      labels.sendQueuedPromptNext,
      labels.slashCommandPalette,
      labels.browserUseCapabilityDescription,
      labels.browserUseCapabilityLabel,
      labels.slashPaletteCapabilitiesGroup,
      labels.slashPaletteCommandsGroup,
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
      labels.stop,
      labels.stopping
    ]
  );
  const handleInterruptCurrentTurn = useCallback(() => {
    actions.interruptCurrentTurn(labels.noRunningResponse);
  }, [actions.interruptCurrentTurn, labels.noRunningResponse]);
  const handleUsageAlertCompact = useCallback(() => {
    actions.submitCompact();
    actions.dismissUsageAlert();
  }, [actions]);
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
      draftContent: viewModel.draftContent,
      availableCommands: viewModel.availableCommands,
      hasCompactableContext: viewModel.hasSentUserMessage,
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
      // Plan decisions replace the composer via bottomDockReplacementPrompt;
      // approval / ask-user embed here (composerActivePrompt encodes that).
      activePrompt: composerActivePrompt,
      activePromptKeyboardShortcutsEnabled: isActive,
      promptTips: labels.promptTips,
      composerFocusRequestSequence,
      isActive,
      promptImagesSupported: viewModel.promptImagesSupported,
      showProjectSelector,
      isInterrupting: viewModel.isInterrupting,
      isSendingTurn: isComposerSending,
      isSubmittingPrompt: viewModel.isRespondingApproval,
      labels: composerLabels,
      workspaceUserProjectI18n,
      onDraftContentChange: updateDraftContent,
      onProjectPathChange: updateSelectedProjectPath,
      onSettingsChange: updateComposerSettings,
      onSubmit: submitPrompt,
      onPromptImagesUnsupported: showPromptImagesUnsupported,
      onSendQueuedPromptNext: sendQueuedPromptNext,
      onRemoveQueuedPrompt: removeQueuedPrompt,
      onEditQueuedPrompt: editQueuedPrompt,
      onInterruptCurrentTurn: handleInterruptCurrentTurn,
      onSubmitInteractivePrompt: submitInteractivePrompt,
      onLinkAction: stableLinkAction,
      onRequestWorkspaceReferences: stableRequestWorkspaceReferences,
      onRequestGitBranches: stableRequestGitBranches,
      richTextAtProviders
    }),
    [
      canQueueWhileBusy,
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
      composerActivePrompt,
      editQueuedPrompt,
      richTextAtProviders,
      removeQueuedPrompt,
      sendQueuedPromptNext,
      showPromptImagesUnsupported,
      showProjectSelector,
      showStopButton,
      slashStatus,
      submitDisabled,
      submitInteractivePrompt,
      submitPrompt,
      stableLinkAction,
      stableRequestGitBranches,
      stableRequestWorkspaceReferences,
      updateComposerSettings,
      updateDraftContent,
      updateSelectedProjectPath,
      viewModel.availableCommands,
      viewModel.availableSkills,
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
      viewModel.workspaceId,
      viewModel.workspacePath,
      workspaceUserProjectI18n,
      workspaceAppIcons
    ]
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
    let nextScrollTop = timeline.scrollTop;

    if (!anchor || anchor.conversationId !== activeConversationId) {
      timeline.scrollTop = maxScrollTop;
      nextScrollTop = maxScrollTop;
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
  }, [conversation, showTimelineSkeleton, viewModel.activeConversationId]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    const bottomDock = bottomDockRef.current;
    const activeConversationId = viewModel.activeConversationId;
    if (!timeline || !bottomDock || !activeConversationId) {
      return;
    }

    let animationFrameId: number | null = null;

    const syncBottomDockSpace = (): void => {
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
        if (animationFrameId !== null) {
          window.cancelAnimationFrame(animationFrameId);
        }
      };
    }

    const observer = new ResizeObserver(syncBottomDockSpace);
    observer.observe(bottomDock);
    return () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      observer.disconnect();
    };
  }, [viewModel.activeConversationId]);

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
    };

    captureScrollAnchor();
    timeline.addEventListener("scroll", captureScrollAnchor, { passive: true });
    return () => {
      timeline.removeEventListener("scroll", captureScrollAnchor);
    };
  }, [viewModel.activeConversationId]);

  return (
    <main className={styles.detail}>
      <AgentGUIDetailHeader
        activeConversation={viewModel.activeConversation}
        labels={labels}
        uiLanguage={uiLanguage}
        statusGroupTitle={statusGroupTitle}
        showSyncIndicator={showSyncIndicator}
        syncStatus={syncStatus}
        syncLabel={syncLabel}
        activeConversationStatus={displayConversationStatus}
        activeConversationStatusLabel={activeConversationStatusLabel}
        showFailedSyncLabel={showFailedSyncLabel}
        usage={viewModel.usage}
        usageLimits={slashStatusLimits}
        compactSupported={viewModel.compactSupported}
        onSubmitCompact={actions.submitCompact}
      />
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
            composerProps={{
              workspaceId: viewModel.workspaceId,
              workspacePath: viewModel.workspacePath,
              currentUserId: viewModel.currentUserId,
              provider: viewModel.data.provider,
              slashStatus,
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
              activePrompt: composerActivePrompt,
              activePromptKeyboardShortcutsEnabled: isActive,
              composerFocusRequestSequence,
              isActive,
              promptImagesSupported: viewModel.promptImagesSupported,
              promptTips: labels.promptTips,
              showProjectSelector,
              isInterrupting: viewModel.isInterrupting,
              isSendingTurn: isComposerSending,
              isSubmittingPrompt: viewModel.isRespondingApproval,
              labels: composerLabels,
              workspaceUserProjectI18n,
              onDraftContentChange: updateDraftContent,
              onProjectPathChange: updateSelectedProjectPath,
              onSettingsChange: updateComposerSettings,
              onSubmit: submitPrompt,
              onPromptImagesUnsupported: showPromptImagesUnsupported,
              onSendQueuedPromptNext: sendQueuedPromptNext,
              onRemoveQueuedPrompt: removeQueuedPrompt,
              onEditQueuedPrompt: editQueuedPrompt,
              onInterruptCurrentTurn: handleInterruptCurrentTurn,
              onSubmitInteractivePrompt: submitInteractivePrompt,
              onLinkAction: stableLinkAction,
              onRequestWorkspaceReferences: stableRequestWorkspaceReferences,
              onRequestGitBranches: stableRequestGitBranches,
              richTextAtProviders
            }}
          />
        ) : (
          <AgentGUIConversationTimelinePane
            conversation={conversation}
            isLoading={showTimelineSkeleton}
            loadingLabel={labels.loadingConversation}
            empty={conversationFlowEmpty}
            onLinkAction={stableLinkAction}
            onAuthLogin={authLogin}
            availableSkills={viewModel.availableSkills}
            workspaceAppIcons={workspaceAppIcons}
            labels={conversationFlowLabels}
          />
        )}
      </ScrollArea>
      {hasActiveConversation ? (
        <AgentGUIBottomDockPane
          bottomDockRef={bottomDockRef}
          bottomDockLiftedPrompt={bottomDockLiftedPrompt}
          bottomDockReplacementPrompt={bottomDockReplacementPrompt}
          usageAlert={viewModel.usageAlert}
          usagePercent={viewModel.usage?.percentUsed ?? null}
          usageAlertShowCompactAction={viewModel.compactSupported !== false}
          usageAlertLabels={labels}
          onUsageAlertCompact={handleUsageAlertCompact}
          onUsageAlertDismiss={actions.dismissUsageAlert}
          store={bottomDockStore}
          storeRevision={bottomDockStoreRevision}
          keyboardShortcutsEnabled={isActive}
          chromeLabels={chromeLabels}
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
  labels: Pick<
    AgentGUIViewLabels,
    | "fallbackAgentTitle"
    | "selectConversation"
    | "usageChipLabel"
    | "usagePopoverTitle"
    | "usageTokensLabel"
    | "usageLimitsLabel"
    | "usageCompactAction"
    | "usageCompactTooltip"
  >;
  uiLanguage: UiLanguage;
  statusGroupTitle: string;
  showSyncIndicator: boolean;
  syncStatus: SyncIndicatorStatus;
  syncLabel: string;
  activeConversationStatus:
    | AgentGUINodeViewModel["conversations"][number]["status"]
    | undefined;
  activeConversationStatusLabel: string;
  showFailedSyncLabel: boolean;
  usage: AgentActivityUsage | null;
  usageLimits: readonly AgentComposerSlashStatusLimit[];
  compactSupported: boolean | null;
  onSubmitCompact: () => Promise<void> | void;
}

const AgentGUIDetailHeader = memo(function AgentGUIDetailHeader({
  activeConversation,
  labels,
  uiLanguage,
  statusGroupTitle,
  showSyncIndicator,
  syncStatus,
  syncLabel,
  activeConversationStatus,
  activeConversationStatusLabel,
  showFailedSyncLabel,
  usage,
  usageLimits,
  compactSupported,
  onSubmitCompact
}: AgentGUIDetailHeaderProps): React.JSX.Element | null {
  "use memo";

  if (!activeConversation) {
    return null;
  }

  const runPath = activeConversation.cwd.trim();

  return (
    <div className={styles.detailHeader}>
      <span className={styles.detailHeaderTitleGroup}>
        <span className={styles.detailHeaderTitle}>
          {conversationPlainTitle(activeConversation, labels, uiLanguage)}
        </span>
        {runPath ? <AgentRunPathInfo path={runPath} /> : null}
      </span>
      <span
        className="inline-flex flex-none items-center gap-2 whitespace-nowrap"
        title={statusGroupTitle}
      >
        {usage && usage.percentUsed !== null ? (
          <AgentUsageChip
            percentUsed={usage.percentUsed}
            usedTokens={usage.usedTokens}
            totalTokens={usage.totalTokens}
            limits={usageLimits}
            labels={labels}
          />
        ) : null}
        {usage && usage.percentUsed !== null && compactSupported !== false ? (
          <AgentGUICompactButton
            conversationId={activeConversation.id}
            status={activeConversationStatus}
            label={labels.usageCompactAction}
            tooltip={labels.usageCompactTooltip}
            onSubmitCompact={onSubmitCompact}
          />
        ) : null}
        <StatusDot
          tone={conversationStatusTone(activeConversationStatus)}
          pulse={conversationStatusPulse(activeConversationStatus)}
          size="sm"
          ariaLabel={activeConversationStatusLabel}
          title={activeConversationStatusLabel}
        />
        <span className={styles.detailHeaderStatus}>
          {activeConversationStatusLabel}
        </span>
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

function AgentRunPathInfo({ path }: { path: string }): React.JSX.Element {
  "use memo";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={styles.detailHeaderPathInfo}
          aria-label={path}
        >
          <Info size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </TooltipTrigger>
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

function AgentGUICompactButton({
  conversationId,
  status,
  label,
  tooltip,
  onSubmitCompact
}: {
  conversationId: string;
  status: AgentGUINodeViewModel["conversations"][number]["status"] | undefined;
  label: string;
  tooltip: string;
  onSubmitCompact: () => Promise<void> | void;
}): React.JSX.Element {
  "use memo";

  const [pendingConversationId, setPendingConversationId] = useState<
    string | null
  >(null);
  const lastStatusRef = useRef(status);

  useEffect(() => {
    const previousStatus = lastStatusRef.current;
    lastStatusRef.current = status;
    if (
      pendingConversationId === conversationId &&
      ((status === "ready" && previousStatus !== "ready") ||
        status === "completed" ||
        status === "failed" ||
        status === "canceled")
    ) {
      setPendingConversationId(null);
    }
  }, [conversationId, pendingConversationId, status]);

  const isPending = pendingConversationId === conversationId;
  const disabled = isPending || status === "working";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UiSystemButton
          type="button"
          variant="secondary"
          size="xs"
          className="text-[13px] font-normal"
          data-testid="agent-gui-compact-button"
          disabled={disabled}
          aria-label={label}
          onClick={() => {
            if (disabled) {
              return;
            }
            setPendingConversationId(conversationId);
            const submission = onSubmitCompact();
            if (submission) {
              void submission.catch(() => {
                setPendingConversationId(null);
              });
            }
          }}
        >
          {label}
        </UiSystemButton>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="end"
        className="max-w-[320px] cursor-default text-xs"
      >
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

type AgentUsageChipLevel = "normal" | "warning" | "critical";
type AgentUsageBadgeVariant = "secondary" | "warning" | "destructive";

function agentUsageChipLevel(percentUsed: number): AgentUsageChipLevel {
  if (percentUsed >= USAGE_CRITICAL_PERCENT) {
    return "critical";
  }
  if (percentUsed >= USAGE_WARN_PERCENT) {
    return "warning";
  }
  return "normal";
}

function agentUsageBadgeVariant(
  level: AgentUsageChipLevel
): AgentUsageBadgeVariant {
  if (level === "critical") {
    return "destructive";
  }
  if (level === "warning") {
    return "warning";
  }
  return "secondary";
}

function AgentUsageChip({
  percentUsed,
  usedTokens,
  totalTokens,
  limits,
  labels
}: {
  percentUsed: number;
  usedTokens: number | null;
  totalTokens: number | null;
  limits: readonly AgentComposerSlashStatusLimit[];
  labels: Pick<
    AgentGUIViewLabels,
    | "usageChipLabel"
    | "usagePopoverTitle"
    | "usageTokensLabel"
    | "usageLimitsLabel"
  >;
}): React.JSX.Element {
  "use memo";

  const chipLabel = labels.usageChipLabel({ percent: percentUsed });
  const showTokens = usedTokens !== null && totalTokens !== null;
  const usageLevel = agentUsageChipLevel(percentUsed);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          asChild
          variant={agentUsageBadgeVariant(usageLevel)}
          className="cursor-default text-[13px] font-normal"
          data-testid="agent-gui-usage-chip"
          data-usage-level={usageLevel}
        >
          <span aria-label={chipLabel}>{chipLabel}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="end"
        className="max-w-[320px] text-xs"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-semibold">{labels.usagePopoverTitle}</span>
          {showTokens ? (
            <span className="whitespace-nowrap">
              {labels.usageTokensLabel}:{" "}
              {formatSlashStatusTokenCount(usedTokens)} /{" "}
              {formatSlashStatusTokenCount(totalTokens)}
            </span>
          ) : null}
          {limits.length > 0 ? (
            <>
              <span className="font-semibold">{labels.usageLimitsLabel}</span>
              {limits.map((limit) => (
                <span key={limit.id} className="whitespace-nowrap">
                  {limit.label}: {limit.value}
                  {limit.reset ? ` (${limit.reset})` : ""}
                </span>
              ))}
            </>
          ) : null}
        </div>
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
        <AgentComposer {...composerProps} layoutMode="hero" />
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

  if (providerStart < 0) {
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

type AgentUsageAlertBannerLabels = Pick<
  AgentGUIViewLabels,
  | "usageAlertWarnMessage"
  | "usageAlertCriticalMessage"
  | "usageAlertDismiss"
  | "usageCompactAction"
>;

function AgentUsageAlertBanner({
  tier,
  percent,
  showCompactAction,
  labels,
  onCompact,
  onDismiss
}: {
  tier: NonNullable<AgentGUINodeViewModel["usageAlert"]>;
  percent: number | null;
  showCompactAction: boolean;
  labels: AgentUsageAlertBannerLabels;
  onCompact: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  "use memo";

  const resolvedPercent =
    percent ??
    (tier === "critical" ? USAGE_CRITICAL_PERCENT : USAGE_WARN_PERCENT);
  const message =
    tier === "critical"
      ? labels.usageAlertCriticalMessage({ percent: resolvedPercent })
      : labels.usageAlertWarnMessage({ percent: resolvedPercent });

  return (
    <div
      className={styles.usageAlertBanner}
      data-testid="agent-gui-usage-alert"
      data-usage-alert-tier={tier}
      role={tier === "critical" ? "alert" : "status"}
    >
      <span className={styles.usageAlertMessage}>{message}</span>
      <span className={styles.usageAlertActions}>
        {tier === "critical" && showCompactAction ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="agent-gui-usage-alert-compact"
            onClick={onCompact}
          >
            {labels.usageCompactAction}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={styles.usageAlertDismiss}
          data-testid="agent-gui-usage-alert-dismiss"
          aria-label={labels.usageAlertDismiss}
          title={labels.usageAlertDismiss}
          onClick={onDismiss}
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </Button>
      </span>
    </div>
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
  usageAlert: AgentGUINodeViewModel["usageAlert"];
  usagePercent: number | null;
  usageAlertShowCompactAction: boolean;
  usageAlertLabels: AgentUsageAlertBannerLabels;
  onUsageAlertCompact: () => void;
  onUsageAlertDismiss: () => void;
  chromeLabels: ChromeLabels;
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
  usageAlert,
  usagePercent,
  usageAlertShowCompactAction,
  usageAlertLabels,
  onUsageAlertCompact,
  onUsageAlertDismiss,
  chromeLabels,
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
            isSubmitting={isRespondingApproval}
            onSubmit={onSubmitBottomDockInteractivePrompt}
            labels={promptLabels}
          />
        </div>
      ) : null}
      {usageAlert ? (
        <AgentUsageAlertBanner
          tier={usageAlert}
          percent={usagePercent}
          showCompactAction={usageAlertShowCompactAction}
          labels={usageAlertLabels}
          onCompact={onUsageAlertCompact}
          onDismiss={onUsageAlertDismiss}
        />
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
  showProjectSelector: boolean;
  createConversationDisabled: boolean;
  openclawGateway: OpenclawGatewayViewModel | null;
  isCollapsed: boolean;
  onCreateConversation: (options?: { projectPath?: string | null }) => void;
  onRetryOpenclawGateway: () => void;
  onSelectConversation: (agentSessionId: string) => void;
  onToggleConversationPinned: (agentSessionId: string, pinned: boolean) => void;
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

function normalizeConversationRailProjectPath(
  path: string | null | undefined
): string {
  const normalized = path?.trim().replaceAll("\\", "/") ?? "";
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\/+$/, "") || "/";
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
    showProjectSelector,
    createConversationDisabled,
    openclawGateway,
    isCollapsed,
    onCreateConversation,
    onRetryOpenclawGateway,
    onSelectConversation,
    onToggleConversationPinned,
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
      return {
        groups: groupConversations(
          filteredConversations,
          labels,
          conversationQuery.trim() ? [] : userProjects,
          { includeEmptyConversations: !conversationQuery.trim() }
        ),
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
            className={styles.newConversationIconButton}
            title={labels.newConversation}
            disabled={createConversationDisabled}
            onClick={() => onCreateConversation()}
          >
            <CreateChatIcon />
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
              const projectLabel =
                section.kind === "project" ? section.label : "";
              const isProjectSection = section.kind === "project";
              const showProjectRailHeader =
                showProjectSelector &&
                !conversationQuery.trim() &&
                section.kind !== "pinned" &&
                (sectionIndex === 0 ||
                  groupedConversations[sectionIndex - 1]?.kind === "pinned");
              const isSectionCollapsed =
                isProjectSection && collapsedProjectSectionIds.has(section.id);
              const projectConversationCount = projectPath
                ? conversations.filter(
                    (conversation) =>
                      normalizeConversationRailProjectPath(
                        conversation.project?.path
                      ) === normalizeConversationRailProjectPath(projectPath)
                  ).length
                : 0;
              return (
                <Fragment key={section.id}>
                  {showProjectRailHeader ? (
                    <AgentGUIProjectRailHeader
                      labels={labels}
                      workspaceUserProjectI18n={workspaceUserProjectI18n}
                    />
                  ) : null}
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
                          onClick={() =>
                            toggleProjectSectionCollapsed(section.id)
                          }
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
                      {projectPath ? (
                        <div className={styles.conversationSectionActions}>
                          <BareIconButton
                            className={styles.conversationSectionMoreButton}
                            aria-label={labels.projectSectionEdit}
                            title={labels.projectSectionEdit}
                            size="sm"
                            disabled={createConversationDisabled}
                            onClick={() =>
                              onCreateConversation({ projectPath })
                            }
                          >
                            <EditIcon aria-hidden="true" />
                          </BareIconButton>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <BareIconButton
                                className={styles.conversationSectionMoreButton}
                                aria-label={labels.projectSectionMoreActions}
                                title={labels.projectSectionMoreActions}
                                size="sm"
                              >
                                <MoreHorizontalIcon aria-hidden="true" />
                              </BareIconButton>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="end"
                              className={`${styles.composerMenuContent} nodrag [-webkit-app-region:no-drag]`}
                              sideOffset={6}
                            >
                              <DropdownMenuItem
                                className={`${styles.composerMenuItem} nodrag [-webkit-app-region:no-drag]`}
                                disabled={projectConversationCount === 0}
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
                        </div>
                      ) : null}
                    </div>
                    <div
                      className={styles.conversationSectionItems}
                      aria-hidden={isSectionCollapsed ? "true" : undefined}
                    >
                      <div className={styles.conversationSectionItemsInner}>
                        {section.items.length === 0 ? (
                          <div className={styles.conversationSectionEmpty}>
                            {labels.emptyProjectConversations}
                          </div>
                        ) : null}
                        {section.items.map((item) => {
                          const isPendingDeleteConversation =
                            pendingDeleteConversationId === item.id;

                          return (
                            <div
                              key={item.id}
                              ref={(element) => {
                                if (element) {
                                  conversationItemElementsRef.current.set(
                                    item.id,
                                    element
                                  );
                                } else {
                                  conversationItemElementsRef.current.delete(
                                    item.id
                                  );
                                }
                              }}
                              className={styles.conversationItem}
                              data-active={item.id === activeConversationId}
                              data-pinned={(item.pinnedAtUnixMs ?? 0) > 0}
                              data-pending-delete={isPendingDeleteConversation}
                              data-testid={`agent-gui-conversation-item-${item.id}`}
                              onMouseLeave={() => {
                                if (isPendingDeleteConversation) {
                                  onCancelDeleteConversation();
                                }
                              }}
                            >
                              <button
                                type="button"
                                className={styles.conversationSelect}
                                onClick={() => onSelectConversation(item.id)}
                              >
                                <span className={styles.conversationTitle}>
                                  {conversationPlainTitle(
                                    item,
                                    labels,
                                    uiLanguage
                                  )}
                                </span>
                                <ConversationMeta
                                  item={item}
                                  nowMs={currentTimeMs}
                                  labels={labels}
                                />
                              </button>
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
                                    <span
                                      className={
                                        styles.conversationDeleteConfirmText
                                      }
                                    >
                                      {labels.deleteSessionConfirm}
                                    </span>
                                  </button>
                                ) : (
                                  <>
                                    <BareIconButton
                                      className={styles.conversationPinButton}
                                      aria-label={
                                        (item.pinnedAtUnixMs ?? 0) > 0
                                          ? labels.unpinSession
                                          : labels.pinSession
                                      }
                                      title={
                                        (item.pinnedAtUnixMs ?? 0) > 0
                                          ? labels.unpinSession
                                          : labels.pinSession
                                      }
                                      size="md"
                                      onPointerDown={(event) => {
                                        event.stopPropagation();
                                      }}
                                      onMouseDown={(event) => {
                                        event.stopPropagation();
                                      }}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        onToggleConversationPinned(
                                          item.id,
                                          (item.pinnedAtUnixMs ?? 0) <= 0
                                        );
                                      }}
                                    >
                                      {(item.pinnedAtUnixMs ?? 0) > 0 ? (
                                        <PinFilledIcon aria-hidden="true" />
                                      ) : (
                                        <PinLinedIcon aria-hidden="true" />
                                      )}
                                    </BareIconButton>
                                    <BareIconButton
                                      className={
                                        styles.conversationDeleteButton
                                      }
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
                                        onRequestDeleteConversation(item.id);
                                      }}
                                    >
                                      <CanvasNodeTrashLinedIcon aria-hidden="true" />
                                    </BareIconButton>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </section>
                </Fragment>
              );
            })
          )}
        </ScrollArea>
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

function AgentGUIProjectRailHeader({
  labels,
  workspaceUserProjectI18n
}: {
  labels: Pick<
    AgentGUIViewLabels,
    "projectRailCreateProject" | "projectRailLinkExistingProject"
  >;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
}): React.JSX.Element {
  "use memo";
  const agentHostApi = useAgentHostApi();
  const userProjectApi = useMemo(
    () =>
      agentHostApi.userProjects
        ? {
            ...agentHostApi.userProjects,
            selectDirectory: agentHostApi.workspace.selectDirectory
          }
        : null,
    [agentHostApi.userProjects, agentHostApi.workspace.selectDirectory]
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
  loadingLabel: string;
  empty: React.JSX.Element;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onAuthLogin?: (provider?: string | null) => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
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
    loadingLabel,
    empty,
    onLinkAction,
    onAuthLogin,
    availableSkills,
    workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS,
    labels
  }: AgentGUIConversationTimelinePaneProps): React.JSX.Element {
    "use memo";

    return (
      <AgentConversationFlow
        conversation={conversation}
        isLoading={isLoading}
        loadingLabel={loadingLabel}
        empty={empty}
        onLinkAction={onLinkAction}
        onAuthLogin={onAuthLogin}
        availableSkills={availableSkills}
        workspaceAppIcons={workspaceAppIcons}
        labels={labels}
      />
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
