import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import {
  assertNoDuplicateEngineSends,
  assertReplayTransportHealthy,
  bindManagedReplayShutdown,
  CAMEL_REPLAY_TRANSPORT_COMMANDS,
  checkpointNeedsToolSettle,
  compareProviderPosition,
  configureReplayWaitDiagnostics,
  createReplayActivityClock,
  createReplayProductPorts,
  createSerialAsyncQueue,
  encodeCamelTimingModeValue,
  encodeKebabTimingModeValue,
  KEBAB_REPLAY_TRANSPORT_COMMANDS,
  loadCassettePolicy,
  loadReplayCheckpointPlan,
  managedReplayFailure,
  managedReplayReadyPrefix,
  normalizePlaybackStateDeriveTimingMode,
  normalizePlaybackStateRequireTimingMode,
  normalizeScreenshotClip,
  pollUntilReady,
  providerConnectionsReached,
  replayActivityTurnIsFresh,
  replayAgentSessionPath,
  replayCheckpointScreenshotPath,
  replayControlRouter,
  replayObservedHydrationError,
  replayObservedTurnId,
  replayPendingInteractionForIdentity,
  replaySessionTerminalFailure,
  replayStimulusPrecondition,
  replayStimulusRequest,
  replayStimulusRetryableStatus,
  requiredReplayRegistrations,
  resolveRecordScenarioProject,
  screenshotEvidenceLabel,
  submitRequestedRequiresSessionIdle,
  validateReplayCheckpointPlan
} from "./index.mjs";

const cassettePolicyPath = fileURLToPath(
  new URL("../../session-replay/cassette-policy.json", import.meta.url)
);

