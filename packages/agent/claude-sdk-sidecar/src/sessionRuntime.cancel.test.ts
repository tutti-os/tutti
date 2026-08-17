import assert from "node:assert/strict";
import test from "node:test";
import type {
  Options as ClaudeQueryOptions,
  PermissionResult,
  SDKMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import { withSidecarEventSinkForTest } from "./eventSink.ts";
import { sidecarClaudeOptionsFromPayload } from "./options.ts";
import { SessionRuntime } from "./sessionRuntime.ts";
import {
  consolidatedAssistant,
  testCanUseToolOptions
} from "./sessionRuntimeTestCommon.ts";
import { fakeGuidedDelegatedContinuationQuery } from "./sessionRuntimeTestQueries.delegated.ts";
import { waitForEvent } from "./sessionRuntimeTestQueries.nested.ts";

function cancelTestSession(
  queryFactory: NonNullable<ConstructorParameters<typeof SessionRuntime>[8]>
): SessionRuntime {
  return new SessionRuntime(
    "provider-session-cancel-test",
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
    queryFactory
  );
}

test("exact cancel removes an undispatched turn without retiring the query", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  const shutdownOrder: string[] = [];
  try {
    const session = new SessionRuntime(
      "provider-session-pre-accept",
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
          const next = await prompt[Symbol.asyncIterator]().next();
          if (!next.done) {
            yield next.value;
          }
        },
        async interrupt() {
          shutdownOrder.push("interrupt");
        },
        close() {
          shutdownOrder.push("close");
        }
      })
    );

    await session.start();
    session.exec("turn-pre-accept", "hello");
    const result = await session.cancel("turn-pre-accept");

    assert.deepEqual(result, {
      canceled: true,
      disposition: "pre_accept",
      turnId: "turn-pre-accept",
      providerTurnId: "",
      dispatchPhase: "queued"
    });
    assert.deepEqual(shutdownOrder, []);
    const canceledEvent = events.find(
      (event) => event.type === "turn_canceled"
    );
    assert.equal(canceledEvent?.payload?.turnId, "turn-pre-accept");
    assert.equal(
      events.some((event) => event.type === "provider_turn_identity_resolved"),
      false
    );
  } finally {
    restoreSink();
  }
});

test("dispatched pre-accept cancel publishes terminal only after interrupt ack", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  let markPromptObserved: () => void = () => {};
  let releaseInterrupt: () => void = () => {};
  const promptObserved = new Promise<void>((resolve) => {
    markPromptObserved = resolve;
  });
  const interruptAck = new Promise<void>((resolve) => {
    releaseInterrupt = resolve;
  });
  try {
    const session = cancelTestSession(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        const next = await prompt[Symbol.asyncIterator]().next();
        markPromptObserved();
        await new Promise(() => {});
        if (!next.done) {
          yield next.value;
        }
      },
      async interrupt() {
        await interruptAck;
      },
      close() {}
    }));

    await session.start();
    session.exec("turn-dispatched", "hello");
    await promptObserved;
    const canceling = session.cancel("turn-dispatched");
    await Promise.resolve();

    assert.equal(
      events.some((event) => event.type === "turn_canceled"),
      false
    );
    releaseInterrupt();
    const result = await canceling;
    assert.equal(result.disposition, "pre_accept");
    assert.equal(
      events.some((event) => event.type === "turn_canceled"),
      true
    );
  } finally {
    restoreSink();
  }
});

test("dispatched cancel terminates the Query when interrupt ack never arrives", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  let markPromptObserved: () => void = () => {};
  const promptObserved = new Promise<void>((resolve) => {
    markPromptObserved = resolve;
  });
  let closed = false;
  try {
    const session = cancelTestSession(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        await prompt[Symbol.asyncIterator]().next();
        markPromptObserved();
        await new Promise(() => {});
        yield {} as SDKMessage;
      },
      async interrupt() {
        await new Promise(() => {});
      },
      close() {
        closed = true;
      }
    }));

    await session.start();
    session.exec("turn-interrupt-timeout", "hello");
    await promptObserved;
    const result = await session.cancel("turn-interrupt-timeout", {
      interruptTimeoutMs: 10,
      drainTimeoutMs: 10
    });

    assert.equal(result.canceled, true);
    assert.equal(closed, true);
    assert.equal(
      events.some(
        (event) =>
          event.type === "turn_canceled" &&
          event.payload?.turnId === "turn-interrupt-timeout"
      ),
      true
    );
  } finally {
    restoreSink();
  }
});

