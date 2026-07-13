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

const NO_COMMANDS: readonly EngineCommand[] = [];

export function createInitialAttentionReadState(): AttentionReadState {
  return { partitionsByUserId: {} };
}

export function attentionReadStateReducer(
  state: AttentionReadState,
  intent: EngineIntent,
  context: {
    sessionsById: Readonly<Record<string, { userId?: string }>>;
    turnsById: Readonly<Record<string, AgentActivityTurn>>;
  } = { sessionsById: {}, turnsById: {} }
): EngineReducerResult<AttentionReadState> {
  switch (intent.type) {
    case "attention/hydrateRequested":
      return requestHydration(state, intent);
    case "attention/readStateHydrated":
      return hydrate(state, intent);
    case "attention/read":
      return setUnread(state, intent.userId, intent.agentSessionId, false);
    case "attention/unreadRequested":
      return setUnread(state, intent.userId, intent.agentSessionId, true);
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
    case "turn/upserted":
      return observeTurn(
        state,
        context.sessionsById[intent.turn.agentSessionId]?.userId ?? "",
        intent.turn,
        true
      );
    case "session/snapshotReceived": {
      let next = state;
      for (const session of intent.sessions) {
        if (session.latestTurn?.phase === "settled") {
          next = observeTurn(
            next,
            session.userId?.trim() ?? "",
            session.latestTurn,
            false
          ).state;
        }
      }
      return next === state ? unchanged(state) : changed(next);
    }
    case "session/upserted": {
      const userId = intent.session.userId?.trim() ?? "";
      if (intent.session.latestTurn?.phase === "settled") {
        return observeTurn(state, userId, intent.session.latestTurn, false);
      }
      const latestSettledTurn = Object.values(context.turnsById)
        .filter(
          (turn) =>
            turn.agentSessionId === intent.session.agentSessionId &&
            turn.phase === "settled"
        )
        .sort((left, right) => right.updatedAtUnixMs - left.updatedAtUnixMs)[0];
      return latestSettledTurn
        ? observeTurn(state, userId, latestSettledTurn, true)
        : unchanged(state);
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
  const isUnread = hydratedUnread(partition, id, kind) ?? live;
  const durablePartition = updateDurableMarker(partition, id, kind, isUnread);
  const nextPartition = {
    ...durablePartition,
    recordsBySessionId: {
      ...durablePartition.recordsBySessionId,
      [id]: { completionKey, isUnread, kind }
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
  id: string,
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
  if (unread.includes(id)) return true;
  if (read.includes(id)) return false;
  return null;
}

function setUnread(
  state: AttentionReadState,
  rawUserId: string,
  rawId: string,
  isUnread: boolean
): EngineReducerResult<AttentionReadState> {
  const id = rawId.trim();
  const userId = rawUserId.trim();
  if (!id || !userId) return unchanged(state);
  const partition = partitionFor(state, userId);
  const current = partition.recordsBySessionId[id];
  if (!current) return unchanged(state);
  const next: AttentionReadRecord = current;
  if (current?.isUnread === isUnread) return unchanged(state);
  const durablePartition = updateDurableMarker(
    partition,
    id,
    current.kind,
    isUnread
  );
  const nextPartition = {
    ...durablePartition,
    recordsBySessionId: {
      ...durablePartition.recordsBySessionId,
      [id]: { ...next, isUnread }
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
  id: string,
  kind: AttentionCompletionKind,
  isUnread: boolean
): AttentionReadPartition {
  if (!partition.hydrated) return partition;
  const readKey = kind === "completed" ? "completedReadIds" : "failedReadIds";
  const unreadKey =
    kind === "completed" ? "completedUnreadIds" : "failedUnreadIds";
  const readIds = new Set(partition.hydrated[readKey]);
  const unreadIds = new Set(partition.hydrated[unreadKey]);
  const completedReadIds = new Set(partition.hydrated.completedReadIds);
  const completedUnreadIds = new Set(partition.hydrated.completedUnreadIds);
  const failedReadIds = new Set(partition.hydrated.failedReadIds);
  const failedUnreadIds = new Set(partition.hydrated.failedUnreadIds);
  for (const bucket of [
    completedReadIds,
    completedUnreadIds,
    failedReadIds,
    failedUnreadIds
  ]) {
    bucket.delete(id);
  }
  readIds.delete(id);
  unreadIds.delete(id);
  (isUnread ? unreadIds : readIds).add(id);
  return {
    ...partition,
    hydrated: {
      completedReadIds: [...completedReadIds],
      completedUnreadIds: [...completedUnreadIds],
      failedReadIds: [...failedReadIds],
      failedUnreadIds: [...failedUnreadIds],
      [readKey]: [...readIds],
      [unreadKey]: [...unreadIds]
    }
  };
}

function hydrate(
  state: AttentionReadState,
  intent: Extract<EngineIntent, { type: "attention/readStateHydrated" }>
): EngineReducerResult<AttentionReadState> {
  const hydrated = {
    completedReadIds: [...intent.completed.readIds],
    completedUnreadIds: [...intent.completed.unreadIds],
    failedReadIds: [...intent.failed.readIds],
    failedUnreadIds: [...intent.failed.unreadIds]
  };
  const userId = intent.userId.trim();
  if (!userId) return unchanged(state);
  const partition = partitionFor(state, userId);
  const recordsBySessionId = { ...partition.recordsBySessionId };
  let mergedObservedRecord = false;
  for (const [id, record] of Object.entries(recordsBySessionId)) {
    const unreadIds =
      record.kind === "completed"
        ? hydrated.completedUnreadIds
        : hydrated.failedUnreadIds;
    const readIds =
      record.kind === "completed"
        ? hydrated.completedReadIds
        : hydrated.failedReadIds;
    if (unreadIds.includes(id)) {
      recordsBySessionId[id] = { ...record, isUnread: true };
    } else if (readIds.includes(id)) {
      recordsBySessionId[id] = { ...record, isUnread: false };
    } else {
      const readKey =
        record.kind === "completed" ? "completedReadIds" : "failedReadIds";
      const unreadKey =
        record.kind === "completed" ? "completedUnreadIds" : "failedUnreadIds";
      hydrated[record.isUnread ? unreadKey : readKey].push(id);
      mergedObservedRecord = true;
    }
  }
  const nextPartition = {
    ...partition,
    hydrated,
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
