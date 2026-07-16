import {
  isPendingActivationViable,
  selectEngineSession,
  selectEngineSessionDetailHydrated,
  selectLatestActivationForSession,
  type AttentionReadRecord,
  type AgentSessionEngine,
  type PendingActivationIntentRecord
} from "@tutti-os/agent-activity-core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { translate } from "../../../i18n/index";
import type { AgentGUINodeData } from "../../../types";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type { AgentGUIConversationRailRevealReason } from "../model/agentGuiConversationRailViewState";
import { forgetAgentGUISessionMemories } from "../model/agentGuiSessionNavigationMemory";
import {
  reportAgentGUIActiveConversationCleared,
  reportAgentGUIConversationListProjectionSkipped
} from "./agentGuiController.reporting";
import {
  isPendingNewConversationActivation,
  isPendingNewConversationActivationForSession,
  type useAgentGUIActivation
} from "./useAgentGUIActivation";
import {
  resolveConversationSummaryById,
  useAgentConversationSelection,
  type ConversationIntent
} from "./useAgentConversationSelection";

type ActivationRecord = Pick<
  PendingActivationIntentRecord,
  "agentSessionId" | "errorMessage" | "mode" | "status"
>;

interface UseAgentGUIConversationSelectionControllerInput {
  activation: ReturnType<typeof useAgentGUIActivation>;
  activeConversationId: string | null;
  activeConversationIdRef: RefObject<string | null>;
  activePendingActivation: ActivationRecord | null;
  agentActivityRuntime: AgentActivityRuntime;
  attentionReadRecordsBySessionId: Record<
    string,
    AttentionReadRecord | undefined
  >;
  conversationIdsRef: RefObject<Set<string>>;
  conversationsRef: RefObject<AgentGUIConversationSummary[]>;
  conversationListQuery: unknown | null;
  currentUserId: string | null | undefined;
  data: AgentGUINodeData;
  dataRef: RefObject<AgentGUINodeData>;
  intent: ConversationIntent;
  isComposerHomeRef: RefObject<boolean>;
  isMountedRef: RefObject<boolean>;
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
  clearRailRevealRequest(): void;
  requestRailReveal(
    agentSessionId: string,
    reason: AgentGUIConversationRailRevealReason
  ): void;
  transientConversation: AgentGUIConversationSummary | null;
  workspaceId: string;
}

export function clearFailedAgentGUIActivationSelection(
  current: AgentGUINodeData,
  failedAgentSessionId: string
): AgentGUINodeData {
  const normalized = failedAgentSessionId.trim();
  return normalized
    ? forgetAgentGUISessionMemories(current, new Set([normalized]))
    : current;
}

