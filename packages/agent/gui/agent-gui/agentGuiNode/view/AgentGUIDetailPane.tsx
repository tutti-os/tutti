import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { Button, ScrollArea } from "@tutti-os/ui-system/components";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../../shared/AgentMessageMarkdown";
import { AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT } from "../../../workbench/contribution";
import { resolveAgentGuiWorkbenchProviderLabel } from "../../../workbench/providerCatalog";
import type {
  AgentComposerGitBranchLoader,
  AgentComposerProps,
  AgentComposerSlashStatusLimit,
  WorkspaceReferencePickResult
} from "../AgentComposer";
import type { AgentContextMentionItem } from "../agentRichText/agentFileMentionExtension";
import type {
  AgentHomeSuggestionAction,
  AgentGUINodeViewModel
} from "../model/agentGuiNodeTypes";
import { updateAgentComposerDraft } from "../model/agentComposerDraft";
import { resolveAgentComposerDraftScopeKey } from "../model/agentComposerDraftScope";
import type { AgentGUIManagedHomeTargetProjection } from "../model/agentGuiProviderRailOrder";
import type {
  AgentGUINodeViewProps,
  AgentGUIProviderUnavailableStateRenderer,
  AgentGUIViewLabels
} from "../AgentGUINodeView";
import {
  buildAgentConversationHandoffPrompt,
  commandAppSource,
  handoffProjectPathForConversation,
  workspaceAppIconKey
} from "./agentGUIDetailModelHelpers";
import { AgentGUIBottomDockPane } from "./AgentGUIBottomDockPane";
import {
  AgentGUIEmptyHomePane,
  EMPTY_HOME_SUGGESTIONS,
  resolveAgentGUIHeroIconUrl
} from "./AgentGUIEmptyState";
import { AgentGUIContentToast } from "./AgentGUIContentToast";
import { AgentGUIConversationTimelinePane } from "./AgentGUIConversationTimelinePane";
import {
  stringValue,
  useOptionalStableEventCallback,
  useStableEventCallback
} from "./agentGUIViewUtils";
import styles from "../AgentGUINode.styles";
import { useAgentGUIDetailScroll } from "./useAgentGUIDetailScroll";
import { useAgentGUIDetailModel } from "./useAgentGUIDetailModel";
import type { AgentGUIComposerEngagement } from "../engagement/agentGUIEngagement.types";
import {
  TuttiModePlanPanel,
  useTuttiModePlanPanels
} from "../../../workspaceWorkflow";

const AGENT_GUI_TIMELINE_SCROLL_AREA_CONTENT_STYLE: CSSProperties = {
  width: "100%",
  minWidth: "100%",
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr)",
  gap: "24px"
};
export const EMPTY_WORKSPACE_APP_ICONS: readonly AgentMessageMarkdownWorkspaceAppIcon[] =
  [];
