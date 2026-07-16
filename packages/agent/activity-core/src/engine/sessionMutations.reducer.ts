import type { AgentActivitySession } from "../types.ts";
import type { CanonicalAgentSession } from "./sessionLifecycle.types.ts";
import type {
  EngineCommand,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";
import type {
  SessionDeleteMutationResult,
  SessionMutationRecord,
  SessionMutationsState
} from "./sessionMutations.types.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];
const MAX_SETTLED_SESSION_MUTATIONS = 128;

export function createInitialSessionMutationsState(): SessionMutationsState {
  return { byMutationId: {} };
}

export function sessionMutationsReducer(
  state: SessionMutationsState,
  intent: EngineIntent,
  context: {
    deletedSessionIds: Readonly<Record<string, true>>;
    sessionsById: Readonly<Record<string, CanonicalAgentSession>>;
  }
): EngineReducerResult<SessionMutationsState> {
  if (intent.type === "session/pinRequested") {
    return requestPin(state, intent, context);
  }
  if (intent.type === "sessions/deleteRequested") {
    return requestDelete(state, intent, context);
  }
  if (intent.type !== "engine/commandResult") return unchanged(state);
  if (
    intent.commandType !== "session/setPinned" &&
    intent.commandType !== "sessions/delete"
  ) {
    return unchanged(state);
  }
  const mutationId = intent.correlationId?.trim() ?? "";
  const record = state.byMutationId[mutationId];
  if (
    !record ||
    record.commandId !== intent.commandId ||
    record.status !== "inFlight" ||
    (record.kind === "pin" && intent.commandType !== "session/setPinned") ||
    (record.kind === "delete" && intent.commandType !== "sessions/delete")
  ) {
    return unchanged(state);
  }
  if (intent.outcome === "failed") {
    return replaceRecord(state, {
      ...record,
      errorCode: intent.errorCode ?? null,
      errorMessage: intent.errorMessage?.trim() || null,
      status: "failed"
    });
  }
  if (intent.outcome === "timedOut") {
    return replaceRecord(state, {
      ...record,
      errorCode: "timeout",
      errorMessage: intent.errorMessage?.trim() || null,
      status: "unknown"
    });
  }
  if (record.kind === "pin") {
    const session = validPinResult(intent.value, record);
    if (!session) return invalidResult(state, record);
    return {
      commands: NO_COMMANDS,
      followUpIntents: [{ session, type: "session/upserted" }],
      state: withRecord(state, { ...record, status: "succeeded" })
    };
  }
  const deleteResult = validDeleteResult(intent.value);
  if (!deleteResult) return invalidResult(state, record);
  const removedSessionIds = [
    ...new Set([...record.agentSessionIds, ...deleteResult.removedSessionIds])
  ];
  return {
    commands: NO_COMMANDS,
    followUpIntents: removedSessionIds.map((agentSessionId) => ({
      agentSessionId,
      type: "session/removed" as const
    })),
    state: withRecord(state, {
      ...record,
      deleteResult,
      status: "succeeded"
    })
  };
}

function requestPin(
  state: SessionMutationsState,
  intent: Extract<EngineIntent, { type: "session/pinRequested" }>,
  context: {
    deletedSessionIds: Readonly<Record<string, true>>;
    sessionsById: Readonly<Record<string, CanonicalAgentSession>>;
  }
): EngineReducerResult<SessionMutationsState> {
  const mutationId = intent.mutationId.trim();
  const agentSessionId = intent.agentSessionId.trim();
  const workspaceId = intent.workspaceId.trim();
  const session = context.sessionsById[agentSessionId];
  if (
    !mutationId ||
    !agentSessionId ||
    !workspaceId ||
    state.byMutationId[mutationId] ||
    context.deletedSessionIds[agentSessionId] ||
    session?.workspaceId !== workspaceId ||
    hasInFlightOverlap(state, [agentSessionId])
  ) {
    return unchanged(state);
  }
  const record: Extract<SessionMutationRecord, { kind: "pin" }> = {
    agentSessionIds: [agentSessionId],
    commandId: mutationId,
    errorCode: null,
    errorMessage: null,
    kind: "pin",
    mutationId,
    pinned: intent.pinned,
    status: "inFlight",
    workspaceId
  };
  const currentlyPinned = session.pinnedAtUnixMs != null;
  if (currentlyPinned === intent.pinned) {
    return replaceRecord(state, { ...record, status: "succeeded" });
  }
  return {
    commands: [
      {
        agentSessionId,
        commandId: mutationId,
        correlationId: mutationId,
        pinned: intent.pinned,
        ...(intent.timeoutMs === undefined
          ? {}
          : { timeoutMs: intent.timeoutMs }),
        type: "session/setPinned",
        workspaceId
      }
    ],
    state: withRequestedRecord(state, record)
  };
}

function requestDelete(
  state: SessionMutationsState,
  intent: Extract<EngineIntent, { type: "sessions/deleteRequested" }>,
  context: {
    deletedSessionIds: Readonly<Record<string, true>>;
    sessionsById: Readonly<Record<string, CanonicalAgentSession>>;
  }
): EngineReducerResult<SessionMutationsState> {
  const mutationId = intent.mutationId.trim();
  const workspaceId = intent.workspaceId.trim();
  const agentSessionIds: string[] = [
    ...new Set(intent.agentSessionIds.map((id) => id.trim()).filter(Boolean))
  ];
  if (
    !mutationId ||
    !workspaceId ||
    agentSessionIds.length === 0 ||
    state.byMutationId[mutationId] ||
    hasInFlightOverlap(state, agentSessionIds) ||
    agentSessionIds.some((id) => {
      const session = context.sessionsById[id];
      return session !== undefined && session.workspaceId !== workspaceId;
    })
  ) {
    return unchanged(state);
  }
  const liveSessionIds = agentSessionIds.filter(
    (id) => !context.deletedSessionIds[id]
  );
  const record: Extract<SessionMutationRecord, { kind: "delete" }> = {
    agentSessionIds,
    commandId: mutationId,
    deleteResult: null,
    errorCode: null,
    errorMessage: null,
    kind: "delete",
    mutationId,
    status: "inFlight",
    workspaceId
  };
  if (liveSessionIds.length === 0) {
    return replaceRecord(state, {
      ...record,
      deleteResult: {
        removedMessages: 0,
        removedSessionIds: [],
        removedSessions: 0
      },
      status: "succeeded"
    });
  }
  return {
    commands: [
      {
        agentSessionIds: liveSessionIds,
        commandId: mutationId,
        correlationId: mutationId,
        ...(intent.timeoutMs === undefined
          ? {}
          : { timeoutMs: intent.timeoutMs }),
        type: "sessions/delete",
        workspaceId
      }
    ],
    state: withRequestedRecord(state, record)
  };
}

function hasInFlightOverlap(
  state: SessionMutationsState,
  agentSessionIds: readonly string[]
): boolean {
  const ids = new Set(agentSessionIds);
  return Object.values(state.byMutationId).some(
    (record) =>
      record.status === "inFlight" &&
      record.agentSessionIds.some((id) => ids.has(id))
  );
}

function validPinResult(
  value: unknown,
  record: Extract<SessionMutationRecord, { kind: "pin" }>
): AgentActivitySession | null {
  if (!value || typeof value !== "object") return null;
  const session = (value as { session?: Partial<AgentActivitySession> })
    .session;
  return session?.agentSessionId?.trim() === record.agentSessionIds[0] &&
    session.workspaceId?.trim() === record.workspaceId &&
    Array.isArray(session.latestTurnInteractions) &&
    Array.isArray(session.pendingInteractions)
    ? (session as AgentActivitySession)
    : null;
}

function validDeleteResult(value: unknown): SessionDeleteMutationResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Partial<SessionDeleteMutationResult>;
  if (
    typeof result.removedMessages !== "number" ||
    typeof result.removedSessions !== "number" ||
    !Array.isArray(result.removedSessionIds) ||
    !result.removedSessionIds.every((id) => typeof id === "string")
  ) {
    return null;
  }
  return {
    removedMessages: result.removedMessages,
    removedSessionIds: result.removedSessionIds.map((id) => id.trim()),
    removedSessions: result.removedSessions
  };
}