test("cancel aborting identity resolution cannot publish terminal before interrupt ack", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  let markResolutionStarted: () => void = () => {};
  let releaseInterrupt: () => void = () => {};
  const resolutionStarted = new Promise<void>((resolve) => {
    markResolutionStarted = resolve;
  });
  const interruptAck = new Promise<void>((resolve) => {
    releaseInterrupt = resolve;
  });
  try {
    const session = new SessionRuntime(
      "provider-session-resolving-cancel",
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
            uuid: "assistant-before-identity",
            parent_tool_use_id: null,
            session_id: "provider-session-resolving-cancel",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "pending" }]
            }
          } as never;
        },
        async interrupt() {
          await interruptAck;
        },
        close() {}
      }),
      30_000,
      async () => {
        markResolutionStarted();
        return await new Promise<never>(() => {});
      }
    );

    await session.start();
    session.exec("turn-resolving", "hello");
    await resolutionStarted;
    const canceling = session.cancel("turn-resolving");
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(
      events.some((event) =>
        ["turn_canceled", "turn_failed", "turn_completed"].includes(event.type)
      ),
      false
    );
    releaseInterrupt();
    const result = await canceling;
    assert.equal(result.disposition, "pre_accept");
    assert.equal(
      events.filter((event) => event.type === "turn_canceled").length,
      1
    );
  } finally {
    restoreSink();
  }
});

test("cancel settles every dispatched prompt retired with the Query generation", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  let markPromptsObserved: () => void = () => {};
  const promptsObserved = new Promise<void>((resolve) => {
    markPromptsObserved = resolve;
  });
  try {
    const session = cancelTestSession(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        const iterator = prompt[Symbol.asyncIterator]();
        for (let index = 0; index < 2; index += 1) {
          const next = await iterator.next();
          if (next.done) {
            return;
          }
        }
        markPromptsObserved();
        await new Promise(() => {});
        yield {} as SDKMessage;
      },
      async interrupt() {},
      close() {}
    }));

    await session.start();
    session.exec("turn-root", "hello");
    session.exec("turn-goal", "/goal ship it", undefined, "goal_arm", {
      operationId: "goal-operation",
      revision: 1,
      repairEpoch: 0,
      action: "set"
    });
    await promptsObserved;

    const result = await session.cancel("turn-root");

    assert.equal(result.disposition, "pre_accept");
    assert.deepEqual(
      events
        .filter((event) => event.type === "turn_canceled")
        .map((event) => event.payload?.turnId),
      ["turn-root"]
    );
    assert.deepEqual(
      events.find((event) => event.type === "goal_command_canceled")?.payload,
      {
        turnId: "turn-goal",
        operationId: "goal-operation",
        revision: 1,
        repairEpoch: 0,
        action: "set",
        reason: "cancel_requested"
      }
    );
    assert.equal(
      events.some((event) => event.type === "goal_command_started"),
      false
    );
  } finally {
    restoreSink();
  }
});

test("interrupt failure closes the owned Query and settles cancellation", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  let markPromptObserved: () => void = () => {};
  const promptObserved = new Promise<void>((resolve) => {
    markPromptObserved = resolve;
  });
  let closed = false;
  try {
    const session = cancelTestSession(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        const next = await prompt[Symbol.asyncIterator]().next();
        markPromptObserved();
        await new Promise(() => {});
        if (!next.done) {
          yield next.value;
        }
      },
      async interrupt() {
        throw new Error("interrupt failed");
      },
      close() {
        closed = true;
      }
    }));

    await session.start();
    session.exec("turn-interrupt-failed", "hello");
    await promptObserved;

    const result = await session.cancel("turn-interrupt-failed");

    assert.equal(result.canceled, true);
    assert.equal(closed, true);
    assert.equal(
      events.some((event) => event.type === "turn_canceled"),
      true
    );
  } finally {
    restoreSink();
  }
});

