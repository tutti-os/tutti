import type {
  AgentActivitySnapshot,
  AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useEffect } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { translate } from "../../../i18n/index";
import type { AgentGUINodeData } from "../../../types";
import {
  reportAgentGUIActiveConversationCleared,
  reportAgentGUIConversationListProjectionSkipped
} from "./agentGuiController.reporting";
import { sessionHasRenderableMessages } from "./useAgentConversationMessagePaging";
import type { useAgentGUIActivation } from "./useAgentGUIActivation";
import {
  useAgentConversationSelection,
  type ConversationIntent
} from "./useAgentConversationSelection";

interface ActivationRecord {
  agentSessionId: string;
  errorMessage?: string | null;
  mode: "existing" | "new";
  status: string;
}

interface UseAgentGUIConversationSelectionControllerInput {
  activation: ReturnType<typeof useAgentGUIActivation>;
  activeConversationId: string | null;
  activeConversationIdRef: RefObject<string | null>;
  activePendingActivation: ActivationRecord | null;
  agentActivityRuntime: AgentActivityRuntime;
  agentActivitySnapshotRef: RefObject<AgentActivitySnapshot>;
  attentionReadRecordsBySessionId: Record<
    string,
    { isUnread?: boolean } | undefined
  >;
  conversationIdsRef: RefObject<Set<string>>;
  conversationListQuery: unknown | null;
  currentUserId: string | null | undefined;
  data: AgentGUINodeData;
  dataRef: RefObject<AgentGUINodeData>;
  intent: ConversationIntent;
  isComposerHomeRef: RefObject<boolean>;
  isMountedRef: RefObject<boolean>;
  latestPendingNewActivation: ActivationRecord | null;
  loadDraftComposerOptions(): void;
  markSelectedConversationDetailPending(agentSessionId: string): string | null;
  onDataChangeRef: RefObject<
    (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
  >;
  reloadSelectedConversationRef: RefObject<
    (
      agentSessionId: string,
      options: { reloadConversations: boolean; reloadDetail: boolean }
    ) => void
  >;
  sessionEngine: AgentSessionEngine;
  setActiveConversationId: Dispatch<SetStateAction<string | null>>;
  setDetailError: Dispatch<SetStateAction<string | null>>;
  setIntent: Dispatch<SetStateAction<ConversationIntent>>;
  setIsComposerHome: Dispatch<SetStateAction<boolean>>;
  setIsLoadingMessages: Dispatch<SetStateAction<boolean>>;
  workspaceId: string;
}

export function useAgentGUIConversationSelectionController(
  input: UseAgentGUIConversationSelectionControllerInput
) {
  const {
    activation,
    activeConversationId,
    activeConversationIdRef,
    activePendingActivation,
    agentActivityRuntime,
    agentActivitySnapshotRef,
    attentionReadRecordsBySessionId,
    conversationIdsRef,
    conversationListQuery,
    currentUserId,
    data,
    dataRef,
    intent,
    isComposerHomeRef,
    isMountedRef,
    latestPendingNewActivation,
    loadDraftComposerOptions,
    markSelectedConversationDetailPending,
    onDataChangeRef,
    reloadSelectedConversationRef,
    sessionEngine,
    setActiveConversationId,
    setDetailError,
    setIntent,
    setIsComposerHome,
    setIsLoadingMessages,
    workspaceId
  } = input;

  useEffect(() => {
    const userId = currentUserId?.trim() ?? "";
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId || !userId) return;
    sessionEngine.dispatch({
      type: "attention/hydrateRequested",
      commandId: `attention-hydrate:${normalizedWorkspaceId}:${userId}`,
      userId,
      workspaceId: normalizedWorkspaceId
    });
  }, [currentUserId, sessionEngine, workspaceId]);

  useEffect(() => {
    if (!activeConversationId) return;
    if (attentionReadRecordsBySessionId[activeConversationId]?.isUnread) {
      sessionEngine.dispatch({
        type: "attention/read",
        agentSessionId: activeConversationId,
        userId: currentUserId?.trim() ?? ""
      });
    }
  }, [
    activeConversationId,
    attentionReadRecordsBySessionId,
    currentUserId,
    sessionEngine
  ]);

