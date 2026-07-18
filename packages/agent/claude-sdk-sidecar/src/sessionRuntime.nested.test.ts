import assert from "node:assert/strict";
import test from "node:test";
import { withSidecarEventSinkForTest } from "./eventSink.ts";
import { SessionRuntime } from "./sessionRuntime.ts";
import { sidecarClaudeOptionsFromPayload } from "./options.ts";
import { fakeDelegatedTextOnlyCompletionQuery } from "./sessionRuntimeTestQueries.session.ts";
import {
  fakeNestedDelegatedLaunchQuery,
  fakeNestedLaunchWithoutToolUseQuery,
  fakeNestedApprovalQuery,
  fakeNestedDeferredParentCompletionQuery,
  fakeNestedToolUseAndEndTurnQuery,
  waitForEvent
} from "./sessionRuntimeTestQueries.nested.ts";

test("nested end_turn assistant completes delegated task without child result", async () => {
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
      fakeDelegatedTextOnlyCompletionQuery
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "task_completed");

    const completed = events.find((event) => event.type === "task_completed");
    assert.equal(completed?.payload?.parentToolUseId, "toolu-agent");
    assert.equal(completed?.payload?.summary, "7");
  } finally {
    restoreSink();
  }
});

test("nested agent launch registers grandchild task with inherited turn id", async () => {
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
      fakeNestedDelegatedLaunchQuery
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "task_completed");

    const childCompleted = events.find(
      (event) =>
        event.type === "task_completed" &&
        event.payload?.parentToolUseId === "toolu-child"
    );
    assert.equal(childCompleted?.payload?.turnId, "turn-1");
    assert.equal(childCompleted?.payload?.agentId, "agent-child");

    const childToolCompleted = events.find(
      (event) =>
        event.type === "tool_completed" &&
        event.payload?.toolCallId === "toolu-child" &&
        event.payload?.status === "completed"
    );
    assert.equal(childToolCompleted?.payload?.turnId, "turn-1");
  } finally {
    restoreSink();
  }
});

test("nested launch without observed tool_use block still registers task", async () => {
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
      fakeNestedLaunchWithoutToolUseQuery
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "task_completed");

    const childCompleted = events.find(
      (event) =>
        event.type === "task_completed" &&
        event.payload?.parentToolUseId === "toolu-child"
    );
    assert.equal(childCompleted?.payload?.turnId, "turn-1");

    const launchToolCompleted = events.find(
      (event) =>
        event.type === "tool_completed" &&
        event.payload?.toolCallId === "toolu-child" &&
        (event.payload?.metadata as Record<string, unknown> | undefined)
          ?.subagentAsync === true
    );
    assert.equal(launchToolCompleted?.payload?.turnId, "turn-1");
  } finally {
    restoreSink();
  }
});

test("nested approval after parent task completed still carries a turn id", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  let permissionResult: unknown;
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
      ({ prompt, options }) =>
        fakeNestedApprovalQuery(prompt, options, (result) => {
          permissionResult = result;
        })
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "approval_requested");

    const request = events.find((event) => event.type === "approval_requested");
    assert.equal(request?.payload?.turnId, "turn-1");
    assert.equal(request?.payload?.agentId, "agent-parent");

    session.submitInteractive(
      "turn-1",
      String(request?.payload?.requestId ?? ""),
      "submit",
      "allow",
      {}
    );
    await waitForEvent(events, "approval_resolved");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(permissionResult, {
      behavior: "allow",
      updatedInput: { command: "ls" }
    });
  } finally {
    restoreSink();
  }
});

test("nested end_turn assistant defers parent completion while grandchild runs", async () => {
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
      fakeNestedDeferredParentCompletionQuery
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "task_completed");
    // Let the fake stream drain the remaining nested messages.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const parentCompletions = events.filter(
      (event) =>
        event.type === "task_completed" &&
        event.payload?.parentToolUseId === "toolu-parent"
    );
    assert.equal(parentCompletions.length, 1);
    assert.equal(parentCompletions[0]?.payload?.summary, "Parent finished.");

    const childCompletedIndex = events.findIndex(
      (event) =>
        event.type === "task_completed" &&
        event.payload?.parentToolUseId === "toolu-child"
    );
    const parentCompletedIndex = events.findIndex(
      (event) =>
        event.type === "task_completed" &&
        event.payload?.parentToolUseId === "toolu-parent"
    );
    assert.ok(childCompletedIndex >= 0);
    assert.ok(parentCompletedIndex > childCompletedIndex);
  } finally {
    restoreSink();
  }
});

test("nested end_turn assistant defers parent completion while child tool result is pending", async () => {
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
      fakeNestedToolUseAndEndTurnQuery
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "task_completed");
    // Let the fake stream drain the grandchild result and final parent end.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const parentCompletions = events.filter(
      (event) =>
        event.type === "task_completed" &&
        event.payload?.parentToolUseId === "toolu-parent"
    );
    assert.equal(parentCompletions.length, 1);
    assert.equal(parentCompletions[0]?.payload?.summary, "Parent finished.");

    const childCompletedIndex = events.findIndex(
      (event) =>
        event.type === "task_completed" &&
        event.payload?.parentToolUseId === "toolu-child"
    );
    const parentCompletedIndex = events.findIndex(
      (event) =>
        event.type === "task_completed" &&
        event.payload?.parentToolUseId === "toolu-parent"
    );
    assert.ok(childCompletedIndex >= 0);
    assert.ok(parentCompletedIndex > childCompletedIndex);
  } finally {
    restoreSink();
  }
});
