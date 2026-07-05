import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type FormEvent
} from "react";
import { createPortal, flushSync } from "react-dom";
import type { AgentSessionCommand } from "../../shared/agentSessionTypes";
import type { UiLanguage } from "../../contexts/settings/domain/agentSettings";
import type {
  AgentComposerDraft,
  AgentComposerDraftFile,
  AgentComposerDraftImage,
  AgentGUIComposerSettingsVM,
  AgentGUIProviderSkillOption,
  AgentGUIQueuedPromptVM
} from "./model/agentGuiNodeTypes";
import {
  Popover,
  PopoverAnchor,
  PopoverContent
} from "../../app/renderer/components/ui/popover";
import { Spinner } from "../../app/renderer/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "../../app/renderer/components/ui/tooltip";
import { ZoomableImage } from "../../app/renderer/components/ZoomableImage";
import type { AgentConversationPromptVM } from "../../shared/agentConversation/contracts/agentConversationVM";
import { AgentUsageMeter, agentUsageBarColor } from "./AgentUsageMeter";
import { cn } from "../../app/renderer/lib/utils";
import {
  AddIcon,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@tutti-os/ui-system";
import { ListChecks, Target, X } from "lucide-react";
import {
  createMentionPaletteStateAdapter,
  makeAtPanelKeyDown,
  repairMentionPaletteHighlight
} from "@tutti-os/ui-rich-text/at-panel";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import {
  clampSlashCommandHighlight,
  filterSlashCommands,
  labelForSlashCommand,
  moveSlashCommandHighlight
} from "./model/agentSlashCommands";
import {
  labelForProviderSkill,
  skillDescriptionForDisplay,
  skillTriggerForPrefix
} from "./model/agentSkillOptions";
import {
  draftForProviderSkillTrigger,
  filterProviderSkillsForTrigger,
  getAgentComposerTriggerQueryMatch,
  getPromptStartSlashCommandQuery
} from "./model/agentComposerTriggerQueries";
import {
  agentComposerDraftHasContent,
  agentComposerDraftToPromptContent,
  emptyAgentComposerDraft,
  MAX_AGENT_COMPOSER_DRAFT_IMAGES,
  textPromptContent
} from "./model/agentComposerDraft";
import {
  resolveSlashCommandsForProvider,
  resolveSlashCommandSelectionEffect,
  resolveSlashCommandSubmitEffect,
  resolveTuttiBrowserUseSubmitEffect,
  type AgentSlashCommand,
  type AgentSlashCommandCapability,
  type SlashCommandSelectionEffect
} from "./model/agentSlashCommandProviderPolicy";
import {
  AgentSlashCommandPalette,
  type AgentSlashPaletteEntry
} from "./AgentSlashCommandPalette";
import { AgentInteractivePromptSurface } from "./AgentInteractivePromptSurface";
import { AgentQueuedPromptPanel } from "./AgentQueuedPromptPanel";
import {
  AgentModelReasoningDropdown,
  AgentPermissionModeDropdown,
  AgentProjectDropdown,
  AgentProjectMissingStatusProbe,
  type AgentProjectPathChangeMetadata
} from "./AgentComposerSettingsMenus";
import styles from "./AgentGUINode.styles";
import { AgentChromeNotice } from "./AgentSessionChrome";
import {
  AgentRichTextEditor,
  type AgentRichTextEditorHandle,
  type AgentRichTextPastedImage
} from "./agentRichText/AgentRichTextEditor";
import {
  imageFilesFromDataTransfer,
  nonImageFilesFromDataTransfer,
  systemFileDragInfoFromDataTransfer,
  readAgentRichTextPromptImages
} from "./agentRichText/agentRichTextPromptImages";
import type { AgentPromptContentBlock } from "../../shared/contracts/dto/agentSession";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../shared/AgentMessageMarkdown";
import type { AgentCapabilityTokenOption } from "./agentRichText/agentCapabilityTokenExtension";
import {
  AgentMentionSearchController,
  type AgentMentionFilterId,
  type AgentMentionGroupId,
  type AgentMentionSearchState
} from "./AgentMentionSearchController";
import {
  agentMentionItemKey,
  AgentFileMentionPalette
} from "./AgentFileMentionPalette";
import {
  AGENT_MENTION_FILTER_TAB_ORDER,
  DEFAULT_AGENT_MENTION_FILTER
} from "./agentMentionSearchHelpers";
import {
  exitAgentFileMentionSuggestion,
  parseMentionItemFromHref,
  type AgentContextMentionItem,
  type AgentFileMentionSuggestionState
} from "./agentRichText/agentFileMentionExtension";
import { isAgentRichTextImeComposing } from "./agentRichText/agentRichTextIme";
import {
  resolveWorkspaceLinkAction,
  type WorkspaceLinkAction
} from "../../actions/workspaceLinkActions";
import type { AgentContextMentionProvider } from "./agentContextMentionProvider";
import { hasWorkspaceFileDropData } from "../terminalNode/workspaceFileDrop";
import {
  AgentSlashStatusPanel,
  formatSlashStatusTokenCount
} from "./AgentSlashStatusPanel";
import { AgentReviewPickerPanel } from "./AgentReviewPickerPanel";
import { ComposerFloatingMenuSurface } from "./composerFloatingMenu/ComposerFloatingMenuSurface";
import {
  USAGE_CRITICAL_PERCENT,
  USAGE_WARN_PERCENT
} from "./model/agentUsageThresholds";
import atLinedIconUrl from "../../app/renderer/assets/icons/@-lined-14px.svg";
import { useOptionalAgentActivityRuntime } from "../../agentActivityRuntime";
import { useOptionalAgentHostApi } from "../../agentActivityHost";
import type { AgentDroppedFileReferenceResolver } from "./model/agentDroppedFileReferences";
import type { AgentGUIProvider, AgentGUIProviderTarget } from "../../types";
import { resolvePermissionModeControlsDisabled } from "./model/composerModeSelection";
import {
  MANAGED_AGENT_ICON_FALLBACK_URL,
  MANAGED_AGENT_ICON_URLS
} from "../../shared/managedAgentIcons";
import { normalizeManagedAgentProvider } from "../../shared/managedAgentProviders";

export { formatSlashStatusTokenCount };

const USAGE_POPOVER_HOVER_DELAY_MS = 120;
const DOCK_COMPOSER_INPUT_MIN_HEIGHT = 56;
const DOCK_COMPOSER_TEXT_LINE_HEIGHT = 24;
const DOCK_COMPOSER_MAX_VISIBLE_TEXT_LINES = 3.5;
const DOCK_COMPOSER_INPUT_TEXT_CHROME_HEIGHT = 26;
const DOCK_COMPOSER_TEXT_VIEWPORT_MAX_HEIGHT =
  DOCK_COMPOSER_TEXT_LINE_HEIGHT * DOCK_COMPOSER_MAX_VISIBLE_TEXT_LINES;
const DOCK_COMPOSER_INPUT_MAX_HEIGHT =
  DOCK_COMPOSER_INPUT_TEXT_CHROME_HEIGHT +
  DOCK_COMPOSER_TEXT_VIEWPORT_MAX_HEIGHT;
const DOCK_COMPOSER_INPUT_BORDER_HEIGHT = 2;
const DOCK_COMPOSER_INPUT_PADDING_BLOCK_HEIGHT = 24;

/**
 * 引用 picker 的确认结果:松散文件按 file mention 插入;mentionItems(如文件夹 bundle)
 * 作为整体节点插入。两者各走各的插入路径,composer 不需要理解 bundle 内部结构。
 */
export interface WorkspaceReferencePickResult {
  files: readonly WorkspaceFileReference[];
  mentionItems: readonly AgentContextMentionItem[];
}

export interface AgentComposerProps {
  workspaceId: string;
  workspacePath?: string | null;
  currentUserId?: string | null;
  provider: string;
  selectedProviderTarget?: AgentGUIProviderTarget | null;
  providerTargets?: readonly AgentGUIProviderTarget[];
  providerSelectReadonly?: boolean;
  slashStatus?: AgentComposerSlashStatus | null;
  usage?: AgentComposerUsage | null;
  draftContent: AgentComposerDraft;
  availableCommands: readonly AgentSessionCommand[];
  hasCompactableContext?: boolean;
  compactSupported?: boolean | null;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  disabled: boolean;
  disabledReason?: string | null;
  /**
   * False while submitting is about to start a brand-new conversation (no
   * active conversation yet). Starting one is async (session creation +
   * activation round trip), so the composer must NOT eagerly clear its own
   * draft echo on submit in that case — the view would otherwise show a
   * gap where the input is empty and nothing has happened yet. Defaults to
   * true so existing/test call sites keep today's immediate-clear behavior.
   */
  hasActiveConversation?: boolean;
  submitDisabled: boolean;
  placeholder: string;
  composerSettings: AgentGUIComposerSettingsVM;
  queuedPrompts: readonly AgentGUIQueuedPromptVM[];
  drainingQueuedPromptId: string | null;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  canQueueWhileBusy: boolean;
  showStopButton: boolean;
  activePrompt: AgentConversationPromptVM | null;
  backgroundAgentStatusText?: string | null;
  activePromptKeyboardShortcutsEnabled?: boolean;
  promptTips?: readonly AgentComposerPromptTip[];
  isInterrupting: boolean;
  isSendingTurn: boolean;
  isSubmittingPrompt: boolean;
  uiLanguage?: UiLanguage;
  isActive?: boolean;
  previewMode?: boolean;
  workspaceReferencePickerOpen?: boolean;
  promptImagesSupported?: boolean;
  composerFocusRequestSequence?: number | null;
  layoutMode?: "dock" | "hero";
  labels: {
    send: string;
    modelLabel: string;
    modelSelectionLabel: string;
    modelContextWindowSuffix: string;
    modelTooltipVersionLabel: string;
    defaultModel: string;
    loadingOptions: string;
    inheritedUnavailable: string;
    loadingConversation: string;
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
    goalLabel: string;
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
    queuedLabel: string;
    sendQueuedPromptNext: string;
    editQueuedPrompt: string;
    deleteQueuedPrompt: string;
    queuedPromptMoreActions: string;
    stop: string;
    stopping: string;
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
    fileMentionPalette: string;
    fileMentionLoading: string;
    fileMentionEmpty: string;
    fileMentionError: string;
    fileMentionTabHint: string;
    mentionPalette: string;
    removeMention: string;
    addReference: string;
    addContent: string;
    referenceWorkspaceFiles: string;
    providerSwitchLabel: string;
    projectLocked: string;
    projectMissingDescription: string;
    promptTipsPrefix: string;
    reviewPicker: {
      title: string;
      targetLabel: string;
      searchPlaceholder: string;
      noResults: string;
      uncommitted: string;
      baseBranch: string;
      commit: string;
      custom: string;
      branchLabel: string;
      branchPlaceholder: string;
      branchLoading: string;
      branchEmpty: string;
      commitPlaceholder: string;
      customPlaceholder: string;
      submit: string;
      cancel: string;
    };
  };
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
  onDraftContentChange: (draftContent: AgentComposerDraft) => void;
  onProjectPathChange?: (
    path: string | null,
    metadata?: AgentProjectPathChangeMetadata
  ) => void;
  onSettingsChange: (settings: {
    model?: string | null;
    reasoningEffort?: string | null;
    speed?: string | null;
    planMode?: boolean;
    browserUse?: boolean;
    computerUse?: boolean;
    permissionModeId?: string | null;
  }) => void;
  onProviderSelect?: (input: {
    provider: AgentGUIProvider;
    providerTargetId?: string | null;
  }) => void;
  capabilityMenuState?: AgentComposerCapabilityMenuState;
  onCapabilitySettingsRequest?: (
    capability: AgentComposerCapabilitySettingsTarget
  ) => void;
  onSubmit: (
    content: AgentPromptContentBlock[],
    displayPrompt?: string
  ) => void;
  onSubmitGuidance?: (
    content: AgentPromptContentBlock[],
    displayPrompt?: string
  ) => void;
  onSendQueuedPromptNext: (queuedPromptId: string) => void;
  onRemoveQueuedPrompt: (queuedPromptId: string) => void;
  onEditQueuedPrompt: (queuedPromptId: string) => void;
  onInterruptCurrentTurn: () => void;
  onPromptImagesUnsupported?: () => void;
  onSubmitInteractivePrompt: (input: {
    requestId: string;
    action?: string;
    optionId?: string;
    payload?: Record<string, unknown>;
  }) => void;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onRequestWorkspaceReferences?:
    | ((
        entity?: AgentContextMentionItem | null
      ) => Promise<WorkspaceReferencePickResult>)
    | null;
  resolveDroppedFileReferences?: AgentDroppedFileReferenceResolver | null;
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  onRequestGitBranches?: AgentComposerGitBranchLoader | null;
  contextMentionProviders?: readonly AgentContextMentionProvider[];
}

export type AgentComposerCapabilitySettingsTarget =
  AgentSlashCommandCapability["capability"];

export interface AgentComposerCapabilityMenuState {
  browserUse?: {
    connectionMode?: "autoConnect" | "isolated" | null;
  };
  computerUse?: {
    authorization?: AgentComposerComputerUseAuthorizationState | null;
    installed?: boolean | null;
  };
}

export type AgentComposerComputerUseAuthorizationState =
  | "authorized"
  | "needs-authorization"
  | "unknown";

export interface AgentComposerGitBranches {
  branches: readonly string[];
  currentBranch?: string | null;
}

export type AgentComposerGitBranchLoader = (input: {
  agentSessionId?: string | null;
  workingDirectory?: string | null;
}) => Promise<AgentComposerGitBranches>;

export interface AgentComposerPromptTip {
  id: string;
  label: string;
  prompt: string;
}

export interface AgentComposerSlashStatus {
  agentSessionId?: string | null;
  baseUrl?: string | null;
  contextWindow?: {
    usedTokens?: number | null;
    totalTokens?: number | null;
  } | null;
  limits?: readonly AgentComposerSlashStatusLimit[];
  limitsLoading?: boolean;
}

export interface AgentComposerSlashStatusLimit {
  id: string;
  label: string;
  percentRemaining?: number | null;
  value: string;
  reset?: string | null;
}

export interface AgentComposerUsage {
  percentUsed: number | null;
  usedTokens: number | null;
  totalTokens: number | null;
}

type AgentUsageChipLevel = "normal" | "warning" | "critical";

function agentUsageChipLevel(percentUsed: number): AgentUsageChipLevel {
  if (percentUsed >= USAGE_CRITICAL_PERCENT) {
    return "critical";
  }
  if (percentUsed >= USAGE_WARN_PERCENT) {
    return "warning";
  }
  return "normal";
}

function agentUsageRingColor(level: AgentUsageChipLevel): string {
  if (level === "critical") {
    return "var(--state-danger)";
  }
  if (level === "warning") {
    return "var(--state-warning)";
  }
  return "var(--text-secondary)";
}

function AgentUsageChip({
  percentUsed,
  usedTokens,
  totalTokens,
  labels,
  tooltipsEnabled = true,
  onCompact,
  compactSupported,
  compactDisabled
}: {
  percentUsed: number;
  usedTokens: number | null;
  totalTokens: number | null;
  tooltipsEnabled?: boolean;
  onCompact?: () => void;
  compactSupported?: boolean;
  compactDisabled?: boolean;
  labels: Pick<
    AgentComposerProps["labels"],
    | "usageChipLabel"
    | "usageTooltipLabel"
    | "usagePopoverTitle"
    | "usageContextWindowLabel"
    | "usageCompactAction"
  >;
}): React.JSX.Element {
  "use memo";

  const [usagePopoverOpen, setUsagePopoverOpen] = useState(false);
  const usagePopoverHoverTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const usagePopoverContentRef = useRef<HTMLDivElement | null>(null);
  const clampedPercent = Math.max(0, Math.min(100, percentUsed));
  const chipLabel = labels.usageChipLabel({ percent: clampedPercent });
  const showTokens = usedTokens !== null && totalTokens !== null;
  const usageLevel = agentUsageChipLevel(clampedPercent);
  const ringColor = agentUsageRingColor(usageLevel);
  const usagePopoverCloseTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const clearUsagePopoverHoverTimer = useCallback(() => {
    if (usagePopoverHoverTimerRef.current) {
      clearTimeout(usagePopoverHoverTimerRef.current);
      usagePopoverHoverTimerRef.current = null;
    }
  }, []);
  const clearUsagePopoverCloseTimer = useCallback(() => {
    if (usagePopoverCloseTimerRef.current) {
      clearTimeout(usagePopoverCloseTimerRef.current);
      usagePopoverCloseTimerRef.current = null;
    }
  }, []);
  const openUsagePopover = useCallback(() => {
    clearUsagePopoverHoverTimer();
    clearUsagePopoverCloseTimer();
    setUsagePopoverOpen(true);
  }, [clearUsagePopoverCloseTimer, clearUsagePopoverHoverTimer]);
  const openUsagePopoverAfterHoverDelay = useCallback(() => {
    clearUsagePopoverHoverTimer();
    clearUsagePopoverCloseTimer();
    usagePopoverHoverTimerRef.current = setTimeout(() => {
      usagePopoverHoverTimerRef.current = null;
      setUsagePopoverOpen(true);
    }, USAGE_POPOVER_HOVER_DELAY_MS);
  }, [clearUsagePopoverCloseTimer, clearUsagePopoverHoverTimer]);
  const closeUsagePopover = useCallback(() => {
    clearUsagePopoverHoverTimer();
    clearUsagePopoverCloseTimer();
    setUsagePopoverOpen(false);
  }, [clearUsagePopoverCloseTimer, clearUsagePopoverHoverTimer]);
  const scheduleUsagePopoverClose = useCallback(() => {
    clearUsagePopoverHoverTimer();
    clearUsagePopoverCloseTimer();
    usagePopoverCloseTimerRef.current = setTimeout(() => {
      usagePopoverCloseTimerRef.current = null;
      setUsagePopoverOpen(false);
    }, 140);
  }, [clearUsagePopoverCloseTimer, clearUsagePopoverHoverTimer]);
  const handleUsagePopoverOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        openUsagePopover();
        return;
      }
      closeUsagePopover();
    },
    [closeUsagePopover, openUsagePopover]
  );
  const handleUsageTriggerBlur = useCallback(
    (event: ReactFocusEvent<HTMLButtonElement>) => {
      const nextFocusTarget = event.relatedTarget;
      if (
        nextFocusTarget instanceof Node &&
        usagePopoverContentRef.current?.contains(nextFocusTarget)
      ) {
        clearUsagePopoverHoverTimer();
        clearUsagePopoverCloseTimer();
        return;
      }
      closeUsagePopover();
    },
    [
      clearUsagePopoverCloseTimer,
      clearUsagePopoverHoverTimer,
      closeUsagePopover
    ]
  );

  useEffect(
    () => () => {
      clearUsagePopoverHoverTimer();
      clearUsagePopoverCloseTimer();
    },
    [clearUsagePopoverCloseTimer, clearUsagePopoverHoverTimer]
  );
  const trigger = (
    <button
      type="button"
      aria-label={chipLabel}
      className={cn(
        "nodrag relative mr-2 inline-flex size-4 shrink-0 items-center justify-center rounded-full p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text-primary)_34%,transparent)] [-webkit-app-region:no-drag]",
        tooltipsEnabled ? "cursor-pointer" : "cursor-default"
      )}
      data-testid="agent-gui-usage-chip"
      data-usage-level={usageLevel}
      onBlur={tooltipsEnabled ? handleUsageTriggerBlur : undefined}
      onFocus={tooltipsEnabled ? openUsagePopoverAfterHoverDelay : undefined}
      onPointerEnter={(event) => {
        if (tooltipsEnabled && event.pointerType !== "touch") {
          openUsagePopoverAfterHoverDelay();
        }
      }}
      onPointerLeave={tooltipsEnabled ? scheduleUsagePopoverClose : undefined}
      title={chipLabel}
      style={{
        background: `conic-gradient(${ringColor} ${clampedPercent}%, color-mix(in srgb, ${ringColor} 16%, transparent) 0)`
      }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-0.5 rounded-full bg-[var(--agent-gui-surface-raised,var(--background-fronted))]"
      />
    </button>
  );

  if (!tooltipsEnabled) {
    return trigger;
  }

  return (
    <Popover
      open={usagePopoverOpen}
      onOpenChange={handleUsagePopoverOpenChange}
    >
      <PopoverAnchor asChild>{trigger}</PopoverAnchor>
      {usagePopoverOpen ? (
        <PopoverContent
          ref={usagePopoverContentRef}
          side="bottom"
          align="end"
          className="w-[320px] max-w-[calc(100vw-32px)] gap-3 text-xs"
          data-testid="agent-gui-usage-popover"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={openUsagePopover}
          onPointerLeave={scheduleUsagePopoverClose}
        >
          <div className="flex min-w-0 flex-col gap-3">
            <span className="text-[13px] font-semibold leading-4">
              {labels.usagePopoverTitle}
            </span>
            {showTokens ? (
              <AgentUsageMeter
                label={labels.usageContextWindowLabel}
                value={`${formatSlashStatusTokenCount(usedTokens)} / ${formatSlashStatusTokenCount(totalTokens)} (${clampedPercent}%)`}
                percent={clampedPercent}
                barColor={agentUsageBarColor(clampedPercent)}
                testId="agent-gui-usage-context-meter"
              />
            ) : null}
            {compactSupported && onCompact ? (
              <Button
                type="button"
                data-testid="agent-gui-compact-button"
                disabled={compactDisabled}
                className="nodrag w-full font-medium [-webkit-app-region:no-drag]"
                size="sm"
                variant="secondary"
                onClick={onCompact}
              >
                {labels.usageCompactAction}
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

const composerStyles = {
  footerGroup: styles.composerFooterLeft,
  footerGroupRight: styles.composerFooterRight,
  dropdownSurface:
    "nodrag isolate rounded-[12px] border border-hairline bg-background-fronted p-[4px] text-foreground shadow-[var(--shadow-panel)] [-webkit-app-region:no-drag]"
};

const workspaceReferenceSelectValue = "__tutti_workspace_reference_idle__";
const workspaceReferenceOptionValue = "__tutti_workspace_reference_add__";
const composerPaletteZIndex = "var(--z-popover)";
const SLASH_PALETTE_HEIGHT_PX = 280;
const MENTION_PALETTE_MIN_HEIGHT_PX = 280;
const MENTION_PALETTE_MAX_HEIGHT_PX = 320;
const MENTION_PALETTE_GAP_PX = 8;
const MENTION_PALETTE_VIEWPORT_PADDING_PX = 8;
const DRAFT_IMAGE_PREVIEW_BASE_HEIGHT_PX = 72;
const DRAFT_IMAGE_PREVIEW_MIN_WIDTH_PX = 56;
const DRAFT_IMAGE_PREVIEW_MAX_WIDTH_PX = 180;
const DRAFT_IMAGE_PREVIEW_MIN_RATIO = 0.5;
const DRAFT_IMAGE_PREVIEW_MAX_RATIO = 3;
const EMPTY_CONTEXT_MENTION_PROVIDERS: readonly AgentContextMentionProvider[] =
  [];
const EMPTY_PROMPT_TIPS: readonly AgentComposerPromptTip[] = [];
const EMPTY_PROVIDER_SKILLS: readonly AgentGUIProviderSkillOption[] = [];
const EMPTY_WORKSPACE_APP_ICONS: readonly AgentMessageMarkdownWorkspaceAppIcon[] =
  [];
const GOAL_MODE_SLASH_COMMAND = "/goal";
const PROMPT_TIP_CYCLE_STEP_MS = 5_200;
const MENTION_PALETTE_DISMISS_INTERACTION_SELECTOR = [
  "[data-node-drag-handle]",
  '[data-workbench-drag-handle="true"]',
  ".workspace-node-window__resizer",
  ".workbench-window__resize-handle",
  "#agent-gui-conversation-rail-resize"
].join(",");

interface MentionPaletteFrame {
  height: number;
  left: number;
  portalTarget: Element;
  top: number;
  width: number;
  zIndex: number | string;
}

function resolveMentionPalettePortalTarget(anchor: HTMLElement): Element {
  return (
    anchor.closest('[data-slot="viewport-menu-boundary"]') ??
    anchor.closest(
      "[data-workbench-window-id], [data-workspace-node-window-root='true']"
    ) ??
    document.body
  );
}

function resolveMentionPaletteZIndex(anchor: HTMLElement): number | string {
  let current: HTMLElement | null = anchor;
  while (current) {
    if (
      current.matches(
        "[data-workbench-window-id], [data-workspace-node-window-root='true']"
      )
    ) {
      const windowZIndex = Number.parseInt(
        window.getComputedStyle(current).zIndex,
        10
      );
      if (Number.isFinite(windowZIndex)) {
        return windowZIndex + 1;
      }
    }
    current = current.parentElement;
  }
  return composerPaletteZIndex;
}

function hasInlineOverflow(element: HTMLElement | null): boolean {
  if (!element) {
    return false;
  }

  return element.scrollWidth > element.clientWidth + 1;
}

function resolveComposerProviderIconUrl(provider: string): string {
  const normalizedProvider = normalizeManagedAgentProvider(provider);
  return (
    MANAGED_AGENT_ICON_URLS[normalizedProvider] ??
    MANAGED_AGENT_ICON_FALLBACK_URL
  );
}

function resolveComposerProviderTargetIconUrl(
  target: AgentGUIProviderTarget
): string {
  return (
    target.iconUrl?.trim() || resolveComposerProviderIconUrl(target.provider)
  );
}

export function AgentComposer({
  workspaceId,
  workspacePath,
  currentUserId,
  provider,
  selectedProviderTarget = null,
  providerTargets = [],
  providerSelectReadonly = false,
  slashStatus = null,
  usage = null,
  draftContent,
  availableCommands,
  hasCompactableContext = true,
  compactSupported = null,
  availableSkills = EMPTY_PROVIDER_SKILLS,
  disabled,
  disabledReason,
  hasActiveConversation = true,
  submitDisabled,
  placeholder,
  composerSettings,
  queuedPrompts,
  drainingQueuedPromptId,
  workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS,
  canQueueWhileBusy,
  showStopButton,
  activePrompt,
  backgroundAgentStatusText = null,
  activePromptKeyboardShortcutsEnabled = true,
  promptTips = EMPTY_PROMPT_TIPS,
  isInterrupting,
  isSendingTurn,
  isSubmittingPrompt,
  uiLanguage = "en",
  isActive = true,
  previewMode = false,
  workspaceReferencePickerOpen = false,
  promptImagesSupported = true,
  composerFocusRequestSequence = null,
  layoutMode = "dock",
  labels,
  workspaceUserProjectI18n,
  onDraftContentChange,
  onProjectPathChange = () => {},
  onSettingsChange,
  onProviderSelect,
  capabilityMenuState,
  onSubmit,
  onSubmitGuidance,
  onSendQueuedPromptNext,
  onRemoveQueuedPrompt,
  onEditQueuedPrompt,
  onInterruptCurrentTurn,
  onPromptImagesUnsupported,
  onSubmitInteractivePrompt,
  onCapabilitySettingsRequest,
  onLinkAction,
  onRequestWorkspaceReferences = null,
  resolveDroppedFileReferences = null,
  selectProjectDirectory,
  onRequestGitBranches = null,
  contextMentionProviders = EMPTY_CONTEXT_MENTION_PROVIDERS
}: AgentComposerProps): React.JSX.Element {
  "use memo";
  const draftPrompt = draftContent.prompt;
  const goalDraftObjective = goalDraftObjectiveFromPrompt(draftPrompt);
  const isGoalModeActive = goalDraftObjective !== null;
  const draftImages = draftContent.images;
  const draftFiles = draftContent.files ?? [];
  const agentActivityRuntime = useOptionalAgentActivityRuntime();
  const agentHostApi = useOptionalAgentHostApi();
  const getReferenceForFile = agentHostApi?.workspace.getReferenceForFile;
  const promptFileUploadSupported = Boolean(
    agentActivityRuntime?.uploadPromptContent &&
    (agentActivityRuntime.promptContentUploadSupport?.file ?? true)
  );
  const promptFilesSupported = Boolean(
    resolveDroppedFileReferences && promptFileUploadSupported
  );
  const [isPaletteOpen, setIsPaletteOpen] = useState(true);
  const [isReviewPickerOpen, setIsReviewPickerOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [mentionHighlightedKey, setMentionHighlightedKey] = useState<
    string | null
  >(null);
  const [shouldCenterMentionHighlight, setShouldCenterMentionHighlight] =
    useState(false);
  const [
    shouldResetMentionHighlightToFilter,
    setShouldResetMentionHighlightToFilter
  ] = useState(false);
  const [paletteDraftPrompt, setPaletteDraftPrompt] = useState(
    goalDraftObjective ?? draftPrompt
  );
  const [fileMentionSuggestion, setFileMentionSuggestion] =
    useState<AgentFileMentionSuggestionState | null>(null);
  const [isSelectedProjectMissing, setIsSelectedProjectMissing] =
    useState(false);
  const [isSlashStatusPanelOpen, setIsSlashStatusPanelOpen] = useState(false);
  const slashStatusAgentSessionId = slashStatus?.agentSessionId ?? null;
  const previousSlashStatusAgentSessionIdRef = useRef<string | null>(
    slashStatusAgentSessionId
  );
  const selectedProjectPath =
    composerSettings.selectedProjectPath?.trim() ?? "";
  const previousSelectedProjectPathRef = useRef(selectedProjectPath);
  const [mentionSearchState, setMentionSearchState] =
    useState<AgentMentionSearchState>({
      status: "idle",
      query: "",
      mode: "browse",
      filter: DEFAULT_AGENT_MENTION_FILTER,
      categories: [],
      groups: [],
      error: null
    });
  const composerRef = useRef<HTMLFormElement | null>(null);
  const inputShellRef = useRef<HTMLDivElement | null>(null);
  const promptInputAreaRef = useRef<HTMLDivElement | null>(null);
  const paletteContentRef = useRef<HTMLDivElement | null>(null);
  const draftPromptRef = useRef(draftPrompt);
  const draftImagesRef = useRef<AgentComposerDraftImage[]>(draftImages);
  const draftFilesRef = useRef<AgentComposerDraftFile[]>(draftFiles);
  const promptTipRef = useRef<HTMLSpanElement | null>(null);
  const mentionControllerRef = useRef<AgentMentionSearchController | null>(
    null
  );
  const editorHandleRef = useRef<AgentRichTextEditorHandle | null>(null);
  const wasActiveRef = useRef(isActive);
  const lastComposerFocusRequestRef = useRef<number | null>(null);
  const autoMentionHighlightedKeyRef = useRef<string | null>(null);
  const [isPromptTipOverflowing, setIsPromptTipOverflowing] = useState(false);
  const [dockComposerInputHeight, setDockComposerInputHeight] = useState(
    DOCK_COMPOSER_INPUT_MIN_HEIGHT
  );
  const [dockComposerInputMaxHeight, setDockComposerInputMaxHeight] = useState(
    DOCK_COMPOSER_INPUT_MAX_HEIGHT
  );
  const [dockComposerAttachmentHeight, setDockComposerAttachmentHeight] =
    useState(0);
  const [dockComposerTextHeight, setDockComposerTextHeight] = useState(
    DOCK_COMPOSER_INPUT_MIN_HEIGHT
  );
  const slashQuery = isGoalModeActive
    ? null
    : getPromptStartSlashCommandQuery(paletteDraftPrompt);
  const promptBeforeSelection =
    editorHandleRef.current?.getPromptTextBeforeSelection() ?? "";
  const skillQueryDraft = promptBeforeSelection || paletteDraftPrompt;
  const skillQueryMatch = getAgentComposerTriggerQueryMatch(skillQueryDraft);
  const resolvedSlashCommands = useMemo(
    () =>
      resolveSlashCommandsForProvider({
        provider,
        commands: availableCommands,
        hasCompactableContext,
        compactSupported,
        planSupported: composerSettings.supportsPlanMode,
        browserSupported: Boolean(composerSettings.supportsBrowser),
        computerSupported: Boolean(composerSettings.supportsComputerUse)
      }),
    [
      availableCommands,
      compactSupported,
      composerSettings.supportsPlanMode,
      composerSettings.supportsBrowser,
      composerSettings.supportsComputerUse,
      hasCompactableContext,
      provider
    ]
  );
  const filteredCommands = useMemo(
    () =>
      slashQuery === null
        ? []
        : filterSlashCommands(resolvedSlashCommands, slashQuery),
    [resolvedSlashCommands, slashQuery]
  );
  const filteredSkills = useMemo(
    () =>
      skillQueryMatch === null
        ? []
        : filterProviderSkillsForTrigger({
            skills: availableSkills,
            query: skillQueryMatch.query,
            triggerPrefix: skillQueryMatch.prefix
          }),
    [availableSkills, skillQueryMatch]
  );
  const availableCapabilities = useMemo<AgentCapabilityTokenOption[]>(() => {
    const entries: AgentCapabilityTokenOption[] = [];
    if (composerSettings.supportsBrowser) {
      entries.push({
        capability: "browserUse",
        label: labels.browserUseCapabilityLabel,
        name: "browser",
        trigger: "/browser"
      });
    }
    if (composerSettings.supportsComputerUse) {
      entries.push({
        capability: "computerUse",
        label: labels.computerUseCapabilityLabel,
        name: "computer",
        trigger: "/computer"
      });
    }
    return entries;
  }, [
    composerSettings.supportsBrowser,
    composerSettings.supportsComputerUse,
    labels.browserUseCapabilityLabel,
    labels.computerUseCapabilityLabel
  ]);
  const slashPaletteEntries = useMemo<AgentSlashPaletteEntry[]>(() => {
    const commandEntries: AgentSlashPaletteEntry[] =
      filteredCommands.flatMap<AgentSlashPaletteEntry>((command) => {
        if (isSlashCommandCapability(command)) {
          const browserConnectionMode =
            capabilityMenuState?.browserUse?.connectionMode ?? null;
          const computerUseInstalled =
            capabilityMenuState?.computerUse?.installed ?? null;
          const computerUseAuthorization =
            capabilityMenuState?.computerUse?.authorization ?? null;
          const capLabel =
            command.capability === "computerUse"
              ? labels.computerUseCapabilityLabel
              : labels.browserUseCapabilityLabel;
          const capDescription =
            command.capability === "computerUse"
              ? computerUseInstalled === false
                ? labels.computerUseCapabilitySetupRequiredDescription
                : computerUseAuthorization === "needs-authorization"
                  ? labels.computerUseCapabilityAuthorizationRequiredDescription
                  : computerUseAuthorization === "unknown"
                    ? labels.computerUseCapabilityAuthorizationUnknownDescription
                    : labels.computerUseCapabilityDescription
              : browserConnectionMode === "autoConnect"
                ? labels.browserUseCapabilityDescriptionAutoConnect
                : browserConnectionMode === "isolated"
                  ? labels.browserUseCapabilityDescriptionIsolated
                  : labels.browserUseCapabilityDescription;
          const capSettingsLabel =
            command.capability === "computerUse"
              ? labels.computerUseCapabilitySettingsLabel
              : labels.browserUseCapabilitySettingsLabel;
          const capabilityEntry: AgentSlashPaletteEntry = {
            type: "capability",
            key: `capability:${command.capability}`,
            label: capLabel,
            description: capDescription,
            settingsAriaLabel: capSettingsLabel,
            settingsLabel: labels.capabilityInlineSettingsLabel,
            selectAction:
              command.capability === "computerUse" &&
              (computerUseInstalled === false ||
                (computerUseInstalled === true &&
                  (computerUseAuthorization === "needs-authorization" ||
                    computerUseAuthorization === "unknown")))
                ? "settings"
                : "capability",
            capability: command
          };
          return [capabilityEntry];
        }
        const commandDescription = slashCommandDescriptionForDisplay(
          command,
          labels
        );
        const commandEntry: AgentSlashPaletteEntry = {
          type: "command",
          key: `command:${command.name}`,
          label: labelForSlashCommand(command),
          ...slashCommandLabelForDisplay(command, labels, uiLanguage),
          ...(commandDescription ? { description: commandDescription } : {}),
          command
        };
        return [commandEntry];
      });
    const skillEntries: AgentSlashPaletteEntry[] = filteredSkills.map(
      (skill) => {
        const trigger = skillTriggerForPrefix(skill, skillQueryMatch?.prefix);
        return {
          type: "skill",
          key: `skill:${trigger}`,
          label: labelForProviderSkill(skill, skillQueryMatch?.prefix),
          ...(skillDescriptionForDisplay(skill.description)
            ? { description: skillDescriptionForDisplay(skill.description) }
            : {}),
          skill
        };
      }
    );
    return [...commandEntries, ...skillEntries];
  }, [
    capabilityMenuState?.browserUse?.connectionMode,
    capabilityMenuState?.computerUse?.authorization,
    capabilityMenuState?.computerUse?.installed,
    filteredCommands,
    filteredSkills,
    labels.browserUseCapabilityDescription,
    labels.browserUseCapabilityDescriptionAutoConnect,
    labels.browserUseCapabilityDescriptionIsolated,
    labels.browserUseCapabilityLabel,
    labels.capabilityInlineSettingsLabel,
    labels.browserUseCapabilitySettingsLabel,
    labels.computerUseCapabilityDescription,
    labels.computerUseCapabilityAuthorizationRequiredDescription,
    labels.computerUseCapabilityAuthorizationUnknownDescription,
    labels.computerUseCapabilitySetupRequiredDescription,
    labels.computerUseCapabilityLabel,
    labels.computerUseCapabilitySettingsLabel,
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
    uiLanguage,
    skillQueryMatch?.prefix
  ]);
  const showFileMentionPalette =
    !disabled && isPaletteOpen && fileMentionSuggestion !== null;
  const showSlashPalette =
    !showFileMentionPalette &&
    !disabled &&
    isPaletteOpen &&
    ((slashQuery !== null && slashPaletteEntries.length > 0) ||
      (slashQuery === null &&
        skillQueryMatch !== null &&
        filteredSkills.length > 0));
  const showPalette = showFileMentionPalette || showSlashPalette;
  const showCommandMenuPanel = isSlashStatusPanelOpen || isReviewPickerOpen;
  const showFloatingCommandMenu = showSlashPalette || showCommandMenuPanel;
  const activeHighlight = clampSlashCommandHighlight(
    highlightedIndex,
    slashPaletteEntries.length
  );
  const [mentionPaletteFrame, setMentionPaletteFrame] =
    useState<MentionPaletteFrame | null>(null);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [skillQueryMatch?.prefix, skillQueryMatch?.query, slashQuery]);

  useEffect(() => {
    const preferredKey =
      shouldResetMentionHighlightToFilter &&
      mentionSearchState.mode === "browse"
        ? `category:${mentionSearchState.filter}`
        : null;
    if (shouldResetMentionHighlightToFilter) {
      const nextKey = repairMentionPaletteHighlight({
        state: mentionSearchState,
        currentKey: null,
        preferredKey,
        getItemKey: agentMentionItemKey
      });
      autoMentionHighlightedKeyRef.current = nextKey;
      setMentionHighlightedKey(nextKey);
      setShouldResetMentionHighlightToFilter(false);
      return;
    }
    setMentionHighlightedKey((current) => {
      const nextKey = repairMentionPaletteHighlight({
        state: mentionSearchState,
        currentKey: current,
        getItemKey: agentMentionItemKey
      });
      if (
        nextKey === current &&
        current !== autoMentionHighlightedKeyRef.current
      ) {
        return current;
      }
      autoMentionHighlightedKeyRef.current = nextKey;
      return nextKey;
    });
  }, [
    mentionSearchState.filter,
    mentionSearchState.mode,
    mentionSearchState,
    shouldResetMentionHighlightToFilter
  ]);

  useEffect(() => {
    const controller = new AgentMentionSearchController({
      contextMentionProviders
    });
    mentionControllerRef.current = controller;
    const unsubscribe = controller.subscribe(setMentionSearchState);
    return () => {
      unsubscribe();
      controller.dispose();
      mentionControllerRef.current = null;
    };
  }, [contextMentionProviders]);

  useEffect(() => {
    const isExternalDraftReplacement = draftPromptRef.current !== draftPrompt;
    draftPromptRef.current = draftPrompt;
    setPaletteDraftPrompt(goalDraftObjective ?? draftPrompt);
    if (isExternalDraftReplacement && draftPrompt) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          editorHandleRef.current?.focusAtStart();
        });
      });
    }
  }, [draftPrompt, goalDraftObjective]);

  useEffect(() => {
    draftImagesRef.current = draftImages;
  }, [draftImages]);

  useEffect(() => {
    draftFilesRef.current = draftFiles;
  }, [draftFiles]);

  useEffect(() => {
    if (
      previousSlashStatusAgentSessionIdRef.current === slashStatusAgentSessionId
    ) {
      return;
    }
    previousSlashStatusAgentSessionIdRef.current = slashStatusAgentSessionId;
    setIsSlashStatusPanelOpen(false);
  }, [slashStatusAgentSessionId]);

  const clearSlashCommandDraft = useCallback((): void => {
    draftPromptRef.current = "";
    setPaletteDraftPrompt("");
    setIsPaletteOpen(false);
    onDraftContentChange(emptyAgentComposerDraft());
  }, [onDraftContentChange]);

  const closeSlashStatusPanel = useCallback((): void => {
    setIsSlashStatusPanelOpen(false);
  }, []);

  const settingsControlsDisabled =
    isSendingTurn || isSubmittingPrompt || showStopButton;
  const permissionModeControlsDisabled = resolvePermissionModeControlsDisabled({
    provider,
    isSendingTurn,
    isSubmittingPrompt,
    showStopButton
  });
  const composerControlsHardDisabled =
    isSelectedProjectMissing ||
    isSubmittingPrompt ||
    (disabled && !isSendingTurn && !showStopButton);

  const closeReviewPicker = useCallback((): void => {
    setIsReviewPickerOpen(false);
  }, []);

  const closeSlashFloatingMenu = useCallback((): void => {
    setIsSlashStatusPanelOpen(false);
    setIsReviewPickerOpen(false);
    setIsPaletteOpen(false);
  }, []);

  const submitReviewCommand = useCallback(
    (command: string): void => {
      setIsReviewPickerOpen(false);
      clearSlashCommandDraft();
      onSubmit(textPromptContent(command));
    },
    [clearSlashCommandDraft, onSubmit]
  );

  // Bind the branch loader to this composer's session so the picker can fetch
  // branches without the caller having to know the active agent session id.
  const reviewBranchLoader = useMemo(() => {
    if (!onRequestGitBranches) {
      return null;
    }
    // Prefer the live agent session (its daemon-resolved cwd); fall back to the
    // selected project path so the review picker still lists branches in the
    // empty-hero composer before any session exists.
    if (slashStatusAgentSessionId) {
      return () =>
        onRequestGitBranches({ agentSessionId: slashStatusAgentSessionId });
    }
    if (selectedProjectPath) {
      return () =>
        onRequestGitBranches({ workingDirectory: selectedProjectPath });
    }
    return null;
  }, [onRequestGitBranches, selectedProjectPath, slashStatusAgentSessionId]);

  const executeSlashCommandEffect = useCallback(
    (effect: SlashCommandSelectionEffect): void => {
      if (effect.kind === "submitPrompt") {
        clearSlashCommandDraft();
        if (effect.enableBrowserUse && !settingsControlsDisabled) {
          onSettingsChange({ browserUse: true });
        }
        if (effect.displayPrompt) {
          onSubmit(textPromptContent(effect.prompt), effect.displayPrompt);
        } else {
          onSubmit(textPromptContent(effect.prompt));
        }
        return;
      }
      if (effect.kind === "showStatus") {
        clearSlashCommandDraft();
        setIsReviewPickerOpen(false);
        setIsSlashStatusPanelOpen((current) => !current);
        return;
      }
      if (effect.kind === "showReviewPicker") {
        clearSlashCommandDraft();
        setIsSlashStatusPanelOpen(false);
        setIsReviewPickerOpen(true);
        return;
      }
      if (effect.kind === "activateGoalMode") {
        draftPromptRef.current = GOAL_MODE_SLASH_COMMAND;
        setPaletteDraftPrompt("");
        setIsSlashStatusPanelOpen(false);
        setIsReviewPickerOpen(false);
        setIsPaletteOpen(false);
        onDraftContentChange({
          ...draftContent,
          prompt: GOAL_MODE_SLASH_COMMAND
        });
        return;
      }
      if (effect.kind === "togglePlanMode") {
        clearSlashCommandDraft();
        onSettingsChange({
          planMode: !composerSettings.draftSettings.planMode
        });
        return;
      }
      if (effect.kind === "enableBrowserUse") {
        const nextDraft = effect.draft;
        draftPromptRef.current = nextDraft;
        setPaletteDraftPrompt(nextDraft);
        onDraftContentChange({ ...draftContent, prompt: nextDraft });
        setIsPaletteOpen(false);
        if (!settingsControlsDisabled) {
          onSettingsChange({ browserUse: true });
        }
        return;
      }
      if (effect.kind === "enableComputerUse") {
        const nextDraft = effect.draft;
        draftPromptRef.current = nextDraft;
        setPaletteDraftPrompt(nextDraft);
        onDraftContentChange({ ...draftContent, prompt: nextDraft });
        setIsPaletteOpen(false);
        if (!settingsControlsDisabled) {
          onSettingsChange({ computerUse: true });
        }
        return;
      }
      if (effect.kind === "toggleSpeed") {
        clearSlashCommandDraft();
        if (composerSettings.supportsSpeed) {
          const currentSpeed =
            composerSettings.selectedSpeedValue ??
            composerSettings.draftSettings.speed ??
            "standard";
          onSettingsChange({
            speed: currentSpeed === "fast" ? "standard" : "fast"
          });
        }
        return;
      }
      const nextDraft = effect.draft;
      draftPromptRef.current = nextDraft;
      setPaletteDraftPrompt(nextDraft);
      onDraftContentChange({ ...draftContent, prompt: nextDraft });
      setIsPaletteOpen(false);
    },
    [
      clearSlashCommandDraft,
      composerSettings.draftSettings.planMode,
      composerSettings.draftSettings.speed,
      composerSettings.selectedSpeedValue,
      composerSettings.supportsSpeed,
      draftContent,
      onDraftContentChange,
      onSettingsChange,
      onSubmit,
      settingsControlsDisabled
    ]
  );

  const selectCommand = useCallback(
    (command: AgentSessionCommand): void => {
      const selectionEffect = resolveSlashCommandSelectionEffect({
        provider,
        command,
        currentDraft: draftPromptRef.current
      });
      executeSlashCommandEffect(selectionEffect);
    },
    [executeSlashCommandEffect, provider]
  );

  const selectCapability = useCallback(
    (capability: AgentSlashCommandCapability): void => {
      const selectionEffect = resolveSlashCommandSelectionEffect({
        provider,
        command: capability,
        currentDraft: draftPromptRef.current
      });
      executeSlashCommandEffect(selectionEffect);
    },
    [executeSlashCommandEffect, provider]
  );

  const selectCapabilitySettings = useCallback(
    (capability: AgentSlashCommandCapability): void => {
      onCapabilitySettingsRequest?.(capability.capability);
      setIsPaletteOpen(false);
    },
    [onCapabilitySettingsRequest]
  );

  const selectSkill = useCallback(
    (skill: AgentGUIProviderSkillOption): void => {
      const trigger = skillTriggerForPrefix(skill, skillQueryMatch?.prefix);
      const replacedDraft =
        trigger && skillQueryMatch && promptBeforeSelection !== ""
          ? editorHandleRef.current?.replaceTextBeforeSelection(
              skillQueryMatch.end - skillQueryMatch.start,
              `${trigger} `
            )
          : null;
      const nextDraft =
        replacedDraft ??
        draftForProviderSkillTrigger({
          skill,
          currentDraft: draftPromptRef.current,
          match: skillQueryMatch
        });
      draftPromptRef.current = nextDraft;
      setPaletteDraftPrompt(nextDraft);
      onDraftContentChange({ ...draftContent, prompt: nextDraft });
      setIsPaletteOpen(false);
    },
    [draftContent, onDraftContentChange, promptBeforeSelection, skillQueryMatch]
  );

  const submitCurrentPrompt = useStableEventCallback(
    (options?: { guidance?: boolean }): void => {
      const canSubmitWhileSending = canQueueWhileBusy && isSendingTurn;
      const currentDraftImages = draftImagesRef.current;
      const currentDraftFiles = draftFilesRef.current;
      const hasUploadingImages = currentDraftImages.some(
        (image) => image.uploading
      );
      const hasFailedImages = currentDraftImages.some(
        (image) => image.uploadError
      );
      const hasUploadingFiles = currentDraftFiles.some(
        (file) => file.uploading
      );
      const hasFailedFiles = currentDraftFiles.some((file) => file.uploadError);
      if (
        isSelectedProjectMissing ||
        submitDisabled ||
        hasUploadingImages ||
        hasFailedImages ||
        hasUploadingFiles ||
        hasFailedFiles ||
        (disabled && !canQueueWhileBusy) ||
        (isSendingTurn && !canSubmitWhileSending)
      ) {
        return;
      }
      const nextPrompt = draftPromptRef.current;
      const nextDraftContent = {
        ...draftContent,
        prompt: nextPrompt,
        images: currentDraftImages,
        files: currentDraftFiles
      };
      if (!agentComposerDraftHasContent(nextDraftContent)) {
        return;
      }
      if (currentDraftImages.length > 0 && !promptImagesSupported) {
        onPromptImagesUnsupported?.();
        return;
      }
      if (options?.guidance !== true) {
        const browserUseEffect = resolveTuttiBrowserUseSubmitEffect({
          browserSupported: Boolean(composerSettings.supportsBrowser),
          commands: resolvedSlashCommands,
          draft: nextPrompt
        });
        if (browserUseEffect) {
          executeSlashCommandEffect(browserUseEffect);
          return;
        }
        const slashCommandEffect = resolveSlashCommandSubmitEffect({
          provider,
          commands: resolvedSlashCommands,
          draft: nextPrompt
        });
        if (slashCommandEffect) {
          executeSlashCommandEffect(slashCommandEffect);
          return;
        }
      }
      setIsPaletteOpen(false);
      // 引用(workspace-reference)mention 不再展开成文件路径:发给 agent 的内容与
      // 对话流回显一致,单条 mention 链接,由 skill+CLL 按需解析。无需 displayPrompt 旁路。
      const submitContent = agentComposerDraftToPromptContent({
        draft: nextDraftContent,
        provider,
        skills: availableSkills
      });
      if (options?.guidance === true) {
        if (!onSubmitGuidance) {
          return;
        }
        onSubmitGuidance(submitContent);
      } else {
        onSubmit(submitContent);
      }
      // Starting a brand-new conversation (no active conversation yet) is
      // async — session creation + activation round trip — before the view
      // switches away from composer-home to show it. Skip the eager local
      // clear in that case so the just-submitted text stays visible instead
      // of leaving the composer blank with nothing happening;
      // startConversation's resolution (see useAgentGUINodeController)
      // authoritatively clears this same draft, or leaves it untouched on
      // failure, once the view actually transitions.
      if (hasActiveConversation) {
        draftPromptRef.current = "";
        draftImagesRef.current = [];
        draftFilesRef.current = [];
        setPaletteDraftPrompt("");
        onDraftContentChange(emptyAgentComposerDraft());
      }
    }
  );

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      submitCurrentPrompt();
    },
    [submitCurrentPrompt]
  );

  const handleSlashPaletteKeyDown = useStableEventCallback(
    (event: KeyboardEvent): boolean => {
      if (!showSlashPalette) {
        return false;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedIndex((current) =>
          moveSlashCommandHighlight(current, slashPaletteEntries.length, 1)
        );
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIndex((current) =>
          moveSlashCommandHighlight(current, slashPaletteEntries.length, -1)
        );
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setIsPaletteOpen(false);
        return true;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const activeEntry = slashPaletteEntries[activeHighlight];
        if (activeEntry?.type === "command") {
          selectCommand(activeEntry.command);
        } else if (activeEntry?.type === "capability") {
          if (activeEntry.selectAction === "settings") {
            selectCapabilitySettings(activeEntry.capability);
          } else {
            selectCapability(activeEntry.capability);
          }
        } else if (activeEntry?.type === "skill") {
          selectSkill(activeEntry.skill);
        }
        return true;
      }
      return false;
    }
  );

  const handleSlashCommandMenuKeyDown = useStableEventCallback(
    (event: KeyboardEvent): boolean => {
      if (!showCommandMenuPanel || event.key !== "Escape") {
        return false;
      }
      event.preventDefault();
      closeSlashFloatingMenu();
      return true;
    }
  );

  const selectFileMention = useCallback(
    (entry: AgentContextMentionItem): void => {
      if (
        entry.kind === "file" &&
        entry.mentionNavigation === "agent-generated-folder-back" &&
        mentionControllerRef.current?.selectAgentGeneratedMentionItem(entry)
      ) {
        return;
      }
      fileMentionSuggestion?.command(entry);
      if (fileMentionSuggestion) {
        exitAgentFileMentionSuggestion(fileMentionSuggestion.editor);
      }
      mentionControllerRef.current?.close();
      setFileMentionSuggestion(null);
      setIsPaletteOpen(false);
    },
    [fileMentionSuggestion]
  );

  const closeFileMentionPalette = useCallback((): void => {
    if (fileMentionSuggestion) {
      exitAgentFileMentionSuggestion(fileMentionSuggestion.editor);
    }
    mentionControllerRef.current?.close();
    setFileMentionSuggestion(null);
    setIsPaletteOpen(false);
  }, [fileMentionSuggestion]);

  const clearActiveFileMentionTrigger = useCallback((): void => {
    if (!fileMentionSuggestion) {
      return;
    }
    const triggerLength = Math.max(
      fileMentionSuggestion.range.to - fileMentionSuggestion.range.from,
      fileMentionSuggestion.text.length
    );
    const nextDraft =
      triggerLength > 0
        ? editorHandleRef.current?.replaceTextBeforeSelection(triggerLength, "")
        : null;
    if (nextDraft === null || nextDraft === undefined) {
      return;
    }
    draftPromptRef.current = nextDraft;
    setPaletteDraftPrompt(nextDraft);
    onDraftContentChange({ ...draftContent, prompt: nextDraft });
  }, [draftContent, fileMentionSuggestion, onDraftContentChange]);

  const closeOpenPalette = useCallback((): void => {
    if (showFileMentionPalette) {
      closeFileMentionPalette();
      return;
    }
    setIsPaletteOpen(false);
  }, [closeFileMentionPalette, showFileMentionPalette]);

  const createFileMentionPaletteAdapter = useCallback(
    (highlightedKey: string | null = mentionHighlightedKey) =>
      createMentionPaletteStateAdapter({
        state: mentionSearchState,
        highlightedKey,
        categoryCycleOrder:
          mentionSearchState.mode === "browse"
            ? mentionSearchState.categories
            : AGENT_MENTION_FILTER_TAB_ORDER,
        getItemKey: agentMentionItemKey,
        callbacks: {
          onHighlightChange: (key) => {
            setShouldCenterMentionHighlight(true);
            autoMentionHighlightedKeyRef.current = null;
            setMentionHighlightedKey(key);
          },
          onActiveCategoryIdChange: (categoryId) => {
            mentionControllerRef.current?.setFilter(
              categoryId as AgentMentionFilterId
            );
            setShouldResetMentionHighlightToFilter(true);
            setShouldCenterMentionHighlight(false);
          },
          onExpandGroup: (groupId) => {
            mentionControllerRef.current?.expandGroup(
              groupId as AgentMentionGroupId
            );
          },
          onSelectItem: selectFileMention
        }
      }),
    [mentionHighlightedKey, mentionSearchState, selectFileMention]
  );

  const moveFileMentionSelection = useCallback(
    (delta: 1 | -1): void => {
      createFileMentionPaletteAdapter().moveSelection(delta);
    },
    [createFileMentionPaletteAdapter]
  );

  const handleMentionHighlightChange = useCallback((key: string): void => {
    autoMentionHighlightedKeyRef.current = null;
    setMentionHighlightedKey(key);
  }, []);

  const cycleFileMentionFilter = useCallback(
    (delta: 1 | -1 = 1): void => {
      createFileMentionPaletteAdapter().cycleCategory(delta);
    },
    [createFileMentionPaletteAdapter]
  );

  const navigateFileMentionHierarchy = useCallback(
    (delta: 1 | -1): boolean => {
      if (delta === -1) {
        return (
          mentionControllerRef.current?.exitAgentGeneratedBrowse() ?? false
        );
      }
      const item = createFileMentionPaletteAdapter().selectedItem;
      if (!item || item.kind !== "file") {
        return false;
      }
      if (item.mentionNavigation !== "agent-generated-folder") {
        return false;
      }
      return (
        mentionControllerRef.current?.selectAgentGeneratedMentionItem(item) ??
        false
      );
    },
    [createFileMentionPaletteAdapter]
  );

  const navigateIntoFileMentionItem = useCallback(
    (item: AgentContextMentionItem): void => {
      mentionControllerRef.current?.selectAgentGeneratedMentionItem(item);
    },
    []
  );

  const handleFileMentionKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!showFileMentionPalette) {
        return false;
      }
      return makeAtPanelKeyDown({
        close: closeFileMentionPalette,
        commitSelection: () => {
          createFileMentionPaletteAdapter().commitHighlighted();
        },
        cycleFilter: cycleFileMentionFilter,
        moveSelection: moveFileMentionSelection,
        navigateHierarchy: navigateFileMentionHierarchy
      })(event);
    },
    [
      closeFileMentionPalette,
      createFileMentionPaletteAdapter,
      cycleFileMentionFilter,
      moveFileMentionSelection,
      navigateFileMentionHierarchy,
      showFileMentionPalette
    ]
  );

  // Shift+Tab toggles plan mode (CLI muscle memory), unified across providers.
  // Plan rides as an independent draft toggle; the daemon enforces provider
  // semantics (claude-code: plan overrides the permission mode; codex: plan is
  // an independent collaboration mode).
  const handlePlanModeToggleKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (
        event.key !== "Tab" ||
        !event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return false;
      }
      if (
        !composerSettings.supportsPlanMode ||
        isSendingTurn ||
        isSubmittingPrompt ||
        showStopButton ||
        composerSettings.isSettingsLoading
      ) {
        return false;
      }
      event.preventDefault();
      onSettingsChange({ planMode: !composerSettings.draftSettings.planMode });
      return true;
    },
    [
      composerSettings.draftSettings.planMode,
      composerSettings.isSettingsLoading,
      composerSettings.supportsPlanMode,
      onSettingsChange,
      isSendingTurn,
      isSubmittingPrompt,
      showStopButton
    ]
  );

  const handlePaletteKeyDown = useStableEventCallback(
    (event: KeyboardEvent): boolean =>
      handleFileMentionKeyDown(event) ||
      handleSlashPaletteKeyDown(event) ||
      handleSlashCommandMenuKeyDown(event) ||
      handlePlanModeToggleKeyDown(event)
  );

  useEffect(() => {
    if (!showPalette || workspaceReferencePickerOpen) {
      return;
    }
    const handleDocumentKeyDown = (event: KeyboardEvent): void => {
      const eventTarget = event.target;
      if (!(eventTarget instanceof Node)) {
        return;
      }
      const isComposerEvent =
        composerRef.current?.contains(eventTarget) ?? false;
      const isPaletteEvent =
        paletteContentRef.current?.contains(eventTarget) ?? false;
      if (!isComposerEvent && !isPaletteEvent) {
        return;
      }
      if (isAgentRichTextImeComposing(event)) {
        return;
      }
      if (handlePaletteKeyDown(event)) {
        event.stopPropagation();
      }
    };

    document.addEventListener("keydown", handleDocumentKeyDown, {
      capture: true
    });
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown, {
        capture: true
      });
    };
  }, [handlePaletteKeyDown, showPalette, workspaceReferencePickerOpen]);

  const handleFileMentionSuggestionChange = useCallback(
    (state: AgentFileMentionSuggestionState | null): void => {
      setFileMentionSuggestion(state);
      if (!state) {
        mentionControllerRef.current?.close();
        return;
      }
      setIsPaletteOpen(true);
      mentionControllerRef.current?.updateQuery({
        workspaceId,
        currentUserId,
        query: state.query,
        sessionCwd: selectedProjectPath || null
      });
    },
    [currentUserId, selectedProjectPath, workspaceId]
  );

  // 项目/任务引用(workspace-reference)mention:点击直接打开引用 picker 并定位到该
  // 应用项目 / 议题分组,而非导航到实体。其余 mention 仍走 workspace link action。
  // 经 ref 转发到稍后定义的 handleOpenReferencesForEntity(沿用本文件 onLinkClickRef 同款模式)。
  const openReferencesForEntityRef = useRef<
    ((entity: AgentContextMentionItem) => void) | null
  >(null);
  const handleLinkClick = useCallback(
    (href: string): void => {
      const item = parseMentionItemFromHref({ name: "", href });
      if (item?.kind === "workspace-reference") {
        openReferencesForEntityRef.current?.(item);
        return;
      }
      const action = resolveWorkspaceLinkAction({
        href,
        workspaceRoot: workspacePath,
        source: "agent-markdown"
      });
      if (action) {
        onLinkAction?.(action);
      }
    },
    [onLinkAction, workspacePath]
  );

  useEffect(() => {
    if (!showFileMentionPalette && shouldCenterMentionHighlight) {
      setShouldCenterMentionHighlight(false);
    }
  }, [shouldCenterMentionHighlight, showFileMentionPalette]);

  useEffect(() => {
    if (!showFileMentionPalette) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest(MENTION_PALETTE_DISMISS_INTERACTION_SELECTOR)) {
        closeOpenPalette();
      }
    };
    const handleWindowResize = (): void => {
      closeOpenPalette();
    };

    document.addEventListener("pointerdown", handlePointerDown, {
      capture: true
    });
    window.addEventListener("resize", handleWindowResize);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, {
        capture: true
      });
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [closeOpenPalette, showFileMentionPalette]);

  const handleDraftChange = useStableEventCallback(
    (nextDraft: string): void => {
      if (isGoalModeActive) {
        const nextGoalPrompt = buildGoalModePrompt(nextDraft);
        draftPromptRef.current = nextGoalPrompt;
        setPaletteDraftPrompt(nextDraft);
        setIsPaletteOpen(true);
        onDraftContentChange({ ...draftContent, prompt: nextGoalPrompt });
        return;
      }
      const nextGoalObjective = goalDraftObjectiveFromPrompt(nextDraft);
      if (nextGoalObjective !== null) {
        const nextGoalPrompt = buildGoalModePrompt(nextGoalObjective);
        draftPromptRef.current = nextGoalPrompt;
        setPaletteDraftPrompt(nextGoalObjective);
        setIsPaletteOpen(true);
        onDraftContentChange({ ...draftContent, prompt: nextGoalPrompt });
        return;
      }
      draftPromptRef.current = nextDraft;
      setPaletteDraftPrompt(nextDraft);
      setIsPaletteOpen(true);
      onDraftContentChange({ ...draftContent, prompt: nextDraft });
    }
  );

  const clearGoalModeBadge = useCallback((): void => {
    if (!isGoalModeActive) {
      return;
    }
    const nextPrompt = goalDraftObjective ?? "";
    draftPromptRef.current = nextPrompt;
    setPaletteDraftPrompt(nextPrompt);
    onDraftContentChange({ ...draftContent, prompt: nextPrompt });
  }, [
    draftContent,
    goalDraftObjective,
    isGoalModeActive,
    onDraftContentChange
  ]);

  const addDraftImages = useCallback(
    (images: AgentRichTextPastedImage[]): void => {
      if (images.length === 0) {
        return;
      }
      if (!promptImagesSupported) {
        onPromptImagesUnsupported?.();
        return;
      }
      const currentDraftImages = draftImagesRef.current;
      const remainingSlots = Math.max(
        0,
        MAX_AGENT_COMPOSER_DRAFT_IMAGES - currentDraftImages.length
      );
      if (remainingSlots === 0) {
        return;
      }
      const uploadPromptContent =
        agentActivityRuntime?.uploadPromptContent &&
        (agentActivityRuntime.promptContentUploadSupport?.image ?? true)
          ? agentActivityRuntime.uploadPromptContent
          : undefined;
      const nextImages = images.slice(0, remainingSlots).map((image) => ({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        name: image.name,
        mimeType: image.mimeType,
        data: image.data,
        previewUrl: `data:${image.mimeType};base64,${image.data}`,
        uploading: Boolean(uploadPromptContent)
      }));
      const nextDraftImages = [...currentDraftImages, ...nextImages];
      draftImagesRef.current = nextDraftImages;
      onDraftContentChange({
        prompt: draftPromptRef.current,
        images: nextDraftImages,
        files: draftFilesRef.current
      });
      if (!uploadPromptContent) {
        return;
      }
      for (const draftImage of nextImages) {
        void uploadPromptContent({
          workspaceId,
          content: [
            {
              type: "image",
              mimeType: draftImage.mimeType,
              data: draftImage.data,
              name: draftImage.name
            }
          ]
        })
          .then((result) => {
            const uploadedImage = result.content.find(
              (block) => block.type === "image"
            );
            const uploadedPath = uploadedImage?.path?.trim() ?? "";
            if (!uploadedPath) {
              throw new Error("Prompt image upload completed without path.");
            }
            const uploadedDraftImages = draftImagesRef.current.map((image) =>
              image.id === draftImage.id
                ? {
                    id: image.id,
                    name: image.name,
                    mimeType: image.mimeType,
                    path: uploadedPath,
                    previewUrl: image.previewUrl,
                    uploading: false
                  }
                : image
            );
            draftImagesRef.current = uploadedDraftImages;
            onDraftContentChange({
              prompt: draftPromptRef.current,
              images: uploadedDraftImages,
              files: draftFilesRef.current
            });
          })
          .catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            const failedDraftImages = draftImagesRef.current.map((image) =>
              image.id === draftImage.id
                ? {
                    ...image,
                    uploading: false,
                    uploadError: message
                  }
                : image
            );
            draftImagesRef.current = failedDraftImages;
            onDraftContentChange({
              prompt: draftPromptRef.current,
              images: failedDraftImages,
              files: draftFilesRef.current
            });
          });
      }
    },
    [
      agentActivityRuntime,
      onDraftContentChange,
      onPromptImagesUnsupported,
      promptImagesSupported,
      workspaceId
    ]
  );

  const removeDraftImage = useCallback(
    (id: string): void => {
      const nextDraftImages = draftImagesRef.current.filter(
        (image) => image.id !== id
      );
      draftImagesRef.current = nextDraftImages;
      onDraftContentChange({
        prompt: draftPromptRef.current,
        images: nextDraftImages,
        files: draftFilesRef.current
      });
    },
    [onDraftContentChange]
  );

  const removeDraftFile = useCallback(
    (id: string): void => {
      const nextDraftFiles = draftFilesRef.current.filter(
        (file) => file.id !== id
      );
      draftFilesRef.current = nextDraftFiles;
      onDraftContentChange({
        prompt: draftPromptRef.current,
        images: draftImagesRef.current,
        files: nextDraftFiles
      });
    },
    [onDraftContentChange]
  );

  const applyReferencePickResult = useCallback(
    async (result: WorkspaceReferencePickResult) => {
      if (result.files.length > 0) {
        const uploadPromptContent = promptFileUploadSupported
          ? agentActivityRuntime?.uploadPromptContent
          : undefined;
        const uploadedFiles = await Promise.all(
          result.files.map(async (file) => {
            const hostPath = file.hostPath?.trim() ?? "";
            if (!hostPath) {
              return file;
            }
            if (!uploadPromptContent) {
              throw new Error(
                "Prompt file uploads are not supported by this agent runtime."
              );
            }
            const uploaded = await uploadPromptContent({
              workspaceId,
              content: [
                {
                  type: "file",
                  hostPath,
                  name: file.displayName,
                  kind: "file"
                }
              ]
            });
            const uploadedFile = uploaded.content.find(
              (block) => block.type === "file"
            );
            const uploadedPath = uploadedFile?.path?.trim() ?? "";
            if (!uploadedPath) {
              throw new Error("Prompt file upload completed without path.");
            }
            return {
              ...file,
              path: uploadedPath,
              ...(uploadedFile?.name
                ? { displayName: uploadedFile.name }
                : file.displayName
                  ? { displayName: file.displayName }
                  : {}),
              ...(uploadedFile?.sizeBytes
                ? { sizeBytes: uploadedFile.sizeBytes }
                : {})
            };
          })
        );
        editorHandleRef.current?.insertWorkspaceReferences(uploadedFiles);
      }
      if (result.mentionItems.length > 0) {
        editorHandleRef.current?.insertMentionItems(result.mentionItems);
      }
    },
    [agentActivityRuntime, promptFileUploadSupported, workspaceId]
  );

  const handleWorkspaceReferencePicker = useCallback(async () => {
    if (!onRequestWorkspaceReferences) {
      return;
    }
    await applyReferencePickResult(await onRequestWorkspaceReferences());
  }, [applyReferencePickResult, onRequestWorkspaceReferences]);
  const providerSwitchTargets = useMemo(
    () => providerTargets.filter((target) => target.disabled !== true),
    [providerTargets]
  );
  const showProviderSelect = providerSwitchTargets.length > 1;
  const selectedProviderTargetId =
    selectedProviderTarget?.targetId ?? `local:${provider}`;
  const selectedProviderSwitchTarget =
    providerSwitchTargets.find(
      (target) => target.targetId === selectedProviderTargetId
    ) ??
    selectedProviderTarget ??
    providerSwitchTargets.find((target) => target.provider === provider) ??
    null;
  const selectedProviderLabel = selectedProviderSwitchTarget?.label ?? provider;
  const providerSelectDisabled =
    previewMode || providerSelectReadonly || !onProviderSelect;

  const applyDroppedFileReferences = useCallback(
    async (files: readonly File[]) => {
      if (
        !promptFilesSupported ||
        !resolveDroppedFileReferences ||
        files.length === 0
      ) {
        return;
      }
      const references = await resolveDroppedFileReferences(files);
      if (references.length === 0) {
        return;
      }
      await applyReferencePickResult({ files: references, mentionItems: [] });
    },
    [
      applyReferencePickResult,
      promptFilesSupported,
      resolveDroppedFileReferences
    ]
  );

  // @ 面板里点任务/应用行的「查看产物」入口:保留面板,打开引用 picker 并定位到该实体;
  // 选中的文件仍按常规插入,但不会把该任务/应用本身作为 mention 插入。
  const handleOpenReferencesForEntity = useCallback(
    (entity: AgentContextMentionItem): void => {
      if (!onRequestWorkspaceReferences) {
        return;
      }
      void onRequestWorkspaceReferences(entity).then((result) => {
        if (result.files.length > 0 || result.mentionItems.length > 0) {
          flushSync(clearActiveFileMentionTrigger);
        }
        return applyReferencePickResult(result);
      });
    },
    [
      clearActiveFileMentionTrigger,
      applyReferencePickResult,
      onRequestWorkspaceReferences
    ]
  );
  // 让 handleLinkClick(定义在前)能转发到此处:点击 workspace-reference chip 即定位打开 picker。
  openReferencesForEntityRef.current = handleOpenReferencesForEntity;

  const syncMentionPaletteFrame = useCallback((): void => {
    const anchor = inputShellRef.current;
    if (!anchor || typeof window === "undefined") {
      setMentionPaletteFrame(null);
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.max(
      0,
      Math.min(
        rect.width,
        viewportWidth - MENTION_PALETTE_VIEWPORT_PADDING_PX * 2
      )
    );
    const left = Math.max(
      MENTION_PALETTE_VIEWPORT_PADDING_PX,
      Math.min(
        rect.left,
        viewportWidth - MENTION_PALETTE_VIEWPORT_PADDING_PX - width
      )
    );
    const availableAbove =
      rect.top - MENTION_PALETTE_GAP_PX - MENTION_PALETTE_VIEWPORT_PADDING_PX;
    const height =
      availableAbove >= MENTION_PALETTE_MIN_HEIGHT_PX
        ? Math.min(MENTION_PALETTE_MAX_HEIGHT_PX, availableAbove)
        : MENTION_PALETTE_MIN_HEIGHT_PX;

    setMentionPaletteFrame({
      height,
      left,
      portalTarget: resolveMentionPalettePortalTarget(anchor),
      top: Math.max(
        MENTION_PALETTE_VIEWPORT_PADDING_PX,
        Math.min(
          rect.top - MENTION_PALETTE_GAP_PX - height,
          viewportHeight - MENTION_PALETTE_VIEWPORT_PADDING_PX - height
        )
      ),
      width,
      zIndex: resolveMentionPaletteZIndex(anchor)
    });
  }, []);

  useLayoutEffect(() => {
    if (!showFileMentionPalette) {
      setMentionPaletteFrame(null);
      return;
    }

    syncMentionPaletteFrame();
    const anchor = inputShellRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(syncMentionPaletteFrame);
    if (anchor) {
      resizeObserver?.observe(anchor);
    }
    window.addEventListener("resize", syncMentionPaletteFrame);
    window.addEventListener("scroll", syncMentionPaletteFrame, {
      capture: true,
      passive: true
    });
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncMentionPaletteFrame);
      window.removeEventListener("scroll", syncMentionPaletteFrame, true);
    };
  }, [showFileMentionPalette, syncMentionPaletteFrame]);

  const mentionPaletteStyle = useMemo<CSSProperties>(
    () => ({
      position: "fixed",
      left: `${mentionPaletteFrame?.left ?? 0}px`,
      top: `${mentionPaletteFrame?.top ?? 0}px`,
      width: `${mentionPaletteFrame?.width ?? 0}px`,
      maxWidth: `${mentionPaletteFrame?.width ?? 0}px`,
      minHeight: `${MENTION_PALETTE_MIN_HEIGHT_PX}px`,
      maxHeight: `${MENTION_PALETTE_MAX_HEIGHT_PX}px`,
      height: `${mentionPaletteFrame?.height ?? MENTION_PALETTE_MIN_HEIGHT_PX}px`,
      zIndex: composerPaletteZIndex
    }),
    [mentionPaletteFrame]
  );
  const mentionPaletteHeightPx =
    mentionPaletteFrame?.height ?? MENTION_PALETTE_MIN_HEIGHT_PX;
  const isHeroLayout = layoutMode === "hero";
  const composerClassName = isHeroLayout
    ? styles.composerHero
    : styles.composer;
  const inputShellClassName = cn(
    styles.composerInputShell,
    isHeroLayout && styles.composerInputShellHero
  );
  const inputDisabled =
    isSelectedProjectMissing || (disabled && !canQueueWhileBusy);
  const handleMentionPaletteButton = useCallback((): void => {
    if (composerControlsHardDisabled || inputDisabled) {
      return;
    }
    editorHandleRef.current?.openMentionPalette();
  }, [composerControlsHardDisabled, inputDisabled]);
  const scheduleComposerFocus = useCallback(() => {
    if (inputDisabled) {
      return;
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        editorHandleRef.current?.focusAtEnd();
      });
    });
  }, [inputDisabled]);
  const handlePastedImages = useCallback(
    (images: AgentRichTextPastedImage[]): void => {
      addDraftImages(images);
      scheduleComposerFocus();
    },
    [addDraftImages, scheduleComposerFocus]
  );
  useEffect(() => {
    const composer = composerRef.current;
    const dropTarget = composer?.closest("#agent-gui-detail") ?? composer;
    if (!dropTarget) {
      return undefined;
    }
    let isDisposed = false;

    const isDragEvent = (event: Event): event is DragEvent =>
      "dataTransfer" in event;

    const containsEventTarget = (event: DragEvent): boolean => {
      const target = event.target;
      return target instanceof Node && dropTarget.contains(target);
    };

    const systemFileDrag = (
      event: DragEvent
    ): { hasImageFiles: boolean; hasRegularFiles: boolean } | null => {
      if (
        event.defaultPrevented ||
        inputDisabled ||
        !containsEventTarget(event) ||
        hasWorkspaceFileDropData(event.dataTransfer)
      ) {
        return null;
      }
      const dragInfo = systemFileDragInfoFromDataTransfer(event.dataTransfer);
      const hasRegularFiles = dragInfo.hasRegularFiles && promptFilesSupported;
      if (!dragInfo.hasImageFiles && !hasRegularFiles) {
        return null;
      }
      return { hasImageFiles: dragInfo.hasImageFiles, hasRegularFiles };
    };

    const systemFileDrop = (
      event: DragEvent
    ): { imageFiles: File[]; regularFiles: File[] } | null => {
      if (
        event.defaultPrevented ||
        inputDisabled ||
        !containsEventTarget(event) ||
        hasWorkspaceFileDropData(event.dataTransfer)
      ) {
        return null;
      }
      const imageFiles = imageFilesFromDataTransfer(event.dataTransfer);
      const imageFileSet = new Set(imageFiles);
      const regularFiles = promptFilesSupported
        ? nonImageFilesFromDataTransfer(event.dataTransfer).filter(
            (file) => !imageFileSet.has(file)
          )
        : [];
      if (imageFiles.length === 0 && regularFiles.length === 0) {
        return null;
      }
      return { imageFiles, regularFiles };
    };

    const handleDragOver: EventListener = (event): void => {
      if (!isDragEvent(event)) {
        return;
      }
      const drag = systemFileDrag(event);
      if (!drag) {
        return;
      }
      event.preventDefault();
      if (
        !drag.hasRegularFiles &&
        drag.hasImageFiles &&
        !promptImagesSupported
      ) {
        return;
      }
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    };

    const handleDrop: EventListener = (event): void => {
      if (!isDragEvent(event)) {
        return;
      }
      const drop = systemFileDrop(event);
      if (!drop) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (drop.regularFiles.length > 0) {
        editorHandleRef.current?.focusAtEnd();
        void applyDroppedFileReferences(drop.regularFiles).then(() => {
          if (!isDisposed) {
            scheduleComposerFocus();
          }
        });
      }
      if (drop.imageFiles.length === 0) {
        return;
      }
      if (!promptImagesSupported) {
        onPromptImagesUnsupported?.();
        return;
      }
      void readAgentRichTextPromptImages(drop.imageFiles).then((images) => {
        if (isDisposed || images.length === 0) {
          return;
        }
        addDraftImages(images);
        scheduleComposerFocus();
      });
    };

    dropTarget.addEventListener("dragover", handleDragOver);
    dropTarget.addEventListener("drop", handleDrop);
    return () => {
      isDisposed = true;
      dropTarget.removeEventListener("dragover", handleDragOver);
      dropTarget.removeEventListener("drop", handleDrop);
    };
  }, [
    addDraftImages,
    applyDroppedFileReferences,
    inputDisabled,
    onPromptImagesUnsupported,
    promptFilesSupported,
    promptImagesSupported,
    scheduleComposerFocus
  ]);
  useEffect(() => {
    if (!isActive) {
      wasActiveRef.current = false;
      return;
    }
    if (!wasActiveRef.current) {
      scheduleComposerFocus();
    }
    wasActiveRef.current = true;
  }, [isActive, scheduleComposerFocus]);
  useEffect(() => {
    if (
      composerFocusRequestSequence === null ||
      composerFocusRequestSequence === lastComposerFocusRequestRef.current
    ) {
      return;
    }
    lastComposerFocusRequestRef.current = composerFocusRequestSequence;
    scheduleComposerFocus();
  }, [composerFocusRequestSequence, scheduleComposerFocus]);
  const showEdgeGlow = isHeroLayout && !inputDisabled;
  const showPromptTips = isHeroLayout && promptTips.length > 0;
  const activePromptTip = showPromptTips ? (promptTips[0] ?? null) : null;
  const showHeroProjectSelector = isHeroLayout;
  const showProjectRow = isHeroLayout;
  const showProjectMissingProbe =
    !showProjectRow &&
    Boolean(composerSettings.projectLocked) &&
    selectedProjectPath !== "";
  const activePromptTipId = activePromptTip?.id ?? null;
  const activePromptTipText = activePromptTip
    ? `${labels.promptTipsPrefix}${activePromptTip.label} · ${activePromptTip.prompt}`
    : "";
  const rotatingPromptTips =
    activePromptTip && promptTips.length > 1
      ? [...promptTips, activePromptTip]
      : activePromptTip
        ? [activePromptTip]
        : [];
  const promptTipStyle =
    promptTips.length > 1
      ? ({
          "--agent-gui-prompt-tip-count": promptTips.length,
          "--agent-gui-prompt-tip-cycle-duration": `${
            promptTips.length * PROMPT_TIP_CYCLE_STEP_MS
          }ms`
        } as CSSProperties)
      : undefined;
  useLayoutEffect(() => {
    if (previewMode) {
      setIsPromptTipOverflowing(false);
      return;
    }
    if (!activePromptTipId) {
      setIsPromptTipOverflowing(false);
      return;
    }

    const element = promptTipRef.current;
    if (!element) {
      setIsPromptTipOverflowing(false);
      return;
    }

    const measure = (): void => {
      setIsPromptTipOverflowing(hasInlineOverflow(element));
    };

    measure();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(element);
    if (element.parentElement) {
      resizeObserver?.observe(element.parentElement);
    }
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [
    activePromptTipId,
    activePromptTipText,
    isPromptTipOverflowing,
    previewMode
  ]);
  useLayoutEffect(() => {
    if (isHeroLayout) {
      setDockComposerInputHeight(DOCK_COMPOSER_INPUT_MIN_HEIGHT);
      setDockComposerInputMaxHeight(DOCK_COMPOSER_INPUT_MAX_HEIGHT);
      setDockComposerAttachmentHeight(0);
      setDockComposerTextHeight(DOCK_COMPOSER_INPUT_MIN_HEIGHT);
      return;
    }

    const inputArea = promptInputAreaRef.current;
    const editor = inputArea?.querySelector(
      ".agent-gui-node__composer-textarea"
    );
    if (!inputArea || !(editor instanceof HTMLElement)) {
      setDockComposerInputHeight(DOCK_COMPOSER_INPUT_MIN_HEIGHT);
      return;
    }

    const measure = (): void => {
      const attachmentArea = inputArea.querySelector(
        '[data-testid="agent-gui-composer-image-drafts"]'
      );
      const attachmentHeight =
        attachmentArea instanceof HTMLElement ? attachmentArea.scrollHeight : 0;
      const textHeight = Math.min(
        DOCK_COMPOSER_INPUT_MAX_HEIGHT,
        Math.max(
          DOCK_COMPOSER_INPUT_MIN_HEIGHT,
          editor.scrollHeight + DOCK_COMPOSER_INPUT_TEXT_CHROME_HEIGHT
        )
      );
      const attachmentChromeHeight =
        attachmentHeight > 0 ? DOCK_COMPOSER_INPUT_PADDING_BLOCK_HEIGHT : 0;
      const maxHeight =
        DOCK_COMPOSER_INPUT_MAX_HEIGHT +
        Math.max(0, attachmentHeight) +
        attachmentChromeHeight;
      const previousHeight = inputArea.style.height;
      const previousInputHeight = inputArea.style.getPropertyValue(
        "--agent-gui-composer-input-height"
      );
      const previousInputMaxHeight = inputArea.style.getPropertyValue(
        "--agent-gui-composer-input-max-height"
      );
      const previousAttachmentHeight = inputArea.style.getPropertyValue(
        "--agent-gui-composer-attachment-height"
      );
      inputArea.style.height = "auto";
      inputArea.style.setProperty(
        "--agent-gui-composer-input-height",
        `${DOCK_COMPOSER_INPUT_MIN_HEIGHT}px`
      );
      inputArea.style.setProperty(
        "--agent-gui-composer-input-max-height",
        `${maxHeight}px`
      );
      inputArea.style.setProperty(
        "--agent-gui-composer-attachment-height",
        `${attachmentHeight}px`
      );
      const contentHeight = inputArea.scrollHeight;
      inputArea.style.height = previousHeight;
      if (previousInputHeight) {
        inputArea.style.setProperty(
          "--agent-gui-composer-input-height",
          previousInputHeight
        );
      } else {
        inputArea.style.removeProperty("--agent-gui-composer-input-height");
      }
      if (previousInputMaxHeight) {
        inputArea.style.setProperty(
          "--agent-gui-composer-input-max-height",
          previousInputMaxHeight
        );
      } else {
        inputArea.style.removeProperty("--agent-gui-composer-input-max-height");
      }
      if (previousAttachmentHeight) {
        inputArea.style.setProperty(
          "--agent-gui-composer-attachment-height",
          previousAttachmentHeight
        );
      } else {
        inputArea.style.removeProperty(
          "--agent-gui-composer-attachment-height"
        );
      }
      const measuredHeight = Math.max(
        contentHeight + DOCK_COMPOSER_INPUT_BORDER_HEIGHT,
        attachmentHeight + textHeight + attachmentChromeHeight
      );
      const nextHeight = Math.min(
        maxHeight,
        Math.max(DOCK_COMPOSER_INPUT_MIN_HEIGHT, measuredHeight)
      );
      setDockComposerInputHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight
      );
      setDockComposerInputMaxHeight((currentHeight) =>
        currentHeight === maxHeight ? currentHeight : maxHeight
      );
      setDockComposerAttachmentHeight((currentHeight) =>
        currentHeight === attachmentHeight ? currentHeight : attachmentHeight
      );
      setDockComposerTextHeight((currentHeight) =>
        currentHeight === textHeight ? currentHeight : textHeight
      );
    };

    measure();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(inputArea);
    resizeObserver?.observe(editor);
    for (const child of Array.from(inputArea.querySelectorAll("*"))) {
      resizeObserver?.observe(child);
    }
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [draftFiles.length, draftImages.length, isHeroLayout, paletteDraftPrompt]);
  const inputShellStyle = useMemo<CSSProperties | undefined>(
    () =>
      showFileMentionPalette || showFloatingCommandMenu
        ? { zIndex: composerPaletteZIndex }
        : undefined,
    [showFileMentionPalette, showFloatingCommandMenu]
  );
  const promptInputAreaStyle = useMemo<CSSProperties | undefined>(
    () =>
      isHeroLayout
        ? undefined
        : ({
            "--agent-gui-composer-attachment-height": `${dockComposerAttachmentHeight}px`,
            "--agent-gui-composer-input-height": `${dockComposerInputHeight}px`,
            "--agent-gui-composer-input-max-height": `${dockComposerInputMaxHeight}px`,
            "--agent-gui-composer-text-height": `${dockComposerTextHeight}px`,
            "--agent-gui-composer-text-line-height": `${DOCK_COMPOSER_TEXT_LINE_HEIGHT}px`,
            "--agent-gui-composer-text-max-visible-lines": `${DOCK_COMPOSER_MAX_VISIBLE_TEXT_LINES}`,
            "--agent-gui-composer-text-viewport-height": `${DOCK_COMPOSER_TEXT_VIEWPORT_MAX_HEIGHT}px`
          } as CSSProperties),
    [
      dockComposerAttachmentHeight,
      dockComposerInputHeight,
      dockComposerInputMaxHeight,
      dockComposerTextHeight,
      isHeroLayout
    ]
  );
  const hasDraftContent = agentComposerDraftHasContent(draftContent);
  const hasUploadingDraftImages = draftImages.some((image) => image.uploading);
  const hasFailedDraftImages = draftImages.some((image) => image.uploadError);
  const hasUploadingDraftFiles = draftFiles.some((file) => file.uploading);
  const hasFailedDraftFiles = draftFiles.some((file) => file.uploadError);
  const isQueueMode = canQueueWhileBusy && hasDraftContent;
  const shouldShowStopButton = showStopButton && !isQueueMode;
  const sendButtonState = isQueueMode
    ? "queue"
    : shouldShowStopButton
      ? isInterrupting
        ? "stopping"
        : "interrupt"
      : isSendingTurn
        ? "loading"
        : "send";
  const sendButtonBusy = isSendingTurn && !isQueueMode;
  const activePromptRequestId = activePrompt?.requestId ?? null;
  const [dismissedPromptRequestId, setDismissedPromptRequestId] = useState<
    string | null
  >(null);
  const visibleActivePrompt =
    activePrompt && dismissedPromptRequestId !== activePromptRequestId
      ? activePrompt
      : null;
  const disabledReasonText = disabledReason?.trim() ?? "";
  const effectivePlaceholder = disabledReasonText || placeholder;
  const visibleDraftFiles = draftFiles;
  useEffect(() => {
    if (previousSelectedProjectPathRef.current === selectedProjectPath) {
      return;
    }
    previousSelectedProjectPathRef.current = selectedProjectPath;
    setIsSelectedProjectMissing(false);
    if (!fileMentionSuggestion) {
      return;
    }
    mentionControllerRef.current?.updateQuery({
      workspaceId,
      currentUserId,
      query: fileMentionSuggestion.query,
      sessionCwd: selectedProjectPath || null
    });
  }, [currentUserId, fileMentionSuggestion, selectedProjectPath, workspaceId]);

  useEffect(() => {
    setDismissedPromptRequestId(null);
  }, [activePromptRequestId]);

  const submitInteractivePromptAndDismiss = useCallback(
    (input: {
      requestId: string;
      action?: string;
      optionId?: string;
      payload?: Record<string, unknown>;
    }) => {
      onSubmitInteractivePrompt(input);
      setDismissedPromptRequestId(input.requestId);
    },
    [onSubmitInteractivePrompt]
  );

  const composerActionButton = shouldShowStopButton ? (
    <button
      type="button"
      className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-transparent bg-transparent p-0 text-[var(--text-primary)] transition-[color,opacity] duration-150 hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text-primary)_34%,transparent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background-panel)] active:bg-transparent disabled:cursor-not-allowed disabled:opacity-45"
      disabled={isInterrupting}
      aria-label={isInterrupting ? labels.stopping : labels.stop}
      title={isInterrupting ? labels.stopping : labels.stop}
      onClick={onInterruptCurrentTurn}
    >
      <Spinner
        className="size-7 text-[var(--text-primary)]"
        size={28}
        strokeWidth={2}
        trackColor="var(--transparency-hover)"
        testId="agent-gui-composer-stop-spinner"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-[2px] bg-current"
        data-testid="agent-gui-composer-stop-symbol"
      />
    </button>
  ) : (
    <button
      type="submit"
      className={styles.composerSendButton}
      data-state={sendButtonState}
      disabled={
        isSelectedProjectMissing ||
        submitDisabled ||
        !hasDraftContent ||
        hasUploadingDraftImages ||
        hasFailedDraftImages ||
        hasUploadingDraftFiles ||
        hasFailedDraftFiles ||
        sendButtonBusy
      }
      aria-label={labels.send}
      title={labels.send}
      aria-busy={sendButtonBusy}
    >
      {sendButtonBusy ? (
        <Spinner
          className="text-[var(--text-primary)]"
          size={16}
          strokeWidth={2.5}
          trackColor="var(--transparency-hover)"
          testId="agent-gui-composer-send-spinner"
        />
      ) : (
        <SendFilledIcon />
      )}
    </button>
  );

  const promptTipNode = activePromptTip ? (
    <span
      key={activePromptTip.id}
      ref={promptTipRef}
      className={styles.composerPromptTip}
      data-rotating={promptTips.length > 1 ? "true" : undefined}
      data-testid="agent-gui-prompt-tip"
      style={promptTipStyle}
    >
      <span className={styles.composerPromptTipTrack}>
        {rotatingPromptTips.map((tip, index) => (
          <span
            key={`${tip.id}:${index}`}
            className={styles.composerPromptTipItem}
            aria-hidden={index >= promptTips.length ? true : undefined}
          >
            <span className={styles.composerPromptTipPrefix}>
              {labels.promptTipsPrefix}
            </span>
            <span className={styles.composerPromptTipLabel}>{tip.label}</span>
            <span className={styles.composerPromptTipText}>
              {" · "}
              {tip.prompt}
            </span>
          </span>
        ))}
      </span>
    </span>
  ) : null;

  return (
    <form
      ref={composerRef}
      className={composerClassName}
      data-layout={layoutMode}
      onSubmit={submit}
    >
      {visibleActivePrompt ? (
        <div
          className={styles.composerFloatingPrompt}
          data-testid="agent-gui-composer-floating-prompt"
        >
          <AgentInteractivePromptSurface
            prompt={visibleActivePrompt}
            embedded={true}
            edgeGlow={true}
            keyboardShortcuts={activePromptKeyboardShortcutsEnabled}
            previewMode={previewMode}
            isSubmitting={isSubmittingPrompt}
            onSubmit={submitInteractivePromptAndDismiss}
            labels={{
              approvalLead: labels.approvalLead,
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
            }}
          />
        </div>
      ) : null}
      {queuedPrompts.length > 0 ? (
        <div
          className={cn(
            styles.composerFloatingPrompt,
            styles.composerQueuedPromptFloating
          )}
          data-testid="agent-gui-composer-queued-prompts"
        >
          <AgentQueuedPromptPanel
            queuedPrompts={queuedPrompts}
            drainingQueuedPromptId={drainingQueuedPromptId}
            labels={{
              queuedLabel: labels.queuedLabel,
              sendQueuedPromptNext: labels.sendQueuedPromptNext,
              editQueuedPrompt: labels.editQueuedPrompt,
              deleteQueuedPrompt: labels.deleteQueuedPrompt,
              queuedPromptMoreActions: labels.queuedPromptMoreActions
            }}
            onSendQueuedPromptNext={onSendQueuedPromptNext}
            onRemoveQueuedPrompt={onRemoveQueuedPrompt}
            onEditQueuedPrompt={onEditQueuedPrompt}
            onLinkClick={handleLinkClick}
            workspaceAppIcons={workspaceAppIcons}
          />
        </div>
      ) : null}
      {showProjectMissingProbe ? (
        <AgentProjectMissingStatusProbe
          composerSettings={composerSettings}
          onProjectMissingChange={setIsSelectedProjectMissing}
        />
      ) : null}
      <div
        className={cn(
          styles.composerInputGroup,
          layoutMode === "hero" && styles.composerInputGroupHero
        )}
        data-edge-glow={showEdgeGlow ? "true" : undefined}
      >
        {backgroundAgentStatusText ? (
          <AgentChromeNotice
            tone="muted"
            role="status"
            testId="agent-gui-composer-background-agent-status"
            title={backgroundAgentStatusText}
            icon={<Spinner className="h-3.5 w-3.5" />}
          />
        ) : null}
        {isSelectedProjectMissing ? (
          <AgentChromeNotice
            tone="danger"
            role="alert"
            testId="agent-gui-missing-project-notice"
            title={workspaceUserProjectI18n.tFirst([
              "projectSelect.projectMissingTitle"
            ])}
            description={labels.projectMissingDescription}
          />
        ) : null}
        <div
          ref={inputShellRef}
          className={cn(inputShellClassName, "relative")}
          data-testid="agent-gui-composer-input-shell"
          data-input-disabled={inputDisabled ? "true" : undefined}
          title={
            inputDisabled && disabledReasonText ? disabledReasonText : undefined
          }
          style={inputShellStyle}
        >
          <Popover
            open={showFileMentionPalette}
            onOpenChange={setIsPaletteOpen}
            modal={false}
          >
            <PopoverAnchor asChild>
              <div
                ref={promptInputAreaRef}
                className={cn(
                  "w-full min-w-0 self-start",
                  !isHeroLayout && "agent-gui-node__composer-prompt-input-area"
                )}
                data-has-draft-images={
                  draftImages.length > 0 ? "true" : undefined
                }
                style={promptInputAreaStyle}
              >
                {draftImages.length > 0 ? (
                  <div
                    className="mb-2 flex w-full max-w-full flex-wrap items-start gap-2"
                    data-testid="agent-gui-composer-image-drafts"
                  >
                    {draftImages.map((image) => (
                      <AgentComposerDraftImagePreview
                        key={image.id}
                        image={image}
                        removeLabel={labels.removeMention}
                        onRemove={removeDraftImage}
                      />
                    ))}
                  </div>
                ) : null}
                {visibleDraftFiles.length > 0 ? (
                  <div
                    className="mb-2 flex max-w-[520px] flex-wrap gap-2"
                    data-testid="agent-gui-composer-file-drafts"
                  >
                    {visibleDraftFiles.map((file) => (
                      <div
                        key={file.id}
                        className={cn(
                          "group inline-flex max-w-full items-center gap-2 rounded-[6px] border border-[var(--line-1)] bg-[var(--background-fronted)] px-2 py-1 text-xs text-[var(--text-primary)]",
                          file.uploadError &&
                            "border-[color:color-mix(in_srgb,var(--danger)_55%,var(--line-1))]"
                        )}
                        data-uploading={file.uploading ? "true" : undefined}
                        data-upload-error={
                          file.uploadError ? "true" : undefined
                        }
                        title={file.hostPath ?? file.path ?? file.name}
                      >
                        {file.uploading ? (
                          <Spinner
                            className="shrink-0 text-[var(--text-primary)]"
                            size={14}
                            strokeWidth={2.4}
                            trackColor="var(--transparency-hover)"
                            testId="agent-gui-composer-file-upload-spinner"
                          />
                        ) : (
                          <span
                            className="size-2 shrink-0 rounded-full bg-[var(--text-tertiary)]"
                            aria-hidden
                          />
                        )}
                        <span className="min-w-0 max-w-[220px] truncate">
                          {file.name}
                        </span>
                        <button
                          type="button"
                          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text-primary)_34%,transparent)]"
                          aria-label={labels.removeMention}
                          title={labels.removeMention}
                          onClick={() => removeDraftFile(file.id)}
                        >
                          <X size={12} strokeWidth={2.4} aria-hidden />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div
                  className={cn(
                    "w-full min-w-0 self-start",
                    !isHeroLayout &&
                      "agent-gui-node__composer-prompt-input-line"
                  )}
                >
                  <AgentRichTextEditor
                    ref={editorHandleRef}
                    value={paletteDraftPrompt}
                    placeholder={effectivePlaceholder}
                    disabled={inputDisabled}
                    className={styles.composerTextarea}
                    onChange={handleDraftChange}
                    onSubmit={submitCurrentPrompt}
                    onSubmitGuidance={() =>
                      submitCurrentPrompt({ guidance: true })
                    }
                    availableSkills={availableSkills}
                    availableCapabilities={availableCapabilities}
                    removeMentionLabel={labels.removeMention}
                    onKeyDownForPalette={handlePaletteKeyDown}
                    onFileMentionSuggestionChange={
                      handleFileMentionSuggestionChange
                    }
                    onFileMentionSuggestionKeyDown={handleFileMentionKeyDown}
                    onLinkClick={handleLinkClick}
                    promptImagesSupported={promptImagesSupported}
                    onPromptImagesUnsupported={onPromptImagesUnsupported}
                    onPasteImages={handlePastedImages}
                    getReferenceForFile={getReferenceForFile}
                    onDropFiles={
                      promptFilesSupported
                        ? applyDroppedFileReferences
                        : undefined
                    }
                  />
                  {!isHeroLayout ? composerActionButton : null}
                </div>
              </div>
            </PopoverAnchor>
            {showFileMentionPalette && mentionPaletteFrame
              ? createPortal(
                  <div
                    data-testid="agent-gui-mention-palette-surface"
                    ref={paletteContentRef}
                    className={cn(
                      composerStyles.dropdownSurface,
                      "max-h-[320px] overflow-hidden border-[var(--line-1)] p-0"
                    )}
                    style={mentionPaletteStyle}
                  >
                    <AgentFileMentionPalette
                      state={mentionSearchState}
                      highlightedKey={mentionHighlightedKey}
                      label={labels.fileMentionPalette}
                      loadingLabel={labels.fileMentionLoading}
                      emptyLabel={labels.fileMentionEmpty}
                      errorLabel={labels.fileMentionError}
                      tabHintLabel={labels.fileMentionTabHint}
                      maxHeightPx={mentionPaletteHeightPx}
                      shouldCenterHighlightedItem={shouldCenterMentionHighlight}
                      onHighlightChange={handleMentionHighlightChange}
                      onSelectItem={selectFileMention}
                      onSelectCategory={(filter) =>
                        mentionControllerRef.current?.setFilter(filter)
                      }
                      onSelectFilter={(filter) =>
                        mentionControllerRef.current?.setFilter(filter)
                      }
                      onExpandGroup={(groupId) =>
                        mentionControllerRef.current?.expandGroup(groupId)
                      }
                      onNavigateHierarchy={navigateFileMentionHierarchy}
                      onNavigateIntoItem={navigateIntoFileMentionItem}
                      onOpenReferences={
                        onRequestWorkspaceReferences
                          ? handleOpenReferencesForEntity
                          : undefined
                      }
                    />
                  </div>,
                  mentionPaletteFrame.portalTarget
                )
              : null}
            <ComposerFloatingMenuSurface
              anchorRef={inputShellRef}
              className="max-h-[320px] border-0 p-0"
              contentClassName="h-full min-h-0"
              dismissBoundaryRef={promptInputAreaRef}
              maxHeight={SLASH_PALETTE_HEIGHT_PX}
              onDismiss={closeSlashFloatingMenu}
              open={showSlashPalette}
              placement="fixed-height"
              surfaceRef={paletteContentRef}
              testId="agent-gui-slash-palette-surface"
            >
              <AgentSlashCommandPalette
                entries={slashPaletteEntries}
                highlightedIndex={activeHighlight}
                label={
                  slashQuery === null
                    ? labels.skillPickerPalette
                    : labels.slashCommandPalette
                }
                commandsGroupLabel={labels.slashPaletteCommandsGroup}
                capabilitiesGroupLabel={labels.slashPaletteCapabilitiesGroup}
                skillsGroupLabel={labels.slashPaletteSkillsGroup}
                pluginsGroupLabel={labels.slashPalettePluginsGroup}
                connectorsGroupLabel={labels.slashPaletteConnectorsGroup}
                mcpGroupLabel={labels.slashPaletteMcpGroup}
                onHighlightChange={setHighlightedIndex}
                onSelect={selectCommand}
                onSelectCapability={selectCapability}
                onSelectCapabilitySettings={selectCapabilitySettings}
                onSelectSkill={selectSkill}
              />
            </ComposerFloatingMenuSurface>
            <ComposerFloatingMenuSurface
              anchorRef={inputShellRef}
              className="border-0 p-0"
              dismissBoundaryRef={promptInputAreaRef}
              maxHeight={SLASH_PALETTE_HEIGHT_PX}
              onDismiss={closeSlashFloatingMenu}
              open={isSlashStatusPanelOpen}
              placement="dynamic-above"
              surfaceRef={paletteContentRef}
              testId="agent-gui-command-menu-surface"
            >
              <AgentSlashStatusPanel
                status={slashStatus}
                labels={{
                  slashStatusTitle: labels.slashStatusTitle,
                  slashStatusSession: labels.slashStatusSession,
                  slashStatusBaseUrl: labels.slashStatusBaseUrl,
                  slashStatusContext: labels.slashStatusContext,
                  slashStatusLimits: labels.slashStatusLimits,
                  slashStatusClose: labels.slashStatusClose,
                  slashStatusContextValue: labels.slashStatusContextValue,
                  slashStatusContextUnavailable:
                    labels.slashStatusContextUnavailable,
                  slashStatusLimitsUnavailable:
                    labels.slashStatusLimitsUnavailable
                }}
                onClose={closeSlashStatusPanel}
              />
            </ComposerFloatingMenuSurface>
            <ComposerFloatingMenuSurface
              anchorRef={inputShellRef}
              className="border-0 p-0"
              dismissBoundaryRef={promptInputAreaRef}
              maxHeight={SLASH_PALETTE_HEIGHT_PX}
              onDismiss={closeSlashFloatingMenu}
              open={isReviewPickerOpen}
              placement="dynamic-above"
              surfaceRef={paletteContentRef}
              testId="agent-gui-command-menu-surface"
            >
              <AgentReviewPickerPanel
                labels={labels.reviewPicker}
                onRequestGitBranches={reviewBranchLoader}
                onSubmitReview={submitReviewCommand}
                onClose={closeReviewPicker}
              />
            </ComposerFloatingMenuSurface>
          </Popover>
          <div className={styles.composerFooter}>
            <div className={composerStyles.footerGroup}>
              <div className="inline-flex shrink-0 items-center gap-1">
                {previewMode ? (
                  <TooltipProvider delayDuration={120}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={labels.referenceWorkspaceFiles}
                          className={cn(
                            styles.composerMenuTrigger,
                            styles.composerReferenceTrigger,
                            "w-auto justify-center text-[var(--agent-gui-text-secondary)] [&_svg]:shrink-0"
                          )}
                        >
                          <AddIcon
                            aria-hidden
                            className="size-3.5"
                            data-agent-reference-add-icon="true"
                          />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {labels.addContent}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <TooltipProvider delayDuration={120}>
                    <Tooltip>
                      <Select
                        open={false}
                        value={workspaceReferenceSelectValue}
                        disabled={
                          !onRequestWorkspaceReferences ||
                          composerControlsHardDisabled
                        }
                        onOpenChange={(isOpen) => {
                          if (isOpen) {
                            void handleWorkspaceReferencePicker();
                          }
                        }}
                        onValueChange={(nextValue) => {
                          if (nextValue === workspaceReferenceOptionValue) {
                            void handleWorkspaceReferencePicker();
                          }
                        }}
                      >
                        <TooltipTrigger asChild>
                          <SelectTrigger
                            size="sm"
                            aria-label={labels.referenceWorkspaceFiles}
                            className={cn(
                              styles.composerMenuTrigger,
                              styles.composerReferenceTrigger,
                              "w-auto justify-center text-[var(--agent-gui-text-secondary)] [&>svg:last-child]:hidden [&_svg]:shrink-0"
                            )}
                          >
                            <AddIcon
                              aria-hidden
                              className="size-3.5"
                              data-agent-reference-add-icon="true"
                            />
                          </SelectTrigger>
                        </TooltipTrigger>
                      </Select>
                      <TooltipContent side="top">
                        {labels.addContent}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                <button
                  type="button"
                  aria-label={labels.mentionPalette}
                  title={labels.mentionPalette}
                  disabled={composerControlsHardDisabled || inputDisabled}
                  className={cn(
                    styles.composerMenuTrigger,
                    styles.composerReferenceTrigger,
                    "group w-auto justify-center text-[var(--agent-gui-text-secondary)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0"
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleMentionPaletteButton}
                >
                  <span
                    aria-hidden
                    className="inline-block size-3.5 bg-[var(--text-secondary)] transition-colors group-hover:bg-[var(--text-primary)] group-focus-visible:bg-[var(--text-primary)]"
                    style={{
                      WebkitMaskImage: `url("${atLinedIconUrl}")`,
                      WebkitMaskPosition: "center",
                      WebkitMaskRepeat: "no-repeat",
                      WebkitMaskSize: "contain",
                      maskImage: `url("${atLinedIconUrl}")`,
                      maskPosition: "center",
                      maskRepeat: "no-repeat",
                      maskSize: "contain"
                    }}
                  />
                </button>
              </div>
              {showProviderSelect && selectedProviderSwitchTarget ? (
                <Select
                  value={selectedProviderTargetId}
                  disabled={providerSelectDisabled}
                  onValueChange={(nextTargetId) => {
                    const target = providerSwitchTargets.find(
                      (candidate) => candidate.targetId === nextTargetId
                    );
                    if (!target) {
                      return;
                    }
                    onProviderSelect?.({
                      provider: target.provider,
                      providerTargetId: target.targetId
                    });
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={labels.providerSwitchLabel}
                    title={labels.providerSwitchLabel}
                    className={cn(
                      styles.composerMenuTrigger,
                      styles.composerProviderSelect,
                      "max-w-[160px] text-[var(--agent-gui-text-secondary)]"
                    )}
                  >
                    <span className="min-w-0 truncate">
                      <SelectValue placeholder={selectedProviderLabel} />
                    </span>
                  </SelectTrigger>
                  <SelectContent
                    align="start"
                    className={cn(styles.composerMenuContent, "min-w-[190px]")}
                  >
                    {providerSwitchTargets.map((target) => (
                      <SelectItem
                        key={`${target.provider}:${target.targetId}`}
                        value={target.targetId}
                        className={cn(styles.composerMenuItem, "gap-2")}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <img
                            alt=""
                            aria-hidden="true"
                            className="size-4 shrink-0 rounded-[4px]"
                            src={resolveComposerProviderTargetIconUrl(target)}
                          />
                          <span className="min-w-0 truncate">
                            {target.label}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              {composerSettings.supportsPlanMode &&
              composerSettings.draftSettings.planMode ? (
                <button
                  type="button"
                  disabled={settingsControlsDisabled}
                  aria-label={labels.planModeLabel}
                  title={labels.planModeLabel}
                  data-agent-plan-mode-badge="true"
                  className={cn(
                    styles.composerMenuTrigger,
                    "group w-auto",
                    "disabled:cursor-not-allowed disabled:opacity-60"
                  )}
                  onClick={() => onSettingsChange({ planMode: false })}
                >
                  <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                    <span className="relative flex size-3.5 shrink-0 items-center justify-center">
                      <ListChecks
                        aria-hidden
                        className="size-3.5 transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
                      />
                      <span
                        aria-hidden
                        className="absolute inset-0 flex items-center justify-center rounded-full bg-[var(--text-secondary)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 group-disabled:opacity-0"
                      >
                        <X
                          className="size-2.5 text-[var(--background-fronted)]"
                          strokeWidth={3}
                        />
                      </span>
                    </span>
                    <span className="min-w-0 truncate">
                      {labels.planModeLabel}
                    </span>
                  </span>
                </button>
              ) : null}
              {isGoalModeActive ? (
                <button
                  type="button"
                  disabled={settingsControlsDisabled}
                  aria-label={labels.goalLabel}
                  title={labels.goalLabel}
                  data-agent-goal-badge="true"
                  className={cn(
                    styles.composerMenuTrigger,
                    "group w-auto",
                    "disabled:cursor-not-allowed disabled:opacity-60"
                  )}
                  onClick={clearGoalModeBadge}
                >
                  <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                    <span className="relative flex size-3.5 shrink-0 items-center justify-center">
                      <Target
                        aria-hidden
                        className="size-3.5 transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
                      />
                      <span
                        aria-hidden
                        className="absolute inset-0 flex items-center justify-center rounded-full bg-[var(--text-secondary)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 group-disabled:opacity-0"
                      >
                        <X
                          className="size-2.5 text-[var(--background-fronted)]"
                          strokeWidth={3}
                        />
                      </span>
                    </span>
                    <span className="min-w-0 truncate">{labels.goalLabel}</span>
                  </span>
                </button>
              ) : null}
            </div>
            <div className={composerStyles.footerGroupRight}>
              {usage && usage.percentUsed !== null ? (
                <AgentUsageChip
                  percentUsed={usage.percentUsed}
                  usedTokens={usage.usedTokens}
                  totalTokens={usage.totalTokens}
                  tooltipsEnabled={!previewMode}
                  compactSupported={compactSupported ?? false}
                  compactDisabled={
                    !hasCompactableContext || composerControlsHardDisabled
                  }
                  onCompact={() => onSubmit(textPromptContent("/compact"))}
                  labels={{
                    usageChipLabel: labels.usageChipLabel,
                    usageTooltipLabel: labels.usageTooltipLabel,
                    usagePopoverTitle: labels.usagePopoverTitle,
                    usageContextWindowLabel: labels.usageContextWindowLabel,
                    usageCompactAction: labels.usageCompactAction
                  }}
                />
              ) : null}
              {composerSettings.supportsPermissionMode ? (
                <AgentPermissionModeDropdown
                  composerSettings={composerSettings}
                  disabled={permissionModeControlsDisabled}
                  previewMode={previewMode}
                  labels={{
                    permissionLabel: labels.permissionLabel,
                    loadingOptions: labels.loadingOptions
                  }}
                  onSettingsChange={(patch) => onSettingsChange(patch)}
                />
              ) : null}
              {composerSettings.supportsModel ||
              composerSettings.supportsReasoningEffort ? (
                <AgentModelReasoningDropdown
                  composerSettings={composerSettings}
                  disabled={settingsControlsDisabled}
                  previewMode={previewMode}
                  labels={{
                    modelLabel: labels.modelLabel,
                    modelSelectionLabel: labels.modelSelectionLabel,
                    modelContextWindowSuffix: labels.modelContextWindowSuffix,
                    modelTooltipVersionLabel: labels.modelTooltipVersionLabel,
                    planModeLabel: labels.planModeLabel,
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
                    speedOptionStandardDescription:
                      labels.speedOptionStandardDescription,
                    speedOptionFast: labels.speedOptionFast,
                    speedOptionFastDescription:
                      labels.speedOptionFastDescription,
                    permissionLabel: labels.permissionLabel,
                    modelDescriptions: labels.modelDescriptions,
                    defaultModel: labels.defaultModel,
                    loadingOptions: labels.loadingOptions,
                    inheritedUnavailable: labels.inheritedUnavailable
                  }}
                  onSettingsChange={onSettingsChange}
                />
              ) : null}
              {isHeroLayout ? composerActionButton : null}
            </div>
          </div>
        </div>
        {showProjectRow ? (
          <div
            className={styles.composerProjectRow}
            data-project-missing={isSelectedProjectMissing ? "true" : undefined}
          >
            {showHeroProjectSelector ? (
              <AgentProjectDropdown
                composerSettings={composerSettings}
                i18n={workspaceUserProjectI18n}
                previewMode={previewMode}
                labels={{
                  projectLocked: labels.projectLocked,
                  projectMissingDescription: labels.projectMissingDescription
                }}
                selectProjectDirectory={selectProjectDirectory}
                onProjectMissingChange={setIsSelectedProjectMissing}
                onProjectPathChange={onProjectPathChange}
              />
            ) : null}
            {activePromptTip ? (
              <div
                className={styles.composerPromptTips}
                data-testid="agent-gui-prompt-tips"
              >
                {!previewMode && isPromptTipOverflowing && promptTipNode ? (
                  <TooltipProvider delayDuration={0}>
                    <Tooltip>
                      <TooltipTrigger asChild>{promptTipNode}</TooltipTrigger>
                      <TooltipContent
                        align="end"
                        className={styles.composerPromptTipTooltip}
                        side="bottom"
                      >
                        {activePromptTipText}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  promptTipNode
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </form>
  );
}

function AgentComposerDraftImagePreview({
  image,
  removeLabel,
  onRemove
}: {
  image: AgentComposerDraftImage;
  removeLabel: string;
  onRemove: (id: string) => void;
}): React.JSX.Element {
  const [aspectRatio, setAspectRatio] = useState(1);
  const previewWidth = Math.round(
    Math.min(
      DRAFT_IMAGE_PREVIEW_MAX_WIDTH_PX,
      Math.max(
        DRAFT_IMAGE_PREVIEW_MIN_WIDTH_PX,
        aspectRatio * DRAFT_IMAGE_PREVIEW_BASE_HEIGHT_PX
      )
    )
  );
  const previewStyle = {
    aspectRatio: String(aspectRatio),
    width: `${previewWidth}px`
  } satisfies CSSProperties;

  return (
    <div
      className={cn(
        "group relative min-w-0 overflow-hidden rounded-[6px] border border-[var(--line-1)] bg-[var(--background-fronted)]",
        "[&>[data-rmiz]]:block [&>[data-rmiz]]:size-full",
        "[&>[data-rmiz]>[data-rmiz-content]]:block [&>[data-rmiz]>[data-rmiz-content]]:size-full",
        image.uploadError &&
          "border-[color:color-mix(in_srgb,var(--danger)_55%,var(--line-1))]"
      )}
      data-testid="agent-gui-composer-image-draft"
      data-uploading={image.uploading ? "true" : undefined}
      data-upload-error={image.uploadError ? "true" : undefined}
      style={previewStyle}
    >
      <ZoomableImage
        src={image.previewUrl}
        alt={image.name}
        className="size-full object-contain"
        draggable={false}
        downloadName={image.name || "image.png"}
        onLoad={(event) => {
          const element = event.currentTarget;
          const width = element.naturalWidth;
          const height = element.naturalHeight;
          if (width <= 0 || height <= 0) {
            return;
          }
          const nextRatio = Math.min(
            DRAFT_IMAGE_PREVIEW_MAX_RATIO,
            Math.max(DRAFT_IMAGE_PREVIEW_MIN_RATIO, width / height)
          );
          setAspectRatio(nextRatio);
        }}
      />
      {image.uploading ? (
        <div
          className="absolute inset-0 grid place-items-center bg-[color-mix(in_srgb,var(--background-fronted)_62%,transparent)]"
          data-testid="agent-gui-composer-image-uploading"
        >
          <Spinner
            className="text-[var(--text-primary)]"
            size={18}
            strokeWidth={2.4}
            trackColor="var(--transparency-hover)"
            testId="agent-gui-composer-image-upload-spinner"
          />
        </div>
      ) : null}
      <button
        type="button"
        className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--text-primary)_16%,transparent)] bg-[color-mix(in_srgb,var(--background-fronted)_88%,transparent)] text-[var(--text-primary)] opacity-90 shadow-sm transition hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text-primary)_34%,transparent)]"
        aria-label={removeLabel}
        title={removeLabel}
        onClick={() => onRemove(image.id)}
      >
        <X size={12} strokeWidth={2.4} aria-hidden />
      </button>
    </div>
  );
}

function slashCommandDescriptionForDisplay(
  command: AgentSessionCommand,
  labels: Pick<
    AgentComposerProps["labels"],
    | "slashCommandCompactDescription"
    | "slashCommandContextDescription"
    | "slashCommandFastDescription"
    | "slashCommandGoalDescription"
    | "slashCommandInitDescription"
    | "slashCommandPlanDescription"
    | "slashCommandReviewDescription"
    | "slashCommandStatusDescription"
    | "slashCommandUsageDescription"
  >
): string | undefined {
  switch (command.name.trim().toLowerCase()) {
    case "compact":
      return labels.slashCommandCompactDescription;
    case "context":
      return labels.slashCommandContextDescription;
    case "fast":
      return labels.slashCommandFastDescription;
    case "goal":
      return labels.slashCommandGoalDescription;
    case "init":
      return labels.slashCommandInitDescription;
    case "plan":
      return labels.slashCommandPlanDescription;
    case "review":
      return labels.slashCommandReviewDescription;
    case "status":
      return labels.slashCommandStatusDescription;
    case "usage":
      return labels.slashCommandUsageDescription;
    default:
      return command.description;
  }
}

function slashCommandLabelForDisplay(
  command: AgentSessionCommand,
  labels: Pick<
    AgentComposerProps["labels"],
    | "slashCommandCompactLabel"
    | "slashCommandContextLabel"
    | "slashCommandFastLabel"
    | "slashCommandGoalLabel"
    | "slashCommandInitLabel"
    | "slashCommandPlanLabel"
    | "slashCommandReviewLabel"
    | "slashCommandStatusLabel"
    | "slashCommandUsageLabel"
  >,
  uiLanguage: UiLanguage
): { primaryLabel?: string; secondaryLabel?: string } {
  const canonicalLabel = labelForSlashCommand(command);
  const primaryLabel = localizedSlashCommandLabel(command, labels);
  return uiLanguage === "en" || primaryLabel === canonicalLabel
    ? { primaryLabel }
    : { primaryLabel, secondaryLabel: canonicalLabel };
}

function localizedSlashCommandLabel(
  command: AgentSessionCommand,
  labels: Pick<
    AgentComposerProps["labels"],
    | "slashCommandCompactLabel"
    | "slashCommandContextLabel"
    | "slashCommandFastLabel"
    | "slashCommandGoalLabel"
    | "slashCommandInitLabel"
    | "slashCommandPlanLabel"
    | "slashCommandReviewLabel"
    | "slashCommandStatusLabel"
    | "slashCommandUsageLabel"
  >
): string {
  switch (command.name.trim().toLowerCase()) {
    case "compact":
      return labels.slashCommandCompactLabel;
    case "context":
      return labels.slashCommandContextLabel;
    case "fast":
      return labels.slashCommandFastLabel;
    case "goal":
      return labels.slashCommandGoalLabel;
    case "init":
      return labels.slashCommandInitLabel;
    case "plan":
      return labels.slashCommandPlanLabel;
    case "review":
      return labels.slashCommandReviewLabel;
    case "status":
      return labels.slashCommandStatusLabel;
    case "usage":
      return labels.slashCommandUsageLabel;
    default:
      return labelForSlashCommand(command);
  }
}

function goalDraftObjectiveFromPrompt(prompt: string): string | null {
  const match = /^\s*\/goal(?:\s+([\s\S]*))?\s*$/u.exec(prompt);
  if (!match) {
    return null;
  }
  return match[1] ?? "";
}

function buildGoalModePrompt(objective: string): string {
  return objective.trim() === ""
    ? GOAL_MODE_SLASH_COMMAND
    : `${GOAL_MODE_SLASH_COMMAND} ${objective}`;
}

function isSlashCommandCapability(
  command: AgentSlashCommand
): command is AgentSlashCommandCapability {
  return "kind" in command && command.kind === "capability";
}

function useStableEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

function SendFilledIcon(): React.JSX.Element {
  "use memo";
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2.74311 8.80587C2.84592 8.40096 3.14571 8.08844 3.54551 7.97033L18.5197 3.51569C18.9336 3.39383 19.3809 3.5054 19.6881 3.81262C19.9951 4.11984 20.1076 4.56798 19.9857 4.9817L15.5311 19.9559C15.413 20.3557 15.1005 20.6555 14.6956 20.7583C14.2895 20.8597 13.869 20.7438 13.5721 20.4469L10.455 15.1823C10.8585 14.6483 12.1563 12.9094 14.3475 9.96528C14.6086 9.70419 14.6382 9.31168 14.4138 9.08692C14.1891 8.86221 13.796 8.8913 13.5348 9.15252L8.31088 13.0423L3.05316 9.92799C2.7562 9.63104 2.64049 9.21071 2.74311 8.80587Z"
        fill="currentColor"
      />
    </svg>
  );
}
