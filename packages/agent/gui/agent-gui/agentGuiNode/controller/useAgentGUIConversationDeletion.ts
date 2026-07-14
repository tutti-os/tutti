import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from "react";
import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { useAgentHostApi } from "../../../agentActivityHost";
import type { AgentSessionViewRef } from "../../../contexts/workspace/presentation/renderer/agentSessions/useAgentSessionTransport";
import type { useAgentGUIActivation } from "./useAgentGUIActivation";
import { type AgentGUIConversationListQuery } from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/useAgentGuiConversationList";
import { type AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type {
  AgentComposerDraft,
  SubmittedDraftSnapshot
} from "../model/agentGuiNodeTypes";
import { resolveAgentComposerDraftScopeKey } from "../model/agentComposerDraftScope";
import { deleteSubmittedDraftSnapshotsForScopes } from "./agentGuiController.draftMessageHelpers";
import { getAgentGUIErrorMessage } from "./agentGuiController.errors";
import {
  reportAgentGUIRuntimeError,
  showAgentGUIControllerErrorToast
} from "./agentGuiController.reporting";
import { type ConversationIntent } from "./useAgentConversationSelection";

export interface UseAgentGUIConversationDeletionInput {
  isDeletingConversation: boolean;
  conversations: AgentGUIConversationSummary[];
  setPendingDeleteConversation: Dispatch<
    SetStateAction<AgentGUIConversationSummary | null>
  >;
  setDetailError: Dispatch<SetStateAction<string | null>>;
  pendingDeleteConversation: AgentGUIConversationSummary | null;
  setIsDeletingConversation: Dispatch<SetStateAction<boolean>>;
  activeConversationIdRef: RefObject<string | null>;
  setIsLoadingMessages: Dispatch<SetStateAction<boolean>>;
  setAgentSessionViewMessagesLoading: (
    ref: AgentSessionViewRef,
    value: boolean
  ) => void;
  sessionViewRef: (agentSessionId: string | null | undefined) => {
    workspaceId: string;
    agentSessionId: string | null | undefined;
    origin: string;
  };
  activation: ReturnType<typeof useAgentGUIActivation>;
  agentActivityRuntime: AgentActivityRuntime;
  setDraftByScopeKey: Dispatch<
    SetStateAction<Record<string, AgentComposerDraft>>
  >;
  submittedDraftSnapshotsRef: RefObject<Record<string, SubmittedDraftSnapshot>>;
  sessionEngine: AgentSessionEngine;
  deleteAgentSessionView: (ref: AgentSessionViewRef) => void;
  conversationsRef: RefObject<AgentGUIConversationSummary[]>;
  markSelectedConversationDetailPending: (
    agentSessionId: string
  ) => string | null;
  setIntent: Dispatch<SetStateAction<ConversationIntent>>;
  setActiveConversationId: Dispatch<SetStateAction<string | null>>;
  persistActiveConversation: (agentSessionId: string | null) => void;
  removeConversations: (conversationIds: readonly string[]) => void;
  agentHostApi: ReturnType<typeof useAgentHostApi>;
  conversationListQuery: AgentGUIConversationListQuery | null;
  workspaceId: string;
}

export function useAgentGUIConversationDeletion(
  input: UseAgentGUIConversationDeletionInput
) {
  const {
    isDeletingConversation,
    conversations,
    setPendingDeleteConversation,
    setDetailError,
    pendingDeleteConversation,
    setIsDeletingConversation,
    activeConversationIdRef,
    setIsLoadingMessages,
    setAgentSessionViewMessagesLoading,
    sessionViewRef,
    activation,
    agentActivityRuntime,
    setDraftByScopeKey,
    submittedDraftSnapshotsRef,
    sessionEngine,
    deleteAgentSessionView,
    conversationsRef,
    markSelectedConversationDetailPending,
    setIntent,
    setActiveConversationId,
    persistActiveConversation,
    removeConversations,
    agentHostApi,
    conversationListQuery,
    workspaceId
  } = input;

  const requestDeleteConversation = useCallback(
    (agentSessionId: string) => {
      const normalized = agentSessionId.trim();
      if (!normalized || isDeletingConversation) {
        return;
      }
      const conversation = conversations.find(
        (candidate) => candidate.id === normalized
      );
      if (!conversation) {
        return;
      }
      setPendingDeleteConversation(conversation);
      setDetailError(null);
    },
    [conversations, isDeletingConversation]
  );

  const cancelDeleteConversation = useCallback(() => {
    if (isDeletingConversation) {
      return;
    }
    setPendingDeleteConversation(null);
  }, [isDeletingConversation]);

  const confirmDeleteConversation = useCallback(() => {
    const target = pendingDeleteConversation;
    if (!target || isDeletingConversation) {
      return;
    }
    setIsDeletingConversation(true);
    setDetailError(null);
    if (activeConversationIdRef.current === target.id) {
      setIsLoadingMessages(true);
      setAgentSessionViewMessagesLoading(sessionViewRef(target.id), true);
    }
    void activation
      .unactivate(target.id)
      .then(() =>
        agentActivityRuntime.deleteSession({
          workspaceId,
          agentSessionId: target.id
        })
      )
      .then(() => {
        const deletedScopeKey = resolveAgentComposerDraftScopeKey({
          agentSessionId: target.id
        });
        setDraftByScopeKey((current) => {
          const next = { ...current };
          delete next[deletedScopeKey];
          return next;
        });
        deleteSubmittedDraftSnapshotsForScopes({
          snapshots: submittedDraftSnapshotsRef.current,
          scopeKeys: new Set([deletedScopeKey]),
          targetAgentSessionIds: new Set([target.id])
        });
        sessionEngine.dispatch({
          agentSessionId: target.id,
          type: "queue/sessionCleaned"
        });
        deleteAgentSessionView(sessionViewRef(target.id));
        const currentConversations = conversationsRef.current;
        const targetIndex = currentConversations.findIndex(
          (conversation) => conversation.id === target.id
        );
        const nextConversations = currentConversations.filter(
          (conversation) => conversation.id !== target.id
        );
        if (activeConversationIdRef.current === target.id) {
          const nextActive =
            nextConversations[Math.max(0, targetIndex)]?.id ??
            nextConversations[Math.max(0, targetIndex - 1)]?.id ??
            null;
          if (nextActive) {
            markSelectedConversationDetailPending(nextActive);
            setIntent({ tag: "active", id: nextActive });
          } else {
            setIsLoadingMessages(false);
            setIntent({ tag: "home" });
          }
          activeConversationIdRef.current = nextActive;
          setActiveConversationId(nextActive);
          persistActiveConversation(nextActive);
        }
        removeConversations([target.id]);
        setPendingDeleteConversation(null);
      })
      .catch((error) => {
        const message = getAgentGUIErrorMessage(error);
        reportAgentGUIRuntimeError({
          agentSessionId: target.id,
          error,
          phase: "delete_conversation",
          provider: target.provider,
          runtime: agentActivityRuntime,
          workspaceId
        });
        showAgentGUIControllerErrorToast(agentHostApi.toast, message);
        if (activeConversationIdRef.current === target.id) {
          setIsLoadingMessages(false);
          setAgentSessionViewMessagesLoading(sessionViewRef(target.id), false);
        }
      })
      .finally(() => {
        setIsDeletingConversation(false);
      });
  }, [
    activation,
    conversationListQuery,
    isDeletingConversation,
    pendingDeleteConversation,
    markSelectedConversationDetailPending,
    persistActiveConversation,
    workspaceId,
    sessionViewRef,
    agentActivityRuntime,
    agentHostApi.toast,
    sessionEngine,
    removeConversations
  ]);

  return {
    requestDeleteConversation,
    cancelDeleteConversation,
    confirmDeleteConversation
  };
}
