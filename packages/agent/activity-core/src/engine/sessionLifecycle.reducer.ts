import type {
  AgentActivityInteraction,
  AgentActivitySendInputResult,
  AgentActivitySession,
  AgentActivityTurn
} from "../types.ts";
import type {
  EngineCommand,
  EngineCommandResultIntent,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";
import {
  isAgentActivityTurnCancelResponse,
  type SessionCancelState,
  type SessionLifecycleIntent,
  type SessionLifecycleRecord,
  type SessionLifecycleState,
  type TurnCancelCommand
} from "./sessionLifecycle.types.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];
const TURN_CANCEL_TIMEOUT_MS = 30_000;

export function createInitialSessionLifecycleState(): SessionLifecycleState {
  return { deletedSessionIds: {}, recordsBySessionId: {} };
}

export function sessionLifecycleReducer(
  state: SessionLifecycleState,
  intent: EngineIntent,
  context: { queuePromotionAccepted: boolean } = {
    queuePromotionAccepted: false
  }
): EngineReducerResult<SessionLifecycleState> {
  switch (intent.type) {
    case "session/snapshotReceived":
      return reconcileSnapshot(state, intent.sessions);
    case "session/upserted":
      return upsertSession(state, intent.session);
    case "session/removed":
      return removeSession(state, intent.agentSessionId);
    case "session/errorRecorded":
      return updateRecord(state, intent.agentSessionId, (record) => ({
        ...record,
        operationError: intent.errorMessage.trim() || record.operationError
      }));
    case "session/errorCleared":
      return updateRecord(state, intent.agentSessionId, (record) =>
        record.operationError === null
          ? record
          : { ...record, operationError: null }
      );
    case "session/cancelRequested":
      return requestCancel(state, intent);
    case "queue/promoted":
      return context.queuePromotionAccepted
        ? requestQueuePromotionCancel(state, intent)
        : unchanged(state);
    case "session/cancelAbandoned":
      return abandonCancel(state, intent.agentSessionId);
    case "engine/intentExpired":
      return expireAwaitingCancel(state, intent.expiryId);
    case "engine/commandResult":
      if (intent.commandType === "turn/cancel") {
        return settleCancelCommand(state, intent);
      }
      return intent.commandType === "queue/sendPrompt"
        ? receiveSendResult(state, intent)
        : unchanged(state);
    default:
      return unchanged(state);
  }
}

function receiveSendResult(
  state: SessionLifecycleState,
  intent: EngineCommandResultIntent
): EngineReducerResult<SessionLifecycleState> {
  return intent.outcome === "succeeded" && isSendInputResult(intent.value)
    ? upsertSession(state, intent.value.session)
    : unchanged(state);
}

function isSendInputResult(
  value: unknown
): value is AgentActivitySendInputResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as Partial<AgentActivitySendInputResult>;
  return (
    typeof result.turnId === "string" &&
    Boolean(result.session) &&
    Boolean(result.turnLifecycle)
  );
}

function reconcileSnapshot(
  state: SessionLifecycleState,
  sessions: readonly AgentActivitySession[]
): EngineReducerResult<SessionLifecycleState> {
  const nextRecords: Record<string, SessionLifecycleRecord> = {};
  const commands: EngineCommand[] = [];
  for (const session of sessions) {
    const agentSessionId = session.agentSessionId.trim();
    if (!agentSessionId || state.deletedSessionIds[agentSessionId]) {
      continue;
    }
    const previous = state.recordsBySessionId[agentSessionId];
    const record = reconcileRecord(session, previous);
    const reconciledCancel = reconcilePendingCancel(record);
    nextRecords[agentSessionId] = reconciledCancel.record;
    commands.push(...reconciledCancel.commands);
  }
  if (recordsEqual(state.recordsBySessionId, nextRecords)) {
    return commands.length === 0 ? unchanged(state) : { commands, state };
  }
  return {
    commands,
    state: { ...state, recordsBySessionId: nextRecords }
  };
}

