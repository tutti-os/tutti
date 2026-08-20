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
import {
  ReplayDeadlineExceeded,
  createReplayDeadline,
  fetchWithReplayDeadline,
  readReplayResponseJson,
  readReplayResponseText,
  runWithReplayDeadline,
  waitWithReplayDeadline
} from "./replay-http.mjs";

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
  const fetchImpl = input.fetchImpl ?? fetch;
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
    activityClockOriginUnixMs: input.activityClockOriginUnixMs,
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
    wait,
    fetchImpl,
    signal: input.signal
  });
  const turnIdentities = createReplayTurnIdentityTracker(
    action.turnIdentityPlan ?? {},
    {
      baseURL,
      headers,
      timeoutMs,
      ports,
      wait,
      fetchImpl,
      signal: input.signal,
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
        { ports, wait, fetchImpl, signal: input.signal }
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
        { ports, wait, fetchImpl, signal: input.signal }
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
            wait,
            fetchImpl,
            signal: input.signal
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
    { ports, wait, fetchImpl, signal: input.signal }
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
  wait,
  fetchImpl,
  signal
}) {
  const deadline = createReplayDeadline(timeoutMs, {
    signal,
    label: `replay stimulus ${event.type}`
  });
  if (replayStimulusPrecondition(event) === "session-idle") {
    await waitForSessionIdle(
      baseURL,
      headers,
      event.workspaceId,
      event.agentSessionId,
      timeoutMs,
      playback,
      { ports, wait, fetchImpl, signal, deadline }
    );
  }
  const replayEvent = await turnIdentities.rebase(event, deadline);
  let readyEvent = replayEvent;
  if (event.type === "interactive.response") {
    readyEvent = await waitForPendingReplayInteraction(
      baseURL,
      headers,
      replayEvent,
      timeoutMs,
      playback,
      { ports, wait, fetchImpl, signal, deadline }
    );
  }
  const request = replayStimulusRequest(readyEvent, {
    workspaceScopeSegment: ports.workspaceScopeSegment
  });
  if (!request) {
    throw new Error(`unsupported direct replay stimulus: ${event.type}`);
  }
  let response;
  let body = "";
  let timeoutCause;
  try {
    while (deadline.remainingMs() > 0) {
      response = await fetchWithReplayDeadline(
        fetchImpl,
        `${baseURL}${request.path}`,
        {
          method: "POST",
          headers,
          ...(request.body === undefined
            ? {}
            : { body: JSON.stringify(request.body) })
        },
        deadline
      );
      body = await readReplayResponseText(response, deadline);
      if (response.ok) break;
      if (!replayStimulusRetryableStatus(event.type, response.status)) {
        const remainingMs = deadline.remainingMs();
        const transportFailure =
          response.status === 502 && remainingMs > 0
            ? await replayTransportFailure(
                baseURL,
                headers,
                cassetteId,
                remainingMs,
                { fetchImpl, signal }
              )
            : "";
        throw new Error(
          `stimulus ${event.type} failed with ${response.status}: ${body}${transportFailure ? `\n${transportFailure}` : ""}\nrequest: ${JSON.stringify(request.body)}`
        );
      }
      await waitWithReplayDeadline(wait, 100, deadline);
    }
  } catch (error) {
    if (!(error instanceof ReplayDeadlineExceeded)) throw error;
    timeoutCause = error;
  }
  if (!response?.ok) {
    throw new Error(
      `stimulus ${event.type} did not become ready: ${response?.status ?? "timeout"} ${body}`,
      timeoutCause ? { cause: timeoutCause } : undefined
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
  options = {}
) {
  const ports = createReplayProductPorts(options.ports);
  const wait = options.wait ?? defaultDelay;
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline =
    options.deadline ??
    createReplayDeadline(timeoutMs, {
      signal: options.signal,
      label: `waiting for replay Session ${agentSessionId} to become idle`
    });
  let latest = null;
  let timeoutCause;
  try {
    while (deadline.remainingMs() > 0) {
      await runWithReplayDeadline(
        () => playback?.waitUntilRunnable(),
        deadline
      );
      const response = await fetchWithReplayDeadline(
        fetchImpl,
        `${baseURL}${replayAgentSessionUrl(ports, workspaceId, agentSessionId)}`,
        { headers },
        deadline
      );
      if (response.ok) {
        latest = await readReplayResponseJson(response, deadline);
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
      await waitWithReplayDeadline(wait, 100, deadline);
    }
  } catch (error) {
    if (!(error instanceof ReplayDeadlineExceeded)) throw error;
    timeoutCause = error;
  }
  throw new Error(
    `timed out waiting for replay Session ${agentSessionId} to become idle: ${JSON.stringify(latest)}`,
    timeoutCause ? { cause: timeoutCause } : undefined
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
  options = {}
) {
  const ports = createReplayProductPorts(options.ports);
  const wait = options.wait ?? defaultDelay;
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline =
    options.deadline ??
    createReplayDeadline(timeoutMs, {
      signal: options.signal,
      label: `waiting for replay Interaction ${event.payload.requestId}`
    });
  let latest = null;
  let timeoutCause;
  try {
    while (deadline.remainingMs() > 0) {
      await runWithReplayDeadline(
        () => playback?.waitUntilRunnable(),
        deadline
      );
      const response = await fetchWithReplayDeadline(
        fetchImpl,
        `${baseURL}${replayAgentSessionUrl(
          ports,
          event.workspaceId,
          event.agentSessionId
        )}`,
        { headers },
        deadline
      );
      if (response.ok) {
        latest = await readReplayResponseJson(response, deadline);
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
      await waitWithReplayDeadline(wait, 100, deadline);
    }
  } catch (error) {
    if (!(error instanceof ReplayDeadlineExceeded)) throw error;
    timeoutCause = error;
  }
  throw new Error(
    `timed out waiting for replay Interaction ${event.payload.requestId}: ${JSON.stringify(latest)}`,
    timeoutCause ? { cause: timeoutCause } : undefined
  );
}
