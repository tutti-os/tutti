import type {
  AgentActivityMessage,
  AgentActivitySendInputResult,
  AgentActivitySession
} from "../types.ts";
import type {
  EngineCommand,
  EngineCommandResultIntent,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";
import type {
  AgentSessionActivationResult,
  PendingActivationIntentRecord,
  PendingIntentsState,
  PendingSubmitIntentRecord,
  SessionActivationRequestedIntent,
  SubmitRequestedIntent
} from "./pendingIntents.types.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];
const ACTIVATION_COMMAND_TIMEOUT_MS = 30_000;

export function createInitialPendingIntentsState(): PendingIntentsState {
  return {
    activationsByRequestId: {},
    inactiveSessionIds: {},
    submitsByClientSubmitId: {}
  };
}

export function pendingIntentsReducer(
  state: PendingIntentsState,
  intent: EngineIntent,
  context: {
    deletedSessionIds: Readonly<Record<string, true>>;
    sessionLifecycleRecords: Readonly<
      Record<
        string,
        import("./sessionLifecycle.types.ts").SessionLifecycleRecord
      >
    >;
    submitCancellationAccepted?: boolean;
  } = {
    deletedSessionIds: {},
    sessionLifecycleRecords: {}
  }
): EngineReducerResult<PendingIntentsState> {
  switch (intent.type) {
    case "activation/requested":
      if (context.deletedSessionIds[intent.agentSessionId.trim()]) {
        return unchanged(state);
      }
      return requestActivation(state, intent);
    case "activation/dismissed":
      return removeActivation(state, intent.requestId);
    case "activation/failureRecorded":
      return recordActivationFailure(state, intent);
    case "activation/failureCleared":
      return clearActivationFailure(state, intent.agentSessionId);
    case "activation/unactivateRequested":
      return requestUnactivation(state, intent);
    case "submit/requested":
      if (context.deletedSessionIds[intent.agentSessionId.trim()]) {
        return unchanged(state);
      }
      return requestSubmit(state, intent);
    case "submit/dismissed":
      return removeSubmit(state, intent.clientSubmitId);
    case "submit/canceled":
      return context.submitCancellationAccepted === true
        ? removeSubmit(state, intent.clientSubmitId)
        : unchanged(state);
    case "message/snapshotReceived":
      return confirmFromMessages(state, intent.messages);
    case "session/snapshotReceived":
      return receiveSessionSnapshot(
        state,
        intent.sessions,
        context.sessionLifecycleRecords
      );
    case "engine/commandResult":
      if (intent.commandType === "queue/sendPrompt") {
        return settleSubmitCommand(state, intent);
      }
      return intent.commandType === "session/activate"
        ? settleActivationCommand(state, intent)
        : unchanged(state);
    case "engine/intentExpired":
      return intent.expiryId.startsWith("activation:")
        ? expireActivation(state, intent.expiryId)
        : expireSubmit(state, intent.expiryId);
    case "session/removed":
      return removeSessionIntents(state, intent.agentSessionId);
    default:
      return unchanged(state);
  }
}

function requestActivation(
  state: PendingIntentsState,
  intent: SessionActivationRequestedIntent
): EngineReducerResult<PendingIntentsState> {
  const requestId = intent.requestId.trim();
  const agentSessionId = intent.agentSessionId.trim();
  const workspaceId = intent.workspaceId.trim();
  const agentTargetId = intent.agentTargetId?.trim() || null;
  if (
    !requestId ||
    !agentSessionId ||
    !workspaceId ||
    state.activationsByRequestId[requestId] ||
    (intent.mode === "new" && !agentTargetId)
  ) {
    return unchanged(state);
  }
  const content = (intent.content ?? []).map((block) => ({ ...block }));
  const record: PendingActivationIntentRecord = {
    agentSessionId,
    agentTargetId,
    clientSubmitId: intent.clientSubmitId?.trim() || null,
    content,
    cwd: intent.cwd?.trim() ?? "",
    errorCode: null,
    errorMessage: null,
    expiresAtUnixMs: intent.expiresAtUnixMs,
    ...(intent.metadata ? { metadata: { ...intent.metadata } } : {}),
    mode: intent.mode,
    requestedAtUnixMs: intent.requestedAtUnixMs,
    requestId,
    result: null,
    ...(intent.settings ? { settings: { ...intent.settings } } : {}),
    status: "requested",
    title: intent.title?.trim() || null,
    workspaceId
  };
  return {
    commands: [
      {
        dueAtUnixMs: intent.expiresAtUnixMs,
        expiryId: activationExpiryId(requestId),
        type: "engine/scheduleExpiry"
      },
      {
        agentSessionId,
        ...(agentTargetId ? { agentTargetId } : {}),
        commandId: `activate:${requestId}`,
        correlationId: requestId,
        ...(intent.cwd !== undefined ? { cwd: intent.cwd } : {}),
        ...(content.length > 0 ? { initialContent: content } : {}),
        ...(intent.initialDisplayPrompt?.trim()
          ? { initialDisplayPrompt: intent.initialDisplayPrompt.trim() }
          : {}),
        ...(intent.metadata ? { metadata: { ...intent.metadata } } : {}),
        mode: intent.mode,
        ...(intent.openclawGatewayReady !== undefined
          ? { openclawGatewayReady: intent.openclawGatewayReady }
          : {}),
        ...(intent.settings ? { settings: { ...intent.settings } } : {}),
        timeoutMs: ACTIVATION_COMMAND_TIMEOUT_MS,
        ...(intent.title?.trim() ? { title: intent.title.trim() } : {}),
        type: "session/activate",
        ...(intent.visible !== undefined ? { visible: intent.visible } : {}),
        workspaceId
      }
    ],
    state: replaceActivation(markSessionActive(state, agentSessionId), record)
  };
}

function recordActivationFailure(
  state: PendingIntentsState,
  intent: Extract<EngineIntent, { type: "activation/failureRecorded" }>
): EngineReducerResult<PendingIntentsState> {
  const agentSessionId = intent.agentSessionId.trim();
  const requestId = intent.requestId.trim();
  if (
    !agentSessionId ||
    !requestId ||
    state.activationsByRequestId[requestId]
  ) {
    return unchanged(state);
  }
  return {
    commands: NO_COMMANDS,
    state: replaceActivation(state, {
      agentSessionId,
      agentTargetId: null,
      clientSubmitId: null,
      content: [],
      cwd: "",
      errorCode: intent.errorCode?.trim() || null,
      errorMessage: intent.errorMessage.trim() || "Session activation failed.",
      expiresAtUnixMs: Number.MAX_SAFE_INTEGER,
      mode: "existing",
      requestedAtUnixMs: intent.occurredAtUnixMs,
      requestId,
      result: null,
      status: "failed",
      title: null,
      workspaceId: intent.workspaceId
    })
  };
}

function clearActivationFailure(
  state: PendingIntentsState,
  agentSessionId: string
): EngineReducerResult<PendingIntentsState> {
  const ids = Object.values(state.activationsByRequestId)
    .filter(
      (record) =>
        record.agentSessionId === agentSessionId.trim() &&
        record.status === "failed"
    )
    .map((record) => record.requestId);
  if (ids.length === 0) {
    return unchanged(state);
  }
  return {
    commands: ids
      .filter(
        (id) =>
          state.activationsByRequestId[id]?.expiresAtUnixMs !==
          Number.MAX_SAFE_INTEGER
      )
      .map((id) => ({
        expiryId: activationExpiryId(id),
        type: "engine/cancelExpiry" as const
      })),
    state: ids.reduce(deleteActivation, state)
  };
}

function requestUnactivation(
  state: PendingIntentsState,
  intent: Extract<EngineIntent, { type: "activation/unactivateRequested" }>
): EngineReducerResult<PendingIntentsState> {
  const agentSessionId = intent.agentSessionId.trim();
  if (!agentSessionId || !intent.workspaceId.trim()) {
    return unchanged(state);
  }
  const activationIds = Object.values(state.activationsByRequestId)
    .filter((record) => record.agentSessionId === agentSessionId)
    .map((record) => record.requestId);
  return {
    commands: [
      ...activationIds
        .filter(
          (id) =>
            state.activationsByRequestId[id]?.expiresAtUnixMs !==
            Number.MAX_SAFE_INTEGER
        )
        .map((id) => ({
          expiryId: activationExpiryId(id),
          type: "engine/cancelExpiry" as const
        })),
      {
        agentSessionId,
        commandId: intent.commandId,
        type: "session/unactivate" as const,
        workspaceId: intent.workspaceId
      }
    ],
    state: markSessionInactive(
      activationIds.reduce(deleteActivation, state),
      agentSessionId
    )
  };
}

function settleActivationCommand(
  state: PendingIntentsState,
  intent: EngineCommandResultIntent
): EngineReducerResult<PendingIntentsState> {
  const requestId = intent.correlationId?.trim() ?? "";
  const record = state.activationsByRequestId[requestId];
  if (!record) {
    return unchanged(state);
  }
  if (intent.outcome === "succeeded" && isActivationResult(intent.value)) {
    const result = intent.value;
    const failed =
      result.activation.status === "failed" ||
      result.session.status === "failed";
    return {
      commands: NO_COMMANDS,
      state: replaceActivation(
        markSessionActive(state, record.agentSessionId),
        {
          ...record,
          errorCode: failed ? result.error?.code?.trim() || null : null,
          errorMessage: failed ? result.error?.message?.trim() || null : null,
          result,
          status: failed ? "failed" : "confirmed"
        }
      )
    };
  }
  return {
    commands: NO_COMMANDS,
    state: replaceActivation(state, {
      ...record,
      errorCode: intent.errorCode ?? null,
      errorMessage:
        intent.outcome === "timedOut"
          ? "Session activation is being reconciled."
          : intent.errorMessage?.trim() || "Session activation failed.",
      status: intent.outcome === "timedOut" ? "uncertain" : "failed"
    })
  };
}

function receiveSessionSnapshot(
  state: PendingIntentsState,
  sessions: readonly AgentActivitySession[],
  lifecycleRecords: Readonly<
    Record<string, import("./sessionLifecycle.types.ts").SessionLifecycleRecord>
  >
): EngineReducerResult<PendingIntentsState> {
  const activationResult = confirmActivationsFromSessions(state, sessions);
  const submitResult = confirmFromSessions(
    activationResult.state,
    sessions,
    lifecycleRecords
  );
  return {
    commands: [...activationResult.commands, ...submitResult.commands],
    state: submitResult.state
  };
}

function confirmActivationsFromSessions(
  state: PendingIntentsState,
  sessions: readonly AgentActivitySession[]
): EngineReducerResult<PendingIntentsState> {
  const sessionsById = new Map(
    sessions.map((session) => [session.agentSessionId, session])
  );
  let next = state;
  for (const record of Object.values(state.activationsByRequestId)) {
    if (record.status !== "requested" && record.status !== "uncertain") {
      continue;
    }
    const session = sessionsById.get(record.agentSessionId);
    if (!session) {
      continue;
    }
    next = replaceActivation(markSessionActive(next, record.agentSessionId), {
      ...record,
      errorMessage:
        session.status === "failed"
          ? (record.errorMessage ?? "Session activation failed.")
          : null,
      status: session.status === "failed" ? "failed" : "confirmed"
    });
  }
  return next === state
    ? unchanged(state)
    : { commands: NO_COMMANDS, state: next };
}

function requestSubmit(
  state: PendingIntentsState,
  intent: SubmitRequestedIntent
): EngineReducerResult<PendingIntentsState> {
  const clientSubmitId = intent.clientSubmitId.trim();
  const agentSessionId = intent.agentSessionId.trim();
  if (
    !clientSubmitId ||
    !agentSessionId ||
    intent.content.length === 0 ||
    state.submitsByClientSubmitId[clientSubmitId]
  ) {
    return unchanged(state);
  }
  const record: PendingSubmitIntentRecord = {
    acceptedSessionVersion: null,
    agentSessionId,
    clientSubmitId,
    content: intent.content.map((block) => ({ ...block })),
    ...(intent.displayPrompt?.trim()
      ? { displayPrompt: intent.displayPrompt.trim() }
      : {}),
    errorCode: null,
    errorMessage: null,
    expiresAtUnixMs: intent.expiresAtUnixMs,
    guidance: intent.guidance === true,
    ...(intent.metadata ? { metadata: { ...intent.metadata } } : {}),
    requestedAtUnixMs: intent.requestedAtUnixMs,
    result: null,
    status: "requested",
    turnId: null,
    workspaceId: intent.workspaceId
  };
  return {
    commands: [
      {
        dueAtUnixMs: intent.expiresAtUnixMs,
        expiryId: submitExpiryId(clientSubmitId),
        type: "engine/scheduleExpiry"
      }
    ],
    state: replaceSubmit(state, record)
  };
}

function settleSubmitCommand(
  state: PendingIntentsState,
  intent: EngineCommandResultIntent
): EngineReducerResult<PendingIntentsState> {
  const clientSubmitId = intent.correlationId?.trim() ?? "";
  const record = state.submitsByClientSubmitId[clientSubmitId];
  if (!record) {
    return unchanged(state);
  }
  if (intent.outcome === "succeeded") {
    const result = isSendInputResult(intent.value) ? intent.value : null;
    return {
      commands: NO_COMMANDS,
      state: replaceSubmit(state, {
        ...record,
        acceptedSessionVersion: result
          ? activitySessionVersion(result.session)
          : null,
        result,
        status: "accepted",
        turnId: result?.turnId.trim() || null
      })
    };
  }
  return {
    commands: NO_COMMANDS,
    state: replaceSubmit(state, {
      ...record,
      errorCode: intent.errorCode ?? null,
      errorMessage:
        intent.outcome === "timedOut"
          ? "Submit delivery is being reconciled."
          : intent.errorMessage?.trim() || "Submit failed.",
      status: intent.outcome === "timedOut" ? "uncertain" : "failed"
    })
  };
}

function confirmFromMessages(
  state: PendingIntentsState,
  messages: readonly AgentActivityMessage[]
): EngineReducerResult<PendingIntentsState> {
  const confirmedIds = new Set(
    messages
      .map(messageClientSubmitId)
      .filter((value): value is string => value !== null)
  );
  if (confirmedIds.size === 0) {
    return unchanged(state);
  }
  let next = state;
  for (const clientSubmitId of confirmedIds) {
    const record = next.submitsByClientSubmitId[clientSubmitId];
    if (!record) {
      continue;
    }
    next = replaceSubmit(next, { ...record, status: "confirmed" });
  }
  return next === state
    ? unchanged(state)
    : { commands: NO_COMMANDS, state: next };
}

function confirmFromSessions(
  state: PendingIntentsState,
  sessions: readonly import("../types.ts").AgentActivitySession[],
  lifecycleRecords: Readonly<
    Record<string, import("./sessionLifecycle.types.ts").SessionLifecycleRecord>
  >
): EngineReducerResult<PendingIntentsState> {
  let next = state;
  for (const record of Object.values(state.submitsByClientSubmitId)) {
    if (record.status !== "accepted" || !record.turnId) {
      continue;
    }
    const session = sessions.find(
      (candidate) => candidate.agentSessionId === record.agentSessionId
    );
    const latestTurn = lifecycleRecords[record.agentSessionId]?.latestTurn;
    if (
      (session?.activeTurn?.turnId === record.turnId &&
        session.activeTurn.phase === "settled") ||
      (latestTurn?.turnId === record.turnId &&
        latestTurn.phase === "settled") ||
      newerTerminalSessionConfirms(record, session)
    ) {
      next = replaceSubmit(next, { ...record, status: "confirmed" });
    }
  }
  return next === state
    ? unchanged(state)
    : { commands: NO_COMMANDS, state: next };
}

function expireSubmit(
  state: PendingIntentsState,
  expiryId: string
): EngineReducerResult<PendingIntentsState> {
  if (!expiryId.startsWith("submit:")) {
    return unchanged(state);
  }
  const clientSubmitId = expiryId.slice("submit:".length);
  const record = state.submitsByClientSubmitId[clientSubmitId];
  if (!record) {
    return unchanged(state);
  }
  if (record.status === "accepted" || record.status === "confirmed") {
    return {
      commands: NO_COMMANDS,
      state: deleteSubmit(state, clientSubmitId)
    };
  }
  return {
    commands: NO_COMMANDS,
    state: replaceSubmit(state, {
      ...record,
      errorMessage:
        record.errorMessage ?? "Submit could not be confirmed in time.",
      status: "failed"
    })
  };
}

function expireActivation(
  state: PendingIntentsState,
  expiryId: string
): EngineReducerResult<PendingIntentsState> {
  const requestId = expiryId.slice("activation:".length);
  const record = state.activationsByRequestId[requestId];
  if (!record) {
    return unchanged(state);
  }
  if (record.status === "confirmed") {
    return unchanged(state);
  }
  return {
    commands: NO_COMMANDS,
    state: replaceActivation(state, {
      ...record,
      errorMessage:
        record.errorMessage ??
        "Session activation could not be confirmed in time.",
      status: "failed"
    })
  };
}

function removeActivation(
  state: PendingIntentsState,
  requestId: string
): EngineReducerResult<PendingIntentsState> {
  const id = requestId.trim();
  if (!state.activationsByRequestId[id]) {
    return unchanged(state);
  }
  return {
    commands: [
      { expiryId: activationExpiryId(id), type: "engine/cancelExpiry" }
    ],
    state: deleteActivation(state, id)
  };
}

function removeSubmit(
  state: PendingIntentsState,
  clientSubmitId: string
): EngineReducerResult<PendingIntentsState> {
  const id = clientSubmitId.trim();
  if (!state.submitsByClientSubmitId[id]) {
    return unchanged(state);
  }
  return {
    commands: [{ expiryId: submitExpiryId(id), type: "engine/cancelExpiry" }],
    state: deleteSubmit(state, id)
  };
}

function removeSessionIntents(
  state: PendingIntentsState,
  agentSessionId: string
): EngineReducerResult<PendingIntentsState> {
  const submitIds = Object.values(state.submitsByClientSubmitId)
    .filter((record) => record.agentSessionId === agentSessionId.trim())
    .map((record) => record.clientSubmitId);
  const activationIds = Object.values(state.activationsByRequestId)
    .filter((record) => record.agentSessionId === agentSessionId.trim())
    .map((record) => record.requestId);
  const wasInactive = state.inactiveSessionIds[agentSessionId.trim()] === true;
  if (submitIds.length === 0 && activationIds.length === 0 && !wasInactive) {
    return unchanged(state);
  }
  return {
    commands: [
      ...submitIds.map((id) => ({
        expiryId: submitExpiryId(id),
        type: "engine/cancelExpiry" as const
      })),
      ...activationIds.map((id) => ({
        expiryId: activationExpiryId(id),
        type: "engine/cancelExpiry" as const
      }))
    ],
    state: removeInactiveSession(
      activationIds.reduce(
        deleteActivation,
        submitIds.reduce(deleteSubmit, state)
      ),
      agentSessionId
    )
  };
}

function messageClientSubmitId(message: AgentActivityMessage): string | null {
  const value = message.payload?.clientSubmitId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function newerTerminalSessionConfirms(
  record: PendingSubmitIntentRecord,
  session: import("../types.ts").AgentActivitySession | undefined
): boolean {
  if (
    !session ||
    session.activeTurnId != null ||
    record.acceptedSessionVersion === null
  ) {
    return false;
  }
  const version = activitySessionVersion(session);
  return version !== null && version > record.acceptedSessionVersion;
}

function activitySessionVersion(
  session: import("../types.ts").AgentActivitySession
): number | null {
  return (
    session.updatedAtUnixMs ??
    session.lastEventUnixMs ??
    session.messageVersion ??
    session.createdAtUnixMs ??
    session.startedAtUnixMs ??
    null
  );
}

function isSendInputResult(
  value: unknown
): value is AgentActivitySendInputResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as Partial<AgentActivitySendInputResult>;
  return typeof result.turnId === "string" && Boolean(result.session);
}

function isActivationResult(
  value: unknown
): value is AgentSessionActivationResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as Partial<AgentSessionActivationResult>;
  return Boolean(
    result.session &&
    typeof result.session.agentSessionId === "string" &&
    result.activation &&
    typeof result.activation.status === "string"
  );
}

