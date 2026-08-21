import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAgentSessionReplayControlWriter } from "../../apps/desktop/src/main/agentSessionReplayStatus.ts";
import {
  cassettePolicy,
  materializeReplayWorkspaceBlobs,
  parseActivityEvents,
  replayActionFromManifest,
  verifyCassette
} from "./agent-session-replay-runner/cassette.mjs";
import {
  enableAgentSessionRecordingFeature,
  replayListenerInfoPath,
  replayWorkbenchSnapshot
} from "./agent-session-replay-runner/runtime.mjs";
import {
  resolveAgentSessionReplayProjectRoot,
  resolveRecordScenarioProject,
  seedRecordingUserProject,
  verifyRecordedProjectBindingArtifacts
} from "./agent-session-replay-runner/recording.mjs";
import {
  activateRendererReplayWorkspaceCassette,
  assertNoDuplicateEngineSends,
  bootstrapRendererReplayWorkspace,
  bootstrapReplayWorkspace,
  bindManagedReplayShutdown,
  createRendererActivityDriver,
  createReplayActivityClock,
  createReplayPlaybackController,
  createReplayWorkspaceSurfaceReadyQueue,
  createSerialAsyncQueue,
  maybeSettleForScreenshot,
  validateReplayCheckpointPlan,
  assertReplayWorkspaceSucceeded,
  checkpointNeedsToolSettle,
  checkpointNeedsScreenshotSettle,
  checkpointAllowsOptionalScreenshotSettle,
  captureCheckpointScreenshot,
  captureScreenshot,
  hasOpenToolDetailText,
  normalizeScreenshotClip,
  parseArgs,
  resolveDesktopHeadless,
  resolveAgentSessionScreenshotClip,
  replayCheckpointScreenshotPath,
  replayControlRouter,
  replayPendingInteraction,
  resolveReplayProjectFromExpectedState,
  replayObservedTurnId,
  replayStimuli,
  replayStimulusPrecondition,
  replayStimulusRetryableStatus,
  replayStimulusRequest,
  replayTurnIdentityPlan,
  replayWorkspaceTransportRegistrations,
  readReplayTotalDurationMs,
  replayWorkspaceActivityClockOrigin,
  replayWorkspaceInitialTargetCheckpoint,
  managedReplayFailure,
  loadRecordScenario,
  screenshotEvidenceLabel,
  submitRequestedRequiresSessionIdle,
  validateAction,
  validateReplayWorkspaceManifest,
  verifyReplayWorkspaceTransports,
  replayTransportHardFailureMessage
} from "./run-agent-session-replay.mjs";

const replayCassetteAID = "277377ed-af34-454f-a8b9-1047b4064e74";
const replayCassetteBID = "628c61c4-cbcb-4445-83f7-718bbbd414bd";
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("open tool detail accepts short rendered fileChange content", () => {
  assert.equal(hasOpenToolDetailText(["R15_TEST"]), true);
});

test("open tool detail rejects missing or empty content", () => {
  assert.equal(hasOpenToolDetailText([]), false);
  assert.equal(hasOpenToolDetailText([null, undefined, " \n\t "]), false);
});

function respondToCheckpointVerification(request, response) {
  const match = request.url?.match(
    /\/checkpoints\/(?<checkpointIndex>\d+)\/verify$/u
  );
  if (request.method !== "POST" || !match?.groups) return false;
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      canonicalMessageVersion: 1,
      canonicalSessionUpdatedAtUnixMs: 1,
      checkpointIndex: Number(match.groups.checkpointIndex),
      readinessSatisfied: true,
      triggerMatched: true
    })
  );
  return true;
}

test("managed Replay failure preserves a structured startup cause", () => {
  assert.deepEqual(
    managedReplayFailure(
      replayCassetteAID,
      new Error("tuttid exited before publishing listener info", {
        cause: {
          code: "managed_process_stderr",
          message: "unsupported process cassette schema version 2"
        }
      })
    ),
    {
      cassetteId: replayCassetteAID,
      cause: {
        code: "managed_process_stderr",
        message: "unsupported process cassette schema version 2"
      },
      error: "tuttid exited before publishing listener info"
    }
  );
});

test("Replay Turn identity plan excludes restored historical Turns", () => {
  const session = (turnIds) => ({
    id: "session-1",
    turns: turnIds.map((id) => ({ id }))
  });

  assert.deepEqual(
    replayTurnIdentityPlan(
      { agent: { sessions: [session(["turn-old", "turn-new"])] } },
      { agent: { sessions: [session(["turn-old"])] } }
    ),
    {
      "session-1": {
        initialTurnIds: ["turn-old"],
        recordedTurnIds: ["turn-new"]
      }
    }
  );
});

test("Replay Turn identity plan keeps child Session lineage", () => {
  assert.deepEqual(
    replayTurnIdentityPlan({
      agent: {
        sessions: [
          {
            id: "root-recorded",
            kind: "root",
            turns: [{ id: "root-turn-recorded" }]
          },
          {
            id: "child-recorded",
            kind: "child",
            rootSessionId: "root-recorded",
            rootTurnId: "root-turn-recorded",
            parentSessionId: "root-recorded",
            parentTurnId: "root-turn-recorded",
            parentToolCallId: "call-stable",
            turns: [{ id: "child-turn-recorded" }]
          }
        ]
      }
    }),
    {
      "root-recorded": {
        initialTurnIds: [],
        recordedTurnIds: ["root-turn-recorded"]
      },
      "child-recorded": {
        initialTurnIds: [],
        recordedTurnIds: ["child-turn-recorded"],
        kind: "child",
        initialSession: false,
        rootSessionId: "root-recorded",
        rootTurnId: "root-turn-recorded",
        parentSessionId: "root-recorded",
        parentTurnId: "root-turn-recorded",
        parentToolCallId: "call-stable"
      }
    }
  );
});

test("managed Replay stops its Desktop when the owner process exits", async () => {
  const runtime = new EventEmitter();
  runtime.stdout = new EventEmitter();
  runtime.stderr = new EventEmitter();
  let checkParent = null;
  let stopCount = 0;
  const dispose = bindManagedReplayShutdown(
    {},
    {
      clearInterval() {},
      isProcessAlive: () => false,
      parentPid: "123",
      processRuntime: runtime,
      setInterval(check) {
        checkParent = check;
        return { unref() {} };
      },
      async stopDesktop() {
        stopCount += 1;
      }
    }
  );

  checkParent();
  runtime.stdout.emit(
    "error",
    Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
  );
  await Promise.resolve();

  assert.equal(stopCount, 1);
  dispose();
  assert.equal(runtime.listenerCount("SIGINT"), 0);
  assert.equal(runtime.stdout.listenerCount("error"), 0);
});

test("Replay Workspace confirms final Surface readiness serially", async () => {
  const events = [];
  let releaseFirst;
  const firstReady = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const reportReady = createReplayWorkspaceSurfaceReadyQueue(
    async (cassette) => {
      events.push(`start:${cassette.cassetteId}`);
      if (cassette.cassetteId === "cassette-1") {
        await firstReady;
      }
      events.push(`ready:${cassette.cassetteId}`);
    }
  );

  const first = reportReady({ cassetteId: "cassette-1" });
  const second = reportReady({ cassetteId: "cassette-2" });
  await Promise.resolve();

  assert.deepEqual(events, ["start:cassette-1"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "start:cassette-1",
    "ready:cassette-1",
    "start:cassette-2",
    "ready:cassette-2"
  ]);
});

test("Replay Workspace continues Surface readiness after one failure", async () => {
  const events = [];
  const reportReady = createReplayWorkspaceSurfaceReadyQueue(
    async (cassette) => {
      events.push(cassette.cassetteId);
      if (cassette.cassetteId === "cassette-1") {
        throw new Error("first Surface failed");
      }
    }
  );

  const first = reportReady({ cassetteId: "cassette-1" });
  const second = reportReady({ cassetteId: "cassette-2" });

  await assert.rejects(first, /first Surface failed/u);
  await second;
  assert.deepEqual(events, ["cassette-1", "cassette-2"]);
});

test("createSerialAsyncQueue runs Desktop UI tasks one at a time", async () => {
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const enqueue = createSerialAsyncQueue();
  const first = enqueue(async () => {
    events.push("start:a");
    await firstGate;
    events.push("end:a");
  });
  const second = enqueue(async () => {
    events.push("start:b");
    events.push("end:b");
  });
  await Promise.resolve();
  assert.deepEqual(events, ["start:a"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b"]);
});

test("maybeSettleForScreenshot pins and clears settle agent session id", async () => {
  const expressions = [];
  const client = {
    async send(method, params) {
      assert.equal(method, "Runtime.evaluate");
      expressions.push(params.expression);
      return { result: { value: true } };
    }
  };
  let settleSawPin = false;
  await maybeSettleForScreenshot(
    {
      async settleForScreenshot() {
        settleSawPin = expressions.some((expression) =>
          expression.includes("__tuttiSettleAgentSessionId = ")
        );
      }
    },
    client,
    1_000,
    { kind: "tool.completed", tags: ["tool.completed"] },
    "session-r03"
  );
  assert.equal(settleSawPin, true);
  assert.ok(
    expressions.some((expression) =>
      expression.includes('__tuttiSettleAgentSessionId = "session-r03"')
    )
  );
  assert.ok(
    expressions.some((expression) =>
      expression.includes("delete globalThis.__tuttiSettleAgentSessionId")
    )
  );
});

test("working checkpoint settle is scenario opt-in", async () => {
  const client = {
    async send() {
      return { result: { value: true } };
    }
  };
  let settles = 0;
  const scenario = {
    async settleForScreenshot() {
      settles += 1;
    }
  };
  const checkpoint = { kind: "turn.working", tags: ["turn.working"] };

  await maybeSettleForScreenshot(scenario, client, 1_000, checkpoint);
  scenario.settleForWorkingScreenshot = true;
  await maybeSettleForScreenshot(scenario, client, 1_000, checkpoint);

  assert.equal(settles, 1);
});

test("replayObservedTurnId prefers Protocol v2 turnId after settle", () => {
  assert.equal(
    replayObservedTurnId({
      activeTurnId: null,
      latestTurn: { turnId: "turn-settled" }
    }),
    "turn-settled"
  );
  assert.equal(
    replayObservedTurnId({
      activeTurnId: "turn-active",
      latestTurn: { turnId: "turn-other" }
    }),
    "turn-active"
  );
  assert.equal(
    replayObservedTurnId({
      activeTurnId: null,
      latestTurn: { id: "turn-legacy" }
    }),
    "turn-legacy"
  );
  assert.equal(
    replayObservedTurnId({
      activeTurnId: null,
      latestTurn: {}
    }),
    null
  );
});

test("replay rebases cancel Turn id from settled latestTurn.turnId", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-cancel-turnid-"));
  const listenerDirectory = join(root, "run");
  await mkdir(listenerDirectory, { recursive: true });
  const verified = [];
  const playbackStartedAt = Date.now();
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (respondToCheckpointVerification(request, response)) return;
    if (
      request.method === "GET" &&
      request.url ===
        `/v1/agent-session-replay/cassettes/${replayCassetteAID}/transport/playback`
    ) {
      response.end(
        JSON.stringify({
          drained: false,
          paused: false,
          playbackElapsedMs: Date.now() - playbackStartedAt,
          providerConnections: [],
          speed: 1,
          timingMode: "realtime"
        })
      );
      return;
    }
    // Settled after early cancel: activeTurnId cleared; Protocol v2 uses turnId.
    response.end(
      JSON.stringify({
        session: {
          activeTurnId: null,
          latestTurn: { turnId: "turn-live-canceled" },
          status: "idle"
        }
      })
    );
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen)
  );
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    await writeFile(
      join(listenerDirectory, "tuttid.listener.json"),
      JSON.stringify({
        addr: `127.0.0.1:${address.port}`,
        auth: { token: "test-token" }
      })
    );
    const base = {
      agentSessionId: "session-1",
      workspaceId: "workspace-1"
    };
    await replayStimuli(
      root,
      {
        ...base,
        activityEvents: [
          {
            ...base,
            kind: "effect",
            occurredAtUnixMs: 1,
            payload: { outcome: "succeeded" },
            sequence: 1,
            type: "session/activate"
          },
          {
            ...base,
            kind: "effect",
            occurredAtUnixMs: 2,
            payload: {
              outcome: "succeeded",
              turnId: "turn-recorded-canceled"
            },
            sequence: 2,
            type: "turn/cancel"
          }
        ],
        turnIdentityPlan: {
          "session-1": {
            initialTurnIds: [],
            recordedTurnIds: ["turn-recorded-canceled"]
          }
        }
      },
      2_000,
      {
        cassetteId: replayCassetteAID,
        rendererDriver: {
          async dispatchIntent() {},
          async verifyEffect(event) {
            verified.push(event);
          }
        },
        checkpoints: [
          {
            index: 0,
            kind: "bootstrap",
            trigger: { source: "bootstrap" },
            cursor: { activityEventSequence: 0, providerConnections: [] },
            schemaVersion: cassettePolicy.schemaVersion
          }
        ]
      }
    );
    assert.equal(verified.length, 2);
    assert.equal(verified[1].type, "turn/cancel");
    assert.equal(verified[1].payload.turnId, "turn-live-canceled");
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
  }
});

