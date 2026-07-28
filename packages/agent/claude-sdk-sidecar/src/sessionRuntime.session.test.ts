import assert from "node:assert/strict";
import test from "node:test";
import { withSidecarEventSinkForTest } from "./eventSink.ts";
import { SessionRuntime } from "./sessionRuntime.ts";
import { sidecarClaudeOptionsFromPayload } from "./options.ts";
import { isRecord, testCanUseToolOptions } from "./sessionRuntimeTestCommon.ts";
import {
  fakeContextUsageQuery,
  fakeSimpleResultQuery
} from "./sessionRuntimeTestQueries.delegated.ts";
import { fakeQueryWithInitializationModels } from "./sessionRuntimeTestQueries.assistant.ts";
import {
  fakeCompactBoundaryQuery,
  fakeDeferredContextUsageQuery,
  fakeFailedCompactQuery,
  fakeGuidancePromptQuery,
  fakePermissionCheckQuery,
  fakeStatusOnlyCompactQuery
} from "./sessionRuntimeTestQueries.session.ts";
import { waitForEvent } from "./sessionRuntimeTestQueries.nested.ts";

test("tutti host context shares one SDK prompt with unchanged user input", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const messages: Array<{
    textBlocks: string[];
    isSynthetic?: boolean;
    shouldQuery?: boolean;
    origin?: unknown;
  }> = [];
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
      ({ prompt }) => ({
        async *[Symbol.asyncIterator]() {
          const iterator = prompt[Symbol.asyncIterator]();
          const next = await iterator.next();
          const message = next.value!;
          const content = message.message.content;
          messages.push({
            textBlocks: Array.isArray(content)
              ? content.flatMap((block) =>
                  block.type === "text" ? [block.text] : []
                )
              : [content],
            isSynthetic: message.isSynthetic,
            shouldQuery: message.shouldQuery,
            origin: message.origin
          });
          yield {
            ...message,
            type: "user",
            parent_tool_use_id: null,
            session_id: "provider-session-1"
          } as never;
          yield { type: "result", subtype: "success" } as never;
        },
        close() {}
      })
    );

    await session.start();
    session.exec(
      "turn-1",
      "what mode is active?",
      undefined,
      undefined,
      undefined,
      "<tutti-host-context>active</tutti-host-context>"
    );
    await waitForEvent(events, "turn_completed");

    assert.deepEqual(messages, [
      {
        textBlocks: [
          "<tutti-host-context>active</tutti-host-context>",
          "what mode is active?"
        ],
        isSynthetic: undefined,
        shouldQuery: undefined,
        origin: undefined
      }
    ]);
    assert.equal(
      JSON.stringify(events).includes("<tutti-host-context>"),
      false,
      "host-owned context must not be projected as user-visible activity"
    );
  } finally {
    restoreSink();
  }
});

test("SDK assistant authentication error fails the message and turn", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  const failure =
    "Failed to authenticate. API Error: 401 The API Key appears to be invalid.";
  try {
    const session = new SessionRuntime(
      "provider-session-auth",
      "/repo",
      {},
      false,
      false,
      {
        model: "k3",
        permissionModeId: "default",
        planMode: false,
        effort: "",
        speed: ""
      },
      sidecarClaudeOptionsFromPayload({}),
      undefined,
      ({ prompt }) => ({
        async *[Symbol.asyncIterator]() {
          const iterator = prompt[Symbol.asyncIterator]();
          const message = (await iterator.next()).value!;
          yield {
            ...message,
            type: "user",
            parent_tool_use_id: null,
            session_id: "provider-session-auth"
          } as never;
          yield {
            type: "assistant",
            error: "authentication_failed",
            message: {
              id: "assistant-auth-error",
              role: "assistant",
              content: [{ type: "text", text: failure }]
            },
            parent_tool_use_id: null,
            session_id: "provider-session-auth"
          } as never;
          yield {
            type: "result",
            subtype: "success",
            is_error: true,
            api_error_status: 401,
            result: failure,
            session_id: "provider-session-auth"
          } as never;
        },
        close() {}
      })
    );

    await session.start();
    session.exec("turn-auth", "hello");
    await waitForEvent(events, "turn_failed");

    const failedMessage = events.find(
      (event) => event.type === "assistant_failed"
    );
    assert.equal(failedMessage?.payload?.content, failure);
    const failedTurn = events.find((event) => event.type === "turn_failed");
    assert.equal(failedTurn?.payload?.turnId, "turn-auth");
    assert.equal(failedTurn?.payload?.code, "authentication_failed");
    assert.equal(failedTurn?.payload?.apiErrorStatus, 401);
    assert.equal(
      events.some((event) => event.type === "turn_completed"),
      false
    );
  } finally {
    restoreSink();
  }
});

