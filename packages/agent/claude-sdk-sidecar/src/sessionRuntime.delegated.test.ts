import assert from "node:assert/strict";
import test from "node:test";
import { withSidecarEventSinkForTest } from "./eventSink.ts";
import { SessionRuntime } from "./sessionRuntime.ts";
import { sidecarClaudeOptionsFromPayload } from "./options.ts";
import {
  fakeDelegatedAssistantParentQuery,
  fakeDelegatedTaskQuery,
  fakeRacedDelegatedTaskAliasQuery
} from "./sessionRuntimeTestQueries.delegated.ts";
import {
  fakeConcurrentDelegatedTaskCreatedHookQuery,
  fakeDelegatedTaskCompletedHookQuery,
  fakeFoldInTaskNotificationQuery,
  fakeUserTaskNotificationQuery
} from "./sessionRuntimeTestQueries.session.ts";
import { waitForEvent } from "./sessionRuntimeTestQueries.nested.ts";

test("late delegated task notification keeps original parent turn id", async () => {
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
      ({ prompt }) => fakeDelegatedTaskQuery(prompt)
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "task_completed");

    const taskCompleted = events.find(
      (event) => event.type === "task_completed"
    );
    assert.equal(taskCompleted?.payload?.turnId, "turn-1");
    assert.equal(taskCompleted?.payload?.parentToolUseId, "toolu-agent");

    const parentToolCompleted = events.find(
      (event) =>
        event.type === "tool_completed" &&
        event.payload?.toolCallId === "toolu-agent" &&
        event.payload?.status === "completed"
    );
    assert.equal(parentToolCompleted?.payload?.turnId, "turn-1");
  } finally {
    restoreSink();
  }
});

test("delegated child result completes background agent, not mid-run child assistant messages", async () => {
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
      fakeDelegatedAssistantParentQuery
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "task_completed");

    const completedEvents = events.filter(
      (event) => event.type === "task_completed"
    );
    assert.equal(completedEvents.length, 1);
    const taskCompleted = completedEvents[0];
    assert.equal(taskCompleted?.payload?.parentToolUseId, "toolu-agent");
    assert.equal(taskCompleted?.payload?.summary, "Child result ready");

    // The mid-run child assistant message streams before the task_progress
    // event; completion must come only after progress, from the child result.
    const progressIndex = events.findIndex(
      (event) => event.type === "task_progress"
    );
    const completedIndex = events.findIndex(
      (event) => event.type === "task_completed"
    );
    assert.ok(progressIndex >= 0);
    assert.ok(completedIndex > progressIndex);

    const parentToolCompleted = events.find(
      (event) =>
        event.type === "tool_completed" &&
        event.payload?.toolCallId === "toolu-agent" &&
        event.payload?.status === "completed"
    );
    assert.equal(parentToolCompleted?.payload?.turnId, "turn-1");
  } finally {
    restoreSink();
  }
});

test("trailing task_progress does not resurrect a settled delegated task", async () => {
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
      ({ prompt }) =>
        fakeDelegatedTaskQuery(prompt, { progressAfterNotification: true })
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "task_completed");
    // Let the fake stream drain the trailing task_progress message.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const completedIndex = events.findIndex(
      (event) => event.type === "task_completed"
    );
    assert.ok(completedIndex >= 0);
    const resurrected = events
      .slice(completedIndex + 1)
      .find((event) => event.type === "task_progress");
    assert.equal(resurrected, undefined);
  } finally {
    restoreSink();
  }
});

test("fold-in queued_command task notification completes running delegated task", async () => {
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
      fakeFoldInTaskNotificationQuery
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

test("user task-notification string completes running delegated task", async () => {
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
      fakeUserTaskNotificationQuery
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "task_completed");

    const completed = events.find((event) => event.type === "task_completed");
    assert.equal(completed?.payload?.parentToolUseId, "toolu-agent");
  } finally {
    restoreSink();
  }
});

