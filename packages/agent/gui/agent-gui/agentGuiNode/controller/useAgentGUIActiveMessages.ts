import {
  isPendingActivationViable,
  selectLatestActivationForSession,
  selectPendingSubmitsForSession,
  type AgentActivityMessage,
  type EditRetryTailPresentation,
  type EngineQueuedPrompt
} from "@tutti-os/agent-activity-core";
import { useMemo } from "react";
import { mergeWorkspaceAgentMessages } from "../../../host/workspaceAgentSessionMessages";
import { createPendingOptimisticTurnId } from "./agentGuiController.draftMessageHelpers";
import {
  createOptimisticGoalControlMessage,
  createOptimisticPromptMessage,
  projectAgentGUIMessagesToTimelineItems
} from "./agentGuiController.promptHelpers";

export function useAgentGUIActiveMessages(input: {
  activeConversationId: string | null;
  editRetryTail: EditRetryTailPresentation | null;
  activePendingActivation: ReturnType<typeof selectLatestActivationForSession>;
  activePendingSubmits: ReturnType<typeof selectPendingSubmitsForSession>;
  activeQueuedPrompts: readonly EngineQueuedPrompt[];
  currentUserId: string | null | undefined;
  storedMessages: readonly AgentActivityMessage[];
  workspaceId: string;
}) {
  const {
    activeConversationId,
    editRetryTail,
    activePendingActivation,
    activePendingSubmits,
    activeQueuedPrompts,
    currentUserId,
    storedMessages,
    workspaceId
  } = input;
  const activeMessages = useMemo(() => {
    if (!activeConversationId) return storedMessages;
    const durableMessages = editRetryTail
      ? storedMessages.filter(
          (message) => message.turnId?.trim() !== editRetryTail.retractedTurnId
        )
      : storedMessages;
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
          displayPrompt: pending.displayPrompt,
          occurredAtUnixMs: pending.requestedAtUnixMs,
          turnId:
            pending.turnId ??
            createPendingOptimisticTurnId(pending.clientSubmitId),
          userId: currentUserId?.trim() || "user",
          workspaceId
        })
      );
    const pendingActivationMessage =
      activePendingActivation?.mode === "new" &&
      isPendingActivationViable(activePendingActivation) &&
      !activePendingActivation.initialPromptRetracted &&
      activePendingActivation.clientSubmitId &&
      activePendingActivation.content.length > 0
        ? activePendingActivation.initialGoalControl
          ? createOptimisticGoalControlMessage({
              agentSessionId: activePendingActivation.agentSessionId,
              clientSubmitId: activePendingActivation.clientSubmitId,
              content: [...activePendingActivation.content],
              displayPrompt: activePendingActivation.displayPrompt,
              goalControl: activePendingActivation.initialGoalControl,
              occurredAtUnixMs: activePendingActivation.requestedAtUnixMs,
              turnId: createPendingOptimisticTurnId(
                activePendingActivation.clientSubmitId
              ),
              userId: currentUserId?.trim() || "user",
              workspaceId
            })
          : createOptimisticPromptMessage({
              agentSessionId: activePendingActivation.agentSessionId,
              clientSubmitId: activePendingActivation.clientSubmitId,
              content: [...activePendingActivation.content],
              displayPrompt: activePendingActivation.displayPrompt,
              occurredAtUnixMs: activePendingActivation.requestedAtUnixMs,
              turnId: createPendingOptimisticTurnId(
                activePendingActivation.clientSubmitId
              ),
              userId: currentUserId?.trim() || "user",
              workspaceId
            })
        : null;
    const replacementClientSubmitId = editRetryTail
      ? `edit-retry:${editRetryTail.operationId ?? editRetryTail.clientOperationId}`
      : null;
    const replacementAlreadyDurable = replacementClientSubmitId
      ? durableMessages.some(
          (message) =>
            message.payload?.clientSubmitId === replacementClientSubmitId ||
            (editRetryTail?.replacementTurnId !== null &&
              message.turnId === editRetryTail?.replacementTurnId)
        )
      : false;
    const latestOccurredAtUnixMs = durableMessages.reduce(
      (latest, message) => Math.max(latest, message.occurredAtUnixMs),
      0
    );
    const replacementMessage =
      editRetryTail && replacementClientSubmitId && !replacementAlreadyDurable
        ? createOptimisticPromptMessage({
            agentSessionId: activeConversationId,
            clientSubmitId: replacementClientSubmitId,
            content: [{ type: "text", text: editRetryTail.editedText }],
            occurredAtUnixMs: latestOccurredAtUnixMs + 1,
            turnId:
              editRetryTail.replacementTurnId ??
              createPendingOptimisticTurnId(replacementClientSubmitId),
            userId: currentUserId?.trim() || "user",
            workspaceId
          })
        : null;
    const optimisticMessages = pendingActivationMessage
      ? [...pendingMessages, pendingActivationMessage]
      : pendingMessages;
    const mergedOptimisticMessages = replacementMessage
      ? [...optimisticMessages, replacementMessage]
      : optimisticMessages;
    return mergedOptimisticMessages.length > 0
      ? mergeWorkspaceAgentMessages(durableMessages, mergedOptimisticMessages)
      : durableMessages;
  }, [
    activeConversationId,
    editRetryTail,
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
