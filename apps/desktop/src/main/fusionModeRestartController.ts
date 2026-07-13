export type FusionModeRestartDecision = "later" | "restart";

export interface FusionModeRestartController {
  dispose(): void;
  observePersistedMode(active: boolean): void;
}

export interface FusionModeRestartControllerOptions {
  currentProcessModeActive: boolean;
  onError?(error: unknown): void;
  prompt(targetModeActive: boolean): Promise<FusionModeRestartDecision>;
  readPersistedMode(): Promise<boolean>;
  restart(): Promise<void> | void;
}

/**
 * Coordinates a startup-selected presentation mode with durable preferences.
 *
 * The controller deliberately never mutates the current process mode. It only
 * offers a restart after an authoritative preference snapshot diverges from
 * the mode selected at startup.
 */
export function createFusionModeRestartController(
  options: FusionModeRestartControllerOptions
): FusionModeRestartController {
  let dismissedTargetMode: boolean | null = null;
  let disposed = false;
  let latestPersistedMode = options.currentProcessModeActive;
  let observationRevision = 0;
  let promptInFlight = false;
  let restartRequested = false;

  return {
    dispose() {
      disposed = true;
    },
    observePersistedMode(active) {
      if (disposed || restartRequested) {
        return;
      }
      latestPersistedMode = active;
      observationRevision += 1;
      if (active === options.currentProcessModeActive) {
        dismissedTargetMode = null;
      }
      void reconcile();
    }
  };

  async function reconcile(): Promise<void> {
    if (
      disposed ||
      restartRequested ||
      promptInFlight ||
      latestPersistedMode === options.currentProcessModeActive ||
      dismissedTargetMode === latestPersistedMode
    ) {
      return;
    }

    const targetMode = latestPersistedMode;
    const revisionAtPromptStart = observationRevision;
    promptInFlight = true;
    let failed = false;
    try {
      const decision = await options.prompt(targetMode);
      if (disposed) {
        return;
      }
      if (decision === "later") {
        if (latestPersistedMode === options.currentProcessModeActive) {
          dismissedTargetMode = null;
        } else if (latestPersistedMode === targetMode) {
          dismissedTargetMode = targetMode;
        }
        return;
      }

      const persistedModeBeforeRestart = await options.readPersistedMode();
      if (disposed) {
        return;
      }
      latestPersistedMode = persistedModeBeforeRestart;
      if (persistedModeBeforeRestart === options.currentProcessModeActive) {
        dismissedTargetMode = null;
        return;
      }

      restartRequested = true;
      await options.restart();
    } catch (error) {
      failed = true;
      restartRequested = false;
      options.onError?.(error);
    } finally {
      promptInFlight = false;
      if (
        !disposed &&
        !restartRequested &&
        !failed &&
        observationRevision !== revisionAtPromptStart
      ) {
        void reconcile();
      }
    }
  }
}
