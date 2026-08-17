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
import { canonicalTurnKey } from "./sessionEntityKeys.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];

interface AttentionReadStateContext {
  previousSessionsById: Readonly<
    Record<string, { userId?: string; latestTurn?: AgentActivityTurn | null }>
  >;
  previousTurnsById: Readonly<Record<string, AgentActivityTurn>>;
  sessionsById: Readonly<
    Record<string, { userId?: string; latestTurn?: AgentActivityTurn | null }>
  >;
  turnsById: Readonly<Record<string, AgentActivityTurn>>;
}

interface CompletionKeyParts {
  agentSessionId: string;
  completionKey: string;
  kind: AttentionCompletionKind;
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
      return removeUnread(state, intent.userId, intent.agentSessionId);
    case "attention/unreadRequested":
      return requestUnread(
        state,
        intent.userId,
        intent.agentSessionId,
        context
      );
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
      if (intent.type === "turn/upserted" && intent.live === false) {
        return unchanged(state);
      }
      const turn = acceptedCanonicalTurn(intent.turn, context);
      const userId = context.sessionsById[turn?.agentSessionId ?? ""]?.userId;
      const replayAcceptedLiveCompletion =
        intent.type === "turn/upserted" &&
        intent.replayAcceptedLiveCompletion === true;
      if (
        !turn ||
        userId === undefined ||
        (!replayAcceptedLiveCompletion &&
          !isLiveCompletionTransition(turn, context))
      ) {
        return unchanged(state);
      }
      return observeLiveUnread(state, userId, turn);
    }
    case "session/detailSnapshotReceived":
    case "session/historyAuthoritativeSnapshotReceived":
      // Historical reads own canonical content. Their accepted live completion
      // is replayed explicitly by sessionReconcile as a marked turn upsert.
      return unchanged(state);
    case "session/snapshotReceived":
      // A list snapshot is historical content. It must not create a read
      // marker, create an unread marker, or remove an existing unread marker.
      return unchanged(state);
    case "session/removed":
      return removeSession(state, intent.agentSessionId);
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

function isLiveCompletionTransition(
  turn: AgentActivityTurn,
  context: AttentionReadStateContext
): boolean {
  if (!completionKind(turn)) return false;
  const previous =
    context.previousTurnsById[
      canonicalTurnKey(turn.agentSessionId, turn.turnId)
    ];
  return (
    previous === undefined ||
    previous.phase !== "settled" ||
    previous.outcome !== turn.outcome
  );
}

function observeLiveUnread(
  state: AttentionReadState,
  rawUserId: string,
  turn: AgentActivityTurn
): EngineReducerResult<AttentionReadState> {
  const parts = completionKeyParts(turn);
  const userId = rawUserId.trim();
  if (!parts || !userId) return unchanged(state);
  const partition = partitionFor(state, userId);
  const current = partition.recordsBySessionId[parts.agentSessionId];
  if (current?.completionKey === parts.completionKey) return unchanged(state);

  return upsertUnread(state, userId, parts, false);
}

function requestUnread(
  state: AttentionReadState,
  rawUserId: string,
  rawId: string,
  context: AttentionReadStateContext
): EngineReducerResult<AttentionReadState> {
  const id = rawId.trim();
  const userId = rawUserId.trim();
  if (!id || !userId) return unchanged(state);
  const partition = partitionFor(state, userId);
  const current = partition.recordsBySessionId[id];
  if (current) {
    if (current.markedUnreadByUser) return unchanged(state);
    return upsertUnread(
      state,
      userId,
      {
        agentSessionId: id,
        completionKey: current.completionKey,
        kind: current.kind
      },
      true
    );
  }

  const latestTurn = context.sessionsById[id]?.latestTurn;
  const turn = latestTurn ? acceptedCanonicalTurn(latestTurn, context) : null;
  const parts = turn ? completionKeyParts(turn) : null;
  if (!parts) return unchanged(state);
  return upsertUnread(state, userId, parts, true);
}

