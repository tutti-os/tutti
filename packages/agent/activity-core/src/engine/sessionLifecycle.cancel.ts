import type { AgentActivityMessage, AgentActivityTurn } from "../types.ts";
import { reconcileSettingsUpdates } from "./sessionSettings.reducer.ts";
import type { EngineCommand, EngineReducerResult } from "./types.ts";
import type { SessionLifecycleState } from "./sessionLifecycle.types.ts";
import { canonicalTurnKey } from "./sessionEntityKeys.ts";
import {
  initialCancel,
  setCancel,
  setOperation
} from "./sessionLifecycle.state.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];
export const TURN_CANCEL_TIMEOUT_MS = 30_000;

export function reconcilePendingCancels(
  previous: SessionLifecycleState,
  next: SessionLifecycleState
): EngineReducerResult<SessionLifecycleState> {
  const settings = reconcileSettingsUpdates(previous, next);
  const commands: EngineCommand[] = [...settings.commands];
  let state = settings.state;
  for (const [id, operation] of Object.entries(state.operationBySessionId)) {
    const session = state.sessionsById[id];
    const activeTurn = session?.activeTurnId
      ? state.turnsById[canonicalTurnKey(id, session.activeTurnId)]
      : null;
    const reconciledOperation = state.operationBySessionId[id] ?? operation;
    const targetedTurn = reconciledOperation.cancel.turnId
      ? state.turnsById[canonicalTurnKey(id, reconciledOperation.cancel.turnId)]
      : null;
    const turn = targetedTurn ?? activeTurn;
    if (
      reconciledOperation.cancel.status === "awaitingTurn" &&
      session &&
      turn &&
      turn.phase !== "settled" &&
      reconciledOperation.cancel.commandId &&
      (!reconciledOperation.cancel.requestedWorkspaceId ||
        session.workspaceId ===
          reconciledOperation.cancel.requestedWorkspaceId) &&
      (!reconciledOperation.cancel.targetClientSubmitId ||
        reconciledOperation.cancel.turnId === turn.turnId)
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
      (!activeTurn || activeTurn.phase === "settled")
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

export function reconcilePendingCancelFromMessages(
  state: SessionLifecycleState,
  messages: readonly AgentActivityMessage[]
): EngineReducerResult<SessionLifecycleState> {
  let next = state;
  for (const message of messages) {
    const clientSubmitId = message.payload?.clientSubmitId;
    const turnId = message.turnId?.trim() ?? "";
    if (
      typeof clientSubmitId !== "string" ||
      !clientSubmitId.trim() ||
      !turnId
    ) {
      continue;
    }
    const agentSessionId = message.agentSessionId.trim();
    const operation = next.operationBySessionId[agentSessionId];
    const messageWorkspaceId = message.workspaceId?.trim() ?? "";
    if (
      !operation ||
      operation.cancel.status !== "awaitingTurn" ||
      operation.cancel.targetClientSubmitId !== clientSubmitId.trim() ||
      (operation.cancel.turnId && operation.cancel.turnId !== turnId) ||
      (messageWorkspaceId &&
        messageWorkspaceId !== operation.cancel.requestedWorkspaceId)
    ) {
      continue;
    }
    next = setCancel(next, agentSessionId, {
      ...operation.cancel,
      turnId
    });
  }
  return next === state
    ? unchanged(state)
    : reconcilePendingCancels(state, next);
}

export function reconcilePendingCancelForSubmit(
  previous: SessionLifecycleState,
  next: SessionLifecycleState,
  clientSubmitId: string,
  turn: AgentActivityTurn
): EngineReducerResult<SessionLifecycleState> {
  const targetClientSubmitId = clientSubmitId.trim();
  if (!targetClientSubmitId || turn.phase === "settled") {
    return result(next);
  }
  const operation = next.operationBySessionId[turn.agentSessionId];
  if (
    !operation ||
    operation.cancel.status !== "awaitingTurn" ||
    operation.cancel.targetClientSubmitId !== targetClientSubmitId ||
    !operation.cancel.commandId
  ) {
    return result(next);
  }
  const session = next.sessionsById[turn.agentSessionId];
  if (
    !session ||
    session.workspaceId.trim() === "" ||
    (operation.cancel.requestedWorkspaceId !== null &&
      session.workspaceId !== operation.cancel.requestedWorkspaceId)
  ) {
    return result(next);
  }
  const commands: EngineCommand[] = [];
  if (operation.cancel.expiryId) {
    commands.push({
      type: "engine/cancelExpiry",
      expiryId: operation.cancel.expiryId
    });
  }
  commands.push(
    cancelCommand(
      session.workspaceId,
      turn.agentSessionId,
      turn,
      operation.cancel.commandId
    )
  );
  const state = setCancel(next, turn.agentSessionId, {
    ...operation.cancel,
    expiryId: null,
    status: "requested",
    turnId: turn.turnId
  });
  return previous === state && commands.length === 0
    ? unchanged(previous)
    : { commands, state };
}

export function cancelCommand(
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

export function clearCancel(
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

export function sessionVersion(session: {
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

function removeDetachedOperation(
  state: SessionLifecycleState,
  id: string
): SessionLifecycleState {
  const operationBySessionId = { ...state.operationBySessionId };
  delete operationBySessionId[id];
  return { ...state, operationBySessionId };
}