function upsertSession(
  state: SessionLifecycleState,
  session: AgentActivitySession
): EngineReducerResult<SessionLifecycleState> {
  const agentSessionId = session.agentSessionId.trim();
  if (!agentSessionId || state.deletedSessionIds[agentSessionId]) {
    return unchanged(state);
  }
  const previous = state.recordsBySessionId[agentSessionId];
  const record = reconcileRecord(session, previous);
  const reconciledCancel = reconcilePendingCancel(record);
  if (
    previous &&
    recordEqual(previous, reconciledCancel.record) &&
    reconciledCancel.commands.length === 0
  ) {
    return unchanged(state);
  }
  return {
    commands: reconciledCancel.commands,
    state: replaceRecord(state, agentSessionId, reconciledCancel.record)
  };
}

function removeSession(
  state: SessionLifecycleState,
  rawAgentSessionId: string
): EngineReducerResult<SessionLifecycleState> {
  const agentSessionId = rawAgentSessionId.trim();
  if (!agentSessionId || state.deletedSessionIds[agentSessionId]) {
    return unchanged(state);
  }
  const records = { ...state.recordsBySessionId };
  const expiryId = records[agentSessionId]?.cancel.expiryId ?? null;
  delete records[agentSessionId];
  return {
    commands: expiryId
      ? [{ expiryId, type: "engine/cancelExpiry" }]
      : NO_COMMANDS,
    state: {
      deletedSessionIds: {
        ...state.deletedSessionIds,
        [agentSessionId]: true
      },
      recordsBySessionId: records
    }
  };
}

function requestCancel(
  state: SessionLifecycleState,
  intent: Extract<SessionLifecycleIntent, { type: "session/cancelRequested" }>
): EngineReducerResult<SessionLifecycleState> {
  const agentSessionId = intent.agentSessionId.trim();
  const record = state.recordsBySessionId[agentSessionId];
  if (!record || cancelIsPending(record.cancel)) {
    return unchanged(state);
  }
  const activeTurn = liveTurn(record.activeTurn);
  const cancel: SessionCancelState = activeTurn
    ? requestedCancelState(intent.commandId, activeTurn.turnId)
    : {
        ...requestedCancelState(intent.commandId, null),
        expiryId:
          intent.awaitingTurnExpiresAtUnixMs === undefined
            ? null
            : awaitingCancelExpiryId(intent.commandId),
        requestedSessionVersion: sessionVersion(record.session),
        status: "awaitingTurn"
      };
  const nextState = replaceRecord(state, agentSessionId, {
    ...record,
    cancel,
    operationError: null
  });
  if (!activeTurn) {
    return {
      commands:
        intent.awaitingTurnExpiresAtUnixMs === undefined
          ? NO_COMMANDS
          : [
              {
                dueAtUnixMs: intent.awaitingTurnExpiresAtUnixMs,
                expiryId: awaitingCancelExpiryId(intent.commandId),
                type: "engine/scheduleExpiry"
              }
            ],
      state: nextState
    };
  }
  return {
    commands: [
      cancelCommand(record, activeTurn, intent.commandId, intent.timeoutMs)
    ],
    state: nextState
  };
}

function requestQueuePromotionCancel(
  state: SessionLifecycleState,
  intent: Extract<EngineIntent, { type: "queue/promoted" }>
): EngineReducerResult<SessionLifecycleState> {
  const agentSessionId = intent.agentSessionId.trim();
  const record = state.recordsBySessionId[agentSessionId];
  if (!record || cancelIsPending(record.cancel)) {
    return unchanged(state);
  }
  const activeTurn = liveTurn(record.activeTurn);
  if (!activeTurn) {
    if (!record.session.activeTurnId) {
      return unchanged(state);
    }
    const cancel: SessionCancelState = {
      ...requestedCancelState(intent.cancelCommandId, null),
      expiryId: awaitingCancelExpiryId(intent.cancelCommandId),
      requestedSessionVersion: sessionVersion(record.session),
      status: "awaitingTurn"
    };
    return {
      commands: [
        {
          dueAtUnixMs: intent.awaitingTurnExpiresAtUnixMs,
          expiryId: cancel.expiryId!,
          type: "engine/scheduleExpiry"
        }
      ],
      state: replaceRecord(state, agentSessionId, {
        ...record,
        cancel,
        operationError: null
      })
    };
  }
  const cancel = requestedCancelState(
    intent.cancelCommandId,
    activeTurn.turnId
  );
  return {
    commands: [
      cancelCommand(
        record,
        activeTurn,
        intent.cancelCommandId,
        intent.timeoutMs
      )
    ],
    state: replaceRecord(state, agentSessionId, {
      ...record,
      cancel,
      operationError: null
    })
  };
}

