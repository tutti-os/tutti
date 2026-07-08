import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionRuntime, withSidecarEventSinkForTest } from "./main.ts";
import { sidecarClaudeOptionsFromPayload } from "./options.ts";

// Shared fixture shape with the Go dispatch test at
// packages/agent/daemon/runtime/claude_sdk_turn_protocol_fixture_test.go.
// Both sides read the same JSON so the sidecar's emitted turnOrigin values
// and the daemon's dispatch routing decisions stay pinned to one source of
// truth instead of two hand-written, driftable tables.
type TurnProtocolFixture = {
  description: string;
  trackedTurnId: string;
  terminalEvent: {
    type: string;
    payload: Record<string, unknown>;
  };
  expectDispatch: "complete_waiter" | "drop_terminal" | "publish";
};

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "turn-protocol"
);

const fixtures = readdirSync(fixtureDir)
  .filter((name) => name.endsWith(".json"))
  .map(
    (name) =>
      JSON.parse(
        readFileSync(path.join(fixtureDir, name), "utf8")
      ) as TurnProtocolFixture
  );

const knownTurnOrigins = new Set([
  "exec_echo",
  "synthetic",
  "queued",
  "delegated"
]);

test("turn protocol fixtures declare a known turnOrigin", () => {
  for (const fixture of fixtures) {
    const origin = fixture.terminalEvent.payload.turnOrigin;
    if (origin !== undefined) {
      assert.ok(
        knownTurnOrigins.has(String(origin)),
        `${fixture.description}: unknown turnOrigin ${String(origin)}`
      );
    }
  }
});

// The "exec echo" fixture is driven for real: a controller-style exec() call
// through the sidecar's testDriver echo path must emit turn_completed with
// exactly the turnId and turnOrigin the fixture (and the Go-side dispatch
// test) expect.
test("exec echo fixture: sidecar emits turnOrigin exec_echo for its own turn_completed", async () => {
  const fixture = fixtures.find((candidate) =>
    candidate.description.startsWith("Controller exec turn terminal echoed")
  );
  assert.ok(fixture, "exec-echo-terminal fixture not found");

  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-1",
      "/repo",
      {},
      false,
      true,
      {
        model: "",
        permissionModeId: "default",
        planMode: false,
        effort: "",
        speed: ""
      },
      sidecarClaudeOptionsFromPayload({})
    );

    session.exec(fixture.trackedTurnId, "hello");

    const completed = events.find((event) => event.type === "turn_completed");
    assert.equal(
      completed?.payload?.turnId,
      fixture.terminalEvent.payload.turnId
    );
    assert.equal(
      completed?.payload?.turnOrigin,
      fixture.terminalEvent.payload.turnOrigin
    );
  } finally {
    restoreSink();
  }
});
