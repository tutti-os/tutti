import {
  selectFailedNewActivationResolution,
  selectEngineSession,
  selectEngineSessionCanReload,
  selectEngineSessionDetailHydrated,
  selectEngineSessionStateHydrated,
  selectLatestActivationForSession,
  type AttentionReadRecord,
  type AgentSessionEngine,
  type PendingActivationIntentRecord
} from "@tutti-os/agent-activity-core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { AgentGUIRuntime } from "../../../agentActivityRuntime";
import { translate } from "../../../i18n/index";
import type { AgentGUINodeData } from "../../../types";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type { AgentGUIConversationRailRevealReason } from "../model/agentGuiConversationRailViewState";
import {
  forgetAgentGUISessionMemories,
  rememberAgentGUIActiveConversation
} from "../model/agentGuiSessionNavigationMemory";
import { AGENT_SESSION_NOT_FOUND_ERROR } from "./agentGuiController.errors";
import { readAgentGUISurfaceDocumentExposure } from "./readAgentGUISurfaceDocumentExposure";
import {
  reportAgentGUIAttentionReadDecision,
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
  | "agentSessionId"
  | "agentTargetId"
  | "errorMessage"
  | "mode"
  | "requestId"
  | "status"
>;

interface UseAgentGUIConversationSelectionControllerInput {
  activation: ReturnType<typeof useAgentGUIActivation>;
  activeConversationId: string | null;
  activeConversationIdRef: RefObject<string | null>;
  activePendingActivation: ActivationRecord | null;
  activeSessionReconcileErrorCode: string | null;
  agentActivityRuntime: AgentGUIRuntime;
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
  isSurfaceActive: boolean;
  isSurfaceVisible: boolean;
  loadDraftComposerOptions(): void;
  loadSelectedConversationMessages(
    agentSessionId: string,
    options?: { force?: boolean }
  ): Promise<void>;
  loadSessionState(agentSessionId: string): void;
  markSelectedConversationDetailPending(agentSessionId: string): string | null;
  nodeId?: string;
  onDataChangeRef: RefObject<
    (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
  >;
  sessionEngine: AgentSessionEngine;
  setActiveConversationId: Dispatch<SetStateAction<string | null>>;
  setDetailError: Dispatch<SetStateAction<string | null>>;
  setIntent: Dispatch<SetStateAction<ConversationIntent>>;
  setIsComposerHome: Dispatch<SetStateAction<boolean>>;
  setIsLoadingMessages: Dispatch<SetStateAction<boolean>>;
  setActiveMessageSession(agentSessionId: string | null): void;
  clearRailRevealRequest(): void;
  requestRailReveal(
    agentSessionId: string,
    reason: AgentGUIConversationRailRevealReason
  ): void;
  transientConversation: AgentGUIConversationSummary | null;
  workspaceId: string;
}

export function clearRolledBackAgentGUISelection(
  current: AgentGUINodeData,
  rolledBackAgentSessionId: string
): AgentGUINodeData {
  const normalized = rolledBackAgentSessionId.trim();
  return normalized
    ? forgetAgentGUISessionMemories(current, new Set([normalized]))
    : current;
}

export function shouldMarkActiveConversationRead(input: {
  activeConversationId: string;
  isSurfaceActive: boolean;
  isSurfaceDocumentExposed: boolean;
  isSurfaceVisible: boolean;
  previousActiveConversationId: string | null;
  record: AttentionReadRecord | undefined;
}): boolean {
  const {
    activeConversationId,
    isSurfaceActive,
    isSurfaceDocumentExposed,
    isSurfaceVisible,
    previousActiveConversationId,
    record
  } = input;
  if (!record?.isUnread) return false;
  if (!isSurfaceActive || !isSurfaceVisible || !isSurfaceDocumentExposed) {
    return false;
  }
  return (
    !record.markedUnreadByUser ||
    previousActiveConversationId !== activeConversationId
  );
}

export function activeConversationReadDecisionReason(input: {
  activeConversationId: string;
  isSurfaceActive: boolean;
  isSurfaceDocumentExposed: boolean;
  isSurfaceVisible: boolean;
  previousActiveConversationId: string | null;
  record: AttentionReadRecord;
}):
  | "active_selection"
  | "manual_unread_current_selection"
  | "reselected"
  | "surface_hidden"
  | "surface_inactive"
  | "document_not_exposed" {
  if (!input.isSurfaceVisible) return "surface_hidden";
  if (!input.isSurfaceActive) return "surface_inactive";
  if (!input.isSurfaceDocumentExposed) return "document_not_exposed";
  if (
    input.record.markedUnreadByUser &&
    input.previousActiveConversationId === input.activeConversationId
  ) {
    return "manual_unread_current_selection";
  }
  return input.previousActiveConversationId === input.activeConversationId
    ? "active_selection"
    : "reselected";
}

export function shouldClearMissingAgentGUISelection(input: {
  activeConversationId: string | null;
  currentActiveConversationId: string | null;
  reconcileErrorCode: string | null;
}): boolean {
  const activeConversationId = input.activeConversationId?.trim() ?? "";
  return (
    activeConversationId !== "" &&
    activeConversationId ===
      (input.currentActiveConversationId?.trim() ?? "") &&
    input.reconcileErrorCode?.trim() === AGENT_SESSION_NOT_FOUND_ERROR
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
    activeSessionReconcileErrorCode,
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
    isSurfaceActive,
    isSurfaceVisible,
    loadDraftComposerOptions,
    loadSelectedConversationMessages,
    loadSessionState,
    markSelectedConversationDetailPending,
    nodeId,
    onDataChangeRef,
    sessionEngine,
    setActiveConversationId,
    setDetailError,
    setIntent,
    setIsComposerHome,
    setIsLoadingMessages,
    setActiveMessageSession,
    clearRailRevealRequest,
    requestRailReveal,
    transientConversation,
    workspaceId
  } = input;
  const previousAttentionActiveConversationIdRef = useRef<string | null>(null);
  const attentionReadDiagnosticKeyRef = useRef<string | null>(null);
  const rolledBackSelectionSessionIdRef = useRef<string | null>(null);
  const persistedConfirmedActivationRequestIdRef = useRef<string | null>(null);
  const attentionHydrationRef = useRef<{
    engine: AgentSessionEngine;
    key: string;
  } | null>(null);

  useEffect(() => {
    const userId = currentUserId?.trim() ?? "";
    const normalizedWorkspaceId = workspaceId.trim();
    const attentionHydrationKey =
      normalizedWorkspaceId && userId
        ? `${normalizedWorkspaceId}:${userId}`
        : "";
    if (!attentionHydrationKey) {
      attentionHydrationRef.current = null;
    } else if (
      attentionHydrationRef.current?.engine !== sessionEngine ||
      attentionHydrationRef.current.key !== attentionHydrationKey
    ) {
      attentionHydrationRef.current = {
        engine: sessionEngine,
        key: attentionHydrationKey
      };
      sessionEngine.dispatch({
        type: "attention/hydrateRequested",
        commandId: `attention-hydrate:${attentionHydrationKey}`,
        userId,
        workspaceId: normalizedWorkspaceId
      });
    }
    setActiveMessageSession(activeConversationId);
    const rollbackSelection = (
      agentSessionId: string,
      errorMessage: string | null
    ) => {
      rolledBackSelectionSessionIdRef.current = agentSessionId;
      setActiveMessageSession(null);
      activeConversationIdRef.current = null;
      setActiveConversationId(null);
      isComposerHomeRef.current = true;
      setIsComposerHome(true);
      setIntent({ tag: "home" });
      clearRailRevealRequest();
      onDataChangeRef.current((current) =>
        clearRolledBackAgentGUISelection(current, agentSessionId)
      );
      if (errorMessage) setDetailError(errorMessage);
      previousAttentionActiveConversationIdRef.current = null;
    };

    if (
      activeConversationIdRef.current ===
        activePendingActivation?.agentSessionId &&
      selectFailedNewActivationResolution(
        sessionEngine.getSnapshot(),
        activePendingActivation.agentSessionId,
        intent.tag === "active" ? { selectionSource: intent.source } : undefined
      ) === "rollback"
    ) {
      rollbackSelection(
        activePendingActivation.agentSessionId,
        activePendingActivation.status === "failed"
          ? activePendingActivation.errorMessage ||
              translate("agentHost.agentGui.sessionActivationFailed")
          : null
      );
      return;
    }
    if (
      shouldClearMissingAgentGUISelection({
        activeConversationId,
        currentActiveConversationId: activeConversationIdRef.current,
        reconcileErrorCode: activeSessionReconcileErrorCode
      })
    ) {
      rollbackSelection(
        activeConversationId!.trim(),
        translate("agentHost.agentGui.sessionNoLongerAvailable")
      );
      setIsLoadingMessages(false);
      return;
    }
    if (
      activePendingActivation?.mode === "new" &&
      activePendingActivation.status === "confirmed" &&
      activeConversationIdRef.current ===
        activePendingActivation.agentSessionId &&
      persistedConfirmedActivationRequestIdRef.current !==
        activePendingActivation.requestId
    ) {
      persistedConfirmedActivationRequestIdRef.current =
        activePendingActivation.requestId;
      onDataChangeRef.current((current) =>
        rememberAgentGUIActiveConversation(
          current,
          activePendingActivation.agentSessionId,
          activePendingActivation.agentTargetId
        )
      );
    }
    if (!activeConversationId) {
      previousAttentionActiveConversationIdRef.current = null;
      return;
    }
    if (activeConversationIdRef.current !== activeConversationId) {
      previousAttentionActiveConversationIdRef.current = null;
      return;
    }
    const evaluateAttentionRead = () => {
      const previousActiveConversationId =
        previousAttentionActiveConversationIdRef.current;
      previousAttentionActiveConversationIdRef.current = activeConversationId;
      const attentionRecord =
        attentionReadRecordsBySessionId[activeConversationId];
      const isSurfaceDocumentExposed = readAgentGUISurfaceDocumentExposure();
      const shouldMarkRead = shouldMarkActiveConversationRead({
        activeConversationId,
        isSurfaceActive,
        isSurfaceDocumentExposed,
        isSurfaceVisible,
        previousActiveConversationId,
        record: attentionRecord
      });
      if (attentionRecord?.isUnread) {
        const reason = activeConversationReadDecisionReason({
          activeConversationId,
          isSurfaceActive,
          isSurfaceDocumentExposed,
          isSurfaceVisible,
          previousActiveConversationId,
          record: attentionRecord
        });
        const diagnosticKey = [
          attentionRecord.completionKey,
          isSurfaceActive,
          isSurfaceDocumentExposed,
          isSurfaceVisible,
          previousActiveConversationId,
          attentionRecord.markedUnreadByUser,
          shouldMarkRead
        ].join(":");
        if (attentionReadDiagnosticKeyRef.current !== diagnosticKey) {
          attentionReadDiagnosticKeyRef.current = diagnosticKey;
          reportAgentGUIAttentionReadDecision({
            agentSessionId: activeConversationId,
            completionKey: attentionRecord.completionKey,
            decision: shouldMarkRead ? "read" : "preserve_unread",
            isSurfaceActive,
            isSurfaceDocumentExposed,
            isSurfaceVisible,
            markedUnreadByUser: attentionRecord.markedUnreadByUser,
            nodeId,
            previousActiveConversationId,
            reason,
            runtime: agentActivityRuntime,
            workspaceId
          });
        }
      } else {
        attentionReadDiagnosticKeyRef.current = null;
      }
      if (shouldMarkRead) {
        sessionEngine.dispatch({
          type: "attention/read",
          agentSessionId: activeConversationId,
          userId: currentUserId?.trim() ?? ""
        });
      }
    };
    const handleExposureChange = () => evaluateAttentionRead();
    document.addEventListener("visibilitychange", handleExposureChange);
    window.addEventListener("blur", handleExposureChange);
    window.addEventListener("focus", handleExposureChange);
    evaluateAttentionRead();
    return () => {
      document.removeEventListener("visibilitychange", handleExposureChange);
      window.removeEventListener("blur", handleExposureChange);
      window.removeEventListener("focus", handleExposureChange);
    };
  }, [
    activeConversationId,
    activePendingActivation,
    activeSessionReconcileErrorCode,
    attentionReadRecordsBySessionId,
    clearRailRevealRequest,
    currentUserId,
    isSurfaceActive,
    isSurfaceVisible,
    sessionEngine,
    setActiveMessageSession,
    workspaceId
  ]);

  useEffect(() => {
    const externalId = data.lastActiveAgentSessionId?.trim() ?? "";
    const rolledBackSelectionSessionId =
      rolledBackSelectionSessionIdRef.current;
    if (rolledBackSelectionSessionId) {
      if (externalId === rolledBackSelectionSessionId) {
        // The Workbench state update that clears a failed or missing session
        // can reach this component after the local rollback. Until that echo
        // arrives, the old persisted id is not a new external selection.
        return;
      }
      rolledBackSelectionSessionIdRef.current = null;
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
      setActiveMessageSession(null);
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
      canReload: (agentSessionId) => {
        return selectEngineSessionCanReload(
          sessionEngine.getSnapshot(),
          agentSessionId
        );
      },
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
      ensureHydrated: (agentSessionId) => {
        void loadSelectedConversationMessages(agentSessionId);
      },
      ensureStateHydrated: loadSessionState,
      isHydrated: (agentSessionId) =>
        selectEngineSessionDetailHydrated(
          sessionEngine.getSnapshot(),
          agentSessionId
        ),
      isStateHydrated: (agentSessionId) =>
        selectEngineSessionStateHydrated(
          sessionEngine.getSnapshot(),
          agentSessionId
        ),
      markPending: markSelectedConversationDetailPending,
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
        setActiveMessageSession(agentSessionId);
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
