import { useMemo } from "react";
import type { AgentGUIProviderReadinessGate } from "../../../types";
import { isAgentGUIAgentTargetComingSoon } from "../../../agentTargets";
import { UnavailableChatIcon } from "../../../app/renderer/components/icons/UnavailableChatIcon";
import { useProjectedAgentConversation } from "../../../shared/agentConversation/projection/useProjectedAgentConversation";
import type { AgentComposerSlashStatusLimit } from "../AgentComposer";
import type { AgentGoalBannerLabels } from "../AgentGoalBanner";
import type {
  AgentGUIInlineNotice,
  AgentGUINodeViewModel,
  AgentGUISessionChrome
} from "../model/agentGuiNodeTypes";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";
import {
  isContextCanceledMessage,
  isDifferentKnownConversationOwner,
  isAgentGUITransportNoticeVisible,
  resolveActiveConversationBusyStatus,
  resolveConversationDetailStatus,
  resolveAgentGUIStopControl,
  resolveSlashStatus,
  useStableSlashStatus
} from "./agentGUIDetailModelHelpers";
import { useAgentGUITimelineTransition } from "./useAgentGUITimelineTransition";
import styles from "../AgentGUINode.styles";

interface Input {
  bottomDockDismissedPromptRequestId: string | null;
  labels: AgentGUIViewLabels;
  slashStatusLimits: readonly AgentComposerSlashStatusLimit[];
  slashStatusLimitsLoading: boolean;
  slashStatusLimitsUnavailable: boolean;
  viewModel: AgentGUINodeViewModel;
}

export function resolveTuttiModeUpdateInlineNotice(input: {
  failedMessage: string;
  status: AgentGUINodeViewModel["composer"]["tuttiModeUpdateStatus"];
  uncertainMessage: string;
}): AgentGUIInlineNotice | null {
  if (input.status !== "failed" && input.status !== "uncertain") return null;
  const localizedMessage =
    input.status === "failed" ? input.failedMessage : input.uncertainMessage;
  return {
    autoDismissMs: null,
    id: `agent-gui-tutti-mode-update-${input.status}`,
    message: localizedMessage,
    tone: input.status === "failed" ? "error" : "warning"
  };
}

