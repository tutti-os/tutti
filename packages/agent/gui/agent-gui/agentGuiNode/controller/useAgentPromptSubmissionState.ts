import { useCallback, useRef, useState } from "react";
import type { AgentGUIConversationListQuery } from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore";
import { getAgentGUIConversationSubmitPending } from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore";
import type { QueuedPromptRetryBlock } from "./agentGuiController.types";
import type { AgentGUIQueuedPromptVM } from "../model/agentGuiNodeTypes";

export function useAgentPromptSubmissionState(input: {
  conversationListQuery: AgentGUIConversationListQuery | null;
  activeConversationId: string | null;
}) {
  const resolvePendingSubmit = useCallback(
    () =>
      input.conversationListQuery
        ? getAgentGUIConversationSubmitPending({
            query: input.conversationListQuery,
            conversationId: input.activeConversationId
          })
        : false,
    [input.activeConversationId, input.conversationListQuery]
  );
  const [localIsSubmitting, setLocalIsSubmitting] = useState(false);
  const [isPendingSubmit, setIsPendingSubmit] = useState(resolvePendingSubmit);
  const isSubmitting = localIsSubmitting || isPendingSubmit;
  const [queuedPromptsBySessionId, setQueuedPromptsBySessionId] = useState<
    Record<string, AgentGUIQueuedPromptVM[]>
  >({});
  const [drainingQueuedPromptSessionId, setDrainingQueuedPromptSessionId] =
    useState<string | null>(null);
  const [
    sendNextQueuedPromptIdBySessionId,
    setSendNextQueuedPromptIdBySessionId
  ] = useState<Record<string, string | null>>({});
  const [failedQueuedPromptIdBySessionId, setFailedQueuedPromptIdBySessionId] =
    useState<Record<string, string | null>>({});
  const [
    queuedPromptRetryBlockBySessionId,
    setQueuedPromptRetryBlockBySessionId
  ] = useState<Record<string, QueuedPromptRetryBlock | null>>({});
  const activePendingPromptRef = useRef<{
    sessionId: string;
    requestId: string;
    kind: string | null;
  } | null>(null);

  return {
    activePendingPromptRef,
    drainingQueuedPromptSessionId,
    failedQueuedPromptIdBySessionId,
    isPendingSubmit,
    isSubmitting,
    localIsSubmitting,
    queuedPromptRetryBlockBySessionId,
    queuedPromptsBySessionId,
    resolvePendingSubmit,
    sendNextQueuedPromptIdBySessionId,
    setDrainingQueuedPromptSessionId,
    setFailedQueuedPromptIdBySessionId,
    setIsPendingSubmit,
    setLocalIsSubmitting,
    setQueuedPromptRetryBlockBySessionId,
    setQueuedPromptsBySessionId,
    setSendNextQueuedPromptIdBySessionId
  };
}
