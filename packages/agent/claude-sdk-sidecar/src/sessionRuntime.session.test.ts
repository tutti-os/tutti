import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  Options as ClaudeQueryOptions,
  PermissionUpdate,
  SDKMessage
} from "@anthropic-ai/claude-agent-sdk";
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
  fakeLocalCommandFailedCompactQuery,
  fakePermissionCheckQuery,
  fakeSilentCompactQuery,
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
            subtype: "hook_started",
            hook_id: "hook-1",
            hook_name: "demo-hook",
            hook_event: "PostToolUse",
            uuid: "ephemeral-hook-started-uuid",
            session_id: "provider-session-checkpoint"
          } as never;
          yield {
            type: "system",
            subtype: "hook_progress",
            hook_id: "hook-1",
            hook_name: "demo-hook",
            hook_event: "PostToolUse",
            stdout: "progress",
            stderr: "",
            output: "progress",
            uuid: "ephemeral-hook-progress-uuid",
            session_id: "provider-session-checkpoint"
          } as never;
          yield {
            type: "system",
            subtype: "hook_response",
            hook_id: "hook-1",
            hook_name: "demo-hook",
            hook_event: "PostToolUse",
            output: "done",
            stdout: "",
            stderr: "",
            outcome: "success",
            uuid: "ephemeral-hook-response-uuid",
            session_id: "provider-session-checkpoint"
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

test("SDK authentication rejection before provider identity skips recovery", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  const failure =
    "Failed to authenticate. API Error: 401 The API Key appears to be invalid.";
  let identityRecoveryCalls = 0;
  try {
    const session = new SessionRuntime(
      "provider-session-auth-rejected",
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
          await iterator.next();
          yield {
            type: "assistant",
            error: "authentication_failed",
            message: {
              id: "assistant-auth-rejected",
              role: "assistant",
              content: [{ type: "text", text: failure }]
            },
            parent_tool_use_id: null,
            session_id: "provider-session-auth-rejected"
          } as never;
          yield {
            type: "result",
            subtype: "success",
            is_error: true,
            api_error_status: 401,
            result: failure,
            session_id: "provider-session-auth-rejected"
          } as never;
        },
        close() {}
      }),
      30_000,
      async () => {
        identityRecoveryCalls += 1;
        throw new Error("identity recovery must not run for an explicit 401");
      },
      50
    );

    await session.start();
    session.exec("turn-auth-rejected", "hello");
    await waitForEvent(events, "turn_failed");

    assert.equal(identityRecoveryCalls, 0);
    assert.equal(
      events.some((event) => event.type === "assistant_failed"),
      false,
      "provider output must not escape before durable acceptance"
    );
    assert.equal(
      events.some((event) => event.type === "provider_turn_identity_resolved"),
      false
    );
    const failedTurn = events.find((event) => event.type === "turn_failed");
    assert.equal(failedTurn?.payload?.turnId, "turn-auth-rejected");
    assert.equal(failedTurn?.payload?.code, "authentication_failed");
    assert.equal(failedTurn?.payload?.apiErrorStatus, 401);
    assert.equal(failedTurn?.payload?.dispatchDisposition, "rejected");
  } finally {
    restoreSink();
  }
});

test("SDK api_retry authentication error fails before retrying", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  let queryClosed = false;
  let closeCalls = 0;
  try {
    const session = new SessionRuntime(
      "provider-session-api-retry-auth",
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
          await prompt[Symbol.asyncIterator]().next();
          yield {
            type: "system",
            subtype: "api_retry",
            attempt: 1,
            max_retries: 10,
            retry_delay_ms: 100,
            error_status: 401,
            error: "authentication_failed",
            session_id: "provider-session-api-retry-auth"
          } as never;
          while (!queryClosed) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        },
        close() {
          closeCalls += 1;
          queryClosed = true;
        }
      })
    );

    await session.start();
    session.exec("turn-api-retry-auth", "hello");
    await waitForEvent(events, "turn_failed");

    const failedTurn = events.find((event) => event.type === "turn_failed");
    assert.equal(failedTurn?.payload?.turnId, "turn-api-retry-auth");
    assert.equal(failedTurn?.payload?.code, "authentication_failed");
    assert.equal(failedTurn?.payload?.apiErrorStatus, 401);
    assert.equal(failedTurn?.payload?.dispatchDisposition, "rejected");
    assert.equal(closeCalls, 1);
    assert.equal(
      events.filter(
        (event) =>
          event.type === "sdk_lifecycle_observed" &&
          event.payload?.sdkMessageSubtype === "api_retry"
      ).length,
      1
    );
  } finally {
    queryClosed = true;
    restoreSink();
  }
});

