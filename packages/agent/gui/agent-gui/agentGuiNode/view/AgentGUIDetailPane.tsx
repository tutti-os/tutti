import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../../shared/AgentMessageMarkdown";
import { latestAssistantMessageText } from "../../../shared/agentConversation/projection/agentConversationProjection";
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
  AgentGUIComposerViewModel,
  AgentGUIDetailViewModel,
  AgentHomeSuggestionAction,
  AgentGUIInteractionViewModel,
  AgentGUIOperationsViewModel,
  AgentGUIRailViewModel,
  AgentGUIReadinessViewModel,
  AgentGUIShellViewModel
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
  handoffProjectPathForConversation
} from "./agentGUIDetailModelHelpers";
import { AgentGUIBottomDockPane } from "./AgentGUIBottomDockPane";
import {
  AgentGUIEmptyHomePane,
  EMPTY_HOME_SUGGESTIONS,
  resolveAgentGUIHeroIconUrl
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
import type { AgentGUIComposerEngagement } from "../engagement/agentGUIEngagement.types";
import { useAgentGUITuttiWorkflow } from "./useAgentGUITuttiWorkflow";

export const EMPTY_WORKSPACE_APP_ICONS: readonly AgentMessageMarkdownWorkspaceAppIcon[] =
  [];
export interface AgentGUIDetailPaneProps {
  shell: AgentGUIShellViewModel;
  rail: AgentGUIRailViewModel;
  detail: AgentGUIDetailViewModel;
  composer: AgentGUIComposerViewModel;
  interaction: AgentGUIInteractionViewModel;
  readiness: AgentGUIReadinessViewModel;
  operations: AgentGUIOperationsViewModel;
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

export const AgentGUIDetailPane = memo(function AgentGUIDetailPane({
  shell,
  rail,
  detail,
  composer,
  interaction,
  readiness,
  operations,
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
  const viewModel = {
    shell,
    rail,
    detail,
    composer,
    interaction,
    readiness,
    operations
  };
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
    homeNoticeChrome,
    inlineNoticeChrome,
    interactivePromptLabels,
    isComposerSending,
    selectedAgentTargetComingSoon,
    sessionChrome,
    showStopButton,
    stopDisabled,
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
  const retryComposerOptions = useStableEventCallback(
    actions.retryComposerOptions
  );
  const setTuttiModeActive = useStableEventCallback(actions.setTuttiModeActive);
  const setTuttiModeOrchestrationIntensity = useStableEventCallback(
    actions.setTuttiModeOrchestrationIntensity
  );
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
    previewMode,
    labels,
    stableLinkAction,
    setTuttiModeActive: actions.setTuttiModeActive,
    setTuttiModeOrchestrationIntensity:
      actions.setTuttiModeOrchestrationIntensity,
    updateDraftContent: actions.updateDraftContent,
    submitPromptPassthrough: submitPromptAndScrollToBottom
  });
  const tuttiWorkflowComposer = tuttiWorkflow.composer;
  const tuttiWorkflowDock = tuttiWorkflow.workflowDock;
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
  const bottomDockComposerProps = useMemo<AgentComposerProps>(
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
      submitDisabled:
        submitDisabled ||
        timelineInteractionLocked ||
        tuttiWorkflowDock.phase?.kind === "materializing",
      tuttiModeActive: viewModel.composer.isTuttiModeActive,
      tuttiModeUpdating: viewModel.composer.isTuttiModeUpdating,
      tuttiModeOrchestrationIntensity:
        viewModel.composer.tuttiModeOrchestrationIntensity,
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
      stopDisabled: stopDisabled || timelineInteractionLocked,
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
      // Only wire Tutti Mode callbacks when the host explicitly enables the
      // capability. Composer footer chip keys off callback presence; slash/badge
      // use capabilityMenuState.tuttiMode.enabled === true (fail closed).
      onTuttiModeChange:
        capabilityMenuState?.tuttiMode?.enabled === true
          ? tuttiWorkflowComposer.setTuttiModeActiveAndSettleReview
          : undefined,
      onTuttiModeOrchestrationIntensityChange:
        capabilityMenuState?.tuttiMode?.enabled === true
          ? setTuttiModeOrchestrationIntensity
          : undefined,
      onPlanIssueBudgetPresetChange: updatePlanIssueBudgetPreset,
      onSubmit: tuttiWorkflowComposer.submitPromptOrDecidePlan,
      onSubmitEmpty: tuttiWorkflowComposer.planReviewSendActive
        ? tuttiWorkflowComposer.acceptPendingPlan
        : undefined,
      emptySubmitLabel:
        tuttiWorkflowComposer.planReviewSendActive &&
        tuttiWorkflowComposer.planReviewIntensityDiverged
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
      onSlashStatusClose,
      onSlashStatusRefresh,
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
      stopDisabled,
      slashStatus,
      submitDisabled,
      setTuttiModeActive,
      setTuttiModeOrchestrationIntensity,
      submitInteractivePrompt,
      tuttiWorkflowComposer.submitPromptOrDecidePlan,
      tuttiWorkflowComposer.planReviewSendActive,
      tuttiWorkflowComposer.planReviewIntensityDiverged,
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
      viewModel.composer.tuttiModeOrchestrationIntensity,
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
  const homeContent = !hasActiveConversation ? (
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
          iconUrl: resolveAgentGUIHeroIconUrl(disabledProviderTarget.provider),
          unavailableReason: disabledProviderTarget.unavailableReason ?? null
        })}
      </>
    ) : (
      <AgentGUIEmptyHomePane
        provider={emptyHeroProvider}
        providerReadinessGate={emptyProviderReadinessGate}
        showAllProviders={viewModel.rail.conversationFilter.kind === "all"}
        agentTargets={composerProviderTargets}
        selectedAgentTarget={composerSelectedProviderTarget}
        onProviderSelect={
          canSwitchComposerProvider &&
          viewModel.rail.activeConversationId === null
            ? selectHomeComposerAgentTargetAndFocus
            : undefined
        }
        noticeChrome={homeNoticeChrome}
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
  ) : null;

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
      <AgentGUIDetailTimeline
        availableSkills={viewModel.composer.availableSkills}
        conversation={conversation}
        conversationFlowEmpty={conversationFlowEmpty}
        conversationFlowLabels={conversationFlowLabels}
        hasActiveConversation={hasActiveConversation}
        homeContent={homeContent}
        isLoadingOlderMessages={viewModel.detail.isLoadingOlderMessages}
        isTimelineScrolledToTop={isTimelineScrolledToTop}
        labels={labels}
        onAuthLogin={authLogin}
        onLinkAction={stableLinkAction}
        previewMode={previewMode}
        showTimelineSkeleton={showTimelineSkeleton}
        showUnavailableChatEmpty={showUnavailableChatEmpty}
        timelineContentRef={timelineContentRef}
        timelineRef={timelineRef}
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
          tuttiWorkflowDock={tuttiWorkflowDock}
          tuttiWorkflowDockLabels={labels.tuttiWorkflowDock}
          tuttiPlanPanelLabels={labels.tuttiModePlanPanel}
          tuttiPlanIssuePanelLabels={labels.tuttiModePlanIssuePanel}
        />
      ) : null}
    </main>
  );
});
