import type {
  AgentActivityInteraction,
  AgentActivitySession,
  AgentActivityTurn
} from "../types.ts";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import type { CanonicalAgentSession } from "./sessionLifecycle.types.ts";
import { canonicalTurnKey } from "./sessionEntityKeys.ts";
import {
  validDeleteResult,
  validForkResult,
  validPinResult
} from "./sessionMutationResults.ts";
import type {
  EngineCommand,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";
import type {
  SessionForkThroughTurnMutationRecord,
  SessionMutationRecord,
  SessionMutationsState
} from "./sessionMutations.types.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];
const MAX_SETTLED_SESSION_MUTATIONS = 128;
export const SESSION_FORK_OBSERVATION_ACK_TIMEOUT_MS = 10_000;
export const SESSION_FORK_OBSERVATION_ACK_RETRY_BACKOFF_MS = [
  1_000, 2_000, 5_000, 10_000, 30_000
] as const;

export function createInitialSessionMutationsState(): SessionMutationsState {
  return { byMutationId: {} };
}

export function sessionMutationsReducer(
  state: SessionMutationsState,
  intent: EngineIntent,
  context: {
    deletedSessionIds: Readonly<Record<string, true>>;
    interactionsById?: Readonly<Record<string, AgentActivityInteraction>>;
    sessionsById: Readonly<Record<string, CanonicalAgentSession>>;
    turnsById?: Readonly<Record<string, AgentActivityTurn>>;
  }
): EngineReducerResult<SessionMutationsState> {
  if (intent.type === "session/pinRequested") {
    return requestPin(state, intent, context);
  }
  if (intent.type === "sessions/deleteRequested") {
    return requestDelete(state, intent, context);
  }
  if (intent.type === "session/forkThroughTurnRequested") {
    return requestForkThroughTurn(state, intent, context);
  }
  if (intent.type === "session/upserted") {
    return observeForkedSession(
      state,
      normalizeAgentActivitySession(intent.session)
    );
  }
  if (intent.type === "session/removed") {
    return removeSessionForkCoordination(state, intent.agentSessionId);
  }
  if (intent.type === "engine/intentExpired") {
    return retryForkObservationAck(state, intent.expiryId);
  }
  if (intent.type !== "engine/commandResult") return unchanged(state);
  if (intent.commandType === "session/ackForkObserved") {
    return settleForkObservationAck(state, intent);
  }
  if (
    intent.commandType !== "session/setPinned" &&
    intent.commandType !== "sessions/delete" &&
    intent.commandType !== "session/forkThroughTurn"
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
    (record.kind === "delete" && intent.commandType !== "sessions/delete") ||
    (record.kind === "forkThroughTurn" &&
      intent.commandType !== "session/forkThroughTurn")
  ) {
    return unchanged(state);
  }
  if (intent.outcome === "failed") {
    const errorIdentity =
      intent.errorReason?.trim() || intent.errorCode?.trim() || null;
    const deliveryUnknown =
      record.kind === "forkThroughTurn" &&
      errorIdentity === "agent_session_fork_delivery_unknown";
    return replaceRecord(state, {
      ...record,
      errorCode: errorIdentity,
      errorMessage: intent.errorMessage?.trim() || null,
      status: deliveryUnknown ? "unknown" : "failed"
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
  if (record.kind === "forkThroughTurn") {
    const result = validForkResult(intent.value, record);
    if (!result) return invalidResult(state, record);
    if (result.status === "accepted") {
      // The durable backend operation is still progressing. Keep the Engine
      // mutation pending; the canonical target Session upsert is the
      // authoritative completion signal.
      return replaceRecord(state, {
        ...record,
        operationId: result.operationId
      });
    }
    if (result.status === "failed" || result.status === "unknown") {
      return replaceRecord(state, {
        ...record,
        errorCode:
          result.status === "unknown"
            ? "agent_session_fork_delivery_unknown"
            : "agent_session_fork_failed",
        errorMessage: result.error,
        operationId: result.operationId,
        status: result.status
      });
    }
    const session = result.session;
    if (!session) return invalidResult(state, record);
    return {
      commands: NO_COMMANDS,
      followUpIntents: [{ session, type: "session/upserted" }],
      state: withRecord(state, {
        ...record,
        ackErrorMessage: null,
        ackRetryAttempt: 0,
        ackRetryExpiryId: null,
        ackStatus: "pending",
        operationId: result.operationId,
        requestId: result.requestId,
        status: "inFlight",
        targetAgentSessionId: result.targetAgentSessionId
      })
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

function requestForkThroughTurn(
  state: SessionMutationsState,
  intent: Extract<EngineIntent, { type: "session/forkThroughTurnRequested" }>,
  context: {
    deletedSessionIds: Readonly<Record<string, true>>;
    interactionsById?: Readonly<Record<string, AgentActivityInteraction>>;
    sessionsById: Readonly<Record<string, CanonicalAgentSession>>;
    turnsById?: Readonly<Record<string, AgentActivityTurn>>;
  }
): EngineReducerResult<SessionMutationsState> {
  const sourceAgentSessionId = intent.sourceAgentSessionId.trim();
  const targetAgentSessionId = intent.targetAgentSessionId.trim();
  const requestId = intent.requestId.trim();
  const turnId = intent.turnId.trim();
  const workspaceId = intent.workspaceId.trim();
  const sourceSession = context.sessionsById[sourceAgentSessionId];
  const turn =
    context.turnsById?.[canonicalTurnKey(sourceAgentSessionId, turnId)];
  const existing = state.byMutationId[requestId];
  if (existing) {
    if (
      existing.kind !== "forkThroughTurn" ||
      existing.workspaceId !== workspaceId ||
      existing.agentSessionIds[0] !== sourceAgentSessionId ||
      existing.targetAgentSessionId !== targetAgentSessionId ||
      existing.turnId !== turnId
    ) {
      return unchanged(state);
    }
    if (
      existing.status === "succeeded" ||
      context.sessionsById[targetAgentSessionId]?.workspaceId === workspaceId
    ) {
      return replaceRecord(state, { ...existing, status: "succeeded" });
    }
    if (existing.status === "inFlight") return unchanged(state);
    return {
      commands: [
        {
          commandId: requestId,
          correlationId: requestId,
          requestId,
          sourceAgentSessionId,
          targetAgentSessionId,
          ...(intent.timeoutMs === undefined
            ? {}
            : { timeoutMs: intent.timeoutMs }),
          turnId,
          type: "session/forkThroughTurn",
          workspaceId
        }
      ],
      state: withRecord(state, {
        ...existing,
        errorCode: null,
        errorMessage: null,
        status: "inFlight"
      })
    };
  }
  if (
    !sourceAgentSessionId ||
    !targetAgentSessionId ||
    !requestId ||
    !turnId ||
    !workspaceId ||
    context.deletedSessionIds[sourceAgentSessionId] ||
    sourceSession?.workspaceId !== workspaceId ||
    sourceSession.kind !== "root" ||
    sourceSession.lifecycleCapabilities.forkThroughTurn !== true ||
    Boolean(sourceSession.activeTurnId?.trim()) ||
    Object.values(context.interactionsById ?? {}).some(
      (interaction) =>
        interaction.agentSessionId === sourceAgentSessionId &&
        interaction.status === "pending"
    ) ||
    turn?.phase !== "settled" ||
    context.sessionsById[targetAgentSessionId] !== undefined ||
    hasInFlightOverlap(state, [sourceAgentSessionId]) ||
    hasUnresolvedForkObservationAckOverlap(
      state,
      workspaceId,
      sourceAgentSessionId,
      turnId
    )
  ) {
    return unchanged(state);
  }
  const record: Extract<SessionMutationRecord, { kind: "forkThroughTurn" }> = {
    agentSessionIds: [sourceAgentSessionId],
    ackCommandId: null,
    ackErrorMessage: null,
    ackRetryAttempt: 0,
    ackRetryExpiryId: null,
    ackStatus: "idle",
    commandId: requestId,
    errorCode: null,
    errorMessage: null,
    kind: "forkThroughTurn",
    mutationId: requestId,
    operationId: null,
    requestId,
    status: "inFlight",
    targetAgentSessionId,
    turnId,
    workspaceId
  };
  return {
    commands: [
      {
        commandId: requestId,
        correlationId: requestId,
        requestId,
        sourceAgentSessionId,
        targetAgentSessionId,
        ...(intent.timeoutMs === undefined
          ? {}
          : { timeoutMs: intent.timeoutMs }),
        turnId,
        type: "session/forkThroughTurn",
        workspaceId
      }
    ],
    state: withRequestedRecord(state, record)
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
        cleanupFailedSessionIds: [],
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

function hasUnresolvedForkObservationAckOverlap(
  state: SessionMutationsState,
  workspaceId: string,
  sourceAgentSessionId: string,
  turnId: string
): boolean {
  return Object.values(state.byMutationId).some(
    (record) =>
      isUnresolvedForkObservationAck(record) &&
      record.workspaceId === workspaceId &&
      record.agentSessionIds[0] === sourceAgentSessionId &&
      record.turnId === turnId
  );
}

function observeForkedSession(
  state: SessionMutationsState,
  session: AgentActivitySession
): EngineReducerResult<SessionMutationsState> {
  const targetAgentSessionId = session.agentSessionId.trim();
  const workspaceId = session.workspaceId.trim();
  const lineage = session.forkedFrom;
  if (
    !targetAgentSessionId ||
    !workspaceId ||
    !lineage?.operationId.trim() ||
    !lineage.sourceAgentSessionId.trim() ||
    !lineage.sourceTurnId.trim() ||
    !lineage.targetTurnId.trim()
  ) {
    return unchanged(state);
  }
  const records = Object.values(state.byMutationId);
  let record: SessionForkThroughTurnMutationRecord | undefined;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const candidate = records[index];
    if (
      candidate?.kind === "forkThroughTurn" &&
      candidate.workspaceId === workspaceId &&
      candidate.agentSessionIds[0] === lineage.sourceAgentSessionId &&
      candidate.turnId === lineage.sourceTurnId &&
      (candidate.operationId
        ? candidate.operationId === lineage.operationId
        : candidate.targetAgentSessionId === targetAgentSessionId)
    ) {
      record = candidate;
      break;
    }
  }
  if (!record) {
    return unchanged(state);
  }
  const observed: SessionForkThroughTurnMutationRecord = {
    ...record,
    operationId: lineage.operationId,
    status: "succeeded",
    targetAgentSessionId
  };
  if (record.ackStatus === "inFlight" || record.ackStatus === "acknowledged") {
    return replaceRecord(state, observed);
  }
  if (record.ackRetryExpiryId !== null) {
    return replaceRecord(state, observed);
  }
  const commandId = sessionForkObservationAckCommandId(lineage.operationId);
  return {
    commands: [
      sessionForkObservationAckCommand(record, lineage.operationId, workspaceId)
    ],
    state: withRecord(state, {
      ...observed,
      ackCommandId: commandId,
      ackErrorMessage: null,
      ackStatus: "inFlight"
    })
  };
}

function settleForkObservationAck(
  state: SessionMutationsState,
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>
): EngineReducerResult<SessionMutationsState> {
  const mutationId = intent.correlationId?.trim() ?? "";
  const record = state.byMutationId[mutationId];
  if (
    record?.kind !== "forkThroughTurn" ||
    record.ackStatus !== "inFlight" ||
    record.ackCommandId !== intent.commandId
  ) {
    return unchanged(state);
  }
  if (intent.outcome === "succeeded") {
    const commands: EngineCommand[] =
      record.ackRetryExpiryId === null
        ? []
        : [
            {
              expiryId: record.ackRetryExpiryId,
              type: "engine/cancelExpiry"
            }
          ];
    return {
      commands,
      state: withRecord(state, {
        ...record,
        ackCommandId: null,
        ackErrorMessage: null,
        ackRetryAttempt: 0,
        ackRetryExpiryId: null,
        ackStatus: "acknowledged"
      })
    };
  }
  const retryAttempt = Math.min(
    record.ackRetryAttempt + 1,
    SESSION_FORK_OBSERVATION_ACK_RETRY_BACKOFF_MS.length
  );
  const retryExpiryId = sessionForkObservationAckRetryExpiryId(
    record.operationId ?? ""
  );
  return {
    commands: [
      {
        delayMs:
          SESSION_FORK_OBSERVATION_ACK_RETRY_BACKOFF_MS[retryAttempt - 1] ??
          30_000,
        expiryId: retryExpiryId,
        type: "engine/scheduleExpiryAfter"
      }
    ],
    state: withRecord(state, {
      ...record,
      ackCommandId: null,
      ackErrorMessage:
        intent.errorMessage?.trim() ||
        (intent.outcome === "timedOut"
          ? "session fork observation acknowledgement timed out"
          : "session fork observation acknowledgement failed"),
      ackRetryAttempt: retryAttempt,
      ackRetryExpiryId: retryExpiryId,
      ackStatus: "pending"
    })
  };
}

function sessionForkObservationAckCommandId(operationId: string): string {
  return `session-fork-observed:${operationId.trim()}`;
}

function sessionForkObservationAckRetryExpiryId(operationId: string): string {
  return `session-fork-observed-retry:${operationId.trim()}`;
}

function sessionForkObservationAckCommand(
  record: SessionForkThroughTurnMutationRecord,
  operationId: string,
  workspaceId = record.workspaceId
): Extract<EngineCommand, { type: "session/ackForkObserved" }> {
  return {
    commandId: sessionForkObservationAckCommandId(operationId),
    correlationId: record.mutationId,
    operationId,
    timeoutMs: SESSION_FORK_OBSERVATION_ACK_TIMEOUT_MS,
    type: "session/ackForkObserved",
    workspaceId
  };
}

function retryForkObservationAck(
  state: SessionMutationsState,
  expiryId: string
): EngineReducerResult<SessionMutationsState> {
  const record = Object.values(state.byMutationId).find(
    (candidate): candidate is SessionForkThroughTurnMutationRecord =>
      candidate.kind === "forkThroughTurn" &&
      candidate.ackStatus === "pending" &&
      candidate.ackRetryExpiryId === expiryId
  );
  const operationId = record?.operationId?.trim() ?? "";
  if (!record || !operationId) {
    return unchanged(state);
  }
  const command = sessionForkObservationAckCommand(record, operationId);
  return {
    commands: [command],
    state: withRecord(state, {
      ...record,
      ackCommandId: command.commandId,
      ackErrorMessage: null,
      ackRetryExpiryId: null,
      ackStatus: "inFlight"
    })
  };
}

function removeSessionForkCoordination(
  state: SessionMutationsState,
  agentSessionIdInput: string
): EngineReducerResult<SessionMutationsState> {
  const agentSessionId = agentSessionIdInput.trim();
  if (!agentSessionId) return unchanged(state);
  const removedRecords = Object.values(state.byMutationId).filter(
    (record): record is SessionForkThroughTurnMutationRecord =>
      record.kind === "forkThroughTurn" &&
      record.status !== "inFlight" &&
      record.status !== "unknown" &&
      (record.ackStatus === "idle" || record.ackStatus === "acknowledged") &&
      (record.agentSessionIds[0] === agentSessionId ||
        record.targetAgentSessionId === agentSessionId)
  );
  if (removedRecords.length === 0) return unchanged(state);
  const removedMutationIds = new Set(
    removedRecords.map((record) => record.mutationId)
  );
  return {
    commands: NO_COMMANDS,
    state: {
      byMutationId: Object.fromEntries(
        Object.entries(state.byMutationId).filter(
          ([mutationId]) => !removedMutationIds.has(mutationId)
        )
      )
    }
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
            isUnresolvedForkCoordination(current) ||
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
  const settled = entries.filter(
    ([, record]) =>
      record.status !== "inFlight" && !isUnresolvedForkCoordination(record)
  );
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
          record.status === "inFlight" ||
          isUnresolvedForkCoordination(record) ||
          retainedSettledIds.has(mutationId)
      )
    )
  };
}

function isUnresolvedForkCoordination(
  record: SessionMutationRecord
): record is SessionForkThroughTurnMutationRecord {
  return (
    record.kind === "forkThroughTurn" &&
    (record.status === "unknown" ||
      (record.ackStatus !== "idle" && record.ackStatus !== "acknowledged"))
  );
}

function isUnresolvedForkObservationAck(
  record: SessionMutationRecord
): record is SessionForkThroughTurnMutationRecord {
  return (
    record.kind === "forkThroughTurn" &&
    record.ackStatus !== "idle" &&
    record.ackStatus !== "acknowledged"
  );
}

function unchanged(
  state: SessionMutationsState
): EngineReducerResult<SessionMutationsState> {
  return { commands: NO_COMMANDS, state };
}
