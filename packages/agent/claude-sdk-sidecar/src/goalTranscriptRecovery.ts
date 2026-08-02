import { errorMessage } from "./errors.ts";
import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";
import type { QueryGeneration } from "./queryGeneration.ts";

const REPLAY_BACKOFF_MS = [25, 75] as const;
const DEFAULT_REPLAY_TIMEOUT_MS = 1_500;
const REPLAY_TIMEOUT_MESSAGE = "Claude transcript replay timed out";

export class GoalTranscriptRecovery {
  private readonly emit: ClaudeSDKSidecarEventEmitter;
  private readonly getProviderSessionId: () => string;
  private readonly shouldReplay: () => boolean;
  private readonly timeoutMs: number;

  constructor(options: {
    emit: ClaudeSDKSidecarEventEmitter;
    getProviderSessionId: () => string;
    shouldReplay: () => boolean;
    timeoutMs?: number;
  }) {
    this.emit = options.emit;
    this.getProviderSessionId = options.getProviderSessionId;
    this.shouldReplay = options.shouldReplay;
    this.timeoutMs = Math.max(
      1,
      options.timeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS
    );
  }

  async recover(generation: QueryGeneration): Promise<void> {
    this.emitReplay(generation, "started");
    const store = generation.transcriptObservationStore;
    if (!store) {
      this.emitReplay(generation, "failed", {
        reason: "observation_store_unavailable"
      });
      return;
    }

    let lastAttempt = 0;
    let lastError: unknown;
    const deadline = Date.now() + this.timeoutMs;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        lastError = replayTimeoutError();
        break;
      }
      lastAttempt = attempt;
      const timeout = new AbortController();
      const timeoutId = setTimeout(
        () => timeout.abort(replayTimeoutError()),
        remainingMs
      );
      try {
        await store.replay(this.getProviderSessionId(), {
          signal: AbortSignal.any([
            generation.cancelController.signal,
            timeout.signal
          ])
        });
        lastError = undefined;
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeoutId);
      }

      if (generation.cancelController.signal.aborted) {
        this.emitCanceled(generation, attempt);
        return;
      }
      if (!this.shouldReplay()) {
        this.emitReplay(generation, "completed", {
          attempt,
          goalGenerationStillActive: false
        });
        return;
      }
      if (isReplayTimeout(lastError)) {
        break;
      }
      const backoffMs = REPLAY_BACKOFF_MS[attempt - 1];
      if (
        backoffMs !== undefined &&
        !(await waitForBackoff(backoffMs, generation.cancelController.signal))
      ) {
        this.emitCanceled(generation, attempt);
        return;
      }
    }

    this.emitReplay(
      generation,
      lastError === undefined ? "incomplete" : "failed",
      {
        attempt: lastAttempt,
        goalGenerationStillActive: true,
        reason:
          lastError === undefined
            ? "terminal_goal_status_unavailable"
            : isReplayTimeout(lastError)
              ? "native_replay_timeout"
              : "native_replay_failed",
        ...(lastError === undefined ? {} : { error: errorMessage(lastError) })
      }
    );
  }

  private emitCanceled(generation: QueryGeneration, attempt: number): void {
    this.emitReplay(generation, "canceled", {
      attempt,
      goalGenerationStillActive: this.shouldReplay()
    });
  }

  private emitReplay(
    generation: QueryGeneration,
    phase: string,
    payload: Record<string, unknown> = {}
  ): void {
    this.emit({
      type: "goal_transcript_replay",
      payload: {
        phase,
        queryGenerationId: generation.id,
        liveGoalStatusEntryCount: generation.liveGoalTranscriptEntryCount,
        replayedGoalStatusEntryCount:
          generation.replayedGoalTranscriptEntryCount,
        ...payload
      }
    });
  }
}

function replayTimeoutError(): Error {
  return new Error(REPLAY_TIMEOUT_MESSAGE);
}

function isReplayTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === REPLAY_TIMEOUT_MESSAGE;
}

function waitForBackoff(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timeoutId);
      resolve(false);
    };
    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
