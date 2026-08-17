import { readFile } from "node:fs/promises";
import { setTimeout as defaultDelay } from "node:timers/promises";
import {
  createReplayActivityClock,
  providerConnectionsReached,
  replaySessionTerminalFailure,
  replayTransportFailure,
  requiredReplayCassetteId,
  writeReplayStatus
} from "./playback-helpers.mjs";
import {
  createReplayProductPorts,
  normalizeIdleSession,
  replayAgentSessionUrl
} from "./product-ports.mjs";
import {
  createReplayDeadline,
  fetchWithReplayDeadline,
  raceReplayAbort,
  readReplayResponseJson,
  readReplayResponseText,
  waitWithReplayDeadline
} from "./replay-http.mjs";
import { compactReplayWaitValue } from "./wait-diagnostics.mjs";

export class ReplayReplacementRequested extends Error {
  constructor() {
    super("Replay Cassette replacement requested");
  }
}

/**
 * Shared playback controller. Products inject dialect via `ports`
 * (`createReplayProductPorts`).
 *
 * @param {object} input
 * @param {ReturnType<typeof createReplayProductPorts> | import("./product-ports.mjs").ReplayProductPorts} input.ports
 */
export function createReplayPlaybackController(input) {
  const ports = createReplayProductPorts(input.ports);
  const wait = input.wait ?? defaultDelay;
  const fetchImpl = input.fetchImpl ?? fetch;
  const requestDeadline = (label, timeoutMs = input.timeoutMs) =>
    createReplayDeadline(timeoutMs, {
      signal: input.signal,
      label
    });
  const waitForSignal = (durationMs) =>
    raceReplayAbort(
      Promise.resolve().then(() =>
        wait(durationMs, undefined, {
          signal: input.signal
        })
      ),
      input.signal
    );
  const cassetteId = requiredReplayCassetteId(input.cassetteId);
  const bySequence = new Map(
    input.checkpoints
      .slice(1)
      .filter((checkpoint) => checkpoint.trigger.source === "activity-boundary")
      .map((checkpoint) => [
        checkpoint.trigger.afterActivityEventSequence,
        checkpoint
      ])
  );
  let currentCheckpoint = 0;
  let lastRevision = 0;
  let paused = false;
  const automatic = input.targetCheckpoint === undefined;
  let targetCheckpoint = automatic
    ? input.checkpoints.length > 1
      ? 1
      : null
    : input.targetCheckpoint;
  let targetDeadline = null;
  let activityEventSequence = 0;
  const preferFastForward = ports.timingSeekPolicy.preferFastForward === true;
  const forceRealtimeSeek = ports.timingSeekPolicy.forceRealtimeSeek === true;
  let timingMode = "realtime";
  const transportPlaybackPath = `/v1/agent-session-replay/cassettes/${encodeURIComponent(cassetteId)}/transport/playback`;
  const checkpointVerificationPath = (checkpointIndex) =>
    `/v1/agent-session-replay/cassettes/${encodeURIComponent(cassetteId)}/checkpoints/${checkpointIndex}/verify`;
  const commands = ports.transportCommands;

  const updateStatus = () =>
    writeReplayStatus(input.statusPath, {
      currentCheckpoint,
      totalCheckpoints: input.checkpoints.length,
      paused,
      timingMode,
      targetCheckpoint
    });

  const setTransport = async (command, deadline = null) => {
    const operationDeadline =
      deadline ?? requestDeadline("replay playback command");
    const response = await fetchWithReplayDeadline(
      fetchImpl,
      `${input.baseURL}${transportPlaybackPath}`,
      {
        method: "POST",
        headers: input.headers,
        body: JSON.stringify(command)
      },
      operationDeadline
    );
    if (!response.ok) {
      throw new Error(
        `replay playback command failed with ${response.status}: ${await readReplayResponseText(response, operationDeadline)}`
      );
    }
  };

  const readTransportPlayback = async (deadline = null) => {
    const operationDeadline =
      deadline ?? requestDeadline("replay playback state");
    const response = await fetchWithReplayDeadline(
      fetchImpl,
      `${input.baseURL}${transportPlaybackPath}`,
      { headers: input.headers },
      operationDeadline
    );
    const body = await readReplayResponseText(response, operationDeadline);
    if (!response.ok) {
      throw new Error(
        `replay playback state failed with ${response.status}: ${body}`
      );
    }
    return ports.normalizePlaybackState(JSON.parse(body));
  };

  const setRealtime = async () => {
    if (preferFastForward) {
      if (timingMode === "fast-forward") return;
      await setTransport({
        command: commands.setTimingMode,
        timingMode: ports.encodeTimingModeValue("fast-forward")
      });
      timingMode = "fast-forward";
      return;
    }
    if (timingMode === "realtime") return;
    await setTransport({
      command: commands.setTimingMode,
      timingMode: ports.encodeTimingModeValue("realtime")
    });
    timingMode = "realtime";
  };

  const setFastForward = async () => {
    if (forceRealtimeSeek) {
      await setRealtime();
      return;
    }
    if (timingMode === "fast-forward") return;
    await setTransport({
      command: commands.setTimingMode,
      timingMode: ports.encodeTimingModeValue("fast-forward")
    });
    timingMode = "fast-forward";
  };

  const maybeSeekFastForward = async () => {
    if (ports.fastForwardOnAutomaticSeek || !automatic) {
      await setFastForward();
    }
  };

  const installProviderTarget = async (checkpointIndex) => {
    const checkpoint = input.checkpoints[checkpointIndex];
    await setTransport({
      command: commands.setProviderCursor,
      providerConnections: checkpoint.cursor.providerConnections
    });
    targetDeadline = Date.now() + input.timeoutMs;
  };

  const providerTargetState = providerConnectionsReached;

  const verifySemanticCheckpoint = async (checkpointIndex, deadline = null) => {
    const operationDeadline =
      deadline ?? requestDeadline("replay checkpoint verification");
    const response = await fetchWithReplayDeadline(
      fetchImpl,
      `${input.baseURL}${checkpointVerificationPath(checkpointIndex)}`,
      {
        method: "POST",
        headers: input.headers
      },
      operationDeadline
    );
    const body = await readReplayResponseText(response, operationDeadline);
    if (!response.ok) {
      throw new Error(
        `replay checkpoint verification failed with ${response.status}: ${body}`
      );
    }
    const state = JSON.parse(body);
    if (
      state.checkpointIndex !== checkpointIndex ||
      typeof state.triggerMatched !== "boolean" ||
      typeof state.readinessSatisfied !== "boolean" ||
      !Number.isSafeInteger(state.canonicalSessionUpdatedAtUnixMs) ||
      state.canonicalSessionUpdatedAtUnixMs < 0 ||
      !Number.isSafeInteger(state.canonicalMessageVersion) ||
      state.canonicalMessageVersion < 0
    ) {
      throw new Error("replay checkpoint verification state is invalid");
    }
    return state;
  };

  let lastHealthyCheckAt = 0;
  const assertWatchedSessionsHealthy = async (checkpointId, options = {}) => {
    if (!ports.watchSessionsDuringPlayback) return;
    const refs = Array.isArray(input.sessionWatch) ? input.sessionWatch : [];
    if (refs.length === 0) return;
    const now = Date.now();
    if (!options.force && now - lastHealthyCheckAt < 250) return;
    lastHealthyCheckAt = now;
    for (const ref of refs) {
      const healthDeadline =
        options.deadline ??
        requestDeadline(
          `replay session health while waiting for ${checkpointId}`,
          Math.min(5_000, input.timeoutMs)
        );
      let response;
      try {
        response = await fetchWithReplayDeadline(
          fetchImpl,
          `${input.baseURL}${replayAgentSessionUrl(ports, ref.workspaceId, ref.agentSessionId)}`,
          {
            headers: input.headers
          },
          healthDeadline
        );
      } catch (error) {
        if (input.signal?.aborted) throw error;
        continue;
      }
      if (!response.ok) continue;
      const raw = await readReplayResponseJson(response, healthDeadline);
      const session = normalizeIdleSession(ports, raw);
      const reason = replaySessionTerminalFailure(session);
      if (!reason) continue;
      const transportFailure = await replayTransportFailure(
        input.baseURL,
        input.headers,
        cassetteId,
        Math.min(5_000, input.timeoutMs),
        { fetchImpl, signal: input.signal }
      );
      throw new Error(
        `replay session failed while waiting for ${checkpointId}: ${reason}` +
          `; session=${compactReplayWaitValue(session)}` +
          (transportFailure ? `\n${transportFailure}` : "")
      );
    }
  };

  const throwIfReadinessTimedOut = async (checkpointId) => {
    if (targetDeadline === null || Date.now() < targetDeadline) return;
    await assertWatchedSessionsHealthy(checkpointId, { force: true });
    throw new Error(`checkpoint_readiness_timeout: ${checkpointId}`);
  };

  const reconcileTarget = async () => {
    if (ports.applyControlBeforeReconcileTarget) {
      await applyControl();
    }
    if (targetCheckpoint === null) return;
    const checkpoint = input.checkpoints[targetCheckpoint];
    if (activityEventSequence > checkpoint.cursor.activityEventSequence) {
      throw new Error(`checkpoint_activity_overshot: ${checkpoint.id}`);
    }
    if (activityEventSequence < checkpoint.cursor.activityEventSequence) return;
    const readinessDeadline =
      targetDeadline === null
        ? null
        : requestDeadline(
            `checkpoint readiness: ${checkpoint.id}`,
            Math.max(0, targetDeadline - Date.now())
          );
    const state = await readTransportPlayback(readinessDeadline);
    if (!providerTargetState(checkpoint, state)) {
      if (ports.watchSessionsDuringPlayback) {
        await assertWatchedSessionsHealthy(checkpoint.id, {
          deadline: readinessDeadline
        });
        await throwIfReadinessTimedOut(checkpoint.id);
      } else if (targetDeadline !== null && Date.now() >= targetDeadline) {
        throw new Error(`checkpoint_readiness_timeout: ${checkpoint.id}`);
      }
      return;
    }
    const semantic = await verifySemanticCheckpoint(
      targetCheckpoint,
      readinessDeadline
    );
    if (!semantic.triggerMatched || !semantic.readinessSatisfied) {
      if (ports.watchSessionsDuringPlayback) {
        await assertWatchedSessionsHealthy(checkpoint.id, {
          deadline: readinessDeadline
        });
        await throwIfReadinessTimedOut(checkpoint.id);
      } else if (targetDeadline !== null && Date.now() >= targetDeadline) {
        throw new Error(`checkpoint_readiness_timeout: ${checkpoint.id}`);
      }
      return;
    }
    currentCheckpoint = targetCheckpoint;
    await setRealtime();
    await input.waitForInspectable?.(checkpoint, semantic);
    await input.onCheckpoint?.(currentCheckpoint);
    if (automatic && currentCheckpoint < input.checkpoints.length - 1) {
      targetCheckpoint = currentCheckpoint + 1;
      await installProviderTarget(targetCheckpoint);
      if (ports.fastForwardOnAutomaticSeek) {
        await setFastForward();
      }
      paused = false;
    } else if (automatic || input.resumeAfterTarget) {
      await setTransport({ command: commands.clearProviderCursor });
      paused = false;
      targetCheckpoint = null;
      targetDeadline = null;
    } else {
      await setTransport({ command: "pause" });
      paused = true;
      targetCheckpoint = null;
      targetDeadline = null;
    }
    await updateStatus();
  };

  const reachBootstrap = async () => {
    const deadline = requestDeadline("replay bootstrap readiness");
    while (true) {
      const semantic = await verifySemanticCheckpoint(0, deadline);
      if (semantic.triggerMatched && semantic.readinessSatisfied) {
        await input.waitForInspectable?.(input.checkpoints[0], semantic);
        await input.onCheckpoint?.(0);
        return;
      }
      await assertWatchedSessionsHealthy(input.checkpoints[0].id, {
        deadline
      });
      if (deadline.isExpired()) {
        await assertWatchedSessionsHealthy(input.checkpoints[0].id, {
          force: true,
          deadline
        });
        throw new Error(
          `checkpoint_readiness_timeout: ${input.checkpoints[0].id}`
        );
      }
      await waitWithReplayDeadline(wait, 25, deadline);
    }
  };

  const applyControl = async () => {
    if (!input.controlPath) return;
    let document;
    try {
      document = JSON.parse(await readFile(input.controlPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new Error(
        `replay control is invalid: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (
      document?.schemaVersion !== 2 ||
      !document.cassettes ||
      typeof document.cassettes !== "object" ||
      Array.isArray(document.cassettes)
    ) {
      throw new Error("replay control router is invalid");
    }
    const control = document.cassettes[cassetteId];
    if (control == null) return;
    if (typeof control !== "object" || Array.isArray(control)) {
      throw new Error("replay cassette control is invalid");
    }
    if (control.revision === lastRevision) return;
    if (
      !Number.isSafeInteger(control.revision) ||
      control.revision <= lastRevision
    ) {
      throw new Error("replay control revision is invalid");
    }
    switch (control.command) {
      case "pause":
        await setTransport({ command: "pause" });
        paused = true;
        targetCheckpoint = null;
        targetDeadline = null;
        break;
      case "resume":
        await setRealtime();
        await setTransport({ command: commands.clearProviderCursor });
        await setTransport({ command: "resume" });
        paused = false;
        targetCheckpoint = null;
        targetDeadline = null;
        break;
      case "next-checkpoint":
        if (targetCheckpoint === null) {
          targetCheckpoint = Math.min(
            currentCheckpoint + 1,
            input.checkpoints.length - 1
          );
          if (targetCheckpoint > currentCheckpoint) {
            await installProviderTarget(targetCheckpoint);
            await setFastForward();
            await setTransport({ command: "resume" });
            paused = false;
          } else {
            targetCheckpoint = null;
          }
        }
        break;
      case "switch-cassette":
        paused = true;
        lastRevision = control.revision;
        await updateStatus();
        await input.onReplacement?.({
          command: control.command,
          currentCheckpoint,
          ...(control.command === "switch-cassette"
            ? { cassetteId: control.cassetteId }
            : {})
        });
        throw new ReplayReplacementRequested();
      default:
        throw new Error(
          `unsupported replay control command: ${control.command}`
        );
    }
    lastRevision = control.revision;
    await updateStatus();
  };

  const activityClock = createReplayActivityClock({
    originOccurredAtUnixMs: input.activityClockOriginUnixMs,
    playbackState: async () => {
      await applyControl();
      return readTransportPlayback();
    },
    wait: waitForSignal
  });

  return {
    checkpointAfter(sequence) {
      return bySequence.get(sequence) ?? null;
    },
    async initialize() {
      if (
        targetCheckpoint !== null &&
        (!Number.isSafeInteger(targetCheckpoint) ||
          targetCheckpoint < 0 ||
          targetCheckpoint >= input.checkpoints.length)
      ) {
        throw new Error(
          `replay target checkpoint is invalid: ${targetCheckpoint}`
        );
      }
      if (targetCheckpoint !== 0 && input.verifyBootstrap) {
        await reachBootstrap();
      }
      if (targetCheckpoint === 0) {
        await setTransport({ command: "pause" });
        paused = true;
        targetCheckpoint = null;
        targetDeadline = null;
        await reachBootstrap();
      } else if (targetCheckpoint !== null) {
        await installProviderTarget(targetCheckpoint);
        await maybeSeekFastForward();
        await setTransport({ command: "resume" });
      }
      await updateStatus();
    },
    async reach(checkpoint) {
      if (checkpoint.index === targetCheckpoint) await reconcileTarget();
    },
    async waitBeforeActivity(sequence) {
      while (true) {
        await reconcileTarget();
        if (ports.applyControlWhileWaitingBeforeActivity) {
          await applyControl();
        }
        const blockedByTarget =
          targetCheckpoint !== null &&
          sequence >
            input.checkpoints[targetCheckpoint].cursor.activityEventSequence;
        if (!paused && !blockedByTarget) return;
        await waitForSignal(25);
      }
    },
    async waitUntilRunnable() {
      while (true) {
        await reconcileTarget();
        await activityClock.synchronize();
        if (!paused) return;
        await waitForSignal(50);
      }
    },
    async activityAdvanced(sequence) {
      activityEventSequence = sequence;
      await reconcileTarget();
    },
    async waitForAllCheckpoints() {
      while (currentCheckpoint < input.checkpoints.length - 1) {
        await reconcileTarget();
        await waitForSignal(25);
      }
    },
    waitForRecordedEvent(occurredAtUnixMs) {
      return activityClock.waitUntil(occurredAtUnixMs);
    },
    async runWhilePolling(operation) {
      let settled = false;
      const result = Promise.resolve()
        .then(operation)
        .finally(() => {
          settled = true;
        });
      while (!settled) {
        await Promise.race([result.catch(() => undefined), waitForSignal(50)]);
        if (!settled) {
          await applyControl();
          if (ports.watchSessionsDuringPlayback) {
            const watching =
              targetCheckpoint !== null
                ? input.checkpoints[targetCheckpoint]?.id
                : input.checkpoints[currentCheckpoint]?.id;
            if (watching) await assertWatchedSessionsHealthy(watching);
          }
        }
      }
      return result;
    },
    async waitForReplacement(isSurfaceOpen) {
      while (isSurfaceOpen()) {
        await applyControl();
        await waitForSignal(50);
      }
    }
  };
}
