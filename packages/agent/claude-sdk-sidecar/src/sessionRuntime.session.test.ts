import assert from "node:assert/strict";
import test from "node:test";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { withSidecarEventSinkForTest } from "./eventSink.ts";
import { SessionRuntime } from "./sessionRuntime.ts";
import { sidecarClaudeOptionsFromPayload } from "./options.ts";
import { isRecord, testCanUseToolOptions } from "./sessionRuntimeTestCommon.ts";
import {
  fakeContextUsageQuery,
  fakeParallelDelegatedTaskContinuationQuery,
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

test("Claude-persisted user UUID becomes the provider Turn identity", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-identity",
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
          const outbound = await iterator.next();
          yield {
            ...outbound.value,
            uuid: "persisted-claude-user-uuid",
            type: "user",
            parent_tool_use_id: null,
            session_id: "provider-session-identity"
          } as never;
          yield { type: "result", subtype: "success" } as never;
        },
        close() {}
      })
    );

    await session.start();
    session.exec(
      "turn-identity",
      "hello",
      undefined,
      undefined,
      undefined,
      "",
      "outbound-correlation-id"
    );
    await waitForEvent(events, "turn_completed");

    const providerStarted = events.find(
      (event) => event.type === "provider_turn_identity_resolved"
    );
    const providerCheckpoint = events.find(
      (event) => event.type === "provider_turn_checkpoint"
    );
    const completed = events.find((event) => event.type === "turn_completed");
    assert.equal(
      providerStarted?.payload?.providerTurnId,
      "persisted-claude-user-uuid"
    );
    assert.equal(
      completed?.payload?.providerTurnId,
      "persisted-claude-user-uuid"
    );
    assert.deepEqual(providerCheckpoint?.payload, {
      turnId: "turn-identity",
      providerTurnId: "persisted-claude-user-uuid",
      providerCheckpointMessageId: "persisted-claude-user-uuid"
    });
  } finally {
    restoreSink();
  }
});

test("successful result recovers provider Turn identity when SDK omits the root user echo", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const recoveryInputs: Array<Record<string, string>> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-recovered",
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
          await prompt[Symbol.asyncIterator]().next();
          yield {
            type: "assistant",
            uuid: "persisted-assistant-uuid",
            parent_tool_use_id: null,
            session_id: "provider-session-recovered",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hello" }]
            }
          } as never;
          yield { type: "result", subtype: "success" } as never;
        },
        close() {}
      }),
      30_000,
      async (input) => {
        recoveryInputs.push(input);
        return {
          providerSessionId: input.sessionId,
          providerTurnId: "persisted-user-uuid",
          providerCheckpointMessageId: "persisted-assistant-uuid"
        };
      }
    );

    await session.start();
    session.exec(
      "turn-recovered",
      "hello",
      undefined,
      undefined,
      undefined,
      "",
      "outbound-correlation-id"
    );
    await waitForEvent(events, "turn_completed");

    assert.deepEqual(recoveryInputs, [
      {
        sessionId: "provider-session-recovered",
        cwd: "/repo",
        recoveryToken: "outbound-correlation-id"
      }
    ]);
    assert.deepEqual(
      events
        .filter((event) =>
          [
            "provider_turn_identity_resolved",
            "provider_turn_checkpoint",
            "turn_completed"
          ].includes(event.type)
        )
        .map(({ type, payload }) => ({ type, payload })),
      [
        {
          type: "provider_turn_identity_resolved",
          payload: {
            turnId: "turn-recovered",
            providerTurnId: "persisted-user-uuid"
          }
        },
        {
          type: "provider_turn_checkpoint",
          payload: {
            turnId: "turn-recovered",
            providerTurnId: "persisted-user-uuid",
            providerCheckpointMessageId: "persisted-assistant-uuid"
          }
        },
        {
          type: "turn_completed",
          payload: {
            stopReason: "end_turn",
            turnId: "turn-recovered",
            providerTurnId: "persisted-user-uuid"
          }
        }
      ]
    );
  } finally {
    restoreSink();
  }
});

