import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentSessionEngine,
  EngineIntent
} from "@tutti-os/agent-activity-core";
import type { AgentSessionActivityEvent } from "./agentSessionActivityEventRecorder.ts";
import {
  installAgentSessionActivityReplayDriver,
  type AgentSessionActivityReplayDriver
} from "./agentSessionActivityReplayDriver.ts";

test("installs globally and dispatches a reconstructed engine intent", () => {
  const intents: EngineIntent[] = [];
  const driver = installDriver(intents);

  driver.dispatchIntent(
    activityEvent({
      agentSessionId: "session-1",
      correlationId: "submit-1",
      kind: "intent",
      payload: {
        clientSubmitId: "submit-1",
        content: [{ text: "continue", type: "text" }],
        requestedAtUnixMs: 100
      },
      type: "submit/requested"
    })
  );

  assert.equal(
    (
      globalThis as typeof globalThis & {
        __tuttiAgentSessionReplayDriver?: AgentSessionActivityReplayDriver;
      }
    ).__tuttiAgentSessionReplayDriver,
    driver
  );
  assert.deepEqual(intents, [
    {
      agentSessionId: "session-1",
      clientSubmitId: "submit-1",
      content: [{ text: "continue", type: "text" }],
      requestedAtUnixMs: 100,
      type: "submit/requested",
      workspaceId: "workspace-1"
    }
  ]);
  driver.dispose();
});

test("rejects the wrong event kind, scope, and reserved payload fields", () => {
  const driver = installDriver([]);

  assert.throws(
    () =>
      driver.dispatchIntent(
        activityEvent({
          kind: "effect",
          payload: {},
          type: "submit/requested"
        })
      ),
    /kind mismatch: expected intent, got effect/
  );
  assert.throws(
    () =>
      driver.dispatchIntent(
        activityEvent({
          kind: "intent",
          payload: {},
          scopeId: "workspace-2",
          type: "submit/requested"
        })
      ),
    /scope mismatch: expected workspace-1, got workspace-2/
  );
  assert.throws(
    () =>
      driver.dispatchIntent(
        activityEvent({
          kind: "intent",
          payload: { workspaceId: "workspace-2" },
          type: "submit/requested"
        })
      ),
    /payload must not contain workspaceId/
  );
  driver.dispose();
});

test("verifies a command result observed before its effect event", async () => {
  const driver = installDriver([]);
  driver.observeIntent(
    commandResult({
      commandType: "queue/sendPrompt",
      correlationId: "submit-1",
      outcome: "succeeded"
    })
  );

  await driver.verifyEffect(
    activityEvent({
      correlationId: "submit-1",
      kind: "effect",
      payload: { outcome: "succeeded" },
      type: "queue/sendPrompt"
    })
  );
  driver.dispose();
});

test("waits for a matching command result and ignores other correlations", async () => {
  const driver = installDriver([]);
  const verification = driver.verifyEffect(
    activityEvent({
      correlationId: "submit-2",
      kind: "effect",
      payload: { outcome: "failed", errorCode: "turn_busy" },
      type: "queue/sendPrompt"
    })
  );
  driver.observeIntent(
    commandResult({
      commandType: "queue/sendPrompt",
      correlationId: "submit-1",
      outcome: "succeeded"
    })
  );
  driver.observeIntent(
    commandResult({
      commandType: "queue/sendPrompt",
      correlationId: "submit-2",
      errorCode: "turn_busy",
      outcome: "failed"
    })
  );

  await verification;
  driver.dispose();
});

test("reports outcome and error detail mismatches", async () => {
  const driver = installDriver([]);
  driver.observeIntent(
    commandResult({
      commandType: "queue/sendPrompt",
      correlationId: "submit-1",
      errorCode: "actual_code",
      errorReason: "actual_reason",
      outcome: "failed"
    })
  );

  await assert.rejects(
    driver.verifyEffect(
      activityEvent({
        correlationId: "submit-1",
        kind: "effect",
        payload: {
          errorCode: "expected_code",
          errorReason: "expected_reason",
          outcome: "succeeded"
        },
        type: "queue/sendPrompt"
      })
    ),
    (error: Error) => {
      assert.match(error.message, /outcome expected "succeeded" got "failed"/);
      assert.match(
        error.message,
        /errorCode expected "expected_code" got "actual_code"/
      );
      assert.match(
        error.message,
        /errorReason expected "expected_reason" got "actual_reason"/
      );
      return true;
    }
  );
  driver.dispose();
});

test("rejects malformed expected effect fields before waiting", () => {
  const driver = installDriver([]);

  assert.throws(
    () =>
      driver.verifyEffect(
        activityEvent({
          kind: "effect",
          payload: { errorCode: 42, outcome: "succeeded" },
          type: "queue/sendPrompt"
        })
      ),
    /invalid errorCode/
  );
  driver.dispose();
});

test("times out an effect that the engine never reports", async () => {
  const driver = installDriver([], 5);

  await assert.rejects(
    driver.verifyEffect(
      activityEvent({
        correlationId: "submit-1",
        kind: "effect",
        payload: { outcome: "succeeded" },
        type: "queue/sendPrompt"
      })
    ),
    /timed out waiting for renderer effect queue\/sendPrompt \(submit-1\)/
  );
  driver.dispose();
});

test("dispose rejects waiters and removes only its own global driver", async () => {
  const driver = installDriver([]);
  const verification = driver.verifyEffect(
    activityEvent({
      kind: "effect",
      payload: { outcome: "succeeded" },
      type: "turn/cancel"
    })
  );

  driver.dispose();

  await assert.rejects(verification, /replay driver was disposed/);
  assert.equal(
    (
      globalThis as typeof globalThis & {
        __tuttiAgentSessionReplayDriver?: AgentSessionActivityReplayDriver;
      }
    ).__tuttiAgentSessionReplayDriver,
    undefined
  );
});

function installDriver(
  intents: EngineIntent[],
  effectTimeoutMs = 100
): AgentSessionActivityReplayDriver {
  const engine = {
    dispatch(intent) {
      intents.push(intent);
    },
    identity: { origin: "test", workspaceId: "workspace-1" }
  } satisfies Pick<AgentSessionEngine, "dispatch" | "identity">;
  return installAgentSessionActivityReplayDriver({
    effectTimeoutMs,
    engine
  });
}

function activityEvent(
  overrides: Partial<AgentSessionActivityEvent> &
    Pick<AgentSessionActivityEvent, "kind" | "payload" | "type">
): AgentSessionActivityEvent {
  return {
    eventId: "event-1",
    occurredAtUnixMs: 100,
    schemaVersion: 3,
    scopeId: "workspace-1",
    sequence: 1,
    ...overrides
  };
}

function commandResult(
  overrides: Partial<Extract<EngineIntent, { type: "engine/commandResult" }>> &
    Pick<
      Extract<EngineIntent, { type: "engine/commandResult" }>,
      "commandType" | "outcome"
    >
): Extract<EngineIntent, { type: "engine/commandResult" }> {
  return {
    commandId: "command-1",
    type: "engine/commandResult",
    ...overrides
  };
}
