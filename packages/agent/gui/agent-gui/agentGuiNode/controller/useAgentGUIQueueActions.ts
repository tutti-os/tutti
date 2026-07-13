import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from "react";
import {
  selectEngineQueuedPrompt,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import { agentPromptContentToComposerDraft } from "../model/agentComposerDraft";
import { createAgentGUIConversationId } from "./agentGuiController.promptHelpers";

export interface UseAgentGUIQueueActionsInput {
  activeConversationIdRef: RefObject<string | null>;
  previewMode: boolean;
  sessionEngine: AgentSessionEngine;
  setDraftBySessionId: Dispatch<
    SetStateAction<Record<string, AgentComposerDraft>>
  >;
}

/** Owns queued-prompt mutations without coupling them to session activation. */
export function useAgentGUIQueueActions({
  activeConversationIdRef,
  previewMode,
  sessionEngine,
  setDraftBySessionId
}: UseAgentGUIQueueActionsInput) {
  const removeQueuedPrompt = useCallback(
    (queuedPromptId: string) => {
      if (previewMode) {
        return;
      }
      const agentSessionId = activeConversationIdRef.current;
      const normalizedQueuedPromptId = queuedPromptId.trim();
      if (!agentSessionId || !normalizedQueuedPromptId) {
        return;
      }
      const queuedPrompt = selectEngineQueuedPrompt(
        sessionEngine.getSnapshot(),
        agentSessionId,
        normalizedQueuedPromptId
      );
      sessionEngine.dispatch(
        queuedPrompt?.clientSubmitId
          ? {
              agentSessionId,
              clientSubmitId: queuedPrompt.clientSubmitId,
              type: "submit/canceled"
            }
          : {
              agentSessionId,
              promptId: normalizedQueuedPromptId,
              type: "queue/removed"
            }
      );
    },
    [activeConversationIdRef, previewMode, sessionEngine]
  );

  const editQueuedPrompt = useCallback(
    (queuedPromptId: string) => {
      const agentSessionId = activeConversationIdRef.current;
      const normalizedQueuedPromptId = queuedPromptId.trim();
      if (previewMode || !agentSessionId || !normalizedQueuedPromptId) {
        return;
      }
      const queuedPrompt = selectEngineQueuedPrompt(
        sessionEngine.getSnapshot(),
        agentSessionId,
        normalizedQueuedPromptId
      );
      if (!queuedPrompt) {
        return;
      }
      sessionEngine.dispatch(
        queuedPrompt.clientSubmitId
          ? {
              agentSessionId,
              clientSubmitId: queuedPrompt.clientSubmitId,
              type: "submit/canceled"
            }
          : {
              agentSessionId,
              promptId: normalizedQueuedPromptId,
              type: "queue/removed"
            }
      );
      setDraftBySessionId((current) => ({
        ...current,
        [agentSessionId]: agentPromptContentToComposerDraft(
          queuedPrompt.content,
          `restore-${queuedPrompt.id}`
        )
      }));
    },
    [activeConversationIdRef, previewMode, sessionEngine, setDraftBySessionId]
  );

  const sendQueuedPromptNext = useCallback(
    (queuedPromptId: string) => {
      const agentSessionId = activeConversationIdRef.current;
      const normalizedQueuedPromptId = queuedPromptId.trim();
      if (previewMode || !agentSessionId || !normalizedQueuedPromptId) {
        return;
      }
      sessionEngine.dispatch({
        agentSessionId,
        awaitingTurnExpiresAtUnixMs: Date.now() + 30_000,
        cancelCommandId: createAgentGUIConversationId(),
        promptId: normalizedQueuedPromptId,
        timeoutMs: 30_000,
        type: "queue/promoted"
      });
    },
    [activeConversationIdRef, previewMode, sessionEngine]
  );

  return {
    editQueuedPrompt,
    removeQueuedPrompt,
    sendQueuedPromptNext
  };
}
