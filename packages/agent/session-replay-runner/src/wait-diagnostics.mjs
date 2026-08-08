/**
 * Product-neutral stall / progress policy for long CDP or HTTP waits.
 * Does not embed Room, Electron, or desktopd — callers supply `poll`.
 */

const replayWaitDiagnostics = {
  log: null,
  progressIntervalMs: 10_000,
  stallTimeoutMs: 60_000
};

export function configureReplayWaitDiagnostics(overrides = {}) {
  if (typeof overrides.log === "function") {
    replayWaitDiagnostics.log = overrides.log;
  }
  if (Number.isFinite(overrides.progressIntervalMs)) {
    replayWaitDiagnostics.progressIntervalMs = Math.max(
      1_000,
      overrides.progressIntervalMs
    );
  }
  if (Number.isFinite(overrides.stallTimeoutMs)) {
    replayWaitDiagnostics.stallTimeoutMs = Math.max(
      0,
      overrides.stallTimeoutMs
    );
  }
  return { ...replayWaitDiagnostics };
}

export function getReplayWaitDiagnostics() {
  return { ...replayWaitDiagnostics };
}

export function compactReplayWaitValue(value, limit = 400) {
  const serialized = JSON.stringify(value) ?? "undefined";
  return serialized.length > limit
    ? `${serialized.slice(0, limit)}… (${serialized.length} chars)`
    : serialized;
}

export function formatReplayWaitSeconds(milliseconds) {
  return `${Math.round(milliseconds / 1_000)}s`;
}

/**
 * Poll until `poll()` returns a truthy `.ready`, applying hard timeout plus
 * stall detection when the observed snapshot stops changing.
 *
 * @param {{
 *   poll: () => Promise<object|null|undefined>,
 *   timeoutMs: number,
 *   label: string,
 *   intervalMs?: number,
 *   delay?: (ms: number) => Promise<void>,
 *   onPoll?: () => Promise<void>|void
 * }} input
 */
export async function pollUntilReady(input) {
  const {
    poll,
    timeoutMs,
    label,
    intervalMs = 250,
    delay,
    onPoll = null
  } = input;
  if (typeof poll !== "function") {
    throw new Error("pollUntilReady requires a poll function");
  }
  if (typeof delay !== "function") {
    throw new Error("pollUntilReady requires a delay function");
  }
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const {
    log: waitLog,
    progressIntervalMs,
    stallTimeoutMs
  } = replayWaitDiagnostics;
  let latest;
  let latestSignature;
  let lastChangeAt = startedAt;
  let lastProgressAt = startedAt;
  while (Date.now() < deadline) {
    [latest] = await Promise.all([
      poll(),
      typeof onPoll === "function" ? onPoll() : undefined
    ]);
    if (latest?.ready) return latest;
    const now = Date.now();
    const signature = JSON.stringify(latest);
    if (signature !== latestSignature) {
      latestSignature = signature;
      lastChangeAt = now;
    } else if (stallTimeoutMs > 0 && now - lastChangeAt >= stallTimeoutMs) {
      throw new Error(
        `stalled waiting for ${label}: no observable change for ` +
          `${formatReplayWaitSeconds(now - lastChangeAt)} (waited ` +
          `${formatReplayWaitSeconds(now - startedAt)} of ` +
          `${formatReplayWaitSeconds(timeoutMs)} hard timeout); last: ` +
          compactReplayWaitValue(latest)
      );
    }
    if (waitLog && now - lastProgressAt >= progressIntervalMs) {
      lastProgressAt = now;
      waitLog(
        `waiting for ${label} (${formatReplayWaitSeconds(now - startedAt)} elapsed, ` +
          `last change ${formatReplayWaitSeconds(now - lastChangeAt)} ago): ` +
          compactReplayWaitValue(latest, 200)
      );
    }
    await delay(intervalMs);
  }
  throw new Error(
    `timed out waiting for ${label} after ${formatReplayWaitSeconds(timeoutMs)}: ` +
      compactReplayWaitValue(latest)
  );
}
