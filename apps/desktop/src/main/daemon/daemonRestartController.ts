export interface DaemonRestartLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface DaemonRestartConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  healthyResetMs: number;
}

export interface DaemonRestartControllerDeps {
  restart: () => Promise<void>;
  isStopRequested: () => boolean;
  delay: (ms: number) => Promise<void>;
  now: () => number;
  logger: DaemonRestartLogger;
  config?: DaemonRestartConfig;
}

export interface DaemonRestartController {
  notifyExited(): Promise<boolean>;
  notifyStarted(): void;
}

const defaultConfig: DaemonRestartConfig = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 5,
  healthyResetMs: 30_000
};

export function createDaemonRestartController(
  deps: DaemonRestartControllerDeps
): DaemonRestartController {
  const config = deps.config ?? defaultConfig;

  let attempts = 0;
  let lastHealthyAt: number | null = null;
  let inFlight: Promise<boolean> | null = null;

  function backoffDelayMs(attempt: number): number {
    return Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs);
  }

  async function runRestartLoop(): Promise<boolean> {
    // A sustained-healthy period before this death earns a fresh retry budget.
    // Evaluate once per cycle — doing it inside the loop would re-fire on every
    // failing retry (lastHealthyAt stays old) and never reach maxAttempts.
    if (
      lastHealthyAt !== null &&
      deps.now() - lastHealthyAt >= config.healthyResetMs
    ) {
      attempts = 0;
    }

    while (!deps.isStopRequested()) {
      if (attempts >= config.maxAttempts) {
        deps.logger.error("managed tuttid restart giving up", {
          attempts
        });
        return false;
      }

      const waitMs = backoffDelayMs(attempts);
      attempts += 1;
      await deps.delay(waitMs);

      if (deps.isStopRequested()) {
        return false;
      }

      try {
        await deps.restart();
        if (deps.isStopRequested()) {
          return false;
        }
        lastHealthyAt = deps.now();
        deps.logger.info("managed tuttid restarted", { attempts });
        return true;
      } catch (error: unknown) {
        deps.logger.error("managed tuttid restart failed", {
          attempts,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return false;
  }

  return {
    notifyExited() {
      if (deps.isStopRequested()) {
        return Promise.resolve(false);
      }

      if (inFlight) {
        return inFlight;
      }

      inFlight = runRestartLoop().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    notifyStarted() {
      // A restart cycle in flight owns the attempt budget (so crash-loop
      // escalation is preserved). Any other successful start — initial boot or
      // recovery after give-up — marks the daemon healthy and resets the budget
      // so future exits get a fresh round of restarts.
      if (inFlight) {
        return;
      }
      attempts = 0;
      lastHealthyAt = deps.now();
    }
  };
}
