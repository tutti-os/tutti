import type { EngineDiagnosticSink } from "./diagnostics.ts";
import type {
  AgentSessionActivateEffectInput,
  EngineCommandPort,
  EngineCommandResultIntent,
  EngineExternalCommand,
  EngineScheduledTask,
  EngineScheduler,
  EngineTypedCommandPort
} from "./types.ts";
import { executeAgentActivityPromptCommand } from "./promptCommandExecution.ts";

// Effect executor: performs external command descriptions through the
// injected command port and feeds every settlement (success, failure,
// timeout) back into the dispatch loop as a command-result intent.
//
// The executor holds no decision logic. Retrying, fallback, and recovery are
// reducer transitions, never executed in place here.

export interface CreateEngineEffectExecutorInput {
  commandPort: EngineCommandPort | EngineTypedCommandPort;
  diagnosticSink?: EngineDiagnosticSink;
  onResult: (intent: EngineCommandResultIntent) => void;
  scheduler: EngineScheduler;
}

export interface EngineEffectExecutor {
  abort(commandId: string, reason: string): void;
  dispose(): void;
  execute(command: EngineExternalCommand): void;
}

export function createEngineEffectExecutor({
  commandPort,
  diagnosticSink,
  onResult,
  scheduler
}: CreateEngineEffectExecutorInput): EngineEffectExecutor {
  let disposed = false;
  const timeoutTasks = new Set<EngineScheduledTask>();
  const abortControllersByCommandId = new Map<string, AbortController>();

  const settle = (intent: EngineCommandResultIntent): void => {
    if (disposed) {
      diagnosticSink?.({
        commandId: intent.commandId,
        type: "commandResultAfterDispose"
      });
      return;
    }
    onResult(intent);
  };

  return {
    abort(commandId, reason) {
      const controller = abortControllersByCommandId.get(commandId.trim());
      if (!controller || controller.signal.aborted) return;
      controller.abort(new Error(reason.trim() || "engine command aborted"));
    },
    dispose() {
      disposed = true;
      for (const task of timeoutTasks) {
        task.cancel();
      }
      timeoutTasks.clear();
      for (const controller of abortControllersByCommandId.values()) {
        controller.abort(new Error("engine disposed"));
      }
      abortControllersByCommandId.clear();
    },
    execute(command) {
      commandPort.observe?.(command);
      let settled = false;
      let timeoutTask: EngineScheduledTask | null = null;
      const abortController = new AbortController();
      abortControllersByCommandId.set(command.commandId, abortController);

      const finishTimeoutTask = (): void => {
        if (
          abortControllersByCommandId.get(command.commandId) === abortController
        ) {
          abortControllersByCommandId.delete(command.commandId);
        }
        if (timeoutTask !== null) {
          timeoutTasks.delete(timeoutTask);
          timeoutTask.cancel();
          timeoutTask = null;
        }
      };

      const timeoutMs = "timeoutMs" in command ? command.timeoutMs : undefined;
      if (timeoutMs !== undefined) {
        timeoutTask = scheduler.schedule(timeoutMs, () => {
          if (settled) {
            return;
          }
          settled = true;
          abortController.abort(new Error("engine command timed out"));
          finishTimeoutTask();
          settle({
            commandId: command.commandId,
            commandType: command.type,
            ...commandCorrelationFields(command),
            outcome: "timedOut",
            type: "engine/commandResult"
          });
        });
        timeoutTasks.add(timeoutTask);
      }

      const execution = executeCommand(
        commandPort,
        command,
        abortController.signal
      );
      execution.then(
        (value) => {
          if (settled) {
            diagnosticSink?.({
              commandId: command.commandId,
              type: "commandResultAfterTimeout"
            });
            return;
          }
          settled = true;
          finishTimeoutTask();
          settle({
            commandId: command.commandId,
            commandType: command.type,
            ...commandCorrelationFields(command),
            outcome: "succeeded",
            type: "engine/commandResult",
            value
          });
        },
        (error: unknown) => {
          if (settled) {
            diagnosticSink?.({
              commandId: command.commandId,
              type: "commandResultAfterTimeout"
            });
            return;
          }
          settled = true;
          finishTimeoutTask();
          settle({
            commandId: command.commandId,
            commandType: command.type,
            ...commandCorrelationFields(command),
            ...engineCommandErrorFields(error),
            outcome: "failed",
            type: "engine/commandResult"
          });
        }
      );
    }
  };
}

