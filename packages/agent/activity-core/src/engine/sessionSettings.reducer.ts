import type { ScopedSessionResultValidation } from "./commandResult.validation.ts";
import type {
  SessionLifecycleState,
  SessionOperationState,
  SessionSettingsActivationRequestedIntent,
  SessionSettingsPreconditionRequestedIntent,
  SessionSettingsQueueResumeRequestedIntent,
  SessionSettingsUpdateRequestedIntent,
  SessionSettingsUpdateState
} from "./sessionLifecycle.types.ts";
import type {
  EngineCommand,
  EngineCommandResultIntent,
  EngineReducerResult
} from "./types.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];

type SettingsRequestIntent =
  | SessionSettingsActivationRequestedIntent
  | SessionSettingsPreconditionRequestedIntent
  | SessionSettingsUpdateRequestedIntent;
type SettingsRequest = SessionSettingsUpdateState["queuedRequests"][number];

export function createInitialSettingsUpdate(): SessionSettingsUpdateState {
  return {
    commandId: null,
    errorCode: null,
    errorMessage: null,
    queuedCommandId: null,
    queuedRequests: [],
    queuedSettings: null,
    requestKind: null,
    settings: null,
    status: "idle",
    timeoutMs: null
  };
}

export function requestSettingsUpdate(
  state: SessionLifecycleState,
  intent: SettingsRequestIntent
): EngineReducerResult<SessionLifecycleState> {
  const id = intent.agentSessionId.trim();
  const commandId = intent.commandId.trim();
  const workspaceId = intent.workspaceId.trim();
  const operation = state.operationBySessionId[id];
  const kind =
    intent.type === "session/settingsPreconditionRequested"
      ? "promptPrecondition"
      : intent.type === "session/settingsActivationRequested"
        ? "activation"
        : "user";
  if (
    !id ||
    !commandId ||
    !workspaceId ||
    !operation ||
    state.sessionsById[id]?.workspaceId !== workspaceId ||
    Object.keys(intent.settings).length === 0 ||
    (operation.runtimeAvailability.state === "blocked" && kind === "user")
  ) {
    return unchanged(state);
  }
  const request: SettingsRequest = {
    commandId,
    kind,
    settings: { ...intent.settings },
    ...(intent.timeoutMs !== undefined ? { timeoutMs: intent.timeoutMs } : {})
  };
  const update = operation.settingsUpdate;
  if (
    update.status === "inFlight" ||
    update.status === "waitingForPromptSend" ||
    update.status === "waitingForRuntime"
  ) {
    return result(
      replaceSettingsUpdate(
        state,
        id,
        operation,
        withQueuedRequests(
          update,
          enqueueSettingsRequest(update.queuedRequests, request)
        )
      )
    );
  }
  if (update.status === "unknown") {
    if (
      intent.type === "session/settingsUpdateRequested" &&
      intent.retry !== true
    ) {
      return unchanged(state);
    }
    const queued = enqueueSettingsRequest(update.queuedRequests, request);
    const next = queued[0];
    if (!next) return unchanged(state);
    return startSettingsRequest(
      state,
      id,
      operation,
      {
        ...next,
        settings: {
          ...(update.settings ?? {}),
          ...next.settings
        }
      },
      queued.slice(1)
    );
  }
  if (update.status === "failed" && update.queuedRequests.length > 0) {
    const queued = enqueueSettingsRequest(update.queuedRequests, request);
    return startSettingsRequest(
      state,
      id,
      operation,
      queued[0]!,
      queued.slice(1)
    );
  }
  return startSettingsRequest(state, id, operation, request, []);
}

export function settleSettingsUpdate(
  state: SessionLifecycleState,
  intent: EngineCommandResultIntent,
  validation: ScopedSessionResultValidation | null
): EngineReducerResult<SessionLifecycleState> {
  const entry = Object.entries(state.operationBySessionId).find(
    ([id, operation]) =>
      operation.settingsUpdate.commandId === intent.commandId &&
      id === (intent.correlationId?.trim() ?? "")
  );
  if (!entry) return unchanged(state);
  const [id, operation] = entry;
  const update = operation.settingsUpdate;
  if (intent.outcome === "succeeded" && validation?.kind === "valid") {
    if (update.requestKind === "promptPrecondition") {
      return result(
        replaceSettingsUpdate(state, id, operation, {
          ...update,
          errorCode: null,
          errorMessage: null,
          status: "waitingForPromptSend"
        })
      );
    }
    return advanceSettingsQueue(state, id, operation);
  }
  return result(
    replaceSettingsUpdate(state, id, operation, {
      ...update,
      errorCode:
        intent.outcome === "succeeded" && validation?.kind === "invalid"
          ? "invalid_command_result"
          : (intent.errorCode ?? null),
      errorMessage: intent.errorMessage?.trim() || null,
      status:
        intent.outcome === "timedOut" || intent.outcome === "succeeded"
          ? "unknown"
          : "failed"
    })
  );
}

export function resumeSettingsQueueAfterPrompt(
  state: SessionLifecycleState,
  intent: SessionSettingsQueueResumeRequestedIntent
): EngineReducerResult<SessionLifecycleState> {
  const id = intent.agentSessionId.trim();
  const operation = state.operationBySessionId[id];
  const update = operation?.settingsUpdate;
  if (
    !operation ||
    !update ||
    update.requestKind !== "promptPrecondition" ||
    update.commandId !== intent.settingsCommandId.trim() ||
    (update.status !== "waitingForPromptSend" && update.status !== "failed")
  ) {
    return unchanged(state);
  }
  return advanceSettingsQueue(state, id, operation);
}