function upsertUnread(
  state: AttentionReadState,
  userId: string,
  parts: CompletionKeyParts,
  markedUnreadByUser: boolean
): EngineReducerResult<AttentionReadState> {
  const partition = partitionFor(state, userId);
  const current = partition.recordsBySessionId[parts.agentSessionId];
  const nextPartition: AttentionReadPartition = {
    ...replaceDurableUnread(partition, parts),
    recordsBySessionId: {
      ...partition.recordsBySessionId,
      [parts.agentSessionId]: {
        completionKey: parts.completionKey,
        isUnread: true,
        kind: parts.kind,
        markedUnreadByUser,
        observationProvenance: "live",
        readStateProvenance: markedUnreadByUser ? "durable" : "live"
      }
    }
  };
  if (
    current?.completionKey === parts.completionKey &&
    current.markedUnreadByUser === markedUnreadByUser
  ) {
    return unchanged(state);
  }
  const persistence = queuePersistence(nextPartition, userId);
  return changed(
    replacePartition(state, userId, persistence.partition),
    persistence.commands
  );
}

function removeUnread(
  state: AttentionReadState,
  rawUserId: string,
  rawId: string
): EngineReducerResult<AttentionReadState> {
  const id = rawId.trim();
  const userId = rawUserId.trim();
  if (!id || !userId) return unchanged(state);
  const partition = partitionFor(state, userId);
  const current = partition.recordsBySessionId[id];
  if (!current) return unchanged(state);

  const recordsBySessionId = { ...partition.recordsBySessionId };
  delete recordsBySessionId[id];
  const nextPartition: AttentionReadPartition = {
    ...partition,
    hydrated: removeDurableSessionKeys(partition, id),
    recordsBySessionId
  };
  const persistence = queuePersistence(nextPartition, userId);
  return changed(
    replacePartition(state, userId, persistence.partition),
    persistence.commands
  );
}

function removeSession(
  state: AttentionReadState,
  rawId: string
): EngineReducerResult<AttentionReadState> {
  const id = rawId.trim();
  if (!id) return unchanged(state);
  let next = state;
  const commands: EngineCommand[] = [];
  for (const [userId, partition] of Object.entries(state.partitionsByUserId)) {
    if (!partition.recordsBySessionId[id]) continue;
    const recordsBySessionId = { ...partition.recordsBySessionId };
    delete recordsBySessionId[id];
    const hydrated = removeDurableSessionKeys(partition, id);
    const nextPartition: AttentionReadPartition = {
      ...partition,
      hydrated,
      recordsBySessionId
    };
    const persistence = queuePersistence(nextPartition, userId);
    commands.push(...persistence.commands);
    next = replacePartition(next, userId, persistence.partition);
  }
  return next === state ? unchanged(state) : changed(next, commands);
}

function replaceDurableUnread(
  partition: AttentionReadPartition,
  parts: CompletionKeyParts
): AttentionReadPartition {
  if (!partition.hydrated) return partition;
  const completedUnreadIds = new Set(partition.hydrated.completedUnreadIds);
  const failedUnreadIds = new Set(partition.hydrated.failedUnreadIds);
  evictSessionCompletionKeys(parts.agentSessionId, [
    completedUnreadIds,
    failedUnreadIds
  ]);
  (parts.kind === "completed" ? completedUnreadIds : failedUnreadIds).add(
    parts.completionKey
  );
  return {
    ...partition,
    hydrated: {
      completedReadIds: [],
      completedUnreadIds: [...completedUnreadIds],
      failedReadIds: [],
      failedUnreadIds: [...failedUnreadIds]
    }
  };
}

function removeDurableSessionKeys(
  partition: AttentionReadPartition,
  sessionId: string
): AttentionReadPartition["hydrated"] {
  if (!partition.hydrated) return partition.hydrated;
  const completedUnreadIds = new Set(partition.hydrated.completedUnreadIds);
  const failedUnreadIds = new Set(partition.hydrated.failedUnreadIds);
  evictSessionCompletionKeys(sessionId, [completedUnreadIds, failedUnreadIds]);
  return {
    completedReadIds: [],
    completedUnreadIds: [...completedUnreadIds],
    failedReadIds: [],
    failedUnreadIds: [...failedUnreadIds]
  };
}

