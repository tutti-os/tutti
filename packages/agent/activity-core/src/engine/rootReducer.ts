import {
  createInitialEngineRuntimeState,
  engineRuntimeReducer
} from "./engineRuntime.reducer.ts";
import {
  createInitialPromptQueueState,
  promptQueueReducer
} from "./promptQueue.reducer.ts";
import {
  createInitialPromptExecutionState,
  promptExecutionReducer,
  selectPromptSettingsExecution
} from "./promptExecution.reducer.ts";
import {
  resolvePromptSendNowStrategy,
  resolveQueuedPromptSendNowStrategy
} from "./promptQueue.sendNow.ts";
import {
  canCancelQueuedSubmit,
  isQueuedSubmitDeliveryPending
} from "./promptQueue.lookup.ts";
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
  RootAgentSessionEngineState,
  RootEngineIntent,
  RootEngineReducerResult
} from "./rootReducer.types.ts";
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
import {
  createInitialSessionMessagesState,
  sessionMessagesReducer
} from "./sessionMessages.reducer.ts";
import {
  composerOptionsReducer,
  createInitialComposerOptionsState
} from "./composerOptions.reducer.ts";
import { canonicalTurnKey } from "./sessionEntityKeys.ts";
import { deriveCanonicalSubmitAvailability } from "./sessionLifecycle.availability.ts";
import { activeTurnIdForSession } from "./promptQueue.drainDecision.ts";
import {
  createInitialSessionMutationsState,
  sessionMutationsReducer
} from "./sessionMutations.reducer.ts";
import {
  createInitialTuttiModeActivationState,
  tuttiModeActivationReducer
} from "./tuttiModeActivation.reducer.ts";
import {
  createInitialEditRetryState,
  editRetryReducer
} from "./editRetry.reducer.ts";
import {
  createInitialSessionGoalControlState,
  sessionGoalControlReducer
} from "./sessionGoalControl.reducer.ts";

// Root reducer: static composition of domain reducers, zero business logic.
// Cross-domain read-only context is passed explicitly; domains still own all
// decisions and state transitions in their own reducer.

export function createInitialAgentSessionEngineState(): RootAgentSessionEngineState {
  return {
    attentionReadState: createInitialAttentionReadState(),
    editRetry: createInitialEditRetryState(),
    engineRuntime: createInitialEngineRuntimeState(),
    pendingIntents: createInitialPendingIntentsState(),
    planDecisions: createInitialPlanDecisionState(),
    promptExecutions: createInitialPromptExecutionState(),
    promptQueue: createInitialPromptQueueState(),
    goalControl: createInitialSessionGoalControlState(),
    sessionReconcile: createInitialSessionReconcileState(),
    sessionMutations: createInitialSessionMutationsState(),
    sessionCommands: createInitialSessionCommandsState(),
    sessionLifecycle: createInitialSessionLifecycleState(),
    sessionMessages: createInitialSessionMessagesState(),
    composerOptions: createInitialComposerOptionsState(),
    tuttiModeActivation: createInitialTuttiModeActivationState()
  };
}

