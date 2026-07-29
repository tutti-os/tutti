import assert from "node:assert/strict";
import test from "node:test";
import { TuttidProtocolError } from "@tutti-os/client-tuttid-ts";
import {
  shouldCloseTerminalNodeAfterCloseFailure,
  shouldCloseTerminalNodeAfterError
} from "./terminalWindowClose.ts";

test("shouldCloseTerminalNodeAfterError closes stale terminal nodes", () => {
  assert.equal(
    shouldCloseTerminalNodeAfterError(
      new TuttidProtocolError({
        code: "workspace_terminal_not_found",
        reason: "workspace_terminal_not_found",
        statusCode: 404
      })
    ),
    true
  );

  assert.equal(
    shouldCloseTerminalNodeAfterError(
      new TuttidProtocolError({
        code: "workspace_terminal_not_running" as never,
        reason: "workspace_terminal_not_running",
        statusCode: 400
      })
    ),
    true
  );
});

test("shouldCloseTerminalNodeAfterError keeps terminal node open for other failures", () => {
  assert.equal(
    shouldCloseTerminalNodeAfterError(new Error("network failed")),
    false
  );
});

test("shouldCloseTerminalNodeAfterCloseFailure closes only ended stale terminals", () => {
  assert.equal(
    shouldCloseTerminalNodeAfterCloseFailure({
      error: new Error("close guard transport failed"),
      status: "detached"
    }),
    false
  );

  assert.equal(
    shouldCloseTerminalNodeAfterCloseFailure({
      error: new Error("terminate failed"),
      status: "failed"
    }),
    true
  );

  assert.equal(
    shouldCloseTerminalNodeAfterCloseFailure({
      error: new Error("network failed"),
      status: "running"
    }),
    false
  );
});
