import {
  pendingSubmitRecordListsEqual,
  selectEngineActiveTurn,
  selectEngineCancelState,
  selectEngineHasPendingInteractions,
  selectEngineInteractionResponseError,
  selectEngineLatestTurn,
  selectEnginePendingInteractions,
  selectEnginePromptQueue,
  selectEnginePromptQueueError,
  selectEngineSession,
  selectEngineSessionDeleted,
  selectEngineSessionError,
  selectEngineSessionIsRespondingToInteraction,
  selectEngineSessionReconcile,
  selectEngineSessionSettingsUpdate,
  selectEngineSubmitAvailability,
  selectLatestActivationForSession,
  selectLatestPendingSubmitForSession,
  selectPendingActivations,
  selectPendingSubmitsForSession,
  selectSessionHasUnconfirmedSubmit,
  selectSessionIsSubmitting,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import { useMemo } from "react";
import type {
  AgentSessionComposerSettings,
  AgentSessionReasoningEffort,
  AgentSessionSpeed,
  AgentSessionState
} from "../../../shared/agentSessionTypes";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";
import { EMPTY_QUEUED_PROMPTS } from "./agentGuiController.draftMessageHelpers";
import { agentActivityInteractionListsEqual } from "./agentGuiController.providerHelpers";

export function useAgentGUISessionEngineState(input: {
  activeConversationId: string | null;
  sessionEngine: AgentSessionEngine;
}) {
  const { activeConversationId, sessionEngine } = input;
  const hasPendingNewActivation = useEngineSelector(sessionEngine, (state) =>
    selectPendingActivations(state).some(
      (activation) =>
        activation.mode === "new" &&
        (activation.status === "requested" || activation.status === "uncertain")
    )
  );
  const activeQueuedPromptSnapshot = useEngineSelector(sessionEngine, (state) =>
    selectEnginePromptQueue(state, activeConversationId)
  );
  const activeQueuedPrompts =
    activeQueuedPromptSnapshot?.prompts.filter(
      (prompt) =>
        prompt.visibleInQueue !== false &&
        prompt.id !== activeQueuedPromptSnapshot.inFlight?.promptId &&
        prompt.id !== activeQueuedPromptSnapshot.sendNextPromptId
    ) ?? EMPTY_QUEUED_PROMPTS;
  const activePendingSubmits = useEngineSelector(
    sessionEngine,
    (state) => selectPendingSubmitsForSession(state, activeConversationId),
    pendingSubmitRecordListsEqual
  );
  const activeLatestPendingSubmit = useEngineSelector(sessionEngine, (state) =>
    selectLatestPendingSubmitForSession(state, activeConversationId)
  );
  const activePendingActivation = useEngineSelector(sessionEngine, (state) =>
    selectLatestActivationForSession(state, activeConversationId)
  );
  const isSubmitting = useEngineSelector(sessionEngine, (state) =>
    selectSessionIsSubmitting(state, activeConversationId)
  );
  const hasUnconfirmedSubmit = useEngineSelector(sessionEngine, (state) =>
    selectSessionHasUnconfirmedSubmit(state, activeConversationId)
  );
  const activeCancelState = useEngineSelector(sessionEngine, (state) =>
    selectEngineCancelState(state, activeConversationId)
  );
  const activeEngineSession = useEngineSelector(sessionEngine, (state) =>
    selectEngineSession(state, activeConversationId)
  );
  const activeSessionReconcile = useEngineSelector(sessionEngine, (state) =>
    selectEngineSessionReconcile(state, activeConversationId)
  );
  const activeSessionReconcilePending = Boolean(
    activeSessionReconcile?.inFlightCommandId ||
    activeSessionReconcile?.pendingMessages ||
    activeSessionReconcile?.pendingState
  );
  const activeEngineSessionDeleted = useEngineSelector(sessionEngine, (state) =>
    selectEngineSessionDeleted(state, activeConversationId)
  );
  const activeEngineActiveTurn = useEngineSelector(sessionEngine, (state) =>
    selectEngineActiveTurn(state, activeConversationId)
  );
  const activeEngineLatestTurn = useEngineSelector(sessionEngine, (state) =>
    selectEngineLatestTurn(state, activeConversationId)
  );
  const activeCanonicalComposerSettings = useMemo<AgentSessionComposerSettings>(
    () => ({
      model: activeEngineSession?.settings?.model ?? undefined,
      permissionModeId:
        activeEngineSession?.settings?.permissionModeId ?? undefined,
      planMode: activeEngineSession?.settings?.planMode ?? undefined,
      browserUse: activeEngineSession?.settings?.browserUse ?? undefined,
      reasoningEffort:
        (activeEngineSession?.settings?.reasoningEffort as
          | AgentSessionReasoningEffort
          | null
          | undefined) ?? undefined,
      speed:
        (activeEngineSession?.settings?.speed as
          | AgentSessionSpeed
          | null
          | undefined) ?? undefined
    }),
    [activeEngineSession?.settings]
  );
  const activeSessionState = useMemo<AgentSessionState | null>(() => {
    if (!activeEngineSession) return null;
    return {
      workspaceId: activeEngineSession.workspaceId,
      agentSessionId: activeEngineSession.agentSessionId,
      agentTargetId: activeEngineSession.agentTargetId,
      provider: activeEngineSession.provider as AgentSessionState["provider"],
      providerSessionId: activeEngineSession.providerSessionId ?? undefined,
      resumable: activeEngineSession.resumable,
      status:
        activeEngineActiveTurn && activeEngineActiveTurn.phase !== "settled"
          ? "working"
          : "ready",
      permissionModeId:
        activeEngineSession.settings?.permissionModeId ?? undefined,
      permissionConfig: activeEngineSession.permissionConfig,
      settings: activeCanonicalComposerSettings,
      pinnedAtUnixMs: activeEngineSession.pinnedAtUnixMs,
      updatedAtUnixMs:
        activeEngineSession.updatedAtUnixMs ??
        activeEngineSession.lastEventUnixMs ??
        activeEngineSession.createdAtUnixMs ??
        0
    };
  }, [
    activeCanonicalComposerSettings,
    activeEngineActiveTurn,
    activeEngineSession
  ]);
  const activeEngineLifecycleError = useEngineSelector(sessionEngine, (state) =>
    selectEngineSessionError(state, activeConversationId)
  );
  const activeEngineQueueError = useEngineSelector(sessionEngine, (state) =>
    selectEnginePromptQueueError(state, activeConversationId)
  );
  const activeEngineInteractionError = useEngineSelector(
    sessionEngine,
    (state) => selectEngineInteractionResponseError(state, activeConversationId)
  );
  const activeEngineSettingsUpdate = useEngineSelector(sessionEngine, (state) =>
    selectEngineSessionSettingsUpdate(state, activeConversationId)
  );
  const activeEngineError =
    activeEngineLifecycleError ??
    activeEngineInteractionError ??
    activeEngineSettingsUpdate?.errorMessage ??
    activeEngineQueueError;
  const isRespondingToInteraction = useEngineSelector(sessionEngine, (state) =>
    selectEngineSessionIsRespondingToInteraction(state, activeConversationId)
  );
  const activeEngineAvailability: "available" | "blocked" | "missing" =
    useEngineSelector(
      sessionEngine,
      (state) =>
        selectEngineSubmitAvailability(state, activeConversationId)?.state ??
        "missing"
    );
  const activeEngineHasPendingInteractions = useEngineSelector(
    sessionEngine,
    (state) => selectEngineHasPendingInteractions(state, activeConversationId)
  );
  const activeEnginePendingInteractions = useEngineSelector(
    sessionEngine,
    (state) => selectEnginePendingInteractions(state, activeConversationId),
    agentActivityInteractionListsEqual
  );

  return {
    activeCancelState,
    activeCanonicalComposerSettings,
    activeEngineActiveTurn,
    activeEngineAvailability,
    activeEngineError,
    activeEngineHasPendingInteractions,
    activeEngineLatestTurn,
    activeEnginePendingInteractions,
    activeEngineSession,
    activeEngineSessionDeleted,
    activeLatestPendingSubmit,
    activePendingActivation,
    activePendingSubmits,
    activeQueuedPromptInFlight: activeQueuedPromptSnapshot?.inFlight ?? null,
    activeQueuedPrompts,
    activeSessionState,
    activeSessionReconcilePending,
    activeSessionReconcileError: activeSessionReconcile?.errorMessage ?? null,
    hasPendingNewActivation,
    hasUnconfirmedSubmit,
    isRespondingToInteraction,
    isSubmitting
  };
}
