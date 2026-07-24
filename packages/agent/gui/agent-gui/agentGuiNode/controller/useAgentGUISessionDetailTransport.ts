import {
  selectLatestActivationForSession,
  type SessionReconcileScope,
  type AgentActivitySnapshot,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { RefObject } from "react";
import { useCallback, useMemo } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { useAgentSessionControllerState } from "../../../contexts/workspace/presentation/renderer/agentSessions/useAgentSessionControllerState";
import { mergeWorkspaceAgentMessages } from "../../../host/workspaceAgentSessionMessages";
import type { AgentGUINodeData } from "../../../types";
import { EMPTY_AGENT_GUI_MESSAGES } from "./agentGuiController.providerHelpers";
import {
  reportAgentGUIMessagePageDiagnostic,
  reportAgentGUIRuntimeError
} from "./agentGuiController.reporting";
import {
  maxFiniteMessageVersion,
  minFiniteMessageVersion,
  useAgentConversationMessagePaging,
  windowHasTurnMissingUserPrompt
} from "./useAgentConversationMessagePaging";

export function useAgentGUISessionDetailTransport(input: {
  activeConversationId: string | null;
  activeConversationIdRef: RefObject<string | null>;
  agentActivityRuntime: AgentActivityRuntime;
  agentActivityRuntimeOrigin: string;
  agentActivitySnapshot: AgentActivitySnapshot;
  agentActivitySnapshotRef: RefObject<AgentActivitySnapshot>;
  dataRef: RefObject<AgentGUINodeData>;
  isMountedRef: RefObject<boolean>;
  reloadSelectedConversationRef: RefObject<
    (
      agentSessionId: string,
      options: { reloadConversations: boolean; reloadDetail: boolean }
    ) => void
  >;
  sessionEngine: AgentSessionEngine;
  syncConversationListProjectionRef: RefObject<
    (agentSessionId?: string | null) => Promise<void>
  >;
  workspaceId: string;
}) {
  const {
    activeConversationId,
    activeConversationIdRef,
    agentActivityRuntime,
    agentActivityRuntimeOrigin,
    agentActivitySnapshot,
    agentActivitySnapshotRef,
    dataRef,
    isMountedRef,
    reloadSelectedConversationRef,
    sessionEngine,
    syncConversationListProjectionRef,
    workspaceId
  } = input;
  const sessionViewRef = useCallback(
    (agentSessionId: string | null | undefined) => ({
      workspaceId,
      agentSessionId,
      origin: agentActivityRuntimeOrigin
    }),
    [agentActivityRuntimeOrigin, workspaceId]
  );
  const state = useAgentSessionControllerState(
    sessionViewRef(activeConversationId),
    activeConversationId
      ? (agentActivitySnapshot.sessionMessagesById[activeConversationId] ?? [])
      : [],
    activeConversationId
      ? (agentActivitySnapshot.sessionMessageWindowsById?.[
          activeConversationId
        ] ?? null)
      : null
  );
  const resolveSessionMessages = useCallback(
    (agentSessionId: string | null | undefined) => {
      const normalized = agentSessionId?.trim() ?? "";
      if (!normalized) return EMPTY_AGENT_GUI_MESSAGES;
      const sessionView = state.getAgentSessionView(sessionViewRef(normalized));
      const canonical =
        agentActivitySnapshot.sessionMessagesById[normalized] ??
        EMPTY_AGENT_GUI_MESSAGES;
      const older = sessionView?.olderMessages ?? EMPTY_AGENT_GUI_MESSAGES;
      return older.length > 0
        ? mergeWorkspaceAgentMessages(older, canonical)
        : canonical;
    },
    [agentActivitySnapshot.sessionMessagesById, sessionViewRef, state]
  );
  const {
    loadSessionState,
    reconcileSessionDetail,
    refreshMessagesFromSnapshot
  } = useMemo(() => {
    const reconcileSession = (
      agentSessionId: string,
      scope: SessionReconcileScope
    ) => {
      const normalized = agentSessionId.trim();
      if (!normalized) return;
      sessionEngine.dispatch({
        agentSessionId: normalized,
        needsMessages: scope !== "state",
        needsState: scope !== "messages",
        type: "session/reconcileRequested",
        workspaceId
      });
    };
    return {
      loadSessionState: (agentSessionId: string, _cause?: unknown) =>
        reconcileSession(agentSessionId, "state"),
      reconcileSessionDetail: (agentSessionId: string) =>
        reconcileSession(agentSessionId, "state_and_messages"),
      refreshMessagesFromSnapshot: (agentSessionId: string) =>
        reconcileSession(agentSessionId, "messages")
    };
  }, [sessionEngine, workspaceId]);
  const paging = useAgentConversationMessagePaging({
    diagnostics: {
      error: ({ agentSessionId, context, error, phase }) =>
        reportAgentGUIRuntimeError({
          agentSessionId,
          context,
          error,
          phase,
          provider: dataRef.current.provider,
          runtime: agentActivityRuntime,
          workspaceId
        }),
      page: ({ agentSessionId, details, event, level, messages }) =>
        reportAgentGUIMessagePageDiagnostic({
          agentSessionId,
          details,
          event,
          level,
          messages,
          runtime: agentActivityRuntime,
          workspaceId
        })
    },
    getActiveSessionId: () => activeConversationIdRef.current,
    getCanonicalMessages: (agentSessionId) =>
      agentActivitySnapshotRef.current.sessionMessagesById[agentSessionId] ??
      EMPTY_AGENT_GUI_MESSAGES,
    isMounted: () => isMountedRef.current,
    projection: {
      maxVersion: maxFiniteMessageVersion,
      minVersion: minFiniteMessageVersion,
      windowHasTurnMissingUserPrompt
    },
    reload: {
      getActivationStatus: (agentSessionId) =>
        selectLatestActivationForSession(
          sessionEngine.getSnapshot(),
          agentSessionId
        )?.status ?? null,
      reconcileDetail: reconcileSessionDetail,
      syncConversationList: (agentSessionId) =>
        void syncConversationListProjectionRef.current(agentSessionId)
    },
    runtime: agentActivityRuntime,
    sessionViewRef,
    view: {
      get: (ref) =>
        ref.agentSessionId?.trim() === activeConversationIdRef.current
          ? state.activeSessionView
          : state.getAgentSessionView(ref),
      mergeOlder: state.mergeAgentSessionViewOlderMessages,
      setOlderMessagesLoading: state.setAgentSessionViewOlderMessagesLoading
    },
    workspaceId
  });
  reloadSelectedConversationRef.current = paging.reloadSelectedConversation;
  const markSelectedConversationDetailPending = useCallback(
    (agentSessionId: string) => {
      const normalized = agentSessionId.trim();
      if (!normalized) return null;
      const ref = sessionViewRef(normalized);
      state.resetAgentSessionViewOlderMessages(ref);
      state.setAgentSessionViewError(ref, null);
      return normalized;
    },
    [sessionViewRef, state]
  );

  return {
    ...state,
    loadOlderConversationMessages: paging.loadOlderMessages,
    loadSelectedConversationMessages: paging.loadInitialMessages,
    loadSessionState,
    markSelectedConversationDetailPending,
    refreshMessagesFromSnapshot,
    reloadSelectedConversation: paging.reloadSelectedConversation,
    resolveSessionMessages,
    sessionViewRef
  };
}
