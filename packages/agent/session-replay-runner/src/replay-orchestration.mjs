import { raceReplayAbort, throwIfReplayAborted } from "./replay-http.mjs";

/**
 * Run one Replay Workspace's cassettes as one cancellation wave.
 *
 * The first cassette failure owns the wave's abort reason. Every cassette gets
 * exactly one terminal outcome, and a late worker result cannot turn an
 * already-cancelled sibling into a successful completion.
 *
 * @param {Array<{ cassetteId: string }>} cassettes
 * @param {(cassette: object, signal: AbortSignal) => unknown} runCassette
 * @param {{
 *   onFirstFailure?: (failure: object, signal: AbortSignal) => void,
 *   onTerminal?: (cassette: object, outcome: object) => void,
 *   timeoutMs?: number,
 * }} [options]
 */
export async function runReplayCassetteBatch(
  cassettes,
  runCassette,
  options = {}
) {
  if (!Array.isArray(cassettes) || cassettes.length === 0) {
    throw new Error("Replay Cassette batch is required");
  }
  if (typeof runCassette !== "function") {
    throw new Error("runReplayCassetteBatch requires runCassette");
  }
  if (
    options.onTerminal !== undefined &&
    typeof options.onTerminal !== "function"
  ) {
    throw new Error("runReplayCassetteBatch onTerminal must be a function");
  }
  if (
    options.onFirstFailure !== undefined &&
    typeof options.onFirstFailure !== "function"
  ) {
    throw new Error("runReplayCassetteBatch onFirstFailure must be a function");
  }

  const cassetteIds = new Set();
  for (const cassette of cassettes) {
    const cassetteId = cassette?.cassetteId;
    if (typeof cassetteId !== "string" || !cassetteId.trim()) {
      throw new Error("Replay Cassette batch identity is required");
    }
    if (cassetteIds.has(cassetteId)) {
      throw new Error(
        `duplicate Replay Cassette batch identity: ${cassetteId}`
      );
    }
    cassetteIds.add(cassetteId);
  }

  const controller = new AbortController();
  const terminalOutcomes = new Map();
  let firstFailure = null;
  let timeout = null;

  const recordFirstFailure = (cassette, error) => {
    if (firstFailure) return firstFailure;
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    firstFailure = { cassetteId: cassette.cassetteId, error: normalizedError };
    controller.abort(normalizedError);
    try {
      options.onFirstFailure?.(firstFailure, controller.signal);
    } catch {
      // Cancellation hooks cannot replace the replay root cause.
    }
    return firstFailure;
  };

  const reportTerminal = (cassette, outcome) => {
    if (terminalOutcomes.has(cassette.cassetteId)) return;
    terminalOutcomes.set(cassette.cassetteId, outcome);
    options.onTerminal?.(cassette, outcome);
  };

  const runOne = async (cassette) => {
    let outcome;
    try {
      const result = await raceReplayAbort(
        Promise.resolve().then(() => runCassette(cassette, controller.signal)),
        controller.signal
      );
      // A fake or late worker may resolve after the shared signal was aborted.
      // It is still an interrupted sibling, never a successful cassette.
      throwIfReplayAborted(controller.signal);
      outcome = {
        cassetteId: cassette.cassetteId,
        result,
        succeeded: true
      };
    } catch (error) {
      recordFirstFailure(cassette, error);
      outcome = {
        cassetteId: cassette.cassetteId,
        error: firstFailure.error,
        succeeded: false
      };
    }
    reportTerminal(cassette, outcome);
    return outcome;
  };

  const normalizedTimeoutMs = Number(options.timeoutMs);
  if (Number.isFinite(normalizedTimeoutMs) && normalizedTimeoutMs > 0) {
    timeout = setTimeout(() => {
      if (firstFailure) return;
      const activeCassette =
        cassettes.find(
          (cassette) => !terminalOutcomes.has(cassette.cassetteId)
        ) ?? cassettes[0];
      recordFirstFailure(
        activeCassette,
        new Error(
          `replay workspace exceeded its ${Math.floor(normalizedTimeoutMs)}ms deadline`
        )
      );
    }, normalizedTimeoutMs);
  }

  let results;
  try {
    results = await Promise.all(cassettes.map((cassette) => runOne(cassette)));
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
  return {
    firstFailure,
    results,
    signal: controller.signal,
    terminalOutcomes
  };
}