test("replay rebases recorded Turn identities before Engine intents", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-turn-identity-"));
  const listenerDirectory = join(root, "run");
  await mkdir(listenerDirectory, { recursive: true });
  const requests = [];
  const dispatched = [];
  let activeTurnId = null;
  const playbackStartedAt = Date.now();
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (respondToCheckpointVerification(request, response)) return;
    if (
      request.method === "GET" &&
      request.url ===
        `/v1/agent-session-replay/cassettes/${replayCassetteAID}/transport/playback`
    ) {
      response.end(
        JSON.stringify({
          drained: false,
          paused: false,
          playbackElapsedMs: Date.now() - playbackStartedAt,
          providerConnections: [],
          speed: 1,
          timingMode: "realtime"
        })
      );
      return;
    }
    if (
      request.method === "POST" &&
      request.url ===
        "/v1/workspaces/workspace-1/agent-sessions/session-1/input"
    ) {
      activeTurnId = "turn-replay";
      response.statusCode = 201;
      response.end("{}");
      return;
    }
    response.end(
      JSON.stringify({
        session: {
          activeTurnId,
          latestTurn: { id: "turn-replay" },
          status: activeTurnId ? "working" : "idle"
        }
      })
    );
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen)
  );
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    await writeFile(
      join(listenerDirectory, "tuttid.listener.json"),
      JSON.stringify({
        addr: `127.0.0.1:${address.port}`,
        auth: { token: "test-token" }
      })
    );
    const base = {
      agentSessionId: "session-1",
      workspaceId: "workspace-1"
    };
    await replayStimuli(
      root,
      {
        ...base,
        activityEvents: [
          {
            ...base,
            kind: "direct-stimulus",
            occurredAtUnixMs: 1,
            payload: { content: [{ type: "text", text: "start" }] },
            sequence: 1,
            type: "session.send"
          },
          {
            ...base,
            kind: "intent",
            occurredAtUnixMs: 2,
            payload: {
              action: "implement",
              commandId: "plan-command",
              idempotencyKey:
                "plan-implementation:workspace-recorded:session-1:turn-recorded",
              promptKind: "plan-implementation",
              requestId: "turn-recorded",
              turnId: "turn-recorded"
            },
            sequence: 2,
            type: "plan/decisionRequested"
          }
        ],
        turnIdentityPlan: {
          "session-1": {
            initialTurnIds: [],
            recordedTurnIds: ["turn-recorded"]
          }
        }
      },
      2_000,
      {
        cassetteId: replayCassetteAID,
        rendererDriver: {
          dispatchIntent(event) {
            dispatched.push(event);
            activeTurnId = null;
          },
          async verifyEffect() {}
        },
        checkpoints: [
          {
            index: 0,
            kind: "bootstrap",
            trigger: { source: "bootstrap" },
            cursor: { activityEventSequence: 0, providerConnections: [] },
            schemaVersion: cassettePolicy.schemaVersion
          },
          {
            index: 1,
            kind: "after-activity-event",
            trigger: {
              source: "activity-boundary",
              afterActivityEventSequence: 2
            },
            cursor: { activityEventSequence: 2, providerConnections: [] },
            schemaVersion: cassettePolicy.schemaVersion
          }
        ]
      }
    );
    assert.equal(dispatched[0].payload.turnId, "turn-replay");
    assert.equal(dispatched[0].payload.requestId, "turn-replay");
    assert.equal(
      requests.some((request) => request.includes("turn-recorded")),
      false
    );
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
  }
});

test("replay rebases child Session and Turn identities from lineage", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-child-identity-"));
  const listenerDirectory = join(root, "run");
  await mkdir(listenerDirectory, { recursive: true });
  const dispatched = [];
  const verified = [];
  let rootActiveTurnId = "root-turn-live";
  const playbackStartedAt = Date.now();
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (respondToCheckpointVerification(request, response)) return;
    if (
      request.method === "GET" &&
      request.url ===
        `/v1/agent-session-replay/cassettes/${replayCassetteAID}/transport/playback`
    ) {
      response.end(
        JSON.stringify({
          drained: false,
          paused: false,
          playbackElapsedMs: Date.now() - playbackStartedAt,
          providerConnections: [],
          speed: 1,
          timingMode: "realtime"
        })
      );
      return;
    }
    if (
      request.method === "GET" &&
      request.url ===
        "/v1/workspaces/workspace-1/agent-sessions/root-recorded?projection=messageHydration"
    ) {
      response.end(
        JSON.stringify({
          session: {
            id: "root-recorded",
            kind: "root",
            activeTurnId: rootActiveTurnId,
            latestTurn: { id: "root-turn-live" }
          },
          childSessions: [
            {
              id: "child-live",
              kind: "child",
              rootAgentSessionId: "root-recorded",
              rootTurnId: "root-turn-live",
              parentAgentSessionId: "root-recorded",
              parentTurnId: "root-turn-live",
              parentToolCallId: "call-stable",
              activeTurnId: "child-turn-live",
              latestTurn: { id: "child-turn-live" }
            }
          ]
        })
      );
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/v1/workspaces/workspace-1/agent-sessions/root-recorded"
    ) {
      response.end(
        JSON.stringify({
          session: {
            activeTurnId: rootActiveTurnId,
            latestTurn: { id: "root-turn-live" },
            status: rootActiveTurnId ? "working" : "idle"
          }
        })
      );
      return;
    }
    response.end("{}");
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen)
  );
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    await writeFile(
      join(listenerDirectory, "tuttid.listener.json"),
      JSON.stringify({
        addr: `127.0.0.1:${address.port}`,
        auth: { token: "test-token" }
      })
    );
    const rootEvent = {
      agentSessionId: "root-recorded",
      workspaceId: "workspace-1"
    };
    const childEvent = {
      agentSessionId: "child-recorded",
      workspaceId: "workspace-1"
    };
    await replayStimuli(
      root,
      {
        ...rootEvent,
        activityEvents: [
          {
            ...rootEvent,
            kind: "effect",
            occurredAtUnixMs: 1,
            payload: {},
            sequence: 1,
            type: "session/activate"
          },
          {
            ...childEvent,
            kind: "intent",
            occurredAtUnixMs: 2,
            payload: {
              requestId: "request-1",
              turnId: "child-turn-recorded"
            },
            sequence: 2,
            type: "interaction/responseRequested"
          },
          {
            ...childEvent,
            correlationId: "recorded-correlation",
            kind: "effect",
            occurredAtUnixMs: 3,
            payload: {
              requestId: "request-1",
              turnId: "child-turn-recorded"
            },
            sequence: 3,
            type: "interaction/respond"
          }
        ],
        turnIdentityPlan: {
          "root-recorded": {
            initialTurnIds: [],
            recordedTurnIds: ["root-turn-recorded"]
          },
          "child-recorded": {
            initialTurnIds: [],
            recordedTurnIds: ["child-turn-recorded"],
            kind: "child",
            initialSession: false,
            rootSessionId: "root-recorded",
            rootTurnId: "root-turn-recorded",
            parentSessionId: "root-recorded",
            parentTurnId: "root-turn-recorded",
            parentToolCallId: "call-stable"
          }
        }
      },
      2_000,
      {
        cassetteId: replayCassetteAID,
        rendererDriver: {
          async dispatchIntent(event) {
            dispatched.push(event);
          },
          async verifyEffect(event) {
            verified.push(event);
            if (event.type === "interaction/respond") {
              rootActiveTurnId = null;
            }
          }
        },
        checkpoints: [
          {
            index: 0,
            kind: "bootstrap",
            trigger: { source: "bootstrap" },
            cursor: { activityEventSequence: 0, providerConnections: [] },
            schemaVersion: cassettePolicy.schemaVersion
          },
          {
            index: 1,
            kind: "after-activity-event",
            trigger: {
              source: "activity-boundary",
              afterActivityEventSequence: 3
            },
            cursor: { activityEventSequence: 3, providerConnections: [] },
            schemaVersion: cassettePolicy.schemaVersion
          }
        ]
      }
    );
    assert.equal(dispatched[0].agentSessionId, "child-live");
    assert.equal(dispatched[0].payload.turnId, "child-turn-live");
    assert.equal(verified[1].agentSessionId, "child-live");
    assert.equal(verified[1].payload.turnId, "child-turn-live");
    assert.match(verified[1].correlationId, /^10:child-live/u);
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
  }
});

test("resolves the tuttid listener from the daemon run directory", () => {
  assert.equal(
    replayListenerInfoPath("/tmp/replay-state"),
    "/tmp/replay-state/run/tuttid.listener.json"
  );
});

test("isolated replay workbench suppresses onboarding without preopening AgentGUI", () => {
  const snapshot = replayWorkbenchSnapshot("2026-07-28T00:00:00.000Z");
  assert.deepEqual(snapshot.nodes, []);
  assert.deepEqual(snapshot.nodeStack, []);
  assert.equal(snapshot.activeNodeId, null);
  assert.deepEqual(snapshot.metadata.workspaceOnboarding, {
    autoOpened: true,
    autoOpenedAt: "2026-07-28T00:00:00.000Z",
    schemaVersion: 1
  });
});

test("replay retries only lifecycle readiness conflicts", () => {
  assert.equal(
    replayStimulusPrecondition({
      type: "session.send",
      payload: { guidance: false }
    }),
    "session-idle"
  );
  assert.equal(
    replayStimulusPrecondition({
      type: "session.send",
      payload: { guidance: true }
    }),
    null
  );
  assert.equal(
    replayStimulusPrecondition({ type: "turn.cancel", payload: {} }),
    null
  );
  assert.equal(replayStimulusRetryableStatus("session.create", 502), false);
  assert.equal(replayStimulusRetryableStatus("session.create", 503), false);
  assert.equal(replayStimulusRetryableStatus("session.send", 409), true);
  assert.equal(replayStimulusRetryableStatus("session.send", 502), false);
  assert.equal(
    replayStimulusRetryableStatus("interactive.response", 404),
    false
  );
  assert.deepEqual(
    replayPendingInteraction(
      {
        pendingInteractions: [
          { requestId: "request-1", status: "pending", turnId: "turn-live" }
        ]
      },
      "request-1"
    ),
    { requestId: "request-1", status: "pending", turnId: "turn-live" }
  );
  assert.equal(
    replayPendingInteraction(
      {
        pendingInteractions: [
          { requestId: "request-1", status: "answered", turnId: "turn-live" }
        ]
      },
      "request-1"
    ),
    null
  );
});

test("submit idle wait skips busy-queue submits and honors send causation", () => {
  const queuedSubmit = {
    kind: "intent",
    type: "submit/requested",
    eventId: "intent-queued",
    correlationId: "submit-queued",
    payload: {
      routing: "auto",
      submitDiagnostics: { queued: false }
    }
  };
  const drainedSubmit = {
    kind: "intent",
    type: "submit/requested",
    eventId: "intent-drained",
    correlationId: "submit-drained",
    payload: {
      routing: "auto",
      submitDiagnostics: { queued: false }
    }
  };
  const explicitQueued = {
    kind: "intent",
    type: "submit/requested",
    eventId: "intent-explicit",
    payload: {
      routing: "auto",
      submitDiagnostics: { queued: true }
    }
  };
  const sendNow = {
    kind: "intent",
    type: "submit/requested",
    eventId: "intent-send-now",
    payload: {
      routing: "send_now",
      submitDiagnostics: { queued: false }
    }
  };
  const tape = [
    queuedSubmit,
    drainedSubmit,
    {
      kind: "effect",
      type: "queue/sendPrompt",
      eventId: "effect-1",
      causedByEventId: "intent-drained",
      correlationId: "submit-drained",
      payload: { outcome: "succeeded" }
    },
    {
      kind: "intent",
      type: "queue/sendNowRequested",
      eventId: "intent-send-now-req",
      correlationId: "submit-queued"
    },
    {
      kind: "effect",
      type: "queue/sendPrompt",
      eventId: "effect-2",
      causedByEventId: "intent-send-now-req",
      correlationId: "submit-queued",
      payload: { outcome: "succeeded" }
    }
  ];
  assert.equal(submitRequestedRequiresSessionIdle(queuedSubmit, tape), false);
  assert.equal(submitRequestedRequiresSessionIdle(drainedSubmit, tape), true);
  assert.equal(submitRequestedRequiresSessionIdle(explicitQueued, tape), false);
  assert.equal(submitRequestedRequiresSessionIdle(sendNow, tape), false);
});

