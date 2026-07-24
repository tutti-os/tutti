import type { AgentActivityInteraction, AgentActivityTurn } from "../types.ts";
import { shouldUseIncomingInteraction } from "../interactionMonotonicity.ts";
import { areJsonLikeValuesEqual } from "../merge.ts";
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
    const candidateSession = useIncoming
      ? preserveLiveTurnOnTimestampTie(current, incomingSession)
      : current!;
    sessionsById[id] =
      current && areJsonLikeValuesEqual(current, candidateSession)
        ? current
        : candidateSession;
    operationBySessionId[id] =
      state.operationBySessionId[id] ?? createOperation();
    if (useIncoming) {
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
      ...source.latestTurnInteractions,
      ...source.pendingInteractions
    ]) {
      if (interaction.agentSessionId === id) {
        mergeInteractionInto(
          interactionsById,
          state.interactionsById,
          interaction
        );
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
  for (const [id, operation] of Object.entries(state.operationBySessionId)) {
    if (
      !operationBySessionId[id] &&
      operation.cancel.status === "awaitingTurn"
    ) {
      operationBySessionId[id] = operation;
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
  const nextInteractionsById = reuseRecordIfShallowEqual(
    state.interactionsById,
    interactionsById
  );
  const nextOperationBySessionId = reuseRecordIfShallowEqual(
    state.operationBySessionId,
    operationBySessionId
  );
  const nextSessionsById = reuseRecordIfShallowEqual(
    state.sessionsById,
    sessionsById
  );
  const nextTurnsById = reuseRecordIfShallowEqual(state.turnsById, turnsById);
  if (
    nextInteractionsById === state.interactionsById &&
    nextOperationBySessionId === state.operationBySessionId &&
    nextSessionsById === state.sessionsById &&
    nextTurnsById === state.turnsById
  ) {
    return state;
  }
  return {
    ...state,
    interactionsById: nextInteractionsById,
    operationBySessionId: nextOperationBySessionId,
    sessionsById: nextSessionsById,
    turnsById: nextTurnsById
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
  const candidateSession = useIncoming
    ? preserveLiveTurnOnTimestampTie(current, incoming)
    : current!;
  const nextSession =
    current && areJsonLikeValuesEqual(current, candidateSession)
      ? current
      : candidateSession;
  const operationBySessionId = state.operationBySessionId[id]
    ? state.operationBySessionId
    : { ...state.operationBySessionId, [id]: createOperation() };
  let next: SessionLifecycleState =
    operationBySessionId === state.operationBySessionId &&
    nextSession === current
      ? state
      : {
          ...state,
          operationBySessionId,
          sessionsById:
            nextSession === current
              ? state.sessionsById
              : { ...state.sessionsById, [id]: nextSession }
        };
  if (useIncoming && source.activeTurn?.agentSessionId === id) {
    next = upsertCanonicalTurn(next, source.activeTurn);
  }
  if (useIncoming && source.latestTurn?.agentSessionId === id) {
    next = upsertCanonicalTurn(next, source.latestTurn);
  }
  for (const interaction of source.latestTurnInteractions) {
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
  for (const interaction of source.pendingInteractions) {
    next = upsertCanonicalInteraction(next, interaction);
  }
  return next;
}

function removeMissingPendingInteractions(
  state: SessionLifecycleState,
  agentSessionId: string,
  incoming: readonly AgentActivityInteraction[],
  authoritativeVersion: number
): SessionLifecycleState {
  const incomingKeys = new Set(
    incoming.map((item) =>
      canonicalInteractionKey(item.agentSessionId, item.turnId, item.requestId)
    )
  );
  const interactionsById = { ...state.interactionsById };
  let changed = false;
  for (const [key, interaction] of Object.entries(state.interactionsById)) {
    if (
      interaction.agentSessionId === agentSessionId &&
      interaction.status === "pending" &&
      !incomingKeys.has(
        canonicalInteractionKey(
          interaction.agentSessionId,
          interaction.turnId,
          interaction.requestId
        )
      ) &&
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
  const nextTurn = current ? preserveTurnProvenance(current, turn) : turn;
  if (current && areJsonLikeValuesEqual(current, nextTurn)) return state;
  return {
    ...state,
    turnsById: { ...state.turnsById, [key]: { ...nextTurn } }
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
  if (current && areJsonLikeValuesEqual(current, interaction)) return state;
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
  existing: Readonly<Record<string, AgentActivityInteraction>>,
  interaction: AgentActivityInteraction
): void {
  const key = canonicalInteractionKey(
    interaction.agentSessionId,
    interaction.turnId,
    interaction.requestId
  );
  const current = target[key] ?? existing[key];
  if (shouldUseIncomingInteraction(current, interaction)) {
    target[key] =
      current && areJsonLikeValuesEqual(current, interaction)
        ? current
        : { ...interaction };
  }
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
    const candidate = current ? preserveTurnProvenance(current, turn) : turn;
    target[key] =
      current && areJsonLikeValuesEqual(current, candidate)
        ? current
        : { ...candidate };
  }
}

function reuseRecordIfShallowEqual<T>(
  current: Readonly<Record<string, T>>,
  next: Record<string, T>
): Record<string, T> {
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (
    currentKeys.length === nextKeys.length &&
    nextKeys.every((key) => current[key] === next[key])
  ) {
    return current as Record<string, T>;
  }
  return next;
}

/**
 * Turn provenance is assigned once. Realtime and HTTP snapshots may arrive in
 * either order, so lifecycle refreshes must not reclassify an observed Turn or
 * erase source fields omitted by a later payload. An absent optional source
 * field may be completed once, but an explicit null/value is immutable.
 */
function preserveTurnProvenance(
  current: AgentActivityTurn,
  incoming: AgentActivityTurn
): AgentActivityTurn {
  let sourceGoalOperationId = current.sourceGoalOperationId;
  let sourceGoalRevision = current.sourceGoalRevision;
  let sourceGoalRepairEpoch = current.sourceGoalRepairEpoch;
  // Historical provenance is intentionally opaque and must never be filled
  // from a later lifecycle payload.
  const canCompleteGoalSource =
    current.origin !== "legacy_unknown" &&
    (current.origin === "goal_arm" || current.origin === "goal_continuation") &&
    incoming.origin === current.origin;
  if (canCompleteGoalSource) {
    if (sourceGoalOperationId === undefined) {
      sourceGoalOperationId = incoming.sourceGoalOperationId;
    }
    if (sourceGoalRevision === undefined) {
      sourceGoalRevision = incoming.sourceGoalRevision;
    }
    if (sourceGoalRepairEpoch === undefined) {
      sourceGoalRepairEpoch = incoming.sourceGoalRepairEpoch;
    }
  }
  const next = { ...incoming, origin: current.origin };
  if (sourceGoalOperationId === undefined) {
    delete next.sourceGoalOperationId;
  } else {
    next.sourceGoalOperationId = sourceGoalOperationId;
  }
  if (sourceGoalRevision === undefined) {
    delete next.sourceGoalRevision;
  } else {
    next.sourceGoalRevision = sourceGoalRevision;
  }
  if (sourceGoalRepairEpoch === undefined) {
    delete next.sourceGoalRepairEpoch;
  } else {
    next.sourceGoalRepairEpoch = sourceGoalRepairEpoch;
  }
  return next;
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
