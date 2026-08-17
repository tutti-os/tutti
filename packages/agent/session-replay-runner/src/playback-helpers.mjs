import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as defaultDelay } from "node:timers/promises";
import {
  createReplayDeadline,
  fetchWithReplayDeadline,
  readReplayResponseText,
  runWithReplayDeadline,
  waitWithReplayDeadline
} from "./replay-http.mjs";

/**
 * Compare provider tape cursors (chunkSeq, then unitIndex).
 * Shared by Tutti/TSH playback controllers; transport command dialects stay
 * product-local.
 */
export function compareProviderPosition(left, right) {
  return left.chunkSeq === right.chunkSeq
    ? left.unitIndex - right.unitIndex
    : left.chunkSeq - right.chunkSeq;
}

/**
 * Whether transport provider cursors have reached (but not overshot) the
 * checkpoint targets.
 */
export function providerConnectionsReached(checkpoint, state) {
  const current = new Map(
    state.providerConnections.map((position) => [
      position.connectionId,
      position
    ])
  );
  let reached = true;
  for (const target of checkpoint.cursor.providerConnections) {
    const position = current.get(target.connectionId);
    if (!position || compareProviderPosition(position, target) < 0) {
      reached = false;
      continue;
    }
    if (compareProviderPosition(position, target) > 0) {
      throw new Error(
        `checkpoint_provider_overshot: ${checkpoint.id} ${target.connectionId}`
      );
    }
  }
  return reached;
}

/**
 * Wall-clock alignment of recorded activity timestamps to daemon playback
 * elapsed time (respects pause / speed / fast-forward).
 */
export function createReplayActivityClock(input) {
  const wait = input.wait ?? defaultDelay;
  const pollIntervalMs = input.pollIntervalMs ?? 50;
  const configuredOriginOccurredAtUnixMs = input.originOccurredAtUnixMs ?? null;
  if (
    configuredOriginOccurredAtUnixMs !== null &&
    (!Number.isSafeInteger(configuredOriginOccurredAtUnixMs) ||
      configuredOriginOccurredAtUnixMs <= 0)
  ) {
    throw new Error(
      `replay activity clock origin is invalid: ${configuredOriginOccurredAtUnixMs}`
    );
  }
  let originOccurredAtUnixMs = configuredOriginOccurredAtUnixMs;
  let originPlaybackElapsedMs = null;
  let lastTargetOccurredAtUnixMs = null;
  let skippedElapsedMs = 0;

  const synchronize = () => input.playbackState();

  return {
    synchronize,
    async waitUntil(occurredAtUnixMs) {
      if (
        !Number.isSafeInteger(occurredAtUnixMs) ||
        occurredAtUnixMs <= 0 ||
        (lastTargetOccurredAtUnixMs !== null &&
          occurredAtUnixMs < lastTargetOccurredAtUnixMs)
      ) {
        throw new Error(`replay activity time is invalid: ${occurredAtUnixMs}`);
      }
      if (originOccurredAtUnixMs === null) {
        originOccurredAtUnixMs = occurredAtUnixMs;
      }
      lastTargetOccurredAtUnixMs = occurredAtUnixMs;
      if (occurredAtUnixMs < originOccurredAtUnixMs) {
        throw new Error(`replay activity time is invalid: ${occurredAtUnixMs}`);
      }
      if (originPlaybackElapsedMs === null) {
        const playback = await synchronize();
        originPlaybackElapsedMs = playback.playbackElapsedMs;
        if (configuredOriginOccurredAtUnixMs === null) return;
      }
      const targetElapsedMs = occurredAtUnixMs - originOccurredAtUnixMs;
      while (true) {
        const playback = await synchronize();
        const playbackElapsedMs =
          playback.playbackElapsedMs -
          originPlaybackElapsedMs +
          skippedElapsedMs;
        if (playback.timingMode === "fast-forward") {
          skippedElapsedMs += Math.max(0, targetElapsedMs - playbackElapsedMs);
          return;
        }
        const remainingMs = targetElapsedMs - playbackElapsedMs;
        if (remainingMs <= 0 && !playback.paused) {
          return;
        }
        await wait(
          playback.paused
            ? pollIntervalMs
            : Math.max(
                1,
                Math.min(
                  pollIntervalMs,
                  Math.ceil(remainingMs / playback.speed)
                )
              )
        );
      }
    }
  };
}