test("guidance preempts immediately and stays on the active SDK turn", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const prompts: string[] = [];
  let releaseInterrupt = () => {};
  let releaseAbortResult = () => {};
  const interrupts = {
    count: 0,
    wait: new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    }),
    resultWait: new Promise<void>((resolve) => {
      releaseAbortResult = resolve;
    })
  };
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
      ({ prompt }) => fakeGuidancePromptQuery(prompt, prompts, interrupts)
    );

    await session.start();
    session.exec("turn-1", "start working");
    await waitForCondition(() => prompts.length === 1, "initial prompt");
    let guidanceAcknowledged = false;
    const guidance = session.guide("prefer the focused path").then(() => {
      guidanceAcknowledged = true;
    });

    assert.equal(interrupts.count, 1);
    assert.deepEqual(prompts, ["start working"]);
    assert.equal(guidanceAcknowledged, false);

    releaseInterrupt();
    await guidance;
    const interruptedIndex = events.findIndex(
      (event) => event.type === "guidance_interrupted"
    );
    assert.ok(interruptedIndex >= 0);
    assert.equal(events[interruptedIndex]?.payload?.turnId, "turn-1");
    assert.deepEqual(prompts, ["start working"]);

    releaseAbortResult();
    await waitForEvent(events, "turn_completed");

    assert.deepEqual(prompts, ["start working", "prefer the focused path"]);
    assert.equal(interrupts.count, 1);
    const guidedAssistantIndex = events.findIndex(
      (event) =>
        event.type === "assistant_completed" &&
        event.payload?.content === "Guided response"
    );
    assert.ok(guidedAssistantIndex > interruptedIndex);
    const completed = events.find((event) => event.type === "turn_completed");
    assert.equal(completed?.payload?.turnId, "turn-1");
    assert.equal(
      events.some(
        (event) =>
          event.type === "turn_completed" && event.payload?.turnId !== "turn-1"
      ),
      false
    );
    assert.equal(
      events.some((event) => event.type === "turn_failed"),
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
    restoreSink();
  }
});

test("guidance rejects instead of enqueueing when SDK preemption fails", async () => {
  const prompts: string[] = [];
  const restoreSink = withSidecarEventSinkForTest(() => {});
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
      ({ prompt }) => {
        const query = fakeGuidancePromptQuery(prompt, prompts);
        return {
          ...query,
          async interrupt() {
            throw new Error("interrupt rejected");
          }
        };
      }
    );

    await session.start();
    session.exec("turn-1", "start working");
    await waitForCondition(() => prompts.length === 1, "initial prompt");

    await assert.rejects(
      session.guide("prefer the focused path"),
      /guidance preemption failed: interrupt rejected/
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(prompts, ["start working"]);
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

test("SDK active_goal messages normalize provider goal lifecycle", async () => {
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
      ({ prompt }) => ({
        async *[Symbol.asyncIterator]() {
          const outbound = await prompt[Symbol.asyncIterator]().next();
          yield {
            ...outbound.value,
            uuid: "provider-goal-turn",
            type: "user",
            parent_tool_use_id: null,
            session_id: "provider-session-active-goal"
          } as never;
          yield {
            type: "active_goal",
            value: "malformed",
            uuid: "active-goal-malformed",
            session_id: "provider-session-active-goal"
          } as never;
          yield {
            type: "active_goal",
            value: {
              condition: "count to three",
              iterations: 2,
              set_at: "2026-08-02T00:00:00.000Z",
              tokens_at_start: 100,
              last_reason: "only reached two"
            },
            uuid: "active-goal-1",
            session_id: "provider-session-active-goal"
          } as never;
          yield {
            type: "active_goal",
            value: null,
            uuid: "active-goal-2",
            session_id: "provider-session-active-goal"
          } as never;
          yield { type: "result", subtype: "success" } as never;
        },
        close() {}
      })
    );

    await session.start();
    session.exec("goal-work-turn", "continue");
    await waitForEvent(events, "turn_completed");

    const updates = events.filter((event) => event.type === "goal_observed");
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[0]?.payload, {
      turnId: "goal-work-turn",
      providerTurnId: "provider-goal-turn",
      source: "active_goal",
      updateType: "thread_goal_update",
      goal: {
        objective: "count to three",
        status: "active",
        iterations: 2,
        reason: "only reached two"
      }
    });
    assert.deepEqual(updates[1]?.payload, {
      turnId: "goal-work-turn",
      providerTurnId: "provider-goal-turn",
      source: "active_goal",
      updateType: "thread_goal_completed"
    });
  } finally {
    restoreSink();
  }
});

