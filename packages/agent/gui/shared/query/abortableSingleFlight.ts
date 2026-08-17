export interface AbortableSingleFlightResult<TValue> {
  readonly promise: Promise<TValue>;
  readonly shared: boolean;
}

export interface AbortableSingleFlightStartContext {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

type SingleFlightState = "running" | "settled" | "aborted";

interface SingleFlightEntry<TValue> {
  readonly abortController: AbortController;
  readonly consumers: Set<symbol>;
  rejectStarted?: (reason?: unknown) => void;
  promise: Promise<TValue>;
  state: SingleFlightState;
}

/**
 * Shares one abortable operation per key while keeping caller cancellation
 * independent. The underlying operation is aborted only when its final caller
 * leaves, and that entry is evicted before aborting so an immediate retry can
 * never acquire the aborted operation.
 */
export class AbortableSingleFlight<TKey, TValue> {
  private readonly entries = new Map<TKey, SingleFlightEntry<TValue>>();

  acquire(
    key: TKey,
    start: (context: AbortableSingleFlightStartContext) => Promise<TValue>,
    signal?: AbortSignal
  ): AbortableSingleFlightResult<TValue> {
    if (signal?.aborted) {
      return {
        promise: Promise.reject(createAbortError()),
        shared: false
      };
    }

    let entry = this.entries.get(key);
    let shared = true;
    if (
      !entry ||
      entry.state !== "running" ||
      entry.abortController.signal.aborted
    ) {
      shared = false;
      entry = this.createEntry(key, start);
    }

    return {
      promise: this.subscribe(key, entry, signal),
      shared
    };
  }

  abortAll(reason?: unknown): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      this.abortEntry(undefined, entry, reason);
    }
  }

  private createEntry(
    key: TKey,
    start: (context: AbortableSingleFlightStartContext) => Promise<TValue>
  ): SingleFlightEntry<TValue> {
    let resolveStarted!: (value: TValue | PromiseLike<TValue>) => void;
    let rejectStarted!: (reason?: unknown) => void;
    const started = new Promise<TValue>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const abortController = new AbortController();
    const entry: SingleFlightEntry<TValue> = {
      abortController,
      consumers: new Set(),
      promise: Promise.resolve() as Promise<TValue>,
      state: "running"
    };
    entry.rejectStarted = rejectStarted;
    entry.promise = started
      .then((value) => {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason ?? createAbortError();
        }
        return value;
      })
      .finally(() => {
        entry.state = "settled";
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
        }
      });
    this.entries.set(key, entry);

    try {
      Promise.resolve(
        start({
          signal: abortController.signal,
          abort: (reason) => this.abortEntry(key, entry, reason)
        })
      ).then(resolveStarted, rejectStarted);
    } catch (error) {
      rejectStarted(error);
    }
    // If every consumer leaves before the operation settles, the shared
    // promise still needs an explicit rejection handler to avoid an unhandled
    // rejection while the abandoned operation unwinds.
    entry.promise.catch(() => undefined);
    return entry;
  }

  private subscribe(
    key: TKey,
    entry: SingleFlightEntry<TValue>,
    signal?: AbortSignal
  ): Promise<TValue> {
    const consumer = Symbol("single-flight-consumer");
    entry.consumers.add(consumer);
    return new Promise<TValue>((resolve, reject) => {
      let finished = false;
      const finish = (settle: () => void, abortWhenUnused: boolean): void => {
        if (finished) {
          return;
        }
        finished = true;
        signal?.removeEventListener("abort", handleAbort);
        entry.consumers.delete(consumer);
        if (abortWhenUnused && entry.consumers.size === 0) {
          this.abortEntry(key, entry);
        }
        settle();
      };
      const handleAbort = (): void => {
        finish(() => reject(createAbortError()), true);
      };

      if (signal?.aborted) {
        handleAbort();
        return;
      }
      signal?.addEventListener("abort", handleAbort, { once: true });
      entry.promise.then(
        (value) => finish(() => resolve(value), false),
        (error) => finish(() => reject(error), false)
      );
    });
  }

  private abortEntry(
    key: TKey | undefined,
    entry: SingleFlightEntry<TValue>,
    reason?: unknown
  ): void {
    if (entry.state !== "running") {
      return;
    }
    entry.state = "aborted";
    if (key !== undefined && this.entries.get(key) === entry) {
      this.entries.delete(key);
    }
    const abortReason = reason ?? createAbortError();
    entry.rejectStarted?.(abortReason);
    entry.abortController.abort(abortReason);
  }
}

function createAbortError(): Error {
  const error = new Error("Single-flight request was aborted");
  error.name = "AbortError";
  return error;
}
