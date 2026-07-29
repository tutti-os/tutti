import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertNoDuplicateEngineSends,
  cassettePolicy,
  createRendererActivityDriver,
  createReplayActivityClock,
  createReplayPlaybackController,
  mapReplaySessionIdentities,
  mapReplayTurnIdentitiesBySessionOrder,
  materializeCassetteBlobs,
  normalizeReplayFixtureRecord,
  parseActivityEvents,
  parseArgs,
  parseReplayCheckpoints,
  replayActionFromScenario,
  replayStimuli,
  replayStimulusPrecondition,
  replayStimulusRetryableStatus,
  replayStimulusRequest,
  replayUserProjectPaths,
  replayWorkbenchSnapshot,
  validateAction,
  verifyCassette
} from "./run-agent-session-replay.mjs";

test("ignores runtime-discovered Session fields during final verification", () => {
  const stable = {
    agent_session_id: "session-1",
    model: "gpt-5.6-terra",
    settings_json: JSON.stringify({
      model: "gpt-5.6-terra",
      reasoningEffort: "high"
    })
  };
  const expected = normalizeReplayFixtureRecord("workspace_agent_sessions", {
    ...stable,
    internal_runtime_context_json: JSON.stringify({
      sessionRuntimeSnapshot: {
        effectiveConfig: { reasoningEffort: "high" }
      }
    }),
    session_metadata_json: JSON.stringify({
      capabilities: ["browserUse"],
      imported: false,
      usage: { contextWindow: { usedTokens: 20_321 } },
      visible: true
    })
  });
  const actual = normalizeReplayFixtureRecord("workspace_agent_sessions", {
    ...stable,
    internal_runtime_context_json: JSON.stringify({
      sessionRuntimeSnapshot: {
        effectiveConfig: {
          planMode: false,
          reasoningEffort: "high",
          speed: "standard"
        }
      }
    }),
    session_metadata_json: JSON.stringify({
      capabilities: [],
      imported: false,
      usage: { contextWindow: { usedTokens: 19_868 } },
      visible: true
    })
  });

  assert.deepEqual(actual, expected);
  assert.equal(actual.model, "gpt-5.6-terra");
  assert.deepEqual(actual.session_metadata_json, {
    imported: false,
    visible: true
  });
});

test("still compares durable Session settings", () => {
  const expected = normalizeReplayFixtureRecord("workspace_agent_sessions", {
    model: "gpt-5.6-terra",
    settings_json: JSON.stringify({ reasoningEffort: "high" })
  });
  const actual = normalizeReplayFixtureRecord("workspace_agent_sessions", {
    model: "gpt-5.6-sol",
    settings_json: JSON.stringify({ reasoningEffort: "low" })
  });

  assert.notDeepEqual(actual, expected);
});

test("maps replay-generated child Session and Turn identities", () => {
  const identityMap = new Map([["recorded-root", "replayed-root"]]);
  const expectedSessions = [
    {
      agent_session_id: "recorded-root",
      agent_target_id: "local:codex",
      provider: "codex",
      provider_session_id: "provider-root",
      session_kind: "root"
    },
    {
      agent_session_id: "recorded-child",
      agent_target_id: "local:codex",
      parent_agent_session_id: "recorded-root",
      provider: "codex",
      provider_session_id: "provider-child",
      session_kind: "child"
    }
  ];
  const actualSessions = [
    {
      agent_session_id: "replayed-root",
      agent_target_id: "local:codex",
      provider: "codex",
      provider_session_id: "provider-root",
      session_kind: "root"
    },
    {
      agent_session_id: "replayed-child",
      agent_target_id: "local:codex",
      parent_agent_session_id: "replayed-root",
      provider: "codex",
      provider_session_id: "provider-child",
      session_kind: "child"
    }
  ];

  mapReplaySessionIdentities(expectedSessions, actualSessions, identityMap);
  mapReplayTurnIdentitiesBySessionOrder(
    [
      {
        agent_session_id: "recorded-child",
        turn_id: "recorded-child-turn"
      }
    ],
    [
      {
        agent_session_id: "replayed-child",
        turn_id: "replayed-child-turn"
      }
    ],
    identityMap
  );

  assert.equal(identityMap.get("recorded-child"), "replayed-child");
  assert.equal(identityMap.get("recorded-child-turn"), "replayed-child-turn");
  assert.deepEqual(
    normalizeReplayFixtureRecord(
      "workspace_agent_sessions",
      expectedSessions[1],
      identityMap
    ),
    normalizeReplayFixtureRecord("workspace_agent_sessions", actualSessions[1])
  );
});

