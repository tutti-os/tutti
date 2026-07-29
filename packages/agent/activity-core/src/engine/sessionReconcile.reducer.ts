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
    case "session/historyAuthoritativeSnapshotReceived":
      if (context.deletedSessionIds[intent.agentSessionId.trim()]) {
        return unchanged(state);
      }
      return receiveAuthoritativeHistorySnapshot(state, intent);
    case "session/historyRevisionObserved":
      if (context.deletedSessionIds[intent.agentSessionId.trim()]) {
        return unchanged(state);
      }
      return applyHistoryCheckpoint(state, intent);
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
          intent.eventType === "session_reconcile_required" ||
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

function receiveAuthoritativeHistorySnapshot(
  state: SessionReconcileState,
  intent: Extract<
    EngineIntent,
    { type: "session/historyAuthoritativeSnapshotReceived" }
  >
): EngineReducerResult<SessionReconcileState> {
  const detail = receiveDetailSnapshot(state, {
    childSessions: intent.childSessions,
    editRetry: intent.editRetry,
    messages: intent.messages,
    session: intent.session,
    sessionMessageWindows: intent.sessionMessageWindows,
    turns: intent.turns,
    type: "session/detailSnapshotReceived",
    workspaceId: intent.workspaceId
  });
  const checkpoint = applyHistoryCheckpoint(
    state,
    {
      agentSessionId: intent.agentSessionId,
      historyRevision: intent.historyRevision,
      workspaceId: intent.workspaceId
    },
    true
  );
  return {
    commands: checkpoint.commands,
    followUpIntents: detail.followUpIntents,
    state: checkpoint.state
  };
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
    authoritativeMessages?: boolean;
    needsMessages: boolean;
    needsState: boolean;
    requiredHistoryRevision?: number;
    workspaceId: string;
  }
): EngineReducerResult<SessionReconcileState> {
  const agentSessionId = input.agentSessionId.trim();
  const workspaceId = input.workspaceId.trim();
  const requiredHistoryRevision = normalizeHistoryRevision(
    input.requiredHistoryRevision
  );
  if (
    !agentSessionId ||
    !workspaceId ||
    (!input.needsMessages &&
      !input.needsState &&
      input.authoritativeMessages !== true &&
      requiredHistoryRevision === null)
  ) {
    return unchanged(state);
  }
  const current = state.recordsBySessionId[agentSessionId] ?? {
    agentSessionId,
    appliedHistoryRevision: null,
    authoritativeMessagesRequired: false,
    errorCode: null,
    errorMessage: null,
    inFlightCommandId: null,
    inFlightLive: false,
    inFlightScope: null,
    messagesHydrated: false,
    pendingLive: false,
    pendingMessages: false,
    pendingState: false,
    requiredHistoryRevision: null,
    workspaceId
  };
  const authoritativeDemandArrivedWhileInFlight =
    current.inFlightCommandId !== null &&
    (input.authoritativeMessages === true ||
      (requiredHistoryRevision !== null &&
        requiredHistoryRevision >
          (current.requiredHistoryRevision ??
            current.appliedHistoryRevision ??
            -1)));
  const record = {
    ...current,
    authoritativeMessagesRequired:
      current.authoritativeMessagesRequired ||
      input.authoritativeMessages === true,
    errorCode: null,
    errorMessage: null,
    pendingLive: current.pendingLive || input.live === true,
    pendingMessages:
      current.pendingMessages ||
      input.needsMessages ||
      authoritativeDemandArrivedWhileInFlight,
    pendingState: current.pendingState || input.needsState,
    requiredHistoryRevision:
      requiredHistoryRevision === null
        ? current.requiredHistoryRevision
        : Math.max(
            current.requiredHistoryRevision ?? 0,
            requiredHistoryRevision
          )
  };
  const next = replaceRecord(state, record);
  return record.inFlightCommandId ||
    (!record.pendingMessages &&
      !record.pendingState &&
      !record.authoritativeMessagesRequired &&
      !historyRevisionIsPending(record))
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
  return settled.pendingMessages ||
    settled.pendingState ||
    (intent.outcome === "succeeded" &&
      (settled.authoritativeMessagesRequired ||
        historyRevisionIsPending(settled)))
    ? startReconcile(next, settled)
    : { commands: NO_COMMANDS, state: next };
}

function startReconcile(
  state: SessionReconcileState,
  record: SessionReconcileRecord
): EngineReducerResult<SessionReconcileState> {
  const needsState = record.pendingState || record.pendingLive;
  const requiresAuthoritativeMessages =
    record.authoritativeMessagesRequired || historyRevisionIsPending(record);
  const scope = requiresAuthoritativeMessages
    ? "state_and_messages"
    : needsState
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
        ...(requiresAuthoritativeMessages
          ? { authoritativeMessages: true }
          : {}),
        commandId,
        live,
        ...(record.requiredHistoryRevision === null
          ? {}
          : { requiredHistoryRevision: record.requiredHistoryRevision }),
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

function applyHistoryCheckpoint(
  state: SessionReconcileState,
  input: {
    agentSessionId: string;
    historyRevision: number | undefined;
    workspaceId: string;
  },
  authoritative = false
): EngineReducerResult<SessionReconcileState> {
  const agentSessionId = input.agentSessionId.trim();
  const workspaceId = input.workspaceId.trim();
  const historyRevision = normalizeHistoryRevision(input.historyRevision);
  if (!agentSessionId || !workspaceId || historyRevision === null) {
    return unchanged(state);
  }
  const current = state.recordsBySessionId[agentSessionId] ?? {
    agentSessionId,
    appliedHistoryRevision: null,
    authoritativeMessagesRequired: false,
    errorCode: null,
    errorMessage: null,
    inFlightCommandId: null,
    inFlightLive: false,
    inFlightScope: null,
    messagesHydrated: false,
    pendingLive: false,
    pendingMessages: false,
    pendingState: false,
    requiredHistoryRevision: null,
    workspaceId
  };
  if (current.workspaceId !== workspaceId) {
    return unchanged(state);
  }
  const appliedHistoryRevision = Math.max(
    current.appliedHistoryRevision ?? 0,
    historyRevision
  );
  const requiredHistoryRevisionRemainsPending =
    current.requiredHistoryRevision !== null &&
    appliedHistoryRevision < current.requiredHistoryRevision;
  const next = {
    ...current,
    appliedHistoryRevision,
    authoritativeMessagesRequired: authoritative
      ? requiredHistoryRevisionRemainsPending
      : current.authoritativeMessagesRequired,
    errorCode: null,
    errorMessage: null,
    pendingMessages:
      authoritative && !requiredHistoryRevisionRemainsPending
        ? false
        : current.pendingMessages
  };
  return {
    commands: NO_COMMANDS,
    state: replaceRecord(state, next)
  };
}

function historyRevisionIsPending(record: SessionReconcileRecord): boolean {
  return (
    record.requiredHistoryRevision !== null &&
    (record.appliedHistoryRevision === null ||
      record.appliedHistoryRevision < record.requiredHistoryRevision)
  );
}

function normalizeHistoryRevision(value: number | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
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