export function useAgentGUIDetailModel(input: Input) {
  const {
    bottomDockDismissedPromptRequestId,
    labels,
    slashStatusLimits,
    slashStatusLimitsLoading,
    slashStatusLimitsUnavailable,
    viewModel
  } = input;
  const projectedConversation = useProjectedAgentConversation({
    conversation: viewModel.detail.conversation,
    detail: viewModel.detail.conversationDetail,
    avoidGroupingEdits: viewModel.detail.avoidGroupingEdits
  });
  const targetConversation =
    viewModel.detail.availability === "not_found"
      ? null
      : projectedConversation;
  const {
    conversation,
    showTimelineSkeleton,
    timelineConversationId,
    transitionPending: timelineTransitionPending
  } = useAgentGUITimelineTransition({
    activeConversationId: viewModel.rail.activeConversationId,
    availability: viewModel.detail.availability,
    conversation: targetConversation
  });
  const hasActiveConversation = viewModel.rail.activeConversationId !== null;
  const selectedAgentTargetComingSoon = isAgentGUIAgentTargetComingSoon(
    viewModel.rail.selectedAgentTarget,
    viewModel.rail.comingSoonProviders
  );
  const emptyProviderReadinessGate = !hasActiveConversation
    ? selectedAgentTargetComingSoon
      ? ({ status: "coming_soon" } satisfies AgentGUIProviderReadinessGate)
      : viewModel.readiness.providerReadinessGate
    : null;
  const activePrompt =
    viewModel.interaction.pendingInteractivePrompt ??
    viewModel.interaction.pendingApproval;
  const activePromptRequestId = activePrompt?.requestId ?? null;
  const sessionChrome = useMemo<AgentGUISessionChrome>(
    () => ({ ...viewModel.interaction.sessionChrome, approval: null }),
    [viewModel.interaction.sessionChrome]
  );
  const transportNoticeVisible = isAgentGUITransportNoticeVisible(
    sessionChrome.recovery
  );
  const rawSlashStatus = useMemo(
    () =>
      resolveSlashStatus({
        rawState: viewModel.interaction.sessionChrome.rawState,
        limits: slashStatusLimits,
        limitsLoading: slashStatusLimitsLoading,
        limitsUnavailable: slashStatusLimitsUnavailable,
        usage: viewModel.detail.usage
      }),
    [
      slashStatusLimits,
      slashStatusLimitsLoading,
      slashStatusLimitsUnavailable,
      viewModel.detail.usage,
      viewModel.interaction.sessionChrome.rawState
    ]
  );
  const slashStatus = useStableSlashStatus(rawSlashStatus);
  const tuttiModeUpdateNotice = useMemo(
    () =>
      resolveTuttiModeUpdateInlineNotice({
        failedMessage: labels.tuttiModeUpdateFailed,
        status: viewModel.composer.tuttiModeUpdateStatus,
        uncertainMessage: labels.tuttiModeUpdateUncertain
      }),
    [
      labels.tuttiModeUpdateFailed,
      labels.tuttiModeUpdateUncertain,
      viewModel.composer.tuttiModeUpdateStatus
    ]
  );
  const displayedInlineNotice = useMemo(() => {
    if (transportNoticeVisible) {
      return null;
    }
    const inlineNotice =
      tuttiModeUpdateNotice ?? viewModel.interaction.inlineNotice;
    const inlineNoticeMessage = inlineNotice?.message.trim() ?? "";
    if (!inlineNotice || inlineNoticeMessage === "") {
      return null;
    }

    if (
      isContextCanceledMessage(inlineNoticeMessage) &&
      viewModel.rail.activeConversation?.status === "completed" &&
      viewModel.readiness.activeLiveState !== "failed"
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
    tuttiModeUpdateNotice,
    viewModel.rail.activeConversation?.status,
    viewModel.readiness.activeLiveState,
    transportNoticeVisible,
    viewModel.interaction.inlineNotice
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
        canRetry: displayedInlineNotice.id.startsWith(
          "agent-gui-tutti-mode-update-failed"
        )
      },
      rawState: null
    };
  }, [displayedInlineNotice]);
  // Plan decisions replace the composer in the bottom dock: the card takes its slot
  // and the composer hides until it is acted on (optimistically cleared via
  // bottomDockDismissedPromptRequestId) or otherwise resolves.
  const activePromptIsPlanDecision =
    activePrompt?.kind === "exit-plan" ||
    activePrompt?.kind === "plan-implementation";
  const activePromptIsVisible =
    activePrompt !== null &&
    !transportNoticeVisible &&
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
    !activePromptIsVisible ||
    activePromptIsPlanDecision ||
    shouldLiftActivePromptAboveInlineNotice
      ? null
      : activePrompt;
  const showUnavailableChatEmpty =
    hasActiveConversation && viewModel.detail.availability === "not_found";
  const activeDetailStatus = resolveConversationDetailStatus(
    viewModel.detail.conversationDetail
  );
  const derivedBusyStatus = resolveActiveConversationBusyStatus({
    conversationStatus: viewModel.rail.activeConversation?.status,
    detailStatus: activeDetailStatus,
    conversation: targetConversation
  });
  const activeConversationTurnBusy =
    viewModel.composer.isSubmitting ||
    viewModel.readiness.activeConversationBusy ||
    derivedBusyStatus !== null;
  const isComposerSending =
    viewModel.composer.isSubmitting ||
    activeConversationTurnBusy ||
    (!hasActiveConversation && viewModel.composer.isCreatingConversation);
  const isCollaboratorConversation = isDifferentKnownConversationOwner({
    conversationUserId: viewModel.rail.activeConversation?.userId,
    currentUserId: viewModel.shell.currentUserId
  });
  const canQueueWhileBusy =
    viewModel.composer.canQueueWhileBusy && !isCollaboratorConversation;
  const composerDisabledReason = isCollaboratorConversation
    ? labels.collaboratorSessionReadOnlyPlaceholder
    : null;
  const hasNonRetryableRecoveryFailure =
    (sessionChrome.recovery?.kind === "failed" &&
      sessionChrome.recovery.canRetry === false) ||
    sessionChrome.recovery?.kind === "resume-unavailable";
  const submitDisabled =
    hasNonRetryableRecoveryFailure ||
    isCollaboratorConversation ||
    viewModel.readiness.sessionRuntimeBlocked ||
    (!viewModel.composer.canSubmit && !canQueueWhileBusy);
  const composerDisabled =
    isCollaboratorConversation ||
    (!viewModel.readiness.sessionRuntimeBlocked &&
      (hasNonRetryableRecoveryFailure ||
        (!canQueueWhileBusy &&
          (viewModel.interaction.pendingApproval !== null ||
            viewModel.interaction.pendingInteractivePrompt !== null ||
            viewModel.composer.isSubmitting ||
            viewModel.composer.isInterrupting ||
            viewModel.composer.isCreatingConversation))));
  const stopControl = resolveAgentGUIStopControl({
    hasPendingApproval: viewModel.interaction.pendingApproval !== null,
    hasPendingInteractivePrompt:
      viewModel.interaction.pendingInteractivePrompt !== null,
    isAuthBlocked: sessionChrome.auth !== null,
    isCancelPending: viewModel.composer.isCancelPending,
    isConversationBusy: activeConversationTurnBusy,
    isCreatingConversation: viewModel.composer.isCreatingConversation,
    isInterrupting: viewModel.composer.isInterrupting,
    isSubmitting: viewModel.composer.isSubmitting,
    isUnavailable: viewModel.readiness.activeLiveState === "failed",
    sessionRuntimeBlocked: viewModel.readiness.sessionRuntimeBlocked
  });
  const showStopButton = stopControl.visible;
  const stopDisabled = stopControl.disabled;
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
    () =>
      showUnavailableChatEmpty ? (
        <div
          className={styles.unavailableChatEmpty}
          data-testid="agent-gui-unavailable-chat-empty"
        >
          <UnavailableChatIcon className={styles.unavailableChatEmptyIcon} />
          <span className={styles.unavailableChatEmptyText}>
            {labels.conversationUnavailable}
          </span>
        </div>
      ) : (
        <></>
      ),
    [labels.conversationUnavailable, showUnavailableChatEmpty]
  );
  const chromeLabels = useMemo(
    () => ({
      approvalRequired: labels.approvalRequired,
      authRequired: labels.authRequired,
      authLogin: labels.authLogin,
      // While connecting, if the user already requested a cancel that is waiting
      // for the session to come up, show "cancelling" instead of "connecting".
      activatingSession: viewModel.composer.isCancelPending
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
      viewModel.composer.isCancelPending
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
      fileChangeApprovalLead: labels.fileChangeApprovalRequired,
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
      labels.fileChangeApprovalRequired,
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
      sendAccept: labels.tuttiModePlanSendAccept,
      sendRequestChanges: labels.tuttiModePlanSendRequestChanges,
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
      reasoningOptionUltra: labels.reasoningOptionUltra,
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
      permissionModeChangeUnavailableDuringTurn:
        labels.permissionModeChangeUnavailableDuringTurn,
      modelDescriptions: labels.modelDescriptions,
      planModeLabel: labels.planModeLabel,
      normalModeLabel: labels.normalModeLabel,
      normalModeDescription: labels.normalModeDescription,
      tuttiModeLabel: labels.tuttiModeLabel,
      tuttiModeDescription: labels.tuttiModeDescription,
      tuttiBudgetTitle: labels.tuttiBudgetTitle,
      tuttiBudgetIntensityLabel: labels.tuttiBudgetIntensityLabel,
      tuttiBudgetIntensityMin: labels.tuttiBudgetIntensityMin,
      tuttiBudgetIntensityMax: labels.tuttiBudgetIntensityMax,
      tuttiBudgetConfirm: labels.tuttiBudgetConfirm,
      tuttiBudgetCancel: labels.tuttiBudgetCancel,
      planModeDescription: labels.planModeDescription,
      planModeOnLabel: labels.planModeOnLabel,
      planModeOffLabel: labels.planModeOffLabel,
      planUnavailable: labels.planUnavailable,
      goalLabel: labels.goalLabel,
      queuedLabel: labels.queuedLabel,
      queuePausedByUserLabel: labels.queuePausedByUserLabel,
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
      slashPaletteCapabilitiesLoading: labels.slashPaletteCapabilitiesLoading,
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
      slashStatusEmptyValue: labels.slashStatusEmptyValue,
      slashStatusUsageJustUpdated: labels.slashStatusUsageJustUpdated,
      slashStatusUsageMinutesAgo: labels.slashStatusUsageMinutesAgo,
      slashStatusUsageHoursAgo: labels.slashStatusUsageHoursAgo,
      slashStatusUsageUpdating: labels.slashStatusUsageUpdating,
      slashStatusUsageRefreshFailed: labels.slashStatusUsageRefreshFailed,
      slashStatusUsageRefreshAria: labels.slashStatusUsageRefreshAria,
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
      handoffTargetDeviceSource: labels.handoffTargetDeviceSource,
      handoffTargetSelf: labels.handoffTargetSelf,
      handoffTargetShared: labels.handoffTargetShared,
      providerSwitchLabel: labels.providerSwitchLabel,
      projectLocked: labels.projectLocked,
      projectMissingDescription: labels.projectMissingDescription,
      promptTipsPrefix: labels.promptTipsPrefix,
      reviewPicker: labels.reviewPicker,
      quickPrompts: labels.quickPrompts,
      ...interactivePromptLabels
    }),
    [
      interactivePromptLabels,
      labels.defaultModel,
      labels.tuttiModePlanSendAccept,
      labels.tuttiModePlanSendRequestChanges,
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
      labels.handoffTargetDeviceSource,
      labels.handoffTargetSelf,
      labels.handoffTargetShared,
      labels.inheritedUnavailable,
      labels.loadingConversation,
      labels.modelLabel,
      labels.modelContextWindowSuffix,
      labels.modelDescriptions,
      labels.modelSelectionLabel,
      labels.modelTooltipVersionLabel,
      labels.permissionLabel,
      labels.permissionModeAuto,
      labels.permissionModeChangeUnavailableDuringTurn,
      labels.permissionModeFullAccess,
      labels.permissionModeReadOnly,
      labels.planModeLabel,
      labels.normalModeLabel,
      labels.normalModeDescription,
      labels.tuttiModeLabel,
      labels.tuttiModeDescription,
      labels.tuttiBudgetTitle,
      labels.tuttiBudgetIntensityLabel,
      labels.tuttiBudgetIntensityMin,
      labels.tuttiBudgetIntensityMax,
      labels.tuttiBudgetConfirm,
      labels.tuttiBudgetCancel,
      labels.planModeDescription,
      labels.planModeOffLabel,
      labels.planModeOnLabel,
      labels.planUnavailable,
      labels.goalLabel,
      labels.projectLocked,
      labels.projectMissingDescription,
      labels.promptTipsPrefix,
      labels.reviewPicker,
      labels.quickPrompts,
      labels.queuedLabel,
      labels.queuePausedByUserLabel,
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
      labels.reasoningOptionUltra,
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
      labels.slashPaletteCapabilitiesLoading,
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
      labels.slashStatusEmptyValue,
      labels.slashStatusUsageHoursAgo,
      labels.slashStatusUsageJustUpdated,
      labels.slashStatusUsageMinutesAgo,
      labels.slashStatusUsageRefreshAria,
      labels.slashStatusUsageRefreshFailed,
      labels.slashStatusUsageUpdating,
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

  return {
    activeConversationTurnBusy,
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
    isCollaboratorConversation,
    isComposerSending,
    selectedAgentTargetComingSoon,
    sessionChrome,
    showStopButton,
    stopDisabled,
    showTimelineSkeleton,
    showUnavailableChatEmpty,
    slashStatus,
    submitDisabled,
    timelineConversationId,
    timelineInteractionLocked: timelineTransitionPending
  };
}
