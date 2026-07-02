import assert from "node:assert/strict";
import test from "node:test";
import type {
  Options as ClaudeQueryOptions,
  SDKMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import { SessionRuntime, withSidecarEventSinkForTest } from "./main.ts";
import { sidecarClaudeOptionsFromPayload } from "./options.ts";

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

test("query enables bypass permission capability for later live mode switch", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  const previousSandbox = process.env.IS_SANDBOX;
  let capturedOptions:
    | {
        allowDangerouslySkipPermissions?: boolean;
        permissionMode?: string;
      }
    | undefined;
  process.env.IS_SANDBOX = "1";
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
      ({ prompt, options }) => {
        capturedOptions = options;
        return fakeSimpleResultQuery(prompt);
      }
    );

    await session.start();
    session.exec("turn-1", "hello");
    await waitForEvent(events, "turn_completed");

    assert.equal(capturedOptions?.permissionMode, "default");
    assert.equal(capturedOptions?.allowDangerouslySkipPermissions, true);
  } finally {
    if (previousSandbox === undefined) {
      delete process.env.IS_SANDBOX;
    } else {
      process.env.IS_SANDBOX = previousSandbox;
    }
    restoreSink();
  }
});

test("session start emits SDK model config options from initialization", async () => {
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
        model: "mimo-v2.5-pro",
        permissionModeId: "default",
        planMode: false,
        effort: "",
        speed: ""
      },
      sidecarClaudeOptionsFromPayload({}),
      undefined,
      ({ prompt }) =>
        fakeQueryWithInitializationModels(prompt, [
          {
            value: "default",
            displayName: "Default",
            description: "Provider default"
          },
          {
            value: "mimo-v2.5-pro",
            displayName: "Mimo v2.5 Pro",
            description: "Custom Mimo model"
          }
        ])
    );

    await session.start();

    const started = events.find((event) => event.type === "session_started");
    const configOptions = started?.payload?.configOptions as
      | Array<Record<string, unknown>>
      | undefined;
    const modelOption = configOptions?.find((option) => option.id === "model");
    const modelOptions = modelOption?.options as
      | Array<Record<string, unknown>>
      | undefined;
    assert.equal(modelOption?.currentValue, "mimo-v2.5-pro");
    assert.deepEqual(
      modelOptions?.map((option) => ({
        value: option.value,
        name: option.name,
        description: option.description
      })),
      [
        {
          value: "default",
          name: "Default",
          description: "Provider default"
        },
        {
          value: "mimo-v2.5-pro",
          name: "Mimo v2.5 Pro",
          description: "Custom Mimo model"
        }
      ]
    );
  } finally {
    restoreSink();
  }
});

test("late compact boundary still attaches to slash compact turn", async () => {
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
        fakeCompactBoundaryQuery(prompt, { boundaryAfterResult: true })
    );

    await session.start();
    session.exec("turn-late", "/compact");
    await waitForEvent(events, "turn_completed");
    await waitForEvent(events, "compact_completed");

    const compactEvent = events.find(
      (event) => event.type === "compact_completed"
    );
    assert.equal(compactEvent?.payload?.turnId, "turn-late");

    const usage = events.find((event) => event.type === "usage_updated");
    assert.equal(usage?.payload?.turnId, "turn-late");
  } finally {
    restoreSink();
  }
});

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

test("bypass permission mode allows ordinary tools without approval", async () => {
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
        permissionModeId: "bypassPermissions",
        planMode: false,
        effort: "",
        speed: ""
      },
      sidecarClaudeOptionsFromPayload({}),
      undefined,
      ({ prompt, options }) =>
        fakePermissionCheckQuery(prompt, options, async (queryOptions) => {
          permissionResult = await queryOptions.canUseTool?.(
            "Bash",
            { command: "rm -rf /repo/*" },
            {
              signal: new AbortController().signal,
              toolUseID: "toolu-bash"
            }
          );
        })
    );

    await session.start();
    session.exec("turn-1", "delete everything");
    await waitForEvent(events, "turn_completed");

    assert.equal(
      events.some((event) => event.type === "approval_requested"),
      false
    );
    assert.deepEqual(permissionResult, {
      behavior: "allow",
      updatedInput: { command: "rm -rf /repo/*" }
    });
  } finally {
    restoreSink();
  }
});

