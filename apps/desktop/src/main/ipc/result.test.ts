import assert from "node:assert/strict";
import test from "node:test";
import {
  TuttidProtocolError,
  workspaceProtocolErrorCodes
} from "@tutti-os/client-tuttid-ts";
import { toDesktopIpcResult } from "./result.ts";
import { DESKTOP_AGENT_PROMPT_FILE_TOO_LARGE_ERROR_CODE } from "../../shared/agentPromptAssets.ts";

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

test("toDesktopIpcResult preserves prompt file size errors", async () => {
  const result = await toDesktopIpcResult(async () => {
    throw Object.assign(new Error("Agent prompt file is too large."), {
      code: DESKTOP_AGENT_PROMPT_FILE_TOO_LARGE_ERROR_CODE
    });
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: DESKTOP_AGENT_PROMPT_FILE_TOO_LARGE_ERROR_CODE,
      message: "Agent prompt file is too large."
    }
  });
});
