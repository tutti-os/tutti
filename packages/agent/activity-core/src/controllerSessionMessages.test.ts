import assert from "node:assert/strict";
import test from "node:test";
import { createAgentActivityController } from "./controller.ts";
import {
  deferred,
  testAdapter,
  testMessage
} from "./controller.testFixtures.ts";
import type { AgentActivitySessionEventEnvelope } from "./types.ts";

test("retained session streams deduplicate consumers and release the subscription once", async () => {
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  const subscription = { signal: null as AbortSignal | null };
  const controller = createAgentActivityController({
    adapter: testAdapter({
      subscribeSessionEvents: async (input) => {
        subscribeCount += 1;
        subscription.signal = input.signal;
        return () => {
          unsubscribeCount += 1;
        };
      }
    }),
    autoRetainSessionEvents: false,
    workspaceId: "workspace-1"
  });

  const releaseFirst = controller.retainSessionEvents({
    agentSessionId: "session-1"
  });
  const releaseSecond = controller.retainSessionEvents({
    agentSessionId: "session-1"
  });
  await Promise.resolve();

  assert.equal(subscribeCount, 1);
  releaseFirst();
  assert.equal(unsubscribeCount, 0);
  assert.equal(subscription.signal?.aborted, false);
  releaseSecond();
  assert.equal(unsubscribeCount, 1);
  assert.equal(subscription.signal?.aborted, true);
});

test("a failed retained subscription can be retried", async () => {
  let subscribeCount = 0;
  let reportedErrors = 0;
  const controller = createAgentActivityController({
    adapter: testAdapter({
      subscribeSessionEvents: async () => {
        subscribeCount += 1;
        if (subscribeCount === 1) {
          throw new Error("stream unavailable");
        }
        return () => {};
      }
    }),
    autoRetainSessionEvents: false,
    workspaceId: "workspace-1"
  });

  controller.retainSessionEvents({
    agentSessionId: "session-1",
    onError: () => {
      reportedErrors += 1;
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const release = controller.retainSessionEvents({
    agentSessionId: "session-1"
  });
  await Promise.resolve();

  assert.equal(subscribeCount, 2);
  assert.equal(reportedErrors, 1);
  release();
});

test("stale listed messages cannot replace a newer retained stream message", async () => {
  const listed = deferred<{
    hasMore: boolean;
    latestVersion: number;
    messages: ReturnType<typeof testMessage>[];
  }>();
  const subscription = {
    onEvent: null as ((event: AgentActivitySessionEventEnvelope) => void) | null
  };
  const controller = createAgentActivityController({
    adapter: testAdapter({
      listSessionMessages: async () => listed.promise,
      subscribeSessionEvents: async (input) => {
        subscription.onEvent = input.onEvent;
        return () => {};
      }
    }),
    autoRetainSessionEvents: false,
    workspaceId: "workspace-1"
  });

  const listing = controller.listSessionMessages({
    agentSessionId: "session-1"
  });
  const release = controller.retainSessionEvents({
    agentSessionId: "session-1"
  });
  await Promise.resolve();
  subscription.onEvent?.(messageEvent(testMessage("message-1", 3)));
  listed.resolve({
    hasMore: false,
    latestVersion: 2,
    messages: [testMessage("message-1", 2)]
  });
  await listing;

  assert.deepEqual(
    controller
      .getSnapshot()
      .sessionMessagesById["session-1"]?.map((item) => [
        item.messageId,
        item.version
      ]),
    [["message-1", 3]]
  );
  release();
});

function messageEvent(
  message: ReturnType<typeof testMessage>
): AgentActivitySessionEventEnvelope {
  return {
    agentSessionId: message.agentSessionId,
    data: {
      acceptedCount: 1,
      agentSessionId: message.agentSessionId,
      eventType: "message_update",
      latestVersion: message.version,
      messages: [
        {
          agentSessionId: message.agentSessionId,
          kind: message.kind,
          messageId: message.messageId,
          occurredAtUnixMs: message.occurredAtUnixMs,
          payload: message.payload,
          role: message.role,
          turnId: message.turnId,
          version: message.version
        }
      ],
      workspaceId: "workspace-1"
    },
    eventType: "message_update",
    workspaceId: "workspace-1"
  };
}
