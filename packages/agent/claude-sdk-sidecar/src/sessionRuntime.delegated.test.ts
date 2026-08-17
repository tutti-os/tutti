import assert from "node:assert/strict";
import test from "node:test";
import { withSidecarEventSinkForTest } from "./eventSink.ts";
import { SessionRuntime } from "./sessionRuntime.ts";
import { sidecarClaudeOptionsFromPayload } from "./options.ts";
import {
  fakeBackgroundBashAndSubagentQuery,
  fakeBackgroundTasksLevelContinuationQuery,
  fakeCancelableBackgroundTaskLevelQuery,
  fakeCoalescedDelegatedTaskContinuationQuery,
  fakeDelegatedAssistantParentQuery,
  fakeDelegatedTaskQuery,
  fakeFailedBackgroundTaskSignalQuery,
  fakeLongRunningBackgroundBashQuery,
  fakeGuidedDelegatedContinuationQuery,
  fakeParallelDelegatedTaskContinuationQuery,
  fakeRacedDelegatedTaskAliasQuery,
  fakeStoppableDelegatedTaskQuery,
  fakeTimedOutDelegatedTaskQuery
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

    const taskNotificationObservedIndex = events.findIndex(
      (event) =>
        event.type === "sdk_lifecycle_observed" &&
        event.payload?.sdkMessageType === "system" &&
        event.payload?.sdkMessageSubtype === "task_notification"
    );
    const taskCompletedIndex = events.findIndex(
      (event) => event.type === "task_completed"
    );
    const continuationObservedIndex = events.findIndex(
      (event) =>
        event.type === "sdk_lifecycle_observed" &&
        event.payload?.sdkMessageType === "assistant" &&
        event.payload?.rootContinuationCandidate === true
    );
    const syntheticStartedIndex = events.findIndex(
      (event) => event.type === "turn_started"
    );
    assert.ok(taskNotificationObservedIndex >= 0);
    assert.ok(taskCompletedIndex > taskNotificationObservedIndex);
    assert.ok(syntheticStartedIndex > taskNotificationObservedIndex);
    assert.ok(taskCompletedIndex > syntheticStartedIndex);
    assert.ok(continuationObservedIndex > taskCompletedIndex);

    const observed = events[taskNotificationObservedIndex]?.payload;
    assert.equal(Object.hasOwn(observed ?? {}, "summary"), false);
    assert.equal(Object.hasOwn(observed ?? {}, "content"), false);
  } finally {
    restoreSink();
  }
});

test("parallel delegated notifications keep the original turn open until session idle", async () => {
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
      ({ prompt }) => fakeParallelDelegatedTaskContinuationQuery(prompt)
    );

    await session.start();
    session.exec("turn-1", "delegate parallel tasks");
    const deadline = Date.now() + 5000;
    while (
      Date.now() < deadline &&
      events.filter((event) => event.type === "turn_completed").length < 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const syntheticStarts = events.filter(
      (event) =>
        event.type === "turn_started" && event.payload?.synthetic === true
    );
    const turnCompletions = events.filter(
      (event) => event.type === "turn_completed"
    );
    const continuationMessages = events.filter(
      (event) =>
        event.type === "assistant_completed" &&
        String(event.payload?.content ?? "").startsWith("Continuation ")
    );
    const taskCompletions = events.filter(
      (event) => event.type === "task_completed"
    );
    const taskResultUpdates = events.filter(
      (event) => event.type === "task_result_updated"
    );

    assert.equal(syntheticStarts.length, 0);
    assert.deepEqual(
      turnCompletions.map((event) => event.payload?.turnId),
      ["turn-1"]
    );
    assert.deepEqual(
      taskCompletions.map((event) => event.payload?.summary),
      ["Task 1", "Task 2"]
    );
    assert.deepEqual(
      taskResultUpdates.map((event) => event.payload?.summary),
      ["Result 1", "Result 2"]
    );
    assert.equal(continuationMessages.length, 2);
    assert.equal(continuationMessages[0]?.payload?.turnId, "turn-1");
    assert.equal(continuationMessages[1]?.payload?.turnId, "turn-1");
  } finally {
    restoreSink();
  }
});