test("goal result-only recovery binds provider identity before activation", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-goal-result-only",
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
          await prompt[Symbol.asyncIterator]().next();
          yield { type: "result", subtype: "success" } as never;
        },
        close() {}
      }),
      30_000,
      async (input) => ({
        providerSessionId: input.sessionId,
        providerTurnId: "persisted-goal-user-uuid",
        providerCheckpointMessageId: "persisted-goal-result-uuid"
      })
    );

    await session.start();
    session.exec(
      "goal-result-only",
      "/goal ship it",
      undefined,
      "goal_arm",
      {
        operationId: "goal-op-result",
        revision: 3,
        repairEpoch: 2,
        action: "set"
      },
      "",
      "goal-result-correlation-id"
    );
    await waitForEvent(events, "turn_completed");

    const identityIndex = events.findIndex(
      (event) => event.type === "provider_turn_identity_resolved"
    );
    const startedIndex = events.findIndex(
      (event) => event.type === "turn_started"
    );
    const completedIndex = events.findIndex(
      (event) => event.type === "turn_completed"
    );
    assert.ok(identityIndex >= 0 && identityIndex < startedIndex);
    assert.ok(startedIndex < completedIndex);
    assert.deepEqual(events[identityIndex]?.payload, {
      turnId: "goal-result-only",
      providerTurnId: "persisted-goal-user-uuid",
      turnOrigin: "goal_arm",
      sourceGoalOperationId: "goal-op-result",
      sourceGoalRevision: 3,
      sourceGoalRepairEpoch: 2
    });
    assert.equal(
      events[completedIndex]?.payload?.providerTurnId,
      "persisted-goal-user-uuid"
    );
  } finally {
    restoreSink();
  }
});

test("interactive request recovers provider Turn identity before waiting when SDK omits the root user echo", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const recoveryInputs: Array<Record<string, string>> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  let permissionResult: unknown;
  try {
    const session = new SessionRuntime(
      "provider-session-interactive-recovered",
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
      ({ prompt, options }) => ({
        async *[Symbol.asyncIterator]() {
          await prompt[Symbol.asyncIterator]().next();
          yield {
            type: "assistant",
            uuid: "persisted-tool-assistant-uuid",
            parent_tool_use_id: null,
            session_id: "provider-session-interactive-recovered",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "toolu-write",
                  name: "Write",
                  input: { file_path: "/repo/tetris.html" }
                }
              ]
            }
          } as never;
          permissionResult = await options.canUseTool?.(
            "Write",
            { file_path: "/repo/tetris.html" },
            testCanUseToolOptions({
              requestId: "request-write",
              toolUseID: "toolu-write"
            })
          );
          yield { type: "result", subtype: "success" } as never;
        },
        close() {}
      }),
      30_000,
      async (input) => {
        recoveryInputs.push(input);
        return {
          providerSessionId: input.sessionId,
          providerTurnId: "persisted-tool-user-uuid",
          providerCheckpointMessageId: "persisted-tool-assistant-uuid"
        };
      }
    );

    await session.start();
    session.exec(
      "turn-interactive-recovered",
      "write a file",
      undefined,
      undefined,
      undefined,
      "",
      "outbound-interactive-correlation-id"
    );
    await waitForEvent(events, "approval_requested");

    assert.deepEqual(recoveryInputs, [
      {
        sessionId: "provider-session-interactive-recovered",
        cwd: "/repo",
        recoveryToken: "outbound-interactive-correlation-id"
      }
    ]);
    assert.deepEqual(
      events
        .filter((event) =>
          [
            "provider_turn_identity_resolved",
            "provider_turn_checkpoint",
            "approval_requested"
          ].includes(event.type)
        )
        .map(({ type, payload }) => ({ type, payload })),
      [
        {
          type: "provider_turn_identity_resolved",
          payload: {
            turnId: "turn-interactive-recovered",
            providerTurnId: "persisted-tool-user-uuid"
          }
        },
        {
          type: "provider_turn_checkpoint",
          payload: {
            turnId: "turn-interactive-recovered",
            providerTurnId: "persisted-tool-user-uuid",
            providerCheckpointMessageId: "persisted-tool-assistant-uuid"
          }
        },
        {
          type: "approval_requested",
          payload: events.find((event) => event.type === "approval_requested")
            ?.payload
        }
      ]
    );

    const request = events.find((event) => event.type === "approval_requested");
    session.submitInteractive(
      "turn-interactive-recovered",
      String(request?.payload?.requestId ?? ""),
      "submit",
      "allow",
      {}
    );
    await waitForEvent(events, "turn_completed");

    assert.deepEqual(permissionResult, {
      behavior: "allow",
      updatedInput: { file_path: "/repo/tetris.html" }
    });
    assert.equal(
      events.filter((event) => event.type === "provider_turn_identity_resolved")
        .length,
      1
    );
  } finally {
    restoreSink();
  }
});