test("guidance prompt stays on the active SDK turn", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const prompts: string[] = [];
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
      ({ prompt }) => fakeGuidancePromptQuery(prompt, prompts)
    );

    await session.start();
    session.exec("turn-1", "start working");
    session.guide("prefer the focused path");
    await waitForEvent(events, "turn_completed");

    assert.deepEqual(prompts, ["start working", "prefer the focused path"]);
    const completed = events.find((event) => event.type === "turn_completed");
    assert.equal(completed?.payload?.turnId, "turn-1");
    assert.equal(
      events.some(
        (event) =>
          event.type === "turn_completed" && event.payload?.turnId !== "turn-1"
      ),
      false
    );
  } finally {
    restoreSink();
  }
});

async function waitForCondition(
  predicate: () => boolean,
  description: string
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${description}`);
}

test("goal set scheduling ack followed by immediate clear coalesces before SDK activation", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-goal",
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
      ({ prompt }) => fakeSimpleResultQuery(prompt)
    );

    await session.start();
    // Both calls have crossed the sidecar scheduling/ACK boundary before the
    // deferred Goal dispatcher hands either command to the SDK iterable.
    session.exec("goal-set-turn", "/goal ship it", undefined, "goal_arm", {
      operationId: "goal-op-set",
      revision: 1,
      action: "set"
    });
    session.exec("goal-clear-command", "/goal clear", undefined, undefined, {
      operationId: "goal-op-clear",
      revision: 2,
      action: "clear"
    });

    await waitForEvent(events, "goal_command_started");
    await waitForEvent(events, "turn_completed");

    assert.equal(
      events.some(
        (event) =>
          event.type === "turn_started" &&
          event.payload?.turnId === "goal-set-turn"
      ),
      false
    );
    const superseded = events.find(
      (event) => event.type === "goal_command_superseded"
    );
    assert.equal(superseded?.payload?.operationId, "goal-op-set");
    const started = events.find(
      (event) => event.type === "goal_command_started"
    );
    assert.equal(started?.payload?.operationId, "goal-op-clear");
    assert.equal(started?.payload?.revision, 2);
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

test("context usage prefers result modelUsage window over SDK maxTokens", async () => {
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
        model: "sonnet",
        permissionModeId: "default",
        planMode: false,
        effort: "",
        speed: ""
      },
      sidecarClaudeOptionsFromPayload({}),
      undefined,
      ({ prompt }) => fakeContextUsageQuery(prompt)
    );

    await session.start();
    session.exec("turn-1", "hi");
    await waitForEvent(events, "turn_completed");
    await waitForEvent(events, "usage_updated");

    const usage = events.find(
      (event) =>
        event.type === "usage_updated" && isRecord(event.payload?.contextWindow)
    );
    const contextWindow = isRecord(usage?.payload?.contextWindow)
      ? usage.payload.contextWindow
      : undefined;
    assert.equal(contextWindow?.usedTokens, 36_092);
    assert.equal(contextWindow?.totalTokens, 1_000_000);
    assert.equal(
      events.some(
        (event) =>
          event.type === "usage_updated" && isRecord(event.payload?.usage)
      ),
      false,
      "cumulative result usage must not replace the authoritative context snapshot"
    );
  } finally {
    restoreSink();
  }
});

test("turn completion does not wait for context usage and stale snapshots are dropped", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const contextUsageResolvers: Array<(value: unknown) => void> = [];
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
        model: "haiku",
        permissionModeId: "default",
        planMode: false,
        effort: "",
        speed: ""
      },
      sidecarClaudeOptionsFromPayload({}),
      undefined,
      ({ prompt }) =>
        fakeDeferredContextUsageQuery(prompt, contextUsageResolvers)
    );

    await session.start();
    session.exec("turn-1", "first");
    await waitForCondition(
      () =>
        events.some(
          (event) =>
            event.type === "turn_completed" &&
            event.payload?.turnId === "turn-1"
        ),
      "first turn completion"
    );
    assert.equal(contextUsageResolvers.length, 1);

    session.exec("turn-2", "second");
    await waitForCondition(
      () =>
        events.some(
          (event) =>
            event.type === "turn_completed" &&
            event.payload?.turnId === "turn-2"
        ) && contextUsageResolvers.length === 2,
      "second turn completion and context usage request"
    );

    contextUsageResolvers[1]?.({ totalTokens: 222, maxTokens: 200_000 });
    await waitForCondition(
      () =>
        events.some(
          (event) =>
            event.type === "usage_updated" &&
            event.payload?.turnId === "turn-2" &&
            isRecord(event.payload?.contextWindow)
        ),
      "second turn context usage"
    );

    contextUsageResolvers[0]?.({ totalTokens: 111, maxTokens: 200_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      events.some(
        (event) =>
          event.type === "usage_updated" &&
          event.payload?.turnId === "turn-1" &&
          isRecord(event.payload?.contextWindow)
      ),
      false,
      "the delayed first-turn snapshot must not overwrite the newer turn"
    );
  } finally {
    restoreSink();
  }
});

test("result usage remains available when context snapshot is unavailable", async () => {
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
        model: "haiku",
        permissionModeId: "default",
        planMode: false,
        effort: "",
        speed: ""
      },
      sidecarClaudeOptionsFromPayload({}),
      undefined,
      ({ prompt }) =>
        fakeSimpleResultQuery(prompt, {
          usage: {
            input_tokens: 120,
            output_tokens: 8,
            cache_read_input_tokens: 72,
            cache_creation_input_tokens: 0
          }
        })
    );

    await session.start();
    session.exec("turn-usage-fallback", "hi");
    await waitForEvent(events, "turn_completed");

    const usage = events.find(
      (event) =>
        event.type === "usage_updated" && isRecord(event.payload?.usage)
    );
    assert.ok(
      usage,
      "expected result usage when no context query is available"
    );
    assert.equal(usage.payload?.turnId, "turn-usage-fallback");
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

test("compact success reported only via status message still refreshes usage", async () => {
  // Real Claude Code compaction can report completion via the `status`
  // system message (`compact_result: "success"`) without a `compact_boundary`
  // message ever following it in a given ordering/timing window. Before this
  // fix, that path emitted "Compacting completed." without ever refreshing
  // the context-usage percentage, so the GUI usage chip stayed pinned at its
  // pre-compaction value (e.g. 100%) until some unrelated later turn happened
  // to report fresh usage.
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
      ({ prompt }) => fakeStatusOnlyCompactQuery(prompt)
    );

    await session.start();
    session.exec("turn-status-only", "/compact");
    await waitForEvent(events, "turn_completed");
    await waitForEvent(events, "compact_completed");

    const usage = events.find(
      (event) =>
        event.type === "usage_updated" && isRecord(event.payload?.contextWindow)
    );
    const contextWindow = isRecord(usage?.payload?.contextWindow)
      ? usage.payload.contextWindow
      : undefined;
    assert.ok(usage, "expected a usage_updated event carrying contextWindow");
    assert.equal(usage?.payload?.turnId, "turn-status-only");
    assert.equal(contextWindow?.usedTokens, 4_061);
    assert.equal(contextWindow?.totalTokens, 1_000_000);
  } finally {
    restoreSink();
  }
});

test("compact failure preserves the status reason and assistant response", async () => {
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
      ({ prompt }) => fakeFailedCompactQuery(prompt)
    );

    await session.start();
    session.exec("turn-compact-failed", "/compact");
    await waitForEvent(events, "compact_failed");
    await waitForEvent(events, "turn_completed");

    assert.equal(
      events.find((event) => event.type === "compact_failed")?.payload?.content,
      "Compacting failed: Not enough messages to compact."
    );
    assert.equal(
      events.find((event) => event.type === "compact_failed")?.payload?.reason,
      "Not enough messages to compact."
    );
    assert.equal(
      events.find((event) => event.type === "assistant_completed")?.payload
        ?.content,
      "Not enough messages to compact."
    );
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
            testCanUseToolOptions({
              requestId: "request-bash",
              toolUseID: "toolu-bash"
            })
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
            testCanUseToolOptions({
              requestId: "request-ask",
              toolUseID: "toolu-ask"
            })
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
      "turn-1",
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
