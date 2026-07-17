import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivitySession } from "@tutti-os/agent-activity-core";
import { agentActivitySessionDiagnosticSignature } from "./desktopAgentRuntimeStateDiagnostics.ts";

function session(
  overrides: Partial<AgentActivitySession> = {}
): AgentActivitySession {
  return {
    activeTurn: null,
    activeTurnId: null,
    agentSessionId: "session-1",
    latestTurn: null,
    lastEventUnixMs: 10,
    messageVersion: 1,
    pendingInteractions: [],
    provider: "codex",
    updatedAtUnixMs: 10,
    ...overrides
  } as AgentActivitySession;
}

test("session diagnostic signature ignores streaming cursors and timestamps", () => {
  const before = agentActivitySessionDiagnosticSignature(session());
  const after = agentActivitySessionDiagnosticSignature(
    session({
      lastEventUnixMs: 30,
      messageVersion: 8,
      updatedAtUnixMs: 40
    })
  );

  assert.equal(after, before);
});

test("session diagnostic signature retains actionable state transitions", () => {
  const before = agentActivitySessionDiagnosticSignature(session());
  const after = agentActivitySessionDiagnosticSignature(
    session({
      pendingInteractions: [
        {
          agentSessionId: "session-1",
          createdAtUnixMs: 20,
          kind: "approval",
          requestId: "request-1",
          status: "pending",
          turnId: "turn-1",
          updatedAtUnixMs: 20
        }
      ]
    })
  );

  assert.notEqual(after, before);
});