test("replay waits for the previous Turn before each queued send", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-order-"));
  const listenerDirectory = join(root, "run");
  await mkdir(listenerDirectory, { recursive: true });
  let active = false;
  let activeChecks = 0;
  const sent = [];
  const accepted = [];
  const server = createServer((request, response) => {
    if (respondToCheckpointVerification(request, response)) return;
    if (
      request.method === "GET" &&
      request.url ===
        `/v1/agent-session-replay/cassettes/${replayCassetteAID}/transport/playback`
    ) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          drained: false,
          paused: false,
          playbackElapsedMs: 0,
          providerConnections: [],
          speed: 1,
          timingMode: "realtime"
        })
      );
      return;
    }
    if (request.method === "GET") {
      activeChecks += 1;
      if (activeChecks >= 2) active = false;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          session: {
            activeTurnId: active ? "turn-active" : null,
            status: active ? "working" : "idle"
          }
        })
      );
      return;
    }
    if (request.url?.endsWith("/input")) {
      if (active) {
        response.statusCode = 502;
        response.end("agent session already has an active turn");
        return;
      }
      sent.push(request.url);
      active = true;
      activeChecks = 0;
      response.end("{}");
      return;
    }
    active = true;
    activeChecks = 0;
    response.statusCode = 201;
    response.end("{}");
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen)
  );
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    await writeFile(
      join(listenerDirectory, "tuttid.listener.json"),
      JSON.stringify({
        addr: `127.0.0.1:${address.port}`,
        auth: { token: "test-token" }
      })
    );
    const base = {
      workspaceId: "workspace-1",
      agentSessionId: "session-1"
    };
    await replayStimuli(
      root,
      {
        ...base,
        activityEvents: [
          {
            ...base,
            kind: "direct-stimulus",
            sequence: 1,
            occurredAtUnixMs: 1,
            type: "session.send",
            payload: { content: [{ type: "text", text: "second" }] }
          },
          {
            ...base,
            kind: "direct-stimulus",
            sequence: 2,
            occurredAtUnixMs: 1,
            type: "session.send",
            payload: { content: [{ type: "text", text: "third" }] }
          }
        ]
      },
      2_000,
      {
        checkpoints: [
          {
            schemaVersion: cassettePolicy.schemaVersion,
            index: 0,
            kind: "bootstrap",
            trigger: { source: "bootstrap" },
            cursor: { activityEventSequence: 0, providerConnections: [] }
          },
          {
            schemaVersion: cassettePolicy.schemaVersion,
            index: 1,
            kind: "after-activity-event",
            trigger: {
              source: "activity-boundary",
              afterActivityEventSequence: 2
            },
            cursor: { activityEventSequence: 2, providerConnections: [] }
          }
        ],
        onStimulusAccepted(stimulus) {
          accepted.push(stimulus.type);
        },
        cassetteId: replayCassetteAID
      }
    );
    assert.equal(sent.length, 2);
    assert.deepEqual(accepted, ["session.send", "session.send"]);
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
  }
});

test("replay diagnoses a 502 through the exact Cassette transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-transport-error-"));
  const listenerDirectory = join(root, "run");
  await mkdir(listenerDirectory, { recursive: true });
  const requests = [];
  const server = createServer((request, response) => {
    if (respondToCheckpointVerification(request, response)) return;
    requests.push(`${request.method} ${request.url}`);
    if (
      request.method === "GET" &&
      request.url ===
        `/v1/agent-session-replay/cassettes/${replayCassetteAID}/transport/playback`
    ) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          drained: false,
          paused: false,
          playbackElapsedMs: 0,
          providerConnections: [],
          speed: 1,
          timingMode: "realtime"
        })
      );
      return;
    }
    if (
      request.method === "POST" &&
      request.url ===
        `/v1/agent-session-replay/cassettes/${replayCassetteAID}/transport/verify`
    ) {
      response.statusCode = 409;
      response.end("recorded outbound frame mismatch");
      return;
    }
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          session: { activeTurnId: null, status: "idle" }
        })
      );
      return;
    }
    response.statusCode = 502;
    response.end("provider transport failed");
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen)
  );
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    await writeFile(
      join(listenerDirectory, "tuttid.listener.json"),
      JSON.stringify({
        addr: `127.0.0.1:${address.port}`,
        auth: { token: "test-token" }
      })
    );
    const base = {
      agentSessionId: "session-1",
      workspaceId: "workspace-1"
    };
    await assert.rejects(
      replayStimuli(
        root,
        {
          ...base,
          activityEvents: [
            {
              ...base,
              kind: "direct-stimulus",
              occurredAtUnixMs: 1,
              payload: { content: [{ type: "text", text: "fail" }] },
              sequence: 1,
              type: "session.send"
            }
          ]
        },
        2_000,
        {
          checkpoints: [
            {
              index: 0,
              kind: "bootstrap",
              trigger: { source: "bootstrap" },
              cursor: { activityEventSequence: 0, providerConnections: [] },
              schemaVersion: cassettePolicy.schemaVersion
            }
          ],
          cassetteId: replayCassetteAID
        }
      ),
      /recorded outbound frame mismatch/u
    );
    assert.equal(
      requests.includes(
        `POST /v1/agent-session-replay/cassettes/${replayCassetteAID}/transport/verify`
      ),
      true
    );
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
  }
});

test("replay drives intents and verifies effects without sending HTTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-activity-"));
  const listenerDirectory = join(root, "run");
  await mkdir(listenerDirectory, { recursive: true });
  const requests = [];
  const playbackStartedAt = Date.now();
  const server = createServer((request, response) => {
    if (respondToCheckpointVerification(request, response)) return;
    if (
      request.method === "GET" &&
      request.url ===
        `/v1/agent-session-replay/cassettes/${replayCassetteAID}/transport/playback`
    ) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          drained: false,
          paused: false,
          playbackElapsedMs: Date.now() - playbackStartedAt,
          providerConnections: [],
          speed: 1,
          timingMode: "realtime"
        })
      );
      return;
    }
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ session: { activeTurnId: null, status: "idle" } })
    );
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen)
  );
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    await writeFile(
      join(listenerDirectory, "tuttid.listener.json"),
      JSON.stringify({
        addr: `127.0.0.1:${address.port}`,
        auth: { token: "test-token" }
      })
    );
    const base = {
      schemaVersion: cassettePolicy.schemaVersion,
      scopeId: "workspace-1",
      workspaceId: "workspace-1",
      agentSessionId: "session-1"
    };
    const calls = [];
    const callTimes = [];
    await replayStimuli(
      root,
      {
        workspaceId: base.workspaceId,
        agentSessionId: base.agentSessionId,
        activityEvents: [
          {
            ...base,
            sequence: 1,
            occurredAtUnixMs: 1,
            kind: "intent",
            type: "queue/sendNowRequested",
            eventId: "intent-1",
            correlationId: "submit-1",
            payload: { promptId: "prompt-1" }
          },
          {
            ...base,
            sequence: 2,
            occurredAtUnixMs: 81,
            kind: "effect",
            type: "session.send",
            eventId: "effect-1",
            correlationId: "submit-1",
            causedByEventId: "intent-1",
            payload: { outcome: "succeeded", guidance: true }
          }
        ]
      },
      2_000,
      {
        checkpoints: [
          {
            schemaVersion: cassettePolicy.schemaVersion,
            index: 0,
            kind: "bootstrap",
            trigger: { source: "bootstrap" },
            cursor: { activityEventSequence: 0, providerConnections: [] }
          },
          {
            schemaVersion: cassettePolicy.schemaVersion,
            index: 1,
            kind: "after-activity-event",
            trigger: {
              source: "activity-boundary",
              afterActivityEventSequence: 2
            },
            cursor: { activityEventSequence: 2, providerConnections: [] }
          }
        ],
        rendererDriver: {
          dispatchIntent(event) {
            calls.push(`intent:${event.type}`);
            callTimes.push(Date.now());
          },
          verifyEffect(event) {
            calls.push(`effect:${event.payload.outcome}`);
            callTimes.push(Date.now());
          }
        },
        cassetteId: replayCassetteAID
      }
    );
    assert.deepEqual(calls, [
      "intent:queue/sendNowRequested",
      "effect:succeeded"
    ]);
    assert.ok(callTimes[1] - callTimes[0] >= 60);
    assert.equal(
      requests.some((request) => request.startsWith("POST /v1/workspaces/")),
      false
    );
    assert.equal(
      requests.some((request) => request.startsWith("GET /v1/workspaces/")),
      true
    );
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
  }
});

test("renderer activity driver scopes bridge calls to one Replay Cassette", async () => {
  const expressions = [];
  const driver = createRendererActivityDriver(
    {
      async send(_method, parameters) {
        expressions.push(parameters.expression);
        return { result: { value: { accepted: true } } };
      }
    },
    2_000,
    replayCassetteAID
  );
  await driver.dispatchIntent({ type: "submit/requested" });
  await driver.verifyEffect({ type: "session.send" });
  assert.equal(expressions.length, 2);
  assert.match(expressions[0], /dispatchCassetteIntent/u);
  assert.match(expressions[0], new RegExp(replayCassetteAID, "u"));
  assert.match(expressions[1], /verifyCassetteEffect/u);
  assert.match(expressions[1], new RegExp(replayCassetteAID, "u"));
});

test("renderer activity driver resumes an exactly-once invocation after CDP collects its Promise", async () => {
  const expressions = [];
  let calls = 0;
  const driver = createRendererActivityDriver(
    {
      async send(_method, parameters) {
        expressions.push(parameters.expression);
        calls += 1;
        if (calls === 1) {
          throw new Error("Promise was collected (-32000)");
        }
        return { result: { value: { accepted: true } } };
      }
    },
    2_000,
    replayCassetteAID
  );
  await driver.dispatchIntent({
    type: "submit/requested",
    eventId: "intent-exactly-once"
  });
  assert.equal(calls, 2);
  assert.equal(expressions[0], expressions[1]);
  assert.match(expressions[0], /__tuttiAgentSessionReplayInvocations/u);
  assert.match(expressions[0], /intent-exactly-once/u);
});

test("renderer activity driver hard-times out when CDP evaluate never resolves", async () => {
  const driver = createRendererActivityDriver(
    {
      async send() {
        return new Promise(() => {
          // Simulate a wedged renderer: CDP never settles.
        });
      }
    },
    50,
    replayCassetteAID
  );
  await assert.rejects(
    () =>
      driver.verifyEffect({
        type: "session/activate",
        eventId: "effect-wedged"
      }),
    /renderer replay invocation timed out after 1s/u
  );
});

test("rejects a direct session.send correlated with a renderer intent", () => {
  assert.throws(
    () =>
      assertNoDuplicateEngineSends([
        {
          kind: "intent",
          type: "submit/requested",
          correlationId: "submit-1"
        },
        {
          kind: "direct-stimulus",
          type: "session.send",
          correlationId: "submit-1"
        }
      ]),
    /duplicates renderer intent/u
  );
});

test("parses ordered activity events and requires effects to follow intents", () => {
  const base = {
    schemaVersion: cassettePolicy.schemaVersion,
    agentSessionId: "session-1",
    occurredAtUnixMs: 1
  };
  const valid = [
    {
      ...base,
      sequence: 1,
      kind: "intent",
      type: "submit/requested",
      eventId: "intent-1",
      payload: { content: [] }
    },
    {
      ...base,
      sequence: 2,
      kind: "effect",
      type: "session.send",
      eventId: "effect-1",
      causedByEventId: "intent-1",
      payload: { outcome: "succeeded" }
    }
  ];
  assert.equal(
    parseActivityEvents(valid.map(JSON.stringify).join("\n")).length,
    2
  );
  assert.throws(
    () =>
      parseActivityEvents(
        [
          {
            ...valid[1],
            sequence: 1
          }
        ]
          .map(JSON.stringify)
          .join("\n")
      ),
    /earlier intent/u
  );
  assert.throws(
    () =>
      parseActivityEvents(
        valid
          .map((event, index) =>
            JSON.stringify({
              ...event,
              occurredAtUnixMs: index === 0 ? 2 : 1
            })
          )
          .join("\n")
      ),
    /is invalid/u
  );
});

test("activity replay clock follows daemon elapsed time and playback state", async () => {
  let playback = {
    paused: false,
    playbackElapsedMs: 0,
    providerConnections: [],
    speed: 1,
    timingMode: "realtime"
  };
  const waits = [];
  let resumeOnNextWait = false;
  const clock = createReplayActivityClock({
    playbackState: async () => playback,
    wait: async (durationMs) => {
      waits.push(durationMs);
      if (!playback.paused && playback.timingMode === "realtime") {
        playback = {
          ...playback,
          playbackElapsedMs:
            playback.playbackElapsedMs + durationMs * playback.speed
        };
      }
      if (resumeOnNextWait) {
        resumeOnNextWait = false;
        playback = { ...playback, paused: false };
      }
    }
  });

  await clock.waitUntil(1_000);
  playback = { ...playback, playbackElapsedMs: 20 };
  await clock.waitUntil(1_100);
  assert.equal(
    waits.reduce((total, duration) => total + duration, 0),
    80
  );

  playback = { ...playback, speed: 2 };
  const speedWaitStart = waits.length;
  await clock.waitUntil(1_200);
  assert.equal(
    waits
      .slice(speedWaitStart)
      .reduce((total, duration) => total + duration, 0),
    50
  );

  playback = { ...playback, paused: true };
  const pauseWaitStart = waits.length;
  resumeOnNextWait = true;
  await clock.waitUntil(1_300);
  assert.equal(
    waits
      .slice(pauseWaitStart)
      .reduce((total, duration) => total + duration, 0),
    100
  );

  playback = { ...playback, timingMode: "fast-forward" };
  const fastForwardWaitStart = waits.length;
  await clock.waitUntil(2_000);
  assert.equal(waits.length, fastForwardWaitStart);
});

test("uses portable checkpoint plan instead of deriving activity boundaries", () => {
  const checkpoints = validateReplayCheckpointPlan(
    {
      schemaVersion: 2,
      cassetteSchemaVersion: cassettePolicy.schemaVersion,
      observationSchemaVersion: 2,
      checkpoints: [
        {
          id: "checkpoint-0000",
          index: 0,
          kind: "replay.bootstrap",
          tags: ["replay.bootstrap"],
          cursor: {
            activityEventSequence: 0,
            providerConnections: []
          },
          trigger: { source: "bootstrap" }
        },
        {
          id: "checkpoint-0001",
          index: 1,
          kind: "submission.accepted",
          tags: ["submission.accepted"],
          cursor: {
            activityEventSequence: 2,
            providerConnections: []
          },
          trigger: {
            source: "activity-boundary",
            afterActivityEventSequence: 2,
            boundaryKind: "intent-effects"
          }
        }
      ]
    },
    [
      { sequence: 1, kind: "intent", eventId: "intent-1" },
      {
        sequence: 2,
        kind: "effect",
        eventId: "effect-1",
        causedByEventId: "intent-1"
      },
      { sequence: 3, kind: "direct-stimulus", eventId: "send-1" }
    ]
  );
  assert.deepEqual(
    checkpoints.map((checkpoint) => checkpoint.cursor.activityEventSequence),
    [0, 2]
  );
});

