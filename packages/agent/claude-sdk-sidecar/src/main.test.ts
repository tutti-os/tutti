import assert from "node:assert/strict";
import test from "node:test";
import { withSidecarEventSinkForTest } from "./eventSink.ts";
import { handleRequest, withSidecarSessionForTest } from "./main.ts";
import { sidecarClaudeOptionsFromPayload } from "./options.ts";
import { CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION } from "./protocol.ts";
import { SessionRuntime } from "./sessionRuntime.ts";
import { fakeSimpleResultQuery } from "./sessionRuntimeTestQueries.delegated.ts";
import { waitForEvent } from "./sessionRuntimeTestQueries.nested.ts";

test("real exec ACK followed by immediate clear converges without a phantom Turn", async () => {
  const events: Array<{
    id?: string;
    type: string;
    payload?: Record<string, unknown>;
  }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  const session = new SessionRuntime(
    "provider-session-goal-protocol",
    "/repo",
    {},
    false,
    false,
    {
      model: "",
      permissionModeId: "default",
      planMode: false,
      effort: "",
      speed: ""
    },
    sidecarClaudeOptionsFromPayload({}),
    undefined,
    ({ prompt }) => fakeSimpleResultQuery(prompt)
  );
  const restoreSession = withSidecarSessionForTest("session-goal", session);
  try {
    await session.start();
    await handleRequest({
      version: CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION,
      id: "request-set",
      type: "exec",
      payload: {
        agentSessionId: "session-goal",
        turnId: "goal-set-turn",
        prompt: "/goal ship it",
        turnOrigin: "goal_arm",
        goalOperationId: "goal-op-set",
        goalRevision: 1,
        goalAction: "set"
      }
    });
    assert.equal(
      events.some((event) => event.id === "request-set" && event.type === "ok"),
      true
    );
    assert.equal(
      events.some((event) => event.type === "goal_command_started"),
      false,
      "the scheduling ACK must precede provider activation"
    );

    await handleRequest({
      version: CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION,
      id: "request-clear",
      type: "exec",
      payload: {
        agentSessionId: "session-goal",
        turnId: "goal-clear-turn",
        prompt: "/goal clear",
        goalOperationId: "goal-op-clear",
        goalRevision: 2,
        goalAction: "clear"
      }
    });
    assert.equal(
      events.some(
        (event) => event.id === "request-clear" && event.type === "ok"
      ),
      true
    );

    await waitForEvent(events, "goal_command_started");
    await waitForEvent(events, "turn_completed");

    assert.equal(
      events.some(
        (event) =>
          event.type === "turn_started" &&
          event.payload?.turnId === "goal-set-turn"
      ),
      false
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "goal_command_superseded" &&
          event.payload?.operationId === "goal-op-set"
      ),
      true
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "goal_command_started" &&
          event.payload?.operationId === "goal-op-clear" &&
          event.payload?.revision === 2
      ),
      true
    );
    assert.equal(session.activeTurnId, "");
  } finally {
    restoreSession();
    await session.close();
    restoreSink();
  }
});
