import assert from "node:assert/strict";
import test from "node:test";
import { replayActionErrorMessage } from "./replayActionErrorMessage.ts";

test("summarizes a final state mismatch without exposing fixture JSON", () => {
  const message = replayActionErrorMessage(
    new Error(
      'Replay failed: expected state mismatch in workspace_agent_sessions\\nexpected: [{"models":"very large"}]'
    ),
    (table) => `State mismatch: ${table}`
  );

  assert.equal(message, "State mismatch: workspace_agent_sessions");
  assert.doesNotMatch(message, /models|expected/u);
});

test("limits other replay errors to one short line", () => {
  const message = replayActionErrorMessage(
    new Error(`transport mismatch ${"x".repeat(300)}\\nrequest: secret`),
    (table) => table
  );

  assert.equal(message.length, 240);
  assert.match(message, /…$/u);
  assert.doesNotMatch(message, /request|secret/u);
});