test("rejects checkpoint plan v1 without a compatibility fallback", () => {
  assert.throws(
    () =>
      validateReplayCheckpointPlan(
        {
          schemaVersion: 1,
          cassetteSchemaVersion: cassettePolicy.schemaVersion,
          observationSchemaVersion: 1,
          checkpoints: []
        },
        []
      ),
    /checkpoint_plan_invalid: unsupported plan schema/
  );
});

test("next checkpoint fast-forwards without skipping the stable boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-control-"));
  const controlPath = join(root, "replay-control.json");
  const statusPath = join(root, "replay-status.json");
  const commands = [];
  const requestPaths = [];
  const transportPlayback = {
    drained: false,
    paused: false,
    playbackElapsedMs: 0,
    providerConnections: [],
    speed: 1,
    timingMode: "realtime"
  };
  const server = createServer(async (request, response) => {
    requestPaths.push(request.url);
    if (respondToCheckpointVerification(request, response)) return;
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(transportPlayback));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const command = JSON.parse(body);
    commands.push(command);
    if (command.command === "pause") transportPlayback.paused = true;
    if (command.command === "resume") transportPlayback.paused = false;
    if (command.command === "set-timing-mode") {
      transportPlayback.timingMode = command.timingMode;
    }
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen)
  );
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const checkpoints = [
      {
        schemaVersion: cassettePolicy.schemaVersion,
        index: 0,
        kind: "bootstrap",
        trigger: { source: "bootstrap" },
        cursor: { activityEventSequence: 0, providerConnections: [] }
      },
      {
        schemaVersion: cassettePolicy.schemaVersion,
        index: 1,
        kind: "after-activity-event",
        trigger: {
          source: "activity-boundary",
          afterActivityEventSequence: 2
        },
        cursor: { activityEventSequence: 2, providerConnections: [] }
      }
    ];
    await writeFile(
      controlPath,
      JSON.stringify(replayControlRouter(replayCassetteAID, 0, "resume"))
    );
    const reached = [];
    let replacement = null;
    const playback = createReplayPlaybackController({
      baseURL: `http://127.0.0.1:${address.port}`,
      checkpoints,
      controlPath,
      headers: { "content-type": "application/json" },
      onCheckpoint(checkpoint) {
        reached.push(checkpoint);
      },
      onReplacement(value) {
        replacement = value;
      },
      cassetteId: replayCassetteAID,
      statusPath,
      targetCheckpoint: null,
      timeoutMs: 2_000
    });
    await playback.initialize();
    await writeFile(
      controlPath,
      JSON.stringify(
        replayControlRouter(replayCassetteAID, 1, "next-checkpoint")
      )
    );
    await playback.waitUntilRunnable();
    assert.equal(playback.checkpointAfter(2).index, 1);
    await playback.activityAdvanced(2);
    await playback.reach(checkpoints[1]);
    assert.deepEqual(reached, [1]);
    assert.deepEqual(commands, [
      { command: "set-provider-cursor", providerConnections: [] },
      { command: "set-timing-mode", timingMode: "fast-forward" },
      { command: "resume" },
      { command: "set-timing-mode", timingMode: "realtime" },
      { command: "pause" }
    ]);
    assert.equal(
      requestPaths.includes(
        `/v1/agent-session-replay/cassettes/${replayCassetteAID}/checkpoints/1/verify`
      ),
      true
    );
    assert.deepEqual(JSON.parse(await readFile(statusPath, "utf8")), {
      currentCheckpoint: 1,
      totalCheckpoints: 2,
      paused: true,
      timingMode: "realtime",
      targetCheckpoint: null
    });

    await writeFile(
      controlPath,
      JSON.stringify(replayControlRouter(replayCassetteAID, 2, "resume"))
    );
    await playback.waitUntilRunnable();
    assert.deepEqual(commands.at(-1), { command: "resume" });

    let slowOperationSettled = false;
    let settleSlowOperation;
    const slowOperation = new Promise((resolveSlowOperation) => {
      settleSlowOperation = resolveSlowOperation;
    });
    const controlSlowOperation = (async () => {
      await writeFile(
        controlPath,
        JSON.stringify(replayControlRouter(replayCassetteAID, 3, "pause"))
      );
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (commands.at(-1)?.command === "pause") break;
        await delay(25);
      }
      assert.equal(slowOperationSettled, false);
      assert.deepEqual(commands.at(-1), { command: "pause" });
      await writeFile(
        controlPath,
        JSON.stringify(replayControlRouter(replayCassetteAID, 4, "resume"))
      );
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (commands.at(-1)?.command === "resume") break;
        await delay(25);
      }
      assert.deepEqual(commands.at(-1), { command: "resume" });
      settleSlowOperation();
    })();
    await Promise.all([
      playback
        .runWhilePolling(() => slowOperation)
        .finally(() => {
          slowOperationSettled = true;
        }),
      controlSlowOperation
    ]);
    assert.deepEqual(commands.slice(-3), [
      { command: "pause" },
      { command: "clear-provider-cursor" },
      { command: "resume" }
    ]);

    await writeFile(
      controlPath,
      JSON.stringify(
        replayControlRouter(replayCassetteAID, 5, "switch-cassette", {
          cassetteId: "cassette-2"
        })
      )
    );
    await assert.rejects(
      playback.waitForReplacement(() => true),
      /Replay Cassette replacement requested/u
    );
    assert.deepEqual(replacement, {
      command: "switch-cassette",
      currentCheckpoint: 1,
      cassetteId: "cassette-2"
    });
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
  }
});

test("manual next holds activity after landing a shared-actSeq checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-shared-actseq-"));
  const controlPath = join(root, "replay-control.json");
  const statusPath = join(root, "replay-status.json");
  const commands = [];
  const transportPlayback = {
    drained: false,
    paused: false,
    playbackElapsedMs: 0,
    providerConnections: [],
    speed: 1,
    timingMode: "realtime"
  };
  const server = createServer(async (request, response) => {
    if (respondToCheckpointVerification(request, response)) return;
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(transportPlayback));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const command = JSON.parse(body);
    commands.push(command);
    if (command.command === "pause") transportPlayback.paused = true;
    if (command.command === "resume") transportPlayback.paused = false;
    if (command.command === "set-timing-mode") {
      transportPlayback.timingMode = command.timingMode;
    }
    if (command.command === "set-provider-cursor") {
      transportPlayback.providerConnections = command.providerConnections ?? [];
    }
    if (command.command === "clear-provider-cursor") {
      transportPlayback.providerConnections = [];
    }
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen)
  );
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const providerAt = (chunkSeq) => [
      { connectionId: "connection-1", chunkSeq, unitIndex: 1 }
    ];
    const checkpoints = [
      {
        schemaVersion: cassettePolicy.schemaVersion,
        index: 0,
        kind: "bootstrap",
        trigger: { source: "bootstrap" },
        cursor: { activityEventSequence: 0, providerConnections: [] }
      },
      {
        schemaVersion: cassettePolicy.schemaVersion,
        index: 1,
        kind: "tool.started",
        trigger: {
          source: "provider-observation",
          type: "call.started"
        },
        cursor: {
          activityEventSequence: 2,
          providerConnections: providerAt(54)
        }
      },
      {
        schemaVersion: cassettePolicy.schemaVersion,
        index: 2,
        kind: "interaction.pending",
        trigger: {
          source: "provider-observation",
          type: "interaction.requested"
        },
        cursor: {
          activityEventSequence: 2,
          providerConnections: providerAt(55)
        }
      },
      {
        schemaVersion: cassettePolicy.schemaVersion,
        index: 3,
        kind: "interaction.resolved",
        trigger: {
          source: "activity-boundary",
          afterActivityEventSequence: 3
        },
        cursor: {
          activityEventSequence: 3,
          providerConnections: providerAt(55)
        }
      }
    ];
    const reached = [];
    const writeControl = createAgentSessionReplayControlWriter(controlPath);
    const playback = createReplayPlaybackController({
      baseURL: `http://127.0.0.1:${address.port}`,
      checkpoints,
      controlPath,
      headers: { "content-type": "application/json" },
      onCheckpoint(checkpoint) {
        reached.push(checkpoint);
      },
      cassetteId: replayCassetteAID,
      statusPath,
      targetCheckpoint: 1,
      timeoutMs: 2_000
    });
    await playback.initialize();
    await playback.activityAdvanced(2);
    await playback.runWhilePolling(async () => {
      while (!reached.includes(1)) {
        await playback.reach(checkpoints[1]);
        await delay(10);
      }
    });
    assert.deepEqual(reached, [1]);

    const setProviderCountAfterFirstLand = commands.filter(
      (command) => command.command === "set-provider-cursor"
    ).length;

    await writeControl({
      command: "next-checkpoint",
      cassetteId: replayCassetteAID
    });
    // Duplicate next while seeking must only ack the revision.
    await writeControl({
      command: "next-checkpoint",
      cassetteId: replayCassetteAID
    });
    await playback.runWhilePolling(async () => {
      while (!reached.includes(2)) {
        await playback.reach(checkpoints[2]);
        await delay(10);
      }
    });
    assert.deepEqual(reached, [1, 2]);
    assert.equal(
      commands.filter((command) => command.command === "set-provider-cursor")
        .length,
      setProviderCountAfterFirstLand + 1
    );

    let activityReleased = false;
    const waiting = playback.waitBeforeActivity(3).then(() => {
      activityReleased = true;
    });
    await playback.runWhilePolling(() => delay(80));
    assert.equal(activityReleased, false);

    await writeControl({
      command: "next-checkpoint",
      cassetteId: replayCassetteAID
    });
    await playback.runWhilePolling(() => waiting);
    assert.equal(activityReleased, true);
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
  }
});

test("Replay Workspace routes Desktop control DTOs to only their Cassette controller", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-control-router-"));
  const controlPath = join(root, "replay-control.json");
  const commands = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          drained: false,
          paused: false,
          playbackElapsedMs: 0,
          providerConnections: [],
          speed: 1,
          timingMode: "realtime"
        })
      );
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const cassetteId = decodeURIComponent(
      request.url.split("/cassettes/")[1].split("/transport/")[0]
    );
    commands.push({ cassetteId, command: JSON.parse(body) });
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen)
  );
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const input = {
      baseURL: `http://127.0.0.1:${address.port}`,
      checkpoints: [
        {
          schemaVersion: cassettePolicy.schemaVersion,
          index: 0,
          kind: "bootstrap",
          trigger: { source: "bootstrap" },
          cursor: { activityEventSequence: 0, providerConnections: [] }
        },
        {
          schemaVersion: cassettePolicy.schemaVersion,
          index: 1,
          kind: "after-activity-event",
          trigger: {
            source: "activity-boundary",
            afterActivityEventSequence: 1
          },
          cursor: { activityEventSequence: 1, providerConnections: [] }
        }
      ],
      controlPath,
      headers: { "content-type": "application/json" },
      targetCheckpoint: null,
      timeoutMs: 2_000
    };
    const controllerA = createReplayPlaybackController({
      ...input,
      cassetteId: replayCassetteAID
    });
    const controllerB = createReplayPlaybackController({
      ...input,
      cassetteId: replayCassetteBID
    });
    await Promise.all([controllerA.initialize(), controllerB.initialize()]);
    const writeControl = createAgentSessionReplayControlWriter(controlPath);

    await writeControl({ command: "pause", cassetteId: replayCassetteAID });
    await Promise.all([
      controllerA.runWhilePolling(() => delay(80)),
      controllerB.runWhilePolling(() => delay(80))
    ]);
    assert.deepEqual(commands, [
      {
        cassetteId: replayCassetteAID,
        command: { command: "pause" }
      }
    ]);

    await writeControl({
      command: "next-checkpoint",
      cassetteId: replayCassetteBID
    });
    await Promise.all([
      controllerA.runWhilePolling(() => delay(80)),
      controllerB.runWhilePolling(() => delay(80))
    ]);
    assert.deepEqual(commands.slice(1), [
      {
        cassetteId: replayCassetteBID,
        command: {
          command: "set-provider-cursor",
          providerConnections: []
        }
      },
      {
        cassetteId: replayCassetteBID,
        command: {
          command: "set-timing-mode",
          timingMode: "fast-forward"
        }
      },
      {
        cassetteId: replayCassetteBID,
        command: { command: "resume" }
      }
    ]);
    assert.deepEqual(JSON.parse(await readFile(controlPath, "utf8")), {
      schemaVersion: 2,
      cassettes: {
        [replayCassetteAID]: { command: "pause", revision: 1 },
        [replayCassetteBID]: {
          command: "next-checkpoint",
          revision: 1
        }
      }
    });
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
  }
});

test("record arguments default to headed mode", () => {
  const options = parseArgs([
    "--record",
    ".tmp/cassettes/example",
    "--scenario",
    "c01",
    "--scenario-file",
    "/tmp/cases/c01/scenario.mjs",
    "--timeout-ms",
    "1234"
  ]);
  assert.equal(options.mode, "record");
  assert.equal(options.headless, undefined);
  assert.equal(resolveDesktopHeadless(options), false);
  assert.equal(options.scenario, "c01");
  assert.equal(options.timeoutMs, 1234);
  assert.equal(options.stallTimeoutMs, 60_000);
  assert.match(
    options.cassetteDirectory,
    /[/\\]\.tmp[/\\]cassettes[/\\]example$/u
  );
});

