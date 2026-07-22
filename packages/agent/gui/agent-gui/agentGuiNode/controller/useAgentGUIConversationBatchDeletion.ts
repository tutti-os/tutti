import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from "react";
import { flushSync } from "react-dom";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { useAgentHostApi } from "../../../agentActivityHost";
import type { AgentSessionViewRef } from "../../../contexts/workspace/presentation/renderer/agentSessions/useAgentSessionTransport";
import type { AgentGUINodeData } from "../../../types";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type {
  AgentComposerDraft,
  SubmittedDraftSnapshot
} from "../model/agentGuiNodeTypes";
import { resolveAgentComposerDraftScopeKey } from "../model/agentComposerDraftScope";
import { deleteSubmittedDraftSnapshotsForScopes } from "./agentGuiController.draftMessageHelpers";
import { getAgentGUIErrorMessage } from "./agentGuiController.errors";
import { omitConversationLocalState } from "./agentGuiController.interactiveHelpers";
import {
  reportAgentGUIRuntimeError,
  showAgentGUIControllerErrorToast
} from "./agentGuiController.reporting";
import { type ConversationIntent } from "./useAgentConversationSelection";

export interface UseAgentGUIConversationBatchDeletionInput {
  isDeletingProjectConversations: boolean;
  conversationsRef: RefObject<AgentGUIConversationSummary[]>;
  setDetailError: Dispatch<SetStateAction<string | null>>;
  setListError: Dispatch<SetStateAction<string | null>>;
  deleteAgentSessionView: (ref: AgentSessionViewRef) => void;
  sessionViewRef: (agentSessionId: string | null | undefined) => {
    workspaceId: string;
    agentSessionId: string | null | undefined;
    origin: string;
  };
  setDraftByScopeKey: Dispatch<
    SetStateAction<Record<string, AgentComposerDraft>>
  >;
  submittedDraftSnapshotsRef: RefObject<Record<string, SubmittedDraftSnapshot>>;
  activeConversationIdRef: RefObject<string | null>;
  markSelectedConversationDetailPending: (
    agentSessionId: string
  ) => string | null;
  setIntent: Dispatch<SetStateAction<ConversationIntent>>;
  setIsLoadingMessages: Dispatch<SetStateAction<boolean>>;
  setActiveConversationId: Dispatch<SetStateAction<string | null>>;
  persistActiveConversation: (agentSessionId: string | null) => void;
  removeConversations: (agentSessionIds: readonly string[]) => void;
  workspaceId: string;
  setIsDeletingProjectConversations: Dispatch<SetStateAction<boolean>>;
  agentActivityRuntime: AgentActivityRuntime;
  dataRef: RefObject<AgentGUINodeData>;
  agentHostApi: ReturnType<typeof useAgentHostApi>;
}

