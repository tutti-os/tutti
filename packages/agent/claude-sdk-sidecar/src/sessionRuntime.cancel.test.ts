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
import { waitForEvent } from "./sessionRuntimeTestQueries.nested.ts";

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
      await session.cancel();
      await waitForEvent(events, "turn_canceled");

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