test("headless flag hides the Electron window", () => {
  const options = parseArgs([
    "--replay",
    ".tmp/cassettes/example",
    "--headless"
  ]);
  assert.equal(options.headless, true);
  assert.equal(resolveDesktopHeadless(options), true);
});

test("managed replay stays headed even with --headless", () => {
  const options = parseArgs([
    "--replay",
    ".tmp/cassettes/example",
    "--cassette-id",
    "example",
    "--managed",
    "--headless"
  ]);
  assert.equal(options.managed, true);
  assert.equal(options.headless, true);
  assert.equal(resolveDesktopHeadless(options), false);
});

test("stall timeout accepts an override and zero disables it", () => {
  const options = parseArgs([
    "--replay",
    ".tmp/cassettes/example",
    "--stall-timeout-ms",
    "5000"
  ]);
  assert.equal(options.stallTimeoutMs, 5000);
  const disabled = parseArgs([
    "--replay",
    ".tmp/cassettes/example",
    "--stall-timeout-ms",
    "0"
  ]);
  assert.equal(disabled.stallTimeoutMs, 0);
  assert.throws(
    () =>
      parseArgs([
        "--replay",
        ".tmp/cassettes/example",
        "--stall-timeout-ms",
        "-1"
      ]),
    /--stall-timeout-ms must be a non-negative integer/
  );
});

test("screenshot checkpoints are opt-in for replay only", () => {
  const options = parseArgs([
    "--replay",
    ".tmp/cassettes/example",
    "--screenshot-checkpoints"
  ]);
  assert.equal(options.screenshotCheckpoints, true);
  const workspace = parseArgs([
    "--replay-workspace-manifest",
    ".tmp/replay-workspace.json",
    "--screenshot-checkpoints"
  ]);
  assert.equal(workspace.screenshotCheckpoints, true);
  assert.throws(
    () =>
      parseArgs([
        "--record",
        ".tmp/cassettes/example",
        "--scenario",
        "c01",
        "--scenario-file",
        "/tmp/cases/c01/scenario.mjs",
        "--screenshot-checkpoints"
      ]),
    /--screenshot-checkpoints is only supported with replay/
  );
});

test("checkpoint screenshot paths stay Cassette-scoped in a Replay Workspace", () => {
  const checkpoints = [{ id: "checkpoint-0000" }, { id: "checkpoint-0004" }];
  assert.equal(
    replayCheckpointScreenshotPath({
      artifactDirectory: "/tmp/artifacts",
      checkpointIndex: 4,
      checkpoints: [{ id: "checkpoint-0000" }]
    }),
    join("/tmp/artifacts", "checkpoint-0004.png")
  );
  assert.equal(
    replayCheckpointScreenshotPath({
      artifactDirectory: "/tmp/artifacts",
      cassetteId: "cassette-a",
      checkpointIndex: 1,
      checkpoints
    }),
    join("/tmp/artifacts", "cassette-a", "checkpoint-0004.png")
  );
});

test("normalizeScreenshotClip rejects tiny or invalid rects", () => {
  assert.equal(normalizeScreenshotClip(null), null);
  assert.equal(
    normalizeScreenshotClip({ x: 0, y: 0, width: 4, height: 100 }),
    null
  );
  assert.deepEqual(
    normalizeScreenshotClip({ x: 10.9, y: 20.1, width: 300.7, height: 400.2 }),
    { x: 10, y: 20, width: 300, height: 400, scale: 1 }
  );
});

test("screenshotEvidenceLabel prefers caseId over scenario", () => {
  assert.equal(screenshotEvidenceLabel(" C03 "), "C03");
  assert.equal(
    screenshotEvidenceLabel({ caseId: "C03", scenario: "c03" }),
    "C03"
  );
  assert.equal(screenshotEvidenceLabel({ scenario: "c03" }), "c03");
  assert.equal(screenshotEvidenceLabel({}), "");
});

test("captureScreenshot clips to the pinned Agent Session and stamps a case badge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asr-clip-shot-"));
  const outputPath = join(directory, "checkpoint.png");
  const evaluations = [];
  const captures = [];
  const client = {
    async send(method, params) {
      if (method === "Runtime.evaluate") {
        evaluations.push(params.expression);
        if (params.expression.includes("getBoundingClientRect")) {
          return {
            result: {
              value: { x: 120.4, y: 40.6, width: 640.8, height: 800.2 }
            }
          };
        }
        return { result: { value: true } };
      }
      if (method === "Page.captureScreenshot") {
        captures.push(params);
        // 1x1 PNG
        return {
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        };
      }
      throw new Error(`unexpected CDP method: ${method}`);
    }
  };

  const result = await captureScreenshot(client, outputPath, {
    agentSessionId: "session-left",
    label: "C03"
  });
  assert.deepEqual(result.clip, {
    x: 120,
    y: 40,
    width: 640,
    height: 800,
    scale: 1
  });
  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0].clip, result.clip);
  assert.ok(
    evaluations.some((expression) =>
      expression.includes('data-tutti-replay-evidence-badge="true"')
    )
  );
  assert.ok(evaluations.some((expression) => expression.includes('"C03"')));
  assert.ok(
    evaluations.some((expression) =>
      expression.includes(
        "querySelectorAll('[data-tutti-replay-evidence-badge="
      )
    )
  );
  assert.equal((await readFile(outputPath)).length > 0, true);
});

test("captureScreenshot falls back to a full-page shot when the session rect is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asr-full-shot-"));
  const outputPath = join(directory, "checkpoint.png");
  const captures = [];
  const client = {
    async send(method, params) {
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("getBoundingClientRect")) {
          return { result: { value: null } };
        }
        return { result: { value: true } };
      }
      if (method === "Page.captureScreenshot") {
        captures.push(params);
        return {
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        };
      }
      throw new Error(`unexpected CDP method: ${method}`);
    }
  };

  const result = await captureScreenshot(client, outputPath, {
    agentSessionId: "missing-session",
    label: "C05"
  });
  assert.equal(result.clip, null);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].clip, undefined);
});

test("captureCheckpointScreenshot keeps Cassette path and forwards clip identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asr-checkpoint-shot-"));
  const captures = [];
  const client = {
    async send(method, params) {
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("getBoundingClientRect")) {
          return {
            result: { value: { x: 0, y: 0, width: 200, height: 300 } }
          };
        }
        return { result: { value: true } };
      }
      if (method === "Page.captureScreenshot") {
        captures.push(params);
        return {
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        };
      }
      throw new Error(`unexpected CDP method: ${method}`);
    }
  };

  const outputPath = await captureCheckpointScreenshot({
    agentSessionId: "session-a",
    artifactDirectory: directory,
    cassetteId: "cassette-a",
    checkpointIndex: 0,
    checkpoints: [{ id: "checkpoint-0007" }],
    client,
    label: "R12"
  });
  assert.equal(
    outputPath,
    join(directory, "cassette-a", "checkpoint-0007.png")
  );
  assert.deepEqual(captures[0]?.clip, {
    x: 0,
    y: 0,
    width: 200,
    height: 300,
    scale: 1
  });
});

test("resolveAgentSessionScreenshotClip returns null without a session id", async () => {
  assert.equal(
    await resolveAgentSessionScreenshotClip({ send() {} }, ""),
    null
  );
  assert.equal(
    await resolveAgentSessionScreenshotClip({ send() {} }, null),
    null
  );
});

test("record arguments accept an external scenario file", () => {
  const options = parseArgs([
    "--record",
    ".tmp/cassettes/example",
    "--scenario",
    "c01",
    "--scenario-file",
    "/tmp/cases/c01/scenario.mjs"
  ]);
  assert.equal(options.scenario, "c01");
  assert.equal(options.scenarioFile, "/tmp/cases/c01/scenario.mjs");
});

test("replay arguments accept an optional scenario file for screenshot settle", () => {
  const options = parseArgs([
    "--replay",
    ".tmp/cassettes/example",
    "--scenario",
    "c01",
    "--scenario-file",
    "/tmp/cases/c01/scenario.mjs",
    "--screenshot-checkpoints"
  ]);
  assert.equal(options.mode, "replay");
  assert.equal(options.scenario, "c01");
  assert.equal(options.scenarioFile, "/tmp/cases/c01/scenario.mjs");
  assert.equal(options.screenshotCheckpoints, true);
});

test("checkpoint settle targets completed tool and terminal turn checkpoints", () => {
  assert.equal(checkpointNeedsScreenshotSettle(null), true);
  assert.equal(
    checkpointNeedsScreenshotSettle({
      kind: "tool.completed",
      tags: ["tool.completed"]
    }),
    true
  );
  assert.equal(
    checkpointNeedsScreenshotSettle({
      kind: "turn.terminal",
      tags: ["turn.terminal"]
    }),
    true
  );
  assert.equal(
    checkpointNeedsScreenshotSettle({
      kind: "tool.started",
      tags: ["tool.started"]
    }),
    false
  );
  assert.equal(
    checkpointNeedsScreenshotSettle({
      kind: "submission.accepted",
      tags: ["submission.accepted"]
    }),
    false
  );
  assert.equal(
    checkpointNeedsScreenshotSettle({
      kind: "turn.working",
      tags: ["turn.working"]
    }),
    false
  );
  assert.equal(checkpointNeedsToolSettle(null), false);
  assert.equal(
    checkpointNeedsToolSettle({
      kind: "tool.completed",
      tags: ["tool.completed"]
    }),
    true
  );
  assert.equal(
    checkpointNeedsToolSettle({
      kind: "tool.started",
      tags: ["tool.started"]
    }),
    false
  );
  assert.equal(
    checkpointNeedsToolSettle({
      kind: "turn.terminal",
      tags: ["turn.terminal"]
    }),
    false
  );
  assert.equal(
    checkpointNeedsToolSettle({ kind: "turn.working", tags: ["turn.working"] }),
    false
  );
  assert.equal(
    checkpointAllowsOptionalScreenshotSettle({
      kind: "submission.accepted",
      tags: ["submission.accepted"]
    }),
    true
  );
  assert.equal(
    checkpointAllowsOptionalScreenshotSettle({
      kind: "plan.waiting",
      tags: ["plan.waiting"]
    }),
    true
  );
  assert.equal(
    checkpointAllowsOptionalScreenshotSettle({
      kind: "turn.working",
      tags: ["turn.working"]
    }),
    false
  );
});

test("record scenarios require an id and file and reject raw prompt overrides", () => {
  assert.throws(
    () => parseArgs(["--record", ".tmp/cassettes/example"]),
    /--scenario is required/u
  );
  assert.throws(
    () =>
      parseArgs(["--record", ".tmp/cassettes/example", "--scenario", "c01"]),
    /--scenario and --scenario-file must be provided together/u
  );
  assert.throws(
    () =>
      parseArgs([
        "--record",
        ".tmp/cassettes/example",
        "--scenario",
        "i01",
        "--scenario-file",
        "/tmp/cases/i01/scenario.mjs",
        "--prompt",
        "override"
      ]),
    /unknown option: --prompt/u
  );
});

test("record runner loads and validates the external scenario module", async () => {
  const directory = await mkdtemp(join(tmpdir(), "external-scenario-"));
  const scenarioFile = join(directory, "scenario.mjs");
  await writeFile(
    scenarioFile,
    `export default {
      id: "c01",
      prepare() {},
      drive() {},
      assert() {}
    };\n`
  );
  const scenario = await loadRecordScenario({
    scenario: "c01",
    scenarioFile
  });
  assert.equal(scenario.id, "c01");
  await assert.rejects(
    loadRecordScenario({ scenario: "c02", scenarioFile }),
    /does not export scenario c02/u
  );
});

test("record and replay modes are mutually exclusive", () => {
  assert.throws(
    () =>
      parseArgs([
        "--record",
        ".tmp/cassettes/record",
        "--replay",
        ".tmp/cassettes/replay"
      ]),
    /exactly one/u
  );
});

test("managed replay requires the daemon-owned Replay Cassette id", () => {
  assert.throws(
    () => parseArgs(["--replay", ".tmp/cassette", "--managed"]),
    /--cassette-id is required/u
  );
});

test("Replay Workspace arguments accept one fixed batch manifest", () => {
  const options = parseArgs([
    "--replay-workspace-manifest",
    ".tmp/replay-workspace.json",
    "--managed"
  ]);
  assert.equal(options.mode, "replay-workspace");
  assert.equal(options.managed, true);
  assert.match(
    options.replayWorkspaceManifestPath,
    /[/\\]\.tmp[/\\]replay-workspace\.json$/u
  );
  assert.throws(
    () =>
      parseArgs([
        "--replay-workspace-manifest",
        ".tmp/replay-workspace.json",
        "--cassette-id",
        replayCassetteAID
      ]),
    /--cassette-id is not supported/u
  );
});

