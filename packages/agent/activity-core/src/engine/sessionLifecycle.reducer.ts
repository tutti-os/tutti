import type { AgentActivityInteraction, AgentActivityTurn } from "../types.ts";
import type { SendInputResultValidation } from "./commandResult.validation.ts";
import type { ScopedSessionResultValidation } from "./commandResult.validation.ts";
import type { CancelResultValidation } from "./commandResult.validation.ts";
import {
  createInitialSettingsUpdate,
  reconcileSettingsUpdates,
  requestSettingsUpdate,
  settleSettingsUpdate
} from "./sessionSettings.reducer.ts";
import type {
  EngineCommand,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";
import {
  type SessionCancelState,
  type SessionLifecycleState,
  type SessionOperationState
} from "./sessionLifecycle.types.ts";
import {
  removeCanonicalSession,
  replaceCanonicalSessionSnapshot,
  upsertCanonicalInteraction,
  upsertCanonicalSession,
  upsertCanonicalTurn
} from "./sessionEntities.reducer.ts";
import {
  canonicalInteractionKey,
  canonicalTurnKey
} from "./sessionEntityKeys.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];
const TURN_CANCEL_TIMEOUT_MS = 30_000;

export function createInitialSessionLifecycleState(): SessionLifecycleState {
  return {
    deletedSessionIds: {},
    interactionsById: {},
    interactionResponsesById: {},
    operationBySessionId: {},
    sessionsById: {},
    turnsById: {}
  };
}

export function sessionLifecycleReducer(
  state: SessionLifecycleState,
  intent: EngineIntent,
  context: {
    queueSendNowRequiresCancel: boolean;
    sendNowSubmitRequiresCancel?: boolean;
    sendResultValidation?: SendInputResultValidation | null;
    interactionResultValidation?: ScopedSessionResultValidation | null;
    settingsResultValidation?: ScopedSessionResultValidation | null;
    cancelResultValidation?: CancelResultValidation | null;
  } = {
    queueSendNowRequiresCancel: false,
    sendNowSubmitRequiresCancel: false
  }
): EngineReducerResult<SessionLifecycleState> {
  switch (intent.type) {
    case "session/snapshotReceived":
      return reconcilePendingCancels(
        state,
        reconcileInteractionResponses(
          state,
          replaceCanonicalSessionSnapshot(
            state,
            intent.sessions,
            initialOperation
          )
        )
      );
    case "session/upserted":
      return reconcilePendingCancels(
        state,
        reconcileInteractionResponses(
          state,
          upsertCanonicalSession(state, intent.session, initialOperation)
        )
      );
    case "session/metadataPatched":
      return patchSessionMetadata(state, intent.agentSessionId, intent.patch);
    case "turn/upserted":
      return reconcilePendingCancels(
        state,
        upsertCanonicalTurn(state, intent.turn)
      );
    case "interaction/upserted":
      return result(
        reconcileInteractionResponse(
          upsertCanonicalInteraction(state, intent.interaction),
          intent.interaction
        )
      );
    case "interaction/responseRequested":
      return requestInteractionResponse(state, intent);
    case "session/removed":
      return removeSession(state, intent.agentSessionId);
    case "session/errorRecorded":
      return updateOperation(state, intent.agentSessionId, (operation) => ({
        ...operation,
        operationError: intent.errorMessage.trim() || operation.operationError
      }));
    case "session/errorCleared":
      return updateOperation(state, intent.agentSessionId, (operation) => ({
        ...operation,
        operationError: null
      }));
    case "session/cancelRequested":
      return requestCancel(state, intent);
    case "session/stopRequested":
      return requestCancel(state, intent);
    case "session/settingsUpdateRequested":
      return requestSettingsUpdate(state, intent);
    case "submit/requested":
      return context.sendNowSubmitRequiresCancel
        ? requestCancel(state, {
            type: "session/cancelRequested",
            agentSessionId: intent.agentSessionId,
            commandId: `submit:cancel:${intent.clientSubmitId}`,
            awaitingTurnExpiresAtUnixMs:
              intent.requestedAtUnixMs + TURN_CANCEL_TIMEOUT_MS,
            timeoutMs: TURN_CANCEL_TIMEOUT_MS,
            workspaceId: intent.workspaceId
          })
        : unchanged(state);
    case "queue/sendNowRequested":
      return context.queueSendNowRequiresCancel
        ? requestCancel(state, {
            type: "session/cancelRequested",
            agentSessionId: intent.agentSessionId,
            commandId: intent.cancelCommandId,
            awaitingTurnExpiresAtUnixMs: intent.awaitingTurnExpiresAtUnixMs,
            timeoutMs: intent.timeoutMs,
            workspaceId:
              state.sessionsById[intent.agentSessionId.trim()]?.workspaceId ??
              ""
          })
        : unchanged(state);
    case "session/cancelAbandoned":
      return clearCancel(state, intent.agentSessionId);
    case "engine/intentExpired":
      return expireCancel(state, intent.expiryId);
    case "engine/commandResult":
      if (intent.commandType === "interaction/respond") {
        const next =
          context.interactionResultValidation?.kind === "valid"
            ? reconcileInteractionResponses(
                state,
                upsertCanonicalSession(
                  state,
                  context.interactionResultValidation.session,
                  initialOperation
                )
              )
            : state;
        return settleInteractionResponse(
          next,
          intent,
          context.interactionResultValidation ?? null
        );
      }
      if (intent.commandType === "session/updateSettings")
        return settleSettingsUpdate(
          context.settingsResultValidation?.kind === "valid"
            ? upsertCanonicalSession(
                state,
                context.settingsResultValidation.session,
                initialOperation
              )
            : state,
          intent,
          context.settingsResultValidation ?? null
        );
      if (intent.commandType === "turn/cancel")
        return settleCancel(
          state,
          intent,
          context.cancelResultValidation ?? null
        );
      if (
        intent.commandType === "queue/sendPrompt" &&
        context.sendResultValidation?.kind === "valid"
      ) {
        const sendResult = context.sendResultValidation.result;
        if (sendResult.kind === "goalControl") {
          return result(
            upsertCanonicalSession(state, sendResult.session, initialOperation)
          );
        }
        const { session, turn } = sendResult;
        return result(
          upsertCanonicalTurn(
            upsertCanonicalSession(state, session, initialOperation),
            turn
          )
        );
      }
      return unchanged(state);
    default:
      return unchanged(state);
  }
}

function requestInteractionResponse(
  state: SessionLifecycleState,
  intent: Extract<EngineIntent, { type: "interaction/responseRequested" }>
): EngineReducerResult<SessionLifecycleState> {
  const agentSessionId = intent.agentSessionId.trim();
  const requestId = intent.requestId.trim();
  const turnId = intent.turnId.trim();
  const workspaceId = intent.workspaceId.trim();
  const commandId = intent.commandId.trim();
  const key = canonicalInteractionKey(agentSessionId, turnId, requestId);
  const interaction = state.interactionsById[key];
  const existing = state.interactionResponsesById[key];
  const action = intent.action?.trim() || null;
  const optionId = intent.optionId?.trim() || null;
  const payload = intent.payload ? { ...intent.payload } : null;
  if (
    !agentSessionId ||
    !requestId ||
    !turnId ||
    !workspaceId ||
    !commandId ||
    state.sessionsById[agentSessionId]?.workspaceId !== workspaceId ||
    interaction?.status !== "pending" ||
    existing?.status === "responding" ||
    (existing &&
      (existing.status === "unknown" || existing.status === "failed") &&
      (intent.retry !== true ||
        existing.action !== action ||
        existing.optionId !== optionId ||
        JSON.stringify(existing.payload) !== JSON.stringify(payload)))
  ) {
    return unchanged(state);
  }
  return {
    commands: [
      {
        ...(action ? { action } : {}),
        agentSessionId,
        commandId,
        correlationId: key,
        ...(optionId ? { optionId } : {}),
        ...(payload ? { payload } : {}),
        requestId,
        turnId,
        ...(intent.timeoutMs !== undefined
          ? { timeoutMs: intent.timeoutMs }
          : {}),
        type: "interaction/respond",
        workspaceId
      }
    ],
    state: replaceInteractionResponse(state, key, {
      action,
      agentSessionId,
      commandId,
      errorCode: null,
      errorMessage: null,
      optionId,
      payload,
      requestId,
      turnId,
      status: "responding",
      workspaceId
    })
  };
}

function settleInteractionResponse(
  state: SessionLifecycleState,
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>,
  validation: ScopedSessionResultValidation | null
): EngineReducerResult<SessionLifecycleState> {
  const entry = Object.entries(state.interactionResponsesById).find(
    ([key, response]) =>
      response.commandId === intent.commandId &&
      key === (intent.correlationId?.trim() ?? "")
  );
  if (!entry) return unchanged(state);
  const [key, response] = entry;
  if (intent.outcome === "failed") {
    return result(
      replaceInteractionResponse(state, key, {
        ...response,
        errorCode: intent.errorCode ?? null,
        errorMessage: intent.errorMessage?.trim() || null,
        status: "failed"
      })
    );
  }
  return result(
    replaceInteractionResponse(state, key, {
      ...response,
      errorCode:
        intent.outcome === "timedOut"
          ? "timeout"
          : validation?.kind === "invalid"
            ? "invalid_command_result"
            : null,
      errorMessage: intent.errorMessage?.trim() || null,
      status: "unknown"
    })
  );
}

function reconcileInteractionResponse(
  state: SessionLifecycleState,
  interaction: AgentActivityInteraction
): SessionLifecycleState {
  if (interaction.status === "pending") return state;
  const key = canonicalInteractionKey(
    interaction.agentSessionId,
    interaction.turnId,
    interaction.requestId
  );
  if (!state.interactionResponsesById[key]) return state;
  const responses = { ...state.interactionResponsesById };
  delete responses[key];
  return { ...state, interactionResponsesById: responses };
}

function reconcileInteractionResponses(
  previous: SessionLifecycleState,
  next: SessionLifecycleState
): SessionLifecycleState {
  let responses: Record<
    string,
    import("./sessionLifecycle.types.ts").InteractionResponseState
  > | null = null;
  for (const [key] of Object.entries(previous.interactionResponsesById)) {
    const interaction = next.interactionsById[key];
    const authoritativelyRemoved =
      !interaction && Boolean(previous.interactionsById[key]);
    if (interaction?.status !== "pending" || authoritativelyRemoved) {
      responses ??= { ...next.interactionResponsesById };
      delete responses[key];
    }
  }
  return responses ? { ...next, interactionResponsesById: responses } : next;
}

function replaceInteractionResponse(
  state: SessionLifecycleState,
  key: string,
  response: import("./sessionLifecycle.types.ts").InteractionResponseState
): SessionLifecycleState {
  return {
    ...state,
    interactionResponsesById: {
      ...state.interactionResponsesById,
      [key]: response
    }
  };
}

function patchSessionMetadata(
  state: SessionLifecycleState,
  rawId: string,
  patch: Extract<EngineIntent, { type: "session/metadataPatched" }>["patch"]
): EngineReducerResult<SessionLifecycleState> {
  const id = rawId.trim();
  const session = state.sessionsById[id];
  if (!session) return unchanged(state);
  const next = { ...session, ...patch };
  const changed = Object.entries(patch).some(
    ([key, value]) => session[key as keyof typeof session] !== value
  );
  return changed
    ? result({
        ...state,
        sessionsById: { ...state.sessionsById, [id]: next }
      })
    : unchanged(state);
}

function requestCancel(
  state: SessionLifecycleState,
  intent: Extract<
    EngineIntent,
    { type: "session/cancelRequested" | "session/stopRequested" }
  >
): EngineReducerResult<SessionLifecycleState> {
  const id = intent.agentSessionId.trim();
  const session = state.sessionsById[id];
  const workspaceId = intent.workspaceId.trim();
  if (
    !id ||
    !workspaceId ||
    state.deletedSessionIds[id] ||
    (session && session.workspaceId !== workspaceId)
  ) {
    return unchanged(state);
  }
  let nextState = state;
  let operation = state.operationBySessionId[id];
  if (!operation) {
    operation = initialOperation();
    nextState = setOperation(state, id, operation);
  }
  if (cancelPending(operation.cancel)) return unchanged(nextState);
  const activeTurnId = session?.activeTurnId ?? null;
  const turn = activeTurnId
    ? state.turnsById[canonicalTurnKey(id, activeTurnId)]
    : null;
  if (turn && turn.phase !== "settled") {
    const next = setCancel(
      nextState,
      id,
      requestedCancel(intent.commandId, turn.turnId, workspaceId)
    );
    return {
      commands: [
        cancelCommand(workspaceId, id, turn, intent.commandId, intent.timeoutMs)
      ],
      state: next
    };
  }
  const expiryId = `cancel:awaiting-turn:${intent.commandId}`;
  const next = setCancel(nextState, id, {
    ...requestedCancel(intent.commandId, null, workspaceId),
    expiryId,
    requestedSessionVersion: session ? sessionVersion(session) : null,
    status: "awaitingTurn"
  });
  return {
    commands: [
      {
        type: "engine/scheduleExpiry",
        expiryId,
        dueAtUnixMs: intent.awaitingTurnExpiresAtUnixMs
      }
    ],
    state: next
  };
}

function reconcilePendingCancels(
  previous: SessionLifecycleState,
  next: SessionLifecycleState
): EngineReducerResult<SessionLifecycleState> {
  const settings = reconcileSettingsUpdates(previous, next);
  const commands: EngineCommand[] = [...settings.commands];
  let state = settings.state;
  for (const [id, operation] of Object.entries(state.operationBySessionId)) {
    const session = state.sessionsById[id];
    const turn = session?.activeTurnId
      ? state.turnsById[canonicalTurnKey(id, session.activeTurnId)]
      : null;
    const reconciledOperation = state.operationBySessionId[id] ?? operation;
    if (
      reconciledOperation.cancel.status === "awaitingTurn" &&
      session &&
      turn &&
      turn.phase !== "settled" &&
      reconciledOperation.cancel.commandId
    ) {
      if (reconciledOperation.cancel.expiryId)
        commands.push({
          type: "engine/cancelExpiry",
          expiryId: reconciledOperation.cancel.expiryId
        });
      commands.push(
        cancelCommand(
          session.workspaceId,
          id,
          turn,
          reconciledOperation.cancel.commandId
        )
      );
      state = setCancel(state, id, {
        ...reconciledOperation.cancel,
        expiryId: null,
        status: "requested",
        turnId: turn.turnId
      });
    } else if (
      reconciledOperation.cancel.status !== "idle" &&
      reconciledOperation.cancel.status !== "awaitingTurn" &&
      (!turn || turn.phase === "settled")
    ) {
      state = setOperation(state, id, {
        ...reconciledOperation,
        cancel: initialCancel(),
        operationError: null
      });
    }
  }
  return state === previous && commands.length === 0
    ? unchanged(previous)
    : { commands, state };
}

function settleCancel(
  state: SessionLifecycleState,
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>,
  validation: CancelResultValidation | null
): EngineReducerResult<SessionLifecycleState> {
  const entry = Object.entries(state.operationBySessionId).find(
    ([, value]) => value.cancel.commandId === intent.commandId
  );
  if (!entry) return unchanged(state);
  const [id, operation] = entry;
  if (intent.outcome !== "succeeded") {
    const message = intent.errorMessage?.trim() || null;
    return result(
      setOperation(state, id, {
        ...operation,
        cancel: {
          ...operation.cancel,
          errorCode: intent.errorCode ?? null,
          errorMessage: message,
          status: "failed"
        },
        operationError: message
      })
    );
  }
  if (validation?.kind !== "valid") {
    const cancel = {
      ...operation.cancel,
      errorCode: "invalid_command_result",
      errorMessage: null,
      status: "unknown" as const
    };
    return {
      commands: [
        {
          type: "engine/reconcileWorkspace",
          commandId: `engine:reconcile:cancel:${intent.commandId}`,
          workspaceId: operation.cancel.requestedWorkspaceId ?? ""
        }
      ],
      state: setOperation(state, id, { ...operation, cancel })
    };
  }
  const response = validation.response;
  const targetId = operation.cancel.turnId;
  const responseTurn = response.turn ?? null;
  let next =
    responseTurn?.agentSessionId === id
      ? upsertCanonicalTurn(state, responseTurn)
      : state;
  const targetGone =
    response?.cancel.reason === "not_found" ||
    response?.cancel.reason === "already_settled";
  const cancelAccepted = response.cancel.reason === "cancel_requested";
  const target = targetId
    ? next.turnsById[canonicalTurnKey(id, targetId)]
    : null;
  if (targetId && (target?.phase === "settled" || targetGone)) {
    const session = next.sessionsById[id];
    if (session?.activeTurnId === targetId) {
      next = {
        ...next,
        sessionsById: {
          ...next.sessionsById,
          [id]: { ...session, activeTurnId: null }
        }
      };
    }
  }
  next = setOperation(next, id, {
    ...operation,
    cancel: cancelAccepted
      ? {
          ...operation.cancel,
          errorCode: null,
          errorMessage: null,
          status: "accepted"
        }
      : initialCancel(),
    operationError: null
  });
  const commands: EngineCommand[] =
    targetGone || (responseTurn !== null && responseTurn.agentSessionId !== id)
      ? [
          {
            type: "engine/reconcileWorkspace",
            commandId: `engine:reconcile:cancel:${intent.commandId}`,
            workspaceId: next.sessionsById[id]?.workspaceId ?? ""
          }
        ]
      : [];
  return { commands, state: next };
}

function removeSession(
  state: SessionLifecycleState,
  rawId: string
): EngineReducerResult<SessionLifecycleState> {
  const id = rawId.trim();
  if (!id || state.deletedSessionIds[id]) return unchanged(state);
  const expiryId = state.operationBySessionId[id]?.cancel.expiryId;
  const removed = removeCanonicalSession(state, id);
  const interactionResponsesById = Object.fromEntries(
    Object.entries(removed.interactionResponsesById).filter(
      ([, response]) => response.agentSessionId !== id
    )
  );
  return {
    commands: expiryId
      ? [{ type: "engine/cancelExpiry", expiryId }]
      : NO_COMMANDS,
    state: {
      ...removed,
      deletedSessionIds: { ...removed.deletedSessionIds, [id]: true },
      interactionResponsesById
    }
  };
}

function expireCancel(
  state: SessionLifecycleState,
  expiryId: string
): EngineReducerResult<SessionLifecycleState> {
  const entry = Object.entries(state.operationBySessionId).find(
    ([, value]) => value.cancel.expiryId === expiryId
  );
  return entry ? clearCancel(state, entry[0]) : unchanged(state);
}

function clearCancel(
  state: SessionLifecycleState,
  id: string
): EngineReducerResult<SessionLifecycleState> {
  const operation = state.operationBySessionId[id];
  if (!operation || operation.cancel.status === "idle") return unchanged(state);
  const nextState = state.sessionsById[id]
    ? setCancel(state, id, initialCancel())
    : removeDetachedOperation(state, id);
  return {
    commands: operation.cancel.expiryId
      ? [{ type: "engine/cancelExpiry", expiryId: operation.cancel.expiryId }]
      : NO_COMMANDS,
    state: nextState
  };
}

function removeDetachedOperation(
  state: SessionLifecycleState,
  id: string
): SessionLifecycleState {
  const operationBySessionId = { ...state.operationBySessionId };
  delete operationBySessionId[id];
  return { ...state, operationBySessionId };
}

function updateOperation(
  state: SessionLifecycleState,
  id: string,
  update: (value: SessionOperationState) => SessionOperationState
): EngineReducerResult<SessionLifecycleState> {
  const current = state.operationBySessionId[id.trim()];
  return current
    ? result(setOperation(state, id.trim(), update(current)))
    : unchanged(state);
}
function setCancel(
  state: SessionLifecycleState,
  id: string,
  cancel: SessionCancelState
): SessionLifecycleState {
  const operation = state.operationBySessionId[id];
  return operation ? setOperation(state, id, { ...operation, cancel }) : state;
}
function setOperation(
  state: SessionLifecycleState,
  id: string,
  operation: SessionOperationState
): SessionLifecycleState {
  return {
    ...state,
    operationBySessionId: { ...state.operationBySessionId, [id]: operation }
  };
}
function initialOperation(): SessionOperationState {
  return {
    cancel: initialCancel(),
    operationError: null,
    settingsUpdate: createInitialSettingsUpdate()
  };
}
function initialCancel(): SessionCancelState {
  return {
    commandId: null,
    errorCode: null,
    errorMessage: null,
    expiryId: null,
    requestedSessionVersion: null,
    requestedWorkspaceId: null,
    status: "idle",
    turnId: null
  };
}
function requestedCancel(
  commandId: string,
  turnId: string | null,
  requestedWorkspaceId: string
): SessionCancelState {
  return {
    ...initialCancel(),
    commandId,
    requestedWorkspaceId,
    status: "requested",
    turnId
  };
}
function cancelPending(cancel: SessionCancelState): boolean {
  return cancel.status === "requested" || cancel.status === "awaitingTurn";
}
function cancelCommand(
  workspaceId: string,
  agentSessionId: string,
  turn: AgentActivityTurn,
  commandId: string,
  timeoutMs = TURN_CANCEL_TIMEOUT_MS
): EngineCommand {
  return {
    type: "turn/cancel",
    workspaceId,
    agentSessionId,
    turnId: turn.turnId,
    commandId,
    timeoutMs
  };
}
function sessionVersion(session: {
  updatedAtUnixMs?: number;
  lastEventUnixMs?: number;
  messageVersion?: number;
  createdAtUnixMs?: number;
  startedAtUnixMs?: number;
}): number | null {
  return (
    session.updatedAtUnixMs ??
    session.lastEventUnixMs ??
    session.messageVersion ??
    session.createdAtUnixMs ??
    session.startedAtUnixMs ??
    null
  );
}
function result(
  state: SessionLifecycleState
): EngineReducerResult<SessionLifecycleState> {
  return { commands: NO_COMMANDS, state };
}
function unchanged(
  state: SessionLifecycleState
): EngineReducerResult<SessionLifecycleState> {
  return { commands: NO_COMMANDS, state };
}
