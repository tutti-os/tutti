import type { AgentActivityTurn } from "../types.ts";
import type {
  EngineCommand,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";
import type {
  AttentionCompletionKind,
  AttentionReadRecord,
  AttentionReadPartition,
  AttentionReadState
} from "./attentionReadState.types.ts";
import type { CanonicalAgentSession } from "./sessionLifecycle.types.ts";
import { canonicalTurnKey } from "./sessionEntityKeys.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];

interface AttentionReadStateContext {
  previousSessionsById: Readonly<Record<string, CanonicalAgentSession>>;
  previousTurnsById: Readonly<Record<string, AgentActivityTurn>>;
  sessionsById: Readonly<Record<string, { userId?: string }>>;
  turnsById: Readonly<Record<string, AgentActivityTurn>>;
}

export function createInitialAttentionReadState(): AttentionReadState {
  return { partitionsByUserId: {} };
}

export function attentionReadStateReducer(
  state: AttentionReadState,
  intent: EngineIntent,
  context: AttentionReadStateContext = {
    previousSessionsById: {},
    previousTurnsById: {},
    sessionsById: {},
    turnsById: {}
  }
): EngineReducerResult<AttentionReadState> {
  switch (intent.type) {
    case "attention/hydrateRequested":
      return requestHydration(state, intent);
    case "attention/readStateHydrated":
      return hydrate(state, intent);
    case "attention/read":
      return setUnread(
        state,
        intent.userId,
        intent.agentSessionId,
        false,
        false
      );
    case "attention/unreadRequested":
      return setUnread(state, intent.userId, intent.agentSessionId, true, true);
    case "attention/persistRetryRequested":
      return retryPersistence(state, intent.userId);
    case "engine/commandResult":
      if (intent.commandType === "attention/readState/read") {
        return intent.outcome === "succeeded"
          ? hydrateFromCommandResult(state, intent)
          : recordPersistenceError(state, intent);
      }
      if (intent.commandType === "attention/readState/write") {
        return settlePersistenceWrite(state, intent);
      }
      return unchanged(state);
    case "turn/projectionReceived":
    case "turn/upserted": {
      const turn = acceptedCanonicalTurn(intent.turn, context);
      if (!turn) return unchanged(state);
      return observeTurn(
        state,
        context.sessionsById[turn.agentSessionId]?.userId ?? "",
        turn,
        true
      );
    }
    case "session/historyAuthoritativeSnapshotReceived":
      return reconcileAuthoritativeHistoryAttention(state, intent, context);
    case "session/snapshotReceived": {
      let next = state;
      for (const session of intent.sessions) {
        if (session.latestTurn) {
          const turn = acceptedCanonicalTurn(session.latestTurn, context);
          const id = session.agentSessionId.trim();
          const key = canonicalTurnKey(id, session.latestTurn.turnId);
          const snapshotAccepted =
            context.sessionsById[id] !== context.previousSessionsById[id] ||
            turn !== context.previousTurnsById[key];
          if (!turn || !snapshotAccepted) continue;
          next = observeTurn(
            next,
            context.sessionsById[turn.agentSessionId]?.userId ?? "",
            turn,
            false
          ).state;
        }
      }
      return next === state ? unchanged(state) : changed(next);
    }
    case "session/removed": {
      const id = intent.agentSessionId.trim();
      let next = state;
      for (const [userId, partition] of Object.entries(
        state.partitionsByUserId
      )) {
        if (!partition.recordsBySessionId[id]) continue;
        const recordsBySessionId = { ...partition.recordsBySessionId };
        delete recordsBySessionId[id];
        next = replacePartition(next, userId, {
          ...partition,
          recordsBySessionId
        });
      }
      return next === state ? unchanged(state) : changed(next);
    }
    default:
      return unchanged(state);
  }
}

function acceptedCanonicalTurn(
  incoming: AgentActivityTurn,
  context: AttentionReadStateContext
): AgentActivityTurn | null {
  const key = canonicalTurnKey(incoming.agentSessionId, incoming.turnId);
  const turn = context.turnsById[key];
  return turn &&
    turn.phase === incoming.phase &&
    turn.outcome === incoming.outcome &&
    turn.updatedAtUnixMs === incoming.updatedAtUnixMs
    ? turn
    : null;
}

function reconcileAuthoritativeTurns(
  state: AttentionReadState,
  rawSessionId: string,
  turns: readonly AgentActivityTurn[]
): EngineReducerResult<AttentionReadState> {
  const sessionId = rawSessionId.trim();
  if (!sessionId) return unchanged(state);
  const authoritativeCompletionKeys = new Set<string>();
  for (const turn of turns) {
    if (turn.agentSessionId.trim() !== sessionId) continue;
    const turnId = turn.turnId.trim();
    const kind = completionKind(turn);
    if (turnId && kind) {
      authoritativeCompletionKeys.add(`turn:${sessionId}:${turnId}:${kind}`);
    }
  }

  let next = state;
  const commands: EngineCommand[] = [];
  for (const [userId, partition] of Object.entries(state.partitionsByUserId)) {
    const current = partition.recordsBySessionId[sessionId];
    const removeRecord =
      current !== undefined &&
      !authoritativeCompletionKeys.has(current.completionKey);
    const hydrated = partition.hydrated;
    let nextHydrated = hydrated;
    if (hydrated) {
      const completedReadIds = retainAuthoritativeCompletionKeys(
        hydrated.completedReadIds,
        sessionId,
        authoritativeCompletionKeys
      );
      const completedUnreadIds = retainAuthoritativeCompletionKeys(
        hydrated.completedUnreadIds,
        sessionId,
        authoritativeCompletionKeys
      );
      const failedReadIds = retainAuthoritativeCompletionKeys(
        hydrated.failedReadIds,
        sessionId,
        authoritativeCompletionKeys
      );
      const failedUnreadIds = retainAuthoritativeCompletionKeys(
        hydrated.failedUnreadIds,
        sessionId,
        authoritativeCompletionKeys
      );
      if (
        completedReadIds !== hydrated.completedReadIds ||
        completedUnreadIds !== hydrated.completedUnreadIds ||
        failedReadIds !== hydrated.failedReadIds ||
        failedUnreadIds !== hydrated.failedUnreadIds
      ) {
        nextHydrated = {
          completedReadIds,
          completedUnreadIds,
          failedReadIds,
          failedUnreadIds
        };
      }
    }
    if (!removeRecord && nextHydrated === hydrated) continue;

    let recordsBySessionId = partition.recordsBySessionId;
    if (removeRecord) {
      const mutableRecords: Record<string, AttentionReadRecord> = {
        ...partition.recordsBySessionId
      };
      delete mutableRecords[sessionId];
      recordsBySessionId = mutableRecords;
    }
    const reconciledPartition: AttentionReadPartition = {
      ...partition,
      hydrated: nextHydrated,
      recordsBySessionId
    };
    const persistence =
      nextHydrated !== hydrated
        ? queuePersistence(reconciledPartition, userId)
        : { commands: NO_COMMANDS, partition: reconciledPartition };
    commands.push(...persistence.commands);
    next = replacePartition(next, userId, persistence.partition);
  }
  return next === state ? unchanged(state) : changed(next, commands);
}

function reconcileAuthoritativeHistoryAttention(
  state: AttentionReadState,
  intent: Extract<
    EngineIntent,
    { type: "session/historyAuthoritativeSnapshotReceived" }
  >,
  context: AttentionReadStateContext
): EngineReducerResult<AttentionReadState> {
  const reconciled = reconcileAuthoritativeTurns(
    state,
    intent.agentSessionId,
    intent.turns
  );
  const liveTurnId = intent.liveTurnId?.trim() ?? "";
  const incomingLiveTurn = liveTurnId
    ? intent.turns.find((turn) => turn.turnId.trim() === liveTurnId)
    : undefined;
  const liveTurn = incomingLiveTurn
    ? acceptedCanonicalTurn(incomingLiveTurn, context)
    : null;
  if (!liveTurn) return reconciled;
  const observed = observeTurn(
    reconciled.state,
    context.sessionsById[intent.agentSessionId]?.userId ?? "",
    liveTurn,
    true
  );
  return {
    commands: [...reconciled.commands, ...observed.commands],
    state: observed.state
  };
}

function retainAuthoritativeCompletionKeys(
  keys: readonly string[],
  sessionId: string,
  authoritativeCompletionKeys: ReadonlySet<string>
): readonly string[] {
  const prefix = `turn:${sessionId}:`;
  const filtered = keys.filter(
    (key) => !key.startsWith(prefix) || authoritativeCompletionKeys.has(key)
  );
  return filtered.length === keys.length ? keys : filtered;
}

function observeTurn(
  state: AttentionReadState,
  rawUserId: string,
  turn: AgentActivityTurn,
  live: boolean
): EngineReducerResult<AttentionReadState> {
  const id = turn.agentSessionId.trim();
  const userId = rawUserId.trim();
  const turnId = turn.turnId.trim();
  const kind = completionKind(turn);
  if (!id || !userId || !turnId || !kind) return unchanged(state);
  const partition = partitionFor(state, userId);
  const completionKey = `turn:${id}:${turnId}:${kind}`;
  const current = partition.recordsBySessionId[id];
  if (current?.completionKey === completionKey) return unchanged(state);
  const isUnread = hydratedUnread(partition, completionKey, kind) ?? live;
  const durablePartition = updateDurableMarker(
    partition,
    id,
    completionKey,
    kind,
    isUnread
  );
  const nextPartition = {
    ...durablePartition,
    recordsBySessionId: {
      ...durablePartition.recordsBySessionId,
      [id]: { completionKey, isUnread, kind, markedUnreadByUser: false }
    }
  };
  const persistence = queuePersistence(nextPartition, userId);
  return changed(
    replacePartition(state, userId, persistence.partition),
    persistence.commands
  );
}

function completionKind(
  turn: AgentActivityTurn
): AttentionCompletionKind | null {
  if (turn.phase !== "settled") return null;
  return turn.outcome === "failed"
    ? "failed"
    : turn.outcome === "completed"
      ? "completed"
      : null;
}

function hydratedUnread(
  state: AttentionReadPartition,
  completionKey: string,
  kind: AttentionCompletionKind
): boolean | null {
  const hydrated = state.hydrated;
  if (!hydrated) return null;
  const unread =
    kind === "completed"
      ? hydrated.completedUnreadIds
      : hydrated.failedUnreadIds;
  const read =
    kind === "completed" ? hydrated.completedReadIds : hydrated.failedReadIds;
  if (unread.includes(completionKey)) return true;
  if (read.includes(completionKey)) return false;
  return null;
}

function setUnread(
  state: AttentionReadState,
  rawUserId: string,
  rawId: string,
  isUnread: boolean,
  markedUnreadByUser: boolean
): EngineReducerResult<AttentionReadState> {
  const id = rawId.trim();
  const userId = rawUserId.trim();
  if (!id || !userId) return unchanged(state);
  const partition = partitionFor(state, userId);
  const current = partition.recordsBySessionId[id];
  if (!current) return unchanged(state);
  const next: AttentionReadRecord = current;
  if (
    current.isUnread === isUnread &&
    current.markedUnreadByUser === markedUnreadByUser
  ) {
    return unchanged(state);
  }
  const durablePartition = updateDurableMarker(
    partition,
    id,
    current.completionKey,
    current.kind,
    isUnread
  );
  const nextPartition = {
    ...durablePartition,
    recordsBySessionId: {
      ...durablePartition.recordsBySessionId,
      [id]: { ...next, isUnread, markedUnreadByUser }
    }
  };
  const persistence = queuePersistence(nextPartition, userId);
  return changed(
    replacePartition(state, userId, persistence.partition),
    persistence.commands
  );
}

function updateDurableMarker(
  partition: AttentionReadPartition,
  sessionId: string,
  completionKey: string,
  kind: AttentionCompletionKind,
  isUnread: boolean
): AttentionReadPartition {
  if (!partition.hydrated) return partition;
  const completedReadIds = new Set(partition.hydrated.completedReadIds);
  const completedUnreadIds = new Set(partition.hydrated.completedUnreadIds);
  const failedReadIds = new Set(partition.hydrated.failedReadIds);
  const failedUnreadIds = new Set(partition.hydrated.failedUnreadIds);
  // Only the latest completion per session drives the lamp, so evict any prior
  // completion key for this session across every bucket before recording the new
  // one. This keeps the durable set bounded to one key per session (per kind)
  // while still keying on the exact completion so a new turn re-lights.
  evictSessionCompletionKeys(sessionId, [
    completedReadIds,
    completedUnreadIds,
    failedReadIds,
    failedUnreadIds
  ]);
  const read = kind === "completed" ? completedReadIds : failedReadIds;
  const unread = kind === "completed" ? completedUnreadIds : failedUnreadIds;
  (isUnread ? unread : read).add(completionKey);
  return {
    ...partition,
    hydrated: {
      completedReadIds: [...completedReadIds],
      completedUnreadIds: [...completedUnreadIds],
      failedReadIds: [...failedReadIds],
      failedUnreadIds: [...failedUnreadIds]
    }
  };
}

function evictSessionCompletionKeys(
  sessionId: string,
  buckets: readonly Set<string>[]
): void {
  const prefix = `turn:${sessionId}:`;
  for (const bucket of buckets) {
    for (const key of bucket) {
      if (key.startsWith(prefix)) bucket.delete(key);
    }
  }
}

function sanitizeCompletionKeys(ids: readonly string[]): string[] {
  // Durable buckets hold completion keys (`turn:<session>:<turn>:<kind>`). Drop
  // any legacy per-session id left by older builds so it cannot linger; a stale
  // session id never matches a completion-key lookup anyway, and dropping it now
  // keeps the persisted set clean without a bespoke migration.
  return ids.filter((id) => id.startsWith("turn:"));
}

function hydrate(
  state: AttentionReadState,
  intent: Extract<EngineIntent, { type: "attention/readStateHydrated" }>
): EngineReducerResult<AttentionReadState> {
  const userId = intent.userId.trim();
  if (!userId) return unchanged(state);
  const partition = partitionFor(state, userId);
  const completedReadIds = new Set(
    sanitizeCompletionKeys(intent.completed.readIds)
  );
  const completedUnreadIds = new Set(
    sanitizeCompletionKeys(intent.completed.unreadIds)
  );
  const failedReadIds = new Set(sanitizeCompletionKeys(intent.failed.readIds));
  const failedUnreadIds = new Set(
    sanitizeCompletionKeys(intent.failed.unreadIds)
  );
  const recordsBySessionId = { ...partition.recordsBySessionId };
  let mergedObservedRecord = false;
  for (const [id, record] of Object.entries(recordsBySessionId)) {
    const key = record.completionKey;
    const unread =
      record.kind === "completed" ? completedUnreadIds : failedUnreadIds;
    const read = record.kind === "completed" ? completedReadIds : failedReadIds;
    if (unread.has(key)) {
      recordsBySessionId[id] = { ...record, isUnread: true };
    } else if (read.has(key)) {
      recordsBySessionId[id] = {
        ...record,
        isUnread: false,
        markedUnreadByUser: false
      };
    } else {
      // The durable store predates this session's current completion. Evict any
      // prior key for the session so the set stays bounded, then persist the
      // observed provenance on the next write.
      evictSessionCompletionKeys(id, [
        completedReadIds,
        completedUnreadIds,
        failedReadIds,
        failedUnreadIds
      ]);
      (record.isUnread ? unread : read).add(key);
      mergedObservedRecord = true;
    }
  }
  const nextPartition = {
    ...partition,
    hydrated: {
      completedReadIds: [...completedReadIds],
      completedUnreadIds: [...completedUnreadIds],
      failedReadIds: [...failedReadIds],
      failedUnreadIds: [...failedUnreadIds]
    },
    lastError: null,
    recordsBySessionId
  };
  const persistence = mergedObservedRecord
    ? queuePersistence(nextPartition, userId)
    : { commands: NO_COMMANDS, partition: nextPartition };
  return changed(
    replacePartition(state, userId, persistence.partition),
    persistence.commands
  );
}

function requestHydration(
  state: AttentionReadState,
  intent: Extract<EngineIntent, { type: "attention/hydrateRequested" }>
): EngineReducerResult<AttentionReadState> {
  const userId = intent.userId.trim();
  const workspaceId = intent.workspaceId.trim();
  const commandId = intent.commandId.trim();
  if (!userId || !workspaceId || !commandId) return unchanged(state);
  const partition = partitionFor(state, userId);
  const next = replacePartition(state, userId, {
    ...partition,
    lastError: null,
    workspaceId
  });
  return {
    commands: [
      {
        type: "attention/readState/read",
        commandId,
        correlationId: userId,
        userId,
        workspaceId
      }
    ],
    state: next
  };
}

function recordPersistenceError(
  state: AttentionReadState,
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>
): EngineReducerResult<AttentionReadState> {
  const userId = intent.correlationId?.trim() ?? "";
  if (!userId) return unchanged(state);
  const partition = partitionFor(state, userId);
  const lastError =
    intent.errorMessage?.trim() ||
    (intent.outcome === "timedOut"
      ? `${intent.commandType} timed out`
      : `${intent.commandType} failed`);
  if (partition.lastError === lastError) return unchanged(state);
  return changed(replacePartition(state, userId, { ...partition, lastError }));
}

function settlePersistenceWrite(
  state: AttentionReadState,
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>
): EngineReducerResult<AttentionReadState> {
  const userId = intent.correlationId?.trim() ?? "";
  if (!userId) return unchanged(state);
  const partition = state.partitionsByUserId[userId];
  if (!partition || partition.writeInFlightCommandId !== intent.commandId) {
    return unchanged(state);
  }
  const dirty = partition.writeDirty;
  const nextPartition: AttentionReadPartition = {
    ...partition,
    lastError:
      intent.outcome === "succeeded"
        ? null
        : intent.errorMessage?.trim() ||
          (intent.outcome === "timedOut"
            ? `${intent.commandType} timed out`
            : `${intent.commandType} failed`),
    writeDirty: false,
    writeInFlightCommandId: null
  };
  const persistence = dirty
    ? queuePersistence(nextPartition, userId)
    : { commands: NO_COMMANDS, partition: nextPartition };
  return changed(
    replacePartition(state, userId, persistence.partition),
    persistence.commands
  );
}

function retryPersistence(
  state: AttentionReadState,
  rawUserId: string
): EngineReducerResult<AttentionReadState> {
  const userId = rawUserId.trim();
  const partition = state.partitionsByUserId[userId];
  if (!partition?.lastError || partition.writeInFlightCommandId) {
    return unchanged(state);
  }
  const persistence = queuePersistence(partition, userId);
  return changed(
    replacePartition(state, userId, persistence.partition),
    persistence.commands
  );
}

function hydrateFromCommandResult(
  state: AttentionReadState,
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>
): EngineReducerResult<AttentionReadState> {
  const userId = intent.correlationId?.trim() ?? "";
  const snapshot = workspaceAgentReadStateSnapshot(intent.value);
  if (!userId || !snapshot) return unchanged(state);
  return hydrate(state, {
    type: "attention/readStateHydrated",
    userId,
    completed: snapshot.completed,
    failed: snapshot.failed
  });
}

function workspaceAgentReadStateSnapshot(value: unknown): {
  completed: { readIds: readonly string[]; unreadIds: readonly string[] };
  failed: { readIds: readonly string[]; unreadIds: readonly string[] };
} | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Record<string, unknown>;
  const completed = readStateBucket(snapshot.completed);
  const failed = readStateBucket(snapshot.failed);
  return completed && failed ? { completed, failed } : null;
}