export async function writeReplayStatus(path, status) {
  if (!path) return;
  let previous = {};
  try {
    previous = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify({ ...previous, ...status }));
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function replayStatusErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 12_000);
}

export function structuredReplayFailureCause(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.code !== "string" ||
    !value.code.trim() ||
    typeof value.message !== "string" ||
    !value.message.trim()
  ) {
    return null;
  }
  return {
    code: value.code.trim(),
    message: value.message.trim()
  };
}

export function managedReplayFailure(cassetteId, error) {
  const cause = structuredReplayFailureCause(
    error instanceof Error ? error.cause : null
  );
  return {
    ...(cause ? { cause } : {}),
    cassetteId,
    error: replayStatusErrorMessage(error)
  };
}

export function requiredReplayCassetteId(value) {
  const cassetteId = typeof value === "string" ? value.trim() : "";
  if (!cassetteId) {
    throw new Error("Replay Cassette id is required");
  }
  return cassetteId;
}

export function replayScopedEntityKey(scopeId, entityId) {
  const scope = scopeId.trim();
  return `${scope.length}:${scope}${entityId.trim()}`;
}

export function replayPendingInteraction(session, requestId) {
  const interactions = Array.isArray(session?.pendingInteractions)
    ? session.pendingInteractions
    : [];
  return (
    interactions.find(
      (interaction) =>
        interaction?.requestId === requestId &&
        interaction?.status === "pending" &&
        typeof interaction?.turnId === "string" &&
        interaction.turnId.trim()
    ) ?? null
  );
}

/**
 * Resolve live Turn id from a session GET / state projection.
 * Includes TSH `turnLifecycle.activeTurnId` as a harmless no-op on Tutti.
 */