function executeCommand(
  commandPort: EngineCommandPort | EngineTypedCommandPort,
  command: EngineExternalCommand,
  signal: AbortSignal
): Promise<unknown> {
  if (command.type === "plan/submitDecision") {
    return commandPort.executePlanDecision
      ? commandPort.executePlanDecision(command, { signal })
      : Promise.reject(
          new Error("EngineCommandPort.executePlanDecision is not configured")
        );
  }
  if (commandPort.kind !== "typed") {
    return commandPort.execute(command, { signal });
  }
  const effects = commandPort.effects;
  switch (command.type) {
    case "session/activate":
      return effects.activateSession(activationInput(command), {
        signal
      });
    case "queue/sendPrompt":
      return executeAgentActivityPromptCommand(
        {
          sendInput: (input) => effects.sendInput(input, { signal }),
          updateSessionSettings: (input) =>
            effects.updateSessionSettings(
              {
                ...input,
                commandId: command.commandId,
                correlationId: command.correlationId ?? command.commandId
              },
              { signal }
            )
        },
        command,
        { signal }
      );
    case "session/updateSettings":
      return effects.updateSessionSettings(
        {
          agentSessionId: command.agentSessionId,
          commandId: command.commandId,
          correlationId: command.correlationId,
          settings: command.settings,
          workspaceId: command.workspaceId
        },
        { signal }
      );
    case "turn/cancel":
      return effects.cancelTurn(
        {
          agentSessionId: command.agentSessionId,
          turnId: command.turnId,
          workspaceId: command.workspaceId
        },
        { signal }
      );
    case "interaction/respond":
      return effects.respondToInteraction(
        {
          ...(command.action ? { action: command.action } : {}),
          agentSessionId: command.agentSessionId,
          ...(command.optionId ? { optionId: command.optionId } : {}),
          ...(command.payload ? { payload: { ...command.payload } } : {}),
          requestId: command.requestId,
          turnId: command.turnId,
          workspaceId: command.workspaceId
        },
        { signal }
      );
    default:
      return commandPort.execute(command, { signal });
  }
}

function activationInput(
  command: Extract<EngineExternalCommand, { type: "session/activate" }>
): AgentSessionActivateEffectInput {
  const shared = {
    agentSessionId: command.agentSessionId,
    ...(command.capabilityRefs?.length
      ? { capabilityRefs: command.capabilityRefs }
      : {}),
    ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
    ...(command.initialContent
      ? { initialContent: [...command.initialContent] }
      : {}),
    ...(command.initialDisplayPrompt !== undefined
      ? { initialDisplayPrompt: command.initialDisplayPrompt }
      : {}),
    ...(command.railPlacement
      ? { railPlacement: { ...command.railPlacement } }
      : {}),
    ...(command.settings ? { settings: { ...command.settings } } : {}),
    ...(command.submitDiagnostics
      ? { submitDiagnostics: { ...command.submitDiagnostics } }
      : {}),
    ...(command.title !== undefined ? { title: command.title } : {}),
    ...(command.visible !== undefined ? { visible: command.visible } : {}),
    workspaceId: command.workspaceId
  };
  return command.mode === "new"
    ? {
        ...shared,
        agentTargetId: command.agentTargetId,
        clientSubmitId: command.clientSubmitId,
        ...(command.initialGoalControl
          ? { initialGoalControl: { ...command.initialGoalControl } }
          : {}),
        ...(command.initialTuttiModeActivation
          ? {
              initialTuttiModeActivation: {
                ...command.initialTuttiModeActivation
              }
            }
          : {}),
        mode: "new"
      }
    : {
        ...shared,
        agentTargetId: command.agentTargetId,
        mode: "existing"
      };
}

function commandCorrelationFields(command: EngineExternalCommand): {
  correlationId?: string;
} {
  if (!("correlationId" in command)) {
    return {};
  }
  const value = command.correlationId;
  return typeof value === "string" && value.trim()
    ? { correlationId: value.trim() }
    : {};
}

function engineCommandErrorFields(error: unknown): {
  errorCode?: string;
  errorReason?: string;
  errorMessage: string;
} {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : null;
  const code = typeof record?.code === "string" ? record.code.trim() : "";
  const reason = typeof record?.reason === "string" ? record.reason.trim() : "";
  const message =
    error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : String(error);
  return {
    ...(code ? { errorCode: code } : {}),
    ...(reason ? { errorReason: reason } : {}),
    errorMessage: message
  };
}