function settleCancelCommand(
  state: SessionLifecycleState,
  intent: EngineCommandResultIntent
): EngineReducerResult<SessionLifecycleState> {
  const entry = Object.entries(state.recordsBySessionId).find(
    ([, record]) => record.cancel.commandId === intent.commandId
  );
  if (!entry) {
    return unchanged(state);
  }
  const [agentSessionId, record] = entry;
  if (intent.outcome === "succeeded") {
    const response = isAgentActivityTurnCancelResponse(intent.value)
      ? intent.value
      : null;
    const canceledTurnId = record.cancel.turnId;
    const responseTurn = response?.turn ?? null;
    const resultTurn =
      responseTurn?.agentSessionId === agentSessionId &&
      responseTurn.turnId === canceledTurnId
        ? responseTurn
        : null;
    const responseTurnMismatched = responseTurn !== null && resultTurn === null;
    const activeTurn = shouldAcceptTurn(record.activeTurn, resultTurn)
      ? resultTurn
      : record.activeTurn;
    const turnSettled =
      resultTurn?.turnId === canceledTurnId && resultTurn.phase === "settled";
    const targetNoLongerExists =
      !resultTurn &&
      (response?.cancel.reason === "not_found" ||
        response?.cancel.reason === "already_settled") &&
      record.activeTurn?.turnId === canceledTurnId;
    const clearTargetTurn = turnSettled || targetNoLongerExists;
    return {
      commands:
        targetNoLongerExists || responseTurnMismatched
          ? [
              {
                commandId: `engine:reconcile:cancel:${intent.commandId}`,
                type: "engine/reconcileWorkspace",
                workspaceId: record.session.workspaceId
              }
            ]
          : NO_COMMANDS,
      state: replaceRecord(state, agentSessionId, {
        ...record,
        activeTurn: targetNoLongerExists ? null : activeTurn,
        cancel: initialCancelState(),
        operationError: null,
        latestTurn: resultTurn ?? record.latestTurn,
        pendingInteractions: clearTargetTurn
          ? record.pendingInteractions.filter(
              (interaction) => interaction.turnId !== canceledTurnId
            )
          : record.pendingInteractions,
        session: clearTargetTurn
          ? { ...record.session, activeTurnId: null }
          : record.session
      })
    };
  }
  const errorMessage = intent.errorMessage?.trim() || "Cancel failed.";
  return {
    commands: NO_COMMANDS,
    state: replaceRecord(state, agentSessionId, {
      ...record,
      cancel: {
        ...record.cancel,
        errorCode: intent.errorCode ?? null,
        errorMessage,
        status: "failed"
      },
      operationError: errorMessage
    })
  };
}

function reconcileRecord(
  session: AgentActivitySession,
  previous?: SessionLifecycleRecord
): SessionLifecycleRecord {
  if (previous && sessionShouldBeRejected(session, previous)) {
    return previous;
  }
  const {
    activeTurn: embeddedTurn,
    pendingInteractions,
    ...sessionEntity
  } = session;
  const incomingTurn = validActiveTurn(session, embeddedTurn ?? null);
  const previousTurn = previous?.activeTurn ?? null;
  const incomingLatestTurn = validTurnEntity(session, embeddedTurn ?? null);
  const previousLatestTurn = previous?.latestTurn ?? null;
  const latestTurn = incomingLatestTurn
    ? shouldAcceptTurn(previousLatestTurn, incomingLatestTurn)
      ? incomingLatestTurn
      : previousLatestTurn
    : previousLatestTurn;
  const activeTurn = incomingTurn
    ? shouldAcceptTurn(previousTurn, incomingTurn)
      ? incomingTurn
      : previousTurn
    : session.activeTurnId
      ? previousTurn?.turnId === session.activeTurnId
        ? previousTurn
        : null
      : null;
  return {
    activeTurn,
    cancel: previous?.cancel ?? initialCancelState(),
    latestTurn,
    operationError: previous?.operationError ?? null,
    pendingInteractions: normalizePendingInteractions(
      pendingInteractions,
      session.agentSessionId,
      activeTurn?.turnId ?? null
    ),
    session: { ...sessionEntity, activeTurnId: session.activeTurnId ?? null }
  };
}