function completionKeyParts(
  turn: AgentActivityTurn
): CompletionKeyParts | null {
  const agentSessionId = turn.agentSessionId.trim();
  const turnId = turn.turnId.trim();
  const kind = completionKind(turn);
  if (!agentSessionId || !turnId || !kind) return null;
  return {
    agentSessionId,
    completionKey: `turn:${agentSessionId}:${turnId}:${kind}`,
    kind
  };
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

function hydrate(
  state: AttentionReadState,
  intent: Extract<EngineIntent, { type: "attention/readStateHydrated" }>
): EngineReducerResult<AttentionReadState> {
  const userId = intent.userId.trim();
  if (!userId) return unchanged(state);
  const partition = partitionFor(state, userId);
  const persistedCompletedUnread = sanitizeCompletionKeys(
    intent.completed.unreadIds
  );
  const persistedFailedUnread = sanitizeCompletionKeys(intent.failed.unreadIds);
  const persistedRecords: Record<string, AttentionReadRecord> = {};
  for (const key of persistedCompletedUnread) {
    const parts = parseCompletionKey(key, "completed");
    if (parts)
      persistedRecords[parts.agentSessionId] = unreadRecord(parts, false);
  }
  for (const key of persistedFailedUnread) {
    const parts = parseCompletionKey(key, "failed");
    if (parts && !persistedRecords[parts.agentSessionId]) {
      persistedRecords[parts.agentSessionId] = unreadRecord(parts, false);
    }
  }

  const recordsBySessionId: Record<string, AttentionReadRecord> = {
    ...persistedRecords,
    ...partition.recordsBySessionId
  };
  const completedUnreadIds = new Set(persistedCompletedUnread);
  const failedUnreadIds = new Set(persistedFailedUnread);
  for (const [sessionId, record] of Object.entries(recordsBySessionId)) {
    evictSessionCompletionKeys(sessionId, [
      completedUnreadIds,
      failedUnreadIds
    ]);
    (record.kind === "completed" ? completedUnreadIds : failedUnreadIds).add(
      record.completionKey
    );
  }

  const hydrated = {
    completedReadIds: [],
    completedUnreadIds: [...completedUnreadIds],
    failedReadIds: [],
    failedUnreadIds: [...failedUnreadIds]
  };
  const recordsChanged = !sameRecords(
    partition.recordsBySessionId,
    recordsBySessionId
  );
  const firstHydration = partition.hydrated === null;
  const hydratedChanged =
    !firstHydration &&
    (partition.hydrated?.completedReadIds.length !== 0 ||
      partition.hydrated?.failedReadIds.length !== 0 ||
      !sameStrings(
        partition.hydrated?.completedUnreadIds ?? [],
        hydrated.completedUnreadIds
      ) ||
      !sameStrings(
        partition.hydrated?.failedUnreadIds ?? [],
        hydrated.failedUnreadIds
      ));
  const nextPartition: AttentionReadPartition = {
    ...partition,
    hydrated,
    lastError: null,
    recordsBySessionId
  };
  if (!recordsChanged && !firstHydration && !hydratedChanged) {
    return unchanged(state);
  }
  const persistence = hydratedChanged
    ? queuePersistence(nextPartition, userId)
    : { commands: NO_COMMANDS, partition: nextPartition };
  return changed(
    replacePartition(state, userId, persistence.partition),
    persistence.commands
  );
}

function unreadRecord(
  parts: CompletionKeyParts,
  markedUnreadByUser: boolean
): AttentionReadRecord {
  return {
    completionKey: parts.completionKey,
    isUnread: true,
    kind: parts.kind,
    markedUnreadByUser,
    observationProvenance: "live",
    readStateProvenance: "durable"
  };
}

function parseCompletionKey(
  key: string,
  expectedKind: AttentionCompletionKind
): CompletionKeyParts | null {
  const match = /^turn:([^:]+):([^:]+):(completed|failed)$/.exec(key);
  if (!match) return null;
  const kind = match[3] as AttentionCompletionKind;
  if (kind !== expectedKind) return null;
  const agentSessionId = match[1];
  if (!agentSessionId) return null;
  return {
    agentSessionId,
    completionKey: key,
    kind
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
  return ids.filter((id) => /^turn:[^:]+:[^:]+:(?:completed|failed)$/.test(id));
}

function sameRecords(
  left: Readonly<Record<string, AttentionReadRecord>>,
  right: Readonly<Record<string, AttentionReadRecord>>
): boolean {
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((id) => {
      const a = left[id];
      const b = right[id];
      return (
        a !== undefined &&
        b !== undefined &&
        a.completionKey === b.completionKey &&
        a.isUnread === b.isUnread &&
        a.kind === b.kind &&
        a.markedUnreadByUser === b.markedUnreadByUser &&
        a.observationProvenance === b.observationProvenance &&
        a.readStateProvenance === b.readStateProvenance
      );
    })
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
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
          readIds: [],
          unreadIds: partition.hydrated.completedUnreadIds
        },
        failed: {
          readIds: [],
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
