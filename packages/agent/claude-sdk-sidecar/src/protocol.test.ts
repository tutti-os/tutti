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

test("sidecar protocol rejects missing and unknown versions", () => {
  assert.throws(
    () => parseClaudeSDKSidecarRequest({ type: "exec" }),
    /protocol version missing/
  );
  assert.throws(
    () => parseClaudeSDKSidecarRequest({ version: 2, type: "exec" }),
    /protocol version 2/
  );
});

test("sidecar events always carry the current version", () => {
  assert.deepEqual(versionedClaudeSDKSidecarEvent({ type: "ok" }), {
    version: CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION,
    type: "ok"
  });
});
