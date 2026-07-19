import type {
  EngineCommand,
  EngineCommandResultIntent,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";
import type {
  SessionReconcileRecord,
  SessionReconcileResult,
  SessionReconcileState
} from "./sessionReconcile.types.ts";
import type { CanonicalAgentSession } from "./sessionLifecycle.types.ts";
import type { SessionDeletionEvidence } from "./sessionDeletion.types.ts";
import { validateSessionReconcileResult } from "./sessionReconcileResult.validation.ts";
const NO_COMMANDS: readonly EngineCommand[] = [];

export function createInitialSessionReconcileState(): SessionReconcileState {
  return { nextCommandSequence: 1, recordsBySessionId: {} };
}

export function sessionReconcileReducer(
  state: SessionReconcileState,
  intent: EngineIntent,
  context: {
    deletedSessionIds: Readonly<Record<string, SessionDeletionEvidence>>;
    sessionsById: Readonly<Record<string, CanonicalAgentSession>>;
    workspaceReconcileCommandId: string | null;
  } = {
    deletedSessionIds: {},
    sessionsById: {},
    workspaceReconcileCommandId: null
  }
): EngineReducerResult<SessionReconcileState> {
  switch (intent.type) {
    case "session/activityObserved":
      if (context.deletedSessionIds[intent.agentSessionId.trim()]) {
        return unchanged(state);
      }
      if (intent.inlineApplied) {
        return unchanged(state);
      }
      return requestReconcile(state, {
        agentSessionId: intent.agentSessionId,
        needsMessages:
          intent.eventType === "message_update" ||
          intent.eventType === "session_audit",
        needsState:
          !intent.hasCachedSession ||
          (intent.eventType !== "message_update" &&
            intent.eventType !== "session_audit") ||
          !intent.hasInlineMessages,
        workspaceId: intent.workspaceId
      });
    case "session/reconcileRequested":
      if (context.deletedSessionIds[intent.agentSessionId.trim()]) {
        return unchanged(state);
      }
      return requestReconcile(state, intent);
    case "session/removed":
      if (!intent.evidence) return unchanged(state);
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
    errorMessage: null,
    inFlightCommandId: null,
    inFlightScope: null,
    lastAbsent: false,
    messagesHydrated: false,
    pendingMessages: false,
    pendingState: false,
    workspaceId
  };
  const record = {
    ...current,
    errorMessage: null,
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
    // Duplicate or out-of-order settle for a command that is no longer in flight.
    return unchanged(state);
  }
  if (intent.outcome !== "succeeded") {
    const settled = {
      ...record,
      errorMessage: intent.errorMessage?.trim() || null,
      inFlightCommandId: null,
      inFlightScope: null,
      lastAbsent: false
    };
    const next = replaceRecord(state, settled);
    return settled.pendingMessages || settled.pendingState
      ? startReconcile(next, settled)
      : { commands: NO_COMMANDS, state: next };
  }

  const validation = validateSessionReconcileResult(intent.value, record);
  if (validation.kind !== "valid") {
    const settled = {
      ...record,
      errorMessage: validation.reason,
      inFlightCommandId: null,
      inFlightScope: null,
      lastAbsent: false
    };
    return { commands: NO_COMMANDS, state: replaceRecord(state, settled) };
  }

  return applyReconcileResult(state, record, validation.result);
}

function applyReconcileResult(
  state: SessionReconcileState,
  record: SessionReconcileRecord,
  result: SessionReconcileResult
): EngineReducerResult<SessionReconcileState> {
  if (result.kind === "absent") {
    // Transport absence is never deletion. Clear in-flight demand so a 404
    // cannot busy-loop; pending create settles via activate result, and later
    // activityObserved/reconcileRequested can request again.
    const settled = {
      ...record,
      errorMessage: null,
      inFlightCommandId: null,
      inFlightScope: null,
      lastAbsent: true,
      pendingMessages: false,
      pendingState: false
    };
    return { commands: NO_COMMANDS, state: replaceRecord(state, settled) };
  }

  if (result.kind === "deleted") {
    return {
      commands: NO_COMMANDS,
      followUpIntents: [
        {
          agentSessionId: record.agentSessionId,
          evidence: result.evidence,
          type: "session/removed"
        }
      ],
      state: removeRecord(state, record.agentSessionId).state
    };
  }

  const settled = {
    ...record,
    errorMessage: null,
    inFlightCommandId: null,
    inFlightScope: null,
    lastAbsent: false,
    messagesHydrated:
      record.messagesHydrated ||
      record.inFlightScope === "messages" ||
      record.inFlightScope === "state_and_messages" ||
      (result.messages?.length ?? 0) > 0
  };
  const followUpIntents: EngineIntent[] = [
    { session: result.session, type: "session/upserted" }
  ];
  for (const child of result.childSessions ?? []) {
    followUpIntents.push({ session: child, type: "session/upserted" });
  }
  for (const turn of result.turns ?? []) {
    followUpIntents.push({ turn, type: "turn/upserted" });
  }
  if (result.live && result.session.latestTurn) {
    followUpIntents.push({
      turn: result.session.latestTurn,
      type: "turn/upserted"
    });
  }
  if ((result.messages?.length ?? 0) > 0) {
    followUpIntents.push({
      messages: result.messages ?? [],
      type: "message/snapshotReceived",
      workspaceId: record.workspaceId
    });
  }
  const next = replaceRecord(state, settled);
  const restarted =
    settled.pendingMessages || settled.pendingState
      ? startReconcile(next, settled)
      : { commands: NO_COMMANDS, state: next };
  return {
    commands: restarted.commands,
    followUpIntents,
    state: restarted.state
  };
}

function startReconcile(
  state: SessionReconcileState,
  record: SessionReconcileRecord
): EngineReducerResult<SessionReconcileState> {
  const scope = record.pendingState
    ? record.pendingMessages
      ? "state_and_messages"
      : "state"
    : "messages";
  const commandId = `session:reconcile:${record.agentSessionId}:${state.nextCommandSequence}`;
  return {
    commands: [
      {
        agentSessionId: record.agentSessionId,
        commandId,
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
        inFlightCommandId: commandId,
        inFlightScope: scope,
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