test("does not guess an ambiguous replay child Session identity", () => {
  const identityMap = new Map();
  const expected = {
    agent_session_id: "recorded-child",
    agent_target_id: "local:codex",
    provider: "codex",
    provider_session_id: "provider-child",
    session_kind: "child"
  };
  mapReplaySessionIdentities(
    [expected],
    [
      { ...expected, agent_session_id: "replayed-child-1" },
      { ...expected, agent_session_id: "replayed-child-2" }
    ],
    identityMap
  );
  assert.equal(identityMap.has("recorded-child"), false);
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
    true
  );
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
    if (
      request.method === "GET" &&
      request.url === "/v1/agent-session-replay/transport/playback"
    ) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          drained: false,
          paused: false,
          playbackElapsedMs: 0,
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
            type: "session.create",
            payload: { agentTargetId: "local:codex", content: [] }
          },
          {
            ...base,
            kind: "direct-stimulus",
            sequence: 2,
            occurredAtUnixMs: 1,
            type: "session.send",
            payload: { content: [{ type: "text", text: "second" }] }
          },
          {
            ...base,
            kind: "direct-stimulus",
            sequence: 3,
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
            afterActivityEventSequence: 0
          },
          {
            schemaVersion: cassettePolicy.schemaVersion,
            index: 1,
            kind: "after-activity-event",
            afterActivityEventSequence: 3
          }
        ],
        onStimulusAccepted(stimulus) {
          accepted.push(stimulus.type);
        }
      }
    );
    assert.equal(sent.length, 2);
    assert.deepEqual(accepted, [
      "session.create",
      "session.send",
      "session.send"
    ]);
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
    if (
      request.method === "GET" &&
      request.url === "/v1/agent-session-replay/transport/playback"
    ) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          drained: false,
          paused: false,
          playbackElapsedMs: Date.now() - playbackStartedAt,
          speed: 1,
          timingMode: "realtime"
        })
      );
      return;
    }
    requests.push(request.method);
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
            afterActivityEventSequence: 0
          },
          {
            schemaVersion: cassettePolicy.schemaVersion,
            index: 1,
            kind: "after-activity-event",
            afterActivityEventSequence: 2
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
        }
      }
    );
    assert.deepEqual(calls, [
      "intent:queue/sendNowRequested",
      "effect:succeeded"
    ]);
    assert.ok(callTimes[1] - callTimes[0] >= 60);
    assert.deepEqual(requests, ["GET"]);
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
  }
});

