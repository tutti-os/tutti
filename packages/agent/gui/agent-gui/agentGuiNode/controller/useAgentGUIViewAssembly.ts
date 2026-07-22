import { useMemo } from "react";
import { useAgentGUIViewModel } from "../model/useAgentGUIViewModel";
import type { AgentGUIProviderRailMode } from "../../../types";
import type { AgentGUIDetailViewModel } from "../model/agentGuiNodeTypes";
import { useAgentGUIComposerPresentation } from "./useAgentGUIComposerPresentation";
import { useAgentGUIControllerActions } from "./useAgentGUIControllerActions";
import { useAgentGUIConversationDetail } from "./useAgentGUIConversationDetail";
import { useAgentGUIConversationPresentation } from "./useAgentGUIConversationPresentation";
import { useAgentGUIProviderHome } from "./useAgentGUIProviderHome";
import { useAgentGUISessionPresentation } from "./useAgentGUISessionPresentation";
import type { useAgentGUIOperationActions } from "./useAgentGUIOperationActions";
import type { useAgentGUIProviderCatalogSelection } from "./useAgentGUIProviderCatalogSelection";
import type { useAgentGUILocalState } from "./useAgentGUILocalState";
import type { useAgentGUIComposerCapabilities } from "./useAgentGUIComposerCapabilities";
import type { useAgentGUISessionDetailTransport } from "./useAgentGUISessionDetailTransport";
import { resolveAgentGUIProviderReadinessGateForView } from "../model/agentGuiProviderReadiness";
import type { useAgentGUITuttiModeActivation } from "./useAgentGUITuttiModeActivation";
import { ownerDeviceLabelForConversation } from "./agentGuiController.providerHelpers";

type ConversationPresentationInput = Parameters<
  typeof useAgentGUIConversationPresentation
>[0];
type ConversationDetailInput = Omit<
  Parameters<typeof useAgentGUIConversationDetail>[0],
  "activeConversation" | "activeSessionView"
>;
type ActiveSessionViewProjection = Parameters<
  typeof useAgentGUIConversationDetail
>[0]["activeSessionView"];
type ComposerPresentationInput = Omit<
  Parameters<typeof useAgentGUIComposerPresentation>[0],
  "activeConversation"
>;
type SessionPresentationInput = Omit<
  Parameters<typeof useAgentGUISessionPresentation>[0],
  | "activeConversation"
  | "activeLiveState"
  | "activationError"
  | "activationErrorCode"
  | "conversation"
  | "isInterrupting"
  | "pendingApproval"
  | "serverInteractivePrompt"
>;
type ProviderHomeInput = Parameters<typeof useAgentGUIProviderHome>[0];
type OperationActions = ReturnType<typeof useAgentGUIOperationActions>;
type ProviderCatalog = ReturnType<typeof useAgentGUIProviderCatalogSelection>;
type LocalState = ReturnType<typeof useAgentGUILocalState>;
type ComposerCapabilities = ReturnType<typeof useAgentGUIComposerCapabilities>;
type SessionDetailTransport = ReturnType<
  typeof useAgentGUISessionDetailTransport
>;

type UseAgentGUIViewAssemblyInput = ConversationPresentationInput &
  ConversationDetailInput &
  ComposerPresentationInput &
  SessionPresentationInput &
  ProviderHomeInput &
  ProviderCatalog &
  LocalState &
  ComposerCapabilities &
  SessionDetailTransport &
  OperationActions & {
    nodeId?: string | null;
    operationActions: OperationActions;
    detailAvailability: AgentGUIDetailViewModel["availability"];
    updateSelectedProjectPath: Parameters<
      typeof useAgentGUIControllerActions
    >[0]["updateSelectedProjectPath"];
    selectConversation: Parameters<
      typeof useAgentGUIControllerActions
    >[0]["selectConversation"];
    providerRailMode: AgentGUIProviderRailMode | undefined;
    tuttiModeActivation: ReturnType<typeof useAgentGUITuttiModeActivation>;
  };

