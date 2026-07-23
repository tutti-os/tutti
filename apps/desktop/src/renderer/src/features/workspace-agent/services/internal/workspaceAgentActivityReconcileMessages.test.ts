import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentActivityAdapter,
  AgentActivityMessage
} from "@tutti-os/agent-activity-core";
import {
  analyzeInlineMessageVersionContinuity,
  reconcileAgentSessionMessagePages
} from "./workspaceAgentActivityReconcileMessages.ts";

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

test("initial descending reconcile exposes the exact older-history boundary", async () => {
  const result = await reconcileAgentSessionMessagePages({
    adapter: adapter({
      hasMore: false,
      latestVersion: 4,
      messages: [message(2), message(4)]
    }),
    agentSessionId: "session-1",
    cached: [],
    historyBoundary: undefined,
    shouldAbort: () => false,
    workspaceId: "ws-1"
  });

  assert.equal(result.historyBoundary, false);
  assert.deepEqual(
    result.page.messages.map((item) => item.version),
    [2, 4]
  );
});

test("cached realtime messages without a history boundary still reconcile from the newest page", async () => {
  const requests: unknown[] = [];
  const result = await reconcileAgentSessionMessagePages({
    adapter: {
      listSessionMessages: async (
        request: Parameters<AgentActivityAdapter["listSessionMessages"]>[0]
      ) => {
        requests.push(request);
        return {
          hasMore: false,
          latestVersion: 4,
          messages: [message(2), message(4)]
        };
      }
    } as unknown as AgentActivityAdapter,
    agentSessionId: "session-1",
    cached: [message(4)],
    historyBoundary: undefined,
    shouldAbort: () => false,
    workspaceId: "ws-1"
  });

  assert.deepEqual(requests, [
    {
      agentSessionId: "session-1",
      limit: 100,
      order: "desc",
      workspaceId: "ws-1"
    }
  ]);
  assert.equal(result.historyBoundary, false);
});

test("incremental ascending reconcile does not claim an older-history boundary", async () => {
  const result = await reconcileAgentSessionMessagePages({
    adapter: adapter({
      hasMore: false,
      latestVersion: 5,
      messages: [message(5)]
    }),
    agentSessionId: "session-1",
    cached: [message(4)],
    historyBoundary: true,
    shouldAbort: () => false,
    workspaceId: "ws-1"
  });

  assert.equal(result.historyBoundary, undefined);
  assert.deepEqual(
    result.page.messages.map((item) => item.version),
    [5]
  );
});

function adapter(
  page: Awaited<ReturnType<AgentActivityAdapter["listSessionMessages"]>>
): AgentActivityAdapter {
  return {
    listSessionMessages: async () => page
  } as unknown as AgentActivityAdapter;
}

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