function invalidResult(
  state: SessionMutationsState,
  record: SessionMutationRecord
): EngineReducerResult<SessionMutationsState> {
  return replaceRecord(state, {
    ...record,
    errorCode: "invalid_command_result",
    errorMessage: null,
    status: "unknown"
  });
}

function replaceRecord(
  state: SessionMutationsState,
  record: SessionMutationRecord
): EngineReducerResult<SessionMutationsState> {
  return { commands: NO_COMMANDS, state: withRecord(state, record) };
}

function withRecord(
  state: SessionMutationsState,
  record: SessionMutationRecord
): SessionMutationsState {
  return boundedMutationState(
    { ...state.byMutationId, [record.mutationId]: record },
    record.mutationId
  );
}

function withRequestedRecord(
  state: SessionMutationsState,
  record: SessionMutationRecord
): SessionMutationsState {
  const ids = new Set(record.agentSessionIds);
  return boundedMutationState(
    {
      ...Object.fromEntries(
        Object.entries(state.byMutationId).filter(
          ([, current]) =>
            current.status === "inFlight" ||
            !current.agentSessionIds.some((id) => ids.has(id))
        )
      ),
      [record.mutationId]: record
    },
    record.mutationId
  );
}

function boundedMutationState(
  records: Readonly<Record<string, SessionMutationRecord>>,
  currentMutationId: string
): SessionMutationsState {
  const entries = Object.entries(records);
  const settled = entries.filter(([, record]) => record.status !== "inFlight");
  const retainedSettledIds = new Set(
    settled
      .filter(([mutationId]) => mutationId !== currentMutationId)
      .slice(-(MAX_SETTLED_SESSION_MUTATIONS - 1))
      .map(([mutationId]) => mutationId)
  );
  retainedSettledIds.add(currentMutationId);
  return {
    byMutationId: Object.fromEntries(
      entries.filter(
        ([mutationId, record]) =>
          record.status === "inFlight" || retainedSettledIds.has(mutationId)
      )
    )
  };
}

function unchanged(
  state: SessionMutationsState
): EngineReducerResult<SessionMutationsState> {
  return { commands: NO_COMMANDS, state };
}
