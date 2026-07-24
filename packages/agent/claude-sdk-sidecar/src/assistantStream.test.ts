import assert from "node:assert/strict";
import test from "node:test";
import { AssistantStreamProjector } from "./assistantStream.ts";
import type { ClaudeSDKSidecarEvent } from "./protocol.ts";

test("assistant stream keeps delta and completion on one message", () => {
  const events: Array<Omit<ClaudeSDKSidecarEvent, "version">> = [];
  const projector = new AssistantStreamProjector(
    () => "turn-1",
    (event) => events.push(event)
  );

  projector.setMessageBase("message-1");
  projector.appendDelta(0, "assistant", "hello");
  assert.equal(projector.completeIndex(0), true);

  assert.deepEqual(
    events.map((event) => [event.type, event.payload?.content]),
    [
      ["assistant_delta", "hello"],
      ["assistant_completed", "hello"]
    ]
  );
  assert.equal(events[0]?.payload?.messageId, events[1]?.payload?.messageId);
});

test("assistant fallback reuses a streamed prefix", () => {
  const events: Array<Omit<ClaudeSDKSidecarEvent, "version">> = [];
  const projector = new AssistantStreamProjector(
    () => "turn-1",
    (event) => events.push(event)
  );

  projector.setMessageBase("message-1");
  projector.appendDelta(0, "assistant", "hel");
  projector.completeContent(
    "assistant",
    "message-1",
    "hello",
    new Set<string>()
  );

  assert.deepEqual(
    events.map((event) => [event.type, event.payload?.content]),
    [
      ["assistant_delta", "hel"],
      ["assistant_delta", "lo"],
      ["assistant_completed", "hello"]
    ]
  );
});

test("assistant SDK error replaces completion with a failed message", () => {
  const events: Array<Omit<ClaudeSDKSidecarEvent, "version">> = [];
  const projector = new AssistantStreamProjector(
    () => "turn-1",
    (event) => events.push(event)
  );

  projector.setMessageBase("message-1");
  projector.failContent(
    "assistant",
    "message-1",
    "Failed to authenticate",
    new Set<string>()
  );

  assert.deepEqual(
    events.map((event) => [event.type, event.payload?.content]),
    [["assistant_failed", "Failed to authenticate"]]
  );
});

test("assistant stream reset drops stale indexes", () => {
  const events: Array<Omit<ClaudeSDKSidecarEvent, "version">> = [];
  const projector = new AssistantStreamProjector(
    () => "turn-2",
    (event) => events.push(event)
  );

  projector.start(0, "thinking");
  projector.reset();

  assert.equal(projector.completeIndex(0), false);
  assert.deepEqual(events, []);
});