test("same-tick exact cancel removes a deferred Goal command", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  let promptCount = 0;
  try {
    const session = cancelTestSession(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        const next = await prompt[Symbol.asyncIterator]().next();
        if (!next.done) {
          promptCount += 1;
          yield next.value;
        }
      },
      close() {}
    }));

    await session.start();
    session.exec("goal-turn", "/goal ship it", undefined, "goal_arm", {
      operationId: "goal-op",
      revision: 1,
      repairEpoch: 2,
      action: "set"
    });
    const result = await session.cancel("goal-turn");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(result.disposition, "pre_accept");
    assert.equal(result.dispatchPhase, "pending_goal");
    assert.equal(promptCount, 0);
    assert.equal(
      events.some((event) => event.type === "goal_command_started"),
      false
    );
    assert.deepEqual(
      events.find((event) => event.type === "goal_command_canceled")?.payload,
      {
        turnId: "goal-turn",
        operationId: "goal-op",
        revision: 1,
        repairEpoch: 2,
        action: "set",
        reason: "cancel_requested"
      }
    );
  } finally {
    restoreSink();
  }
});

test("canonical root cancel retires the generation behind an active synthetic continuation", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  let interrupts = 0;
  let closes = 0;
  try {
    const session = new SessionRuntime(
      "provider-session-synthetic-cancel",
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
        const query = fakeGuidedDelegatedContinuationQuery(prompt);
        return {
          ...query,
          async interrupt() {
            interrupts += 1;
            await query.interrupt();
          },
          close() {
            closes += 1;
            query.close();
          }
        };
      },
      100
    );

    await session.start();
    session.exec("turn-root", "delegate task");
    await waitForEvent(events, "turn_started");

    const synthetic = events.find(
      (event) => event.type === "turn_started" && event.payload?.synthetic
    );
    assert.match(String(synthetic?.payload?.turnId ?? ""), /^synthetic-/u);

    const result = await session.cancel("turn-root");

    assert.equal(result.canceled, true);
    assert.equal(result.turnId, "turn-root");
    assert.equal(interrupts, 1);
    assert.equal(closes, 1);
    assert.equal(session.query, undefined);
    assert.equal(
      events.some(
        (event) =>
          event.type === "turn_canceled" &&
          event.payload?.turnId === synthetic?.payload?.turnId
      ),
      true
    );

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(
      events.some(
        (event) =>
          event.type === "assistant_completed" &&
          event.payload?.content === "Guided continuation."
      ),
      false
    );
  } finally {
    restoreSink();
  }
});

