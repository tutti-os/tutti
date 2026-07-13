import {
  selectLatestActivationForSession,
  selectPendingSubmitsForSession,
  type AgentActivityMessage,
  type EngineQueuedPrompt
} from "@tutti-os/agent-activity-core";
import { useMemo } from "react";
import { mergeWorkspaceAgentMessages } from "../../../host/workspaceAgentSessionMessages";
import { agentPromptContentDisplayText } from "../model/agentComposerDraft";
import { createPendingOptimisticTurnId } from "./agentGuiController.draftMessageHelpers";
import {
  createOptimisticPromptMessage,
  projectAgentGUIMessagesToTimelineItems
} from "./agentGuiController.promptHelpers";

export function useAgentGUIActiveMessages(input: {
  activeConversationId: string | null;
  activePendingActivation: ReturnType<typeof selectLatestActivationForSession>;
  activePendingSubmits: ReturnType<typeof selectPendingSubmitsForSession>;
  activeQueuedPrompts: readonly EngineQueuedPrompt[];
  currentUserId: string | null | undefined;
  storedMessages: readonly AgentActivityMessage[];
  workspaceId: string;
}) {
  const {
    activeConversationId,
    activePendingActivation,
    activePendingSubmits,
    activeQueuedPrompts,
    currentUserId,
    storedMessages,
    workspaceId
  } = input;
  const activeMessages = useMemo(() => {
    if (!activeConversationId) return storedMessages;
    const visibleQueuedSubmitIds = new Set(
      activeQueuedPrompts
        .map((prompt) =>
          "clientSubmitId" in prompt ? prompt.clientSubmitId : undefined
        )
        .filter((value): value is string => Boolean(value))
    );
    const pendingMessages = activePendingSubmits
      .filter(
        (pending) =>
          pending.agentSessionId === activeConversationId &&
          pending.status !== "failed" &&
          !visibleQueuedSubmitIds.has(pending.clientSubmitId)
      )
      .map((pending) =>
        createOptimisticPromptMessage({
          agentSessionId: pending.agentSessionId,
          clientSubmitId: pending.clientSubmitId,
          content: [...pending.content],
          occurredAtUnixMs: pending.requestedAtUnixMs,
          prompt:
            pending.displayPrompt ??
            agentPromptContentDisplayText([...pending.content]),
          turnId:
            pending.turnId ??
            createPendingOptimisticTurnId(pending.clientSubmitId),
          userId: currentUserId?.trim() || "user",
          workspaceId
        })
      );
    const pendingActivationMessage =
      activePendingActivation?.mode === "new" &&
      activePendingActivation.status !== "failed" &&
      activePendingActivation.clientSubmitId &&
      activePendingActivation.content.length > 0
        ? createOptimisticPromptMessage({
            agentSessionId: activePendingActivation.agentSessionId,
            clientSubmitId: activePendingActivation.clientSubmitId,
            content: [...activePendingActivation.content],
            occurredAtUnixMs: activePendingActivation.requestedAtUnixMs,
            prompt: agentPromptContentDisplayText([
              ...activePendingActivation.content
            ]),
            turnId: createPendingOptimisticTurnId(
              activePendingActivation.clientSubmitId
            ),
            userId: currentUserId?.trim() || "user",
            workspaceId
          })
        : null;
    const optimisticMessages = pendingActivationMessage
      ? [...pendingMessages, pendingActivationMessage]
      : pendingMessages;
    return optimisticMessages.length > 0
      ? mergeWorkspaceAgentMessages(storedMessages, optimisticMessages)
      : storedMessages;
  }, [
    activeConversationId,
    activePendingActivation,
    activePendingSubmits,
    activeQueuedPrompts,
    currentUserId,
    storedMessages,
    workspaceId
  ]);
  const activeTimelineItems = useMemo(
    () => projectAgentGUIMessagesToTimelineItems(activeMessages),
    [activeMessages]
  );
  return { activeMessages, activeTimelineItems };
}
