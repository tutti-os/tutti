import type { SessionCommandsState } from "./sessionCommands.types.ts";
import type {
  EngineCommand,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];

export function createInitialSessionCommandsState(): SessionCommandsState {
  return { bySessionId: {} };
}

export function sessionCommandsReducer(
  state: SessionCommandsState,
  intent: EngineIntent,
  context: {
    deletedSessionIds: Readonly<Record<string, true>>;
  }
): EngineReducerResult<SessionCommandsState> {
  if (intent.type === "session/availableCommandsReceived") {
    const id = intent.agentSessionId.trim();
    if (!id || context.deletedSessionIds[id] || !intent.workspaceId.trim())
      return unchanged(state);
    const commands = normalizeCommands(intent.commands);
    const current = state.bySessionId[id];
    if (
      current?.workspaceId === intent.workspaceId.trim() &&
      commandListsEqual(current.commands, commands)
    )
      return unchanged(state);
    return {
      commands: NO_COMMANDS,
      state: {
        bySessionId: {
          ...state.bySessionId,
          [id]: { commands, workspaceId: intent.workspaceId.trim() }
        }
      }
    };
  }
  if (intent.type === "session/removed") {
    const id = intent.agentSessionId.trim();
    if (!state.bySessionId[id]) return unchanged(state);
    const bySessionId = { ...state.bySessionId };
    delete bySessionId[id];
    return { commands: NO_COMMANDS, state: { bySessionId } };
  }
  return unchanged(state);
}

function normalizeCommands(values: readonly unknown[]) {
  const byName = new Map<
    string,
    import("./sessionCommands.types.ts").AgentSessionAvailableCommand
  >();
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const candidate = value as {
      name?: unknown;
      description?: unknown;
      inputHint?: unknown;
    };
    const name =
      typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!name || byName.has(name)) continue;
    byName.set(name, {
      name,
      ...(typeof candidate.description === "string" &&
      candidate.description.trim()
        ? { description: candidate.description.trim() }
        : {}),
      ...(typeof candidate.inputHint === "string" && candidate.inputHint.trim()
        ? { inputHint: candidate.inputHint.trim() }
        : {})
    });
  }
  return [...byName.values()];
}

function commandListsEqual(
  left: readonly import("./sessionCommands.types.ts").AgentSessionAvailableCommand[],
  right: readonly import("./sessionCommands.types.ts").AgentSessionAvailableCommand[]
) {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      const other = right[index];
      return (
        value.name === other?.name &&
        value.description === other.description &&
        value.inputHint === other.inputHint
      );
    })
  );
}

function unchanged(
  state: SessionCommandsState
): EngineReducerResult<SessionCommandsState> {
  return { commands: NO_COMMANDS, state };
}