test("Replay Workspace manifest rejects duplicate cassette and root Session", () => {
  const cassette = (cassetteId, rootAgentSessionId) => ({
    cassetteId,
    cassetteDirectory: `.tmp/${cassetteId}`,
    rootAgentSessionId
  });
  assert.throws(
    () =>
      validateReplayWorkspaceManifest({
        playbackMode: "unexpected",
        cassettes: [cassette(replayCassetteAID, "root-a")]
      }),
    /playback mode is invalid/u
  );
  assert.throws(
    () =>
      validateReplayWorkspaceManifest({
        playbackMode: "automatic",
        workspaceId: "workspace-a",
        cassettes: [
          cassette(replayCassetteAID, "root-a"),
          cassette(replayCassetteAID, "root-b")
        ]
      }),
    /duplicate Replay Workspace cassette/u
  );
  assert.throws(
    () =>
      validateReplayWorkspaceManifest({
        playbackMode: "automatic",
        workspaceId: "workspace-a",
        cassettes: [
          cassette(replayCassetteAID, "root-a"),
          cassette(replayCassetteBID, "root-a")
        ]
      }),
    /duplicate Replay Workspace root Session/u
  );
  assert.deepEqual(
    validateReplayWorkspaceManifest({
      playbackMode: "manual",
      cassettes: [{ cassetteDirectory: ".tmp/portable-cassette" }]
    }),
    {
      cassettes: [
        {
          caseId: "",
          cassetteDirectory: join(process.cwd(), ".tmp", "portable-cassette"),
          cassetteId: "",
          rootAgentSessionId: "",
          scenario: "",
          scenarioFile: ""
        }
      ],
      playbackMode: "manual",
      workspaceId: null
    }
  );
  assert.equal(
    validateReplayWorkspaceManifest({
      playbackMode: "automatic",
      cassettes: [
        {
          caseId: "C03",
          cassetteDirectory: ".tmp/c03"
        }
      ]
    }).cassettes[0]?.caseId,
    "C03"
  );
});

test("manual Replay Workspace starts at its first inspectable checkpoint", () => {
  assert.equal(
    replayWorkspaceInitialTargetCheckpoint(
      {
        action: { type: "continue-session" },
        cassetteId: replayCassetteAID,
        checkpoints: [{}]
      },
      "manual"
    ),
    0
  );
  assert.equal(
    replayWorkspaceInitialTargetCheckpoint(
      {
        action: { type: "create-session" },
        cassetteId: replayCassetteBID,
        checkpoints: [{}, {}]
      },
      "manual"
    ),
    1
  );
  assert.equal(
    replayWorkspaceInitialTargetCheckpoint(
      {
        action: { type: "create-session" },
        cassetteId: replayCassetteBID,
        checkpoints: [{}]
      },
      "automatic"
    ),
    null
  );
});

test("Replay Workspace shares the earliest recorded Activity clock origin", () => {
  assert.equal(
    replayWorkspaceActivityClockOrigin([
      { action: { activityEvents: [{ occurredAtUnixMs: 2_000 }] } },
      { action: { activityEvents: [{ occurredAtUnixMs: 1_000 }] } }
    ]),
    1_000
  );
  assert.equal(
    replayWorkspaceActivityClockOrigin([{ action: { activityEvents: [] } }]),
    null
  );
});

test("Replay Workspace rejects duplicate identities derived from artifacts", async () => {
  let runtimeCreates = 0;
  await assert.rejects(
    bootstrapReplayWorkspace(
      {
        playbackMode: "automatic",
        cassettes: [
          { cassetteDirectory: ".tmp/cassette-a" },
          { cassetteDirectory: ".tmp/cassette-b" }
        ]
      },
      {
        createWorkspaceId: () => "replay-workspace",
        async loadCassette(cassette) {
          return {
            ...cassette,
            cassetteId: replayCassetteAID,
            rootAgentSessionId: "root-a"
          };
        },
        async createRuntime() {
          runtimeCreates += 1;
          return {};
        }
      }
    ),
    /duplicate Replay Workspace cassette/u
  );
  assert.equal(runtimeCreates, 0);
});

test("Replay Workspace leaves Workspace creation to the semantic runtime", async () => {
  const calls = [];
  const manifest = {
    playbackMode: "automatic",
    workspaceId: "workspace-a",
    cassettes: [
      {
        cassetteId: replayCassetteAID,
        cassetteDirectory: ".tmp/cassette-a",
        rootAgentSessionId: "root-a"
      },
      {
        cassetteId: replayCassetteBID,
        cassetteDirectory: ".tmp/cassette-b",
        rootAgentSessionId: "root-b"
      }
    ]
  };
  const bootstrap = await bootstrapReplayWorkspace(manifest, {
    async loadCassette(cassette) {
      calls.push(`load:${cassette.cassetteId}`);
      return {
        ...cassette,
        action: { activityEvents: [], workspaceId: "workspace-a" },
        mode: "create-session"
      };
    },
    async createRuntime(mode) {
      calls.push(`create:${mode}`);
      return {
        directory: "/runtime",
        stateDirectory: "/runtime/state"
      };
    },
    async initializeDatabase() {
      calls.push("database");
    },
    async materializeBlobs() {
      calls.push("blobs");
    },
    async removeRuntime() {
      calls.push("remove");
    }
  });
  assert.deepEqual(calls, [
    `load:${replayCassetteAID}`,
    `load:${replayCassetteBID}`,
    "create:replay-workspace",
    "database",
    "blobs"
  ]);
  assert.equal(bootstrap.runtime.directory, "/runtime");
  assert.deepEqual(
    bootstrap.registrations,
    replayWorkspaceTransportRegistrations(bootstrap.cassettes)
  );
});

test("Replay Workspace seeds each portable project once before blobs", async () => {
  const calls = [];
  const sharedProject = resolveRecordScenarioProject(
    { label: "repo", relativePath: "." },
    workspaceRoot
  );
  const nestedProject = resolveRecordScenarioProject(
    { label: "agent", relativePath: "packages/agent" },
    workspaceRoot
  );
  await bootstrapReplayWorkspace(
    {
      playbackMode: "automatic",
      workspaceId: "workspace-a",
      cassettes: [
        {
          cassetteId: replayCassetteAID,
          cassetteDirectory: ".tmp/cassette-a",
          rootAgentSessionId: "root-a"
        },
        {
          cassetteId: replayCassetteBID,
          cassetteDirectory: ".tmp/cassette-b",
          rootAgentSessionId: "root-b"
        },
        {
          cassetteId: "a4509255-05f8-4420-aa75-d07234cae38e",
          cassetteDirectory: ".tmp/cassette-c",
          rootAgentSessionId: "root-c"
        }
      ]
    },
    {
      async loadCassette(cassette) {
        return {
          ...cassette,
          action: {
            replayProject:
              cassette.rootAgentSessionId === "root-c"
                ? nestedProject
                : sharedProject,
            workspaceId: "workspace-a"
          },
          mode: "create-session"
        };
      },
      async createRuntime() {
        return {
          directory: "/runtime",
          stateDirectory: "/runtime/state"
        };
      },
      async initializeDatabase(_runtime, workspaceId) {
        calls.push(`database:${workspaceId}`);
      },
      async seedUserProject(databasePath, project) {
        calls.push(`project:${databasePath}:${project.portablePath}`);
      },
      async materializeBlobs() {
        calls.push("blobs");
      }
    }
  );
  assert.deepEqual(calls, [
    "database:workspace-a",
    "project:/runtime/state/tuttid.db:${REPLAY_CWD}",
    "project:/runtime/state/tuttid.db:${REPLAY_CWD}/packages/agent",
    "blobs"
  ]);
});

test("Replay registrations carry cassette provider and frozen model metadata", () => {
  assert.deepEqual(
    replayWorkspaceTransportRegistrations([
      {
        cassetteId: replayCassetteAID,
        rootAgentSessionId: "root-a",
        cassetteDirectory: "/tmp/cassette-a",
        providers: ["codex"],
        replayPrerequisites: replayPrerequisitesForTest(),
        action: { workspaceId: "workspace-a" }
      }
    ]),
    [
      {
        cassetteId: replayCassetteAID,
        rootAgentSessionId: "root-a",
        cassetteDirectory: "/tmp/cassette-a/provider",
        artifactDirectory: "/tmp/cassette-a",
        workspaceId: "workspace-a",
        providers: ["codex"],
        frozenModel: "gpt-5.4"
      }
    ]
  );
});

test("Replay database enables the agent session recording feature", async () => {
  const databasePath = join(
    tmpdir(),
    `agent-session-replay-feature-${Date.now()}.db`
  );
  try {
    await execFileAsync("sqlite3", [
      databasePath,
      `CREATE TABLE desktop_preferences (
        id TEXT PRIMARY KEY,
        feature_flags_json TEXT
      );
      INSERT INTO desktop_preferences (id, feature_flags_json)
      VALUES ('desktop', '{}');`
    ]);
    await enableAgentSessionRecordingFeature(databasePath, workspaceRoot);
    const result = await execFileAsync("sqlite3", [
      databasePath,
      `SELECT json_extract(feature_flags_json, '$."agent.sessionRecording"')
       FROM desktop_preferences WHERE id = 'desktop';`
    ]);
    assert.equal(result.stdout.trim(), "1");
  } finally {
    await rm(databasePath, { force: true });
  }
});

test("resolves a project placement from portable expected Session state", () => {
  const project = resolveReplayProjectFromExpectedState(
    {
      agent: {
        sessions: [
          {
            id: "root-a",
            railSectionKey: "project:${REPLAY_CWD}/packages/agent"
          }
        ]
      }
    },
    "root-a",
    workspaceRoot
  );
  assert.deepEqual(project, {
    id: `replay-project-${createHash("sha256")
      .update(join(workspaceRoot, "packages/agent"))
      .digest("hex")
      .slice(0, 16)}`,
    label: "agent",
    path: join(workspaceRoot, "packages/agent"),
    portablePath: "${REPLAY_CWD}/packages/agent"
  });
  assert.equal(
    resolveReplayProjectFromExpectedState(
      {
        agent: {
          sessions: [{ id: "root-a", railSectionKey: "conversations" }]
        }
      },
      "root-a",
      workspaceRoot
    ),
    null
  );
  assert.throws(
    () =>
      resolveReplayProjectFromExpectedState(
        {
          agent: {
            sessions: [
              { id: "root-a", railSectionKey: "project:/recording/root" }
            ]
          }
        },
        "root-a",
        workspaceRoot
      ),
    /not portable/u
  );
});

test("Replay Workspace does not create a runtime when any cassette is invalid", async () => {
  let runtimeCreates = 0;
  await assert.rejects(
    bootstrapReplayWorkspace(
      {
        playbackMode: "automatic",
        workspaceId: "workspace-a",
        cassettes: [
          {
            cassetteId: replayCassetteAID,
            cassetteDirectory: ".tmp/cassette-a",
            rootAgentSessionId: "root-a"
          },
          {
            cassetteId: replayCassetteBID,
            cassetteDirectory: ".tmp/cassette-b",
            rootAgentSessionId: "root-b"
          }
        ]
      },
      {
        async loadCassette(cassette) {
          if (cassette.cassetteId === replayCassetteBID) {
            throw new Error("tampered cassette");
          }
          return cassette;
        },
        async createRuntime() {
          runtimeCreates += 1;
          return {};
        }
      }
    ),
    /tampered cassette/u
  );
  assert.equal(runtimeCreates, 0);
});

test("Replay Workspace verifies every Cassette through its cassette-scoped endpoint", async () => {
  const calls = [];
  const results = await verifyReplayWorkspaceTransports(
    "/runtime/state",
    [{ cassetteId: replayCassetteAID }, { cassetteId: replayCassetteBID }],
    1234,
    async (stateDirectory, cassetteId, timeoutMs) => {
      calls.push({ stateDirectory, cassetteId, timeoutMs });
      if (cassetteId === replayCassetteAID) throw new Error("leftover frame");
    }
  );
  assert.deepEqual(calls, [
    {
      stateDirectory: "/runtime/state",
      cassetteId: replayCassetteAID,
      timeoutMs: 1234
    },
    {
      stateDirectory: "/runtime/state",
      cassetteId: replayCassetteBID,
      timeoutMs: 1234
    }
  ]);
  assert.deepEqual(results, [
    {
      cassetteId: replayCassetteAID,
      verified: false,
      error: "leftover frame"
    },
    { cassetteId: replayCassetteBID, verified: true }
  ]);
});

test("non-managed Replay Workspace propagates Cassette failures", () => {
  assert.throws(
    () =>
      assertReplayWorkspaceSucceeded(
        [
          { cassetteId: replayCassetteAID, succeeded: true },
          { cassetteId: replayCassetteBID, succeeded: false }
        ],
        false
      ),
    new RegExp(replayCassetteBID, "u")
  );
  assert.doesNotThrow(() =>
    assertReplayWorkspaceSucceeded(
      [{ cassetteId: replayCassetteBID, succeeded: false }],
      true
    )
  );
});

test("non-managed Replay Workspace preserves the first Cassette root cause", () => {
  const rootCause = new Error("first cassette failed");
  assert.throws(
    () =>
      assertReplayWorkspaceSucceeded(
        [
          {
            cassetteId: replayCassetteAID,
            error: rootCause,
            succeeded: false
          },
          { cassetteId: replayCassetteBID, succeeded: false }
        ],
        false
      ),
    (error) => error === rootCause
  );
});

