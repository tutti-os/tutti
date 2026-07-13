import {
  selectEngineSession,
  selectWorkspaceAgentConsumerSession,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect } from "react";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import { selectAgentGUIConversationId } from "../model/agentGuiConversationModel";
import {
  normalizeAgentGUIOpenSessionRequest,
  type AgentGUIOpenSessionRequest
} from "./agentGuiController.draftMessageHelpers";
import {
  resolveConversationSummaryById,
  type ConversationIntent
} from "./useAgentConversationSelection";

interface UseAgentGUIConversationRoutingInput {
  activeConversationIdRef: RefObject<string | null>;
  conversationListQuery: unknown | null;
  conversations: readonly AgentGUIConversationSummary[];
  conversationsRef: RefObject<AgentGUIConversationSummary[]>;
  explicitlyOpenedConversationIdsRef: RefObject<Set<string>>;
  handledOpenSessionSequenceRef: RefObject<number | null>;
  hasLoadedConversations: boolean;
  intent: ConversationIntent;
  openSessionRequest: AgentGUIOpenSessionRequest | null | undefined;
  pendingOpenSessionRequestRef: RefObject<AgentGUIOpenSessionRequest | null>;
  previewMode: boolean;
  selectConversation(
    agentSessionId: string,
    options?: { reloadConversations?: boolean }
  ): void;
  sessionEngine: AgentSessionEngine;
  setIntent: Dispatch<SetStateAction<ConversationIntent>>;
  syncConversationListProjection(agentSessionId: string): Promise<void>;
  transientConversation: AgentGUIConversationSummary | null;
  workspaceId: string;
}

export function useAgentGUIConversationRouting(
  input: UseAgentGUIConversationRoutingInput
): void {
  const {
    activeConversationIdRef,
    conversationListQuery,
    conversations,
    conversationsRef,
    explicitlyOpenedConversationIdsRef,
    handledOpenSessionSequenceRef,
    hasLoadedConversations,
    intent,
    openSessionRequest,
    pendingOpenSessionRequestRef,
    previewMode,
    selectConversation,
    sessionEngine,
    setIntent,
    syncConversationListProjection,
    transientConversation,
    workspaceId
  } = input;

  const ensureTransientOpenSessionConversation = useCallback(
    (agentSessionId: string) => {
      const normalizedAgentSessionId = agentSessionId.trim();
      if (!normalizedAgentSessionId) return;
      if (
        resolveConversationSummaryById(
          conversationsRef.current,
          normalizedAgentSessionId,
          transientConversation
        )
      ) {
        return;
      }
      const consumerSession = selectWorkspaceAgentConsumerSession(
        sessionEngine.getSnapshot(),
        normalizedAgentSessionId
      );
      if (consumerSession && consumerSession.session.visible !== false) return;
      sessionEngine.dispatch({
        agentSessionId: normalizedAgentSessionId,
        needsMessages: true,
        needsState: true,
        type: "session/reconcileRequested",
        workspaceId
      });
    },
    [sessionEngine, transientConversation, workspaceId]
  );

  useEffect(() => {
    const normalizedOpenSessionRequest =
      normalizeAgentGUIOpenSessionRequest(openSessionRequest);
    if (
      !previewMode &&
      normalizedOpenSessionRequest &&
      handledOpenSessionSequenceRef.current !==
        normalizedOpenSessionRequest.sequence
    ) {
      handledOpenSessionSequenceRef.current =
        normalizedOpenSessionRequest.sequence;
      pendingOpenSessionRequestRef.current = normalizedOpenSessionRequest;
    }
    const pendingOpenSessionRequest = pendingOpenSessionRequestRef.current;
    const hasExplicitOpenSessionRequest = Boolean(
      pendingOpenSessionRequest?.agentSessionId.trim()
    );
    const resolveId = (id: string) =>
      resolveConversationSummaryById(
        conversations,
        id,
        transientConversation
      ) !== null;
    const resolveCanonicalId = (id: string) =>
      resolveConversationSummaryById(conversations, id, null) !== null;
    const inSnapshot = (id: string) => {
      const session = selectEngineSession(sessionEngine.getSnapshot(), id);
      return Boolean(session && session.visible !== false);
    };

    if (hasExplicitOpenSessionRequest) {
      const requestedId = pendingOpenSessionRequest!.agentSessionId.trim();
      if (!hasLoadedConversations) return;
      explicitlyOpenedConversationIdsRef.current.add(requestedId);
      pendingOpenSessionRequestRef.current = null;
      selectConversation(requestedId, { reloadConversations: false });
      ensureTransientOpenSessionConversation(requestedId);
      return;
    }

    switch (intent.tag) {
      case "home":
        return;
      case "active":
        if (resolveCanonicalId(intent.id)) {
          explicitlyOpenedConversationIdsRef.current.delete(intent.id);
          return;
        }
        if (resolveId(intent.id)) return;
        if (!hasLoadedConversations) return;
        if (
          inSnapshot(intent.id) &&
          activeConversationIdRef.current === intent.id
        ) {
          ensureTransientOpenSessionConversation(intent.id);
          return;
        }
        if (
          explicitlyOpenedConversationIdsRef.current.has(intent.id) &&
          activeConversationIdRef.current === intent.id
        ) {
          return;
        }
        setIntent({ tag: "requested", id: intent.id });
        return;
      case "requested":
        if (!hasLoadedConversations) return;
        if (resolveId(intent.id)) {
          if (activeConversationIdRef.current === intent.id) {
            setIntent({ tag: "active", id: intent.id });
            return;
          }
          selectConversation(intent.id, { reloadConversations: false });
          return;
        }
        if (inSnapshot(intent.id)) {
          if (activeConversationIdRef.current === intent.id) {
            ensureTransientOpenSessionConversation(intent.id);
            setIntent({ tag: "active", id: intent.id });
          }
          return;
        }
        setIntent({ tag: "resolving", id: intent.id });
        void syncConversationListProjection(intent.id);
        return;
      case "resolving": {
        if (resolveId(intent.id)) {
          selectConversation(intent.id, { reloadConversations: false });
          return;
        }
        const fallback = selectAgentGUIConversationId(
          conversations,
          activeConversationIdRef.current
        );
        if (fallback) {
          selectConversation(fallback, { reloadConversations: false });
        } else {
          setIntent({ tag: "home" });
        }
      }
    }
  }, [
    conversationListQuery,
    conversations,
    ensureTransientOpenSessionConversation,
    hasLoadedConversations,
    intent,
    openSessionRequest,
    previewMode,
    selectConversation,
    syncConversationListProjection,
    transientConversation
  ]);
}
