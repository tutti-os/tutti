import { readFile } from "node:fs/promises";
import { setTimeout as defaultDelay } from "node:timers/promises";
import {
  createReplayPlaybackController,
  ReplayReplacementRequested
} from "./playback-controller.mjs";
import {
  replayEventMayStartTurn,
  replayPendingInteraction,
  replaySessionTerminalFailure,
  replaySessionWatchRefs,
  replayStimulusRetryableStatus,
  replayTransportFailure,
  requiredReplayCassetteId,
  submitRequestedRequiresSessionIdle
} from "./playback-helpers.mjs";
import {
  createReplayProductPorts,
  normalizeIdleSession,
  replayAgentSessionUrl
} from "./product-ports.mjs";
import {
  assertNoDuplicateEngineSends,
  replayStimulusPrecondition,
  replayStimulusRequest
} from "./stimulus.mjs";
import { createReplayTurnIdentityTracker } from "./turn-identity-tracker.mjs";

export { ReplayReplacementRequested };

/**
 * Drive recorded activity events against a live playback controller.
 *
 * @param {string} stateDirectory
 * @param {object} action
 * @param {number} timeoutMs
 * @param {object} [input]
 * @param {import("./product-ports.mjs").ReplayProductPorts} input.ports
 */
export async function replayStimuli(
  stateDirectory,
  action,
  timeoutMs,
  input = {}
) {
  const ports = createReplayProductPorts(input.ports);
  const wait = input.wait ?? defaultDelay;
  const log =
    ports.log ??
    input.log ??
    ((message) => {
      process.stderr.write(`[agent-session-replay] ${message}\n`);
    });
  if (!Array.isArray(input.checkpoints) || input.checkpoints.length === 0) {
    throw new Error("replay checkpoints are required");
  }
  if (typeof ports.listenerInfoPath !== "function") {
    throw new Error("ReplayProductPorts.listenerInfoPath is required");
  }
  const cassetteId = requiredReplayCassetteId(input.cassetteId);
  const listener = JSON.parse(
    await readFile(await ports.listenerInfoPath(stateDirectory), "utf8")
  );
  const baseURL = `http://${listener.addr}`;
  const headers = {
    authorization: `Bearer ${listener.auth.token}`,
    "content-type": "application/json"
  };
  const sessionWatch = ports.watchSessionsDuringPlayback
    ? Array.isArray(input.sessionWatch) && input.sessionWatch.length > 0
      ? input.sessionWatch
      : replaySessionWatchRefs(action.activityEvents, {
          workspaceId: input.workspaceId,
          rootAgentSessionId: input.rootAgentSessionId
        })
    : undefined;
  const playback = createReplayPlaybackController({
    baseURL,
    checkpoints: input.checkpoints,
    controlPath: input.controlPath,
    headers,
    onCheckpoint: input.onCheckpoint,
    onReplacement: input.onReplacement,
    cassetteId,
    ports,
    sessionWatch,
    statusPath: input.statusPath,
    targetCheckpoint: input.initialTargetCheckpoint,
    verifyBootstrap: action.type === "continue-session",
    waitForInspectable: input.waitForInspectable,
    timeoutMs,
    wait
  });
  const turnIdentities = createReplayTurnIdentityTracker(
    action.turnIdentityPlan ?? {},
    {
      baseURL,
      headers,
      timeoutMs,
      ports,
      wait,
      readRendererActivitySnapshot:
        input.rendererDriver?.readRendererActivitySnapshot
    }
  );
  await playback.initialize();
  assertNoDuplicateEngineSends(action.activityEvents);
  const totalActivityEvents = action.activityEvents.length;
  for (const event of action.activityEvents) {
    log(
      `activity ${event.sequence}/${totalActivityEvents}: ` +
        `${event.kind} ${event.type}`
    );
    await playback.waitUntilRunnable();
    await playback.waitBeforeActivity(event.sequence);
    await playback.waitForRecordedEvent(event.occurredAtUnixMs);
    if (submitRequestedRequiresSessionIdle(event, action.activityEvents)) {
      await waitForSessionIdle(
        baseURL,
        headers,
        event.workspaceId,
        event.agentSessionId,
        timeoutMs,
        playback,
        { ports, wait }
      );
    }
    if (event.kind === "intent" && event.type === "plan/feedbackRequested") {
      await waitForSessionIdle(
        baseURL,
        headers,
        event.workspaceId,
        event.agentSessionId,
        timeoutMs,
        playback,
        { ports, wait }
      );
    }
    if (ports.captureActivityBaselinesInStimuli) {
      await turnIdentities.captureActivityBaseline(
        event.workspaceId,
        event.agentSessionId
      );
    }
    switch (event.kind) {
      case "intent": {
        if (!input.rendererDriver?.dispatchIntent) {
          throw new Error(
            `renderer activity driver is required for intent ${event.type}`
          );
        }
        const runIntent = async () => {
          const replayIntent =
            ports.rebasePendingInteractionForResponseRequested &&
            event.type === "interaction/responseRequested"
              ? await playback.runWhilePolling(() =>
                  turnIdentities.rebasePendingInteraction(event)
                )
              : await turnIdentities.rebase(event);
          await playback.runWhilePolling(() =>
            input.rendererDriver.waitUntilIntentReady?.(replayIntent)
          );
          await playback.runWhilePolling(() =>
            input.rendererDriver.dispatchIntent(replayIntent)
          );
        };
        if (
          event.type !== "activation/requested" &&
          typeof input.runRendererIntent === "function"
        ) {
          await input.runRendererIntent(event, runIntent);
        } else {
          await runIntent();
        }
        break;
      }
      case "effect": {
        if (!input.rendererDriver?.verifyEffect) {
          throw new Error(
            `renderer activity driver is required for effect ${event.type}`
          );
        }
        const replayEffect = await turnIdentities.rebase(event);
        await playback.runWhilePolling(() =>
          input.rendererDriver.verifyEffect(replayEffect)
        );
        break;
      }
      case "direct-stimulus":
        await playback.runWhilePolling(() =>
          replayDirectStimulus({
            baseURL,
            event,
            headers,
            playback,
            cassetteId,
            ports,
            turnIdentities,
            timeoutMs,
            wait
          })
        );
        await input.onStimulusAccepted?.(event);
        break;
      default:
        throw new Error(`unsupported replay activity kind: ${event.kind}`);
    }
    if (replayEventMayStartTurn(event)) {
      await turnIdentities.observeCurrentTurn(
        event.workspaceId,
        event.agentSessionId
      );
    }
    await input.onActivityEventCompleted?.(event);
    if (event.kind === "effect" && event.type === "session/activate") {
      await input.onStimulusAccepted?.(event);
    }
    await playback.activityAdvanced(event.sequence);
    const checkpoint = playback.checkpointAfter(event.sequence);
    if (checkpoint) {
      await playback.reach(checkpoint);
    }
  }
  await waitForSessionIdle(
    baseURL,
    headers,
    action.workspaceId,
    action.agentSessionId,
    timeoutMs,
    playback,
    { ports, wait }
  );
  await playback.waitForAllCheckpoints();
  await playback.waitUntilRunnable();
  return playback;
}

