import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  Fragment,
  type FormEvent
} from "react";
import { createPortal } from "react-dom";
import type { AgentSessionCommand } from "../../shared/agentSessionTypes";
import type {
  AgentComposerDraft,
  AgentComposerDraftImage,
  AgentGUIComposerSettingsVM,
  AgentGUIProviderSkillOption,
  AgentGUIQueuedPromptVM
} from "./model/agentGuiNodeTypes";
import {
  Popover,
  PopoverAnchor
} from "../../app/renderer/components/ui/popover";
import { Spinner } from "../../app/renderer/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "../../app/renderer/components/ui/tooltip";
import type { AgentConversationPromptVM } from "../../shared/agentConversation/contracts/agentConversationVM";
import { cn } from "../../app/renderer/lib/utils";
import {
  AddIcon,
  menuItemClassName,
  Select,
  SelectTrigger
} from "@tutti-os/ui-system";
import { X } from "lucide-react";
import { makeAtPanelKeyDown } from "@tutti-os/ui-rich-text/at-panel";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import {
  clampSlashCommandHighlight,
  filterSlashCommands,
  getSlashCommandQuery,
  labelForSlashCommand,
  moveSlashCommandHighlight
} from "./model/agentSlashCommands";
import {
  draftForProviderSkill,
  filterProviderSkills,
  getProviderSkillQueryMatch,
  labelForProviderSkill,
  skillDescriptionForDisplay,
  skillTriggerForPrefix
} from "./model/agentSkillOptions";
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
  composerModeOptions,
  composerModeSelectedValue,
  composerModeSelectionPatch,
  nextComposerModeValue
} from "./model/composerModeCycle";
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
  readAgentRichTextPromptImages
} from "./agentRichText/agentRichTextPromptImages";
import type { AgentPromptContentBlock } from "../../shared/contracts/dto/agentSession";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../shared/AgentMessageMarkdown";
import type { AgentCapabilityTokenOption } from "./agentRichText/agentCapabilityTokenExtension";
import {
  AgentMentionSearchController,
  type AgentMentionFilterId,
  type AgentMentionSearchState
} from "./AgentMentionSearchController";
import {
  AgentFileMentionPalette,
  flattenAgentMentionPaletteEntries
} from "./AgentFileMentionPalette";
import { AGENT_MENTION_FILTER_TAB_ORDER } from "./agentMentionSearchHelpers";
import {
  exitAgentFileMentionSuggestion,
  type AgentContextMentionItem,
  type AgentFileMentionSuggestionState
} from "./agentRichText/agentFileMentionExtension";
import { isAgentRichTextImeComposing } from "./agentRichText/agentRichTextIme";
import {
  resolveWorkspaceLinkAction,
  type WorkspaceLinkAction
} from "../../actions/workspaceLinkActions";
import type { AgentRichTextAtProvider } from "./agentRichTextAtProvider";
import { hasWorkspaceFileDropData } from "../terminalNode/workspaceFileDrop";
import {
  AgentReviewBranchController,
  type AgentReviewBranchState
} from "./AgentReviewBranchController";

export interface AgentComposerProps {
  workspaceId: string;
  workspacePath?: string | null;
  currentUserId?: string | null;
  provider: string;
  slashStatus?: AgentComposerSlashStatus | null;
  draftContent: AgentComposerDraft;
  availableCommands: readonly AgentSessionCommand[];
  hasCompactableContext?: boolean;
  compactSupported?: boolean | null;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  disabled: boolean;
  disabledReason?: string | null;
  submitDisabled: boolean;
  placeholder: string;
  composerSettings: AgentGUIComposerSettingsVM;
  queuedPrompts: readonly AgentGUIQueuedPromptVM[];
  drainingQueuedPromptId: string | null;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  canQueueWhileBusy: boolean;
  showStopButton: boolean;
  activePrompt: AgentConversationPromptVM | null;
  activePromptKeyboardShortcutsEnabled?: boolean;
  promptTips?: readonly AgentComposerPromptTip[];
  isInterrupting: boolean;
  isSendingTurn: boolean;
  isSubmittingPrompt: boolean;
  isActive?: boolean;
  promptImagesSupported?: boolean;
  composerFocusRequestSequence?: number | null;
  layoutMode?: "dock" | "hero";
  showProjectSelector?: boolean;
  labels: {
    send: string;
    modelLabel: string;
    modelSelectionLabel: string;
    defaultModel: string;
    inheritedUnavailable: string;
    loadingConversation: string;
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
    browserUseCapabilityLabel: string;
    browserUseCapabilityDescription: string;
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
    removeMention: string;
    addReference: string;
    referenceWorkspaceFiles: string;
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
    permissionModeId?: string | null;
  }) => void;
  onSubmit: (content: AgentPromptContentBlock[]) => void;
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
    | (() => Promise<WorkspaceFileReference[]>)
    | null;
  onRequestGitBranches?: AgentComposerGitBranchLoader | null;
  richTextAtProviders?: readonly AgentRichTextAtProvider[];
}

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

const composerStyles = {
  footerGroup: styles.composerFooterLeft,
  footerGroupRight: styles.composerFooterRight,
  dropdownSurface:
    "nodrag isolate rounded-[12px] border border-hairline bg-background-fronted p-[4px] text-foreground shadow-[var(--tsh-shell-shadow)] [-webkit-app-region:no-drag]",
  slashDropdown: "overflow-hidden"
};

const workspaceReferenceSelectValue = "__tutti_workspace_reference_idle__";
const workspaceReferenceOptionValue = "__tutti_workspace_reference_add__";
const composerPaletteZIndex = "var(--z-popover)";
const SLASH_PALETTE_HEIGHT_PX = 280;
const MENTION_PALETTE_MIN_HEIGHT_PX = 280;
const MENTION_PALETTE_MAX_HEIGHT_PX = 320;
const MENTION_PALETTE_GAP_PX = 8;
const MENTION_PALETTE_VIEWPORT_PADDING_PX = 8;
const EMPTY_RICH_TEXT_AT_PROVIDERS: readonly AgentRichTextAtProvider[] = [];
const EMPTY_PROMPT_TIPS: readonly AgentComposerPromptTip[] = [];
const EMPTY_PROVIDER_SKILLS: readonly AgentGUIProviderSkillOption[] = [];
const EMPTY_WORKSPACE_APP_ICONS: readonly AgentMessageMarkdownWorkspaceAppIcon[] =
  [];
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

