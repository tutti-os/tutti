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
import type { AgentCollaborationVM } from "../../../shared/agentConversation/contracts/agentCollaborationVM";
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
import {
  agentPromptContentDisplayText,
  updateAgentComposerDraft
} from "../model/agentComposerDraft";
import { resolveAgentComposerDraftScopeKey } from "../model/agentComposerDraftScope";
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
import { AgentGUIContentToast } from "./AgentGUIContentToast";
import { AgentGUIConversationTimelinePane } from "./AgentGUIConversationTimelinePane";
import {
  useOptionalStableEventCallback,
  useStableEventCallback
} from "./agentGUIViewUtils";
import styles from "../AgentGUINode.styles";
import { useAgentGUIDetailScroll } from "./useAgentGUIDetailScroll";
import { useAgentGUIDetailModel } from "./useAgentGUIDetailModel";
import { useAgentGUIProviderRailPreferences } from "./useAgentGUIProviderRailPreferences";
import type { AgentGUIComposerEngagement } from "../engagement/agentGUIEngagement.types";
import {
  TuttiModePlanPanel,
  mergeTaskAssignmentDraft,
  taskAssignmentInputsFromDrafts,
  useTuttiModePlanPanels,
  type TuttiModePlanTaskAssignmentDraft,
  type TuttiModePlanTaskAssignmentDrafts
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
  referenceProvenanceFilter?: AgentComposerProps["referenceProvenanceFilter"];
  composerEngagement?: AgentGUIComposerEngagement;
  actions: AgentGUINodeViewProps["actions"];
  labels: AgentGUIViewLabels;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
  uiLanguage: UiLanguage;
  hideDetailHeader: boolean;
  isActive: boolean;
  previewMode: boolean;
  workspaceReferencePickerOpen: boolean;
  composerFocusRequestSequence: number | null;
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

export const AgentGUIDetailPane = memo(function AgentGUIDetailPane({
  viewModel,
  referenceProvenanceFilter = null,
  composerEngagement,
  actions,
  labels,
  workspaceUserProjectI18n,
  uiLanguage,
  hideDetailHeader,
  isActive,
  previewMode,
  workspaceReferencePickerOpen,
  composerFocusRequestSequence,
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
    slashStatus,
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
  const tuttiModePlanPanels = useTuttiModePlanPanels({
    enabled: !previewMode,
    workspaceId: viewModel.shell.workspaceId,
    sourceSessionId: viewModel.rail.activeConversationId,
    decidedBy: viewModel.shell.currentUserId?.trim() || "local"
  });
  // Assignment drafts are host-owned (keyed by panel id) so a composer-driven
  // accept can carry them; the panel only renders and reports edits.
  const [planAssignmentDrafts, setPlanAssignmentDrafts] = useState<
    Readonly<Record<string, TuttiModePlanTaskAssignmentDrafts>>
  >({});
  const handlePlanAssignmentDraftChange = useStableEventCallback(
    (
      panelId: string,
      taskId: string,
      patch: TuttiModePlanTaskAssignmentDraft
    ): void => {
      setPlanAssignmentDrafts((current) => ({
        ...current,
        [panelId]: mergeTaskAssignmentDraft(
          current[panelId] ?? {},
          taskId,
          patch
        )
      }));
    }
  );
  // The composer decides the earliest actionable checkpoint (single-review
  // flow: at most one is pending per session).
  const pendingPlanPanel =
    tuttiModePlanPanels.panels.find((panel) => panel.actionable) ?? null;
  const pendingPlanSubmitting =
    pendingPlanPanel !== null &&
    tuttiModePlanPanels.submittingCheckpointId ===
      pendingPlanPanel.checkpoint.id;
  const planReviewSendActive =
    pendingPlanPanel !== null && !pendingPlanSubmitting;
  // Once the session intensity diverges from the plan's snapshot, an empty
  // send means "re-plan at the new intensity" instead of accepting; matching
  // values (including adjusting back) restore accept semantics.
  const planReviewIntensityDiverged =
    pendingPlanPanel !== null &&
    viewModel.composer.tuttiModeOrchestrationIntensity !==
      pendingPlanPanel.execution.orchestrationIntensity;
  const decidePendingPlan = useStableEventCallback(
    (decision: "accepted" | "rejected" | "canceled", reason?: string): void => {
      if (!pendingPlanPanel || pendingPlanSubmitting) return;
      const assignments =
        decision === "accepted"
          ? taskAssignmentInputsFromDrafts(
              planAssignmentDrafts[pendingPlanPanel.id] ?? {},
              pendingPlanPanel.tasks
            )
          : [];
      void tuttiModePlanPanels.decide({
        workflowId: pendingPlanPanel.workflowId,
        checkpointId: pendingPlanPanel.checkpoint.id,
        decision,
        reason,
        taskAssignments: assignments.length > 0 ? assignments : undefined
      });
    }
  );
  const acceptPendingPlan = useStableEventCallback((): void => {
    if (planReviewIntensityDiverged && pendingPlanPanel) {
      decidePendingPlan(
        "rejected",
        labels.tuttiModePlanReplanFeedback(
          String(pendingPlanPanel.execution.orchestrationIntensity),
          String(viewModel.composer.tuttiModeOrchestrationIntensity)
        )
      );
      return;
    }
    decidePendingPlan("accepted");
  });
  const cancelPendingPlan = useStableEventCallback((): void => {
    decidePendingPlan("canceled");
  });
  // Turning Tutti mode off with a review still pending also cancels the
  // checkpoint: the banner and composer decision semantics clear with it, and
  // the agent continues naturally on the next message without plan context.
  const setTuttiModeActiveAndSettleReview = useStableEventCallback(
    (active: boolean): void => {
      if (!active) {
        decidePendingPlan("canceled");
      }
      setTuttiModeActive(active);
    }
  );
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
  const reviseFailedCollaboration = useStableEventCallback(
    (collaboration: AgentCollaborationVM) => {
      const prompt = collaboration.requestText?.trim();
      if (!prompt) return;
      updateDraftContent(
        updateAgentComposerDraft(viewModel.composer.draftContent, { prompt })
      );
      onRequestComposerFocus();
    }
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
    (...args: Parameters<typeof submitPrompt>): void => {
      requestSubmittedPromptScrollToBottom();
      submitPrompt(...args);
    },
    [requestSubmittedPromptScrollToBottom, submitPrompt]
  );
  // While a plan review is pending the composer doubles as the decision
  // surface: typed text becomes request-changes feedback (the daemon relays
  // it to the agent), an empty send accepts. Normal sends resume once the
  // checkpoint settles.
  const submitPromptOrDecidePlan = useStableEventCallback(
    (...args: Parameters<typeof submitPrompt>): void => {
      const [content] = args;
      if (pendingPlanPanel && !pendingPlanSubmitting) {
        let feedback = agentPromptContentDisplayText(content).trim();
        // Slash commands (e.g. the usage chip's "/compact") are never plan
        // feedback — let them flow through the normal submit path.
        if (feedback && !feedback.startsWith("/")) {
          if (planReviewIntensityDiverged) {
            feedback += labels.tuttiModePlanReplanFeedbackSuffix(
              String(viewModel.composer.tuttiModeOrchestrationIntensity)
            );
          }
          decidePendingPlan("rejected", feedback);
          updateDraftContent(
            updateAgentComposerDraft(viewModel.composer.draftContent, {
              prompt: ""
            })
          );
          return;
        }
      }
      submitPromptAndScrollToBottom(...args);
    }
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
      onRetryComposerOptions: retryComposerOptions,
      onTuttiModeChange: setTuttiModeActiveAndSettleReview,
      onTuttiModeOrchestrationIntensityChange:
        setTuttiModeOrchestrationIntensity,
      onPlanIssueBudgetPresetChange: updatePlanIssueBudgetPreset,
      onSubmit: submitPromptOrDecidePlan,
      onSubmitEmpty: planReviewSendActive ? acceptPendingPlan : undefined,
      emptySubmitLabel:
        planReviewSendActive && planReviewIntensityDiverged
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
      resolveDroppedFileReferences,
      selectProjectDirectory: stableSelectProjectDirectory,
      onRequestGitBranches: stableRequestGitBranches,
      contextMentionProviders
    }),
    [
      canQueueWhileBusy,
      capabilityMenuState,
      canSwitchComposerProvider,
      composerDisabled,
      composerDisabledReason,
      composerFocusRequestSequence,
      composerEngagement,
      composerHandoffProviderTargets,
      composerLabels,
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
      contextMentionProviders,
      removeQueuedPrompt,
      resolveDroppedFileReferences,
      sendQueuedPromptNext,
      showPromptImagesUnsupported,
      showStopButton,
      slashStatus,
      submitDisabled,
      setTuttiModeActive,
      setTuttiModeOrchestrationIntensity,
      submitInteractivePrompt,
      submitPromptOrDecidePlan,
      planReviewSendActive,
      planReviewIntensityDiverged,
      labels.tuttiModePlanSendRequestChanges,
      acceptPendingPlan,
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
    showTimelineSkeleton,
    submittedPromptScrollConversationRef,
    timelineConversationId,
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
          insetTopPx={hideDetailHeader ? 16 : 80}
          message={labels.goalRemoved}
        />
      ) : null}
      <AgentGUIDetailHeader
        activeConversation={viewModel.rail.activeConversation}
        hidden={hideDetailHeader}
        labels={labels}
        uiLanguage={uiLanguage}
        previewMode={previewMode}
      />
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
          <>
            <AgentGUIConversationTimelinePane
              conversation={conversation}
              isLoading={showTimelineSkeleton}
              isLoadingOlderMessages={viewModel.detail.isLoadingOlderMessages}
              loadingLabel={labels.loadingConversation}
              empty={conversationFlowEmpty}
              onLinkAction={stableLinkAction}
              onReviseCollaboration={reviseFailedCollaboration}
              onAuthLogin={authLogin}
              availableSkills={viewModel.composer.availableSkills}
              workspaceAppIcons={workspaceAppIcons}
              previewMode={previewMode}
              labels={conversationFlowLabels}
            />
            {tuttiModePlanPanels.panels.map((panel) => (
              <TuttiModePlanPanel
                key={panel.id}
                assignmentCatalog={tuttiModePlanPanels.assignmentCatalog}
                assignmentDrafts={planAssignmentDrafts[panel.id] ?? {}}
                labels={labels.tuttiModePlanPanel}
                panel={panel}
                submitting={
                  tuttiModePlanPanels.submittingCheckpointId ===
                  panel.checkpoint.id
                }
                onAssignmentDraftChange={(taskId, patch) =>
                  handlePlanAssignmentDraftChange(panel.id, taskId, patch)
                }
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
          isRespondingApproval={viewModel.interaction.isRespondingApproval}
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
          tuttiPlanReview={
            pendingPlanPanel
              ? {
                  planTitle: pendingPlanPanel.title,
                  submitting: pendingPlanSubmitting,
                  intensity: viewModel.composer.tuttiModeOrchestrationIntensity,
                  intensityDiverged: planReviewIntensityDiverged
                }
              : null
          }
          tuttiPlanReviewLabels={labels.tuttiModePlanBanner}
          onCancelTuttiPlanReview={cancelPendingPlan}
          onTuttiPlanReviewIntensityChange={setTuttiModeOrchestrationIntensity}
        />
      ) : null}
    </main>
  );
});