export function shouldMarkActiveConversationRead(input: {
  activeConversationId: string;
  previousActiveConversationId: string | null;
  record: AttentionReadRecord | undefined;
}): boolean {
  const { activeConversationId, previousActiveConversationId, record } = input;
  if (!record?.isUnread) return false;
  return (
    !record.markedUnreadByUser ||
    previousActiveConversationId !== activeConversationId
  );
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
    attentionReadRecordsBySessionId,
    conversationIdsRef,
    conversationsRef,
    conversationListQuery,
    currentUserId,
    data,
    dataRef,
    intent,
    isComposerHomeRef,
    isMountedRef,
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
    clearRailRevealRequest,
    requestRailReveal,
    transientConversation,
    workspaceId
  } = input;
  const previousAttentionActiveConversationIdRef = useRef<string | null>(null);
  const failedActivationRollbackSessionIdRef = useRef<string | null>(null);

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
    if (
      activePendingActivation?.mode === "new" &&
      !isPendingActivationViable(activePendingActivation) &&
      activeConversationIdRef.current === activePendingActivation.agentSessionId
    ) {
      failedActivationRollbackSessionIdRef.current =
        activePendingActivation.agentSessionId;
      activeConversationIdRef.current = null;
      setActiveConversationId(null);
      isComposerHomeRef.current = true;
      setIsComposerHome(true);
      setIntent({ tag: "home" });
      clearRailRevealRequest();
      onDataChangeRef.current((current) =>
        clearFailedAgentGUIActivationSelection(
          current,
          activePendingActivation.agentSessionId
        )
      );
      if (activePendingActivation.status === "failed") {
        setDetailError(
          activePendingActivation.errorMessage ||
            translate("agentHost.agentGui.sessionActivationFailed")
        );
      }
      previousAttentionActiveConversationIdRef.current = null;
      return;
    }
    if (!activeConversationId) {
      previousAttentionActiveConversationIdRef.current = null;
      return;
    }
    const previousActiveConversationId =
      previousAttentionActiveConversationIdRef.current;
    previousAttentionActiveConversationIdRef.current = activeConversationId;
    if (
      shouldMarkActiveConversationRead({
        activeConversationId,
        previousActiveConversationId,
        record: attentionReadRecordsBySessionId[activeConversationId]
      })
    ) {
      sessionEngine.dispatch({
        type: "attention/read",
        agentSessionId: activeConversationId,
        userId: currentUserId?.trim() ?? ""
      });
    }
  }, [
    activeConversationId,
    activePendingActivation,
    attentionReadRecordsBySessionId,
    clearRailRevealRequest,
    currentUserId,
    sessionEngine
  ]);

  useEffect(() => {
    const externalId = data.lastActiveAgentSessionId?.trim() ?? "";
    const failedActivationRollbackSessionId =
      failedActivationRollbackSessionIdRef.current;
    if (failedActivationRollbackSessionId) {
      if (externalId === failedActivationRollbackSessionId) {
        // The workbench state update that clears a failed optimistic session
        // can reach this component after the local rollback. Until that echo
        // arrives, the old persisted id is not a new external selection.
        return;
      }
      failedActivationRollbackSessionIdRef.current = null;
    }
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
      if (
        previous &&
        !isPendingNewConversationActivationForSession(
          activePendingActivation,
          previous
        )
      ) {
        void activation.unactivate(previous);
      }
      setIntent({ tag: "home" });
      isComposerHomeRef.current = true;
      setIsComposerHome(true);
      activeConversationIdRef.current = null;
      setActiveConversationId(null);
      setIsLoadingMessages(false);
      setDetailError(null);
      clearRailRevealRequest();
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
      if (current.tag === "requested") {
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
      isPending: (agentSessionId) =>
        isPendingNewConversationActivation(
          selectLatestActivationForSession(
            sessionEngine.getSnapshot(),
            agentSessionId
          )
        )
    },
    conversations: {
      agentTargetIdFor: (agentSessionId) => {
        const state = sessionEngine.getSnapshot();
        const sessionAgentTargetId =
          selectEngineSession(state, agentSessionId)?.agentTargetId?.trim() ??
          "";
        if (sessionAgentTargetId) return sessionAgentTargetId;
        const activationAgentTargetId =
          selectLatestActivationForSession(
            state,
            agentSessionId
          )?.agentTargetId?.trim() ?? "";
        if (activationAgentTargetId) return activationAgentTargetId;
        return (
          resolveConversationSummaryById(
            conversationsRef.current,
            agentSessionId,
            transientConversation
          )?.agentTargetId?.trim() || null
        );
      },
      contains: (agentSessionId) =>
        conversationIdsRef.current.has(agentSessionId)
    },
    detail: {
      isHydrated: (agentSessionId) =>
        selectEngineSessionDetailHydrated(
          sessionEngine.getSnapshot(),
          agentSessionId
        ),
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
    rail: {
      clearRevealRequest: clearRailRevealRequest,
      requestReveal: requestRailReveal
    },
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

  const removeConversations = useCallback(
    (conversationIds: readonly string[]) => {
      const removedIds = new Set(
        conversationIds
          .map((agentSessionId) => agentSessionId.trim())
          .filter(Boolean)
      );
      for (const agentSessionId of conversationIds) {
        sessionEngine.dispatch({
          type: "session/removed",
          agentSessionId
        });
      }
      if (removedIds.size === 0) return;
      onDataChangeRef.current((current) => {
        const next = forgetAgentGUISessionMemories(current, removedIds);
        dataRef.current = next;
        return next;
      });
    },
    [dataRef, onDataChangeRef, sessionEngine]
  );

  return { ...selection, removeConversations };
}