test("provider idle blocks an active Goal without a terminal verdict", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-goal-timeout",
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
          const outbound = await prompt[Symbol.asyncIterator]().next();
          yield {
            ...outbound.value,
            uuid: "provider-goal-timeout-turn",
            type: "user",
            parent_tool_use_id: null,
            session_id: "provider-session-goal-timeout"
          } as never;
          yield { type: "result", subtype: "success" } as never;
          yield {
            type: "system",
            subtype: "session_state_changed",
            state: "idle",
            session_id: "provider-session-goal-timeout"
          } as never;
        },
        close() {}
      })
    );

    await session.start();
    session.exec(
      "goal-timeout-turn",
      "/goal finish the task",
      undefined,
      undefined,
      {
        operationId: "goal-timeout-operation",
        revision: 1,
        action: "set"
      }
    );
    await waitForCondition(
      () =>
        events.some(
          (event) =>
            event.type === "goal_observed" &&
            isRecord(event.payload?.goal) &&
            event.payload.goal.status === "blocked"
        ),
      "blocked Goal at provider idle"
    );

    const updates = events.filter((event) => event.type === "goal_observed");
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0]?.payload?.goal, {
      objective: "finish the task",
      status: "blocked"
    });
  } finally {
    restoreSink();
  }
});

test("SDK active_goal clear keeps the exact goal command action", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-goal-clear",
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
          const outbound = await prompt[Symbol.asyncIterator]().next();
          yield {
            ...outbound.value,
            uuid: "provider-goal-clear-turn",
            type: "user",
            parent_tool_use_id: null,
            session_id: "provider-session-goal-clear"
          } as never;
          yield {
            type: "active_goal",
            value: null,
            uuid: "active-goal-clear",
            session_id: "provider-session-goal-clear"
          } as never;
          yield { type: "result", subtype: "success" } as never;
        },
        close() {}
      })
    );

    await session.start();
    session.exec("goal-clear-turn", "/goal clear", undefined, undefined, {
      operationId: "goal-op-clear",
      revision: 2,
      action: "clear"
    });
    await waitForEvent(events, "turn_completed");

    const update = events.find((event) => event.type === "goal_observed");
    assert.equal(update?.payload?.action, "clear");
    assert.equal(update?.payload?.source, "active_goal");
    assert.equal(update?.payload?.updateType, "thread_goal_cleared");
  } finally {
    restoreSink();
  }
});