function readStateBucket(
  value: unknown
): { readIds: readonly string[]; unreadIds: readonly string[] } | null {
  if (!value || typeof value !== "object") return null;
  const bucket = value as Record<string, unknown>;
  if (!Array.isArray(bucket.readIds) || !Array.isArray(bucket.unreadIds)) {
    return null;
  }
  if (
    !bucket.readIds.every((id) => typeof id === "string") ||
    !bucket.unreadIds.every((id) => typeof id === "string")
  ) {
    return null;
  }
  return { readIds: bucket.readIds, unreadIds: bucket.unreadIds };
}

function queuePersistence(
  partition: AttentionReadPartition,
  userId: string
): {
  commands: readonly EngineCommand[];
  partition: AttentionReadPartition;
} {
  if (!partition.hydrated || !partition.workspaceId) {
    return { commands: NO_COMMANDS, partition };
  }
  if (partition.writeInFlightCommandId) {
    return {
      commands: NO_COMMANDS,
      partition: partition.writeDirty
        ? partition
        : { ...partition, writeDirty: true }
    };
  }
  const writeRevision = partition.writeRevision + 1;
  const commandId = `attention-write:${userId}:${writeRevision}`;
  return {
    commands: [
      {
        type: "attention/readState/write",
        commandId,
        correlationId: userId,
        userId,
        workspaceId: partition.workspaceId,
        completed: {
          readIds: partition.hydrated.completedReadIds,
          unreadIds: partition.hydrated.completedUnreadIds
        },
        failed: {
          readIds: partition.hydrated.failedReadIds,
          unreadIds: partition.hydrated.failedUnreadIds
        }
      }
    ],
    partition: {
      ...partition,
      writeDirty: false,
      writeInFlightCommandId: commandId,
      writeRevision
    }
  };
}

function partitionFor(
  state: AttentionReadState,
  userId: string
): AttentionReadPartition {
  return (
    state.partitionsByUserId[userId] ?? {
      hydrated: null,
      lastError: null,
      recordsBySessionId: {},
      workspaceId: null,
      writeDirty: false,
      writeInFlightCommandId: null,
      writeRevision: 0
    }
  );
}

function replacePartition(
  state: AttentionReadState,
  userId: string,
  partition: AttentionReadPartition
): AttentionReadState {
  return {
    ...state,
    partitionsByUserId: {
      ...state.partitionsByUserId,
      [userId]: partition
    }
  };
}

function changed(
  state: AttentionReadState,
  commands: readonly EngineCommand[] = NO_COMMANDS
): EngineReducerResult<AttentionReadState> {
  return { commands, state };
}
function unchanged(
  state: AttentionReadState
): EngineReducerResult<AttentionReadState> {
  return { commands: NO_COMMANDS, state };
}