test("renderer activity driver calls the replay bridge through CDP", async () => {
  const evaluations = [];
  const driver = createRendererActivityDriver(
    {
      async send(method, parameters) {
        evaluations.push({ method, parameters });
        return { result: { value: { accepted: true } } };
      }
    },
    2_000
  );
  const intent = {
    kind: "intent",
    type: "submit/requested",
    eventId: "intent-1",
    payload: { content: [] }
  };
  const effect = {
    kind: "effect",
    type: "session.send",
    eventId: "effect-1",
    causedByEventId: "intent-1",
    payload: { outcome: "succeeded" }
  };
  await driver.dispatchIntent(intent);
  await driver.verifyEffect(effect);
  assert.deepEqual(
    evaluations.map(({ method, parameters }) => ({
      method,
      awaitPromise: parameters.awaitPromise,
      returnByValue: parameters.returnByValue,
      calls: parameters.expression.includes("dispatchIntent")
        ? "dispatchIntent"
        : "verifyEffect"
    })),
    [
      {
        method: "Runtime.evaluate",
        awaitPromise: true,
        returnByValue: true,
        calls: "dispatchIntent"
      },
      {
        method: "Runtime.evaluate",
        awaitPromise: true,
        returnByValue: true,
        calls: "verifyEffect"
      }
    ]
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
    scopeId: "workspace-1",
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

test("validates stable replay checkpoints against stimulus sequences", () => {
  const activityEvents = [{ sequence: 1 }, { sequence: 3 }];
  const contents = [
    {
      schemaVersion: cassettePolicy.schemaVersion,
      index: 0,
      kind: "bootstrap",
      afterActivityEventSequence: 0
    },
    {
      schemaVersion: cassettePolicy.schemaVersion,
      index: 1,
      kind: "after-activity-event",
      afterActivityEventSequence: 3
    }
  ]
    .map(JSON.stringify)
    .join("\n");
  assert.equal(parseReplayCheckpoints(contents, activityEvents).length, 2);
  assert.throws(
    () =>
      parseReplayCheckpoints(
        contents.replace(
          '"afterActivityEventSequence":3',
          '"afterActivityEventSequence":2'
        ),
        activityEvents
      ),
    /invalid stimulus/u
  );
});

test("next checkpoint fast-forwards without skipping the stable boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-control-"));
  const controlPath = join(root, "replay-control.json");
  const statusPath = join(root, "replay-status.json");
  const commands = [];
  const transportPlayback = {
    drained: false,
    paused: false,
    playbackElapsedMs: 0,
    speed: 1,
    timingMode: "realtime"
  };
  const server = createServer(async (request, response) => {
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
        afterActivityEventSequence: 0
      },
      {
        schemaVersion: cassettePolicy.schemaVersion,
        index: 1,
        kind: "after-activity-event",
        afterActivityEventSequence: 2
      }
    ];
    await writeFile(
      controlPath,
      JSON.stringify({ schemaVersion: 1, revision: 0, command: "resume" })
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
      statusPath,
      timeoutMs: 2_000
    });
    await playback.initialize();
    await writeFile(
      controlPath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        command: "next-checkpoint"
      })
    );
    await playback.waitUntilRunnable();
    assert.equal(playback.checkpointAfter(2).index, 1);
    await playback.reach(checkpoints[1]);
    assert.deepEqual(reached, [1]);
    assert.deepEqual(commands, [
      { command: "set-timing-mode", timingMode: "fast-forward" },
      { command: "resume" },
      { command: "set-timing-mode", timingMode: "realtime" },
      { command: "pause" }
    ]);
    assert.deepEqual(JSON.parse(await readFile(statusPath, "utf8")), {
      currentCheckpoint: 1,
      totalCheckpoints: 2,
      paused: true,
      timingMode: "realtime",
      targetCheckpoint: null
    });

    await writeFile(
      controlPath,
      JSON.stringify({ schemaVersion: 1, revision: 2, command: "resume" })
    );
    await playback.waitUntilRunnable();
    assert.deepEqual(commands.at(-1), { command: "resume" });

    let slowOperationSettled = false;
    const controlSlowOperation = (async () => {
      await delay(20);
      await writeFile(
        controlPath,
        JSON.stringify({ schemaVersion: 1, revision: 3, command: "pause" })
      );
      await delay(70);
      assert.equal(slowOperationSettled, false);
      assert.deepEqual(commands.at(-1), { command: "pause" });
      await writeFile(
        controlPath,
        JSON.stringify({ schemaVersion: 1, revision: 4, command: "resume" })
      );
    })();
    await Promise.all([
      playback
        .runWhilePolling(() => delay(160))
        .finally(() => {
          slowOperationSettled = true;
        }),
      controlSlowOperation
    ]);
    assert.deepEqual(commands.slice(-2), [
      { command: "pause" },
      { command: "resume" }
    ]);

    await writeFile(
      controlPath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 5,
        command: "switch-cassette",
        cassetteId: "cassette-2"
      })
    );
    await assert.rejects(
      playback.waitForReplacement(() => true),
      /Replay Run replacement requested/u
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

test("record arguments default to headed mode", () => {
  const options = parseArgs([
    "--record",
    ".tmp/cassettes/example",
    "--timeout-ms",
    "1234"
  ]);
  assert.equal(options.mode, "record");
  assert.equal(options.headless, undefined);
  assert.equal(options.timeoutMs, 1234);
  assert.match(
    options.cassetteDirectory,
    /[/\\]\.tmp[/\\]cassettes[/\\]example$/u
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

test("managed replay requires the daemon-owned Replay Run id", () => {
  assert.throws(
    () => parseArgs(["--replay", ".tmp/cassette", "--managed"]),
    /--run-id is required/u
  );
});

test("managed replacement accepts a stable target checkpoint", () => {
  const options = parseArgs([
    "--replay",
    ".tmp/cassette",
    "--managed",
    "--run-id",
    "run-2",
    "--target-checkpoint",
    "3"
  ]);
  assert.equal(options.targetCheckpoint, 3);
  assert.throws(
    () => parseArgs(["--replay", ".tmp/cassette", "--target-checkpoint", "-1"]),
    /non-negative integer/u
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
  await materializeCassetteBlobs(cassette, state);
  assert.deepEqual(
    await readFile(
      join(state, "agent", "attachments", "session-1", "attachment-1.png")
    ),
    data
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
    materializeCassetteBlobs(cassette, join(root, "state")),
    /integrity mismatch/u
  );
});

test("verifies cassette inventory and rejects unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-inventory-"));
  const cassette = join(root, "cassette");
  await writeValidCassette(cassette);
  await assert.doesNotReject(verifyCassette(cassette));
  await writeFile(join(cassette, "debug.log"), "unrelated");
  await assert.rejects(verifyCassette(cassette), /unrelated file/u);
});

test("rejects a cassette file integrity mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-replay-integrity-"));
  const cassette = join(root, "cassette");
  await writeValidCassette(cassette);
  await writeFile(join(cassette, "scenario.json"), "tampered");
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
      maxTotalBytes: cassettePolicy.limits.maxCassetteBytes,
      totalBytes,
      files
    })
  );
}

