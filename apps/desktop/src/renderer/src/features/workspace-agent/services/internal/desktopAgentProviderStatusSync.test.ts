import assert from "node:assert/strict";
import test from "node:test";
import { TuttidProtocolError } from "@tutti-os/client-tuttid-ts";
import { shouldRefreshProviderStatusAfterSessionError } from "./desktopAgentProviderStatusSync.ts";

test("shouldRefreshProviderStatusAfterSessionError matches provider availability reasons", () => {
  assert.equal(
    shouldRefreshProviderStatusAfterSessionError(
      new TuttidProtocolError({
        code: "workspace_operation_failed",
        reason: "acp_adapter_version_mismatch",
        statusCode: 502
      })
    ),
    true
  );
  assert.equal(
    shouldRefreshProviderStatusAfterSessionError(
      new TuttidProtocolError({
        code: "workspace_operation_failed",
        reason: "cli_not_found",
        statusCode: 502
      })
    ),
    true
  );
  assert.equal(
    shouldRefreshProviderStatusAfterSessionError(
      new TuttidProtocolError({
        code: "workspace_operation_failed",
        reason: "claude_sdk_sidecar_unavailable",
        statusCode: 502
      })
    ),
    true
  );
  assert.equal(
    shouldRefreshProviderStatusAfterSessionError(
      new TuttidProtocolError({
        code: "workspace_operation_failed",
        reason: "managed_runtime_unavailable",
        statusCode: 502
      })
    ),
    true
  );
});

test("shouldRefreshProviderStatusAfterSessionError ignores unrelated failures", () => {
  assert.equal(
    shouldRefreshProviderStatusAfterSessionError(
      new TuttidProtocolError({
        code: "workspace_operation_failed",
        reason: "workspace_operation_failed",
        statusCode: 502
      })
    ),
    false
  );
  assert.equal(
    shouldRefreshProviderStatusAfterSessionError(
      new TuttidProtocolError({
        code: "service_unavailable",
        reason: "service_unavailable",
        statusCode: 503
      })
    ),
    false
  );
  assert.equal(
    shouldRefreshProviderStatusAfterSessionError(new Error("network down")),
    false
  );
});
