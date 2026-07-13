import {
  createInitialEngineRuntimeState,
  engineRuntimeReducer
} from "./engineRuntime.reducer.ts";
import {
  canPromoteQueuedPrompt,
  createInitialPromptQueueState,
  promptQueueReducer
} from "./promptQueue.reducer.ts";
import { canCancelQueuedSubmit } from "./promptQueue.lookup.ts";
import {
  createInitialPendingIntentsState,
  pendingIntentsReducer
} from "./pendingIntents.reducer.ts";
import {
  createInitialSessionLifecycleState,
  sessionLifecycleReducer
} from "./sessionLifecycle.reducer.ts";
import {
  createInitialSessionReconcileState,
  sessionReconcileReducer
} from "./sessionReconcile.reducer.ts";
import type {
  AgentSessionEngineState,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";
import {
  attentionReadStateReducer,
  createInitialAttentionReadState
} from "./attentionReadState.reducer.ts";
import {
  validateScopedSessionResult,
  validateCancelResult,
  validateSendInputResult
} from "./commandResult.validation.ts";
import {
  createInitialPlanDecisionState,
  planDecisionReducer
} from "./planDecision.reducer.ts";
import {
  createInitialSessionCommandsState,
  sessionCommandsReducer
} from "./sessionCommands.reducer.ts";
import { canonicalTurnKey } from "./sessionEntityKeys.ts";

// Root reducer: static composition of domain reducers, zero business logic.
// Cross-domain read-only context is passed explicitly; domains still own all
// decisions and state transitions in their own reducer.

export function createInitialAgentSessionEngineState(): AgentSessionEngineState {
  return {
    attentionReadState: createInitialAttentionReadState(),
    engineRuntime: createInitialEngineRuntimeState(),
    pendingIntents: createInitialPendingIntentsState(),
    planDecisions: createInitialPlanDecisionState(),
    promptQueue: createInitialPromptQueueState(),
    sessionReconcile: createInitialSessionReconcileState(),
    sessionCommands: createInitialSessionCommandsState(),
    sessionLifecycle: createInitialSessionLifecycleState()
  };
}

export function rootEngineReducer(
  state: AgentSessionEngineState,
  intent: EngineIntent
): EngineReducerResult<AgentSessionEngineState> {
  const sendResultValidation =
    intent.type === "engine/commandResult" &&
    intent.commandType === "queue/sendPrompt" &&
    intent.outcome === "succeeded"
      ? validateSendInputResult(
          intent.value,
          state.pendingIntents.submitsByClientSubmitId[
            intent.correlationId?.trim() ?? ""
          ]
        )
      : null;
  const interactionResponse =
    intent.type === "engine/commandResult" &&
    intent.commandType === "interaction/respond"
      ? Object.values(state.sessionLifecycle.interactionResponsesById).find(
          (response) => response.commandId === intent.commandId
        )
      : undefined;
  const interactionResultValidation =
    intent.type === "engine/commandResult" &&
    intent.commandType === "interaction/respond" &&
    intent.outcome === "succeeded"
      ? validateScopedSessionResult(intent.value, interactionResponse)
      : null;
  const settingsEntry =
    intent.type === "engine/commandResult" &&
    intent.commandType === "session/updateSettings"
      ? Object.entries(state.sessionLifecycle.operationBySessionId).find(
          ([, operation]) =>
            operation.settingsUpdate.commandId === intent.commandId
        )
      : undefined;
  const settingsResultValidation =
    intent.type === "engine/commandResult" &&
    intent.commandType === "session/updateSettings" &&
    intent.outcome === "succeeded"
      ? validateScopedSessionResult(
          intent.value,
          settingsEntry
            ? {
                agentSessionId: settingsEntry[0],
                workspaceId:
                  state.sessionLifecycle.sessionsById[settingsEntry[0]]
                    ?.workspaceId ?? ""
              }
            : (() => {
                const activation =
                  state.pendingIntents.activationsByRequestId[
                    intent.correlationId?.trim() ?? ""
                  ];
                return activation
                  ? {
                      agentSessionId: activation.agentSessionId,
                      workspaceId: activation.workspaceId
                    }
                  : undefined;
              })(),
          true
        )
      : null;
  const cancelEntry =
    intent.type === "engine/commandResult" &&
    intent.commandType === "turn/cancel"
      ? Object.entries(state.sessionLifecycle.operationBySessionId).find(
          ([, operation]) => operation.cancel.commandId === intent.commandId
        )
      : undefined;
  const cancelResultValidation =
    intent.type === "engine/commandResult" &&
    intent.commandType === "turn/cancel" &&
    intent.outcome === "succeeded"
      ? validateCancelResult(
          intent.value,
          cancelEntry
            ? {
                agentSessionId: cancelEntry[0],
                currentTurn: cancelEntry[1].cancel.turnId
                  ? (state.sessionLifecycle.turnsById[
                      canonicalTurnKey(
                        cancelEntry[0],
                        cancelEntry[1].cancel.turnId
                      )
                    ] ?? null)
                  : null,
                turnId: cancelEntry[1].cancel.turnId,
                workspaceMatches:
                  state.sessionLifecycle.sessionsById[cancelEntry[0]]
                    ?.workspaceId === cancelEntry[1].cancel.requestedWorkspaceId
              }
            : undefined
        )
      : null;
  const engineRuntime = engineRuntimeReducer(state.engineRuntime, intent);
  const planIntent =
    intent.type === "plan/decisionRequested" ||
    intent.type === "plan/feedbackRequested" ||
    intent.type === "plan/skipped"
      ? intent
      : null;
  const planTurnValid = Boolean(
    planIntent &&
    !state.sessionLifecycle.deletedSessionIds[planIntent.agentSessionId] &&
    state.sessionLifecycle.sessionsById[planIntent.agentSessionId]
      ?.workspaceId === planIntent.workspaceId &&
    state.sessionLifecycle.turnsById[
      canonicalTurnKey(planIntent.agentSessionId, planIntent.turnId)
    ]?.phase === "settled" &&
    state.sessionLifecycle.turnsById[
      canonicalTurnKey(planIntent.agentSessionId, planIntent.turnId)
    ]?.outcome === "completed"
  );
  const submitIntent =
    intent.type === "submit/requested" ||
    intent.type === "plan/feedbackRequested"
      ? intent
      : null;
  const submitId = submitIntent?.clientSubmitId.trim() ?? "";
  const submitSessionId = submitIntent?.agentSessionId.trim() ?? "";
  const submitWorkspaceId = submitIntent?.workspaceId.trim() ?? "";
  const submitSession = submitSessionId
    ? state.sessionLifecycle.sessionsById[submitSessionId]
    : undefined;
  const queueRecord = submitIntent
    ? state.promptQueue.recordsBySessionId[submitSessionId]
    : undefined;
  const submitRequestAccepted = Boolean(
    submitIntent &&
    submitId &&
    submitSessionId &&
    submitWorkspaceId &&
    submitSession?.workspaceId === submitWorkspaceId &&
    submitIntent.content.length > 0 &&
    !state.sessionLifecycle.deletedSessionIds[submitSessionId] &&
    !state.pendingIntents.submitsByClientSubmitId[submitId] &&
    !queueRecord?.prompts.some(
      (prompt) => prompt.id === submitId || prompt.clientSubmitId === submitId
    ) &&
    queueRecord?.inFlight?.promptId !== submitId &&
    queueRecord?.uncertainDelivery?.promptId !== submitId
  );
  const feedbackAccepted = Boolean(
    intent.type === "plan/feedbackRequested" &&
    planTurnValid &&
    submitRequestAccepted
  );
  const promptQueue = promptQueueReducer(state.promptQueue, intent, {
    deletedSessionIds: state.sessionLifecycle.deletedSessionIds,
    planFeedbackAccepted: feedbackAccepted,
    submitRequestAccepted,
    cancelResultValidation
  });
  const planDecisions = planDecisionReducer(state.planDecisions, intent, {
    feedbackAccepted,
    planTurnValid
  });
  const sessionCommands = sessionCommandsReducer(
    state.sessionCommands,
    intent,
    {
      deletedSessionIds: state.sessionLifecycle.deletedSessionIds
    }
  );
  const sessionLifecycle = sessionLifecycleReducer(
    state.sessionLifecycle,
    intent,
    {
      queuePromotionAccepted:
        intent.type === "queue/promoted" &&
        canPromoteQueuedPrompt(
          state.promptQueue,
          intent.agentSessionId,
          intent.promptId
        ),
      sendResultValidation,
      interactionResultValidation,
      settingsResultValidation,
      cancelResultValidation
    }
  );
  const attentionReadState = attentionReadStateReducer(
    state.attentionReadState,
    intent,
    {
      sessionsById: sessionLifecycle.state.sessionsById,
      turnsById: sessionLifecycle.state.turnsById
    }
  );
  const pendingIntents = pendingIntentsReducer(state.pendingIntents, intent, {
    deletedSessionIds: state.sessionLifecycle.deletedSessionIds,
    turnsById: sessionLifecycle.state.turnsById,
    submitCancellationAccepted:
      intent.type === "submit/canceled" &&
      canCancelQueuedSubmit(
        state.promptQueue,
        intent.agentSessionId,
        intent.clientSubmitId
      ),
    planFeedbackAccepted: feedbackAccepted,
    submitRequestAccepted,
    sendResultValidation,
    settingsResultValidation
  });
  const sessionReconcile = sessionReconcileReducer(
    state.sessionReconcile,
    intent,
    { deletedSessionIds: state.sessionLifecycle.deletedSessionIds }
  );
  const unchanged =
    attentionReadState.state === state.attentionReadState &&
    engineRuntime.state === state.engineRuntime &&
    pendingIntents.state === state.pendingIntents &&
    planDecisions.state === state.planDecisions &&
    promptQueue.state === state.promptQueue &&
    sessionReconcile.state === state.sessionReconcile &&
    sessionCommands.state === state.sessionCommands &&
    sessionLifecycle.state === state.sessionLifecycle;
  const nextState = unchanged
    ? state
    : {
        attentionReadState: attentionReadState.state,
        engineRuntime: engineRuntime.state,
        pendingIntents: pendingIntents.state,
        planDecisions: planDecisions.state,
        promptQueue: promptQueue.state,
        sessionReconcile: sessionReconcile.state,
        sessionCommands: sessionCommands.state,
        sessionLifecycle: sessionLifecycle.state
      };
  return {
    commands: [
      ...attentionReadState.commands,
      ...engineRuntime.commands,
      ...pendingIntents.commands,
      ...planDecisions.commands,
      ...promptQueue.commands,
      ...sessionReconcile.commands,
      ...sessionCommands.commands,
      ...sessionLifecycle.commands
    ],
    state: nextState
  };
}