export function useAgentGUIConversationBatchDeletion(
  input: UseAgentGUIConversationBatchDeletionInput
) {
  const {
    isDeletingProjectConversations,
    conversationsRef,
    setDetailError,
    setListError,
    deleteAgentSessionView,
    sessionViewRef,
    setDraftByScopeKey,
    submittedDraftSnapshotsRef,
    activeConversationIdRef,
    markSelectedConversationDetailPending,
    setIntent,
    setIsLoadingMessages,
    setActiveConversationId,
    persistActiveConversation,
    removeConversations,
    workspaceId,
    setIsDeletingProjectConversations,
    agentActivityRuntime,
    dataRef,
    agentHostApi
  } = input;

  const finalizeConversationBatchDeletion = useCallback(
    (targetIds: Set<string>) => {
      for (const id of targetIds) {
        deleteAgentSessionView(sessionViewRef(id));
      }
      const deletedScopeKeys = new Set(
        [...targetIds].map((agentSessionId) =>
          resolveAgentComposerDraftScopeKey({ agentSessionId })
        )
      );
      setDraftByScopeKey((current) =>
        omitConversationLocalState(current, deletedScopeKeys)
      );
      deleteSubmittedDraftSnapshotsForScopes({
        snapshots: submittedDraftSnapshotsRef.current,
        scopeKeys: deletedScopeKeys,
        targetAgentSessionIds: targetIds
      });
    },
    [
      deleteAgentSessionView,
      sessionViewRef,
      setDraftByScopeKey,
      submittedDraftSnapshotsRef
    ]
  );

  const confirmDeleteProjectConversations = useCallback(
    async (
      sectionKey?: string,
      agentTargetId?: string | null
    ): Promise<string[]> => {
      const normalizedSectionKey = sectionKey?.trim() ?? "";
      const listDeletionCandidates =
        agentActivityRuntime.listSessionSectionDeletionCandidates;
      if (
        !normalizedSectionKey ||
        isDeletingProjectConversations ||
        !listDeletionCandidates
      ) {
        return [];
      }
      setDetailError(null);
      setListError(null);
      try {
        const candidates = await listDeletionCandidates({
          agentTargetId: agentTargetId?.trim() || undefined,
          excludePinned: true,
          sectionKey: normalizedSectionKey,
          workspaceId
        });
        const sessionIds = candidates.sessionIds
          .map((id) => id.trim())
          .filter(Boolean);
        if (sessionIds.length === 0) {
          void agentActivityRuntime.load(workspaceId).catch(() => undefined);
        }
        return [...new Set(sessionIds)];
      } catch (error) {
        const message = getAgentGUIErrorMessage(error);
        reportAgentGUIRuntimeError({
          error,
          phase: "delete_conversation",
          provider: dataRef.current.provider,
          runtime: agentActivityRuntime,
          workspaceId,
          context: { sectionKey: normalizedSectionKey }
        });
        setListError(message);
        showAgentGUIControllerErrorToast(agentHostApi.toast, message);
        return [];
      }
    },
    [
      agentActivityRuntime,
      isDeletingProjectConversations,
      agentHostApi.toast,
      workspaceId
    ]
  );

  const confirmDeleteConversations = useCallback(
    (agentSessionIds: string[]) => {
      if (isDeletingProjectConversations) {
        return;
      }
      const targetIds = new Set(
        agentSessionIds.map((id) => id.trim()).filter((id) => id !== "")
      );
      const deleteSessionsBatch = agentActivityRuntime.deleteSessionsBatch;
      if (targetIds.size === 0 || !deleteSessionsBatch) {
        return;
      }
      setIsDeletingProjectConversations(true);
      setDetailError(null);
      setListError(null);
      const activeDeletedConversationId = activeConversationIdRef.current;
      if (
        activeDeletedConversationId &&
        targetIds.has(activeDeletedConversationId)
      ) {
        const nextActive =
          conversationsRef.current.find(
            (conversation) => !targetIds.has(conversation.id)
          )?.id ?? null;
        if (nextActive) {
          markSelectedConversationDetailPending(nextActive);
        }
        activeConversationIdRef.current = nextActive;
        flushSync(() => {
          if (nextActive) {
            setIntent({ tag: "active", id: nextActive });
          } else {
            setIsLoadingMessages(false);
            setIntent({ tag: "home" });
          }
          setActiveConversationId(nextActive);
        });
        persistActiveConversation(nextActive);
      }
      void deleteSessionsBatch({
        sessionIds: [...targetIds],
        workspaceId
      })
        .then((result) => {
          if (result.cleanupFailedSessionIds.length > 0) {
            try {
              void Promise.resolve(
                agentActivityRuntime.reportDiagnostic?.({
                  details: {
                    cleanupFailedSessionIds: result.cleanupFailedSessionIds
                  },
                  event: "agent.gui.conversation_delete.cleanup_failed",
                  level: "warn",
                  source: "agent-gui",
                  workspaceId
                })
              ).catch((error) => {
                console.error(
                  "[agent-gui-cleanup-diagnostic]",
                  JSON.stringify({
                    error: getAgentGUIErrorMessage(error),
                    workspaceId
                  })
                );
              });
            } catch (error) {
              console.error(
                "[agent-gui-cleanup-diagnostic]",
                JSON.stringify({
                  error: getAgentGUIErrorMessage(error),
                  workspaceId
                })
              );
            }
          }
          const removedIds = new Set([
            ...targetIds,
            ...result.removedSessionIds
          ]);
          removeConversations([...removedIds]);
          finalizeConversationBatchDeletion(removedIds);
        })
        .catch((error) => {
          const message = getAgentGUIErrorMessage(error);
          reportAgentGUIRuntimeError({
            error,
            phase: "delete_conversation",
            provider: dataRef.current.provider,
            runtime: agentActivityRuntime,
            workspaceId,
            context: {
              conversationCount: targetIds.size
            }
          });
          setListError(message);
          showAgentGUIControllerErrorToast(agentHostApi.toast, message);
        })
        .finally(() => {
          setIsDeletingProjectConversations(false);
        });
    },
    [
      activeConversationIdRef,
      agentActivityRuntime,
      agentHostApi.toast,
      conversationsRef,
      dataRef,
      finalizeConversationBatchDeletion,
      isDeletingProjectConversations,
      markSelectedConversationDetailPending,
      persistActiveConversation,
      removeConversations,
      setActiveConversationId,
      setDetailError,
      setIntent,
      setIsDeletingProjectConversations,
      setIsLoadingMessages,
      setListError,
      workspaceId
    ]
  );

  return {
    confirmDeleteProjectConversations,
    confirmDeleteConversations
  };
}
