import type { EngineDiagnosticSink } from "./diagnostics.ts";
import type {
  EngineCommandPort,
  EngineCommandResultIntent,
  EngineExternalCommand,
  EngineScheduledTask,
  EngineScheduler
} from "./types.ts";

// Effect executor: performs external command descriptions through the
// injected command port and feeds every settlement (success, failure,
// timeout) back into the dispatch loop as a command-result intent.
//
// The executor holds no decision logic. Retrying, fallback, and recovery are
// reducer transitions, never executed in place here.

export interface CreateEngineEffectExecutorInput {
  commandPort: EngineCommandPort;
  diagnosticSink?: EngineDiagnosticSink;
  onResult: (intent: EngineCommandResultIntent) => void;
  scheduler: EngineScheduler;
}

export interface EngineEffectExecutor {
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
    dispose() {
      disposed = true;
      for (const task of timeoutTasks) {
        task.cancel();
      }
      timeoutTasks.clear();
    },
    execute(command) {
      let settled = false;
      let timeoutTask: EngineScheduledTask | null = null;

      const finishTimeoutTask = (): void => {
        if (timeoutTask !== null) {
          timeoutTasks.delete(timeoutTask);
          timeoutTask.cancel();
          timeoutTask = null;
        }
      };

      if (command.timeoutMs !== undefined) {
        timeoutTask = scheduler.schedule(command.timeoutMs, () => {
          if (settled) {
            return;
          }
          settled = true;
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

      commandPort.execute(command).then(
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
  errorMessage: string;
} {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : null;
  const code = typeof record?.code === "string" ? record.code.trim() : "";
  const message =
    error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : String(error);
  return {
    ...(code ? { errorCode: code } : {}),
    errorMessage: message
  };
}
