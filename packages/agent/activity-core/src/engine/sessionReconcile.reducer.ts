import type {
  EngineCommand,
  EngineCommandResultIntent,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";
import type {
  SessionReconcileRecord,
  SessionReconcileState
} from "./sessionReconcile.types.ts";
import type { CanonicalAgentSession } from "./sessionLifecycle.types.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];

export function createInitialSessionReconcileState(): SessionReconcileState {
  return { nextCommandSequence: 1, recordsBySessionId: {} };
}

export function sessionReconcileReducer(
  state: SessionReconcileState,
  intent: EngineIntent,
  context: {
    deletedSessionIds: Readonly<Record<string, true>>;
    sessionsById: Readonly<Record<string, CanonicalAgentSession>>;
    workspaceReconcileCommandId: string | null;
  } = {
    deletedSessionIds: {},
    sessionsById: {},
    workspaceReconcileCommandId: null
  }
): EngineReducerResult<SessionReconcileState> {
  switch (intent.type) {
    case "session/detailSnapshotReceived":
      return receiveDetailSnapshot(state, intent);
    case "session/activityObserved":
      if (context.deletedSessionIds[intent.agentSessionId.trim()]) {
        return unchanged(state);
      }
      if (intent.inlineApplied && intent.terminalTurn !== true) {
        return unchanged(state);
      }
      return requestReconcile(state, {
        agentSessionId: intent.agentSessionId,
        needsMessages:
          intent.eventType === "message_update" ||
          intent.eventType === "session_audit" ||
          intent.terminalTurn === true,
        needsState:
          !intent.hasCachedSession ||
          (intent.eventType !== "message_update" &&
            intent.eventType !== "session_audit") ||
          !intent.hasInlineMessages,
        live: intent.eventType === "turn_update",
        workspaceId: intent.workspaceId
      });
    case "session/reconcileRequested":
      if (context.deletedSessionIds[intent.agentSessionId.trim()]) {
        return unchanged(state);
      }
      return requestReconcile(state, intent);
    case "session/removed":
      return removeRecord(state, intent.agentSessionId);
    case "engine/commandResult":
      if (
        intent.commandType === "engine/reconcileWorkspace" &&
        intent.outcome === "succeeded" &&
        intent.commandId === context.workspaceReconcileCommandId
      ) {
        return hydrateActiveRootSessions(state, context.sessionsById);
      }
      return intent.commandType === "session/reconcile"
        ? settleReconcile(state, intent)
        : unchanged(state);
    default:
      return unchanged(state);
  }
}

function receiveDetailSnapshot(
  state: SessionReconcileState,
  intent: Extract<EngineIntent, { type: "session/detailSnapshotReceived" }>
): EngineReducerResult<SessionReconcileState> {
  const followUpIntents: EngineIntent[] = [
    { session: intent.session, type: "session/upserted" }
  ];
  if (intent.editRetry) {
    followUpIntents.push({
      agentSessionId: intent.session.agentSessionId,
      availability: intent.editRetry,
      type: "editRetry/availabilityReceived",
      workspaceId: intent.workspaceId
    });
  }
  if (intent.live && intent.session.latestTurn) {
    followUpIntents.push({
      turn: intent.session.latestTurn,
      type: "turn/upserted"
    });
  }
  followUpIntents.push(
    ...intent.turns.map(
      (turn): EngineIntent => ({ turn, type: "turn/upserted" })
    ),
    ...intent.childSessions.map(
      (session): EngineIntent => ({ session, type: "session/upserted" })
    )
  );
  if (intent.messages || intent.sessionMessageWindows) {
    followUpIntents.push({
      messages: intent.messages ?? [],
      ...(intent.sessionMessageWindows
        ? { sessionMessageWindows: intent.sessionMessageWindows }
        : {}),
      type: "message/snapshotReceived",
      workspaceId: intent.workspaceId
    });
  }
  return { commands: NO_COMMANDS, followUpIntents, state };
}

function hydrateActiveRootSessions(
  state: SessionReconcileState,
  sessionsById: Readonly<Record<string, CanonicalAgentSession>>
): EngineReducerResult<SessionReconcileState> {
  let next = state;
  const commands: EngineCommand[] = [];
  const activeRoots = Object.values(sessionsById)
    .filter(
      (session) =>
        session.kind === "root" && Boolean(session.activeTurnId?.trim())
    )
    .sort((left, right) =>
      left.agentSessionId.localeCompare(right.agentSessionId)
    );

  for (const session of activeRoots) {
    const requested = requestReconcile(next, {
      agentSessionId: session.agentSessionId,
      needsMessages: false,
      needsState: true,
      live: false,
      workspaceId: session.workspaceId
    });
    next = requested.state;
    commands.push(...requested.commands);
  }

  return { commands, state: next };
}

function requestReconcile(
  state: SessionReconcileState,
  input: {
    agentSessionId: string;
    live?: boolean;
    needsMessages: boolean;
    needsState: boolean;
    workspaceId: string;
  }
): EngineReducerResult<SessionReconcileState> {
  const agentSessionId = input.agentSessionId.trim();
  const workspaceId = input.workspaceId.trim();
  if (
    !agentSessionId ||
    !workspaceId ||
    (!input.needsMessages && !input.needsState)
  ) {
    return unchanged(state);
  }
  const current = state.recordsBySessionId[agentSessionId] ?? {
    agentSessionId,
    errorCode: null,
    errorMessage: null,
    inFlightCommandId: null,
    inFlightLive: false,
    inFlightScope: null,
    messagesHydrated: false,
    pendingLive: false,
    pendingMessages: false,
    pendingState: false,
    workspaceId
  };
  const record = {
    ...current,
    errorCode: null,
    errorMessage: null,
    pendingLive: current.pendingLive || input.live === true,
    pendingMessages: current.pendingMessages || input.needsMessages,
    pendingState: current.pendingState || input.needsState
  };
  const next = replaceRecord(state, record);
  return record.inFlightCommandId
    ? { commands: NO_COMMANDS, state: next }
    : startReconcile(next, record);
}

function settleReconcile(
  state: SessionReconcileState,
  intent: EngineCommandResultIntent
): EngineReducerResult<SessionReconcileState> {
  const record = Object.values(state.recordsBySessionId).find(
    (candidate) => candidate.inFlightCommandId === intent.commandId
  );
  if (!record) {
    return unchanged(state);
  }
  const settled = {
    ...record,
    errorCode:
      intent.outcome === "succeeded" ? null : intent.errorCode?.trim() || null,
    errorMessage:
      intent.outcome === "succeeded"
        ? null
        : intent.errorMessage?.trim() || null,
    inFlightCommandId: null,
    inFlightLive: false,
    inFlightScope: null,
    messagesHydrated:
      record.messagesHydrated ||
      (intent.outcome === "succeeded" &&
        (record.inFlightScope === "messages" ||
          record.inFlightScope === "state_and_messages")),
    pendingLive:
      record.pendingLive ||
      (intent.outcome !== "succeeded" && record.inFlightLive)
  };
  const next = replaceRecord(state, settled);
  return settled.pendingMessages || settled.pendingState
    ? startReconcile(next, settled)
    : { commands: NO_COMMANDS, state: next };
}

function startReconcile(
  state: SessionReconcileState,
  record: SessionReconcileRecord
): EngineReducerResult<SessionReconcileState> {
  const needsState = record.pendingState || record.pendingLive;
  const scope = needsState
    ? record.pendingMessages
      ? "state_and_messages"
      : "state"
    : "messages";
  const commandId = `session:reconcile:${record.agentSessionId}:${state.nextCommandSequence}`;
  const live = record.pendingLive;
  return {
    commands: [
      {
        agentSessionId: record.agentSessionId,
        commandId,
        live,
        scope,
        timeoutMs: 30_000,
        type: "session/reconcile",
        workspaceId: record.workspaceId
      }
    ],
    state: replaceRecord(
      { ...state, nextCommandSequence: state.nextCommandSequence + 1 },
      {
        ...record,
        errorCode: null,
        errorMessage: null,
        inFlightCommandId: commandId,
        inFlightLive: live,
        inFlightScope: scope,
        pendingLive: false,
        pendingMessages: false,
        pendingState: false
      }
    )
  };
}

function replaceRecord(
  state: SessionReconcileState,
  record: SessionReconcileRecord
): SessionReconcileState {
  return {
    ...state,
    recordsBySessionId: {
      ...state.recordsBySessionId,
      [record.agentSessionId]: record
    }
  };
}

function removeRecord(
  state: SessionReconcileState,
  rawAgentSessionId: string
): EngineReducerResult<SessionReconcileState> {
  const records = { ...state.recordsBySessionId };
  if (!records[rawAgentSessionId.trim()]) {
    return unchanged(state);
  }
  delete records[rawAgentSessionId.trim()];
  return {
    commands: NO_COMMANDS,
    state: { ...state, recordsBySessionId: records }
  };
}

function unchanged(
  state: SessionReconcileState
): EngineReducerResult<SessionReconcileState> {
  return { commands: NO_COMMANDS, state };
}