  useEffect(() => {
    const externalId = data.lastActiveAgentSessionId?.trim() ?? "";
    if (externalId === (activeConversationIdRef.current ?? "")) return;
    if (!externalId) {
      const previous = activeConversationIdRef.current;
      if (!previous && isComposerHomeRef.current && intent.tag === "home") {
        return;
      }
      reportAgentGUIActiveConversationCleared({
        details: {
          dataLastActiveAgentSessionId: data.lastActiveAgentSessionId ?? null,
          intent: intent.tag,
          isComposerHome: isComposerHomeRef.current
        },
        previousAgentSessionId: previous,
        reason: "external_last_active_empty",
        runtime: agentActivityRuntime,
        workspaceId
      });
      if (previous) void activation.unactivate(previous);
      setIntent({ tag: "home" });
      isComposerHomeRef.current = true;
      setIsComposerHome(true);
      activeConversationIdRef.current = null;
      setActiveConversationId(null);
      setIsLoadingMessages(false);
      setDetailError(null);
      loadDraftComposerOptions();
      return;
    }
    setIntent((current) => {
      if (
        (current.tag === "active" || current.tag === "requested") &&
        current.id === externalId
      ) {
        return current;
      }
      if (current.tag === "requested" || current.tag === "resolving") {
        return current;
      }
      return { tag: "requested", id: externalId };
    });
    // External persisted selection is the trigger; routing dependencies stay in
    // refs or stable controller callbacks to avoid replaying a local selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.lastActiveAgentSessionId]);
  const selection = useAgentConversationSelection({
    activation: {
      forget: activation.clearFailure,
      getPendingSessionId: () =>
        latestPendingNewActivation?.agentSessionId ?? null
    },
    conversations: {
      contains: (agentSessionId) =>
        conversationIdsRef.current.has(agentSessionId)
    },
    detail: {
      hasRenderableMessages: (agentSessionId) =>
        sessionHasRenderableMessages({
          agentSessionId,
          snapshotMessagesById:
            agentActivitySnapshotRef.current.sessionMessagesById
        }),
      markPending: markSelectedConversationDetailPending,
      reload: (agentSessionId, options) =>
        reloadSelectedConversationRef.current(agentSessionId, options),
      setLoading: setIsLoadingMessages
    },
    hasConversationListQuery: () => Boolean(conversationListQuery),
    isMounted: () => isMountedRef.current,
    onMissingConversationListQuery: (previous) => {
      const workspaceIdPresent = Boolean(workspaceId.trim());
      const currentUserIdPresent = Boolean(currentUserId?.trim());
      const diagnosticInput = {
        currentUserIdPresent,
        dataLastActiveAgentSessionId:
          dataRef.current.lastActiveAgentSessionId ?? null,
        isComposerHome: isComposerHomeRef.current,
        provider: dataRef.current.provider,
        runtime: agentActivityRuntime,
        workspaceId,
        workspaceIdPresent
      };
      reportAgentGUIConversationListProjectionSkipped({
        ...diagnosticInput,
        activeConversationId: previous,
        reason: "conversation_list_query_missing"
      });
      reportAgentGUIActiveConversationCleared({
        details: {
          currentUserIdPresent,
          dataLastActiveAgentSessionId:
            diagnosticInput.dataLastActiveAgentSessionId,
          isComposerHome: diagnosticInput.isComposerHome,
          provider: diagnosticInput.provider,
          workspaceIdPresent
        },
        previousAgentSessionId: previous,
        reason: "conversation_list_query_missing",
        runtime: agentActivityRuntime,
        workspaceId
      });
    },
    persistence: { update: (updater) => onDataChangeRef.current(updater) },
    selection: {
      clearDetailError: () => setDetailError(null),
      getActiveSessionId: () => activeConversationIdRef.current,
      setActiveSessionId: (agentSessionId) => {
        activeConversationIdRef.current = agentSessionId;
        setActiveConversationId(agentSessionId);
      },
      setComposerHome: (home) => {
        isComposerHomeRef.current = home;
        setIsComposerHome(home);
      },
      setIntent
    }
  });

  useEffect(() => {
    const pending = latestPendingNewActivation;
    if (
      !pending ||
      activeConversationIdRef.current === pending.agentSessionId
    ) {
      return;
    }
    activeConversationIdRef.current = pending.agentSessionId;
    setActiveConversationId(pending.agentSessionId);
    isComposerHomeRef.current = false;
    setIsComposerHome(false);
    setIntent({ tag: "active", id: pending.agentSessionId });
    selection.persistActiveConversation(pending.agentSessionId);
  }, [latestPendingNewActivation, selection.persistActiveConversation]);

  useEffect(() => {
    if (
      activePendingActivation?.mode !== "new" ||
      activePendingActivation.status !== "failed" ||
      activeConversationIdRef.current !== activePendingActivation.agentSessionId
    ) {
      return;
    }
    activeConversationIdRef.current = null;
    setActiveConversationId(null);
    isComposerHomeRef.current = true;
    setIsComposerHome(true);
    setIntent({ tag: "home" });
    selection.persistActiveConversation(null);
    setDetailError(
      activePendingActivation.errorMessage ||
        translate("agentHost.agentGui.sessionActivationFailed")
    );
  }, [activePendingActivation, selection.persistActiveConversation]);

  return selection;
}
