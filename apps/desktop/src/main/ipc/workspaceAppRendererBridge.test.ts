import assert from "node:assert/strict";
import test from "node:test";
import { isWorkspaceAppExternalRendererResponse } from "./workspaceAppRendererBridge.ts";

test("workspace app renderer responses must match the active request id", () => {
  assert.equal(
    isWorkspaceAppExternalRendererResponse(
      {
        requestId: "request-1",
        result: { data: { ok: true }, ok: true }
      },
      "request-1"
    ),
    true
  );
  assert.equal(
    isWorkspaceAppExternalRendererResponse(
      {
        requestId: "request-2",
        result: { data: { ok: true }, ok: true }
      },
      "request-1"
    ),
    false
  );
});

test("workspace app renderer responses validate success and error envelopes", () => {
  assert.equal(
    isWorkspaceAppExternalRendererResponse(
      {
        requestId: "request-1",
        result: { error: { message: "failed" }, ok: false }
      },
      "request-1"
    ),
    true
  );
  assert.equal(
    isWorkspaceAppExternalRendererResponse(
      {
        requestId: "request-1",
        result: { error: {}, ok: false }
      },
      "request-1"
    ),
    false
  );
});