test("system init follows goal_status written after SDK result", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const tempDirectory = await mkdtemp(
    join(tmpdir(), "tutti-claude-goal-transcript-")
  );
  const transcriptDirectory = join(tempDirectory, "projects", "-repo");
  const transcriptPath = join(
    transcriptDirectory,
    "provider-session-goal-status.jsonl"
  );
  await mkdir(transcriptDirectory, { recursive: true });
  await writeFile(transcriptPath, "", "utf8");
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-goal-status",
      "/repo",
      { CLAUDE_CONFIG_DIR: tempDirectory },
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
          yield {
            type: "system",
            subtype: "init",
            session_id: "provider-session-goal-status",
            cwd: "/repo",
            model: "haiku"
          } as never;
          yield {
            type: "system",
            subtype: "init",
            session_id: "provider-subagent-goal-status",
            parent_tool_use_id: "toolu-delegated-agent",
            cwd: "/subagent",
            model: "haiku"
          } as never;
          const outbound = await prompt[Symbol.asyncIterator]().next();
          yield {
            ...outbound.value,
            uuid: "provider-goal-status-turn",
            type: "user",
            parent_tool_use_id: null,
            session_id: "provider-session-goal-status"
          } as never;
          await appendFile(
            transcriptPath,
            `${JSON.stringify({
              type: "attachment",
              uuid: "goal-status-sentinel",
              sessionId: "provider-session-goal-status",
              attachment: {
                type: "goal_status",
                met: false,
                sentinel: true,
                condition: "count to three"
              }
            })}\n`,
            "utf8"
          );
          yield { type: "result", subtype: "success" } as never;
          await appendFile(
            transcriptPath,
            `${JSON.stringify({
              type: "attachment",
              uuid: "goal-status-complete",
              sessionId: "provider-session-goal-status",
              attachment: {
                type: "goal_status",
                met: true,
                condition: "count to three",
                reason: "counted one number per turn",
                iterations: 3,
                durationMs: 16_386,
                tokens: 1_479
              }
            })}\n`,
            "utf8"
          );
          yield {
            type: "system",
            subtype: "session_state_changed",
            state: "idle",
            session_id: "provider-session-goal-status"
          } as never;
        },
        close() {}
      })
    );

    await session.start();
    session.exec(
      "goal-status-turn",
      "/goal count to three",
      undefined,
      undefined,
      {
        operationId: "goal-op-status",
        revision: 1,
        action: "set"
      }
    );
    await waitForEvent(events, "turn_completed");
    await waitForCondition(
      () =>
        events.some(
          (event) =>
            event.type === "goal_observed" &&
            isRecord(event.payload?.goal) &&
            event.payload.goal.status === "complete"
        ),
      "late transcript goal completion"
    );

    const updates = events.filter((event) => event.type === "goal_observed");
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[1]?.payload, {
      turnId: "goal-status-turn",
      providerTurnId: "provider-goal-status-turn",
      source: "goal_status",
      updateType: "thread_goal_update",
      goal: {
        objective: "count to three",
        status: "complete",
        reason: "counted one number per turn",
        iterations: 3,
        durationMs: 16_386,
        tokens: 1_479
      }
    });
    assert.ok(
      events.findIndex(
        (event) =>
          event.type === "goal_observed" &&
          isRecord(event.payload?.goal) &&
          event.payload.goal.status === "active"
      ) < events.findIndex((event) => event.type === "turn_completed"),
      "the sentinel goal evidence must be emitted before the root turn settles"
    );
    assert.ok(
      events.findIndex(
        (event) =>
          event.type === "goal_observed" &&
          isRecord(event.payload?.goal) &&
          event.payload.goal.status === "complete"
      ) > events.findIndex((event) => event.type === "turn_completed"),
      "the final goal evidence may arrive after the SDK result"
    );
  } finally {
    restoreSink();
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("resume tails the known session transcript without system init", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const tempDirectory = await mkdtemp(
    join(tmpdir(), "tutti-claude-goal-resume-")
  );
  const transcriptDirectory = join(tempDirectory, "projects", "-repo");
  const transcriptPath = join(
    transcriptDirectory,
    "provider-session-goal-resume.jsonl"
  );
  await mkdir(transcriptDirectory, { recursive: true });
  await writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "attachment",
      uuid: "historical-goal-status",
      attachment: {
        type: "goal_status",
        met: false,
        condition: "historical goal"
      }
    })}\n`,
    "utf8"
  );
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-goal-resume",
      "/repo",
      { CLAUDE_CONFIG_DIR: tempDirectory },
      true,
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
          const outbound = await prompt[Symbol.asyncIterator]().next();
          yield {
            ...outbound.value,
            uuid: "provider-goal-resume-turn",
            type: "user",
            parent_tool_use_id: null,
            session_id: "provider-session-goal-resume"
          } as never;
          await appendFile(
            transcriptPath,
            `${JSON.stringify({
              type: "attachment",
              uuid: "current-goal-status",
              attachment: {
                type: "goal_status",
                met: true,
                condition: "resume goal"
              }
            })}\n`,
            "utf8"
          );
          yield { type: "result", subtype: "success" } as never;
        },
        close() {}
      })
    );

    await session.start();
    session.exec(
      "goal-resume-turn",
      "/goal resume goal",
      undefined,
      undefined,
      {
        operationId: "goal-op-resume",
        revision: 1,
        action: "set"
      }
    );
    await waitForEvent(events, "turn_completed");

    const updates = events.filter((event) => event.type === "goal_observed");
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.payload?.source, "goal_status");
    assert.deepEqual(updates[0]?.payload?.goal, {
      objective: "resume goal",
      status: "complete"
    });
  } finally {
    restoreSink();
    await rm(tempDirectory, { recursive: true, force: true });
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
        includeHookEvents?: boolean;
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
    assert.equal(capturedOptions?.includeHookEvents, true);
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

test("restore start emits session_started without waiting for context usage", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const contextUsageResolvers: Array<(value: unknown) => void> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  try {
    const session = new SessionRuntime(
      "provider-session-restore",
      "/repo",
      {},
      true,
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

    const started = session.start();
    await waitForCondition(
      () => events.some((event) => event.type === "session_started"),
      "session_started before context usage resolves"
    );
    await started;
    assert.equal(
      events.some((event) => event.type === "usage_updated"),
      false,
      "restore start must not wait for getContextUsage"
    );
    assert.equal(contextUsageResolvers.length, 1);

    contextUsageResolvers[0]?.({ totalTokens: 12_345, maxTokens: 200_000 });
    await waitForCondition(
      () =>
        events.some(
          (event) =>
            event.type === "usage_updated" &&
            isRecord(event.payload?.contextWindow) &&
            event.payload.contextWindow.usedTokens === 12_345
        ),
      "background restore context usage"
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

test("follow-up after settled turn resumes a fresh Claude query", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  let queryCount = 0;
  let resumedOptions: ClaudeQueryOptions | undefined;
  try {
    const session = new SessionRuntime(
      "provider-session-continue",
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
        queryCount += 1;
        if (queryCount === 1) {
          return fakeSimpleResultQuery(prompt, {
            text: "first reply"
          });
        }
        resumedOptions = options;
        return fakeSimpleResultQuery(prompt, {
          text: "continue reply"
        });
      }
    );

    await session.start();
    session.exec("turn-1", "first");
    await waitForEvent(events, "turn_completed");
    assert.equal(queryCount, 1);

    session.exec("turn-2", "follow-up in the same conversation");
    await waitForCondition(
      () =>
        events.some(
          (event) =>
            event.type === "turn_completed" &&
            event.payload?.turnId === "turn-2"
        ) ||
        events.some(
          (event) =>
            event.type === "turn_failed" && event.payload?.turnId === "turn-2"
        ),
      `follow-up turn terminal; events=${JSON.stringify(events)}`
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "turn_completed" && event.payload?.turnId === "turn-2"
      ),
      true,
      `follow-up should complete; events=${JSON.stringify(events)}`
    );

    assert.equal(queryCount, 2);
    assert.equal(resumedOptions?.resume, "provider-session-1");
    assert.equal(Object.hasOwn(resumedOptions ?? {}, "sessionId"), false);
  } finally {
    restoreSink();
  }
});

test("allow for session survives the fresh Claude query used by a follow-up turn", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  const permissionResults: unknown[] = [];
  const suggestions = [
    {
      type: "addRules",
      rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }],
      behavior: "allow",
      destination: "session"
    } satisfies PermissionUpdate
  ];
  let queryCount = 0;
  try {
    const session = new SessionRuntime(
      "provider-session-permission-ledger",
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
        queryCount += 1;
        const currentQuery = queryCount;
        return fakePermissionCheckQuery(prompt, options, async (queryOptions) => {
          permissionResults.push(
            await queryOptions.canUseTool?.(
              "WebFetch",
              { url: `https://example.com/${currentQuery}` },
              {
                ...testCanUseToolOptions({
                  requestId: `request-web-fetch-${currentQuery}`,
                  toolUseID: `tool-web-fetch-${currentQuery}`
                }),
                suggestions
              }
            )
          );
        });
      }
    );

    await session.start();
    session.exec("turn-1", "fetch once");
    await waitForEvent(events, "approval_requested");
    const request = events.find((event) => event.type === "approval_requested");
    session.submitInteractive(
      "turn-1",
      String(request?.payload?.requestId ?? ""),
      "approved",
      "allow_always",
      {}
    );
    await waitForCondition(
      () =>
        events.some(
          (event) =>
            event.type === "turn_completed" && event.payload?.turnId === "turn-1"
        ),
      "first permission turn completion"
    );

    session.exec("turn-2", "fetch again");
    await waitForCondition(
      () =>
        events.some(
          (event) =>
            event.type === "turn_completed" && event.payload?.turnId === "turn-2"
        ),
      "follow-up permission turn completion"
    );

    assert.equal(queryCount, 2);
    assert.equal(
      events.filter((event) => event.type === "approval_requested").length,
      1
    );
    assert.deepEqual(permissionResults, [
      {
        behavior: "allow",
        updatedInput: { url: "https://example.com/1" },
        updatedPermissions: suggestions
      },
      {
        behavior: "allow",
        updatedInput: { url: "https://example.com/2" },
        updatedPermissions: suggestions
      }
    ]);
  } finally {
    restoreSink();
  }
});