export interface AgentGUIDetailPaneProps {
  viewModel: AgentGUINodeViewModel;
  homeTargetProjection: AgentGUIManagedHomeTargetProjection;
  referenceProvenanceFilter?: AgentComposerProps["referenceProvenanceFilter"];
  composerEngagement?: AgentGUIComposerEngagement;
  actions: AgentGUINodeViewProps["actions"];
  labels: AgentGUIViewLabels;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
  uiLanguage: UiLanguage;
  isActive: boolean;
  previewMode: boolean;
  workspaceReferencePickerOpen: boolean;
  composerFocusRequestSequence: number | null;
  slashStatusLimits: readonly AgentComposerSlashStatusLimit[];
  slashStatusLimitsLoading: boolean;
  slashStatusLimitsUnavailable: boolean;
  slashStatusOverride?: AgentComposerProps["slashStatus"];
  onSlashStatusOpen?: AgentComposerProps["onSlashStatusOpen"];
  onSlashStatusClose?: AgentComposerProps["onSlashStatusClose"];
  onSlashStatusRefresh?: AgentComposerProps["onSlashStatusRefresh"];
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onHandoffConversation?: AgentGUINodeViewProps["onHandoffConversation"];
  capabilityMenuState?: AgentComposerProps["capabilityMenuState"];
  capabilityControlsReadOnly?: AgentComposerProps["capabilityControlsReadOnly"];
  onCapabilitySettingsRequest?: AgentComposerProps["onCapabilitySettingsRequest"];
  onAgentProviderLogin?: (provider?: string | null) => void;
  onRequestWorkspaceReferences?:
    | ((
        entity?: AgentContextMentionItem | null
      ) => Promise<WorkspaceReferencePickResult>)
    | null;
  resolveExternalPromptEntries?: AgentComposerProps["resolveExternalPromptEntries"];
  prepareExternalPromptFiles?: AgentComposerProps["prepareExternalPromptFiles"];
  promptAssetLimit?: number | null;
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  onRequestGitBranches?: AgentComposerGitBranchLoader | null;
  onRequestComposerFocus: () => void;
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

export const AgentGUIDetailPane = memo(function AgentGUIDetailPane({
  viewModel,
  homeTargetProjection,
  referenceProvenanceFilter = null,
  composerEngagement,
  actions,
  labels,
  workspaceUserProjectI18n,
  uiLanguage,
  isActive,
  previewMode,
  workspaceReferencePickerOpen,
  composerFocusRequestSequence,
  slashStatusLimits,
  slashStatusLimitsLoading,
  slashStatusLimitsUnavailable,
  slashStatusOverride,
  onSlashStatusOpen,
  onSlashStatusClose,
  onSlashStatusRefresh,
  onLinkAction,
  onHandoffConversation,
  capabilityMenuState,
  capabilityControlsReadOnly = false,
  onCapabilitySettingsRequest,
  onAgentProviderLogin,
  onRequestWorkspaceReferences,
  resolveExternalPromptEntries = null,
  prepareExternalPromptFiles = null,
  promptAssetLimit = null,
  selectProjectDirectory,
  onRequestGitBranches,
  onRequestComposerFocus,
  workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS,
  renderProviderUnavailableState
}: AgentGUIDetailPaneProps): React.JSX.Element {
  "use memo";
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineContentRef = useRef<HTMLDivElement | null>(null);
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
    showStopButton,
    showTimelineSkeleton,
    showUnavailableChatEmpty,
    slashStatus: derivedSlashStatus,
    submitDisabled,
    timelineConversationId,
    timelineInteractionLocked
  } = useAgentGUIDetailModel({
    bottomDockDismissedPromptRequestId,
    labels,
    slashStatusLimits,
    slashStatusLimitsLoading,
    slashStatusLimitsUnavailable,
    viewModel
  });
  const slashStatus = slashStatusOverride ?? derivedSlashStatus;
  const tuttiModePlanPanels = useTuttiModePlanPanels({
    enabled: !previewMode,
    workspaceId: viewModel.shell.workspaceId,
    sourceSessionId: viewModel.rail.activeConversationId,
    decidedBy: viewModel.shell.currentUserId?.trim() || "local"
  });
  const handleInterruptCurrentTurn = useCallback(() => {
    actions.interruptCurrentTurn(labels.noRunningResponse);
  }, [actions.interruptCurrentTurn, labels.noRunningResponse]);
  const submitApprovalOption = useStableEventCallback(
    actions.submitApprovalOption
  );
  const retryActivation = useStableEventCallback(actions.retryActivation);
  const retryTuttiModeActivation = useStableEventCallback(
    actions.retryTuttiModeActivation
  );
  const retryInlineNotice =
    viewModel.composer.tuttiModeUpdateStatus === "failed"
      ? retryTuttiModeActivation
      : retryActivation;
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
  const setTuttiModeActive = useStableEventCallback(actions.setTuttiModeActive);
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
      // Don't request focus here: replacing the draft already focuses the
      // filled prompt at the end. A second focus request would race it.
      updateDraftContent(
        updateAgentComposerDraft(viewModel.composer.draftContent, { prompt })
      );
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
    (
      content: AgentPromptContentBlock[],
      displayPrompt?: string,
      options?: Parameters<AgentComposerProps["onSubmit"]>[2]
    ): void => {
      requestSubmittedPromptScrollToBottom();
      if (displayPrompt === undefined) {
        submitPrompt(content, undefined, options);
        return;
      }
      submitPrompt(content, displayPrompt, options);
    },
    [requestSubmittedPromptScrollToBottom, submitPrompt]
  );
  const submitGuidancePromptAndScrollToBottom = useCallback(
    (...args: Parameters<typeof submitGuidancePrompt>): void => {
      requestSubmittedPromptScrollToBottom();
      submitGuidancePrompt(...args);
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
  const isInteractionPending =
    viewModel.interaction.isRespondingApproval ||
    viewModel.interaction.isRuntimeBlocked;
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
  const stableHandoffConversation = useOptionalStableEventCallback(
    onHandoffConversation && viewModel.rail.activeConversationId !== null
      ? (target: (typeof composerHandoffProviderTargets)[number]) =>
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
      : undefined
  );
  const bottomDockComposerProps = useMemo<AgentComposerProps>(
    () => ({
      workspaceId: viewModel.shell.workspaceId,
      workspacePath: viewModel.shell.workspacePath,
      currentUserId: viewModel.shell.currentUserId,
      provider: composerProvider,
      slashStatus,
      onSlashStatusOpen,
      onSlashStatusClose,
      onSlashStatusRefresh,
      usage: viewModel.detail.usage,
      draftContent: viewModel.composer.draftContent,
      engagement: composerEngagement,
      draftScopeKey: resolveAgentComposerDraftScopeKey({
        agentSessionId: viewModel.rail.activeConversationId
      }),
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
      disabled: composerDisabled || timelineInteractionLocked,
      disabledReason: composerDisabledReason,
      submitDisabled: submitDisabled || timelineInteractionLocked,
      tuttiModeActive: viewModel.composer.isTuttiModeActive,
      tuttiModeUpdating: viewModel.composer.isTuttiModeUpdating,
      composerSettings: viewModel.composer.composerSettings,
      queueStatus: viewModel.composer.queueStatus,
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
      referenceProvenanceFilter,
      // Plan decisions replace the composer; approval / ask-user embed here.
      activePrompt: composerActivePrompt,
      activePromptKeyboardShortcutsEnabled: isActive,
      promptTips: labels.promptTips,
      composerFocusRequestSequence,
      isActive,
      promptImagesSupported: viewModel.composer.promptImagesSupported,
      providerSelectLabel: labels.providerSwitchLabel,
      handoffLabel: labels.handoffConversation,
      handoffMenuLabel: labels.handoffConversationMenu,
      isInterrupting:
        viewModel.composer.isInterrupting || viewModel.composer.isCancelPending,
      isSendingTurn: isComposerSending,
      isSubmittingPrompt: isInteractionPending,
      projectMissingProbeEnabled: !viewModel.composer.isCreatingConversation,
      uiLanguage,
      labels: composerLabels,
      workspaceUserProjectI18n,
      capabilityMenuState,
      capabilityControlsReadOnly,
      onDraftContentChange: updateDraftContent,
      onProjectPathChange: updateSelectedProjectPath,
      onSettingsChange: updateComposerSettings,
      onTuttiModeChange: setTuttiModeActive,
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
      onHandoffConversation: stableHandoffConversation,
      onRequestWorkspaceReferences: stableRequestWorkspaceReferences,
      resolveExternalPromptEntries,
      prepareExternalPromptFiles,
      promptAssetLimit,
      selectProjectDirectory: stableSelectProjectDirectory,
      onRequestGitBranches: stableRequestGitBranches
    }),
    [
      canQueueWhileBusy,
      capabilityMenuState,
      capabilityControlsReadOnly,
      canSwitchComposerProvider,
      composerDisabled,
      composerDisabledReason,
      composerFocusRequestSequence,
      composerEngagement,
      composerHandoffProviderTargets,
      composerLabels,
      conversation,
      composerProviderTargets,
      composerSelectedProviderTarget,
      timelineInteractionLocked,
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
      stableHandoffConversation,
      onSlashStatusOpen,
      previewMode,
      workspaceReferencePickerOpen,
      composerActivePrompt,
      editQueuedPrompt,
      onCapabilitySettingsRequest,
      removeQueuedPrompt,
      resolveExternalPromptEntries,
      prepareExternalPromptFiles,
      promptAssetLimit,
      sendQueuedPromptNext,
      showPromptImagesUnsupported,
      showStopButton,
      slashStatus,
      submitDisabled,
      setTuttiModeActive,
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
      viewModel.composer.compactSupported,
      viewModel.composer.composerSettings,
      viewModel.shell.currentUserId,
      viewModel.rail.activeConversation,
      composerProvider,
      viewModel.composer.draftContent,
      viewModel.composer.draftPrompt,
      viewModel.composer.drainingQueuedPromptId,
      viewModel.detail.hasSentUserMessage,
      viewModel.composer.isInterrupting,
      viewModel.composer.isCreatingConversation,
      viewModel.composer.isTuttiModeActive,
      viewModel.composer.isTuttiModeUpdating,
      viewModel.interaction.isRespondingApproval,
      viewModel.interaction.isRuntimeBlocked,
      viewModel.composer.promptImagesSupported,
      viewModel.composer.queueStatus,
      viewModel.composer.queuedPrompts,
      viewModel.detail.usage,
      viewModel.shell.workspaceId,
      viewModel.shell.workspacePath,
      referenceProvenanceFilter,
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
    viewModel.composer.queuedPrompts.map((prompt) => prompt.id).join(","),
    viewModel.composer.queueStatus,
    viewModel.composer.drainingQueuedPromptId ?? "",
    isInteractionPending ? "1" : "0"
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
    showTimelineSkeleton,
    submittedPromptScrollConversationRef,
    timelineConversationId,
    timelineContentRef,
    timelineRef,
    timelineScrollAnchorRef,
    viewModel
  });

  return (
    <main
      className={styles.detail}
      aria-busy={timelineInteractionLocked || undefined}
      inert={timelineInteractionLocked}
    >
      {viewModel.operations.goalClearNoticeSequence > 0 ? (
        <AgentGUIContentToast
          key={viewModel.operations.goalClearNoticeSequence}
          insetTopPx={16}
          message={labels.goalRemoved}
        />
      ) : null}
      <ScrollArea
        scrollbarMode="native"
        className="flex h-full min-h-0 flex-1 flex-col [&_[data-orientation=vertical][data-slot=scroll-area-scrollbar]]:opacity-100"
        viewportRef={timelineRef}
        viewportContentRef={timelineContentRef}
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
              isRespondingApproval={isInteractionPending}
              previewMode={previewMode}
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
          <>
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
            {tuttiModePlanPanels.panels.map((panel) => (
              <TuttiModePlanPanel
                key={panel.id}
                labels={labels.tuttiModePlanPanel}
                panel={panel}
                submitting={
                  tuttiModePlanPanels.submittingCheckpointId ===
                  panel.checkpoint.id
                }
                onDecide={tuttiModePlanPanels.decide}
              />
            ))}
            {tuttiModePlanPanels.error ? (
              <div
                className="mx-auto flex w-full max-w-[860px] items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
                role="alert"
              >
                <span>{labels.tuttiModePlanLoadFailed}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={tuttiModePlanPanels.retry}
                >
                  {labels.tuttiModePlanRetry}
                </Button>
              </div>
            ) : null}
          </>
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
          isRespondingApproval={isInteractionPending}
          sessionChrome={sessionChrome}
          keyboardShortcutsEnabled={isActive}
          chromeLabels={chromeLabels}
          goalBannerLabels={goalBannerLabels}
          promptLabels={interactivePromptLabels}
          onSubmitApprovalOption={submitApprovalOption}
          onRetryActivation={retryActivation}
          onRetryInlineNotice={retryInlineNotice}
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