function validTurnEntity(
  session: AgentActivitySession,
  turn: AgentActivityTurn | null
): AgentActivityTurn | null {
  return turn && turn.agentSessionId === session.agentSessionId
    ? { ...turn }
    : null;
}

function reconcilePendingCancel(record: SessionLifecycleRecord): {
  commands: readonly EngineCommand[];
  record: SessionLifecycleRecord;
} {
  const cancel = record.cancel;
  if (cancel.status === "awaitingTurn") {
    const activeTurn = liveTurn(record.activeTurn);
    if (activeTurn && cancel.commandId) {
      return {
        commands: [
          ...(cancel.expiryId
            ? [
                {
                  expiryId: cancel.expiryId,
                  type: "engine/cancelExpiry" as const
                }
              ]
            : []),
          cancelCommand(record, activeTurn, cancel.commandId)
        ],
        record: {
          ...record,
          cancel: { ...cancel, status: "requested", turnId: activeTurn.turnId }
        }
      };
    }
  }
  if (cancel.status === "requested") {
    const activeTurn = record.activeTurn;
    if (
      !activeTurn ||
      activeTurn.turnId !== cancel.turnId ||
      activeTurn.phase === "settled"
    ) {
      return {
        commands: NO_COMMANDS,
        record: { ...record, cancel: initialCancelState() }
      };
    }
  }
  if (cancel.status === "failed" && !liveTurn(record.activeTurn)) {
    return {
      commands: NO_COMMANDS,
      record: {
        ...record,
        cancel: initialCancelState(),
        operationError: null
      }
    };
  }
  return { commands: NO_COMMANDS, record };
}

function abandonCancel(
  state: SessionLifecycleState,
  rawAgentSessionId: string
): EngineReducerResult<SessionLifecycleState> {
  const agentSessionId = rawAgentSessionId.trim();
  const record = state.recordsBySessionId[agentSessionId];
  if (!record || record.cancel.status === "idle") {
    return unchanged(state);
  }
  return {
    commands: record.cancel.expiryId
      ? [{ expiryId: record.cancel.expiryId, type: "engine/cancelExpiry" }]
      : NO_COMMANDS,
    state: replaceRecord(state, agentSessionId, {
      ...record,
      cancel: initialCancelState()
    })
  };
}

function expireAwaitingCancel(
  state: SessionLifecycleState,
  expiryId: string
): EngineReducerResult<SessionLifecycleState> {
  const entry = Object.entries(state.recordsBySessionId).find(
    ([, record]) =>
      record.cancel.status === "awaitingTurn" &&
      record.cancel.expiryId === expiryId
  );
  if (!entry) {
    return unchanged(state);
  }
  const [agentSessionId, record] = entry;
  return {
    commands: NO_COMMANDS,
    state: replaceRecord(state, agentSessionId, {
      ...record,
      cancel: initialCancelState()
    })
  };
}

function validActiveTurn(
  session: AgentActivitySession,
  turn: AgentActivityTurn | null
): AgentActivityTurn | null {
  const activeTurnId = session.activeTurnId?.trim() ?? "";
  if (
    !activeTurnId ||
    !turn ||
    turn.turnId !== activeTurnId ||
    turn.agentSessionId !== session.agentSessionId
  ) {
    return null;
  }
  return { ...turn };
}

function normalizePendingInteractions(
  interactions: readonly AgentActivityInteraction[] | undefined,
  agentSessionId: string,
  activeTurnId: string | null
): readonly AgentActivityInteraction[] {
  if (!activeTurnId) {
    return [];
  }
  return (interactions ?? [])
    .filter(
      (interaction) =>
        interaction.agentSessionId === agentSessionId &&
        interaction.turnId === activeTurnId &&
        interaction.status === "pending"
    )
    .map((interaction) => ({ ...interaction }));
}

