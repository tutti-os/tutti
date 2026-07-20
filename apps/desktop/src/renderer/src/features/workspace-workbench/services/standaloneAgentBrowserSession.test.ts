import assert from "node:assert/strict";
import test from "node:test";
import { resolveStandaloneAgentBrowserSessionId } from "./standaloneAgentBrowserSession.ts";

test("automation-managed Browser tabs stay bound to their resource session", () => {
  assert.equal(
    resolveStandaloneAgentBrowserSessionId({
      currentAgentSessionId: "session-b",
      resourceAgentSessionId: "session-a"
    }),
    "session-a"
  );
});

test("user-created Browser tabs follow the current Agent session", () => {
  assert.equal(
    resolveStandaloneAgentBrowserSessionId({
      currentAgentSessionId: "session-b"
    }),
    "session-b"
  );
});
