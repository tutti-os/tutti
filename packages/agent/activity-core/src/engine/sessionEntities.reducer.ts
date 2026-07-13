import type { AgentActivityInteraction, AgentActivityTurn } from "../types.ts";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import type { AgentActivitySessionInput } from "../sessionNormalization.ts";
import type {
  CanonicalAgentSession,
  SessionLifecycleState,
  SessionOperationState
} from "./sessionLifecycle.types.ts";
import {
  canonicalInteractionKey,
  canonicalTurnKey
} from "./sessionEntityKeys.ts";

export function replaceCanonicalSessionSnapshot(
  state: SessionLifecycleState,
  incoming: readonly AgentActivitySessionInput[],
  createOperation: () => SessionOperationState
): SessionLifecycleState {
  const sessionsById: Record<string, CanonicalAgentSession> = {};
  const turnsById: Record<string, AgentActivityTurn> = {};
  const interactionsById: Record<string, AgentActivityInteraction> = {};
  const operationBySessionId: Record<string, SessionOperationState> = {};
  const incomingSessionIds = new Set<string>();
  const authoritativePendingVersionBySessionId: Record<string, number> = {};
  for (const source of incoming) {
    const id = source.agentSessionId.trim();
    if (!id || state.deletedSessionIds[id]) continue;
    incomingSessionIds.add(id);
    const current = state.sessionsById[id];
    const incomingSession = canonicalSession(source);
    const useIncoming = shouldUseIncomingSession(current, incomingSession);
    sessionsById[id] = useIncoming
      ? preserveLiveTurnOnTimestampTie(current, incomingSession)
      : current!;
    operationBySessionId[id] =
      state.operationBySessionId[id] ?? createOperation();
    if (useIncoming && source.pendingInteractions !== undefined) {
      authoritativePendingVersionBySessionId[id] =
        sessionVersion(incomingSession);
    }
    if (useIncoming && source.activeTurn?.agentSessionId === id) {
      mergeTurnInto(turnsById, state.turnsById, source.activeTurn);
    }
    if (useIncoming && source.latestTurn?.agentSessionId === id) {
      mergeTurnInto(turnsById, state.turnsById, source.latestTurn);
    }
    for (const interaction of [
      ...(source.latestTurnInteractions ?? []),
      ...(source.pendingInteractions ?? [])
    ]) {
      if (interaction.agentSessionId === id) {
        mergeInteractionInto(interactionsById, interaction);
      }
    }
  }
  // Session removal is an explicit protocol-v2 event. A list response can be
  // stale or paginated, so omission must not erase a newer locally observed
  // session (for example one created while the list request was in flight).
  for (const [id, session] of Object.entries(state.sessionsById)) {
    if (!sessionsById[id] && !state.deletedSessionIds[id]) {
      sessionsById[id] = session;
      operationBySessionId[id] =
        state.operationBySessionId[id] ?? createOperation();
    }
  }
  for (const turn of Object.values(state.turnsById)) {
    const key = canonicalTurnKey(turn.agentSessionId, turn.turnId);
    if (sessionsById[turn.agentSessionId] && !turnsById[key]) {
      turnsById[key] = turn;
    }
  }
  for (const interaction of Object.values(state.interactionsById)) {
    if (!sessionsById[interaction.agentSessionId]) continue;
    const key = canonicalInteractionKey(
      interaction.agentSessionId,
      interaction.turnId,
      interaction.requestId
    );
    const projected = interactionsById[key];
    const authoritativePendingVersion =
      authoritativePendingVersionBySessionId[interaction.agentSessionId];
    const authoritativelyOmitted =
      !projected &&
      incomingSessionIds.has(interaction.agentSessionId) &&
      interaction.status === "pending" &&
      authoritativePendingVersion !== undefined &&
      authoritativePendingVersion >= interaction.updatedAtUnixMs;
    if (
      !authoritativelyOmitted &&
      (!projected || shouldUseIncomingInteraction(projected, interaction))
    ) {
      interactionsById[key] = interaction;
    }
  }
  return {
    ...state,
    interactionsById,
    operationBySessionId,
    sessionsById,
    turnsById
  };
}