export function useAgentGUIViewAssembly(input: UseAgentGUIViewAssemblyInput) {
  const { activeConversation, visibleConversations } =
    useAgentGUIConversationPresentation(input);
  const activeConversationOwnerDeviceLabel = useMemo(
    () =>
      ownerDeviceLabelForConversation(
        activeConversation,
        input.normalizedProviderTargets
      ),
    [activeConversation?.agentTargetId, input.normalizedProviderTargets]
  );
  const stableActiveSessionViewProjection =
    useMemo<ActiveSessionViewProjection>(
      () =>
        input.activeSessionView
          ? {
              hasOlderMessages: input.activeSessionView.hasOlderMessages,
              isLoadingOlderMessages:
                input.activeSessionView.isLoadingOlderMessages,
              olderMessageCount: input.activeSessionView.olderMessages.length,
              oldestLoadedVersion: input.activeSessionView.oldestLoadedVersion
            }
          : null,
      [
        input.activeSessionView?.hasOlderMessages,
        input.activeSessionView?.isLoadingOlderMessages,
        input.activeSessionView?.olderMessages.length,
        input.activeSessionView?.oldestLoadedVersion
      ]
    );
  const detail = useAgentGUIConversationDetail({
    ...input,
    activeConversation,
    activeSessionView: stableActiveSessionViewProjection
  });
  const { stableComposerSettings } = useAgentGUIComposerPresentation({
    ...input,
    activeConversation
  });
  const session = useAgentGUISessionPresentation({
    ...input,
    activeConversation,
    ownerDeviceLabel: activeConversationOwnerDeviceLabel,
    activeLiveState: detail.activeLiveState,
    activationError: detail.activationError,
    activationErrorCode: detail.activationErrorCode,
    conversation: detail.conversation,
    isInterrupting: detail.isInterrupting,
    pendingApproval: detail.pendingApproval,
    serverInteractivePrompt: detail.serverInteractivePrompt
  });
  const providerHome = useAgentGUIProviderHome(input);
  const controllerActions = useAgentGUIControllerActions({
    ...input.operationActions,
    ...providerHome,
    loadOlderConversationMessages: input.loadOlderConversationMessages,
    selectConversation: input.selectConversation,
    setTuttiModeActive: input.tuttiModeActivation.setActive,
    setTuttiModeOrchestrationIntensity:
      input.tuttiModeActivation.setOrchestrationIntensity,
    retryTuttiModeActivation: input.tuttiModeActivation.retry,
    updateSelectedProjectPath: input.updateSelectedProjectPath
  });
  const viewData =
    input.activeConversationId === null
      ? input.selectedComposerTargetData.data
      : input.data;
  const providerReadinessGate = resolveAgentGUIProviderReadinessGateForView({
    activeConversationId: input.activeConversationId,
    providerReadinessGates: input.providerReadinessGates,
    selectedProvider: input.effectiveSelectedProviderTarget.provider
  });
  const viewModel = useAgentGUIViewModel({
    shell: {
      nodeId: input.nodeId?.trim() || null,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      currentUserId: input.currentUserId,
      data: viewData
    },
    rail: {
      selectedAgentTarget: input.effectiveSelectedProviderTarget,
      agentTargets: input.normalizedProviderTargets,
      agentTargetsLoading: input.agentTargetsLoading,
      providerRailMode: input.providerRailMode ?? "catalog",
      comingSoonProviders: input.normalizedComingSoonProviders,
      conversationFilter: input.conversationFilter,
      conversations: visibleConversations,
      userProjects: input.userProjects,
      activeConversation,
      activeConversationId: input.activeConversationId,
      revealRequest: input.railRevealRequest,
      isLoadingConversations: input.isLoadingConversations,
      listError: input.listError
    },
    detail: {
      availability: input.detailAvailability,
      isLoadingMessages: input.isLoadingMessages,
      isLoadingOlderMessages:
        input.activeSessionView?.isLoadingOlderMessages ?? false,
      hasOlderMessages: input.activeSessionView?.hasOlderMessages ?? false,
      usage: input.usage,
      hasSentUserMessage: session.hasSentUserMessage,
      avoidGroupingEdits: input.avoidGroupingEdits,
      conversation: detail.conversation,
      conversationDetail: detail.conversationDetail
    },
    composer: {
      handoffAgentTargets: input.handoffAgentTargets,
      availableCommands: detail.availableCommands,
      availableSkills: detail.availableSkills,
      draftPrompt: detail.draftPrompt,
      draftContent: detail.draftContent,
      isCreatingConversation: input.isCreatingConversation,
      isSubmitting: input.isSubmitting,
      isInterrupting: detail.isInterrupting,
      isCancelPending: detail.isCancelPending,
      promptImagesSupported: input.promptImagesSupported,
      compactSupported: input.compactSupported,
      goalPauseSupported: input.goalPauseSupported,
      canSubmit: session.canSubmit,
      isTuttiModeActive: input.tuttiModeActivation.active,
      isTuttiModeUpdating: input.tuttiModeActivation.updatePending,
      tuttiModeOrchestrationIntensity:
        input.tuttiModeActivation.orchestrationIntensity,
      tuttiModeUpdateStatus: input.tuttiModeActivation.updateStatus,
      composerSettings: stableComposerSettings,
      queueStatus: detail.queueStatus,
      queuedPrompts: detail.queuedPrompts,
      drainingQueuedPromptId: detail.drainingQueuedPromptId,
      canQueueWhileBusy: session.canQueueWhileBusy
    },
    interaction: {
      isRespondingApproval: session.isRespondingApproval,
      isRuntimeBlocked: session.sessionRuntimeBlocked,
      pendingApproval: detail.pendingApproval,
      pendingInteractivePrompt: session.pendingInteractivePrompt,
      sessionChrome: session.sessionChrome,
      inlineNotice: detail.effectiveDetailError
        ? {
            id: `agent-gui-detail-error:${input.activeConversationId ?? "current"}`,
            message: detail.effectiveDetailError,
            tone: "error" as const,
            autoDismissMs: null
          }
        : null
    },
    readiness: {
      activeLiveState: detail.activeLiveState,
      activationError: detail.activationError,
      activeConversationBusy: session.activeConversationBusy,
      sessionRuntimeBlocked: session.sessionRuntimeBlocked,
      providerReadinessGate
    },
    operations: {
      goalClearNoticeSequence: input.goalClearNoticeSequence,
      isDeletingConversation: input.isDeletingConversation,
      isDeletingProjectConversations: input.isDeletingProjectConversations,
      isUserProjectMutationPending: input.isUserProjectMutationPending,
      pendingDeleteConversation: input.pendingDeleteConversation,
      pendingDeleteProjectConversations: input.pendingDeleteProjectConversations
    }
  });
  return useMemo(
    () => ({ viewModel, actions: controllerActions }),
    [controllerActions, viewModel]
  );
}