test("bypass permission mode still surfaces AskUserQuestion", async () => {
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
        permissionModeId: "bypassPermissions",
        planMode: false,
        effort: "",
        speed: ""
      },
      sidecarClaudeOptionsFromPayload({}),
      undefined,
      ({ prompt, options }) =>
        fakePermissionCheckQuery(prompt, options, async (queryOptions) => {
          permissionResult = await queryOptions.canUseTool?.(
            "AskUserQuestion",
            {
              questions: [
                {
                  header: "Confirm",
                  question: "Delete everything?",
                  options: [{ label: "Yes", description: "Delete files" }]
                }
              ]
            },
            {
              signal: new AbortController().signal,
              toolUseID: "toolu-ask"
            }
          );
        })
    );

    await session.start();
    session.exec("turn-1", "delete everything");
    await waitForEvent(events, "user_input_requested");

    const request = events.find(
      (event) => event.type === "user_input_requested"
    );
    session.submitInteractive(
      String(request?.payload?.requestId ?? ""),
      "submit",
      "Yes",
      {
        answers: ["Yes"],
        answersByQuestionId: { "question-1": "Yes" }
      }
    );
    await waitForEvent(events, "turn_completed");

    assert.equal(
      events.some((event) => event.type === "approval_requested"),
      false
    );
    assert.deepEqual(permissionResult, {
      behavior: "allow",
      updatedInput: {
        questions: [
          {
            header: "Confirm",
            question: "Delete everything?",
            options: [{ label: "Yes", description: "Delete files" }]
          }
        ],
        answers: { "Delete everything?": "Yes" }
      }
    });
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

