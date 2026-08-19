import { memo, useCallback, useMemo, useRef } from "react";
import type { AgentTranscriptVirtualScrollController } from "../../../shared/agentConversation/components/AgentTranscriptView";
import { latestAssistantMessageText } from "../../../shared/agentConversation/projection/agentConversationProjection";
import { AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT } from "../../../workbench/contribution";
import type { AgentComposerProps } from "../AgentComposer";
import type { AgentHomeSuggestionAction } from "../model/agentGuiNodeTypes";
import {
  emptyAgentComposerDraft,
  updateAgentComposerDraft
} from "../model/agentComposerDraft";
import { resolveAgentComposerDraftScopeKey } from "../model/agentComposerDraftScope";
import {
  buildAgentConversationHandoffPrompt,
  handoffProjectPathForConversation,
  resolveAgentGUIComposerInteractionDisabledReason,
  resolveAgentGUITuttiStopTargets
} from "./agentGUIDetailModelHelpers";
import { EMPTY_WORKSPACE_APP_ICONS } from "./agentGUIDetailConstants";
import { AgentGUIBottomDockPane } from "./AgentGUIBottomDockPane";
import {
  AgentGUIEmptyHomePane,
  EMPTY_HOME_SUGGESTIONS
} from "./AgentGUIEmptyState";
import { AgentGUIContentToast } from "./AgentGUIContentToast";
import { AgentGUIDetailTimeline } from "./AgentGUIDetailTimeline";
import {
  useOptionalStableEventCallback,
  useStableEventCallback
} from "./agentGUIViewUtils";
import styles from "../AgentGUINode.styles";
import { useAgentGUIDetailScroll } from "./useAgentGUIDetailScroll";
import { useAgentGUIDetailModel } from "./useAgentGUIDetailModel";
import { useAgentGUIComposerInputHistoryProps } from "./useAgentGUIComposerInputHistoryProps";
import { useAgentGUITuttiWorkflow } from "./useAgentGUITuttiWorkflow";
import type { AgentGUIDetailPaneProps } from "./AgentGUIDetailPane.types";
import { useAgentGUIDetailEditRetry } from "./useAgentGUIDetailEditRetry";
import { useAgentGUIDetailSideConversation } from "./useAgentGUIDetailSideConversation";
import { useAgentGUIDetailSideChrome as useSideChrome } from "./useAgentGUIDetailSideChrome";
import type { TimelineScrollAnchor } from "./agentGUIScrollMemory";
import { useBottomDockInteractionSubmission } from "./useBottomDockInteractionSubmission";
export const AgentGUIDetailPane = memo(function AgentGUIDetailPane({
  shell,
  rail,
  detail,
  composer,
  interaction,
  readiness,
  operations,
  homeTargetProjection,
  referenceProvenanceFilters = null,
  sessionInputHistoryEnabled = false,
  sideConversationEnabled = false,
  sessionWorktreeEnabled = false,
  sessionLaunchModesByProjectSectionKey,
  onSessionLaunchModePreferenceChange,
  composerEngagement,
  actions,
  labels,
  workspaceUserProjectI18n,
  uiLanguage,
  isActive,
  isVisible,
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
  showHandoffTargetOwnershipLabels = false,
  capabilityMenuState,
  capabilityControlsReadOnly = false,
  onCapabilitySettingsRequest,
  onAgentProviderLogin,
  onRequestWorkspaceReferences,
  resolveExternalPromptEntries = null,
  prepareExternalPromptFiles = null,
  resolvePastedPath = null,
  promptAssetLimit = null,
  selectProjectDirectory,
  projectSelectOptions,
  onRequestGitBranches,
  onRequestComposerFocus,
  workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS,
  renderComposerFooterAccessory
}: AgentGUIDetailPaneProps): React.JSX.Element {
  "use memo";
  const viewModel = {
    shell,
    rail,
    detail,
    composer,
    interaction,
    readiness,
    operations
  };
  // Keep refs here: React Compiler may cache a custom Hook's returned object.
  const bottomDockRef = useRef<HTMLDivElement | null>(null);
  const pendingPrependScrollAnchorRef = useRef<{
    conversationId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const submittedPromptScrollConversationRef = useRef<string | null>(null);
  const timelineContentRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineScrollAnchorRef = useRef<TimelineScrollAnchor | null>(null);
  const virtualScrollControllerRef =
    useRef<AgentTranscriptVirtualScrollController | null>(null);
  const {
    activePromptResponsePending,
    bottomDockLiftedPrompt,
    bottomDockReplacementPrompt,
    chromeLabels,
    composerActivePrompt,
    composerDisabledReason,
    composerGate,
    composerLabels,
    conversation,
    conversationFlowEmpty,
    conversationFlowLabels,
    dismissBottomDockPrompt,
    emptyProviderReadinessGate,
    goalBannerLabels,
    hasActiveConversation,
    homeNoticeChrome,
    inlineNoticeChrome,
    interactivePromptLabels,
    isComposerSending,
    sessionChrome,
    showStopButton,
    stopDisabled,
    showTimelineSkeleton,
    showUnavailableChatEmpty,
    slashStatus: derivedSlashStatus,
    timelineConversationId,
    timelineInteractionLocked
  } = useAgentGUIDetailModel({
    labels,
    slashStatusLimits,
    slashStatusLimitsLoading,
    slashStatusLimitsUnavailable,
    viewModel
  });
  const slashStatus = slashStatusOverride ?? derivedSlashStatus;
  const handleForkThroughTurn = useStableEventCallback((turnId: string) => {
    const agentSessionId =
      conversation?.sourceDetail.session.agentSessionId.trim() ?? "";
    if (agentSessionId) {
      void actions.forkConversationThroughTurn(agentSessionId, turnId);
    }
  });
  const openForkSourceSession = useStableEventCallback(
    actions.openForkSourceConversation
  );
  const editRetry = useAgentGUIDetailEditRetry({
    agentSessionId: viewModel.rail.activeConversationId,
    workspaceId: viewModel.shell.workspaceId
  });
  const submitApproval = useStableEventCallback(actions.submitApprovalOption);
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
  const clearMainDraft = useStableEventCallback(() =>
    updateDraftContent(emptyAgentComposerDraft())
  );
  const updateSelectedProjectPath = useOptionalStableEventCallback(
    actions.updateSelectedProjectPath
  );
  const updateComposerSettings = useStableEventCallback(
    actions.updateComposerSettings
  );
  const retryComposerOptions = useStableEventCallback(
    actions.retryComposerOptions
  );
  const setTuttiModeEffect = useStableEventCallback(actions.setTuttiModeEffect);
  const setTuttiModeSpeed = useStableEventCallback(actions.setTuttiModeSpeed);
  const updatePlanIssueBudgetPreset = useStableEventCallback(
    actions.updatePlanIssueBudgetPreset
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
      updateDraftContent(
        updateAgentComposerDraft(viewModel.composer.draftContent, { prompt })
      );
    },
    [updateDraftContent, viewModel.composer.draftContent]
  );
  const handleHomeSuggestionAction = useCallback(
    (action: AgentHomeSuggestionAction) => {
      if (action === "import-session") {
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
  const requestSubmittedPromptScrollToBottom = useStableEventCallback(() => {
    const activeConversationId = viewModel.rail.activeConversationId;
    if (!activeConversationId) {
      return;
    }
    submittedPromptScrollConversationRef.current = activeConversationId;
    pendingPrependScrollAnchorRef.current = null;
  });
  const submitPromptAndScrollToBottom = useStableEventCallback(
    (...args: Parameters<typeof submitPrompt>): void => {
      requestSubmittedPromptScrollToBottom();
      submitPrompt(...args);
    }
  );
  const submitGuidancePromptAndScrollToBottom = useStableEventCallback(
    (...args: Parameters<typeof submitGuidancePrompt>): void => {
      requestSubmittedPromptScrollToBottom();
      submitGuidancePrompt(...args);
    }
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
  const tuttiWorkflow = useAgentGUITuttiWorkflow({
    viewModel,
    labels,
    stableLinkAction,
    setTuttiModeActive: actions.setTuttiModeActive,
    setTuttiModeEffect: actions.setTuttiModeEffect,
    setTuttiModeSpeed: actions.setTuttiModeSpeed,
    updateDraftContent: actions.updateDraftContent,
    submitPromptPassthrough: submitPromptAndScrollToBottom
  });
  const tuttiWorkflowComposer = tuttiWorkflow.composer;
  const tuttiWorkflowDock = tuttiWorkflow.workflowDock;
  const sourceActiveTurn =
    viewModel.detail.conversationDetail?.session.activeTurn ?? null;
  const sourceHasStoppableWork =
    Boolean(sourceActiveTurn && sourceActiveTurn.phase !== "settled") ||
    viewModel.composer.isCreatingConversation;
  const handleInterruptCurrentTurn = useStableEventCallback(() => {
    const targets = resolveAgentGUITuttiStopTargets({
      executionActive: tuttiWorkflowComposer.tuttiExecutionActive,
      sourceHasStoppableWork
    });
    if (targets.stopExecution) {
      void tuttiWorkflowComposer
        .stopTuttiExecution()
        .catch((error: unknown) => {
          console.error("tutti plan execution stop failed", error);
        });
    }
    if (targets.stopSession) {
      actions.interruptCurrentTurn(labels.noRunningResponse);
    }
  });
  const stableRequestWorkspaceReferences = useOptionalStableEventCallback(
    onRequestWorkspaceReferences
  );
  const stableSelectProjectDirectory = useOptionalStableEventCallback(
    selectProjectDirectory
  );
  const stableRequestGitBranches =
    useOptionalStableEventCallback(onRequestGitBranches);
  const authLogin = useOptionalStableEventCallback(onAgentProviderLogin);
  const submitBottomDockInteractivePrompt = useBottomDockInteractionSubmission(
    submitInteractivePrompt,
    dismissBottomDockPrompt
  );
  const isInteractionPending = activePromptResponsePending;
  const composerActivePromptDisabledReason =
    resolveAgentGUIComposerInteractionDisabledReason(
      composerActivePrompt?.kind,
      viewModel.interaction
    );
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
  const handoffSourceSessionId = viewModel.rail.activeConversationId;
  const stableHandoffConversation = useOptionalStableEventCallback(
    onHandoffConversation && handoffSourceSessionId !== null
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
            sourceAgentSessionId: handoffSourceSessionId,
            userProjectPath: handoffProjectPathForConversation(
              viewModel.rail.activeConversation
            )
          })
      : undefined
  );
  const composerInputHistoryProps = useAgentGUIComposerInputHistoryProps({
    actions,
    conversation,
    enabled: sessionInputHistoryEnabled,
    pendingPrependScrollAnchorRef,
    timelineRef,
    viewModel
  });
  const sideConversation = useAgentGUIDetailSideConversation({
    enabled: sideConversationEnabled,
    workspaceId: viewModel.shell.workspaceId,
    sourceAgentSessionId: viewModel.rail.activeConversationId,
    provider: composerProvider,
    cwd: viewModel.shell.workspacePath ?? null,
    availableCommands: viewModel.composer.availableCommands,
    clearMainDraft,
    submitPrompt: tuttiWorkflowComposer.submitPromptOrDecidePlan
  });
  const sideComposerFocused = sideConversation.focused;
  const baseComposerProps = useMemo<AgentComposerProps>(
    () => ({
      workspaceId: viewModel.shell.workspaceId,
      agentSessionId: viewModel.rail.activeConversationId,
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
      ...composerInputHistoryProps,
      availableCommands: sideConversation.commands,
      hasCompactableContext: viewModel.detail.hasSentUserMessage,
      compactSupported: viewModel.composer.compactSupported,
      availableSkills: viewModel.composer.availableSkills,
      selectedAgentTarget: composerSelectedProviderTarget,
      sessionWorktreeEnabled:
        sessionWorktreeEnabled &&
        sessionLaunchModesByProjectSectionKey !== undefined,
      sessionLaunchMode:
        sessionLaunchModesByProjectSectionKey?.[
          viewModel.composer.composerSettings.selectedProjectSectionKey?.trim() ??
            ""
        ] ?? "local",
      onSessionLaunchModeChange:
        onSessionLaunchModePreferenceChange &&
        viewModel.composer.composerSettings.selectedProjectSectionKey?.trim()
          ? (mode) =>
              onSessionLaunchModePreferenceChange({
                mode,
                projectSectionKey:
                  viewModel.composer.composerSettings.selectedProjectSectionKey!.trim()
              })
          : undefined,
      agentTargets: composerProviderTargets,
      handoffAgentTargets: composerHandoffProviderTargets,
      showHandoffTargetOwnershipLabels,
      providerSelectReadonly: viewModel.rail.activeConversationId !== null,
      onProviderSelect:
        viewModel.rail.activeConversationId === null
          ? selectHomeComposerAgentTargetAndFocus
          : undefined,
      gate: composerGate,
      presentationEditorDisabled: timelineInteractionLocked,
      disabledReason: composerDisabledReason,
      presentationSubmitDisabled:
        timelineInteractionLocked ||
        tuttiWorkflowDock.phase?.kind === "materializing",
      tuttiModeActive: viewModel.composer.isTuttiModeActive,
      tuttiModeUpdating: viewModel.composer.isTuttiModeUpdating,
      tuttiModeEffect: viewModel.composer.tuttiModeEffect,
      tuttiModeSpeed: viewModel.composer.tuttiModeSpeed,
      composerSettings: viewModel.composer.composerSettings,
      queueStatus: viewModel.composer.queueStatus,
      queuedPrompts: viewModel.composer.queuedPrompts,
      drainingQueuedPromptId: viewModel.composer.drainingQueuedPromptId,
      workspaceAppIcons,
      placeholder: viewModel.detail.hasSentUserMessage
        ? labels.followupPlaceholder
        : labels.initialPlaceholder,
      showStopButton:
        showStopButton || tuttiWorkflowComposer.tuttiExecutionActive,
      activeTurnId: sourceActiveTurn?.turnId ?? null,
      draftOverridesStopButton: tuttiWorkflowComposer.tuttiExecutionActive,
      stopDisabled:
        stopDisabled ||
        timelineInteractionLocked ||
        tuttiWorkflowComposer.tuttiExecutionStopping,
      workspaceReferencePickerOpen,
      referenceProvenanceFilters,
      activePrompt: composerActivePrompt,
      activePromptKeyboardShortcutsEnabled: isActive && !sideComposerFocused,
      activePromptDisabledReason: composerActivePromptDisabledReason,
      promptTips: labels.promptTips,
      composerFocusRequestSequence,
      isActive: isActive && !sideComposerFocused,
      promptImagesSupported: viewModel.composer.promptImagesSupported,
      providerSelectLabel: labels.providerSwitchLabel,
      handoffLabel: labels.handoffConversation,
      handoffMenuLabel: labels.handoffConversationMenu,
      isInterrupting:
        viewModel.composer.isInterrupting ||
        viewModel.composer.isCancelPending ||
        tuttiWorkflowComposer.tuttiExecutionStopping,
      modelConsult:
        viewModel.rail.activeConversationId !== null
          ? {
              agentSessionId: viewModel.rail.activeConversationId,
              lastAssistantMessageText: latestAssistantMessageText(conversation)
            }
          : null,
      isSendingTurn: isComposerSending,
      isSubmittingPrompt: isInteractionPending,
      uiLanguage,
      labels: composerLabels,
      workspaceUserProjectI18n,
      capabilityMenuState,
      capabilityControlsReadOnly,
      onDraftContentChange: updateDraftContent,
      onProjectPathChange: updateSelectedProjectPath,
      onSettingsChange: updateComposerSettings,
      onRetryComposerOptions: retryComposerOptions,
      onTuttiModeChange:
        capabilityMenuState?.tuttiMode?.enabled === true
          ? tuttiWorkflowComposer.setTuttiModeActiveAndSettleReview
          : undefined,
      onTuttiModeEffectChange:
        capabilityMenuState?.tuttiMode?.enabled === true
          ? setTuttiModeEffect
          : undefined,
      onTuttiModeSpeedChange:
        capabilityMenuState?.tuttiMode?.enabled === true
          ? setTuttiModeSpeed
          : undefined,
      onPlanIssueBudgetPresetChange: updatePlanIssueBudgetPreset,
      onSubmit: sideConversation.submitMain,
      onSubmitEmpty: tuttiWorkflowComposer.planReviewSendActive
        ? tuttiWorkflowComposer.acceptPendingPlan
        : undefined,
      emptySubmitLabel:
        tuttiWorkflowComposer.planReviewSendActive &&
        tuttiWorkflowComposer.planReviewPreferencesDiverged
          ? labels.tuttiModePlanSendRequestChanges
          : undefined,
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
      resolvePastedPath,
      promptAssetLimit,
      selectProjectDirectory: stableSelectProjectDirectory,
      projectSelectOptions,
      onRequestGitBranches: stableRequestGitBranches
    }),
    [
      capabilityMenuState,
      capabilityControlsReadOnly,
      composerDisabledReason,
      composerGate,
      composerFocusRequestSequence,
      composerEngagement,
      composerInputHistoryProps,
      composerHandoffProviderTargets,
      composerLabels,
      conversation,
      composerProviderTargets,
      composerSelectedProviderTarget,
      timelineInteractionLocked,
      handleInterruptCurrentTurn,
      isActive,
      sideComposerFocused,
      isComposerSending,
      labels,
      stableHandoffConversation,
      onSlashStatusOpen,
      onSlashStatusClose,
      onSlashStatusRefresh,
      workspaceReferencePickerOpen,
      composerActivePrompt,
      composerActivePromptDisabledReason,
      editQueuedPrompt,
      onCapabilitySettingsRequest,
      removeQueuedPrompt,
      resolveExternalPromptEntries,
      prepareExternalPromptFiles,
      resolvePastedPath,
      promptAssetLimit,
      projectSelectOptions,
      sendQueuedPromptNext,
      showPromptImagesUnsupported,
      showStopButton,
      sourceActiveTurn?.turnId,
      showHandoffTargetOwnershipLabels,
      sessionWorktreeEnabled,
      sessionLaunchModesByProjectSectionKey,
      onSessionLaunchModePreferenceChange,
      stopDisabled,
      slashStatus,
      setTuttiModeEffect,
      setTuttiModeSpeed,
      submitInteractivePrompt,
      tuttiWorkflowComposer.submitPromptOrDecidePlan,
      sideConversation.submitMain,
      tuttiWorkflowComposer.planReviewSendActive,
      tuttiWorkflowComposer.tuttiExecutionActive,
      tuttiWorkflowComposer.tuttiExecutionStopping,
      tuttiWorkflowComposer.planReviewPreferencesDiverged,
      tuttiWorkflowDock.phase?.kind,
      labels.tuttiModePlanSendRequestChanges,
      tuttiWorkflowComposer.acceptPendingPlan,
      submitGuidancePromptAndScrollToBottom,
      uiLanguage,
      stableLinkAction,
      stableRequestGitBranches,
      stableSelectProjectDirectory,
      stableRequestWorkspaceReferences,
      updateComposerSettings,
      retryComposerOptions,
      updatePlanIssueBudgetPreset,
      updateDraftContent,
      updateSelectedProjectPath,
      viewModel.rail.activeConversationId,
      viewModel.composer.availableCommands,
      sideConversation.commands,
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
      viewModel.composer.isTuttiModeActive,
      viewModel.composer.isTuttiModeUpdating,
      viewModel.composer.tuttiModeEffect,
      viewModel.composer.tuttiModeSpeed,
      isInteractionPending,
      viewModel.composer.promptImagesSupported,
      viewModel.composer.queueStatus,
      viewModel.composer.queuedPrompts,
      viewModel.detail.usage,
      viewModel.shell.workspaceId,
      viewModel.shell.workspacePath,
      referenceProvenanceFilters,
      workspaceUserProjectI18n,
      workspaceAppIcons,
      selectHomeComposerAgentTargetAndFocus
    ]
  );
  const { bottomDockComposerProps, selectionProps, sidePane } = useSideChrome({
    availableSkills: viewModel.composer.availableSkills,
    baseComposerProps,
    controller: sideConversation,
    conversationFlowLabels,
    isVisible,
    textSelectionActionsEnabled: sideConversationEnabled,
    onRequestComposerFocus,
    renderComposerFooterAccessory
  });
  const emptyHeroComposerProps = useMemo<AgentComposerProps>(
    () => ({
      ...bottomDockComposerProps,
      layoutMode: "hero"
    }),
    [bottomDockComposerProps]
  );
  const emptyHeroProvider =
    composerSelectedProviderTarget?.provider ?? viewModel.shell.data.provider;
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
  const {
    followEndMode,
    isTimelineScrolledToBottom,
    isTimelineScrolledToTop,
    setVirtualScrollController,
    scrollTimelineToBottom
  } = useAgentGUIDetailScroll({
    actions,
    bottomDockRef,
    bottomDockStoreRevision,
    conversation,
    isVisible,
    pendingPrependScrollAnchorRef,
    showTimelineSkeleton,
    submittedPromptScrollConversationRef,
    timelineConversationId,
    timelineContentRef,
    timelineRef,
    timelineScrollAnchorRef,
    virtualScrollControllerRef,
    viewModel
  });
  const homeContent = !hasActiveConversation ? (
    <AgentGUIEmptyHomePane
      isActive={isActive}
      isVisible={isVisible}
      provider={emptyHeroProvider}
      providerReadinessGate={emptyProviderReadinessGate}
      showAllProviders={viewModel.rail.conversationFilter.kind === "all"}
      agentTargets={composerProviderTargets}
      selectedAgentTarget={composerSelectedProviderTarget}
      onProviderSelect={
        viewModel.rail.activeConversationId === null
          ? selectHomeComposerAgentTargetAndFocus
          : undefined
      }
      noticeChrome={homeNoticeChrome}
      isRespondingApproval={isInteractionPending}
      onSubmitApprovalOption={submitApproval}
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
  ) : null;
  const forkedFrom =
    viewModel.detail.conversationDetail?.session.forkedFrom ?? null;
  return (
    <main
      className={styles.detail}
      aria-busy={timelineInteractionLocked || undefined}
      data-agent-session-id={viewModel.rail.activeConversationId ?? undefined}
    >
      {viewModel.operations.goalClearNoticeSequence > 0 ? (
        <AgentGUIContentToast
          key={viewModel.operations.goalClearNoticeSequence}
          insetTopPx={16}
          message={labels.goalRemoved}
        />
      ) : null}
      <div className={styles.detailWorkbench}>
        <section
          className={styles.detailPrimary}
          inert={timelineInteractionLocked}
        >
          <AgentGUIDetailTimeline
            availableSkills={viewModel.composer.availableSkills}
            conversation={conversation}
            editRetry={editRetry}
            conversationFlowEmpty={conversationFlowEmpty}
            conversationFlowLabels={conversationFlowLabels}
            followEndMode={followEndMode}
            forkedFrom={forkedFrom}
            hasActiveConversation={hasActiveConversation}
            homeContent={homeContent}
            isLoadingOlderMessages={viewModel.detail.isLoadingOlderMessages}
            isVisible={isVisible}
            isTimelineScrolledToTop={isTimelineScrolledToTop}
            labels={labels}
            onAuthLogin={authLogin}
            onForkThroughTurn={handleForkThroughTurn}
            onOpenForkSourceSession={openForkSourceSession}
            forkThroughTurnPendingTurnIds={
              viewModel.operations.forkThroughTurnPendingTurnIds
            }
            onLinkAction={stableLinkAction}
            {...selectionProps}
            showTimelineSkeleton={showTimelineSkeleton}
            showUnavailableChatEmpty={showUnavailableChatEmpty}
            timelineContentRef={timelineContentRef}
            timelineRef={timelineRef}
            virtualScrollControllerRef={setVirtualScrollController}
            workspaceAppIcons={workspaceAppIcons}
          />
          {hasActiveConversation ? (
            <AgentGUIBottomDockPane
              bottomDockRef={bottomDockRef}
              showScrollToBottom={!isTimelineScrolledToBottom}
              scrollToBottomLabel={labels.scrollToBottom}
              onScrollToBottom={scrollTimelineToBottom}
              bottomDockLiftedPrompt={bottomDockLiftedPrompt}
              bottomDockReplacementPrompt={bottomDockReplacementPrompt}
              composerProps={bottomDockComposerProps}
              approvalDisabledReason={
                viewModel.interaction.approvalDisabledReason
              }
              interactivePromptDisabledReason={
                viewModel.interaction.interactivePromptDisabledReason
              }
              inlineNoticeChrome={inlineNoticeChrome}
              isRespondingApproval={isInteractionPending}
              sessionChrome={sessionChrome}
              keyboardShortcutsEnabled={isActive && !sideComposerFocused}
              chromeLabels={chromeLabels}
              goalBannerLabels={goalBannerLabels}
              promptLabels={interactivePromptLabels}
              onSubmitApprovalOption={submitApproval}
              onRetryActivation={retryActivation}
              onRetryInlineNotice={retryInlineNotice}
              onAuthLogin={authLogin}
              onContinueInNewConversation={continueInNewConversation}
              onSubmitBottomDockInteractivePrompt={
                submitBottomDockInteractivePrompt
              }
              onGoalControl={goalControl}
              goalPauseSupported={viewModel.composer.goalPauseSupported}
              tuttiWorkflowDock={tuttiWorkflowDock}
              tuttiWorkflowDockLabels={labels.tuttiWorkflowDock}
              tuttiPlanPanelLabels={labels.tuttiModePlanPanel}
              tuttiPlanIssuePanelLabels={labels.tuttiModePlanIssuePanel}
            />
          ) : null}
        </section>
        {hasActiveConversation ? sidePane : null}
      </div>
    </main>
  );
});
