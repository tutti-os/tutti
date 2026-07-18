import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import { analyzeInlineMessageVersionContinuity } from "./workspaceAgentActivityReconcileMessages.ts";

test("inline message continuity accepts snapshot cursor gaps already present in the cache", () => {
  const result = analyzeInlineMessageVersionContinuity(
    [message(1), message(5)],
    [message(6), message(7)]
  );

  assert.deepEqual(result, {
    cachedVersion: 5,
    continuous: true,
    firstUnseenVersion: 6,
    latestIncomingVersion: 7
  });
});

test("inline message continuity rejects an unseen version hole", () => {
  const result = analyzeInlineMessageVersionContinuity(
    [message(1)],
    [message(3)]
  );

  assert.deepEqual(result, {
    cachedVersion: 1,
    continuous: false,
    firstUnseenVersion: 3,
    latestIncomingVersion: 3
  });
});

test("inline message continuity accepts duplicate or stale delivery", () => {
  assert.equal(
    analyzeInlineMessageVersionContinuity(
      [message(3)],
      [message(2), message(3)]
    ).continuous,
    true
  );
});

function message(version: number): AgentActivityMessage {
  return {
    workspaceId: "ws-1",
    agentSessionId: "session-1",
    messageId: `message-${version}`,
    version,
    turnId: "turn-1",
    role: "assistant",
    kind: "text",
    payload: { text: String(version) },
    occurredAtUnixMs: version
  };
}