test("createSerialAsyncQueue serializes tasks", async () => {
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

test("loadCassettePolicy reads Tutti shared policy", async () => {
  const policy = await loadCassettePolicy(cassettePolicyPath);
  assert.equal(typeof policy.schemaVersion, "number");
  assert.equal(policy.files.checkpointPlan.path, "checkpoint-plan.json");
});

test("validateReplayCheckpointPlan requires injected schema version", () => {
  assert.throws(
    () => validateReplayCheckpointPlan({ schemaVersion: 2 }, []),
    /cassetteSchemaVersion option is required/
  );
});

test("validateReplayCheckpointPlan accepts portable v2 plan", async () => {
  const policy = await loadCassettePolicy(cassettePolicyPath);
  const checkpoints = validateReplayCheckpointPlan(
    {
      schemaVersion: 2,
      cassetteSchemaVersion: policy.schemaVersion,
      observationSchemaVersion: 2,
      checkpoints: [
        {
          id: "checkpoint-0000",
          index: 0,
          kind: "replay.bootstrap",
          tags: ["replay.bootstrap"],
          cursor: { activityEventSequence: 0, providerConnections: [] },
          trigger: { source: "bootstrap" }
        }
      ]
    },
    [],
    { cassetteSchemaVersion: policy.schemaVersion }
  );
  assert.equal(checkpoints.length, 1);
});

test("loadReplayCheckpointPlan reads file from cassette directory", async () => {
  const policy = await loadCassettePolicy(cassettePolicyPath);
  const root = await mkdtemp(join(tmpdir(), "asr-runner-checkpoint-"));
  await writeFile(
    join(root, "checkpoint-plan.json"),
    JSON.stringify({
      schemaVersion: 2,
      cassetteSchemaVersion: policy.schemaVersion,
      observationSchemaVersion: 2,
      checkpoints: [
        {
          id: "checkpoint-0000",
          index: 0,
          kind: "replay.bootstrap",
          tags: ["replay.bootstrap"],
          cursor: { activityEventSequence: 0, providerConnections: [] },
          trigger: { source: "bootstrap" }
        }
      ]
    })
  );
  const checkpoints = await loadReplayCheckpointPlan(root, [], {
    cassetteSchemaVersion: policy.schemaVersion
  });
  assert.equal(checkpoints[0].id, "checkpoint-0000");
});

test("replayStimulusPrecondition and duplicate send guard", () => {
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
  assert.throws(
    () =>
      assertNoDuplicateEngineSends([
        { kind: "intent", correlationId: "c1" },
        {
          kind: "direct-stimulus",
          type: "session.send",
          correlationId: "c1"
        }
      ]),
    /duplicates renderer intent correlation/
  );
});

test("managed prefixes and control router", () => {
  assert.match(managedReplayReadyPrefix, /ready/);
  assert.deepEqual(replayControlRouter("cass-1", 3, "pause"), {
    schemaVersion: 2,
    cassettes: { "cass-1": { command: "pause", revision: 3 } }
  });
});

test("resolveRecordScenarioProject builds portable binding", () => {
  const root = join(tmpdir(), "asr-record-root");
  const project = resolveRecordScenarioProject(
    { relativePath: "demo", label: "Demo" },
    root,
    { portableReplayCWDToken: "${REPLAY_CWD}" }
  );
  assert.equal(project.label, "Demo");
  assert.equal(project.portablePath, "${REPLAY_CWD}/demo");
  assert.match(project.id, /^replay-project-[0-9a-f]{16}$/);
});

test("provider cursor math and activity clock", async () => {
  assert.equal(
    compareProviderPosition(
      { chunkSeq: 1, unitIndex: 2 },
      { chunkSeq: 1, unitIndex: 5 }
    ),
    -3
  );
  assert.equal(
    providerConnectionsReached(
      {
        id: "checkpoint-0001",
        cursor: {
          providerConnections: [
            { connectionId: "c1", chunkSeq: 1, unitIndex: 0 }
          ]
        }
      },
      {
        providerConnections: [{ connectionId: "c1", chunkSeq: 1, unitIndex: 0 }]
      }
    ),
    true
  );

  let playback = {
    paused: false,
    playbackElapsedMs: 0,
    speed: 1,
    timingMode: "realtime"
  };
  const waits = [];
  const clock = createReplayActivityClock({
    playbackState: async () => playback,
    wait: async (durationMs) => {
      waits.push(durationMs);
      playback = {
        ...playback,
        playbackElapsedMs:
          playback.playbackElapsedMs + durationMs * playback.speed
      };
    }
  });
  await clock.waitUntil(1_000);
  playback = { ...playback, playbackElapsedMs: 20 };
  await clock.waitUntil(1_100);
  assert.equal(
    waits.reduce((total, duration) => total + duration, 0),
    80
  );

  playback = {
    paused: false,
    playbackElapsedMs: 0,
    speed: 1,
    timingMode: "realtime"
  };
  const sharedOriginWaits = [];
  const sharedOriginClock = createReplayActivityClock({
    originOccurredAtUnixMs: 900,
    playbackState: async () => playback,
    wait: async (durationMs) => {
      sharedOriginWaits.push(durationMs);
      playback = {
        ...playback,
        playbackElapsedMs: playback.playbackElapsedMs + durationMs
      };
    }
  });
  await sharedOriginClock.waitUntil(1_000);
  assert.equal(
    sharedOriginWaits.reduce((total, duration) => total + duration, 0),
    100
  );
});

test("submit idle gate and managed failure routing", () => {
  assert.equal(
    submitRequestedRequiresSessionIdle(
      {
        kind: "intent",
        type: "submit/requested",
        eventId: "e1",
        payload: { submitDiagnostics: { queued: true } }
      },
      []
    ),
    false
  );
  assert.equal(replayStimulusRetryableStatus("session.send", 409), true);
  assert.equal(managedReplayFailure("cass-1", new Error("boom")).error, "boom");
  assert.equal(
    replayObservedTurnId({
      activeTurnId: null,
      turnLifecycle: { activeTurnId: "turn-tsh" }
    }),
    "turn-tsh"
  );
});

test("pollUntilReady stall policy", async () => {
  configureReplayWaitDiagnostics({
    stallTimeoutMs: 30,
    progressIntervalMs: 1_000,
    log: null
  });
  let polls = 0;
  await assert.rejects(
    () =>
      pollUntilReady({
        label: "unit",
        timeoutMs: 200,
        intervalMs: 10,
        delay: async () => {},
        poll: async () => {
          polls += 1;
          return { ready: false, n: 1 };
        }
      }),
    /stalled waiting for unit/
  );
  assert.ok(polls >= 1);
  configureReplayWaitDiagnostics({ stallTimeoutMs: 60_000 });
});

test("replayCheckpointScreenshotPath nests optional cassette scope", () => {
  assert.equal(
    replayCheckpointScreenshotPath({
      artifactDirectory: "/tmp/out",
      cassetteId: "cass-1",
      checkpointIndex: 0,
      checkpoints: [{ id: "checkpoint-ready" }]
    }),
    join("/tmp/out", "cass-1", "checkpoint-ready.png")
  );
  assert.match(
    replayCheckpointScreenshotPath({
      artifactDirectory: "/tmp/out",
      checkpointIndex: 3,
      checkpoints: []
    }),
    /checkpoint-0003\.png$/
  );
});

test("evidence helpers: clip, label, settle", () => {
  assert.equal(normalizeScreenshotClip(null), null);
  assert.equal(
    normalizeScreenshotClip({ x: 0, y: 0, width: 4, height: 100 }),
    null
  );
  assert.deepEqual(
    normalizeScreenshotClip({ x: 10.9, y: 20.1, width: 300.7, height: 400.2 }),
    { x: 10, y: 20, width: 300, height: 400, scale: 1 }
  );
  assert.equal(
    screenshotEvidenceLabel({ caseId: "C03", scenario: "c03" }),
    "C03"
  );
  assert.equal(
    checkpointNeedsToolSettle({ kind: "tool.completed", tags: [] }),
    true
  );
});

test("replayStimulusRequest scopes workspaces vs rooms", () => {
  const stimulus = {
    type: "session.send",
    workspaceId: "ws-1",
    agentSessionId: "sess-1",
    payload: { content: "hi" }
  };
  assert.equal(
    replayStimulusRequest(stimulus).path,
    "/v1/workspaces/ws-1/agent-sessions/sess-1/input"
  );
  assert.equal(
    replayStimulusRequest(stimulus, { workspaceScopeSegment: "rooms" }).path,
    "/v1/rooms/ws-1/agent-sessions/sess-1/input"
  );
});

test("hydration / registration / turn freshness helpers", () => {
  assert.equal(
    replayObservedHydrationError({
      cassettes: [{ hydrationError: " boom " }]
    }),
    "boom"
  );
  assert.equal(
    replaySessionTerminalFailure({
      turnLifecycle: { outcome: "failed", phase: "working" }
    }),
    "turnLifecycle outcome is failed (working)"
  );
  requiredReplayRegistrations([
    {
      cassetteId: "c1",
      rootAgentSessionId: "s1",
      cassetteDirectory: "/tmp/c1"
    }
  ]);
  assert.throws(() => requiredReplayRegistrations([]), /required/);
  assert.equal(
    replayActivityTurnIsFresh(
      { turnId: "t2", startedAtUnixMs: 200 },
      { turnIds: new Set(["t1"]), capturedAtUnixMs: 100 },
      "t1"
    ),
    true
  );
  assert.equal(
    replayPendingInteractionForIdentity(
      {
        pendingInteractions: [
          { status: "pending", requestId: "r1", turnId: "t9" }
        ]
      },
      "r1",
      "t9"
    )?.requestId,
    "r1"
  );
});

test("bindManagedReplayShutdown requires stopDesktop and cleans listeners", async () => {
  const runtime = new EventEmitter();
  runtime.stdout = new EventEmitter();
  runtime.stderr = new EventEmitter();
  let stopCount = 0;
  assert.throws(() => bindManagedReplayShutdown({}), /requires stopDesktop/);
  const dispose = bindManagedReplayShutdown(
    {},
    {
      clearInterval() {},
      isProcessAlive: () => false,
      parentPid: "123",
      processRuntime: runtime,
      setInterval() {
        return { unref() {} };
      },
      async stopDesktop() {
        stopCount += 1;
      }
    }
  );
  runtime.stdout.emit(
    "error",
    Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
  );
  await Promise.resolve();
  assert.equal(stopCount, 1);
  dispose();
  assert.equal(runtime.listenerCount("SIGINT"), 0);
});

test("assertReplayTransportHealthy fails closed on non-OK", async () => {
  await assert.rejects(
    () =>
      assertReplayTransportHealthy("cass-1", {
        baseURL: "http://127.0.0.1:9",
        fetchImpl: async () => ({
          ok: false,
          status: 503,
          text: async () => "down"
        })
      }),
    /replay transport failed with 503/
  );
});

test("ReplayProductPorts encode dialect without product names", () => {
  assert.equal(
    replayAgentSessionPath({
      workspaceScopeSegment: "workspaces",
      workspaceId: "w1",
      agentSessionId: "s1"
    }),
    "/v1/workspaces/w1/agent-sessions/s1"
  );
  assert.equal(
    replayAgentSessionPath({
      workspaceScopeSegment: "rooms",
      workspaceId: "w1",
      agentSessionId: "s1",
      stateSuffix: true
    }),
    "/v1/rooms/w1/agent-sessions/s1/state"
  );
  assert.equal(encodeKebabTimingModeValue("fast-forward"), "fast-forward");
  assert.equal(encodeCamelTimingModeValue("fast-forward"), "fastForward");
  assert.equal(
    KEBAB_REPLAY_TRANSPORT_COMMANDS.setTimingMode,
    "set-timing-mode"
  );
  assert.equal(CAMEL_REPLAY_TRANSPORT_COMMANDS.setTimingMode, "setTimingMode");
  const ports = createReplayProductPorts({
    workspaceScopeSegment: "rooms",
    transportCommands: CAMEL_REPLAY_TRANSPORT_COMMANDS,
    encodeTimingModeValue: encodeCamelTimingModeValue,
    normalizePlaybackState: normalizePlaybackStateDeriveTimingMode,
    sessionObservation: "lean-activity",
    agentSessionStateSuffix: true,
    watchSessionsDuringPlayback: true
  });
  assert.equal(ports.workspaceScopeSegment, "rooms");
  assert.equal(ports.sessionObservation, "lean-activity");
  assert.deepEqual(
    normalizePlaybackStateDeriveTimingMode({
      paused: false,
      playbackElapsedMs: 0,
      speed: 1,
      fastForward: true,
      providerConnections: []
    }).timingMode,
    "fast-forward"
  );
  assert.throws(
    () =>
      normalizePlaybackStateRequireTimingMode({
        paused: false,
        playbackElapsedMs: 0,
        speed: 1,
        providerConnections: []
      }),
    /replay playback state is invalid/
  );
});
