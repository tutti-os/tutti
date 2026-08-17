import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  CAMEL_REPLAY_TRANSPORT_COMMANDS,
  createReplayProductPorts,
  encodeCamelTimingModeValue,
  normalizePlaybackStateDeriveTimingMode
} from "./product-ports.mjs";
import {
  replayStimuli,
  waitForPendingReplayInteraction,
  waitForSessionIdle
} from "./replay-stimuli.mjs";

const ports = createReplayProductPorts({
  workspaceScopeSegment: "rooms",
  transportCommands: CAMEL_REPLAY_TRANSPORT_COMMANDS,
  encodeTimingModeValue: encodeCamelTimingModeValue,
  normalizePlaybackState: normalizePlaybackStateDeriveTimingMode,
  failIdleWaitOnTerminalSession: true,
  listenerInfoPath: () => "unused"
});

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(value);
    }
  };
}

test("waitForSessionIdle aborts a hung HTTP request at its remaining deadline", async () => {
  let requestSignal;
  let requestAborted = false;
  const fetchImpl = async (_url, { signal }) => {
    requestSignal = signal;
    return new Promise((_, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          requestAborted = true;
          reject(signal.reason);
        },
        { once: true }
      );
    });
  };

  await assert.rejects(
    waitForSessionIdle(
      "http://replay",
      { authorization: "Bearer test" },
      "room-1",
      "session-1",
      40,
      undefined,
      { ports, fetchImpl, wait: async () => undefined }
    ),
    /timed out waiting for replay Session session-1 to become idle/
  );
  assert.equal(requestAborted, true);
  assert.equal(requestSignal?.aborted, true);
});

test("waitForSessionIdle preserves terminal session fast-fail", async () => {
  let fetchCount = 0;
  let waitCount = 0;
  const session = {
    status: "working",
    activeTurnId: "turn-1",
    turnLifecycle: { phase: "failed", outcome: "failed" }
  };
  await assert.rejects(
    waitForSessionIdle(
      "http://replay",
      {},
      "room-1",
      "session-1",
      5_000,
      undefined,
      {
        ports,
        fetchImpl: async () => {
          fetchCount += 1;
          return jsonResponse(session);
        },
        wait: async () => {
          waitCount += 1;
        }
      }
    ),
    /replay Session session-1 failed while waiting for idle: turnLifecycle outcome is failed/
  );
  assert.equal(fetchCount, 1);
  assert.equal(waitCount, 0);
});

test("waitForPendingReplayInteraction propagates caller cancellation", async () => {
  const controller = new AbortController();
  const cancellation = new Error("sibling cassette failed");
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  let requestSignal;
  const fetchImpl = async (_url, { signal }) => {
    requestSignal = signal;
    started();
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true
      });
    });
  };
  const pending = waitForPendingReplayInteraction(
    "http://replay",
    {},
    {
      workspaceId: "room-1",
      agentSessionId: "session-1",
      payload: { requestId: "request-1" }
    },
    5_000,
    undefined,
    { ports, fetchImpl, signal: controller.signal, wait: async () => undefined }
  );

  await startedPromise;
  controller.abort(cancellation);
  await assert.rejects(pending, (error) => error === cancellation);
  assert.equal(requestSignal?.aborted, true);
});

test("direct stimulus request is bounded by the stimulus deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-stimulus-timeout-"));
  const listenerInfoPath = join(root, "listener.json");
  await writeFile(
    listenerInfoPath,
    JSON.stringify({ addr: "127.0.0.1:1", auth: { token: "test" } })
  );
  let stimulusSignal;
  const playbackState = {
    paused: false,
    playbackElapsedMs: 0,
    speed: 1,
    fastForward: false,
    providerConnections: []
  };
  const fetchImpl = async (url, { signal }) => {
    if (url.endsWith("/transport/playback")) {
      return jsonResponse(playbackState);
    }
    stimulusSignal = signal;
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true
      });
    });
  };

  await assert.rejects(
    replayStimuli(
      root,
      {
        type: "recorded-session",
        workspaceId: "room-1",
        agentSessionId: "session-1",
        activityEvents: [
          {
            sequence: 1,
            occurredAtUnixMs: Date.now(),
            kind: "direct-stimulus",
            type: "session.settings.update",
            workspaceId: "room-1",
            agentSessionId: "session-1",
            payload: { settings: { model: "test" } }
          }
        ],
        turnIdentityPlan: {}
      },
      40,
      {
        cassetteId: "cassette-1",
        ports: { ...ports, listenerInfoPath: () => listenerInfoPath },
        checkpoints: [
          {
            id: "checkpoint-0000",
            index: 0,
            trigger: { source: "bootstrap" },
            cursor: { activityEventSequence: 0, providerConnections: [] }
          }
        ],
        fetchImpl,
        wait: delay
      }
    ),
    /stimulus session\.settings\.update did not become ready/
  );
  assert.equal(stimulusSignal?.aborted, true);
});