export function reconcileSettingsUpdates(
  previous: SessionLifecycleState,
  next: SessionLifecycleState
): EngineReducerResult<SessionLifecycleState> {
  const commands: EngineCommand[] = [];
  let state = next;
  for (const [id, initialOperation] of Object.entries(
    next.operationBySessionId
  )) {
    const operation = state.operationBySessionId[id] ?? initialOperation;
    const session = state.sessionsById[id];
    if (
      operation.settingsUpdate.status !== "unknown" ||
      !session ||
      !settingsMatch(session.settings, operation.settingsUpdate.settings)
    ) {
      continue;
    }
    const advanced = advanceSettingsQueue(state, id, operation);
    state = advanced.state;
    commands.push(...advanced.commands);
  }
  return state === previous && commands.length === 0
    ? unchanged(previous)
    : { commands, state };
}

export function resumeSettingsUpdateWhenRuntimeAvailable(
  state: SessionLifecycleState,
  rawAgentSessionId: string
): EngineReducerResult<SessionLifecycleState> {
  const id = rawAgentSessionId.trim();
  const operation = state.operationBySessionId[id];
  const update = operation?.settingsUpdate;
  if (
    !operation ||
    operation.runtimeAvailability.state !== "available" ||
    update?.status !== "waitingForRuntime" ||
    !update.commandId ||
    !update.settings
  ) {
    return unchanged(state);
  }
  return {
    commands: [
      settingsCommand(
        id,
        state.sessionsById[id]?.workspaceId ?? "",
        update.commandId,
        update.settings,
        update.timeoutMs ?? undefined
      )
    ],
    state: replaceSettingsUpdate(state, id, operation, {
      ...update,
      status: "inFlight"
    })
  };
}

function advanceSettingsQueue(
  state: SessionLifecycleState,
  id: string,
  operation: SessionOperationState
): EngineReducerResult<SessionLifecycleState> {
  const [next, ...queued] = operation.settingsUpdate.queuedRequests;
  if (!next) {
    return result(
      replaceSettingsUpdate(state, id, operation, createInitialSettingsUpdate())
    );
  }
  return startSettingsRequest(state, id, operation, next, queued);
}

function startSettingsRequest(
  state: SessionLifecycleState,
  id: string,
  operation: SessionOperationState,
  request: SettingsRequest,
  queued: readonly SettingsRequest[]
): EngineReducerResult<SessionLifecycleState> {
  const waitingForRuntime = operation.runtimeAvailability.state === "blocked";
  const update = withQueuedRequests(
    {
      ...createInitialSettingsUpdate(),
      commandId: request.commandId,
      requestKind: request.kind,
      settings: { ...request.settings },
      status: waitingForRuntime ? "waitingForRuntime" : "inFlight",
      timeoutMs: request.timeoutMs ?? null
    },
    queued
  );
  const nextState = replaceSettingsUpdate(state, id, operation, update);
  return waitingForRuntime
    ? result(nextState)
    : {
        commands: [
          settingsCommand(
            id,
            state.sessionsById[id]?.workspaceId ?? "",
            request.commandId,
            request.settings,
            request.timeoutMs
          )
        ],
        state: nextState
      };
}

function enqueueSettingsRequest(
  queued: readonly SettingsRequest[],
  request: SettingsRequest
): readonly SettingsRequest[] {
  const last = queued.at(-1);
  if (last?.kind === "user" && request.kind === "user") {
    return [
      ...queued.slice(0, -1),
      {
        ...request,
        settings: { ...last.settings, ...request.settings }
      }
    ];
  }
  return [...queued, request];
}

function withQueuedRequests(
  update: SessionSettingsUpdateState,
  queuedRequests: readonly SettingsRequest[]
): SessionSettingsUpdateState {
  const queuedSettings =
    queuedRequests.length === 0
      ? null
      : Object.assign({}, ...queuedRequests.map((request) => request.settings));
  return {
    ...update,
    queuedCommandId: queuedRequests.at(-1)?.commandId ?? null,
    queuedRequests,
    queuedSettings
  };
}

function settingsCommand(
  agentSessionId: string,
  workspaceId: string,
  commandId: string,
  settings: Readonly<Record<string, unknown>>,
  timeoutMs?: number
): EngineCommand {
  return {
    agentSessionId,
    commandId,
    correlationId: agentSessionId,
    settings,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    type: "session/updateSettings",
    workspaceId
  };
}

function settingsMatch(
  canonical: Readonly<Record<string, unknown>> | null | undefined,
  patch: Readonly<Record<string, unknown>> | null
): boolean {
  return Boolean(
    canonical &&
    patch &&
    Object.entries(patch).every(([key, value]) => canonical[key] === value)
  );
}

function replaceSettingsUpdate(
  state: SessionLifecycleState,
  id: string,
  operation: SessionOperationState,
  settingsUpdate: SessionSettingsUpdateState
): SessionLifecycleState {
  return setOperation(state, id, { ...operation, settingsUpdate });
}

function setOperation(
  state: SessionLifecycleState,
  id: string,
  operation: SessionOperationState
): SessionLifecycleState {
  return {
    ...state,
    operationBySessionId: { ...state.operationBySessionId, [id]: operation }
  };
}

function result(
  state: SessionLifecycleState
): EngineReducerResult<SessionLifecycleState> {
  return { commands: NO_COMMANDS, state };
}

function unchanged(
  state: SessionLifecycleState
): EngineReducerResult<SessionLifecycleState> {
  return { commands: NO_COMMANDS, state };
}