test("Replay Workspace bootstrap calls the renderer bridge once with all Cassettes", async () => {
  const evaluations = [];
  const snapshot = { ready: false, cassettes: [] };
  const result = await bootstrapRendererReplayWorkspace(
    {
      async send(method, parameters) {
        evaluations.push({ method, parameters });
        return { result: { value: snapshot } };
      }
    },
    [
      {
        action: { agentTargetId: "local:codex" },
        cassetteId: replayCassetteAID,
        rootAgentSessionId: "root-a",
        mode: "create-session",
        ignored: true
      },
      {
        action: { agentTargetId: "local:claude-code" },
        cassetteId: replayCassetteBID,
        rootAgentSessionId: "root-b",
        mode: "continue-session",
        ignored: true
      }
    ],
    2_000
  );
  assert.equal(result, snapshot);
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].method, "Runtime.evaluate");
  assert.match(
    evaluations[0].parameters.expression,
    /__tuttiAgentSessionReplayWorkspace/u
  );
  assert.match(
    evaluations[0].parameters.expression,
    new RegExp(replayCassetteAID, "u")
  );
  assert.match(evaluations[0].parameters.expression, /local:codex/u);
  assert.match(
    evaluations[0].parameters.expression,
    new RegExp(replayCassetteBID, "u")
  );
  assert.match(evaluations[0].parameters.expression, /create-session/u);
  assert.match(evaluations[0].parameters.expression, /continue-session/u);
  assert.doesNotMatch(evaluations[0].parameters.expression, /ignored/u);
});

test("Replay Workspace reactivates a created Session before continuing", async () => {
  const evaluations = [];
  await activateRendererReplayWorkspaceCassette(
    {
      async send(method, parameters) {
        evaluations.push({ method, parameters });
        if (evaluations.length === 1) {
          return { result: { value: { ready: false } } };
        }
        return {
          result: {
            value: {
              ready: true,
              cassette: { cassetteId: replayCassetteAID, ready: true }
            }
          }
        };
      }
    },
    replayCassetteAID,
    2_000
  );
  assert.match(evaluations[0].parameters.expression, /\.activate\(/u);
  assert.equal(evaluations.length, 2);
});

test("Replay runner never reloads the page when a Session is created", async () => {
  const source = await readFile(
    new URL("./run-agent-session-replay.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /Page\.reload/u);
});

test("managed replacement accepts a stable target checkpoint", () => {
  const options = parseArgs([
    "--replay",
    ".tmp/cassette",
    "--managed",
    "--cassette-id",
    "cassette-2",
    "--target-checkpoint",
    "3"
  ]);
  assert.equal(options.targetCheckpoint, 3);
  assert.throws(
    () => parseArgs(["--replay", ".tmp/cassette", "--target-checkpoint", "-1"]),
    /non-negative integer/u
  );
});

test("Replay duration includes provider frames and later activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-duration-"));
  const providerDirectory = dirname(
    join(root, cassettePolicy.files.providerManifest.path)
  );
  await mkdir(providerDirectory, { recursive: true });
  await writeFile(
    join(providerDirectory, "frames.jsonl"),
    [
      JSON.stringify({ elapsedMs: 1_000 }),
      JSON.stringify({ elapsedMs: 8_000 })
    ].join("\n")
  );

  assert.equal(
    await readReplayTotalDurationMs(root, 10_000, [
      { occurredAtUnixMs: 11_000 },
      { occurredAtUnixMs: 19_500 }
    ]),
    9_500
  );
});

test("does not accept a source user database", () => {
  assert.throws(
    () =>
      parseArgs([
        "--replay",
        ".tmp/cassettes/replay",
        "--source-db",
        "/Users/example/.tutti/tuttid.db"
      ]),
    /unknown option/u
  );
});

test("action validation accepts create and continue Session scenarios", () => {
  assert.doesNotThrow(() =>
    validateAction({
      schemaVersion: 1,
      type: "create-session",
      agentTargetId: "local:codex",
      prompts: ["one", "two", "three"]
    })
  );
  assert.doesNotThrow(() =>
    validateAction({
      schemaVersion: 1,
      type: "continue-session",
      agentTargetId: "local:codex",
      prompts: ["next"]
    })
  );
  assert.throws(
    () =>
      validateAction({
        schemaVersion: 1,
        type: "new-session-submit",
        agentTargetId: "local:codex",
        prompts: ["old"]
      }),
    /invalid or unsupported/u
  );
});

test("materializes verified content-addressed attachment blobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-blobs-"));
  const cassette = join(root, "cassette");
  const state = join(root, "state");
  const data = Buffer.from("attachment bytes");
  const digest = createHash("sha256").update(data).digest("hex");
  await mkdir(join(cassette, "blobs", "sha256"), { recursive: true });
  await writeFile(join(cassette, "blobs", "sha256", digest), data);
  await writeFile(
    join(cassette, "blobs", "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      blobs: [
        {
          kind: "agent-prompt-attachment",
          sha256: digest,
          sizeBytes: data.byteLength,
          agentSessionId: "session-1",
          attachmentId: "attachment-1",
          mimeType: "image/png"
        }
      ]
    })
  );
  await materializeReplayWorkspaceBlobs(
    [{ cassetteDirectory: cassette }],
    state
  );
  assert.deepEqual(
    await readFile(
      join(state, "agent", "attachments", "session-1", "attachment-1.png")
    ),
    data
  );
});

test("materializes verified generated image blobs into Codex home", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-generated-image-"));
  const cassette = join(root, "cassette");
  const state = join(root, "state");
  const data = Buffer.from("generated image bytes");
  const digest = createHash("sha256").update(data).digest("hex");
  await mkdir(join(cassette, "blobs", "sha256"), { recursive: true });
  await writeFile(join(cassette, "blobs", "sha256", digest), data);
  await writeFile(
    join(cassette, "blobs", "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      blobs: [
        {
          kind: "agent-generated-image",
          sha256: digest,
          sizeBytes: data.byteLength,
          agentSessionId: "session-1",
          relativePath: "generated_images/call-1/image.png",
          mimeType: "image/png"
        }
      ]
    })
  );
  await materializeReplayWorkspaceBlobs(
    [{ cassetteDirectory: cassette }],
    state
  );
  assert.deepEqual(
    await readFile(
      join(
        state,
        "agent",
        "runs",
        "session-1",
        "codex-home",
        "generated_images",
        "call-1",
        "image.png"
      )
    ),
    data
  );
});

test("Replay Workspace rejects conflicting blobs before materialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-blob-conflict-"));
  const state = join(root, "state");
  const cassettes = [];
  for (const [name, contents] of [
    ["cassette-a", "one"],
    ["cassette-b", "two"]
  ]) {
    const cassette = join(root, name);
    const digest = createHash("sha256").update(contents).digest("hex");
    await mkdir(join(cassette, "blobs", "sha256"), { recursive: true });
    await writeFile(join(cassette, "blobs", "sha256", digest), contents);
    await writeFile(
      join(cassette, "blobs", "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        blobs: [
          {
            kind: "agent-prompt-attachment",
            sha256: digest,
            sizeBytes: contents.length,
            agentSessionId: "session-a",
            attachmentId: "attachment-a",
            mimeType: "image/png"
          }
        ]
      })
    );
    cassettes.push({ cassetteDirectory: cassette });
  }
  await assert.rejects(
    materializeReplayWorkspaceBlobs(cassettes, state),
    /conflicting Replay Workspace blob target/u
  );
  await assert.rejects(
    readFile(
      join(state, "agent", "attachments", "session-a", "attachment-a.png")
    )
  );
});

test("rejects a tampered attachment blob", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-blob-tamper-"));
  const cassette = join(root, "cassette");
  const data = Buffer.from("expected bytes");
  const digest = createHash("sha256").update(data).digest("hex");
  await mkdir(join(cassette, "blobs", "sha256"), { recursive: true });
  await writeFile(
    join(cassette, "blobs", "sha256", digest),
    Buffer.from("tampered")
  );
  await writeFile(
    join(cassette, "blobs", "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      blobs: [
        {
          kind: "agent-prompt-attachment",
          sha256: digest,
          sizeBytes: data.byteLength,
          agentSessionId: "session-1",
          attachmentId: "attachment-1",
          mimeType: "image/png"
        }
      ]
    })
  );
  await assert.rejects(
    materializeReplayWorkspaceBlobs(
      [{ cassetteDirectory: cassette }],
      join(root, "state")
    ),
    /integrity mismatch/u
  );
});

test("ignores Finder metadata and rejects other unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-inventory-"));
  const cassette = join(root, "cassette");
  await writeValidCassette(cassette);
  await assert.doesNotReject(verifyCassette(cassette));
  await writeFile(join(cassette, ".DS_Store"), "finder metadata");
  await assert.doesNotReject(verifyCassette(cassette));
  await writeFile(join(cassette, "debug.log"), "unrelated");
  await assert.rejects(verifyCassette(cassette), /unrelated file/u);
});

test("rejects a cassette file integrity mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-integrity-"));
  const cassette = join(root, "cassette");
  await writeValidCassette(cassette);
  await writeFile(
    join(cassette, cassettePolicy.files.expectedState.path),
    "tampered"
  );
  await assert.rejects(verifyCassette(cassette), /integrity mismatch/u);
});

