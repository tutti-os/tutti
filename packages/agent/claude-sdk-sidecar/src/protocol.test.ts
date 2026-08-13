import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION,
  parseClaudeSDKSidecarRequest,
  versionedClaudeSDKSidecarEvent
} from "./protocol.ts";

test("sidecar protocol accepts the current version", () => {
  assert.deepEqual(
    parseClaudeSDKSidecarRequest({
      version: CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION,
      id: "request-1",
      type: "exec",
      payload: { turnId: "turn-1" }
    }),
    {
      version: CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION,
      id: "request-1",
      type: "exec",
      payload: { turnId: "turn-1" }
    }
  );
});

test("sidecar protocol accepts stop_task requests", () => {
  assert.equal(
    parseClaudeSDKSidecarRequest({
      version: CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION,
      type: "stop_task",
      payload: { agentSessionId: "session-1", taskId: "task-1" }
    }).type,
    "stop_task"
  );
});

test("sidecar protocol requires bounded cancellation phases", () => {
  const request = parseClaudeSDKSidecarRequest({
    version: CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION,
    type: "cancel",
    payload: {
      agentSessionId: "session-1",
      turnId: "turn-1",
      interruptTimeoutMs: 10_000,
      drainTimeoutMs: 8_000
    }
  });
  assert.equal(request.type, "cancel");

  assert.throws(
    () =>
      parseClaudeSDKSidecarRequest({
        version: CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION,
        type: "cancel",
        payload: { interruptTimeoutMs: 10_000 }
      }),
    /cancel drainTimeoutMs must be a positive integer/
  );
});

test("sidecar protocol accepts stateless session fork requests", () => {
  for (const type of [
    "inspect_fork_checkpoints",
    "recover_turn_binding",
    "fork_session"
  ] as const) {
    assert.equal(
      parseClaudeSDKSidecarRequest({
        version: CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION,
        type,
        payload: { providerSessionId: "provider-session-1" }
      }).type,
      type
    );
  }
});

test("sidecar protocol rejects missing and unknown versions", () => {
  assert.throws(
    () => parseClaudeSDKSidecarRequest({ type: "exec" }),
    /protocol version missing/
  );
  assert.throws(
    () => parseClaudeSDKSidecarRequest({ version: 1, type: "exec" }),
    /protocol version 1/
  );
});

test("sidecar events always carry the current version", () => {
  assert.deepEqual(versionedClaudeSDKSidecarEvent({ type: "ok" }), {
    version: CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION,
    type: "ok"
  });
});
