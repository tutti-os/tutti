import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { cn, toastVariants } from "@tutti-os/ui-system";
import { ScrollArea } from "@tutti-os/ui-system/components";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../../shared/AgentMessageMarkdown";
import { openAgentEnvPanel } from "../../../shared/agentEnv/agentEnvPanelStore";
import { AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT } from "../../../workbench/contribution";
import { resolveAgentGuiWorkbenchProviderLabel } from "../../../workbench/providerCatalog";
import type {
  AgentComposerGitBranchLoader,
  AgentComposerProps,
  AgentComposerSlashStatusLimit,
  WorkspaceReferencePickResult
} from "../AgentComposer";
import type { AgentContextMentionProvider } from "../agentContextMentionProvider";
import type { AgentContextMentionItem } from "../agentRichText/agentFileMentionExtension";
import type {
  AgentHomeSuggestionAction,
  AgentGUINodeViewModel
} from "../model/agentGuiNodeTypes";
import { projectAgentGUIManagedHomeTargets } from "../model/agentGuiProviderRailOrder";
import type {
  AgentGUINodeViewProps,
  AgentGUIProviderUnavailableStateRenderer,
  AgentGUIViewLabels
} from "../AgentGUINodeView";
import {
  buildAgentConversationHandoffPrompt,
  handoffProjectPathForConversation
} from "./agentGUIDetailModelHelpers";
import { AgentGUIBottomDockPane } from "./AgentGUIBottomDockPane";
import {
  AgentGUIEmptyHomePane,
  EMPTY_HOME_SUGGESTIONS,
  resolveAgentGUIHeroIconUrl
} from "./AgentGUIEmptyState";
import { AgentGUIDetailHeader } from "./AgentGUIDetailHeader";
import { AgentGUIConversationTimelinePane } from "./AgentGUIConversationTimelinePane";
import {
  stringValue,
  useOptionalStableEventCallback,
  useStableEventCallback
} from "./agentGUIViewUtils";
import styles from "../AgentGUINode.styles";
import { useAgentGUIDetailScroll } from "./useAgentGUIDetailScroll";
import { useAgentGUIDetailModel } from "./useAgentGUIDetailModel";
import { useAgentGUIProviderRailPreferences } from "./useAgentGUIProviderRailPreferences";

const AGENT_GUI_TIMELINE_SCROLL_AREA_CONTENT_STYLE: CSSProperties = {
  width: "100%",
  minWidth: "100%",
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr)",
  gap: "24px"
};
const EMPTY_WORKSPACE_APP_ICONS: readonly AgentMessageMarkdownWorkspaceAppIcon[] =
  [];

export interface AgentGUIDetailPaneProps {
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
  slashStatusLimitsUnavailable: boolean;
  onSlashStatusOpen?: AgentComposerProps["onSlashStatusOpen"];
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
}

