import { useMemo } from "react";
import type { AgentGUINodeViewModel } from "./agentGuiNodeTypes";

export function useAgentGUIViewModel(
  candidate: AgentGUINodeViewModel
): AgentGUINodeViewModel {
  const shell = useMemo(
    () => candidate.shell,
    [
      candidate.shell.currentUserId,
      candidate.shell.data,
      candidate.shell.nodeId,
      candidate.shell.workspaceId,
      candidate.shell.workspacePath
    ]
  );
  const rail = useMemo(
    () => candidate.rail,
    [
      candidate.rail.activeConversation,
      candidate.rail.activeConversationId,
      candidate.rail.comingSoonProviders,
      candidate.rail.conversationFilter,
      candidate.rail.conversations,
      candidate.rail.isLoadingConversations,
      candidate.rail.listError,
      candidate.rail.providerRailMode,
      candidate.rail.revealRequest,
      candidate.rail.agentTargets,
      candidate.rail.agentTargetsLoading,
      candidate.rail.selectedAgentTarget,
      candidate.rail.userProjects
    ]
  );
  const detail = useMemo(
    () => candidate.detail,
    [
      candidate.detail.availability,
      candidate.detail.avoidGroupingEdits,
      candidate.detail.conversation,
      candidate.detail.conversationDetail,
      candidate.detail.hasOlderMessages,
      candidate.detail.hasSentUserMessage,
      candidate.detail.isLoadingMessages,
      candidate.detail.isLoadingOlderMessages,
      candidate.detail.usage
    ]
  );
  const composer = useMemo(
    () => candidate.composer,
    [
      candidate.composer.availableCommands,
      candidate.composer.availableSkills,
      candidate.composer.canQueueWhileBusy,
      candidate.composer.canSubmit,
      candidate.composer.compactSupported,
      candidate.composer.composerSettings,
      candidate.composer.draftContent,
      candidate.composer.draftPrompt,
      candidate.composer.drainingQueuedPromptId,
      candidate.composer.goalPauseSupported,
      candidate.composer.handoffAgentTargets,
      candidate.composer.isCancelPending,
      candidate.composer.isCreatingConversation,
      candidate.composer.isInterrupting,
      candidate.composer.isSubmitting,
      candidate.composer.isTuttiModeActive,
      candidate.composer.isTuttiModeUpdating,
      candidate.composer.promptImagesSupported,
      candidate.composer.queueStatus,
      candidate.composer.queuedPrompts,
      candidate.composer.tuttiModeOrchestrationIntensity,
      candidate.composer.tuttiModeUpdateStatus
    ]
  );
  const interaction = useMemo(
    () => candidate.interaction,
    [
      candidate.interaction.inlineNotice,
      candidate.interaction.isRuntimeBlocked,
      candidate.interaction.isRespondingApproval,
      candidate.interaction.pendingApproval,
      candidate.interaction.pendingInteractivePrompt,
      candidate.interaction.sessionChrome
    ]
  );
  const readiness = useMemo(
    () => candidate.readiness,
    [
      candidate.readiness.activationError,
      candidate.readiness.activeConversationBusy,
      candidate.readiness.activeLiveState,
      candidate.readiness.providerReadinessGate,
      candidate.readiness.sessionRuntimeBlocked,
      candidate.readiness.sessionRuntimeBlockedReason
    ]
  );
  const operations = useMemo(
    () => candidate.operations,
    [
      candidate.operations.goalClearNoticeSequence,
      candidate.operations.isDeletingConversation,
      candidate.operations.isDeletingProjectConversations,
      candidate.operations.isUserProjectMutationPending,
      candidate.operations.pendingDeleteConversation,
      candidate.operations.pendingDeleteProjectConversations
    ]
  );

  return useMemo(
    () => ({
      shell,
      rail,
      detail,
      composer,
      interaction,
      readiness,
      operations
    }),
    [composer, detail, interaction, operations, rail, readiness, shell]
  );
}