test("AskUserQuestion and ExitPlanMode share one accepted identity without root user echo", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  let recoveryCalls = 0;
  try {
    const session = new SessionRuntime(
      "provider-session-multi-interaction",
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
      ({ prompt, options }) => ({
        async *[Symbol.asyncIterator]() {
          await prompt[Symbol.asyncIterator]().next();
          yield {
            type: "assistant",
            uuid: "assistant-before-interactions",
            parent_tool_use_id: null,
            session_id: "provider-session-multi-interaction",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "I need two answers." }]
            }
          } as never;
          await options.canUseTool?.(
            "AskUserQuestion",
            {
              questions: [
                {
                  header: "Choice",
                  question: "Pick one",
                  options: [{ label: "A", description: "Alpha" }]
                }
              ]
            },
            testCanUseToolOptions({
              requestId: "request-ask",
              toolUseID: "toolu-ask"
            })
          );
          await options.canUseTool?.(
            "ExitPlanMode",
            { plan: "Implement the selected option." },
            testCanUseToolOptions({
              requestId: "request-exit-plan",
              toolUseID: "toolu-exit-plan"
            })
          );
          yield { type: "result", subtype: "success" } as never;
        },
        close() {}
      }),
      30_000,
      async (input) => {
        recoveryCalls += 1;
        return {
          providerSessionId: input.sessionId,
          providerTurnId: "provider-turn-multi-interaction",
          providerCheckpointMessageId: "assistant-before-interactions"
        };
      }
    );

    await session.start();
    session.exec(
      "turn-multi-interaction",
      "ask then exit plan",
      undefined,
      undefined,
      undefined,
      "",
      "correlation-multi-interaction"
    );
    await waitForEventCount(events, "user_input_requested", 1);
    const ask = events.find((event) => event.type === "user_input_requested");
    session.submitInteractive(
      "turn-multi-interaction",
      String(ask?.payload?.requestId ?? ""),
      "submit",
      "",
      { answers: { "Pick one": "A" } }
    );
    await waitForEventCount(events, "user_input_requested", 2);
    const exitPlan = events.filter(
      (event) => event.type === "user_input_requested"
    )[1];
    session.submitInteractive(
      "turn-multi-interaction",
      String(exitPlan?.payload?.requestId ?? ""),
      "submit",
      "default",
      {}
    );
    await waitForEvent(events, "turn_completed");

    const ordered = events.filter((event) =>
      [
        "provider_turn_identity_resolved",
        "user_input_requested",
        "turn_completed"
      ].includes(event.type)
    );
    assert.equal(ordered[0]?.type, "provider_turn_identity_resolved");
    assert.equal(
      ordered.filter(
        (event) => event.type === "provider_turn_identity_resolved"
      ).length,
      1
    );
    assert.equal(
      ordered.filter((event) => event.type === "user_input_requested").length,
      2
    );
    assert.equal(recoveryCalls, 1);
    assert.equal(
      ordered.at(-1)?.payload?.providerTurnId,
      "provider-turn-multi-interaction"
    );
  } finally {
    restoreSink();
  }
});