test("root success before delegated continuation keeps the original turn open until session idle", async () => {
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
        fakeParallelDelegatedTaskContinuationQuery(prompt, {
          rootResultBeforeContinuations: true
        })
    );

    await session.start();
    session.exec("turn-1", "delegate parallel tasks");
    await waitForEvent(events, "turn_completed");

    assert.deepEqual(
      events
        .filter((event) => event.type === "turn_completed")
        .map((event) => ({
          turnId: event.payload?.turnId,
          stopReason: event.payload?.stopReason
        })),
      [{ turnId: "turn-1", stopReason: "background_agent_idle" }]
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "turn_started" && event.payload?.synthetic === true
      ),
      false
    );
  } finally {
    restoreSink();
  }
});

test("session idle settles coalesced delegated notifications without result-count pairing", async () => {
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
      ({ prompt }) => fakeCoalescedDelegatedTaskContinuationQuery(prompt)
    );

    await session.start();
    session.exec("turn-1", "delegate six tasks");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(
      events.filter((event) => event.type === "task_completed").length,
      6
    );
    assert.equal(
      events.filter(
        (event) =>
          event.type === "assistant_completed" &&
          String(event.payload?.content ?? "").startsWith("Continuation ")
      ).length,
      3
    );
    assert.equal(
      events.filter(
        (event) =>
          event.type === "sdk_lifecycle_observed" &&
          event.payload?.sdkMessageType === "result" &&
          event.payload?.sdkMessageOrigin === "task-notification"
      ).length,
      3
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "sdk_lifecycle_observed" &&
          event.payload?.sdkMessageSubtype === "session_state_changed" &&
          event.payload?.state === "idle"
      )
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "turn_completed")
        .map((event) => event.payload?.turnId),
      ["turn-1"]
    );
  } finally {
    restoreSink();
  }
});

test("task-notification results wait for delayed session idle", async () => {
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
        fakeCoalescedDelegatedTaskContinuationQuery(prompt, {
          idleDelayMs: 40
        })
    );

    await session.start();
    session.exec("turn-1", "delegate six tasks");
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(
      events.some((event) => event.type === "turn_completed"),
      false
    );

    await waitForEvent(events, "turn_completed");
    const completed = events.find((event) => event.type === "turn_completed");
    assert.equal(completed?.payload?.turnId, "turn-1");
    assert.equal(completed?.payload?.stopReason, "background_agent_idle");
    assert.equal(completed?.payload?.syntheticTimeout, undefined);
  } finally {
    restoreSink();
  }
});

test("delegated continuation start timeout interrupts and closes its synthetic turn", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  let interrupts = 0;
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
        fakeTimedOutDelegatedTaskQuery(prompt, () => {
          interrupts += 1;
        }),
      5
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "task_completed");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const delayed = events.find(
      (event) =>
        event.type === "continuation_delayed" &&
        String(event.payload?.turnId ?? "").startsWith("synthetic-")
    );
    assert.match(String(delayed?.payload?.turnId ?? ""), /^synthetic-/);
    assert.equal(delayed?.payload?.waitedMs, 5);
    const timedOut = events.find(
      (event) =>
        event.type === "turn_completed" &&
        event.payload?.syntheticTimeout === true
    );
    assert.equal(timedOut?.payload?.turnId, delayed?.payload?.turnId);
    assert.equal(
      timedOut?.payload?.stopReason,
      "background_agent_continuation_timeout"
    );
    assert.equal(interrupts, 1);
  } finally {
    restoreSink();
  }
});

test("background task level reserves continuation when terminal task edges are missing", async () => {
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
      ({ prompt }) => fakeBackgroundTasksLevelContinuationQuery(prompt),
      5
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "background_tasks_quiesced");

    const synthetic = events.find(
      (event) =>
        event.type === "turn_started" && event.payload?.synthetic === true
    );
    const syntheticTurnId = String(synthetic?.payload?.turnId ?? "");
    assert.match(syntheticTurnId, /^synthetic-/u);
    assert.ok(
      events.some(
        (event) =>
          event.type === "background_tasks_changed" &&
          event.payload?.backgroundTasksObservedCount === 1 &&
          event.payload?.backgroundTasksRunningCount === 0 &&
          event.payload?.backgroundTasksNoLongerLiveCount === 1 &&
          event.payload?.delegatedTasksKnownCount === 1 &&
          event.payload?.delegatedTasksRunningCount === 1 &&
          event.payload?.delegatedTasksCompletedCount === 0
      )
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "background_tasks_quiesced" &&
          event.payload?.runningCount === 0
      )
    );
    assert.equal(
      events.some((event) => event.type === "turn_waiting"),
      false
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "continuation_delayed" &&
          event.payload?.turnId === syntheticTurnId
      )
    );
    assert.equal(
      events.some((event) => event.type === "turn_running"),
      false
    );
    assert.equal(
      events.some((event) => event.type === "task_completed"),
      false
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "turn_completed" &&
          event.payload?.turnId === syntheticTurnId &&
          event.payload?.syntheticTimeout === true &&
          event.payload?.stopReason === "background_agent_continuation_timeout"
      )
    );
    assert.equal(
      events.filter((event) => event.type === "assistant_completed").length,
      0
    );
  } finally {
    restoreSink();
  }
});