test("settings effort after idle-retire bakes into resumed query settings without applyFlagSettings", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  let queryCount = 0;
  let resumedOptions: ClaudeQueryOptions | undefined;
  const applyFlagSettingsCalls: unknown[] = [];
  try {
    const session = new SessionRuntime(
      "provider-session-effort",
      "/repo",
      {},
      false,
      false,
      {
        model: "",
        permissionModeId: "default",
        planMode: false,
        effort: "medium",
        speed: "standard"
      },
      sidecarClaudeOptionsFromPayload({}),
      undefined,
      ({ prompt, options }) => {
        queryCount += 1;
        const query = fakeSimpleResultQuery(prompt, {
          text: queryCount === 1 ? "first reply" : "high effort reply"
        }) as AsyncIterable<SDKMessage> & {
          applyFlagSettings?: (settings: unknown) => Promise<void>;
          close?: () => void;
        };
        query.applyFlagSettings = async (settings) => {
          applyFlagSettingsCalls.push(settings);
        };
        if (queryCount > 1) {
          resumedOptions = options;
        }
        return query;
      }
    );

    await session.start();
    session.exec("turn-1", "first");
    await waitForEvent(events, "turn_completed");
    applyFlagSettingsCalls.length = 0;

    await session.applySettings({ effort: "high" });
    session.exec("turn-2", "follow-up after effort change");
    await waitForCondition(
      () =>
        events.some(
          (event) =>
            event.type === "turn_completed" &&
            event.payload?.turnId === "turn-2"
        ) ||
        events.some(
          (event) =>
            event.type === "turn_failed" && event.payload?.turnId === "turn-2"
        ),
      `effort follow-up terminal; events=${JSON.stringify(events)}`
    );

    assert.equal(queryCount, 2);
    assert.equal(resumedOptions?.resume, "provider-session-1");
    assert.deepEqual(
      (resumedOptions as { settings?: Record<string, unknown> } | undefined)
        ?.settings,
      {
        effortLevel: "high",
        fastMode: false
      }
    );
    assert.deepEqual(
      applyFlagSettingsCalls,
      [],
      "resumed quiet query must not receive live applyFlagSettings"
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

test("silent slash compact still emits a progress banner before result", async () => {
  // Real Claude Code 2.1.x can finish /compact with only result + getContextUsage
  // and never stream status:compacting or compact_boundary to the query
  // iterator. Without an immediate compact_started, AgentGUI shows only the
  // turn duration footer and no compaction divider.
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
      ({ prompt }) => fakeSilentCompactQuery(prompt)
    );

    await session.start();
    session.exec("turn-silent-compact", "/compact");
    await waitForEvent(events, "compact_started");
    await waitForEvent(events, "turn_completed");

    assert.equal(
      events.find((event) => event.type === "compact_started")?.payload?.turnId,
      "turn-silent-compact"
    );
    const usage = events.find(
      (event) =>
        event.type === "usage_updated" && isRecord(event.payload?.contextWindow)
    );
    assert.equal(usage?.payload?.turnId, "turn-silent-compact");
    assert.equal(
      (usage?.payload?.contextWindow as { usedTokens?: number } | undefined)
        ?.usedTokens,
      1_990
    );
  } finally {
    restoreSink();
  }
});

test("local_command compact failure still emits compact_failed", async () => {
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
      ({ prompt }) => fakeLocalCommandFailedCompactQuery(prompt)
    );

    await session.start();
    session.exec("turn-local-command-failed", "/compact");
    await waitForEvent(events, "compact_failed");
    await waitForEvent(events, "turn_completed");

    assert.equal(
      events.find((event) => event.type === "compact_failed")?.payload?.reason,
      "Not enough messages to compact."
    );
    assert.equal(
      events.find((event) => event.type === "compact_started")?.payload?.turnId,
      "turn-local-command-failed"
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
    const requestQuestions = (
      request?.payload?.input as { questions?: Array<Record<string, unknown>> }
    )?.questions;
    assert.equal(requestQuestions?.[0]?.id, "contract-question-1412lhw");
    session.submitInteractive(
      "turn-1",
      String(request?.payload?.requestId ?? ""),
      "submit",
      "Yes",
      {
        answers: ["Yes"],
        answersByQuestionId: { "contract-question-1412lhw": "Yes" }
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
            options: [{ label: "Yes", description: "Delete files" }],
            id: "contract-question-1412lhw"
          }
        ],
        answers: { "Delete everything?": "Yes" }
      }
    });
  } finally {
    restoreSink();
  }
});