async function waitForEventCount(
  events: Array<{ type: string }>,
  type: string,
  count: number
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (events.filter((event) => event.type === type).length >= count) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${count} ${type} events`);
}

test("ephemeral Claude session state UUID does not replace the durable checkpoint", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-checkpoint",
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
          const outbound = await iterator.next();
          yield {
            ...outbound.value,
            uuid: "persisted-user-uuid",
            type: "user",
            parent_tool_use_id: null,
            session_id: "provider-session-checkpoint"
          } as never;
          yield {
            type: "assistant",
            uuid: "persisted-assistant-uuid",
            parent_tool_use_id: null,
            session_id: "provider-session-checkpoint",
            message: {
              id: "assistant-message",
              role: "assistant",
              content: [{ type: "text", text: "hello" }]
            }
          } as never;
          yield {
            type: "system",
            subtype: "session_state_changed",
            state: "idle",
            uuid: "ephemeral-idle-uuid",
            parent_tool_use_id: null,
            session_id: "provider-session-checkpoint"
          } as never;
          yield { type: "result", subtype: "success" } as never;
        },
        close() {}
      })
    );

    await session.start();
    session.exec(
      "turn-checkpoint",
      "hello",
      undefined,
      undefined,
      undefined,
      "",
      "outbound-correlation-id"
    );
    await waitForEvent(events, "turn_completed");

    const checkpoints = events.filter(
      (event) => event.type === "provider_turn_checkpoint"
    );
    assert.deepEqual(
      checkpoints.map((event) => event.payload?.providerCheckpointMessageId),
      ["persisted-user-uuid", "persisted-assistant-uuid"]
    );
  } finally {
    restoreSink();
  }
});

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

test("SDK transcript mirror normalizes provider goal lifecycle", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-active-goal",
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
      ({ prompt, options }) => ({
        async *[Symbol.asyncIterator]() {
          const outbound = await prompt[Symbol.asyncIterator]().next();
          yield {
            ...outbound.value,
            uuid: "provider-goal-turn",
            type: "user",
            parent_tool_use_id: null,
            session_id: "provider-session-active-goal"
          } as never;
          await options.sessionStore?.append(
            {
              projectKey: "repo",
              sessionId: "provider-session-active-goal"
            },
            [
              {
                type: "attachment",
                uuid: "attachment-other",
                attachment: { type: "other" }
              },
              {
                type: "attachment",
                uuid: "goal-status-sentinel",
                timestamp: "2026-08-02T05:26:47.783Z",
                attachment: {
                  type: "goal_status",
                  met: false,
                  sentinel: true,
                  condition: "count to three"
                }
              },
              {
                type: "attachment",
                uuid: "goal-status-active",
                timestamp: "2026-08-02T05:26:53.921Z",
                attachment: {
                  type: "goal_status",
                  met: false,
                  condition: "count to three",
                  iterations: 2,
                  reason: "only reached two"
                }
              },
              {
                type: "attachment",
                uuid: "goal-status-complete",
                timestamp: "2026-08-02T05:27:01.472Z",
                attachment: {
                  type: "goal_status",
                  met: true,
                  condition: "count to three",
                  iterations: 3,
                  durationMs: 1200,
                  tokens: 420,
                  reason: "counted all three"
                }
              },
              {
                type: "attachment",
                uuid: "goal-status-complete",
                attachment: {
                  type: "goal_status",
                  met: true,
                  condition: "count to three"
                }
              }
            ]
          );
          yield { type: "result", subtype: "success" } as never;
        },
        close() {}
      })
    );

    await session.start();
    session.exec(
      "goal-work-turn",
      "/goal count to three",
      undefined,
      "goal_arm",
      {
        operationId: "goal-op-1",
        revision: 7,
        repairEpoch: 2,
        action: "set"
      }
    );
    await waitForEvent(events, "turn_completed");

    const updates = events.filter((event) => event.type === "goal_observed");
    assert.equal(updates.length, 3);
    assert.deepEqual(updates[0]?.payload, {
      turnId: "goal-work-turn",
      providerTurnId: "provider-goal-turn",
      action: "set",
      goalOperationId: "goal-op-1",
      goalRevision: 7,
      goalRepairEpoch: 2,
      occurredAtUnixMs: Date.parse("2026-08-02T05:26:47.783Z"),
      source: "transcript_mirror",
      updateType: "thread_goal_update",
      goal: {
        objective: "count to three",
        status: "active"
      }
    });
    assert.deepEqual(updates[1]?.payload, {
      turnId: "goal-work-turn",
      providerTurnId: "provider-goal-turn",
      action: "set",
      goalOperationId: "goal-op-1",
      goalRevision: 7,
      goalRepairEpoch: 2,
      occurredAtUnixMs: Date.parse("2026-08-02T05:26:53.921Z"),
      source: "transcript_mirror",
      updateType: "thread_goal_update",
      goal: {
        objective: "count to three",
        status: "active",
        iterations: 2,
        reason: "only reached two"
      }
    });
    assert.deepEqual(updates[2]?.payload, {
      turnId: "goal-work-turn",
      providerTurnId: "provider-goal-turn",
      action: "set",
      goalOperationId: "goal-op-1",
      goalRevision: 7,
      goalRepairEpoch: 2,
      occurredAtUnixMs: Date.parse("2026-08-02T05:27:01.472Z"),
      source: "transcript_mirror",
      updateType: "thread_goal_completed",
      goal: {
        objective: "count to three",
        status: "complete",
        iterations: 3,
        durationMs: 1200,
        tokens: 420,
        reason: "counted all three"
      }
    });
  } finally {
    restoreSink();
  }
});

test("terminal result replays durable goal status when live mirror omits attachments", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const currentSentinelTimestamp = new Date(Date.now() + 1_000).toISOString();
  const currentCompletionTimestamp = new Date(Date.now() + 2_000).toISOString();
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-replayed-goal",
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
          await prompt[Symbol.asyncIterator]().next();
          // Claude has already durably written goal_status here, but the live
          // sessionStore mirror did not include either attachment.
          yield { type: "result", subtype: "success" } as never;
        },
        close() {}
      }),
      30_000,
      async (input) => ({
        providerSessionId: input.sessionId,
        providerTurnId: "provider-replayed-goal-turn",
        providerCheckpointMessageId: "provider-replayed-goal-result"
      }),
      5_000,
      {
        replayNativeSession: async (sessionId, destination, options) => {
          assert.equal(sessionId, "provider-session-replayed-goal");
          assert.deepEqual(options, {
            dir: "/repo",
            includeSubagents: false
          });
          await destination.append(
            {
              projectKey: "repo",
              sessionId: "provider-session-replayed-goal"
            },
            [
              {
                type: "attachment",
                uuid: "historical-goal-sentinel",
                timestamp: "2026-01-01T00:00:00.000Z",
                attachment: {
                  type: "goal_status",
                  met: false,
                  sentinel: true,
                  condition: "historical goal"
                }
              },
              {
                type: "attachment",
                uuid: "historical-goal-complete",
                parentUuid: "historical-goal-sentinel",
                timestamp: "2026-01-01T00:00:01.000Z",
                attachment: {
                  type: "goal_status",
                  met: true,
                  condition: "historical goal"
                }
              },
              {
                type: "attachment",
                uuid: "replayed-goal-sentinel",
                timestamp: currentSentinelTimestamp,
                attachment: {
                  type: "goal_status",
                  met: false,
                  sentinel: true,
                  condition: "count to three"
                }
              },
              {
                type: "attachment",
                uuid: "sibling-goal-complete",
                parentUuid: "replayed-goal-sentinel",
                timestamp: currentCompletionTimestamp,
                attachment: {
                  type: "goal_status",
                  met: true,
                  condition: "count to three"
                }
              },
              {
                type: "user",
                uuid: "provider-replayed-goal-turn",
                parentUuid: "replayed-goal-sentinel",
                timestamp: currentSentinelTimestamp,
                message: {
                  role: "user",
                  content: "/goal count to three"
                }
              },
              {
                type: "attachment",
                uuid: "replayed-goal-complete",
                parentUuid: "provider-replayed-goal-turn",
                timestamp: currentCompletionTimestamp,
                attachment: {
                  type: "goal_status",
                  met: true,
                  condition: "count to three",
                  iterations: 3
                }
              }
            ]
          );
        }
      }
    );

    await session.start();
    session.exec(
      "goal-replay-turn",
      "/goal count to three",
      undefined,
      "goal_arm",
      {
        operationId: "goal-replay-operation",
        revision: 3,
        repairEpoch: 1,
        action: "set"
      }
    );
    await waitForEvent(events, "turn_completed");

    const completions = events.filter(
      (event) =>
        event.type === "goal_observed" &&
        event.payload?.updateType === "thread_goal_completed"
    );
    assert.equal(completions.length, 1);
    const completed = completions[0];
    assert.equal(completed?.payload?.goalOperationId, "goal-replay-operation");
    assert.equal(
      completed?.payload?.providerTurnId,
      "provider-replayed-goal-turn"
    );
    assert.deepEqual(completed?.payload?.goal, {
      objective: "count to three",
      status: "complete",
      iterations: 3
    });
    const replay = events.find(
      (event) =>
        event.type === "goal_transcript_replay" &&
        event.payload?.phase === "completed"
    );
    assert.equal(replay?.payload?.liveGoalStatusEntryCount, 0);
    assert.equal(replay?.payload?.replayedGoalStatusEntryCount, 5);
    const replayedBatch = events.find(
      (event) =>
        event.type === "goal_transcript_observed" &&
        event.payload?.transcriptSource === "native_replay"
    );
    assert.equal(replayedBatch?.payload?.projectedUpdateCount, 1);
    assert.equal(replayedBatch?.payload?.projectedTerminalCount, 1);
    assert.equal(replayedBatch?.payload?.ignoredOutsideCurrentTurnCount, 3);
    assert.equal(replayedBatch?.payload?.ignoredUnboundGenerationCount, 0);
  } finally {
    restoreSink();
  }
});

test("terminal replay reconsiders eager goal entries observed before Turn activation", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const timestamp = new Date(Date.now() + 1_000).toISOString();
  const key = {
    projectKey: "repo",
    sessionId: "provider-session-eager-goal"
  };
  const entries: SessionStoreEntry[] = [
    {
      type: "attachment",
      uuid: "eager-goal-sentinel",
      timestamp,
      attachment: {
        type: "goal_status",
        met: false,
        sentinel: true,
        condition: "ship it"
      }
    },
    {
      type: "user",
      uuid: "provider-eager-goal-turn",
      parentUuid: "eager-goal-sentinel",
      timestamp
    },
    {
      type: "attachment",
      uuid: "eager-goal-complete",
      parentUuid: "provider-eager-goal-turn",
      timestamp,
      attachment: {
        type: "goal_status",
        met: true,
        condition: "ship it"
      }
    }
  ];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      key.sessionId,
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
      ({ prompt, options }) => ({
        async *[Symbol.asyncIterator]() {
          await prompt[Symbol.asyncIterator]().next();
          await options.sessionStore?.append(key, entries);
          yield { type: "result", subtype: "success" } as never;
        },
        close() {}
      }),
      30_000,
      async (input) => ({
        providerSessionId: input.sessionId,
        providerTurnId: "provider-eager-goal-turn",
        providerCheckpointMessageId: "provider-eager-goal-result"
      }),
      5_000,
      {
        replayNativeSession: async (_sessionId, destination) => {
          await destination.append(key, entries);
        }
      }
    );

    await session.start();
    session.exec("eager-goal-turn", "/goal ship it", undefined, "goal_arm", {
      operationId: "eager-goal-operation",
      revision: 1,
      action: "set"
    });
    await waitForEvent(events, "turn_completed");

    const completions = events.filter(
      (event) =>
        event.type === "goal_observed" &&
        event.payload?.updateType === "thread_goal_completed"
    );
    assert.equal(completions.length, 1);
    assert.equal(
      completions[0]?.payload?.goalOperationId,
      "eager-goal-operation"
    );
    const replay = events.find(
      (event) =>
        event.type === "goal_transcript_replay" &&
        event.payload?.phase === "completed"
    );
    assert.equal(replay?.payload?.liveGoalStatusEntryCount, 2);
    assert.equal(replay?.payload?.replayedGoalStatusEntryCount, 2);
  } finally {
    restoreSink();
  }
});

test("task-notification result recovers a terminal goal before idle settlement", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const timestamp = new Date(Date.now() + 1_000).toISOString();
  const key = { projectKey: "repo", sessionId: "provider-session-1" };
  const activeEntries: SessionStoreEntry[] = [
    {
      type: "attachment",
      uuid: "background-goal-sentinel",
      timestamp,
      attachment: {
        type: "goal_status",
        met: false,
        sentinel: true,
        condition: "finish background work"
      }
    },
    {
      type: "user",
      uuid: "background-goal-provider-turn",
      parentUuid: "background-goal-sentinel",
      timestamp
    }
  ];
  const terminalEntry: SessionStoreEntry = {
    type: "attachment",
    uuid: "background-goal-complete",
    parentUuid: "background-goal-provider-turn",
    timestamp,
    attachment: {
      type: "goal_status",
      met: true,
      condition: "finish background work"
    }
  };
  let terminalAvailable = false;
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      key.sessionId,
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
          rootResultBeforeContinuations: true,
          beforeTaskNotificationResult: () => {
            terminalAvailable = true;
          }
        }),
      30_000,
      undefined,
      5_000,
      {
        replayNativeSession: async (_sessionId, destination) => {
          await destination.append(key, [
            ...activeEntries,
            ...(terminalAvailable ? [terminalEntry] : [])
          ]);
        }
      }
    );

    await session.start();
    session.exec(
      "background-goal-turn",
      "/goal finish background work",
      undefined,
      "goal_arm",
      {
        operationId: "background-goal-operation",
        revision: 1,
        action: "set"
      },
      "",
      "background-goal-provider-turn"
    );
    await waitForEvent(events, "turn_completed");

    const completionIndex = events.findIndex(
      (event) =>
        event.type === "goal_observed" &&
        event.payload?.updateType === "thread_goal_completed"
    );
    const turnCompletionIndex = events.findIndex(
      (event) => event.type === "turn_completed"
    );
    assert.ok(completionIndex >= 0 && completionIndex < turnCompletionIndex);
    assert.equal(
      events[turnCompletionIndex]?.payload?.stopReason,
      "background_agent_idle"
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "sdk_lifecycle_observed" &&
          event.payload?.sdkMessageOrigin === "task-notification"
      )
    );
  } finally {
    restoreSink();
  }
});

test("timed-out goal replay cannot delay turn settlement or publish a partial batch", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const timestamp = new Date(Date.now() + 1_000).toISOString();
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-replay-timeout",
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
          await prompt[Symbol.asyncIterator]().next();
          yield { type: "result", subtype: "success" } as never;
        },
        close() {}
      }),
      30_000,
      async (input) => ({
        providerSessionId: input.sessionId,
        providerTurnId: "provider-replay-timeout-turn",
        providerCheckpointMessageId: "provider-replay-timeout-result"
      }),
      5_000,
      {
        goalTranscriptReplayTimeoutMs: 20,
        replayNativeSession: async (_sessionId, destination) => {
          await destination.append(
            {
              projectKey: "repo",
              sessionId: "provider-session-replay-timeout"
            },
            [
              {
                type: "attachment",
                uuid: "timeout-goal-sentinel",
                timestamp,
                attachment: {
                  type: "goal_status",
                  met: false,
                  sentinel: true,
                  condition: "ship it"
                }
              },
              {
                type: "user",
                uuid: "provider-replay-timeout-turn",
                parentUuid: "timeout-goal-sentinel",
                timestamp
              },
              {
                type: "attachment",
                uuid: "timeout-goal-complete",
                parentUuid: "provider-replay-timeout-turn",
                timestamp,
                attachment: {
                  type: "goal_status",
                  met: true,
                  condition: "ship it"
                }
              }
            ]
          );
          await new Promise<never>(() => {});
        }
      }
    );

    await session.start();
    session.exec("goal-timeout-turn", "/goal ship it", undefined, "goal_arm", {
      operationId: "goal-timeout-operation",
      revision: 1,
      action: "set"
    });
    await waitForEvent(events, "turn_completed");

    assert.equal(
      events.some((event) => event.type === "goal_observed"),
      false
    );
    const replayFailure = events.find(
      (event) =>
        event.type === "goal_transcript_replay" &&
        event.payload?.reason === "native_replay_timeout"
    );
    assert.equal(replayFailure?.payload?.phase, "failed");
    assert.equal(replayFailure?.payload?.attempt, 1);
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

test("session start publishes the per-user model reported by SDK system init", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  let session: SessionRuntime | undefined;
  try {
    session = new SessionRuntime(
      "provider-session-effective-model",
      "/repo",
      {},
      false,
      false,
      {
        model: "default",
        permissionModeId: "default",
        planMode: false,
        effort: "",
        speed: ""
      },
      sidecarClaudeOptionsFromPayload({}),
      undefined,
      ({ prompt }) => ({
        async initializationResult() {
          return {
            models: [
              {
                value: "default",
                displayName: "Sonnet 5",
                description: "Efficient for routine tasks"
              },
              {
                value: "haiku",
                displayName: "Haiku 4.5",
                description: "Small and fast"
              }
            ]
          };
        },
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "init",
            model: "claude-haiku-4-5-20251001",
            session_id: "provider-session-effective-model"
          } as never;
          for await (const message of prompt) {
            yield {
              ...message,
              type: "user",
              parent_tool_use_id: null,
              session_id: "provider-session-effective-model"
            } as never;
            yield {
              type: "assistant",
              message: {
                id: "assistant-effective-model",
                model: "claude-opus-4-8",
                role: "assistant",
                content: [{ type: "text", text: "Done." }]
              },
              parent_tool_use_id: null,
              session_id: "provider-session-effective-model"
            } as never;
            yield {
              type: "result",
              subtype: "success",
              session_id: "provider-session-effective-model"
            } as never;
          }
        },
        close() {}
      })
    );

    await session.start();
    await waitForCondition(
      () =>
        events.some((event) => {
          if (event.type !== "session_state") {
            return false;
          }
          const configOptions = event.payload?.configOptions as
            | Array<Record<string, unknown>>
            | undefined;
          return configOptions?.some(
            (option) =>
              option.id === "model" &&
              option.currentValue === "default" &&
              option.effectiveValue === "claude-haiku-4-5-20251001"
          );
        }),
      "effective model session state"
    );

    session.exec("turn-effective-model", "Which model are you?");
    await waitForCondition(
      () =>
        events.some((event) => {
          if (event.type !== "session_state") {
            return false;
          }
          const configOptions = event.payload?.configOptions as
            | Array<Record<string, unknown>>
            | undefined;
          return configOptions?.some(
            (option) =>
              option.id === "model" &&
              option.currentValue === "default" &&
              option.effectiveValue === "claude-opus-4-8"
          );
        }),
      "assistant-reconciled effective model session state"
    );
  } finally {
    await session?.close();
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