test("cancel during delegated continuation wait disarms timeout", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  let interrupts = 0;
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
        fakeTimedOutDelegatedTaskQuery(prompt, () => {
          interrupts += 1;
        }),
      100
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "task_completed");
    await session.cancel();
    await waitForEvent(events, "turn_canceled");
    await new Promise((resolve) => setTimeout(resolve, 120));

    const canceled = events.find(
      (event) =>
        event.type === "turn_canceled" &&
        String(event.payload?.turnId ?? "").startsWith("synthetic-")
    );
    assert.ok(canceled);
    assert.equal(
      events.some((event) => event.payload?.syntheticTimeout === true),
      false
    );
    assert.equal(interrupts, 1);
  } finally {
    restoreSink();
  }
});

test("cancel clears a pending background-task quiescence timer", async () => {
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
      ({ prompt }) => fakeCancelableBackgroundTaskLevelQuery(prompt)
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForMatchingEvent(
      events,
      (event) =>
        event.type === "background_tasks_changed" &&
        event.payload?.backgroundTasksRunningCount === 0,
      "empty background task level"
    );
    await session.cancel();
    await waitForEvent(events, "turn_canceled");
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(
      events.some((event) => event.type === "background_tasks_quiesced"),
      false
    );
  } finally {
    restoreSink();
  }
});

for (const lateSignal of ["empty-level", "task-notification"] as const) {
  test(`failed root ignores late ${lateSignal} continuation reservation`, async () => {
    const events: Array<{ type: string; payload?: Record<string, unknown> }> =
      [];
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
        ({ prompt }) => fakeFailedBackgroundTaskSignalQuery(prompt, lateSignal)
      );

      await session.start();
      session.exec("turn-1", "delegate task");
      await waitForEvent(events, "turn_failed");
      await waitForMatchingEvent(
        events,
        (event) =>
          lateSignal === "empty-level"
            ? event.type === "background_tasks_changed" &&
              event.payload?.backgroundTasksRunningCount === 0
            : event.type === "task_completed",
        `late ${lateSignal}`
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(
        events.some(
          (event) =>
            event.type === "turn_started" && event.payload?.synthetic === true
        ),
        false
      );
      await session.close();
    } finally {
      restoreSink();
    }
  });
}

test("guidance during delegated continuation wait stays on reserved synthetic turn", async () => {
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
      ({ prompt }) => fakeGuidedDelegatedContinuationQuery(prompt),
      100
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "task_completed");
    const reserved = events.find((event) => event.type === "turn_started");
    await session.guide("include the child result");
    await waitForEvent(events, "assistant_completed");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.match(String(reserved?.payload?.turnId ?? ""), /^synthetic-/);
    assert.equal(
      events.filter((event) => event.type === "turn_started").length,
      1
    );
    const assistant = events.find(
      (event) =>
        event.type === "assistant_completed" &&
        event.payload?.content === "Guided continuation."
    );
    assert.equal(assistant?.payload?.turnId, reserved?.payload?.turnId);
    const completed = events.find(
      (event) =>
        event.type === "turn_completed" &&
        event.payload?.turnId === reserved?.payload?.turnId
    );
    assert.ok(completed);
  } finally {
    restoreSink();
  }
});

