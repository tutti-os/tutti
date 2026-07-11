import assert from "node:assert/strict";
import test from "node:test";
import {
  TuttidProtocolError,
  workspaceProtocolErrorCodes
} from "@tutti-os/client-tuttid-ts";
import { toDesktopIpcResult } from "./result.ts";
import { DesktopApiError } from "../../shared/desktopApiError.ts";

test("toDesktopIpcResult preserves protocol error details for renderer i18n", async () => {
  const result = await toDesktopIpcResult(async () => {
    throw new TuttidProtocolError({
      code: workspaceProtocolErrorCodes.workspaceNotFound,
      correlationId: "corr-1",
      developerMessage: "workspace not found",
      params: { workspaceId: "ws-missing" },
      reason: "workspace_not_found",
      retryable: true,
      statusCode: 404
    });
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: workspaceProtocolErrorCodes.workspaceNotFound,
      message: "workspace not found",
      reason: "workspace_not_found",
      params: { workspaceId: "ws-missing" },
      retryable: true,
      developerMessage: "workspace not found",
      correlationId: "corr-1"
    }
  });
});

test("toDesktopIpcResult preserves non-protocol errors as plain desktop errors", async () => {
  const result = await toDesktopIpcResult(async () => {
    throw new Error("plain failure");
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "transport_request_failed",
      message: "plain failure"
    }
  });
});

test("toDesktopIpcResult preserves structured desktop host errors", async () => {
  const result = await toDesktopIpcResult(async () => {
    throw new DesktopApiError({
      code: "COMMON.UNAVAILABLE",
      correlationId: "corr-host-1",
      developerMessage: "owner tunnel offline",
      message: "Provider device is offline.",
      params: { authorityId: "device-1" },
      reason: "owner_offline",
      retryable: true
    });
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "COMMON.UNAVAILABLE",
      correlationId: "corr-host-1",
      developerMessage: "owner tunnel offline",
      message: "Provider device is offline.",
      params: { authorityId: "device-1" },
      reason: "owner_offline",
      retryable: true
    }
  });
});

test("toDesktopIpcResult keeps Node errors on the existing classifier path", async () => {
  for (const [nodeCode, expectedCode] of [
    ["ENOENT", "daemon_unavailable"],
    ["ETIMEDOUT", "transport_timeout"],
    ["ECONNREFUSED", "transport_connect_failed"]
  ] as const) {
    const result = await toDesktopIpcResult(async () => {
      throw Object.assign(new Error("node failure"), { code: nodeCode });
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, expectedCode);
    }
  }
});