for (const permissionModeId of ["default", "bypassPermissions"] as const) {
  test(`cancel retires ${permissionModeId} query before background completion can run another tool`, async () => {
    const events: Array<{ type: string; payload?: Record<string, unknown> }> =
      [];
    const restoreSink = withSidecarEventSinkForTest((event) =>
      events.push(event)
    );
    let queryCount = 0;
    let closeCount = 0;
    const shutdownOrder: string[] = [];
    let latePermissionResult: PermissionResult | undefined;
    let resumedOptions: ClaudeQueryOptions | undefined;
    let releaseBackground: () => void = () => {};
    let markFirstPromptObserved: () => void = () => {};
    let markLatePermissionChecked: () => void = () => {};
    const backgroundCompletion = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    const firstPromptObserved = new Promise<void>((resolve) => {
      markFirstPromptObserved = resolve;
    });
    const latePermissionChecked = new Promise<void>((resolve) => {
      markLatePermissionChecked = resolve;
    });

    try {
      const session = new SessionRuntime(
        "provider-session-1",
        "/repo",
        {},
        false,
        false,
        {
          model: "",
          permissionModeId,
          planMode: false,
          effort: "",
          speed: ""
        },
        sidecarClaudeOptionsFromPayload({}),
        undefined,
        ({ prompt, options }) => {
          queryCount += 1;
          if (queryCount === 1) {
            return backgroundCompletionQuery({
              prompt,
              options,
              backgroundCompletion,
              onPromptObserved: markFirstPromptObserved,
              onInterrupt: () => {
                shutdownOrder.push("interrupt");
                releaseBackground();
              },
              onInterruptSettled: () => {
                shutdownOrder.push("interrupt-settled");
              },
              onPermissionResult: (result) => {
                latePermissionResult = result;
                markLatePermissionChecked();
              },
              onClose: () => {
                shutdownOrder.push("close");
                closeCount += 1;
              },
              permissionChecked: latePermissionChecked
            });
          }
          resumedOptions = options;
          return resumedQuery(prompt, () => {
            closeCount += 1;
          });
        }
      );

      await session.start();
      session.exec("turn-1", "create a site in the background");
      await firstPromptObserved;
      const cancelResult = await session.cancel();
      await waitForEvent(events, "turn_canceled");

      assert.equal(cancelResult.disposition, "provider_active");
      assert.equal(cancelResult.providerTurnId.length > 0, true);
      assert.equal(closeCount, 1);
      assert.deepEqual(shutdownOrder, [
        "interrupt",
        "interrupt-settled",
        "close"
      ]);
      assert.deepEqual(latePermissionResult, {
        behavior: "deny",
        message: "Tool use aborted"
      });
      assert.equal(
        events.some((event) => event.type === "turn_started"),
        false
      );
      assert.equal(
        events.some((event) => event.type === "approval_requested"),
        false
      );
      assert.equal(
        events.some(
          (event) =>
            event.type === "assistant_completed" &&
            event.payload?.content === "Running ls after background completion"
        ),
        false
      );

      session.exec("turn-2", "continue with a real user prompt");
      await waitForEvent(events, "turn_completed");

      assert.equal(queryCount, 2);
      assert.equal(resumedOptions?.resume, "provider-session-1");
      assert.equal(Object.hasOwn(resumedOptions ?? {}, "sessionId"), false);
      assert.equal(
        events.some(
          (event) =>
            event.type === "assistant_completed" &&
            event.payload?.content === "Resumed after cancellation"
        ),
        true
      );
      const completedTurns = events.filter(
        (event) => event.type === "turn_completed"
      );
      assert.equal(completedTurns.length, 1);
      assert.equal(completedTurns[0]?.payload?.turnId, "turn-2");
      assert.equal(
        events.some((event) => event.type === "turn_started"),
        false
      );
      assert.equal(
        events.some(
          (event) =>
            event.type === "sdk_lifecycle_observed" &&
            event.payload?.sdkMessageSubtype === "task_notification"
        ),
        false
      );
    } finally {
      restoreSink();
    }
  });
}

function backgroundCompletionQuery(options: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: ClaudeQueryOptions;
  backgroundCompletion: Promise<void>;
  onPromptObserved: () => void;
  onInterrupt: () => void;
  onInterruptSettled: () => void;
  onPermissionResult: (result: PermissionResult | undefined) => void;
  onClose: () => void;
  permissionChecked: Promise<void>;
}): AsyncIterable<SDKMessage> & {
  interrupt: () => Promise<void>;
  close: () => void;
} {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await options.prompt[Symbol.asyncIterator]().next();
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
      options.onPromptObserved();
      await options.backgroundCompletion;
      const result = await options.options.canUseTool?.(
        "Bash",
        { command: "ls -la /repo/site" },
        testCanUseToolOptions({
          requestId: "late-background-ls",
          toolUseID: "toolu-late-background-ls"
        })
      );
      options.onPermissionResult(result ?? undefined);
      if (result?.behavior === "allow") {
        yield consolidatedAssistant("assistant-late", "msg-late", [
          {
            type: "text",
            text: "Running ls after background completion"
          }
        ]);
      }
    },
    async interrupt() {
      options.onInterrupt();
      await options.permissionChecked;
      options.onInterruptSettled();
    },
    close() {
      options.onClose();
    }
  };
}

function resumedQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  onClose: () => void
): AsyncIterable<SDKMessage> & { close: () => void } {
  return {
    async *[Symbol.asyncIterator]() {
      const next = await prompt[Symbol.asyncIterator]().next();
      yield {
        ...next.value,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield {
        type: "system",
        subtype: "task_notification",
        task_id: "old-background-task",
        tool_use_id: "toolu-old-background-task",
        status: "stopped"
      } as unknown as SDKMessage;
      yield { type: "result", subtype: "success" } as unknown as SDKMessage;
      yield consolidatedAssistant("assistant-resumed", "msg-resumed", [
        { type: "text", text: "Resumed after cancellation" }
      ]);
      yield { type: "result", subtype: "success" } as unknown as SDKMessage;
    },
    close: onClose
  };
}