export function rootEngineReducer(
  state: RootAgentSessionEngineState,
  intent: RootEngineIntent
): RootEngineReducerResult<RootAgentSessionEngineState> {
  if (intent.type === "prompt/executionRequested") {
    const promptExecutions = promptExecutionReducer(
      state.promptExecutions,
      intent
    );
    return {
      commands: promptExecutions.commands,
      ...(promptExecutions.followUpIntents
        ? { followUpIntents: promptExecutions.followUpIntents }
        : {}),
      state:
        promptExecutions.state === state.promptExecutions
          ? state
          : { ...state, promptExecutions: promptExecutions.state }
    };
  }
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
  const promptSettingsExecution =
    intent.type === "engine/commandResult" &&
    intent.commandType === "session/updateSettings"
      ? selectPromptSettingsExecution(state.promptExecutions, intent.commandId)
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
    ]?.outcome === "completed" &&
    state.sessionLifecycle.operationBySessionId[
      planIntent.agentSessionId.trim()
    ]?.runtimeAvailability.state !== "blocked"
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
  const submitSendNowStrategy =
    submitIntent?.type === "submit/requested" &&
    submitIntent.routing === "send_now"
      ? resolvePromptSendNowStrategy(
          deriveCanonicalSubmitAvailability(
            state.sessionLifecycle,
            submitSessionId
          ),
          submitSession?.capabilities
        )
      : null;
  const queueRecord = submitIntent
    ? state.promptQueue.recordsBySessionId[submitSessionId]
    : undefined;
  // A session whose activation is still in flight is not in sessionsById yet.
  // Plain submits for it are accepted into the queue (they drain once the
  // session upserts) instead of being silently dropped; routings that dispatch
  // straight to the daemon still require the canonical session record.
  const submitSessionScopeValid =
    submitSession !== undefined
      ? submitSession.workspaceId === submitWorkspaceId
      : submitIntent?.type === "submit/requested" &&
        submitIntent.routing !== "immediate";
  const submitRequestAccepted = Boolean(
    submitIntent &&
    submitId &&
    submitSessionId &&
    submitWorkspaceId &&
    submitSessionScopeValid &&
    submitIntent.content.length > 0 &&
    (submitIntent.type !== "submit/requested" ||
      submitIntent.routing !== "send_now" ||
      submitSendNowStrategy !== null) &&
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
  const queuedSendNowTargetTurnId =
    intent.type === "queue/sendNowRequested"
      ? (intent.targetTurnId?.trim() ?? "")
      : "";
  const queuedSendNowCurrentTurnId =
    intent.type === "queue/sendNowRequested"
      ? (activeTurnIdForSession(
          state.sessionLifecycle,
          intent.agentSessionId
        ) ?? "")
      : "";
  const sendNowStrategy =
    intent.type === "submit/requested" && intent.routing === "send_now"
      ? submitSendNowStrategy
      : intent.type === "queue/sendNowRequested"
        ? queuedSendNowTargetTurnId &&
          queuedSendNowTargetTurnId !== queuedSendNowCurrentTurnId
          ? "send_available"
          : resolveQueuedPromptSendNowStrategy(
              state.promptQueue,
              intent.agentSessionId,
              intent.promptId,
              deriveCanonicalSubmitAvailability(
                state.sessionLifecycle,
                intent.agentSessionId
              ),
              state.sessionLifecycle.sessionsById[intent.agentSessionId.trim()]
                ?.capabilities
            )
        : null;
  const expiringSubmitId =
    intent.type === "engine/intentExpired" &&
    intent.expiryId.startsWith("submit:")
      ? intent.expiryId.slice("submit:".length)
      : "";
  const expiringSubmit =
    state.pendingIntents.submitsByClientSubmitId[expiringSubmitId];
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
  const sessionMutations = sessionMutationsReducer(
    state.sessionMutations,
    intent,
    {
      deletedSessionIds: state.sessionLifecycle.deletedSessionIds,
      interactionsById: state.sessionLifecycle.interactionsById,
      sessionsById: state.sessionLifecycle.sessionsById,
      turnsById: state.sessionLifecycle.turnsById
    }
  );
  const sessionLifecycle = sessionLifecycleReducer(
    state.sessionLifecycle,
    intent,
    {
      queueSendNowRequiresCancel: sendNowStrategy === "cancel_then_send",
      sendNowSubmitRequiresCancel:
        intent.type === "submit/requested" &&
        submitRequestAccepted &&
        sendNowStrategy === "cancel_then_send",
      sendResultValidation,
      interactionResultValidation,
      settingsResultValidation,
      cancelResultValidation
    }
  );
  const goalControl = sessionGoalControlReducer(state.goalControl, intent, {
    deletedSessionIds: sessionLifecycle.state.deletedSessionIds,
    sessionsById: sessionLifecycle.state.sessionsById
  });
  const promptExecutions = promptExecutionReducer(
    state.promptExecutions,
    intent,
    { settingsResultValidation }
  );
  const promptQueue = promptQueueReducer(state.promptQueue, intent, {
    cancelResultValidation,
    deletedSessionIds: sessionLifecycle.state.deletedSessionIds,
    interactionResultValidation,
    lifecycle: sessionLifecycle.state,
    planFeedbackAccepted: feedbackAccepted,
    sendResultValidation,
    submitRequestAccepted,
    sendNowStrategy,
    settingsPreconditionPromptCommandId:
      promptSettingsExecution?.promptCommand.commandId ?? null,
    settingsResultValidation
  });
  const attentionReadState = attentionReadStateReducer(
    state.attentionReadState,
    intent,
    {
      previousSessionsById: state.sessionLifecycle.sessionsById,
      previousTurnsById: state.sessionLifecycle.turnsById,
      sessionsById: sessionLifecycle.state.sessionsById,
      turnsById: sessionLifecycle.state.turnsById
    }
  );
  const editRetry = editRetryReducer(state.editRetry, intent);
  const pendingIntents = pendingIntentsReducer(state.pendingIntents, intent, {
    deletedSessionIds: sessionLifecycle.state.deletedSessionIds,
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
    submitDeliveryIsQueuePending: Boolean(
      expiringSubmit &&
      isQueuedSubmitDeliveryPending(
        state.promptQueue,
        expiringSubmit.agentSessionId,
        expiringSubmitId
      )
    ),
    sendResultValidation,
    settingsResultValidation
  });
  const sessionReconcile = sessionReconcileReducer(
    state.sessionReconcile,
    intent,
    {
      deletedSessionIds: state.sessionLifecycle.deletedSessionIds,
      // Once activation is uncertain, the command is no longer the owner of
      // Session visibility. Its recovery follow-up must be allowed to issue
      // the authoritative read that can discover a committed Session.
      pendingNewSessionIds: new Set(
        Object.values(pendingIntents.state.activationsByRequestId)
          .filter(
            (activation) =>
              activation.mode === "new" && activation.status === "requested"
          )
          .map((activation) => activation.agentSessionId)
      ),
      sessionsById: sessionLifecycle.state.sessionsById,
      workspaceReconcileCommandId:
        state.engineRuntime.workspaceReconcile.commandId
    }
  );
  const sessionMessages = sessionMessagesReducer(
    state.sessionMessages,
    intent,
    {
      previousSessionsById: state.sessionLifecycle.sessionsById,
      sessionsById: sessionLifecycle.state.sessionsById
    }
  );
  const composerOptions = composerOptionsReducer(
    state.composerOptions,
    intent,
    {
      settingsResultValidation
    }
  );
  const tuttiModeActivation = tuttiModeActivationReducer(
    state.tuttiModeActivation,
    intent,
    { sessionsById: sessionLifecycle.state.sessionsById }
  );
  const unchanged =
    attentionReadState.state === state.attentionReadState &&
    editRetry.state === state.editRetry &&
    engineRuntime.state === state.engineRuntime &&
    goalControl.state === state.goalControl &&
    pendingIntents.state === state.pendingIntents &&
    planDecisions.state === state.planDecisions &&
    promptExecutions.state === state.promptExecutions &&
    promptQueue.state === state.promptQueue &&
    sessionReconcile.state === state.sessionReconcile &&
    sessionMutations.state === state.sessionMutations &&
    sessionCommands.state === state.sessionCommands &&
    sessionLifecycle.state === state.sessionLifecycle &&
    sessionMessages.state === state.sessionMessages &&
    composerOptions.state === state.composerOptions &&
    tuttiModeActivation.state === state.tuttiModeActivation;
  const nextState = unchanged
    ? state
    : {
        attentionReadState: attentionReadState.state,
        editRetry: editRetry.state,
        engineRuntime: engineRuntime.state,
        goalControl: goalControl.state,
        pendingIntents: pendingIntents.state,
        planDecisions: planDecisions.state,
        promptExecutions: promptExecutions.state,
        promptQueue: promptQueue.state,
        sessionReconcile: sessionReconcile.state,
        sessionMutations: sessionMutations.state,
        sessionCommands: sessionCommands.state,
        sessionLifecycle: sessionLifecycle.state,
        sessionMessages: sessionMessages.state,
        composerOptions: composerOptions.state,
        tuttiModeActivation: tuttiModeActivation.state
      };
  const followUpIntents = [
    ...(editRetry.followUpIntents ?? []),
    ...(goalControl.followUpIntents ?? []),
    ...(sessionReconcile.followUpIntents ?? []),
    ...(sessionMutations.followUpIntents ?? []),
    ...(sessionLifecycle.followUpIntents ?? []),
    ...(pendingIntents.followUpIntents ?? []),
    ...(promptExecutions.followUpIntents ?? []),
    ...(promptQueue.followUpIntents ?? [])
  ];
  return {
    commands: [
      ...attentionReadState.commands,
      ...editRetry.commands,
      ...engineRuntime.commands,
      ...goalControl.commands,
      ...pendingIntents.commands,
      ...planDecisions.commands,
      ...promptExecutions.commands,
      ...sessionReconcile.commands,
      ...sessionMutations.commands,
      ...sessionCommands.commands,
      ...sessionLifecycle.commands,
      ...promptQueue.commands,
      ...composerOptions.commands,
      ...tuttiModeActivation.commands
    ],
    ...(followUpIntents.length > 0 ? { followUpIntents } : {}),
    state: nextState
  };
}
