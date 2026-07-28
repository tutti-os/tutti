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
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import {
  agentComposerDraftImages,
  agentPromptContentToComposerDraft,
  updateAgentComposerDraft
} from "../model/agentComposerDraft";
import { resolveAgentComposerDraftScopeKey } from "../model/agentComposerDraftScope";
import { QueuedPromptImageLoadOwner } from "../queuedPromptImageLoadOwner";
import { createAgentGUIConversationId } from "./agentGuiController.promptHelpers";

export interface UseAgentGUIQueueActionsInput {
  activeConversationIdRef: RefObject<string | null>;
  agentActivityRuntime: AgentActivityRuntime;
  sessionEngine: AgentSessionEngine;
  setDraftByScopeKey: Dispatch<
    SetStateAction<Record<string, AgentComposerDraft>>
  >;
  workspaceId: string;
}

/** Owns queued-prompt mutations without coupling them to session activation. */
export function useAgentGUIQueueActions({
  activeConversationIdRef,
  agentActivityRuntime,
  sessionEngine,
  setDraftByScopeKey,
  workspaceId
}: UseAgentGUIQueueActionsInput) {
  const removeQueuedPrompt = useCallback(
    (queuedPromptId: string) => {
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
    [activeConversationIdRef, sessionEngine]
  );

  const editQueuedPrompt = useCallback(
    (queuedPromptId: string) => {
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
      if (!queuedPrompt) {
        return;
      }
      const draftScopeKey = resolveAgentComposerDraftScopeKey({
        agentSessionId
      });
      const restoredDraft = agentPromptContentToComposerDraft(
        queuedPrompt.content,
        `restore-${queuedPrompt.id}`
      );
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
      setDraftByScopeKey((current) => ({
        ...current,
        [draftScopeKey]: restoredDraft
      }));
      for (const restoredImage of agentComposerDraftImages(restoredDraft)) {
        const attachmentId = restoredImage.attachmentId?.trim() ?? "";
        const path = restoredImage.path?.trim() ?? "";
        if (restoredImage.previewUrl || (!attachmentId && !path)) {
          continue;
        }
        const owner = new QueuedPromptImageLoadOwner(
          {
            agentSessionId,
            attachmentId,
            imageKey: restoredImage.id,
            mimeType: restoredImage.mimeType,
            name: restoredImage.name,
            path,
            remoteUrl: restoredImage.url?.trim() ?? "",
            runtime: agentActivityRuntime,
            workspaceId
          },
          (source) => {
            if (!source) {
              return;
            }
            setDraftByScopeKey((current) => {
              const currentDraft = current[draftScopeKey];
              if (!currentDraft) {
                return current;
              }
              let updated = false;
              const images = agentComposerDraftImages(currentDraft).map(
                (currentImage) => {
                  if (
                    currentImage.id !== restoredImage.id ||
                    currentImage.previewUrl ||
                    currentImage.attachmentId !== restoredImage.attachmentId ||
                    currentImage.path !== restoredImage.path ||
                    currentImage.url !== restoredImage.url
                  ) {
                    return currentImage;
                  }
                  updated = true;
                  return { ...currentImage, previewUrl: source };
                }
              );
              return updated
                ? {
                    ...current,
                    [draftScopeKey]: updateAgentComposerDraft(currentDraft, {
                      images
                    })
                  }
                : current;
            });
          }
        );
        owner.start();
      }
    },
    [
      activeConversationIdRef,
      agentActivityRuntime,
      sessionEngine,
      setDraftByScopeKey,
      workspaceId
    ]
  );

  const sendQueuedPromptNext = useCallback(
    (queuedPromptId: string) => {
      const agentSessionId = activeConversationIdRef.current;
      const normalizedQueuedPromptId = queuedPromptId.trim();
      if (!agentSessionId || !normalizedQueuedPromptId) {
        return;
      }
      sessionEngine.dispatch({
        agentSessionId,
        awaitingTurnExpiresAtUnixMs: Date.now() + 30_000,
        cancelCommandId: createAgentGUIConversationId(),
        promptId: normalizedQueuedPromptId,
        timeoutMs: 30_000,
        type: "queue/sendNowRequested"
      });
    },
    [activeConversationIdRef, sessionEngine]
  );

  return {
    editQueuedPrompt,
    removeQueuedPrompt,
    sendQueuedPromptNext
  };
}