async function replayDirectStimulus({
  baseURL,
  event,
  headers,
  playback,
  cassetteId,
  ports,
  turnIdentities,
  timeoutMs,
  wait
}) {
  if (replayStimulusPrecondition(event) === "session-idle") {
    await waitForSessionIdle(
      baseURL,
      headers,
      event.workspaceId,
      event.agentSessionId,
      timeoutMs,
      playback,
      { ports, wait }
    );
  }
  const replayEvent = await turnIdentities.rebase(event);
  let readyEvent = replayEvent;
  if (event.type === "interactive.response") {
    readyEvent = await waitForPendingReplayInteraction(
      baseURL,
      headers,
      replayEvent,
      timeoutMs,
      playback,
      { ports, wait }
    );
  }
  const request = replayStimulusRequest(readyEvent, {
    workspaceScopeSegment: ports.workspaceScopeSegment
  });
  if (!request) {
    throw new Error(`unsupported direct replay stimulus: ${event.type}`);
  }
  const deadline = Date.now() + timeoutMs;
  let response;
  let body = "";
  while (Date.now() < deadline) {
    response = await fetch(`${baseURL}${request.path}`, {
      method: "POST",
      headers,
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) })
    });
    body = await response.text();
    if (response.ok) break;
    if (!replayStimulusRetryableStatus(event.type, response.status)) {
      const transportFailure =
        response.status === 502
          ? await replayTransportFailure(
              baseURL,
              headers,
              cassetteId,
              timeoutMs
            )
          : "";
      throw new Error(
        `stimulus ${event.type} failed with ${response.status}: ${body}${transportFailure ? `\n${transportFailure}` : ""}\nrequest: ${JSON.stringify(request.body)}`
      );
    }
    await wait(100);
  }
  if (!response?.ok) {
    throw new Error(
      `stimulus ${event.type} did not become ready: ${response?.status} ${body}`
    );
  }
}