export function upsertCanonicalSession(
  state: SessionLifecycleState,
  source: AgentActivitySessionInput,
  createOperation: () => SessionOperationState
): SessionLifecycleState {
  const id = source.agentSessionId.trim();
  if (!id || state.deletedSessionIds[id]) return state;
  const current = state.sessionsById[id];
  const incoming = canonicalSession(source);
  const useIncoming = shouldUseIncomingSession(current, incoming);
  let next: SessionLifecycleState = {
    ...state,
    operationBySessionId: state.operationBySessionId[id]
      ? state.operationBySessionId
      : { ...state.operationBySessionId, [id]: createOperation() },
    sessionsById: {
      ...state.sessionsById,
      [id]: useIncoming
        ? preserveLiveTurnOnTimestampTie(current, incoming)
        : current!
    }
  };
  if (useIncoming && source.activeTurn?.agentSessionId === id) {
    next = upsertCanonicalTurn(next, source.activeTurn);
  }
  if (useIncoming && source.latestTurn?.agentSessionId === id) {
    next = upsertCanonicalTurn(next, source.latestTurn);
  }
  for (const interaction of source.latestTurnInteractions ?? []) {
    next = upsertCanonicalInteraction(next, interaction);
  }
  if (useIncoming) {
    next = removeMissingPendingInteractions(
      next,
      id,
      source.pendingInteractions,
      sessionVersion(incoming)
    );
  }
  for (const interaction of source.pendingInteractions ?? []) {
    next = upsertCanonicalInteraction(next, interaction);
  }
  return next;
}

function removeMissingPendingInteractions(
  state: SessionLifecycleState,
  agentSessionId: string,
  incoming: readonly AgentActivityInteraction[] | undefined,
  authoritativeVersion: number
): SessionLifecycleState {
  if (!incoming) return state;
  const incomingIds = new Set(incoming.map((item) => item.requestId));
  const interactionsById = { ...state.interactionsById };
  let changed = false;
  for (const [key, interaction] of Object.entries(state.interactionsById)) {
    if (
      interaction.agentSessionId === agentSessionId &&
      interaction.status === "pending" &&
      !incomingIds.has(interaction.requestId) &&
      authoritativeVersion >= interaction.updatedAtUnixMs
    ) {
      delete interactionsById[key];
      changed = true;
    }
  }
  return changed ? { ...state, interactionsById } : state;
}

export function upsertCanonicalTurn(
  state: SessionLifecycleState,
  turn: AgentActivityTurn
): SessionLifecycleState {
  if (
    !turn.agentSessionId.trim() ||
    !turn.turnId.trim() ||
    state.deletedSessionIds[turn.agentSessionId]
  )
    return state;
  const key = canonicalTurnKey(turn.agentSessionId, turn.turnId);
  const current = state.turnsById[key];
  if (current && !shouldUseIncomingTurn(current, turn)) return state;
  return {
    ...state,
    turnsById: { ...state.turnsById, [key]: { ...turn } }
  };
}

export function upsertCanonicalInteraction(
  state: SessionLifecycleState,
  interaction: AgentActivityInteraction
): SessionLifecycleState {
  if (
    !interaction.agentSessionId.trim() ||
    !interaction.requestId.trim() ||
    !interaction.turnId.trim() ||
    state.deletedSessionIds[interaction.agentSessionId]
  ) {
    return state;
  }
  const key = canonicalInteractionKey(
    interaction.agentSessionId,
    interaction.turnId,
    interaction.requestId
  );
  const current = state.interactionsById[key];
  if (!shouldUseIncomingInteraction(current, interaction)) return state;
  return {
    ...state,
    interactionsById: {
      ...state.interactionsById,
      [key]: { ...interaction }
    }
  };
}

function mergeInteractionInto(
  target: Record<string, AgentActivityInteraction>,
  interaction: AgentActivityInteraction
): void {
  const key = canonicalInteractionKey(
    interaction.agentSessionId,
    interaction.turnId,
    interaction.requestId
  );
  if (shouldUseIncomingInteraction(target[key], interaction)) {
    target[key] = { ...interaction };
  }
}