function fakeRacedDelegatedTaskAliasQuery(
  prompt: AsyncIterable<SDKUserMessage>
): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield delegatedAgentToolUse("toolu-agent-1", "First task");
      yield delegatedAgentToolResult("toolu-agent-1", "agent-1");
      // Claude Code puts the agent id into task_id; this event races ahead of
      // the second launch result, so its alias is still unknown here.
      yield {
        type: "system",
        subtype: "task_started",
        task_id: "agent-2",
        description: "Second task"
      } as unknown as SDKMessage;
      yield delegatedAgentToolUse("toolu-agent-2", "Second task");
      yield delegatedAgentToolResult("toolu-agent-2", "agent-2");
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      yield {
        type: "system",
        subtype: "task_notification",
        task_id: "agent-2",
        status: "completed",
        summary: "Second task complete"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function fakeDelegatedTaskQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  options: {
    omitNotificationIds?: boolean;
    skipNotification?: boolean;
    continueAfterNotification?: boolean;
    progressAfterNotification?: boolean;
  } = {}
): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield {
        type: "assistant",
        uuid: "assistant-1",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-agent",
              name: "Agent",
              input: {
                description: "Explore codebase structure",
                prompt: "Find files"
              }
            }
          ]
        }
      } as unknown as SDKMessage;
      yield {
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-agent",
              content:
                "Async agent launched successfully\nagentId: agent-1\noutput_file: /tmp/agent-1.output"
            }
          ]
        }
      } as unknown as SDKMessage;
      yield {
        type: "system",
        subtype: "task_started",
        task_id: "task-1",
        agent_id: "agent-1",
        description: "Explore codebase structure"
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      if (options.skipNotification) {
        return;
      }
      yield {
        type: "system",
        subtype: "task_notification",
        ...(options.omitNotificationIds ? {} : { task_id: "task-1" }),
        status: "completed",
        summary: "Found files"
      } as unknown as SDKMessage;
      if (options.progressAfterNotification) {
        yield {
          type: "system",
          subtype: "task_progress",
          task_id: "task-1",
          description: "Explore codebase structure"
        } as unknown as SDKMessage;
      }
      if (!options.continueAfterNotification) {
        return;
      }
      yield {
        type: "assistant",
        uuid: "assistant-2",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Continuing after child agent."
            }
          ]
        }
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function fakeDelegatedAssistantParentQuery({
  prompt
}: {
  prompt: AsyncIterable<SDKUserMessage>;
}): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield delegatedAgentToolUse("toolu-agent", "Child task");
      yield delegatedAgentToolResult("toolu-agent", "agent-1");
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      // Mid-run child streaming: assistant messages tagged with the parent
      // tool use id arrive while the child is still working and must not
      // settle the delegated task.
      yield {
        type: "assistant",
        uuid: "assistant-child-1",
        parent_tool_use_id: "toolu-agent",
        session_id: "provider-session-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Still working on the child task" }]
        }
      } as unknown as SDKMessage;
      yield {
        type: "system",
        subtype: "task_progress",
        task_id: "agent-1",
        description: "Child task"
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        parent_tool_use_id: "toolu-agent",
        result: "Child result ready"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function fakeSimpleResultQuery(
  prompt: AsyncIterable<SDKUserMessage>
): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function fakeEarlyConsolidatedAssistantQuery(
  prompt: AsyncIterable<SDKUserMessage>
): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-message-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "message_start",
          message: { id: "msg-early" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_start",
          index: 5,
          content_block: { type: "text", text: "" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-delta",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_delta",
          index: 5,
          delta: { type: "text_delta", text: "Done." }
        }
      } as unknown as SDKMessage;
      yield consolidatedAssistant("assistant-early", "msg-early", [
        { type: "text", text: "Done." }
      ]);
      yield {
        type: "stream_event",
        uuid: "stream-text-stop",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: { type: "content_block_stop", index: 5 }
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function fakePartialStreamAssistantQuery(
  prompt: AsyncIterable<SDKUserMessage>
): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-message-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "message_start",
          message: { id: "msg-partial" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_start",
          index: 2,
          content_block: { type: "text", text: "" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-delta",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_delta",
          index: 2,
          delta: { type: "text_delta", text: "hello" }
        }
      } as unknown as SDKMessage;
      yield consolidatedAssistant("assistant-partial", "msg-partial", [
        { type: "text", text: "hello world" }
      ]);
      yield {
        type: "stream_event",
        uuid: "stream-text-stop",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: { type: "content_block_stop", index: 2 }
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function fakeNonStreamingAssistantQuery(
  prompt: AsyncIterable<SDKUserMessage>
): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield consolidatedAssistant("assistant-fallback", "msg-fallback", [
        { type: "text", text: "Offline answer." }
      ]);
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function fakeInterleavedAssistantQuery(
  prompt: AsyncIterable<SDKUserMessage>
): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-message-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "message_start",
          message: { id: "msg-interleaved" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-thinking-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-thinking-delta",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Need a skill." }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-thinking-stop",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: { type: "content_block_stop", index: 0 }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-1-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_start",
          index: 4,
          content_block: { type: "text", text: "" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-1-delta",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_delta",
          index: 4,
          delta: { type: "text_delta", text: "Before tool." }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-1-stop",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: { type: "content_block_stop", index: 4 }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_start",
          index: 8,
          content_block: {
            type: "tool_use",
            id: "toolu-interleaved",
            name: "Grep",
            input: { pattern: "assistant" }
          }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: { type: "content_block_stop", index: 8 }
      } as unknown as SDKMessage;
      yield {
        type: "user",
        uuid: "user-tool-result",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-interleaved",
              content: "result"
            }
          ]
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-2-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_start",
          index: 12,
          content_block: { type: "text", text: "" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-2-delta",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_delta",
          index: 12,
          delta: { type: "text_delta", text: "After tool." }
        }
      } as unknown as SDKMessage;
      yield {
        type: "assistant",
        uuid: "assistant-interleaved",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        message: {
          id: "msg-interleaved",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Need a skill." },
            { type: "text", text: "Before tool." },
            {
              type: "tool_use",
              id: "toolu-interleaved",
              name: "Grep",
              input: { pattern: "assistant" }
            },
            { type: "text", text: "After tool." }
          ]
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-2-stop",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: { type: "content_block_stop", index: 12 }
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function consolidatedAssistant(
  uuid: string,
  id: string,
  content: Array<Record<string, unknown>>
): SDKMessage {
  return {
    type: "assistant",
    uuid,
    parent_tool_use_id: null,
    session_id: "provider-session-1",
    message: {
      id,
      role: "assistant",
      content
    }
  } as unknown as SDKMessage;
}

function fakeQueryWithInitializationModels(
  prompt: AsyncIterable<SDKUserMessage>,
  models: Array<Record<string, unknown>>
): AsyncIterable<SDKMessage> & {
  initializationResult: () => Promise<unknown>;
  close: () => void;
} {
  return {
    async initializationResult() {
      return { models };
    },
    async *[Symbol.asyncIterator]() {
      yield* fakeSimpleResultQuery(prompt);
    },
    close() {}
  };
}

function fakeCompactBoundaryQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  options: { boundaryAfterResult?: boolean } = {}
): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      if (options.boundaryAfterResult) {
        yield {
          type: "result",
          subtype: "success"
        } as unknown as SDKMessage;
      }
      yield {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          pre_tokens: 2400,
          post_tokens: 800
        }
      } as unknown as SDKMessage;
      if (options.boundaryAfterResult) {
        return;
      }
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function fakePermissionCheckQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  options: ClaudeQueryOptions,
  check: (options: ClaudeQueryOptions) => Promise<void>
): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      await check(options);
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function fakeConcurrentDelegatedTaskCreatedHookQuery({
  prompt,
  options
}: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: unknown;
}): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield delegatedAgentToolUse("toolu-agent-1", "First task");
      yield delegatedAgentToolResult("toolu-agent-1", "agent-1");
      await emitTestHooks(options, "TaskCreated", {
        hook_event_name: "TaskCreated",
        task_id: "task-2",
        task_subject: "Second task",
        task_description: "Second task"
      });
      yield delegatedAgentToolUse("toolu-agent-2", "Second task");
      yield delegatedAgentToolResult("toolu-agent-2", "agent-2");
      yield {
        type: "system",
        subtype: "task_started",
        task_id: "task-2",
        agent_id: "agent-2",
        description: "Second task"
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      yield {
        type: "system",
        subtype: "task_notification",
        task_id: "task-2",
        status: "completed",
        summary: "Second task complete"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function delegatedAgentToolUse(id: string, description: string): SDKMessage {
  return {
    type: "assistant",
    uuid: `${id}-assistant`,
    parent_tool_use_id: null,
    session_id: "provider-session-1",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id,
          name: "Agent",
          input: {
            description,
            prompt: description
          }
        }
      ]
    }
  } as unknown as SDKMessage;
}

