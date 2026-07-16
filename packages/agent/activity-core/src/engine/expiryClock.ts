import type {
  EngineClock,
  EngineExpiryCommand,
  EngineIntentExpiredIntent,
  EngineScheduledTask,
  EngineScheduler
} from "./types.ts";

// Expiry clock: turns scheduleExpiry/cancelExpiry command descriptions into
// host-clock scheduling and feeds elapsed deadlines back into the dispatch
// loop as expiry intents. Reducers never read the wall clock or set timers;
// this is the only place where deadlines meet real time.

export interface CreateEngineExpiryClockInput {
  clock: EngineClock;
  onExpired: (intent: EngineIntentExpiredIntent) => void;
  scheduler: EngineScheduler;
}

export interface EngineExpiryClock {
  apply(command: EngineExpiryCommand): void;
  dispose(): void;
}

export function createEngineExpiryClock({
  clock,
  onExpired,
  scheduler
}: CreateEngineExpiryClockInput): EngineExpiryClock {
  const tasksByExpiryId = new Map<string, EngineScheduledTask>();
  let disposed = false;

  const cancelExpiry = (expiryId: string): void => {
    const task = tasksByExpiryId.get(expiryId);
    if (task !== undefined) {
      task.cancel();
      tasksByExpiryId.delete(expiryId);
    }
  };

  return {
    apply(command) {
      if (disposed) {
        return;
      }
      if (command.type === "engine/cancelExpiry") {
        cancelExpiry(command.expiryId);
        return;
      }
      // Rescheduling the same expiry id replaces the previous deadline.
      cancelExpiry(command.expiryId);
      const delayMs = Math.max(0, command.dueAtUnixMs - clock.nowUnixMs());
      const task = scheduler.schedule(delayMs, () => {
        tasksByExpiryId.delete(command.expiryId);
        onExpired({
          dueAtUnixMs: command.dueAtUnixMs,
          expiryId: command.expiryId,
          type: "engine/intentExpired"
        });
      });
      tasksByExpiryId.set(command.expiryId, task);
    },
    dispose() {
      disposed = true;
      for (const task of tasksByExpiryId.values()) {
        task.cancel();
      }
      tasksByExpiryId.clear();
    }
  };
}