function shouldUseIncomingInteraction(
  current: AgentActivityInteraction | undefined,
  incoming: AgentActivityInteraction
): boolean {
  if (!current) return true;
  if (incoming.updatedAtUnixMs < current.updatedAtUnixMs) return false;
  const currentTerminal = current.status !== "pending";
  const incomingTerminal = incoming.status !== "pending";
  if (currentTerminal && incoming.status !== current.status) return false;
  if (
    incoming.updatedAtUnixMs === current.updatedAtUnixMs &&
    currentTerminal !== incomingTerminal
  ) {
    return incomingTerminal;
  }
  return true;
}

function shouldUseIncomingTurn(
  current: AgentActivityTurn,
  incoming: AgentActivityTurn
): boolean {
  if (incoming.updatedAtUnixMs < current.updatedAtUnixMs) return false;
  if (current.phase === "settled") {
    return incoming.phase === "settled" && incoming.outcome === current.outcome;
  }
  if (!allowedTurnTransition(current.phase, incoming.phase)) return false;
  return true;
}

function allowedTurnTransition(current: string, incoming: string): boolean {
  if (current === incoming) return true;
  switch (current) {
    case "submitted":
      return ["running", "waiting", "settling", "settled"].includes(incoming);
    case "running":
      return ["waiting", "settling", "settled"].includes(incoming);
    case "waiting":
      return ["running", "settling", "settled"].includes(incoming);
    case "settling":
      return incoming === "settled";
    case "settled":
      return false;
    default:
      return false;
  }
}

export function removeCanonicalSession(
  state: SessionLifecycleState,
  agentSessionId: string
): SessionLifecycleState {
  const sessionsById = { ...state.sessionsById };
  const operationBySessionId = { ...state.operationBySessionId };
  delete sessionsById[agentSessionId];
  delete operationBySessionId[agentSessionId];
  return {
    ...state,
    interactionsById: Object.fromEntries(
      Object.entries(state.interactionsById).filter(
        ([, value]) => value.agentSessionId !== agentSessionId
      )
    ),
    operationBySessionId,
    sessionsById,
    turnsById: Object.fromEntries(
      Object.entries(state.turnsById).filter(
        ([, value]) => value.agentSessionId !== agentSessionId
      )
    )
  };
}

function canonicalSession(
  source: AgentActivitySessionInput
): CanonicalAgentSession {
  const normalized = normalizeAgentActivitySession(source);
  const {
    activeTurn: _activeTurn,
    latestTurn: _latestTurn,
    latestTurnInteractions: _latestTurnInteractions,
    pendingInteractions: _pendingInteractions,
    ...session
  } = normalized;
  return { ...session, activeTurnId: normalized.activeTurnId };
}

function mergeTurnInto(
  target: Record<string, AgentActivityTurn>,
  existing: Readonly<Record<string, AgentActivityTurn>>,
  turn: AgentActivityTurn
): void {
  const key = canonicalTurnKey(turn.agentSessionId, turn.turnId);
  const current = target[key] ?? existing[key];
  if (!current || shouldUseIncomingTurn(current, turn)) {
    target[key] = { ...turn };
  }
}

function shouldUseIncomingSession(
  current: CanonicalAgentSession | undefined,
  incoming: CanonicalAgentSession
): boolean {
  return !current || sessionVersion(incoming) >= sessionVersion(current);
}

function preserveLiveTurnOnTimestampTie(
  current: CanonicalAgentSession | undefined,
  incoming: CanonicalAgentSession
): CanonicalAgentSession {
  if (
    current?.activeTurnId &&
    current.activeTurnId !== incoming.activeTurnId &&
    sessionVersion(current) === sessionVersion(incoming)
  ) {
    return { ...incoming, activeTurnId: current.activeTurnId };
  }
  return incoming;
}

function sessionVersion(session: CanonicalAgentSession): number {
  return (
    session.updatedAtUnixMs ??
    session.lastEventUnixMs ??
    session.messageVersion ??
    session.createdAtUnixMs ??
    session.startedAtUnixMs ??
    0
  );
}