export function replayObservedTurnId(session) {
  if (!session || typeof session !== "object") return null;
  const candidates = [
    session.activeTurnId,
    session.turnLifecycle?.activeTurnId,
    session.activeTurn?.turnId,
    session.activeTurn?.id,
    session.latestTurn?.turnId,
    session.latestTurn?.id
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

export function replayEventMayStartTurn(event) {
  return (
    ["session.create", "session.send"].includes(event.type) ||
    (event.kind === "effect" &&
      ["queue/sendPrompt", "session/activate"].includes(event.type))
  );
}

/**
 * Wait for session idle before replaying a submit only when that submit is
 * expected to drain into a send. Busy-queue submits (and send_now/immediate)
 * must not wait.
 */
export function submitRequestedRequiresSessionIdle(event, activityEvents) {
  if (event?.kind !== "intent" || event.type !== "submit/requested") {
    return false;
  }
  if (event.payload?.submitDiagnostics?.queued === true) {
    return false;
  }
  const routing = event.payload?.routing;
  if (routing === "send_now" || routing === "immediate") {
    return false;
  }
  return submitRequestedCausedSend(event, activityEvents);
}

export function submitRequestedCausedSend(event, activityEvents) {
  const eventId = event.eventId;
  if (!eventId || !Array.isArray(activityEvents)) {
    // Without a causable tape identity, treat non-queued auto submits as
    // needing idle (the historical runner default).
    return event.payload?.submitDiagnostics?.queued !== true;
  }
  return activityEvents.some(
    (candidate) =>
      candidate.kind === "effect" &&
      (candidate.type === "queue/sendPrompt" ||
        candidate.type === "session/activate") &&
      candidate.causedByEventId === eventId
  );
}

export function replayStimulusRetryableStatus(type, status) {
  switch (type) {
    case "session.send":
    case "goal.control":
    case "session.settings.update":
      return status === 409;
    case "turn.cancel":
    case "plan.decision":
      return status === 404 || status === 409;
    default:
      return false;
  }
}

export function requiredReplayRegistrations(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Replay registrations are required");
  }
  for (const registration of value) {
    if (
      !registration ||
      typeof registration.cassetteId !== "string" ||
      !registration.cassetteId.trim() ||
      typeof registration.rootAgentSessionId !== "string" ||
      !registration.rootAgentSessionId.trim() ||
      typeof registration.cassetteDirectory !== "string" ||
      !registration.cassetteDirectory.trim()
    ) {
      throw new Error("Replay registration is invalid");
    }
  }
  return value;
}

export function replayObservedHydrationError(value) {
  if (!value || typeof value !== "object") return "";
  for (const candidate of [
    value.hydrationError,
    value.cassette?.hydrationError,
    ...(Array.isArray(value.cassettes)
      ? value.cassettes.map((cassette) => cassette?.hydrationError)
      : [])
  ]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

/**
 * Terminal Host/Session failure that will never satisfy a success-path
 * checkpoint. Returning a non-empty string means the runner should fail now
 * instead of waiting for the hard readiness timeout.
 */
export function replaySessionTerminalFailure(session) {
  if (!session || typeof session !== "object") return "";
  const status = String(session.status ?? "")
    .trim()
    .toLowerCase();
  if (status === "failed") {
    return `session status is failed`;
  }
  const lifecycle = session.turnLifecycle;
  if (lifecycle && typeof lifecycle === "object") {
    const outcome = String(lifecycle.outcome ?? "")
      .trim()
      .toLowerCase();
    const phase = String(lifecycle.phase ?? "")
      .trim()
      .toLowerCase();
    // outcome=failed is terminal even while activeTurnId is briefly retained;
    // waiting for activeTurnId to clear is what dragged failures into readiness
    // timeouts.
    if (outcome === "failed") {
      return `turnLifecycle outcome is failed` + (phase ? ` (${phase})` : "");
    }
  }
  const latestTurn = session.latestTurn;
  if (latestTurn && typeof latestTurn === "object") {
    const outcome = String(latestTurn.outcome ?? "")
      .trim()
      .toLowerCase();
    if (outcome === "failed") {
      return `latestTurn outcome is failed`;
    }
  }
  return "";
}

export function replaySessionWatchRefs(activityEvents, options = {}) {
  const refs = [];
  const seen = new Set();
  const forcedWorkspaceId =
    typeof options.workspaceId === "string" ? options.workspaceId.trim() : "";
  const forcedRootSessionId =
    typeof options.rootAgentSessionId === "string"
      ? options.rootAgentSessionId.trim()
      : "";
  if (forcedWorkspaceId && forcedRootSessionId) {
    const key = `${forcedWorkspaceId}\0${forcedRootSessionId}`;
    seen.add(key);
    refs.push({
      workspaceId: forcedWorkspaceId,
      agentSessionId: forcedRootSessionId
    });
  }
  for (const event of activityEvents ?? []) {
    const workspaceId =
      forcedWorkspaceId ||
      (typeof event?.workspaceId === "string" ? event.workspaceId.trim() : "");
    const agentSessionId = forcedRootSessionId
      ? forcedRootSessionId
      : typeof event?.agentSessionId === "string"
        ? event.agentSessionId.trim()
        : "";
    if (!workspaceId || !agentSessionId) continue;
    const key = `${workspaceId}\0${agentSessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ workspaceId, agentSessionId });
  }
  return refs;
}

/**
 * GET `/v1/agent-session-replay/cassettes/:id/transport/health` and throw on
 * non-OK. Product-neutral HTTP; Room/CDP stay product-local.
 */
export async function assertReplayTransportHealthy(
  cassetteId,
  { baseURL, headers = {}, timeoutMs, fetchImpl = fetch, signal } = {}
) {
  const normalizedBaseURL = String(baseURL ?? "")
    .trim()
    .replace(/\/+$/u, "");
  if (!normalizedBaseURL) {
    throw new Error("replay transport health requires baseURL");
  }
  const path = `/v1/agent-session-replay/cassettes/${encodeURIComponent(
    cassetteId
  )}/transport/health`;
  const deadline = createReplayDeadline(timeoutMs, {
    signal,
    label: "replay transport health"
  });
  let response;
  try {
    response = await fetchWithReplayDeadline(
      fetchImpl,
      `${normalizedBaseURL}${path}`,
      { headers },
      deadline
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new Error(
      `replay transport failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
  if (!response.ok) {
    const body = await readReplayResponseText(response, deadline);
    throw new Error(`replay transport failed with ${response.status}: ${body}`);
  }
}

/**
 * Best-effort POST `/transport/verify` used when a stimulus gets HTTP 502.
 * Returns a diagnostic suffix string (empty when verify itself is healthy).
 */
export async function replayTransportFailure(
  baseURL,
  headers,
  cassetteId,
  timeoutMs,
  { fetchImpl = fetch, signal } = {}
) {
  const deadline = createReplayDeadline(timeoutMs, {
    signal,
    label: "replay transport verification"
  });
  try {
    const response = await fetchWithReplayDeadline(
      fetchImpl,
      `${baseURL}/v1/agent-session-replay/cassettes/${encodeURIComponent(cassetteId)}/transport/verify`,
      {
        method: "POST",
        headers
      },
      deadline
    );
    if (response.ok) return "";
    return `replay transport mismatch: ${await readReplayResponseText(response, deadline)}`;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return `replay transport verification failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * Poll `/transport/playback` until drained, then POST `/transport/verify`.
 * Products resolve baseURL/headers from their listener artifact first.
 * Optional `onStillDraining` runs each poll (Tutti uses it for hard-fault probes).
 */
export async function verifyDrainedReplayTransport({
  baseURL,
  headers,
  cassetteId,
  timeoutMs,
  delay,
  fetchImpl = fetch,
  onStillDraining = null,
  signal
}) {
  const deadline = createReplayDeadline(timeoutMs, {
    signal,
    label: "replay transport drain"
  });
  const transportPath = `/v1/agent-session-replay/cassettes/${encodeURIComponent(cassetteId)}/transport`;
  let latestPlayback = null;
  while (deadline.remainingMs() > 0) {
    const playbackResponse = await fetchWithReplayDeadline(
      fetchImpl,
      `${baseURL}${transportPath}/playback`,
      {
        headers
      },
      deadline
    );
    const playbackBody = await readReplayResponseText(
      playbackResponse,
      deadline
    );
    if (!playbackResponse.ok) {
      throw new Error(
        `replay transport playback failed with ${playbackResponse.status}: ${playbackBody}`
      );
    }
    latestPlayback = JSON.parse(playbackBody);
    if (latestPlayback.drained === true) {
      break;
    }
    if (typeof onStillDraining === "function") {
      await runWithReplayDeadline(
        () =>
          onStillDraining({
            baseURL,
            headers,
            cassetteId,
            timeoutMs,
            latestPlayback,
            signal
          }),
        deadline
      );
    }
    await waitWithReplayDeadline(delay, 50, deadline);
  }
  if (latestPlayback?.drained !== true) {
    throw new Error(
      `replay transport did not drain before verification: ${JSON.stringify(latestPlayback)}`
    );
  }
  const response = await fetchWithReplayDeadline(
    fetchImpl,
    `${baseURL}${transportPath}/verify`,
    {
      method: "POST",
      headers
    },
    deadline
  );
  if (!response.ok) {
    throw new Error(
      `replay transport verification failed with ${response.status}: ${await readReplayResponseText(response, deadline)}`
    );
  }
}
