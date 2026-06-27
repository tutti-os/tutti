import assert from "node:assert/strict";
import { test } from "node:test";
import {
  latestAgentActivityMessageVersion,
  mergeAgentActivityMessages
} from "./merge.ts";
import type { AgentActivityMessage } from "./types.ts";

test("mergeAgentActivityMessages replaces older versions and keeps order", () => {
  const current = [
    message({ messageId: "message-2", version: 2 }),
    message({ messageId: "message-1", version: 1, status: "working" })
  ];

  const merged = mergeAgentActivityMessages(current, [
    message({ messageId: "message-1", version: 3, status: "completed" }),
    message({ messageId: "message-3", version: 4 })
  ]);

  assert.deepEqual(
    merged.map((item) => [item.messageId, item.version, item.status]),
    [
      ["message-2", 2, "working"],
      ["message-1", 3, "completed"],
      ["message-3", 4, "working"]
    ]
  );
});

test("mergeAgentActivityMessages ignores stale updates", () => {
  const merged = mergeAgentActivityMessages(
    [message({ messageId: "message-1", version: 4, status: "completed" })],
    [message({ messageId: "message-1", version: 3, status: "working" })]
  );

  assert.equal(merged[0]?.version, 4);
  assert.equal(merged[0]?.status, "completed");
});

test("latestAgentActivityMessageVersion returns highest cached version", () => {
  assert.equal(
    latestAgentActivityMessageVersion([
      message({ messageId: "message-1", version: 2 }),
      message({ messageId: "message-2", version: 8 })
    ]),
    8
  );
});

function message(
  overrides: Partial<AgentActivityMessage>
): AgentActivityMessage {
  return {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    messageId: "message-1",
    version: 1,
    turnId: "turn-1",
    role: "assistant",
    kind: "message.assistant",
    status: "working",
    payload: {},
    occurredAtUnixMs: 1,
    ...overrides
  };
}