function delegatedAgentToolResult(id: string, agentId: string): SDKMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    session_id: "provider-session-1",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: `Async agent launched successfully\nagentId: ${agentId}\noutput_file: /tmp/${agentId}.output`
        }
      ]
    }
  } as unknown as SDKMessage;
}

function fakeDelegatedTaskCompletedHookQuery({
  prompt,
  options
}: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: unknown;
}): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* fakeDelegatedTaskQuery(prompt, { skipNotification: true });
      await emitTestHooks(options, "TaskCompleted", {
        hook_event_name: "TaskCompleted",
        task_id: "task-1",
        task_subject: "Explore codebase structure",
        task_description: "Explore codebase structure",
        summary: "Found files"
      });
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

type TestHookOptions = {
  hooks?: Record<
    string,
    Array<{
      hooks: unknown[];
    }>
  >;
};

async function emitTestHooks(
  options: unknown,
  name: string,
  input: Record<string, unknown>
): Promise<void> {
  const hookOptions = options as TestHookOptions;
  for (const entry of hookOptions.hooks?.[name] ?? []) {
    for (const hook of entry.hooks) {
      await (hook as (value: unknown) => Promise<unknown>)(input);
    }
  }
}

function fakeDelegatedTextOnlyCompletionQuery({
  prompt
}: {
  prompt: AsyncIterable<SDKUserMessage>;
}): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield delegatedAgentToolUse("toolu-agent", "Child task");
      yield delegatedAgentToolResult("toolu-agent", "agent-1");
      yield {
        type: "assistant",
        uuid: "assistant-child-final",
        parent_tool_use_id: "toolu-agent",
        session_id: "provider-session-1",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "7" }]
        }
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function fakeFoldInTaskNotificationQuery({
  prompt
}: {
  prompt: AsyncIterable<SDKUserMessage>;
}): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield delegatedAgentToolUse("toolu-agent", "Child task");
      yield delegatedAgentToolResult("toolu-agent", "agent-1");
      yield {
        type: "attachment",
        uuid: "attachment-fold-in",
        session_id: "provider-session-1",
        attachment: {
          type: "queued_command",
          commandMode: "task-notification",
          prompt: `<task-notification>
<task-id>agent-1</task-id>
<tool-use-id>toolu-agent</tool-use-id>
<status>completed</status>
<summary>Agent "Child task" finished</summary>
<result>7</result>
</task-notification>`
        }
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function fakeUserTaskNotificationQuery({
  prompt
}: {
  prompt: AsyncIterable<SDKUserMessage>;
}): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield delegatedAgentToolUse("toolu-agent", "Child task");
      yield delegatedAgentToolResult("toolu-agent", "agent-1");
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      yield {
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        message: {
          role: "user",
          content: `<task-notification>
<task-id>agent-1</task-id>
<tool-use-id>toolu-agent</tool-use-id>
<status>completed</status>
<summary>Agent "Child task" finished</summary>
</task-notification>`
        }
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

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

    session.submitInteractive(
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

function fakeNestedDelegatedLaunchQuery({
  prompt
}: {
  prompt: AsyncIterable<SDKUserMessage>;
}): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield delegatedAgentToolUse("toolu-parent", "Parent task");
      yield delegatedAgentToolResult("toolu-parent", "agent-parent");
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      // Child stream: the child agent launches a grandchild Task after the
      // launching turn already settled.
      yield nestedAssistantToolUse(
        "toolu-parent",
        "toolu-child",
        "Grandchild task"
      );
      yield nestedAgentLaunchResult(
        "toolu-parent",
        "toolu-child",
        "agent-child"
      );
      yield userTaskNotification("agent-child", "toolu-child");
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function fakeNestedLaunchWithoutToolUseQuery({
  prompt
}: {
  prompt: AsyncIterable<SDKUserMessage>;
}): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield delegatedAgentToolUse("toolu-parent", "Parent task");
      yield delegatedAgentToolResult("toolu-parent", "agent-parent");
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      // Only the launch result streams through; the grandchild tool_use block
      // was never observed, so the local tool name is unknown.
      yield nestedAgentLaunchResult(
        "toolu-parent",
        "toolu-child",
        "agent-child"
      );
      yield userTaskNotification("agent-child", "toolu-child");
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function fakeNestedApprovalQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  options: ClaudeQueryOptions,
  onPermissionResult: (result: unknown) => void
): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield delegatedAgentToolUse("toolu-parent", "Parent task");
      yield delegatedAgentToolResult("toolu-parent", "agent-parent");
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      yield {
        type: "system",
        subtype: "task_notification",
        task_id: "agent-parent",
        status: "completed",
        summary: "Parent done"
      } as unknown as SDKMessage;
      // A grandchild tool runs after the parent task completed; its approval
      // must still resolve a turn id or the approval card never surfaces.
      const result = await options.canUseTool?.(
        "Bash",
        { command: "ls" },
        {
          signal: new AbortController().signal,
          toolUseID: "toolu-nested-bash"
        }
      );
      onPermissionResult(result);
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function fakeNestedDeferredParentCompletionQuery({
  prompt
}: {
  prompt: AsyncIterable<SDKUserMessage>;
}): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield delegatedAgentToolUse("toolu-parent", "Parent task");
      yield delegatedAgentToolResult("toolu-parent", "agent-parent");
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      yield nestedAssistantToolUse(
        "toolu-parent",
        "toolu-child",
        "Grandchild task"
      );
      yield nestedAgentLaunchResult(
        "toolu-parent",
        "toolu-child",
        "agent-child"
      );
      // The child ends its own turn while the grandchild is still running;
      // this must not settle the child's delegated task yet.
      yield nestedEndTurnAssistant(
        "toolu-parent",
        "assistant-premature-end",
        "All grandchildren launched."
      );
      yield userTaskNotification("agent-child", "toolu-child");
      yield nestedEndTurnAssistant(
        "toolu-parent",
        "assistant-final-end",
        "Parent finished."
      );
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

function nestedAssistantToolUse(
  parentToolUseId: string,
  id: string,
  description: string
): SDKMessage {
  return {
    type: "assistant",
    uuid: `${id}-nested-assistant`,
    parent_tool_use_id: parentToolUseId,
    session_id: "provider-session-1",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id,
          name: "Task",
          input: {
            description,
            prompt: description
          }
        }
      ]
    }
  } as unknown as SDKMessage;
}

