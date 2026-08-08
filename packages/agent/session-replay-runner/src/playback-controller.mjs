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

  const setTransport = async (command) => {
    const response = await fetch(`${input.baseURL}${transportPlaybackPath}`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(input.timeoutMs)
    });
    if (!response.ok) {
      throw new Error(
        `replay playback command failed with ${response.status}: ${await response.text()}`
      );
    }
  };

  const readTransportPlayback = async () => {
    const response = await fetch(`${input.baseURL}${transportPlaybackPath}`, {
      headers: input.headers,
      signal: AbortSignal.timeout(input.timeoutMs)
    });
    const body = await response.text();
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

  const verifySemanticCheckpoint = async (checkpointIndex) => {
    const response = await fetch(
      `${input.baseURL}${checkpointVerificationPath(checkpointIndex)}`,
      {
        method: "POST",
        headers: input.headers,
        signal: AbortSignal.timeout(input.timeoutMs)
      }
    );
    const body = await response.text();
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
      let response;
      try {
        response = await fetch(
          `${input.baseURL}${replayAgentSessionUrl(ports, ref.workspaceId, ref.agentSessionId)}`,
          {
            headers: input.headers,
            signal: AbortSignal.timeout(Math.min(5_000, input.timeoutMs))
          }
        );
      } catch {
        continue;
      }
      if (!response.ok) continue;
      const raw = await response.json();
      const session = normalizeIdleSession(ports, raw);
      const reason = replaySessionTerminalFailure(session);
      if (!reason) continue;
      const transportFailure = await replayTransportFailure(
        input.baseURL,
        input.headers,
        cassetteId,
        Math.min(5_000, input.timeoutMs)
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
    const state = await readTransportPlayback();
    if (!providerTargetState(checkpoint, state)) {
      if (ports.watchSessionsDuringPlayback) {
        await assertWatchedSessionsHealthy(checkpoint.id);
        await throwIfReadinessTimedOut(checkpoint.id);
      } else if (targetDeadline !== null && Date.now() >= targetDeadline) {
        throw new Error(`checkpoint_readiness_timeout: ${checkpoint.id}`);
      }
      return;
    }
    const semantic = await verifySemanticCheckpoint(targetCheckpoint);
    if (!semantic.triggerMatched || !semantic.readinessSatisfied) {
      if (ports.watchSessionsDuringPlayback) {
        await assertWatchedSessionsHealthy(checkpoint.id);
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
    const deadline = Date.now() + input.timeoutMs;
    while (true) {
      const semantic = await verifySemanticCheckpoint(0);
      if (semantic.triggerMatched && semantic.readinessSatisfied) {
        await input.waitForInspectable?.(input.checkpoints[0], semantic);
        await input.onCheckpoint?.(0);
        return;
      }
      await assertWatchedSessionsHealthy(input.checkpoints[0].id);
      if (Date.now() >= deadline) {
        await assertWatchedSessionsHealthy(input.checkpoints[0].id, {
          force: true
        });
        throw new Error(
          `checkpoint_readiness_timeout: ${input.checkpoints[0].id}`
        );
      }
      await wait(25);
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
    playbackState: async () => {
      await applyControl();
      return readTransportPlayback();
    },
    wait
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
        await wait(25);
      }
    },
    async waitUntilRunnable() {
      while (true) {
        await reconcileTarget();
        await activityClock.synchronize();
        if (!paused) return;
        await wait(50);
      }
    },
    async activityAdvanced(sequence) {
      activityEventSequence = sequence;
      await reconcileTarget();
    },
    async waitForAllCheckpoints() {
      while (currentCheckpoint < input.checkpoints.length - 1) {
        await reconcileTarget();
        await wait(25);
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
        await Promise.race([result.catch(() => undefined), wait(50)]);
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
        await wait(50);
      }
    }
  };
}