async function writeValidCassette(cassette) {
  const contents = new Map();
  for (const file of Object.values(cassettePolicy.files)) {
    if (!file.required || file.inventory === false) continue;
    contents.set(
      file.path,
      file.path === cassettePolicy.files.blobManifest.path
        ? JSON.stringify({
            schemaVersion: cassettePolicy.blobManifestSchemaVersion,
            blobs: []
          })
        : ""
    );
  }
  const files = [];
  let totalBytes = 0;
  for (const [path, content] of contents) {
    const absolute = join(cassette, ...path.split("/"));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    const bytes = Buffer.from(content);
    const policyFile = Object.values(cassettePolicy.files).find(
      (candidate) => candidate.path === path
    );
    files.push({
      path,
      role: policyFile.role,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
    totalBytes += bytes.byteLength;
  }
  await writeFile(
    join(cassette, cassettePolicy.files.cassetteManifest.path),
    JSON.stringify({
      schemaVersion: cassettePolicy.schemaVersion,
      stateFormat: "tutti.agent-session-replay-state.v1",
      id: replayCassetteAID,
      name: "Valid Cassette",
      sourceRecordingId: replayCassetteBID,
      agentTargetId: "local:codex",
      replayPrerequisites: replayPrerequisitesForTest(),
      rootAgentSessionId: "root-a",
      mode: "create-session",
      maxTotalBytes: cassettePolicy.limits.maxCassetteBytes,
      createdAtUnixMs: 1,
      totalBytes,
      files
    })
  );
}

test("maps API-origin direct stimuli while Engine events stay renderer-owned", () => {
  const base = {
    workspaceId: "workspace 1",
    agentSessionId: "session/1"
  };
  const cases = [
    [
      {
        ...base,
        type: "session.create",
        payload: { agentTargetId: "local:codex", content: [] }
      },
      "/v1/workspaces/workspace%201/agent-sessions",
      "session/1"
    ],
    [
      { ...base, type: "session.send", payload: { guidance: "steer" } },
      "/v1/workspaces/workspace%201/agent-sessions/session%2F1/input",
      undefined
    ],
    [
      { ...base, type: "turn.cancel", payload: { turnId: "turn/1" } },
      "/turns/turn%2F1/cancel",
      undefined
    ],
    [
      {
        ...base,
        type: "interactive.response",
        payload: { requestId: "request/1", turnId: "turn-1", action: "yes" }
      },
      "/interactives/request%2F1/response",
      "turn-1"
    ],
    [
      {
        ...base,
        type: "plan.decision",
        payload: {
          turnId: "turn-1",
          requestId: "request-1",
          promptKind: "plan-implementation",
          action: "implement",
          idempotencyKey: "decision-1"
        }
      },
      "/plan-decisions/request-1",
      "plan-implementation"
    ],
    [
      {
        ...base,
        type: "goal.control",
        payload: {
          action: "set",
          clientSubmitId: "goal-submit-1",
          objective: "ship"
        }
      },
      "/goal",
      "goal-submit-1"
    ],
    [
      {
        ...base,
        type: "session.settings.update",
        payload: { settings: { planMode: true } }
      },
      "/settings",
      true
    ]
  ];
  for (const [stimulus, pathSuffix, bodyValue] of cases) {
    const request = replayStimulusRequest(stimulus);
    assert.ok(request.path.includes(pathSuffix), stimulus.type);
    if (bodyValue !== undefined) {
      assert.ok(
        JSON.stringify(request.body).includes(JSON.stringify(bodyValue)),
        stimulus.type
      );
    }
  }
  assert.equal(
    replayStimulusRequest({ ...base, type: "internal.worker" }),
    null
  );
  for (const type of [
    "activation/requested",
    "interaction/responseRequested",
    "plan/decisionRequested",
    "session/cancelRequested",
    "session/settingsUpdateRequested"
  ]) {
    assert.equal(replayStimulusRequest({ ...base, type }), null, type);
  }
});

test("injects the transient Replay Workspace at the product event boundary", () => {
  const manifest = {
    schemaVersion: cassettePolicy.schemaVersion,
    mode: "create-session",
    agentTargetId: "local:codex",
    replayPrerequisites: replayPrerequisitesForTest(),
    rootAgentSessionId: "session-1"
  };
  const sourceWorkspaceId = "11111111-1111-4111-8111-111111111111";
  const replayWorkspaceId = "22222222-2222-4222-8222-222222222222";
  const action = replayActionFromManifest(
    manifest,
    [
      {
        schemaVersion: cassettePolicy.schemaVersion,
        sequence: 1,
        kind: "direct-stimulus",
        type: "session.create",
        eventId: "create-1",
        agentSessionId: "session-1",
        payload: { displayPrompt: sourceWorkspaceId }
      }
    ],
    replayWorkspaceId
  );
  assert.equal(action.workspaceId, replayWorkspaceId);
  assert.equal(action.activityEvents[0].scopeId, replayWorkspaceId);
  assert.equal(action.activityEvents[0].workspaceId, replayWorkspaceId);
  assert.equal(
    action.activityEvents[0].payload.displayPrompt,
    sourceWorkspaceId
  );
  assert.deepEqual(
    action.activityEvents[0].payload.settings,
    manifest.replayPrerequisites.composerDefaults
  );
});

test("resolves portable recording paths for Engine activation", () => {
  const manifest = {
    schemaVersion: cassettePolicy.schemaVersion,
    mode: "create-session",
    agentTargetId: "local:codex",
    replayPrerequisites: replayPrerequisitesForTest(),
    rootAgentSessionId: "session-1"
  };
  const action = replayActionFromManifest(
    manifest,
    [
      {
        schemaVersion: cassettePolicy.schemaVersion,
        sequence: 1,
        kind: "intent",
        type: "activation/requested",
        eventId: "create-1",
        agentSessionId: "session-1",
        payload: {
          cwd: "${REPLAY_CWD}",
          displayPrompt: "keep ${REPLAY_CWD} as user text",
          settings: { planMode: true },
          railPlacement: {
            projectPath: "${REPLAY_CWD}/packages/agent",
            sectionKey: "project:${REPLAY_CWD}/packages/agent"
          },
          railSectionKey: "project:${REPLAY_CWD}/packages/agent"
        }
      }
    ],
    "22222222-2222-4222-8222-222222222222"
  );
  const payload = action.activityEvents[0].payload;
  const replayProjectRoot = resolveAgentSessionReplayProjectRoot();
  const agentPackagePath = join(replayProjectRoot, "packages", "agent");
  assert.equal(payload.cwd, replayProjectRoot);
  assert.equal(payload.cwd.startsWith(`${workspaceRoot}/`), false);
  assert.notEqual(payload.cwd, workspaceRoot);
  assert.equal(payload.railPlacement.projectPath, agentPackagePath);
  assert.equal(payload.railPlacement.sectionKey.startsWith("project:"), true);
  assert.equal(payload.railPlacement.sectionKey, `project:${agentPackagePath}`);
  assert.equal(
    payload.railPlacement.sectionKey.includes("${REPLAY_CWD}"),
    false
  );
  assert.equal(payload.railSectionKey, payload.railPlacement.sectionKey);
  assert.equal(payload.displayPrompt, "keep ${REPLAY_CWD} as user text");
  assert.deepEqual(payload.settings, {
    ...manifest.replayPrerequisites.composerDefaults,
    planMode: true
  });
});

test("materializes portable Composer defaults into creation intent and effect", () => {
  const manifest = {
    schemaVersion: cassettePolicy.schemaVersion,
    mode: "create-session",
    agentTargetId: "local:codex",
    replayPrerequisites: replayPrerequisitesForTest(),
    rootAgentSessionId: "session-1"
  };
  const action = replayActionFromManifest(
    manifest,
    [
      {
        schemaVersion: cassettePolicy.schemaVersion,
        sequence: 1,
        kind: "intent",
        type: "activation/requested",
        eventId: "create-1",
        agentSessionId: "session-1",
        payload: { cwd: "", settings: {} }
      },
      {
        schemaVersion: cassettePolicy.schemaVersion,
        sequence: 2,
        kind: "effect",
        type: "session/activate",
        eventId: "create-2",
        causedByEventId: "create-1",
        agentSessionId: "session-1",
        payload: { cwd: "", settings: {} }
      }
    ],
    "22222222-2222-4222-8222-222222222222"
  );
  for (const event of action.activityEvents) {
    assert.deepEqual(
      event.payload.settings,
      manifest.replayPrerequisites.composerDefaults
    );
  }
});

test("does not apply create-session Composer defaults while continuing a Session", () => {
  const action = replayActionFromManifest(
    {
      schemaVersion: cassettePolicy.schemaVersion,
      mode: "continue-session",
      agentTargetId: "local:codex",
      replayPrerequisites: replayPrerequisitesForTest(),
      rootAgentSessionId: "session-1"
    },
    [
      {
        schemaVersion: cassettePolicy.schemaVersion,
        sequence: 1,
        kind: "intent",
        type: "activation/requested",
        eventId: "activate-1",
        agentSessionId: "session-1",
        payload: { cwd: "", settings: {} }
      }
    ],
    "22222222-2222-4222-8222-222222222222"
  );
  assert.deepEqual(action.activityEvents[0].payload.settings, {});
});

test("PROJECT_ROOT remaps portable REPLAY_CWD outside Tutti checkout", () => {
  const previous = process.env.TUTTI_AGENT_SESSION_REPLAY_PROJECT_ROOT;
  const externalRoot = resolve(tmpdir(), "tutti.sessionrec-unit-test");
  try {
    delete process.env.TUTTI_AGENT_SESSION_REPLAY_PROJECT_ROOT;
    const defaultRoot = resolveAgentSessionReplayProjectRoot();
    assert.equal(
      defaultRoot.startsWith(join(tmpdir(), "tutti-agent-session-rec")),
      true
    );
    assert.equal(defaultRoot.startsWith(`${workspaceRoot}/`), false);
    assert.notEqual(defaultRoot, workspaceRoot);
    process.env.TUTTI_AGENT_SESSION_REPLAY_PROJECT_ROOT = externalRoot;
    assert.equal(resolveAgentSessionReplayProjectRoot(), externalRoot);
    const project = resolveRecordScenarioProject(
      { label: "sessionrec", relativePath: "." },
      resolveAgentSessionReplayProjectRoot()
    );
    assert.equal(project.path, externalRoot);
    assert.equal(project.portablePath, "${REPLAY_CWD}");
    assert.equal(project.path.startsWith(workspaceRoot + "/"), false);
    assert.throws(() => {
      process.env.TUTTI_AGENT_SESSION_REPLAY_PROJECT_ROOT = "relative/path";
      resolveAgentSessionReplayProjectRoot();
    }, /must be an absolute path/u);
    process.env.TUTTI_AGENT_SESSION_REPLAY_PROJECT_ROOT = externalRoot;
    const action = replayActionFromManifest(
      {
        schemaVersion: cassettePolicy.schemaVersion,
        mode: "create-session",
        agentTargetId: "local:codex",
        replayPrerequisites: replayPrerequisitesForTest(),
        rootAgentSessionId: "session-1"
      },
      [
        {
          schemaVersion: cassettePolicy.schemaVersion,
          sequence: 1,
          kind: "intent",
          type: "activation/requested",
          eventId: "create-1",
          agentSessionId: "session-1",
          payload: {
            cwd: "${REPLAY_CWD}",
            railPlacement: {
              projectPath: "${REPLAY_CWD}",
              sectionKey: "project:${REPLAY_CWD}"
            },
            railSectionKey: "project:${REPLAY_CWD}"
          }
        }
      ],
      "22222222-2222-4222-8222-222222222222"
    );
    assert.equal(action.activityEvents[0].payload.cwd, externalRoot);
    assert.equal(
      action.activityEvents[0].payload.railPlacement.projectPath,
      externalRoot
    );
  } finally {
    if (previous === undefined) {
      delete process.env.TUTTI_AGENT_SESSION_REPLAY_PROJECT_ROOT;
    } else {
      process.env.TUTTI_AGENT_SESSION_REPLAY_PROJECT_ROOT = previous;
    }
  }
});

test("P01 selects an in-cwd project and requires portable binding artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-project-binding-"));
  const canonicalRoot = realpathSync(root);
  const project = resolveRecordScenarioProject(
    { label: basename(canonicalRoot), relativePath: "." },
    root
  );
  assert.equal(project.path, canonicalRoot);
  assert.equal(project.label, basename(canonicalRoot));
  assert.equal(project.portablePath, "${REPLAY_CWD}");
  assert.throws(
    () =>
      resolveRecordScenarioProject(
        { label: "Outside", relativePath: ".." },
        root
      ),
    /must be inside replay cwd/u
  );
  const databasePath = join(root, "project-seed.db");
  await execFileAsync("sqlite3", [
    databasePath,
    `CREATE TABLE user_projects (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      created_at_unix_ms INTEGER NOT NULL,
      updated_at_unix_ms INTEGER NOT NULL,
      last_used_at_unix_ms INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      pinned_at_unix_ms INTEGER NOT NULL DEFAULT 0
    );`
  ]);
  await seedRecordingUserProject(databasePath, project);
  const seeded = await execFileAsync("sqlite3", [
    databasePath,
    "SELECT path || '|' || label FROM user_projects;"
  ]);
  assert.equal(
    seeded.stdout.trim(),
    `${canonicalRoot}|${basename(canonicalRoot)}`
  );

  await writeFile(
    join(root, cassettePolicy.files.activityEvents.path),
    `${JSON.stringify({
      agentSessionId: "session-1",
      correlationId: "request-1",
      eventId: "intent-1",
      kind: "intent",
      occurredAtUnixMs: 1,
      payload: {
        cwd: "${REPLAY_CWD}",
        mode: "new",
        railPlacement: {
          kind: "project",
          projectPath: "${REPLAY_CWD}",
          sectionKey: "project:${REPLAY_CWD}"
        },
        requestId: "request-1"
      },
      schemaVersion: cassettePolicy.schemaVersion,
      sequence: 1,
      type: "activation/requested"
    })}\n${JSON.stringify({
      agentSessionId: "session-1",
      causedByEventId: "intent-1",
      correlationId: "request-1",
      eventId: "effect-1",
      kind: "effect",
      occurredAtUnixMs: 2,
      payload: {
        cwd: "${REPLAY_CWD}",
        mode: "new",
        outcome: "succeeded",
        railPlacement: {
          kind: "project",
          projectPath: "${REPLAY_CWD}",
          sectionKey: "project:${REPLAY_CWD}"
        }
      },
      schemaVersion: cassettePolicy.schemaVersion,
      sequence: 2,
      type: "session/activate"
    })}\n`
  );
  await writeFile(
    join(root, cassettePolicy.files.checkpointPlan.path),
    JSON.stringify({
      checkpoints: [
        {
          kind: "project.binding-ready",
          readiness: {
            all: [
              {
                equals: "recorded",
                subject: 0,
                type: "project.binding"
              }
            ]
          }
        }
      ],
      schemaVersion: cassettePolicy.schemaVersion
    })
  );

  await verifyRecordedProjectBindingArtifacts(root, "${REPLAY_CWD}");
});

test("P03 accepts a portable project binding restored from initial state", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "agent-replay-continued-project-binding-")
  );
  await writeFile(
    join(root, cassettePolicy.files.activityEvents.path),
    `${JSON.stringify({
      agentSessionId: "session-1",
      correlationId: "request-1",
      eventId: "intent-1",
      kind: "intent",
      occurredAtUnixMs: 1,
      payload: { content: [{ text: "follow up", type: "text" }] },
      schemaVersion: cassettePolicy.schemaVersion,
      sequence: 1,
      type: "submit/requested"
    })}\n`
  );
  await writeFile(
    join(root, cassettePolicy.files.initialState.path),
    JSON.stringify({
      agent: {
        sessions: [
          {
            cwd: "${REPLAY_CWD}",
            id: "session-1",
            railProjectPath: "${REPLAY_CWD}",
            railSectionKey: "project:${REPLAY_CWD}"
          }
        ]
      }
    })
  );
  await writeFile(
    join(root, cassettePolicy.files.expectedState.path),
    JSON.stringify({
      agent: {
        sessions: [
          {
            cwd: "${REPLAY_CWD}",
            id: "session-1",
            railProjectPath: "${REPLAY_CWD}",
            railSectionKey: "project:${REPLAY_CWD}"
          }
        ]
      }
    })
  );
  await verifyRecordedProjectBindingArtifacts(root, "${REPLAY_CWD}");

  await writeFile(
    join(root, cassettePolicy.files.expectedState.path),
    JSON.stringify({
      agent: {
        sessions: [
          {
            cwd: "${REPLAY_CWD}",
            id: "session-1",
            railProjectPath: null,
            railSectionKey: "conversations"
          }
        ]
      }
    })
  );
  await assert.rejects(
    verifyRecordedProjectBindingArtifacts(root, "${REPLAY_CWD}"),
    /did not preserve portable project binding/u
  );
});

function execFileAsync(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(
          new Error(`${command} failed: ${stderr || error.message}`)
        );
        return;
      }
      resolvePromise({ stderr, stdout });
    });
  });
}

function replayPrerequisitesForTest() {
  return {
    composerDefaults: {
      model: "gpt-5.4",
      permissionModeId: "default",
      reasoningEffort: "medium",
      speed: "normal"
    }
  };
}

test("replayTransportHardFailureMessage classifies hard outbound faults", () => {
  assert.equal(
    replayTransportHardFailureMessage(
      409,
      "connection connection-1 outbound mismatch at chunk 64"
    ),
    "connection connection-1 outbound mismatch at chunk 64"
  );
  assert.equal(
    replayTransportHardFailureMessage(
      409,
      "connection connection-1 received unexpected outbound bytes after cassette end"
    ),
    "connection connection-1 received unexpected outbound bytes after cassette end"
  );
  assert.equal(
    replayTransportHardFailureMessage(
      409,
      "connection connection-1 consumed 64 of 131 chunks"
    ),
    ""
  );
  assert.equal(replayTransportHardFailureMessage(500, "outbound mismatch"), "");
  assert.equal(replayTransportHardFailureMessage(409, ""), "");
});
