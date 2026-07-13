import type { ScopedSessionResultValidation } from "./commandResult.validation.ts";
import type {
  SessionLifecycleState,
  SessionOperationState,
  SessionSettingsUpdateState
} from "./sessionLifecycle.types.ts";
import type {
  EngineCommand,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];

export function createInitialSettingsUpdate(): SessionSettingsUpdateState {
  return {
    commandId: null,
    errorCode: null,
    errorMessage: null,
    queuedCommandId: null,
    queuedSettings: null,
    settings: null,
    status: "idle"
  };
}

export function requestSettingsUpdate(
  state: SessionLifecycleState,
  intent: Extract<EngineIntent, { type: "session/settingsUpdateRequested" }>
): EngineReducerResult<SessionLifecycleState> {
  const id = intent.agentSessionId.trim();
  const commandId = intent.commandId.trim();
  const workspaceId = intent.workspaceId.trim();
  const operation = state.operationBySessionId[id];
  if (
    !id ||
    !commandId ||
    !workspaceId ||
    !operation ||
    state.sessionsById[id]?.workspaceId !== workspaceId ||
    Object.keys(intent.settings).length === 0
  )
    return unchanged(state);
  if (operation.settingsUpdate.status === "inFlight") {
    return result(
      setOperation(state, id, {
        ...operation,
        settingsUpdate: {
          ...operation.settingsUpdate,
          queuedCommandId: commandId,
          queuedSettings: {
            ...(operation.settingsUpdate.queuedSettings ?? {}),
            ...intent.settings
          }
        }
      })
    );
  }
  if (operation.settingsUpdate.status === "unknown" && intent.retry !== true)
    return unchanged(state);
  const settings = { ...intent.settings };
  return {
    commands: [
      settingsCommand(id, workspaceId, commandId, settings, intent.timeoutMs)
    ],
    state: setOperation(state, id, {
      ...operation,
      settingsUpdate: {
        ...createInitialSettingsUpdate(),
        commandId,
        settings,
        status: "inFlight"
      }
    })
  };
}

export function settleSettingsUpdate(
  state: SessionLifecycleState,
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>,
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
  if (
    intent.outcome === "succeeded" &&
    validation?.kind === "valid" &&
    update.queuedSettings &&
    update.queuedCommandId
  ) {
    const settings = update.queuedSettings;
    const commandId = update.queuedCommandId;
    return {
      commands: [
        settingsCommand(
          id,
          state.sessionsById[id]?.workspaceId ?? "",
          commandId,
          settings
        )
      ],
      state: setOperation(state, id, {
        ...operation,
        settingsUpdate: {
          ...createInitialSettingsUpdate(),
          commandId,
          settings,
          status: "inFlight"
        }
      })
    };
  }
  const status =
    intent.outcome === "succeeded" && validation?.kind === "valid"
      ? "idle"
      : intent.outcome === "timedOut" || intent.outcome === "succeeded"
        ? "unknown"
        : "failed";
  return result(
    setOperation(state, id, {
      ...operation,
      settingsUpdate: {
        ...update,
        errorCode:
          intent.outcome === "succeeded" && validation?.kind === "invalid"
            ? "invalid_command_result"
            : (intent.errorCode ?? null),
        errorMessage: intent.errorMessage?.trim() || null,
        status
      }
    })
  );
}

export function reconcileSettingsUpdates(
  previous: SessionLifecycleState,
  next: SessionLifecycleState
): EngineReducerResult<SessionLifecycleState> {
  const commands: EngineCommand[] = [];
  let state = next;
  for (const [id, operation] of Object.entries(next.operationBySessionId)) {
    const session = next.sessionsById[id];
    if (
      operation.settingsUpdate.status !== "unknown" ||
      !session ||
      !settingsMatch(session.settings, operation.settingsUpdate.settings)
    )
      continue;
    const queuedSettings = operation.settingsUpdate.queuedSettings;
    const queuedCommandId = operation.settingsUpdate.queuedCommandId;
    if (queuedSettings && queuedCommandId) {
      commands.push(
        settingsCommand(
          id,
          session.workspaceId,
          queuedCommandId,
          queuedSettings
        )
      );
      state = setOperation(state, id, {
        ...operation,
        settingsUpdate: {
          ...createInitialSettingsUpdate(),
          commandId: queuedCommandId,
          settings: queuedSettings,
          status: "inFlight"
        }
      });
    } else {
      state = setOperation(state, id, {
        ...operation,
        settingsUpdate: createInitialSettingsUpdate()
      });
    }
  }
  return state === previous && commands.length === 0
    ? unchanged(previous)
    : { commands, state };
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