function nestedAgentLaunchResult(
  parentToolUseId: string,
  toolUseId: string,
  agentId: string
): SDKMessage {
  return {
    type: "user",
    parent_tool_use_id: parentToolUseId,
    session_id: "provider-session-1",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: `Async agent launched successfully\nagentId: ${agentId}\noutput_file: /tmp/${agentId}.output`
        }
      ]
    }
  } as unknown as SDKMessage;
}

function nestedEndTurnAssistant(
  parentToolUseId: string,
  uuid: string,
  text: string
): SDKMessage {
  return {
    type: "assistant",
    uuid,
    parent_tool_use_id: parentToolUseId,
    session_id: "provider-session-1",
    message: {
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text }]
    }
  } as unknown as SDKMessage;
}

function userTaskNotification(taskId: string, toolUseId: string): SDKMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    session_id: "provider-session-1",
    message: {
      role: "user",
      content: `<task-notification>
<task-id>${taskId}</task-id>
<tool-use-id>${toolUseId}</tool-use-id>
<status>completed</status>
<summary>done</summary>
</task-notification>`
    }
  } as unknown as SDKMessage;
}

async function waitForEvent(
  events: Array<{ type: string }>,
  type: string
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (events.some((event) => event.type === type)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(
    `timed out waiting for ${type}; events=${JSON.stringify(events)}`
  );
}