/**
 * @param {string} baseURL
 * @param {object} headers
 * @param {string} workspaceId
 * @param {string} agentSessionId
 * @param {number} timeoutMs
 * @param {object} [playback]
 * @param {{ ports: import("./product-ports.mjs").ReplayProductPorts, wait?: Function }} options
 */
export async function waitForSessionIdle(
  baseURL,
  headers,
  workspaceId,
  agentSessionId,
  timeoutMs,
  playback,
  options
) {
  const ports = createReplayProductPorts(options.ports);
  const wait = options.wait ?? defaultDelay;
  let remainingMs = timeoutMs;
  let latest = null;
  while (remainingMs > 0) {
    await playback?.waitUntilRunnable();
    const pollStartedAt = Date.now();
    const response = await fetch(
      `${baseURL}${replayAgentSessionUrl(ports, workspaceId, agentSessionId)}`,
      { headers }
    );
    if (response.ok) {
      latest = await response.json();
      const session = normalizeIdleSession(ports, latest);
      if (ports.failIdleWaitOnTerminalSession) {
        const terminalFailure = replaySessionTerminalFailure(session);
        if (terminalFailure) {
          throw new Error(
            `replay Session ${agentSessionId} failed while waiting for idle: ${terminalFailure}; ${JSON.stringify(latest)}`
          );
        }
      }
      if (
        !session.activeTurnId &&
        !["working", "waiting"].includes(session.status)
      ) {
        return session;
      }
    }
    await wait(100);
    remainingMs -= Date.now() - pollStartedAt;
  }
  throw new Error(
    `timed out waiting for replay Session ${agentSessionId} to become idle: ${JSON.stringify(latest)}`
  );
}

/**
 * @param {string} baseURL
 * @param {object} headers
 * @param {object} event
 * @param {number} timeoutMs
 * @param {object} [playback]
 * @param {{ ports: import("./product-ports.mjs").ReplayProductPorts, wait?: Function }} options
 */
export async function waitForPendingReplayInteraction(
  baseURL,
  headers,
  event,
  timeoutMs,
  playback,
  options
) {
  const ports = createReplayProductPorts(options.ports);
  const wait = options.wait ?? defaultDelay;
  let remainingMs = timeoutMs;
  let latest = null;
  while (remainingMs > 0) {
    await playback?.waitUntilRunnable();
    const pollStartedAt = Date.now();
    const response = await fetch(
      `${baseURL}${replayAgentSessionUrl(
        ports,
        event.workspaceId,
        event.agentSessionId
      )}`,
      { headers }
    );
    if (response.ok) {
      latest = await response.json();
      const session = normalizeIdleSession(ports, latest);
      const interaction = replayPendingInteraction(
        session,
        event.payload.requestId
      );
      if (interaction) {
        return {
          ...event,
          payload: {
            ...event.payload,
            turnId: interaction.turnId
          }
        };
      }
    }
    await wait(100);
    remainingMs -= Date.now() - pollStartedAt;
  }
  throw new Error(
    `timed out waiting for replay Interaction ${event.payload.requestId}: ${JSON.stringify(latest)}`
  );
}