export function mergeWorkspaceAppIconsFromCommands(input: {
  commands: AgentGUINodeViewModel["composer"]["availableCommands"];
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

function workspaceAppIconKey(appId: string, workspaceId: string): string {
  return `${workspaceId}\u0000${appId}`;
}

export const AgentGUIDetailPane = memo(function AgentGUIDetailPane({
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
  slashStatusLimitsUnavailable,
  onSlashStatusOpen,
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
  renderProviderUnavailableState
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
  const [
    bottomDockDismissedPromptRequestId,
    setBottomDockDismissedPromptRequestId
  ] = useState<string | null>(null);
  const {
    activePromptRequestId,
    bottomDockLiftedPrompt,
    bottomDockReplacementPrompt,
    canQueueWhileBusy,
    chromeLabels,
    composerActivePrompt,
    composerDisabled,
    composerDisabledReason,
    composerLabels,
    conversation,
    conversationFlowEmpty,
    conversationFlowLabels,
    emptyProviderReadinessGate,
    goalBannerLabels,
    hasActiveConversation,
    inlineNoticeChrome,
    interactivePromptLabels,
    isComposerSending,
    selectedAgentTargetComingSoon,
    sessionChrome,
    showProviderSetupNotice,
    showStopButton,
    showTimelineSkeleton,
    showUnavailableChatEmpty,
    slashStatus,
    submitDisabled
  } = useAgentGUIDetailModel({
    bottomDockDismissedPromptRequestId,
    isAgentProviderReady,
    labels,
    slashStatusLimits,
    slashStatusLimitsLoading,
    slashStatusLimitsUnavailable,
    viewModel
  });
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
      updateDraftContent({ ...viewModel.composer.draftContent, prompt });
    },
    [updateDraftContent, viewModel.composer.draftContent]
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
    const activeConversationId = viewModel.rail.activeConversationId;
    if (!activeConversationId) {
      return;
    }
    submittedPromptScrollConversationRef.current = activeConversationId;
    pendingPrependScrollAnchorRef.current = null;
  }, [viewModel.rail.activeConversationId]);
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
    viewModel.detail.backgroundAgentCount > 0
      ? labels.waitingForBackgroundAgent(viewModel.detail.backgroundAgentCount)
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
  const { preferences: providerRailPreferences } =
    useAgentGUIProviderRailPreferences();
  const homeTargetProjection = projectAgentGUIManagedHomeTargets({
    agentTargets: viewModel.rail.agentTargets,
    preferences: providerRailPreferences,
    selectedAgentTarget: viewModel.rail.selectedAgentTarget
  });
  const homeComposerProviderTargets = homeTargetProjection.agentTargets;
  const selectedHomeComposerTarget = homeTargetProjection.selectedAgentTarget;
  const composerProviderTargets =
    viewModel.rail.activeConversationId === null
      ? homeComposerProviderTargets
      : viewModel.rail.agentTargets;
  const composerHandoffProviderTargets = viewModel.composer.handoffAgentTargets;
  const composerProvider =
    viewModel.rail.activeConversationId === null
      ? (selectedHomeComposerTarget?.provider ?? viewModel.shell.data.provider)
      : viewModel.shell.data.provider;
  const composerSelectedProviderTarget =
    viewModel.rail.activeConversationId === null
      ? selectedHomeComposerTarget
      : (viewModel.rail.agentTargets.find((target) => {
          if (target.provider !== viewModel.shell.data.provider) {
            return false;
          }
          const agentTargetId = viewModel.shell.data.agentTargetId;
          return (
            !agentTargetId ||
            target.targetId === agentTargetId ||
            target.agentTargetId === agentTargetId
          );
        }) ?? viewModel.rail.selectedAgentTarget);
  const bottomDockComposerProps = useMemo<AgentComposerProps>(
    () => ({
      workspaceId: viewModel.shell.workspaceId,
      workspacePath: viewModel.shell.workspacePath,
      currentUserId: viewModel.shell.currentUserId,
      provider: composerProvider,
      slashStatus,
      onSlashStatusOpen,
      usage: viewModel.detail.usage,
      draftContent: viewModel.composer.draftContent,
      availableCommands: viewModel.composer.availableCommands,
      hasCompactableContext: viewModel.detail.hasSentUserMessage,
      compactSupported: viewModel.composer.compactSupported,
      availableSkills: viewModel.composer.availableSkills,
      selectedAgentTarget: composerSelectedProviderTarget,
      agentTargets: composerProviderTargets,
      handoffAgentTargets: composerHandoffProviderTargets,
      providerSelectReadonly:
        !canSwitchComposerProvider ||
        viewModel.rail.activeConversationId !== null,
      onProviderSelect:
        canSwitchComposerProvider &&
        viewModel.rail.activeConversationId === null
          ? selectHomeComposerAgentTargetAndFocus
          : undefined,
      disabled: composerDisabled,
      disabledReason: composerDisabledReason,
      submitDisabled,
      composerSettings: viewModel.composer.composerSettings,
      queuedPrompts: viewModel.composer.queuedPrompts,
      drainingQueuedPromptId: viewModel.composer.drainingQueuedPromptId,
      workspaceAppIcons,
      canQueueWhileBusy,
      placeholder: viewModel.detail.hasSentUserMessage
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
      promptImagesSupported: viewModel.composer.promptImagesSupported,
      providerSelectLabel: labels.providerSwitchLabel,
      handoffLabel: labels.handoffConversation,
      handoffMenuLabel: labels.handoffConversationMenu,
      isInterrupting: viewModel.composer.isInterrupting,
      isSendingTurn: isComposerSending,
      isSubmittingPrompt: viewModel.interaction.isRespondingApproval,
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
        onHandoffConversation && viewModel.rail.activeConversationId !== null
          ? (target) =>
              onHandoffConversation({
                agentTargetId: target.agentTargetId ?? target.targetId,
                draftPrompt: buildAgentConversationHandoffPrompt({
                  activeConversation: viewModel.rail.activeConversation,
                  currentUserId: viewModel.shell.currentUserId,
                  labels,
                  selectedAgentTarget: composerSelectedProviderTarget,
                  uiLanguage,
                  workspaceId: viewModel.shell.workspaceId
                }),
                provider: target.provider,
                userProjectPath: handoffProjectPathForConversation(
                  viewModel.rail.activeConversation
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
      onSlashStatusOpen,
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
      viewModel.rail.activeConversationId,
      viewModel.composer.availableCommands,
      viewModel.composer.availableSkills,
      viewModel.rail.activeConversationId,
      viewModel.composer.compactSupported,
      viewModel.composer.composerSettings,
      viewModel.shell.currentUserId,
      viewModel.rail.activeConversationId,
      viewModel.rail.activeConversation,
      composerProvider,
      viewModel.composer.draftContent,
      viewModel.composer.draftPrompt,
      viewModel.composer.drainingQueuedPromptId,
      viewModel.detail.hasSentUserMessage,
      viewModel.composer.isInterrupting,
      viewModel.interaction.isRespondingApproval,
      viewModel.composer.promptImagesSupported,
      viewModel.composer.queuedPrompts,
      viewModel.detail.usage,
      viewModel.shell.workspaceId,
      viewModel.shell.workspacePath,
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
    composerSelectedProviderTarget?.provider ?? viewModel.shell.data.provider;
  const disabledProviderTarget =
    composerSelectedProviderTarget?.disabled === true ||
    selectedAgentTargetComingSoon
      ? composerSelectedProviderTarget
      : null;
  const shouldRenderProviderUnavailableState =
    !hasActiveConversation &&
    disabledProviderTarget !== null &&
    renderProviderUnavailableState !== undefined;
  const bottomDockStoreRevision = [
    bottomDockLiftedPrompt?.requestId ?? "",
    bottomDockReplacementPrompt?.requestId ?? "",
    inlineNoticeChrome?.recovery?.message ?? "",
    sessionChrome.auth?.message ?? "",
    sessionChrome.recovery?.kind ?? "",
    sessionChrome.recovery?.message ?? "",
    backgroundAgentStatusText ?? "",
    viewModel.composer.queuedPrompts.map((prompt) => prompt.id).join(","),
    viewModel.composer.drainingQueuedPromptId ?? "",
    viewModel.interaction.isRespondingApproval ? "1" : "0"
  ].join("|");

  useEffect(() => {
    setBottomDockDismissedPromptRequestId(null);
  }, [activePromptRequestId]);

  const {
    isTimelineScrolledToBottom,
    isTimelineScrolledToTop,
    scrollTimelineToBottom
  } = useAgentGUIDetailScroll({
    actions,
    bottomDockRef,
    bottomDockStoreRevision,
    conversation,
    pendingPrependScrollAnchorRef,
    pendingRestoreScrollRef,
    showTimelineSkeleton,
    submittedPromptScrollConversationRef,
    timelineRef,
    timelineScrollAnchorRef,
    timelineScrollPositionsRef,
    viewModel
  });

  return (
    <main className={styles.detail}>
      <AgentGUIDetailHeader
        activeConversation={viewModel.rail.activeConversation}
        hidden={hideDetailHeader}
        labels={labels}
        uiLanguage={uiLanguage}
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
                provider: viewModel.shell.data.provider,
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
          ) : (
            <AgentGUIEmptyHomePane
              provider={emptyHeroProvider}
              providerReadinessGate={emptyProviderReadinessGate}
              showAllProviders={
                viewModel.rail.conversationFilter.kind === "all"
              }
              agentTargets={composerProviderTargets}
              selectedAgentTarget={composerSelectedProviderTarget}
              onProviderSelect={
                canSwitchComposerProvider &&
                viewModel.rail.activeConversationId === null
                  ? selectHomeComposerAgentTargetAndFocus
                  : undefined
              }
              inlineNoticeChrome={inlineNoticeChrome}
              isRespondingApproval={viewModel.interaction.isRespondingApproval}
              onSubmitApprovalOption={submitApprovalOption}
              onRetryActivation={retryActivation}
              onAuthLogin={authLogin}
              onContinueInNewConversation={continueInNewConversation}
              chromeLabels={chromeLabels}
              composerProps={emptyHeroComposerProps}
              labels={labels}
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
            isLoadingOlderMessages={viewModel.detail.isLoadingOlderMessages}
            loadingLabel={labels.loadingConversation}
            empty={conversationFlowEmpty}
            onLinkAction={stableLinkAction}
            onAuthLogin={authLogin}
            availableSkills={viewModel.composer.availableSkills}
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
          composerProps={bottomDockComposerProps}
          inlineNoticeChrome={inlineNoticeChrome}
          isRespondingApproval={viewModel.interaction.isRespondingApproval}
          sessionChrome={sessionChrome}
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
          goalPauseSupported={viewModel.composer.goalPauseSupported}
        />
      ) : null}
    </main>
  );
});
