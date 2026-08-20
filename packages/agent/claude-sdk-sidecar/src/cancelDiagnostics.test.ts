import assert from "node:assert/strict";
import { pid } from "node:process";
import test from "node:test";
import {
  CLAUDE_CODE_CANCEL_DIAGNOSTIC_PREFIX,
  logClaudeCodeCancellation,
  withCancellationDiagnosticSinkForTest
} from "./cancelDiagnostics.ts";

test("cancellation diagnostics use one prefix and JSON payload", () => {
  const lines: string[] = [];
  const restore = withCancellationDiagnosticSinkForTest((line) =>
    lines.push(line)
  );
  try {
    logClaudeCodeCancellation("interrupt_started", {
      agentSessionId: "agent-session",
      turnId: "turn-1",
      generationId: 3
    });
  } finally {
    restore();
  }

  assert.equal(lines.length, 1);
  assert.equal(
    lines[0]?.startsWith(`${CLAUDE_CODE_CANCEL_DIAGNOSTIC_PREFIX} `),
    true
  );
  assert.deepEqual(
    JSON.parse(
      lines[0]?.slice(CLAUDE_CODE_CANCEL_DIAGNOSTIC_PREFIX.length + 1) ?? ""
    ),
    {
      stage: "interrupt_started",
      sidecarPid: pid,
      agentSessionId: "agent-session",
      turnId: "turn-1",
      generationId: 3
    }
  );
});
