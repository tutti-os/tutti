import assert from "node:assert/strict";
import test from "node:test";
import type {
  Options as ClaudeQueryOptions,
  SDKMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import { withSidecarEventSinkForTest } from "./eventSink.ts";
import { sidecarClaudeOptionsFromPayload } from "./options.ts";
import { SessionRuntime } from "./sessionRuntime.ts";
import { waitForEvent } from "./sessionRuntimeTestQueries.nested.ts";

type FirstTurnOutcome = "connection-error" | "http-error" | "retry-success";

function recoveryQueryFactory(
  outcome: FirstTurnOutcome,
  calls: Array<{ generation: number; options: ClaudeQueryOptions }>,
  closes: number[]
) {
  return ({
    prompt,
    options
  }: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: ClaudeQueryOptions;
  }) => {
    const generation = calls.length + 1;
    calls.push({ generation, options });
    return {
      async *[Symbol.asyncIterator]() {
        let promptNumber = 0;
        for await (const message of prompt) {
          promptNumber += 1;
          yield {
            ...message,
            type: "user",
            parent_tool_use_id: null,
            session_id: "provider-session-recovery"
          } as SDKMessage;
          if (generation === 1 && promptNumber === 1) {
            yield {
              type: "system",
              subtype: "api_retry",
              attempt: 1,
              max_retries: 3,
              retry_delay_ms: 100,
              error_status: null,
              error: "unknown",
              uuid: "00000000-0000-4000-8000-000000000001",
              session_id: "provider-session-recovery"
            } as SDKMessage;
            if (outcome === "connection-error") {
              yield {
                type: "result",
                subtype: "success",
                is_error: true,
                api_error_status: null,
                result:
                  "API Error: Unable to connect to API (ConnectionRefused)",
                session_id: "provider-session-recovery"
              } as SDKMessage;
              continue;
            }
            if (outcome === "http-error") {
              yield {
                type: "result",
                subtype: "success",
                is_error: true,
                api_error_status: 401,
                result: "API Error: Unauthorized",
                session_id: "provider-session-recovery"
              } as SDKMessage;
              continue;
            }
          }
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "ok",
            session_id: "provider-session-recovery"
          } as SDKMessage;
        }
      },
      close() {
        closes.push(generation);
      }
    };
  };
}

function createSession(
  outcome: FirstTurnOutcome,
  calls: Array<{ generation: number; options: ClaudeQueryOptions }>,
  closes: number[]
): SessionRuntime {
  return new SessionRuntime(
    "provider-session-recovery",
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
    recoveryQueryFactory(outcome, calls, closes)
  );
}

test("terminal SDK connection error replaces the query before the next turn", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const calls: Array<{
    generation: number;
    options: ClaudeQueryOptions;
  }> = [];
  const closes: number[] = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  const session = createSession("connection-error", calls, closes);
  try {
    await session.start();
    session.exec("turn-failed", "first");
    await waitForEvent(events, "turn_failed");

    const retry = events.find(
      (event) =>
        event.type === "sdk_lifecycle_observed" &&
        event.payload?.sdkMessageSubtype === "api_retry"
    );
    assert.equal(retry?.payload?.sdkConnectionError, true);
    assert.equal(retry?.payload?.sdkRetryAttempt, 1);
    assert.equal(retry?.payload?.sdkMaxRetries, 3);
    assert.equal(retry?.payload?.sdkRetryDelayMs, 100);

    session.exec("turn-recovered", "second");
    await waitForEvent(events, "turn_completed");

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.options.sessionId, "provider-session-recovery");
    assert.equal(calls[1]?.options.resume, "provider-session-recovery");
    assert.deepEqual(closes, [1]);
  } finally {
    await session.close();
    restoreSink();
  }
});

test("terminal SDK connection error fails another turn queued on the retired query", async () => {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const calls: Array<{
    generation: number;
    options: ClaudeQueryOptions;
  }> = [];
  const closes: number[] = [];
  const restoreSink = withSidecarEventSinkForTest((event) =>
    events.push(event)
  );
  const session = createSession("connection-error", calls, closes);
  try {
    await session.start();
    session.exec("turn-failed", "first");
    session.exec("turn-queued", "second");
    await waitForEvent(events, "turn_failed");

    assert.deepEqual(
      events
        .filter((event) => event.type === "turn_failed")
        .map((event) => event.payload?.turnId)
        .sort(),
      ["turn-failed", "turn-queued"]
    );
  } finally {
    await session.close();
    restoreSink();
  }
});

for (const scenario of [
  {
    name: "a transient connection retry that succeeds",
    outcome: "retry-success" as const
  },
  {
    name: "a terminal HTTP authentication error",
    outcome: "http-error" as const
  }
]) {
  test(`${scenario.name} resumes a fresh query on the next turn`, async () => {
    const events: Array<{ type: string; payload?: Record<string, unknown> }> =
      [];
    const calls: Array<{
      generation: number;
      options: ClaudeQueryOptions;
    }> = [];
    const closes: number[] = [];
    const restoreSink = withSidecarEventSinkForTest((event) =>
      events.push(event)
    );
    const session = createSession(scenario.outcome, calls, closes);
    try {
      await session.start();
      session.exec("turn-first", "first");
      await waitForEvent(
        events,
        scenario.outcome === "http-error" ? "turn_failed" : "turn_completed"
      );

      events.length = 0;
      session.exec("turn-second", "second");
      await waitForEvent(events, "turn_completed");

      assert.equal(calls.length, 2);
      assert.equal(calls[0]?.options.sessionId, "provider-session-recovery");
      assert.equal(calls[1]?.options.resume, "provider-session-recovery");
      assert.deepEqual(closes, [1]);
    } finally {
      await session.close();
      restoreSink();
    }
  });
}
