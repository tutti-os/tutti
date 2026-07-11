import assert from "node:assert/strict";
import test from "node:test";
import { withSidecarEventSinkForTest } from "./eventSink.ts";
import { SessionRuntime } from "./sessionRuntime.ts";
import { sidecarClaudeOptionsFromPayload } from "./options.ts";
import {
  fakeEarlyConsolidatedAssistantQuery,
  fakeInterleavedAssistantQuery,
  fakeNonStreamingAssistantQuery,
  fakePartialStreamAssistantQuery
} from "./sessionRuntimeTestQueries.assistant.ts";
import { waitForEvent } from "./sessionRuntimeTestQueries.nested.ts";

test("assistant text segments around tools keep distinct live message ids", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-1",
      "/repo",
      {},
      false,
      false,
      {
        model: "",
        permissionModeId: "default",
        planMode: false,
        effort: "",
        speed: ""
      },
      sidecarClaudeOptionsFromPayload({}),
      undefined,
      ({ prompt }) => fakeInterleavedAssistantQuery(prompt)
    );

    await session.start();
    session.exec("turn-1", "use a tool");
    await waitForEvent(events, "turn_completed");

    const completedAssistant = events.filter(
      (event) => event.type === "assistant_completed"
    );
    assert.deepEqual(
      completedAssistant.map((event) => event.payload?.content),
      ["Before tool.", "After tool."]
    );
    for (const event of completedAssistant) {
      assert.match(String(event.payload?.messageId ?? ""), /:live:\d+$/u);
      assert.doesNotMatch(String(event.payload?.messageId ?? ""), /:block:/u);
    }
    assert.notEqual(
      completedAssistant[0]?.payload?.messageId,
      completedAssistant[1]?.payload?.messageId
    );

    const completedThinking = events.filter(
      (event) => event.type === "thinking_completed"
    );
    assert.deepEqual(
      completedThinking.map((event) => event.payload?.content),
      ["Need a skill."]
    );
  } finally {
    restoreSink();
  }
});

test("consolidated assistant before content block stop does not duplicate", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-1",
      "/repo",
      {},
      false,
      false,
      {
        model: "",
        permissionModeId: "default",
        planMode: false,
        effort: "",
        speed: ""
      },
      sidecarClaudeOptionsFromPayload({}),
      undefined,
      ({ prompt }) => fakeEarlyConsolidatedAssistantQuery(prompt)
    );

    await session.start();
    session.exec("turn-1", "stream text");
    await waitForEvent(events, "turn_completed");

    const completedAssistant = events.filter(
      (event) => event.type === "assistant_completed"
    );
    assert.equal(completedAssistant.length, 1);
    assert.equal(completedAssistant[0]?.payload?.content, "Done.");
    assert.match(
      String(completedAssistant[0]?.payload?.messageId ?? ""),
      /:live:\d+$/u
    );
  } finally {
    restoreSink();
  }
});

test("partial stream consolidated assistant emits tail on same message id", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-1",
      "/repo",
      {},
      false,
      false,
      {
        model: "",
        permissionModeId: "default",
        planMode: false,
        effort: "",
        speed: ""
      },
      sidecarClaudeOptionsFromPayload({}),
      undefined,
      ({ prompt }) => fakePartialStreamAssistantQuery(prompt)
    );

    await session.start();
    session.exec("turn-1", "stream partial");
    await waitForEvent(events, "turn_completed");

    const deltas = events.filter((event) => event.type === "assistant_delta");
    const completed = events.filter(
      (event) => event.type === "assistant_completed"
    );
    assert.deepEqual(
      deltas.map((event) => event.payload?.content),
      ["hello", " world"]
    );
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.payload?.content, "hello world");
    assert.equal(
      deltas[0]?.payload?.messageId,
      completed[0]?.payload?.messageId
    );
    assert.equal(
      deltas[1]?.payload?.messageId,
      completed[0]?.payload?.messageId
    );
  } finally {
    restoreSink();
  }
});

test("non-streaming consolidated assistant creates fallback segment", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-1",
      "/repo",
      {},
      false,
      false,
      {
        model: "",
        permissionModeId: "default",
        planMode: false,
        effort: "",
        speed: ""
      },
      sidecarClaudeOptionsFromPayload({}),
      undefined,
      ({ prompt }) => fakeNonStreamingAssistantQuery(prompt)
    );

    await session.start();
    session.exec("turn-1", "no stream");
    await waitForEvent(events, "turn_completed");

    const deltas = events.filter((event) => event.type === "assistant_delta");
    const completed = events.filter(
      (event) => event.type === "assistant_completed"
    );
    assert.equal(deltas.length, 0);
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.payload?.content, "Offline answer.");
    assert.match(
      String(completed[0]?.payload?.messageId ?? ""),
      /:fallback:\d+$/u
    );
    assert.doesNotMatch(
      String(completed[0]?.payload?.messageId ?? ""),
      /:block:/u
    );
  } finally {
    restoreSink();
  }
});