export function formatSlashStatusTokenCount(
  value: number | null | undefined
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }
  return Math.max(0, Math.trunc(value)).toLocaleString("en-US");
}

function slashStatusContextText(
  status: AgentComposerSlashStatus | null | undefined,
  labels: Pick<
    AgentComposerProps["labels"],
    "slashStatusContextValue" | "slashStatusContextUnavailable"
  >
): string {
  const usedTokens = status?.contextWindow?.usedTokens;
  const totalTokens = status?.contextWindow?.totalTokens;
  if (
    typeof usedTokens !== "number" ||
    !Number.isFinite(usedTokens) ||
    typeof totalTokens !== "number" ||
    !Number.isFinite(totalTokens) ||
    totalTokens <= 0
  ) {
    return labels.slashStatusContextUnavailable;
  }
  const used = Math.max(0, Math.trunc(usedTokens));
  const total = Math.max(0, Math.trunc(totalTokens));
  const percentLeft = Math.max(
    0,
    Math.min(100, Math.round(((total - used) / total) * 100))
  );
  return labels.slashStatusContextValue({
    percentLeft,
    usedTokens: formatSlashStatusTokenCount(used),
    totalTokens: formatSlashStatusTokenCount(total)
  });
}

function AgentSlashStatusPanel({
  status,
  labels,
  onClose
}: {
  status: AgentComposerSlashStatus | null | undefined;
  labels: Pick<
    AgentComposerProps["labels"],
    | "slashStatusTitle"
    | "slashStatusSession"
    | "slashStatusBaseUrl"
    | "slashStatusContext"
    | "slashStatusLimits"
    | "slashStatusClose"
    | "slashStatusContextValue"
    | "slashStatusContextUnavailable"
    | "slashStatusLimitsUnavailable"
  >;
  onClose: () => void;
}): React.JSX.Element {
  const limits = status?.limits ?? [];
  const agentSessionId = status?.agentSessionId?.trim() ?? "";
  const baseUrl = status?.baseUrl?.trim() ?? "";
  const showSessionDetails = agentSessionId.length > 0;
  return (
    <section
      className="agent-gui-node__slash-status-panel"
      data-testid="agent-gui-slash-status-panel"
      role="status"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="truncate text-[11px] font-semibold leading-4">
          {labels.slashStatusTitle}
        </h3>
        <button
          className="nodrag shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px] leading-4 text-muted-foreground transition-colors hover:bg-background-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]"
          type="button"
          onClick={onClose}
        >
          {labels.slashStatusClose}
        </button>
      </div>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[11px] leading-4">
        {showSessionDetails ? (
          <>
            <dt className="text-muted-foreground">
              {labels.slashStatusSession}:
            </dt>
            <dd className="min-w-0 truncate">{agentSessionId}</dd>
            {baseUrl ? (
              <>
                <dt className="text-muted-foreground">
                  {labels.slashStatusBaseUrl}:
                </dt>
                <dd className="min-w-0 truncate">{baseUrl}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">
              {labels.slashStatusContext}:
            </dt>
            <dd className="min-w-0">
              {slashStatusContextText(status, labels)}
            </dd>
          </>
        ) : null}
        {limits.map((limit) => (
          <Fragment key={limit.id}>
            <dt className="text-muted-foreground">{limit.label}:</dt>
            <dd className="min-w-0">
              <span className="agent-gui-node__slash-status-limit">
                {typeof limit.percentRemaining === "number" &&
                Number.isFinite(limit.percentRemaining) ? (
                  <span
                    aria-hidden="true"
                    className="agent-gui-node__slash-status-limit-meter"
                  >
                    <span
                      className="agent-gui-node__slash-status-limit-meter-fill"
                      style={{
                        width: `${Math.max(
                          0,
                          Math.min(100, limit.percentRemaining)
                        )}%`
                      }}
                    />
                  </span>
                ) : null}
                <span className="agent-gui-node__slash-status-limit-value">
                  {limit.value}
                  {limit.reset ? (
                    <span className="text-muted-foreground">
                      {" "}
                      ({limit.reset})
                    </span>
                  ) : null}
                </span>
              </span>
            </dd>
          </Fragment>
        ))}
        {limits.length === 0 && status?.limitsLoading ? (
          <>
            <dt className="text-muted-foreground">
              {labels.slashStatusLimits}:
            </dt>
            <dd className="min-w-0 text-muted-foreground">
              {labels.slashStatusLimitsUnavailable}
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

type ReviewStage = "root" | "base" | "commit" | "custom";

interface ReviewMenuEntry {
  key: string;
  label: string;
  description?: string;
  disabled?: boolean;
  onSelect: () => void;
}

const reviewMenuStyles = {
  panel:
    "agent-gui-node__slash-status-panel nodrag flex max-h-[280px] flex-col gap-1 overflow-hidden [-webkit-app-region:no-drag]",
  search:
    "nodrag h-8 w-full shrink-0 rounded-[6px] border-0 bg-transparent px-2.5 text-[11px] leading-4 text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus-visible:outline-none [-webkit-app-region:no-drag]",
  list: "flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto",
  option: cn(
    menuItemClassName,
    "nodrag min-h-9 w-full min-w-0 justify-start overflow-hidden rounded-[6px] border-0 bg-transparent px-2.5 py-2 text-left hover:bg-[var(--transparency-block)] focus:bg-[var(--transparency-block)] focus-visible:outline-none data-[highlighted]:bg-[var(--transparency-block)] active:bg-[var(--transparency-active)] disabled:pointer-events-none disabled:opacity-50"
  ),
  copy: "flex min-w-0 flex-1 items-baseline gap-1 overflow-hidden leading-[16px]",
  name: "min-w-0 shrink-0 truncate text-[11px] font-semibold text-[var(--text-primary)]",
  description:
    "min-w-0 flex-1 truncate text-[11px] font-normal text-[var(--text-secondary)]",
  message:
    "select-none px-2.5 py-2 text-[11px] leading-4 text-[var(--text-secondary)]"
};

// A staged, searchable command menu (root scopes -> branch/commit/custom),
// mirroring the slash-command palette interaction instead of nested dropdowns.
function AgentReviewPickerPanel({
  labels,
  onRequestGitBranches,
  onSubmitReview,
  onClose
}: {
  labels: AgentComposerProps["labels"]["reviewPicker"];
  onRequestGitBranches?: (() => Promise<AgentComposerGitBranches>) | null;
  onSubmitReview: (command: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [stage, setStage] = useState<ReviewStage>("root");
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const highlightedOptionRef = useRef<HTMLButtonElement | null>(null);

  // The controller owns all branch-load orchestration (lazy load, in-flight
  // de-duplication, caching, loading/error state). It is created inside the
  // subscribe effect (and held in a ref) rather than in `useState`, mirroring
  // AgentMentionSearchController: a persisted instance disposed on effect
  // cleanup would stay permanently disposed after React StrictMode's
  // mount -> cleanup -> remount cycle, so `ensureLoaded` would never run.
  const reviewBranchControllerRef = useRef<AgentReviewBranchController | null>(
    null
  );
  const [branchState, setBranchState] = useState<AgentReviewBranchState>({
    status: "idle",
    branches: [],
    currentBranch: null,
    error: null
  });

  useEffect(() => {
    const controller = new AgentReviewBranchController();
    reviewBranchControllerRef.current = controller;
    const unsubscribe = controller.subscribe(setBranchState);
    return () => {
      unsubscribe();
      controller.dispose();
      reviewBranchControllerRef.current = null;
    };
  }, []);

  // Keep the controller pointed at the current loader and trigger a lazy load
  // once the user drills into the base-branch stage.
  useEffect(() => {
    const controller = reviewBranchControllerRef.current;
    if (!controller) {
      return;
    }
    controller.setLoader(onRequestGitBranches ?? null);
    if (stage === "base") {
      controller.ensureLoaded();
    }
  }, [onRequestGitBranches, stage]);

  // Keep focus in the search field as the user drills between stages.
  useEffect(() => {
    searchInputRef.current?.focus();
  }, [stage]);

  const submit = useCallback(
    (command: string): void => {
      onSubmitReview(command);
    },
    [onSubmitReview]
  );

  const goToStage = useCallback((next: ReviewStage): void => {
    setStage(next);
    setQuery("");
    setHighlightedIndex(0);
  }, []);

  const goBackToRoot = useCallback((): void => {
    setStage("root");
    setQuery("");
    setHighlightedIndex(0);
  }, []);

  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.toLowerCase();

  const entries = useMemo<ReviewMenuEntry[]>(() => {
    if (stage === "root") {
      const options: ReviewMenuEntry[] = [
        {
          key: "uncommitted",
          label: labels.uncommitted,
          onSelect: () => submit("/review")
        },
        {
          key: "base",
          label: labels.baseBranch,
          onSelect: () => goToStage("base")
        },
        {
          key: "commit",
          label: labels.commit,
          onSelect: () => goToStage("commit")
        },
        {
          key: "custom",
          label: labels.custom,
          onSelect: () => goToStage("custom")
        }
      ];
      if (normalizedQuery === "") {
        return options;
      }
      return options.filter((option) =>
        option.label.toLowerCase().includes(normalizedQuery)
      );
    }
    if (stage === "base") {
      const branches =
        normalizedQuery === ""
          ? branchState.branches
          : branchState.branches.filter((name) =>
              name.toLowerCase().includes(normalizedQuery)
            );
      return branches.map((name) => ({
        key: `branch:${name}`,
        label: name,
        onSelect: () => submit(`/review base:${name}`)
      }));
    }
    // commit / custom: the search box doubles as the free-text input; the single
    // confirm entry submits the typed value when non-empty.
    const prefix = stage === "commit" ? "commit" : "custom";
    return [
      {
        key: `${prefix}-confirm`,
        label: labels.submit,
        description: trimmedQuery || undefined,
        disabled: trimmedQuery === "",
        onSelect: () => {
          if (trimmedQuery !== "") {
            submit(`/review ${prefix}:${trimmedQuery}`);
          }
        }
      }
    ];
  }, [
    stage,
    normalizedQuery,
    trimmedQuery,
    branchState.branches,
    labels.uncommitted,
    labels.baseBranch,
    labels.commit,
    labels.custom,
    labels.submit,
    submit,
    goToStage
  ]);

  const safeHighlightedIndex =
    entries.length === 0 ? -1 : Math.min(highlightedIndex, entries.length - 1);

  // Keep the highlighted entry visible while navigating a long list with the
  // arrow keys (e.g. many branches).
  useEffect(() => {
    highlightedOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [safeHighlightedIndex]);

  const searchPlaceholder =
    stage === "base"
      ? labels.branchPlaceholder
      : stage === "commit"
        ? labels.commitPlaceholder
        : stage === "custom"
          ? labels.customPlaceholder
          : labels.searchPlaceholder;

  // Shown in place of the list when there are no entries (branch loading /
  // empty repo / no search matches).
  let emptyMessage = labels.noResults;
  if (stage === "base") {
    if (branchState.status === "loading") {
      emptyMessage = labels.branchLoading;
    } else if (branchState.branches.length === 0) {
      emptyMessage = labels.branchEmpty;
    }
  }

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedIndex((current) =>
          entries.length === 0 ? 0 : Math.min(current + 1, entries.length - 1)
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const entry = entries[safeHighlightedIndex];
        if (entry && !entry.disabled) {
          entry.onSelect();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (stage === "root") {
          onClose();
        } else {
          goBackToRoot();
        }
        return;
      }
      if (event.key === "Backspace" && query === "" && stage !== "root") {
        event.preventDefault();
        goBackToRoot();
      }
    },
    [entries, safeHighlightedIndex, stage, query, onClose, goBackToRoot]
  );

  return (
    <section
      className={reviewMenuStyles.panel}
      data-testid="agent-gui-review-picker-panel"
      role="dialog"
      aria-label={labels.title}
    >
      <input
        ref={searchInputRef}
        type="search"
        className={reviewMenuStyles.search}
        value={query}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlightedIndex(0);
        }}
        onKeyDown={handleKeyDown}
      />
      <div
        className={reviewMenuStyles.list}
        role="listbox"
        aria-label={labels.title}
      >
        {entries.length === 0 ? (
          <div className={reviewMenuStyles.message}>{emptyMessage}</div>
        ) : (
          entries.map((entry, index) => {
            const isHighlighted = index === safeHighlightedIndex;
            return (
              <button
                key={entry.key}
                ref={isHighlighted ? highlightedOptionRef : null}
                type="button"
                className={cn(
                  reviewMenuStyles.option,
                  isHighlighted && "bg-[var(--transparency-block)]"
                )}
                role="option"
                aria-selected={isHighlighted}
                data-highlighted={isHighlighted ? "" : undefined}
                disabled={entry.disabled}
                onMouseEnter={() => setHighlightedIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!entry.disabled) {
                    entry.onSelect();
                  }
                }}
              >
                <span className={reviewMenuStyles.copy}>
                  <span className={reviewMenuStyles.name}>{entry.label}</span>
                  {entry.description ? (
                    <span className={reviewMenuStyles.description}>
                      {entry.description}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}

export function AgentComposer({
  workspaceId,
  workspacePath,
  currentUserId,
  provider,
  slashStatus = null,
  draftContent,
  availableCommands,
  hasCompactableContext = true,
  compactSupported = null,
  availableSkills = EMPTY_PROVIDER_SKILLS,
  disabled,
  disabledReason,
  submitDisabled,
  placeholder,
  composerSettings,
  queuedPrompts,
  drainingQueuedPromptId,
  workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS,
  canQueueWhileBusy,
  showStopButton,
  activePrompt,
  activePromptKeyboardShortcutsEnabled = true,
  promptTips = EMPTY_PROMPT_TIPS,
  isInterrupting,
  isSendingTurn,
  isSubmittingPrompt,
  isActive = true,
  promptImagesSupported = true,
  composerFocusRequestSequence = null,
  layoutMode = "dock",
  showProjectSelector = true,
  labels,
  workspaceUserProjectI18n,
  onDraftContentChange,
  onProjectPathChange = () => {},
  onSettingsChange,
  onSubmit,
  onSendQueuedPromptNext,
  onRemoveQueuedPrompt,
  onEditQueuedPrompt,
  onInterruptCurrentTurn,
  onPromptImagesUnsupported,
  onSubmitInteractivePrompt,
  onLinkAction,
  onRequestWorkspaceReferences = null,
  onRequestGitBranches = null,
  richTextAtProviders = EMPTY_RICH_TEXT_AT_PROVIDERS
}: AgentComposerProps): React.JSX.Element {
  "use memo";
  const draftPrompt = draftContent.prompt;
  const draftImages = draftContent.images;
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
  const [paletteDraftPrompt, setPaletteDraftPrompt] = useState(draftPrompt);
  const [fileMentionSuggestion, setFileMentionSuggestion] =
    useState<AgentFileMentionSuggestionState | null>(null);
  const [isSelectedProjectMissing, setIsSelectedProjectMissing] =
    useState(false);
  const [submittedImagePreview, setSubmittedImagePreview] = useState<
    AgentComposerDraftImage[]
  >([]);
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
      filter: "all",
      categories: [],
      groups: [],
      error: null
    });
  const composerRef = useRef<HTMLFormElement | null>(null);
  const inputShellRef = useRef<HTMLDivElement | null>(null);
  const paletteContentRef = useRef<HTMLDivElement | null>(null);
  const draftPromptRef = useRef(draftPrompt);
  const submittedImagePreviewObservedBusyRef = useRef(false);
  const promptTipRef = useRef<HTMLSpanElement | null>(null);
  const mentionControllerRef = useRef<AgentMentionSearchController | null>(
    null
  );
  const editorHandleRef = useRef<AgentRichTextEditorHandle | null>(null);
  const wasActiveRef = useRef(isActive);
  const lastComposerFocusRequestRef = useRef<number | null>(null);
  const autoMentionHighlightedKeyRef = useRef<string | null>(null);
  const [isPromptTipOverflowing, setIsPromptTipOverflowing] = useState(false);
  const slashQuery = getSlashCommandQuery(paletteDraftPrompt);
  const promptBeforeSelection =
    editorHandleRef.current?.getPromptTextBeforeSelection() ?? "";
  const skillQueryDraft = promptBeforeSelection || paletteDraftPrompt;
  const skillQueryMatch = getProviderSkillQueryMatch({
    draft: skillQueryDraft,
    provider
  });
  const resolvedSlashCommands = useMemo(
    () =>
      resolveSlashCommandsForProvider({
        provider,
        commands: availableCommands,
        hasCompactableContext,
        compactSupported,
        browserSupported: Boolean(composerSettings.supportsBrowser)
      }),
    [
      availableCommands,
      compactSupported,
      composerSettings.supportsBrowser,
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
        : filterProviderSkills({
            skills: availableSkills,
            query: skillQueryMatch.query,
            triggerPrefix: skillQueryMatch.prefix
          }),
    [availableSkills, skillQueryMatch]
  );
  const availableCapabilities = useMemo<AgentCapabilityTokenOption[]>(
    () =>
      composerSettings.supportsBrowser
        ? [
            {
              capability: "browserUse",
              label: labels.browserUseCapabilityLabel,
              name: "browser",
              trigger: "/browser"
            }
          ]
        : [],
    [composerSettings.supportsBrowser, labels.browserUseCapabilityLabel]
  );
  const slashPaletteEntries = useMemo<AgentSlashPaletteEntry[]>(() => {
    const commandEntries: AgentSlashPaletteEntry[] = filteredCommands.map(
      (command) => {
        if (isSlashCommandCapability(command)) {
          return {
            type: "capability",
            key: `capability:${command.capability}`,
            label: labels.browserUseCapabilityLabel,
            description: labels.browserUseCapabilityDescription,
            capability: command
          };
        }
        return {
          type: "command",
          key: `command:${command.name}`,
          label: labelForSlashCommand(command),
          ...(command.description ? { description: command.description } : {}),
          command
        };
      }
    );
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
    filteredCommands,
    filteredSkills,
    labels.browserUseCapabilityDescription,
    labels.browserUseCapabilityLabel,
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
  const activeHighlight = clampSlashCommandHighlight(
    highlightedIndex,
    slashPaletteEntries.length
  );
  const mentionPaletteEntries = useMemo(
    () => flattenAgentMentionPaletteEntries(mentionSearchState),
    [mentionSearchState]
  );
  const [mentionPaletteFrame, setMentionPaletteFrame] =
    useState<MentionPaletteFrame | null>(null);
  const [slashPaletteFrame, setSlashPaletteFrame] =
    useState<MentionPaletteFrame | null>(null);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [skillQueryMatch?.prefix, skillQueryMatch?.query, slashQuery]);

  useEffect(() => {
    const firstKey = mentionPaletteEntries[0]?.key ?? null;
    if (!firstKey) {
      autoMentionHighlightedKeyRef.current = null;
      setMentionHighlightedKey(null);
      return;
    }
    if (shouldResetMentionHighlightToFilter) {
      const resetKey =
        mentionSearchState.mode === "browse"
          ? `category:${mentionSearchState.filter}`
          : null;
      autoMentionHighlightedKeyRef.current = resetKey;
      setMentionHighlightedKey(resetKey);
      setShouldResetMentionHighlightToFilter(false);
      return;
    }
    setMentionHighlightedKey((current) => {
      const hasCurrent =
        current !== null &&
        mentionPaletteEntries.some((entry) => entry.key === current);
      if (hasCurrent && current !== autoMentionHighlightedKeyRef.current) {
        return current;
      }
      autoMentionHighlightedKeyRef.current = firstKey;
      return firstKey;
    });
  }, [
    mentionPaletteEntries,
    mentionSearchState.filter,
    mentionSearchState.mode,
    shouldResetMentionHighlightToFilter
  ]);

  useEffect(() => {
    const controller = new AgentMentionSearchController({
      richTextAtProviders
    });
    mentionControllerRef.current = controller;
    const unsubscribe = controller.subscribe(setMentionSearchState);
    return () => {
      unsubscribe();
      controller.dispose();
      mentionControllerRef.current = null;
    };
  }, [richTextAtProviders]);

  useEffect(() => {
    draftPromptRef.current = draftPrompt;
    setPaletteDraftPrompt(draftPrompt);
  }, [draftPrompt]);

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

  const closeReviewPicker = useCallback((): void => {
    setIsReviewPickerOpen(false);
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
        onSubmit(textPromptContent(effect.prompt));
        return;
      }
      if (effect.kind === "showStatus") {
        clearSlashCommandDraft();
        setIsSlashStatusPanelOpen((current) => !current);
        return;
      }
      if (effect.kind === "showReviewPicker") {
        clearSlashCommandDraft();
        setIsReviewPickerOpen(true);
        return;
      }
      if (effect.kind === "blockCommand") {
        clearSlashCommandDraft();
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
        draftForProviderSkill(skill, draftPromptRef.current, skillQueryMatch);
      draftPromptRef.current = nextDraft;
      setPaletteDraftPrompt(nextDraft);
      onDraftContentChange({ ...draftContent, prompt: nextDraft });
      setIsPaletteOpen(false);
    },
    [draftContent, onDraftContentChange, promptBeforeSelection, skillQueryMatch]
  );

  const submitCurrentPrompt = useStableEventCallback((): void => {
    const canSubmitWhileSending = canQueueWhileBusy && isSendingTurn;
    if (
      isSelectedProjectMissing ||
      submitDisabled ||
      (disabled && !canQueueWhileBusy) ||
      (isSendingTurn && !canSubmitWhileSending)
    ) {
      return;
    }
    const nextPrompt = draftPromptRef.current;
    const nextDraftContent = { ...draftContent, prompt: nextPrompt };
    if (!agentComposerDraftHasContent(nextDraftContent)) {
      return;
    }
    if (draftImages.length > 0 && !promptImagesSupported) {
      onPromptImagesUnsupported?.();
      return;
    }
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
    setIsPaletteOpen(false);
    onSubmit(
      agentComposerDraftToPromptContent({
        draft: nextDraftContent,
        provider,
        skills: availableSkills
      })
    );
    if (draftImages.length > 0 && !canQueueWhileBusy) {
      setSubmittedImagePreview(draftImages);
      submittedImagePreviewObservedBusyRef.current = false;
    } else {
      setSubmittedImagePreview([]);
      submittedImagePreviewObservedBusyRef.current = false;
    }
    draftPromptRef.current = "";
    setPaletteDraftPrompt("");
    onDraftContentChange(emptyAgentComposerDraft());
  });

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
          selectCapability(activeEntry.capability);
        } else if (activeEntry?.type === "skill") {
          selectSkill(activeEntry.skill);
        }
        return true;
      }
      return false;
    }
  );

  const selectFileMention = useCallback(
    (entry: AgentContextMentionItem): void => {
      if (
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

  const closeOpenPalette = useCallback((): void => {
    if (showFileMentionPalette) {
      closeFileMentionPalette();
      return;
    }
    setIsPaletteOpen(false);
  }, [closeFileMentionPalette, showFileMentionPalette]);

  const moveFileMentionSelection = useCallback(
    (delta: 1 | -1): void => {
      const focusableEntries =
        flattenAgentMentionPaletteEntries(mentionSearchState);
      if (focusableEntries.length === 0) {
        return;
      }
      const currentIndex = mentionHighlightedKey
        ? focusableEntries.findIndex(
            (entry) => entry.key === mentionHighlightedKey
          )
        : -1;
      const baseIndex = currentIndex >= 0 ? currentIndex : delta > 0 ? -1 : 0;
      const nextIndex =
        (baseIndex + delta + focusableEntries.length) % focusableEntries.length;
      setShouldCenterMentionHighlight(true);
      autoMentionHighlightedKeyRef.current = null;
      setMentionHighlightedKey(focusableEntries[nextIndex]?.key ?? null);
    },
    [mentionHighlightedKey, mentionSearchState]
  );

  const handleMentionHighlightChange = useCallback((key: string): void => {
    autoMentionHighlightedKeyRef.current = null;
    setMentionHighlightedKey(key);
  }, []);

  const cycleFileMentionFilter = useCallback(
    (delta: 1 | -1 = 1): void => {
      const filters = (
        mentionSearchState.mode === "browse"
          ? mentionSearchState.categories.map((category) => category.id)
          : [...AGENT_MENTION_FILTER_TAB_ORDER]
      ) as AgentMentionFilterId[];
      if (filters.length === 0) {
        return;
      }
      const currentFilterIndex = filters.findIndex(
        (filter) => filter === mentionSearchState.filter
      );
      const baseIndex =
        currentFilterIndex >= 0 ? currentFilterIndex : delta > 0 ? -1 : 0;
      const nextIndex = (baseIndex + delta + filters.length) % filters.length;
      const nextFilter = filters[nextIndex];
      if (!nextFilter) {
        return;
      }
      mentionControllerRef.current?.setFilter(nextFilter);
      setShouldResetMentionHighlightToFilter(true);
      setShouldCenterMentionHighlight(false);
    },
    [mentionSearchState]
  );

  const handleFileMentionKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!showFileMentionPalette) {
        return false;
      }
      const focusableEntries =
        flattenAgentMentionPaletteEntries(mentionSearchState);
      return makeAtPanelKeyDown({
        close: closeFileMentionPalette,
        commitSelection: () => {
          const activeEntry = focusableEntries.find(
            (entry) => entry.key === mentionHighlightedKey
          );
          if (!activeEntry) {
            const highlightedCategoryId = mentionHighlightedKey?.startsWith(
              "category:"
            )
              ? mentionHighlightedKey.slice("category:".length)
              : null;
            if (
              highlightedCategoryId &&
              mentionSearchState.categories.some(
                (category) => category.id === highlightedCategoryId
              )
            ) {
              mentionControllerRef.current?.setFilter(
                highlightedCategoryId as AgentMentionFilterId
              );
            }
            return;
          }
          if (activeEntry.type === "category" && activeEntry.categoryId) {
            mentionControllerRef.current?.setFilter(activeEntry.categoryId);
          } else if (activeEntry.type === "expand" && activeEntry.groupId) {
            mentionControllerRef.current?.expandGroup(activeEntry.groupId);
          } else if (activeEntry.type === "item" && activeEntry.item) {
            selectFileMention(activeEntry.item);
          }
        },
        cycleFilter: cycleFileMentionFilter,
        moveSelection: moveFileMentionSelection
      })(event);
    },
    [
      closeFileMentionPalette,
      cycleFileMentionFilter,
      mentionHighlightedKey,
      mentionSearchState,
      moveFileMentionSelection,
      selectFileMention,
      showFileMentionPalette
    ]
  );

  // Shift+Tab cycles permission modes plus plan mode (CLI muscle memory),
  // sharing the option list and selection mapping with the dropdown.
  const handleModeCycleKeyDown = useCallback(
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
        isSendingTurn ||
        isSubmittingPrompt ||
        showStopButton ||
        composerSettings.isSettingsLoading
      ) {
        return false;
      }
      const planModeActive = Boolean(
        composerSettings.supportsPlanMode &&
        (composerSettings.effectivePlanMode ??
          composerSettings.draftSettings.planMode)
      );
      const options = composerModeOptions({
        availablePermissionModes: composerSettings.supportsPermissionMode
          ? (composerSettings.availablePermissionModes ?? [])
          : [],
        supportsPlanMode: composerSettings.supportsPlanMode,
        planModeLabel: labels.planModeLabel
      });
      const next = nextComposerModeValue(
        options,
        composerModeSelectedValue({
          planModeActive,
          selectedPermissionModeValue:
            composerSettings.selectedPermissionModeValue ??
            composerSettings.draftSettings.permissionModeId
        })
      );
      if (next === null) {
        return false;
      }
      event.preventDefault();
      onSettingsChange(composerModeSelectionPatch(next, planModeActive));
      return true;
    },
    [
      composerSettings.availablePermissionModes,
      composerSettings.draftSettings.permissionModeId,
      composerSettings.draftSettings.planMode,
      composerSettings.effectivePlanMode,
      composerSettings.isSettingsLoading,
      composerSettings.selectedPermissionModeValue,
      composerSettings.supportsPermissionMode,
      composerSettings.supportsPlanMode,
      labels.planModeLabel,
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
      handleModeCycleKeyDown(event)
  );

  useEffect(() => {
    if (!showPalette) {
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
  }, [handlePaletteKeyDown, showPalette]);

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

  const handleLinkClick = useCallback(
    (href: string): void => {
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
    if (!showPalette) {
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
  }, [closeOpenPalette, showPalette]);

  const handleDraftChange = useStableEventCallback(
    (nextDraft: string): void => {
      draftPromptRef.current = nextDraft;
      setPaletteDraftPrompt(nextDraft);
      setIsPaletteOpen(true);
      setSubmittedImagePreview([]);
      submittedImagePreviewObservedBusyRef.current = false;
      onDraftContentChange({ ...draftContent, prompt: nextDraft });
    }
  );

  const addDraftImages = useCallback(
    (images: AgentRichTextPastedImage[]): void => {
      if (images.length === 0) {
        return;
      }
      if (!promptImagesSupported) {
        onPromptImagesUnsupported?.();
        return;
      }
      setSubmittedImagePreview([]);
      submittedImagePreviewObservedBusyRef.current = false;
      const remainingSlots = Math.max(
        0,
        MAX_AGENT_COMPOSER_DRAFT_IMAGES - draftImages.length
      );
      if (remainingSlots === 0) {
        return;
      }
      const nextImages = images.slice(0, remainingSlots).map((image) => ({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        name: image.name,
        mimeType: image.mimeType,
        data: image.data,
        previewUrl: `data:${image.mimeType};base64,${image.data}`
      }));
      onDraftContentChange({
        prompt: draftPromptRef.current,
        images: [...draftImages, ...nextImages]
      });
    },
    [
      draftImages,
      onDraftContentChange,
      onPromptImagesUnsupported,
      promptImagesSupported
    ]
  );

  const handlePastedImages = useCallback(
    (images: AgentRichTextPastedImage[]): void => {
      addDraftImages(images);
    },
    [addDraftImages]
  );

  const removeDraftImage = useCallback(
    (id: string): void => {
      onDraftContentChange({
        prompt: draftPromptRef.current,
        images: draftImages.filter((image) => image.id !== id)
      });
    },
    [draftImages, onDraftContentChange]
  );

  const insertWorkspaceReferences = useCallback(
    (items: readonly WorkspaceFileReference[]) => {
      if (items.length === 0) {
        return;
      }
      editorHandleRef.current?.insertWorkspaceReferences(items);
    },
    []
  );

  const handleWorkspaceReferencePicker = useCallback(async () => {
    if (!onRequestWorkspaceReferences) {
      return;
    }
    insertWorkspaceReferences(await onRequestWorkspaceReferences());
  }, [insertWorkspaceReferences, onRequestWorkspaceReferences]);

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

  const syncSlashPaletteFrame = useCallback((): void => {
    const anchor = inputShellRef.current;
    if (!anchor || typeof window === "undefined") {
      setSlashPaletteFrame(null);
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
      availableAbove >= SLASH_PALETTE_HEIGHT_PX
        ? SLASH_PALETTE_HEIGHT_PX
        : Math.max(
            MENTION_PALETTE_MIN_HEIGHT_PX,
            Math.min(SLASH_PALETTE_HEIGHT_PX, availableAbove)
          );

    setSlashPaletteFrame({
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

  useLayoutEffect(() => {
    if (!showSlashPalette) {
      setSlashPaletteFrame(null);
      return;
    }

    syncSlashPaletteFrame();
    const anchor = inputShellRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(syncSlashPaletteFrame);
    if (anchor) {
      resizeObserver?.observe(anchor);
    }
    window.addEventListener("resize", syncSlashPaletteFrame);
    window.addEventListener("scroll", syncSlashPaletteFrame, {
      capture: true,
      passive: true
    });
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncSlashPaletteFrame);
      window.removeEventListener("scroll", syncSlashPaletteFrame, true);
    };
  }, [showSlashPalette, syncSlashPaletteFrame]);

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
  const slashPaletteStyle = useMemo<CSSProperties>(
    () => ({
      position: "fixed",
      left: `${slashPaletteFrame?.left ?? 0}px`,
      top: `${slashPaletteFrame?.top ?? 0}px`,
      width: `${slashPaletteFrame?.width ?? 0}px`,
      maxWidth: `${slashPaletteFrame?.width ?? 0}px`,
      minHeight: `${MENTION_PALETTE_MIN_HEIGHT_PX}px`,
      height: `${slashPaletteFrame?.height ?? SLASH_PALETTE_HEIGHT_PX}px`,
      maxHeight: `${SLASH_PALETTE_HEIGHT_PX}px`,
      overflow: "hidden",
      zIndex: composerPaletteZIndex
    }),
    [slashPaletteFrame]
  );
  const composerClassName =
    layoutMode === "hero" ? styles.composerHero : styles.composer;
  const inputShellClassName = cn(
    styles.composerInputShell,
    layoutMode === "hero" && styles.composerInputShellHero
  );
  const inputDisabled =
    isSelectedProjectMissing || (disabled && !canQueueWhileBusy);
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

    const hasPromptImageFiles = (event: DragEvent): boolean => {
      if (
        event.defaultPrevented ||
        inputDisabled ||
        !containsEventTarget(event) ||
        hasWorkspaceFileDropData(event.dataTransfer)
      ) {
        return false;
      }
      return imageFilesFromDataTransfer(event.dataTransfer).length > 0;
    };

    const handleDragOver: EventListener = (event): void => {
      if (!isDragEvent(event)) {
        return;
      }
      if (!hasPromptImageFiles(event)) {
        return;
      }
      event.preventDefault();
      if (!promptImagesSupported) {
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
      if (!hasPromptImageFiles(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!promptImagesSupported) {
        onPromptImagesUnsupported?.();
        return;
      }
      const imageFiles = imageFilesFromDataTransfer(event.dataTransfer);
      void readAgentRichTextPromptImages(imageFiles).then((images) => {
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
    inputDisabled,
    onPromptImagesUnsupported,
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
  const showEdgeGlow = layoutMode === "hero" && !inputDisabled;
  const showPromptTips = layoutMode === "hero" && promptTips.length > 0;
  const activePromptTip = showPromptTips ? (promptTips[0] ?? null) : null;
  const showHeroProjectSelector = layoutMode === "hero" && showProjectSelector;
  const showProjectRow =
    layoutMode === "hero" && (showHeroProjectSelector || activePromptTip);
  const showProjectMissingProbe =
    !showProjectRow &&
    showProjectSelector &&
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
  }, [activePromptTipId, activePromptTipText, isPromptTipOverflowing]);
  const inputShellStyle = useMemo<CSSProperties | undefined>(
    () => (showPalette ? { zIndex: composerPaletteZIndex } : undefined),
    [showPalette]
  );
  const hasDraftContent = agentComposerDraftHasContent(draftContent);
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
  const showingSubmittedImagePreview =
    draftImages.length === 0 && submittedImagePreview.length > 0;
  const visibleDraftImages =
    draftImages.length > 0 ? draftImages : submittedImagePreview;

  useEffect(() => {
    if (submittedImagePreview.length === 0) {
      submittedImagePreviewObservedBusyRef.current = false;
      return;
    }
    const busy = isSubmittingPrompt || isSendingTurn;
    if (busy) {
      submittedImagePreviewObservedBusyRef.current = true;
      return;
    }
    if (submittedImagePreviewObservedBusyRef.current) {
      submittedImagePreviewObservedBusyRef.current = false;
      setSubmittedImagePreview([]);
    }
  }, [isSendingTurn, isSubmittingPrompt, submittedImagePreview.length]);

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
    <form ref={composerRef} className={composerClassName} onSubmit={submit}>
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
        {isSlashStatusPanelOpen ? (
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
              slashStatusLimitsUnavailable: labels.slashStatusLimitsUnavailable
            }}
            onClose={closeSlashStatusPanel}
          />
        ) : null}
        {isReviewPickerOpen ? (
          <AgentReviewPickerPanel
            labels={labels.reviewPicker}
            onRequestGitBranches={reviewBranchLoader}
            onSubmitReview={submitReviewCommand}
            onClose={closeReviewPicker}
          />
        ) : null}
        <div
          ref={inputShellRef}
          className={cn(inputShellClassName, "relative")}
          data-input-disabled={inputDisabled ? "true" : undefined}
          title={
            inputDisabled && disabledReasonText ? disabledReasonText : undefined
          }
          style={inputShellStyle}
        >
          <Popover
            open={showPalette}
            onOpenChange={setIsPaletteOpen}
            modal={false}
          >
            <PopoverAnchor asChild>
              <div className="min-w-0 self-start">
                {visibleDraftImages.length > 0 ? (
                  <div
                    className="mb-2 grid max-w-[320px] grid-cols-[repeat(auto-fill,minmax(56px,1fr))] gap-2"
                    data-testid="agent-gui-composer-image-drafts"
                    data-submitted-preview={
                      showingSubmittedImagePreview ? "true" : undefined
                    }
                  >
                    {visibleDraftImages.map((image) => (
                      <div
                        key={image.id}
                        className="group relative aspect-square min-w-0 overflow-hidden rounded-[6px] border border-[var(--line-1)] bg-[var(--background-fronted)]"
                      >
                        <img
                          src={image.previewUrl}
                          alt={image.name}
                          className="size-full object-cover"
                          draggable={false}
                        />
                        {showingSubmittedImagePreview ? null : (
                          <button
                            type="button"
                            className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--text-primary)_16%,transparent)] bg-[color-mix(in_srgb,var(--background-fronted)_88%,transparent)] text-[var(--text-primary)] opacity-90 shadow-sm transition hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text-primary)_34%,transparent)]"
                            aria-label={labels.removeMention}
                            title={labels.removeMention}
                            onClick={() => removeDraftImage(image.id)}
                          >
                            <X size={12} strokeWidth={2.4} aria-hidden />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
                <AgentRichTextEditor
                  ref={editorHandleRef}
                  value={paletteDraftPrompt}
                  placeholder={effectivePlaceholder}
                  disabled={inputDisabled}
                  className={styles.composerTextarea}
                  onChange={handleDraftChange}
                  onSubmit={submitCurrentPrompt}
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
                />
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
                      onCycleFilter={cycleFileMentionFilter}
                      onMoveSelection={moveFileMentionSelection}
                    />
                  </div>,
                  mentionPaletteFrame.portalTarget
                )
              : null}
            {showSlashPalette && slashPaletteFrame
              ? createPortal(
                  <div
                    data-testid="agent-gui-slash-palette-surface"
                    ref={paletteContentRef}
                    className={cn(
                      composerStyles.dropdownSurface,
                      composerStyles.slashDropdown,
                      "max-h-[320px] border-0 p-0"
                    )}
                    style={slashPaletteStyle}
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
                      capabilitiesGroupLabel={
                        labels.slashPaletteCapabilitiesGroup
                      }
                      skillsGroupLabel={labels.slashPaletteSkillsGroup}
                      onHighlightChange={setHighlightedIndex}
                      onSelect={selectCommand}
                      onSelectCapability={selectCapability}
                      onSelectSkill={selectSkill}
                    />
                  </div>,
                  slashPaletteFrame.portalTarget
                )
              : null}
          </Popover>
          <div className={styles.composerFooter}>
            <div className={composerStyles.footerGroup}>
              <Select
                open={false}
                value={workspaceReferenceSelectValue}
                disabled={
                  isSelectedProjectMissing ||
                  isSendingTurn ||
                  isSubmittingPrompt ||
                  !onRequestWorkspaceReferences ||
                  (disabled && !canQueueWhileBusy)
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
                <SelectTrigger
                  size="sm"
                  aria-label={labels.referenceWorkspaceFiles}
                  title={labels.referenceWorkspaceFiles}
                  className={cn(
                    styles.composerMenuTrigger,
                    styles.composerReferenceTrigger,
                    "w-auto justify-center px-1 text-[var(--agent-gui-text-secondary)] [&>svg:last-child]:hidden [&_svg]:shrink-0"
                  )}
                >
                  <AddIcon
                    aria-hidden
                    className="size-3.5"
                    data-agent-reference-add-icon="true"
                  />
                </SelectTrigger>
              </Select>
            </div>
            <div className={composerStyles.footerGroupRight}>
              {composerSettings.supportsPermissionMode ||
              composerSettings.supportsPlanMode ? (
                <AgentPermissionModeDropdown
                  composerSettings={composerSettings}
                  disabled={settingsControlsDisabled}
                  labels={{
                    permissionLabel: labels.permissionLabel,
                    planModeLabel: labels.planModeLabel
                  }}
                  onSettingsChange={(patch) => onSettingsChange(patch)}
                />
              ) : null}
              {composerSettings.supportsModel ||
              composerSettings.supportsReasoningEffort ? (
                <AgentModelReasoningDropdown
                  composerSettings={composerSettings}
                  disabled={settingsControlsDisabled}
                  labels={{
                    modelLabel: labels.modelLabel,
                    modelSelectionLabel: labels.modelSelectionLabel,
                    planModeLabel: labels.planModeLabel,
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
                    modelDescriptions: labels.modelDescriptions,
                    defaultModel: labels.defaultModel,
                    inheritedUnavailable: labels.inheritedUnavailable,
                    loadingSettings: labels.loadingConversation
                  }}
                  onSettingsChange={onSettingsChange}
                />
              ) : null}
              {shouldShowStopButton ? (
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
              )}
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
                labels={{
                  projectLocked: labels.projectLocked,
                  projectMissingDescription: labels.projectMissingDescription
                }}
                onProjectMissingChange={setIsSelectedProjectMissing}
                onProjectPathChange={onProjectPathChange}
              />
            ) : null}
            {activePromptTip ? (
              <div
                className={styles.composerPromptTips}
                data-testid="agent-gui-prompt-tips"
              >
                {isPromptTipOverflowing && promptTipNode ? (
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
