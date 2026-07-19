import assert from "node:assert/strict";
import test from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSDKSidecarEvent } from "./protocol.ts";
import { SDKMessageRouter } from "./messageRouter.ts";
import { TurnLifecycle } from "./turnLifecycle.ts";
import type { AssistantStreamProjector } from "./assistantStream.ts";
import type { CompactionTracker } from "./compaction.ts";
import type { MessageProjection } from "./messageProjection.ts";
import type { ToolActivityProjector } from "./toolActivity.ts";

type TestSidecarEvent = Omit<ClaudeSDKSidecarEvent, "version">;

function createRouter(events: TestSidecarEvent[]): {
  router: SDKMessageRouter;
  messageBases: string[];
} {
  const lifecycle = new TurnLifecycle({
    emit: (event) => events.push(event),
    onActivate: () => {},
    onSettled: () => {}
  });
  lifecycle.enqueue({
    turnId: "turn-1",
    promptUuid: "prompt-1",
    settled: false
  });
  lifecycle.activateForUserMessage("prompt-1");
  const messageBases: string[] = [];
  const router = new SDKMessageRouter({
    getProviderSessionId: () => "provider-session-1",
    setProviderSessionId: () => {},
    onAssistantUuid: () => {},
    onSessionState: () => {},
    onMaybeTitle: async () => {},
    turns: lifecycle,
    assistant: {
      setMessageBase: (value: string) => messageBases.push(value)
    } as unknown as AssistantStreamProjector,
    activities: {} as unknown as ToolActivityProjector,
    projection: {} as unknown as MessageProjection,
    compaction: {} as unknown as CompactionTracker,
    emit: (event) => events.push(event)
  });
  return { router, messageBases };
}

function streamEvent(
  event: Record<string, unknown>,
  parentToolUseID: string | null = null
): SDKMessage {
  return {
    type: "stream_event",
    uuid: `stream-${crypto.randomUUID()}`,
    parent_tool_use_id: parentToolUseID,
    session_id: "provider-session-1",
    event
  } as unknown as SDKMessage;
}

function usageEvents(events: TestSidecarEvent[]): TestSidecarEvent[] {
  return events.filter((event) => event.type === "usage_updated");
}

test("message_start emits usage_updated with the messageStart marker and raw usage", async () => {
  const events: TestSidecarEvent[] = [];
  const { router, messageBases } = createRouter(events);

  await router.handle(
    streamEvent({
      type: "message_start",
      message: {
        id: "msg-1",
        usage: { input_tokens: 1200, output_tokens: 1 }
      }
    })
  );

  assert.deepEqual(messageBases, ["msg-1"]);
  const usage = usageEvents(events);
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.payload?.turnId, "turn-1");
  assert.equal(usage[0]?.payload?.messageStart, true);
  assert.deepEqual(usage[0]?.payload?.usage, {
    input_tokens: 1200,
    output_tokens: 1
  });
});

test("message_start without usage keeps the base update but emits nothing", async () => {
  const events: TestSidecarEvent[] = [];
  const { router, messageBases } = createRouter(events);

  await router.handle(
    streamEvent({ type: "message_start", message: { id: "msg-no-usage" } })
  );

  assert.deepEqual(messageBases, ["msg-no-usage"]);
  assert.equal(usageEvents(events).length, 0);
});

test("nested message_start usage stays out of the root turn counters", async () => {
  const events: TestSidecarEvent[] = [];
  const { router, messageBases } = createRouter(events);

  await router.handle(
    streamEvent(
      {
        type: "message_start",
        message: { id: "msg-nested", usage: { input_tokens: 42 } }
      },
      "tool-use-1"
    )
  );

  assert.deepEqual(messageBases, []);
  assert.equal(usageEvents(events).length, 0);
});

test("message_delta emission is unchanged next to the message_start marker", async () => {
  const events: TestSidecarEvent[] = [];
  const { router } = createRouter(events);

  await router.handle(
    streamEvent({
      type: "message_start",
      message: { id: "msg-2", usage: { input_tokens: 100 } }
    })
  );
  await router.handle(
    streamEvent({
      type: "message_delta",
      usage: { output_tokens: 37 }
    })
  );

  const usage = usageEvents(events);
  assert.equal(usage.length, 2);
  assert.equal(usage[0]?.payload?.messageStart, true);
  assert.deepEqual(usage[0]?.payload?.usage, { input_tokens: 100 });
  assert.equal(usage[1]?.payload?.messageStart, undefined);
  assert.deepEqual(usage[1]?.payload, {
    turnId: "turn-1",
    usage: { output_tokens: 37 }
  });
});
