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