async function waitForMatchingEvent(
  events: Array<{ type: string; payload?: Record<string, unknown> }>,
  predicate: (event: {
    type: string;
    payload?: Record<string, unknown>;
  }) => boolean,
  description: string
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (events.some(predicate)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(
    `timed out waiting for ${description}; events=${JSON.stringify(events)}`
  );
}

test("background bash completes its launch without gating the root turn or becoming a child task", async () => {
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
      ({ prompt }) => fakeBackgroundBashAndSubagentQuery(prompt),
      50
    );

    await session.start();
    session.exec("turn-1", "delegate and background");
    await waitForEvent(events, "turn_started");

    const bashStarted = events.find(
      (event) =>
        event.type === "task_started" && event.payload?.taskId === "bs-1"
    );
    assert.equal(bashStarted, undefined);
    const bashCompleted = events.find(
      (event) =>
        event.type === "tool_completed" &&
        event.payload?.toolCallId === "toolu-bash"
    );
    assert.equal(bashCompleted?.payload?.turnId, "turn-1");
    assert.deepEqual(
      (bashCompleted?.payload?.metadata as Record<string, unknown> | undefined)
        ?.backgroundProcess,
      {
        taskId: "bs-1",
        status: "running"
      }
    );

    const agentCompletedIndex = events.findIndex(
      (event) =>
        event.type === "task_completed" && event.payload?.taskId === "task-1"
    );
    const rootCompletedIndex = events.findIndex(
      (event) =>
        event.type === "turn_completed" && event.payload?.turnId === "turn-1"
    );
    const syntheticStartedIndex = events.findIndex(
      (event) =>
        event.type === "turn_started" && event.payload?.synthetic === true
    );
    assert.ok(agentCompletedIndex >= 0);
    assert.ok(rootCompletedIndex >= 0);
    // The delegated Agent still owns its provider continuation. The detached
    // process remains alive but contributes no child task or continuation.
    assert.ok(syntheticStartedIndex >= 0);
    assert.ok(syntheticStartedIndex < agentCompletedIndex);
    assert.equal(
      events.some(
        (event) =>
          (event.type === "task_completed" ||
            event.type === "task_result_updated") &&
          event.payload?.taskId === "bs-1"
      ),
      false
    );
    // Disarm the short continuation timer so it cannot leak into later tests.
    await session.close();
  } finally {
    restoreSink();
  }
});

test("long-running background bash does not keep a completed root turn busy", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
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
    ({ prompt }) => fakeLongRunningBackgroundBashQuery(prompt),
    50
  );
  try {
    await session.start();
    session.exec("turn-1", "start a persistent web server");
    await waitForMatchingEvent(
      events,
      (event) =>
        event.type === "turn_completed" && event.payload?.turnId === "turn-1",
      "completed root turn"
    );

    const bashCompleted = events.find(
      (event) =>
        event.type === "tool_completed" &&
        event.payload?.toolCallId === "toolu-bash"
    );
    assert.deepEqual(
      (bashCompleted?.payload?.metadata as Record<string, unknown> | undefined)
        ?.backgroundProcess,
      {
        status: "running"
      }
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "task_started" && event.payload?.taskId === "bs-1"
      ),
      false
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "turn_started" && event.payload?.synthetic === true
      ),
      false
    );
  } finally {
    await session.close();
    restoreSink();
  }
});

test("stopTask stops a running delegated task without opening a synthetic continuation", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const stopCalls: string[] = [];
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
        fakeStoppableDelegatedTaskQuery(prompt, (taskId) =>
          stopCalls.push(taskId)
        ),
      5
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "turn_completed");

    const stopped = await session.stopTask("task-1");
    assert.equal(stopped, true);
    assert.deepEqual(stopCalls, ["task-1"]);
    await waitForEvent(events, "task_completed");
    // Leave room for an (incorrect) synthetic continuation timer to fire.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const taskCompleted = events.find(
      (event) => event.type === "task_completed"
    );
    assert.equal(taskCompleted?.payload?.status, "stopped");
    assert.equal(taskCompleted?.payload?.parentToolUseId, "toolu-agent");

    const syntheticStarted = events.find(
      (event) =>
        event.type === "turn_started" && event.payload?.synthetic === true
    );
    assert.equal(syntheticStarted, undefined);
    assert.equal(
      events.some((event) => event.payload?.syntheticTimeout === true),
      false
    );
  } finally {
    restoreSink();
  }
});

test("stopTask resolves the task id from the parent tool call id", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const stopCalls: string[] = [];
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
        fakeStoppableDelegatedTaskQuery(prompt, (taskId) =>
          stopCalls.push(taskId)
        )
    );

    await session.start();
    session.exec("turn-1", "delegate task");
    await waitForEvent(events, "turn_completed");

    assert.equal(await session.stopTask("", "toolu-agent"), true);
    assert.deepEqual(stopCalls, ["task-1"]);

    // Unknown ids must not dispatch a stop.
    assert.equal(await session.stopTask("task-unknown"), false);
    assert.equal(await session.stopTask("", "toolu-unknown"), false);
    assert.deepEqual(stopCalls, ["task-1"]);
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