test("delegated task continuation emits synthetic turn started", async () => {
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
      ({ prompt }) =>
        fakeDelegatedTaskQuery(prompt, { continueAfterNotification: true })
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "turn_started");

    const started = events.find((event) => event.type === "turn_started");
    assert.equal(started?.payload?.synthetic, true);
    assert.match(String(started?.payload?.turnId ?? ""), /^synthetic-/);

    const continuation = events.find(
      (event) =>
        event.type === "assistant_completed" &&
        event.payload?.content === "Continuing after child agent."
    );
    assert.equal(continuation?.payload?.turnId, started?.payload?.turnId);
  } finally {
    restoreSink();
  }
});

test("late delegated task notification without ids resolves single running task", async () => {
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
      ({ prompt }) =>
        fakeDelegatedTaskQuery(prompt, { omitNotificationIds: true })
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "task_completed");

    const taskCompleted = events.find(
      (event) => event.type === "task_completed"
    );
    assert.equal(taskCompleted?.payload?.turnId, "turn-1");
    assert.equal(taskCompleted?.payload?.parentToolUseId, "toolu-agent");

    const parentToolCompleted = events.find(
      (event) =>
        event.type === "tool_completed" &&
        event.payload?.toolCallId === "toolu-agent" &&
        event.payload?.status === "completed"
    );
    assert.equal(parentToolCompleted?.payload?.turnId, "turn-1");
  } finally {
    restoreSink();
  }
});

test("late delegated task completion hook clears single running task", async () => {
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
      fakeDelegatedTaskCompletedHookQuery
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "task_completed");

    const taskCompleted = events.find(
      (event) => event.type === "task_completed"
    );
    assert.equal(taskCompleted?.payload?.turnId, "turn-1");
    assert.equal(taskCompleted?.payload?.parentToolUseId, "toolu-agent");
    assert.equal(taskCompleted?.payload?.status, "completed");

    const parentToolCompleted = events.find(
      (event) =>
        event.type === "tool_completed" &&
        event.payload?.toolCallId === "toolu-agent" &&
        event.payload?.status === "completed"
    );
    assert.equal(parentToolCompleted?.payload?.turnId, "turn-1");
  } finally {
    restoreSink();
  }
});

test("task created hook does not bind unrelated running delegated task", async () => {
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
      fakeConcurrentDelegatedTaskCreatedHookQuery
    );

    await session.start();
    session.exec("turn-1", "delegate tasks");
    await waitForEvent(events, "task_completed");

    const taskCompleted = events.find(
      (event) => event.type === "task_completed"
    );
    assert.equal(taskCompleted?.payload?.taskId, "task-2");
    assert.equal(taskCompleted?.payload?.parentToolUseId, "toolu-agent-2");

    const completedParents = events
      .filter((event) => {
        const metadata = event.payload?.metadata as
          | Record<string, unknown>
          | undefined;
        return (
          event.type === "tool_completed" &&
          event.payload?.status === "completed" &&
          metadata?.subagentStatus === "completed"
        );
      })
      .map((event) => event.payload?.toolCallId);
    assert.deepEqual(completedParents, ["toolu-agent-2"]);
  } finally {
    restoreSink();
  }
});

test("unknown task alias does not bind to another running delegated task", async () => {
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
      ({ prompt }) => fakeRacedDelegatedTaskAliasQuery(prompt)
    );

    await session.start();
    session.exec("turn-1", "delegate tasks");
    await waitForEvent(events, "task_completed");

    const taskCompleted = events.find(
      (event) => event.type === "task_completed"
    );
    assert.equal(taskCompleted?.payload?.parentToolUseId, "toolu-agent-2");

    const completedParents = events
      .filter((event) => {
        const metadata = event.payload?.metadata as
          | Record<string, unknown>
          | undefined;
        return (
          event.type === "tool_completed" &&
          event.payload?.status === "completed" &&
          metadata?.subagentStatus === "completed"
        );
      })
      .map((event) => event.payload?.toolCallId);
    assert.deepEqual(completedParents, ["toolu-agent-2"]);

    const firstAgentTaskEvents = events.filter(
      (event) =>
        (event.type === "task_started" ||
          event.type === "task_progress" ||
          event.type === "task_completed") &&
        event.payload?.parentToolUseId === "toolu-agent-1"
    );
    assert.deepEqual(firstAgentTaskEvents, []);
  } finally {
    restoreSink();
  }
});