function activationExpiryId(requestId: string): string {
  return `activation:${requestId}`;
}

function submitExpiryId(clientSubmitId: string): string {
  return `submit:${clientSubmitId}`;
}

function replaceSubmit(
  state: PendingIntentsState,
  record: PendingSubmitIntentRecord
): PendingIntentsState {
  return {
    ...state,
    submitsByClientSubmitId: {
      ...state.submitsByClientSubmitId,
      [record.clientSubmitId]: record
    }
  };
}

function replaceActivation(
  state: PendingIntentsState,
  record: PendingActivationIntentRecord
): PendingIntentsState {
  return {
    ...state,
    activationsByRequestId: {
      ...state.activationsByRequestId,
      [record.requestId]: record
    }
  };
}

function deleteSubmit(
  state: PendingIntentsState,
  clientSubmitId: string
): PendingIntentsState {
  const submits = { ...state.submitsByClientSubmitId };
  delete submits[clientSubmitId];
  return { ...state, submitsByClientSubmitId: submits };
}

function deleteActivation(
  state: PendingIntentsState,
  requestId: string
): PendingIntentsState {
  const activations = { ...state.activationsByRequestId };
  delete activations[requestId];
  return { ...state, activationsByRequestId: activations };
}

function markSessionActive(
  state: PendingIntentsState,
  agentSessionId: string
): PendingIntentsState {
  return removeInactiveSession(state, agentSessionId);
}

function markSessionInactive(
  state: PendingIntentsState,
  agentSessionId: string
): PendingIntentsState {
  const id = agentSessionId.trim();
  return state.inactiveSessionIds[id]
    ? state
    : {
        ...state,
        inactiveSessionIds: { ...state.inactiveSessionIds, [id]: true }
      };
}

function removeInactiveSession(
  state: PendingIntentsState,
  agentSessionId: string
): PendingIntentsState {
  const id = agentSessionId.trim();
  if (!state.inactiveSessionIds[id]) {
    return state;
  }
  const inactiveSessionIds = { ...state.inactiveSessionIds };
  delete inactiveSessionIds[id];
  return { ...state, inactiveSessionIds };
}

function unchanged(
  state: PendingIntentsState
): EngineReducerResult<PendingIntentsState> {
  return { commands: NO_COMMANDS, state };
}