test("maps every supported external stimulus to its daemon request", () => {
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
        payload: { action: "set", objective: "ship" }
      },
      "/goal",
      "set"
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
  const create = replayStimulusRequest(cases[0][0]);
  assert.deepEqual(create.body.initialContent, []);
  assert.equal(create.body.content, undefined);
  assert.equal(
    replayStimulusRequest({ ...base, type: "internal.worker" }),
    null
  );
});

test("maps portable Scope identity to the Tutti Workspace adapter", () => {
  const scenario = {
    schemaVersion: 1,
    mode: "create-session",
    scopeId: "workspace-1",
    workspaceId: "workspace-1",
    agentTargetId: "local:codex",
    rootAgentSessionId: "session-1"
  };
  const action = replayActionFromScenario(scenario, [
    {
      schemaVersion: cassettePolicy.schemaVersion,
      sequence: 1,
      kind: "direct-stimulus",
      type: "session.create",
      eventId: "create-1",
      scopeId: "workspace-1",
      agentSessionId: "session-1",
      payload: { displayPrompt: "hello" }
    }
  ]);
  assert.equal(action.workspaceId, "workspace-1");
  assert.equal(action.activityEvents[0].workspaceId, "workspace-1");
});

test("seeds replay User Projects from recorded create-session placement", () => {
  assert.deepEqual(
    replayUserProjectPaths({
      activityEvents: [
        {
          payload: {
            cwd: "/workspace/project",
            railPlacement: {
              kind: "project",
              projectPath: "/workspace/project"
            }
          }
        },
        {
          payload: {
            cwd: " /workspace/other "
          }
        }
      ]
    }),
    ["/workspace/project", "/workspace/other"]
  );
});