function cancelCommand(
  record: SessionLifecycleRecord,
  turn: AgentActivityTurn,
  commandId: string,
  timeoutMs?: number
): TurnCancelCommand {
  return {
    agentSessionId: record.session.agentSessionId,
    commandId,
    type: "turn/cancel",
    turnId: turn.turnId,
    workspaceId: record.session.workspaceId,
    timeoutMs: timeoutMs ?? TURN_CANCEL_TIMEOUT_MS
  };
}

function requestedCancelState(
  commandId: string,
  turnId: string | null
): SessionCancelState {
  return {
    commandId,
    errorCode: null,
    errorMessage: null,
    expiryId: null,
    requestedSessionVersion: null,
    status: "requested",
    turnId
  };
}

function initialCancelState(): SessionCancelState {
  return {
    commandId: null,
    errorCode: null,
    errorMessage: null,
    expiryId: null,
    requestedSessionVersion: null,
    status: "idle",
    turnId: null
  };
}

function cancelIsPending(cancel: SessionCancelState): boolean {
  return cancel.status === "requested" || cancel.status === "awaitingTurn";
}

function liveTurn(turn: AgentActivityTurn | null): AgentActivityTurn | null {
  return turn && turn.phase !== "settled" ? turn : null;
}

function shouldAcceptTurn(
  current: AgentActivityTurn | null,
  incoming: AgentActivityTurn | null
): boolean {
  if (!incoming) {
    return current === null;
  }
  if (!current || current.turnId !== incoming.turnId) {
    return true;
  }
  return incoming.updatedAtUnixMs >= current.updatedAtUnixMs;
}

function sessionShouldBeRejected(
  incoming: AgentActivitySession,
  current: SessionLifecycleRecord
): boolean {
  const incomingVersion = sessionVersion(incoming);
  const currentVersion = sessionVersion(current.session);
  if (
    incomingVersion !== null &&
    currentVersion !== null &&
    incomingVersion < currentVersion
  ) {
    return true;
  }
  const currentTurn = liveTurn(current.activeTurn);
  const incomingActiveTurnId = incoming.activeTurnId?.trim() || null;
  return Boolean(
    currentTurn &&
    incomingActiveTurnId !== currentTurn.turnId &&
    incomingVersion !== null &&
    currentVersion !== null &&
    incomingVersion <= currentVersion
  );
}

function sessionVersion(session: AgentActivitySession): number | null {
  return (
    session.updatedAtUnixMs ??
    session.lastEventUnixMs ??
    session.messageVersion ??
    session.createdAtUnixMs ??
    session.startedAtUnixMs ??
    null
  );
}

function awaitingCancelExpiryId(commandId: string): string {
  return `cancel:awaiting-turn:${commandId}`;
}

function updateRecord(
  state: SessionLifecycleState,
  rawAgentSessionId: string,
  updater: (record: SessionLifecycleRecord) => SessionLifecycleRecord
): EngineReducerResult<SessionLifecycleState> {
  const agentSessionId = rawAgentSessionId.trim();
  const current = state.recordsBySessionId[agentSessionId];
  if (!current) {
    return unchanged(state);
  }
  const next = updater(current);
  return next === current || recordEqual(current, next)
    ? unchanged(state)
    : {
        commands: NO_COMMANDS,
        state: replaceRecord(state, agentSessionId, next)
      };
}

function replaceRecord(
  state: SessionLifecycleState,
  agentSessionId: string,
  record: SessionLifecycleRecord
): SessionLifecycleState {
  return {
    ...state,
    recordsBySessionId: {
      ...state.recordsBySessionId,
      [agentSessionId]: record
    }
  };
}

function unchanged(
  state: SessionLifecycleState
): EngineReducerResult<SessionLifecycleState> {
  return { commands: NO_COMMANDS, state };
}

function recordsEqual(
  left: Readonly<Record<string, SessionLifecycleRecord>>,
  right: Readonly<Record<string, SessionLifecycleRecord>>
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => right[key] && recordEqual(left[key]!, right[key]!))
  );
}

function recordEqual(
  left: SessionLifecycleRecord,
  right: SessionLifecycleRecord
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
