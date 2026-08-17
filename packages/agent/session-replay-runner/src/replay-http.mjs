/**
 * Shared deadline and cancellation primitives for replay HTTP/wait paths.
 *
 * A replay wait owns one deadline. Every request and delay derives its signal
 * from the remaining budget, so a hung operation cannot outlive that wait.
 * The optional parent signal is intentionally kept separate: callers can
 * cancel a cassette (or a whole replay wave) without changing timeout errors.
 */

export class ReplayDeadlineExceeded extends Error {
  constructor(label, timeoutMs, options = {}) {
    super(
      `${label} exceeded its ${timeoutMs}ms deadline`,
      options.cause ? { cause: options.cause } : undefined
    );
    this.name = "ReplayDeadlineExceeded";
    this.code = "REPLAY_DEADLINE_EXCEEDED";
    this.timeoutMs = timeoutMs;
  }
}

function replayAbortReason(signal) {
  return (
    signal?.reason ??
    new DOMException("The replay operation was aborted", "AbortError")
  );
}

export function throwIfReplayAborted(signal) {
  if (signal?.aborted) throw replayAbortReason(signal);
}

/**
 * @param {number} timeoutMs
 * @param {{ signal?: AbortSignal, label?: string }} [options]
 */
export function createReplayDeadline(timeoutMs, options = {}) {
  const hasDeadline = Number.isFinite(timeoutMs);
  const normalizedTimeoutMs = hasDeadline
    ? Math.max(0, Math.floor(timeoutMs))
    : Infinity;
  const label = String(options.label ?? "replay wait").trim() || "replay wait";
  const startedAt = Date.now();
  const deadlineAt = hasDeadline ? startedAt + normalizedTimeoutMs : Infinity;
  const parentSignal = options.signal;
  const timeoutError = (cause) =>
    new ReplayDeadlineExceeded(label, normalizedTimeoutMs, { cause });

  return {
    label,
    timeoutMs: normalizedTimeoutMs,
    deadlineAt,
    signal: parentSignal,
    remainingMs() {
      return hasDeadline ? Math.max(0, deadlineAt - Date.now()) : Infinity;
    },
    isExpired() {
      return hasDeadline && Date.now() >= deadlineAt;
    },
    timeoutError,
    throwIfAborted() {
      throwIfReplayAborted(parentSignal);
    },
    requestSignal() {
      throwIfReplayAborted(parentSignal);
      if (!hasDeadline) {
        return { signal: parentSignal, timeoutSignal: null };
      }
      const remainingMs = Math.max(1, Math.ceil(deadlineAt - Date.now()));
      if (deadlineAt <= Date.now()) throw timeoutError();
      const timeoutSignal = AbortSignal.timeout(remainingMs);
      return {
        signal: parentSignal
          ? AbortSignal.any([parentSignal, timeoutSignal])
          : timeoutSignal,
        timeoutSignal
      };
    }
  };
}

/**
 * Race an operation against a caller cancellation signal. This also guards
 * injected test/fake implementations that do not consume AbortSignal on
 * their own; native fetch still receives the same signal below.
 */
export async function raceReplayAbort(operation, signal) {
  const promise = Promise.resolve(operation);
  if (!signal) return promise;
  throwIfReplayAborted(signal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(replayAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Run one operation using the remaining deadline budget.
 * `operation` receives the derived request signal.
 */
export async function runWithReplayDeadline(operation, deadline) {
  if (!deadline || typeof deadline.requestSignal !== "function") {
    throw new Error("runWithReplayDeadline requires a replay deadline");
  }
  const { signal, timeoutSignal } = deadline.requestSignal();
  try {
    return await raceReplayAbort(
      Promise.resolve().then(() => operation(signal)),
      signal
    );
  } catch (error) {
    if (deadline.signal?.aborted) throw replayAbortReason(deadline.signal);
    if (timeoutSignal?.aborted || deadline.isExpired()) {
      throw deadline.timeoutError(error);
    }
    throw error;
  }
}

export function fetchWithReplayDeadline(fetchImpl, url, init, deadline) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchWithReplayDeadline requires fetchImpl");
  }
  return runWithReplayDeadline(
    (signal) => fetchImpl(url, { ...(init ?? {}), signal }),
    deadline
  );
}

export function readReplayResponseText(response, deadline) {
  if (!response || typeof response.text !== "function") {
    throw new Error("replay HTTP response must provide text()");
  }
  return runWithReplayDeadline(() => response.text(), deadline);
}

export async function readReplayResponseJson(response, deadline) {
  return JSON.parse(await readReplayResponseText(response, deadline));
}

export function waitWithReplayDeadline(wait, delayMs, deadline) {
  if (typeof wait !== "function") {
    throw new Error("waitWithReplayDeadline requires wait");
  }
  const remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) throw deadline.timeoutError();
  const durationMs = Math.min(
    Math.max(0, Math.ceil(Number(delayMs) || 0)),
    remainingMs
  );
  return runWithReplayDeadline(
    (signal) => wait(durationMs, undefined, { signal }),
    deadline
  );
}
