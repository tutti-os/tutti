import {
  selectFailedNewActivationResolution,
  selectEngineSessionReconcile,
  selectWorkspaceAgentConsumerSession,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect } from "react";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import {
  normalizeAgentGUIOpenSessionRequest,
  resolveAgentGUIPendingOpenSessionRequestForRender,
  type AgentGUIOpenSessionSelectionOutcome,
  type AgentGUIOpenSessionRequest
} from "./agentGuiController.draftMessageHelpers";
import {
  resolveConversationSummaryById,
  type AgentGUIConversationSelectionOptions,
  type ConversationIntent
} from "./useAgentConversationSelection";

interface UseAgentGUIConversationRoutingInput {
  activeConversationIdRef: RefObject<string | null>;
  agentTargetsLoading?: boolean;
  conversationListQuery: unknown | null;
  conversations: readonly AgentGUIConversationSummary[];
  conversationsRef: RefObject<AgentGUIConversationSummary[]>;
  handledOpenSessionSequenceRef: RefObject<number | null>;
  hasLoadedConversations: boolean;
  intent: ConversationIntent;
  openSessionRequest: AgentGUIOpenSessionRequest | null | undefined;
  openExternalSession?(
    request: AgentGUIOpenSessionRequest
  ): AgentGUIOpenSessionSelectionOutcome;
  pendingOpenSessionRequestRef: RefObject<AgentGUIOpenSessionRequest | null>;
  selectConversation(
    agentSessionId: string,
    options?: AgentGUIConversationSelectionOptions
  ): void;
  sessionEngine: AgentSessionEngine;
  setIntent: Dispatch<SetStateAction<ConversationIntent>>;
  transientConversation: AgentGUIConversationSummary | null;
  workspaceId: string;
}

export function useAgentGUIConversationRouting(
  input: UseAgentGUIConversationRoutingInput
): AgentGUIOpenSessionRequest | null {
  const {
    activeConversationIdRef,
    agentTargetsLoading = false,
    conversationListQuery,
    conversations,
    conversationsRef,
    handledOpenSessionSequenceRef,
    hasLoadedConversations,
    intent,
    openSessionRequest,
    openExternalSession,
    pendingOpenSessionRequestRef,
    selectConversation,
    sessionEngine,
    setIntent,
    transientConversation,
    workspaceId
  } = input;
  const pendingOpenSessionRequestForRender =
    resolveAgentGUIPendingOpenSessionRequestForRender({
      handledSequence: handledOpenSessionSequenceRef.current,
      openSessionRequest,
      pendingOpenSessionRequest: pendingOpenSessionRequestRef.current
    });

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
      const reconcile = selectEngineSessionReconcile(
        sessionEngine.getSnapshot(),
        normalizedAgentSessionId
      );
      if (
        reconcile?.inFlightCommandId ||
        reconcile?.pendingMessages ||
        reconcile?.pendingState
      ) {
        return;
      }
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
    if (hasExplicitOpenSessionRequest) {
      const request = pendingOpenSessionRequest!;
      const requestedId = request.agentSessionId.trim();
      const hasExactTargetIdentity = Object.prototype.hasOwnProperty.call(
        request,
        "agentTargetId"
      );
      if (!hasLoadedConversations) return;
      if (hasExactTargetIdentity) {
        if (request.agentTargetId !== null && agentTargetsLoading) return;
        pendingOpenSessionRequestRef.current = null;
        if (openExternalSession?.(request) === "selected") {
          ensureTransientOpenSessionConversation(requestedId);
        }
        return;
      }
      pendingOpenSessionRequestRef.current = null;
      selectConversation(requestedId, {
        reloadConversations: false,
        reveal: "external-open"
      });
      ensureTransientOpenSessionConversation(requestedId);
      return;
    }

    if (intent.tag !== "home") {
      if (
        selectFailedNewActivationResolution(
          sessionEngine.getSnapshot(),
          intent.id,
          intent.tag === "active"
            ? { selectionSource: intent.source }
            : undefined
        ) === "rollback"
      ) {
        // Terminal activation settlement clears the optimistic selection in an
        // earlier effect. Do not let this effect's stale active/requested intent
        // select the provisional session again during the same effect flush.
        setIntent({ tag: "home" });
        return;
      }
    }

    switch (intent.tag) {
      case "home":
        return;
      case "active":
        if (resolveCanonicalId(intent.id)) return;
        if (resolveId(intent.id)) return;
        // An active intent is produced by an explicit user/session selection.
        // Rail pages are bounded and may not contain that selected session yet;
        // list absence must not demote it into the requested/fallback flow.
        if (activeConversationIdRef.current === intent.id) return;
        if (!hasLoadedConversations) return;
        setIntent({ tag: "requested", id: intent.id });
        return;
      case "requested":
        if (!hasLoadedConversations) return;
        // Persisted/external selection is authoritative. The bounded list may
        // not contain it after restart, so activate it and reconcile detail
        // instead of replacing it with the first visible rail row.
        selectConversation(intent.id, { reloadConversations: false });
        ensureTransientOpenSessionConversation(intent.id);
        return;
    }
  }, [
    agentTargetsLoading,
    conversationListQuery,
    conversations,
    ensureTransientOpenSessionConversation,
    hasLoadedConversations,
    intent,
    openSessionRequest,
    openExternalSession,
    selectConversation,
    transientConversation
  ]);
  return pendingOpenSessionRequestForRender;
}
