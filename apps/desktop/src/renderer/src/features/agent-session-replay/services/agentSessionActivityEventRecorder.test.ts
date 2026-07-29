import assert from "node:assert/strict";
import test from "node:test";
import type {
  EngineExternalCommand,
  EngineIntent
} from "@tutti-os/agent-activity-core";
import {
  AgentSessionActivityEventRecorder,
  createTuttidAgentSessionActivityEventAppender,
  type AgentSessionActivityEvent
} from "./agentSessionActivityEventRecorder.ts";

test("records replayable intents and their command effects in one sequence", async () => {
  const appended: AgentSessionActivityEvent[] = [];
  let now = 100;
  const recorder = new AgentSessionActivityEventRecorder({
    appender: {
      async append(input) {
        appended.push(...input.events);
        assert.equal(input.recordingId, "recording-1");
      }
    },
    nowUnixMs: () => now++
  });
  recorder.start({ recordingId: "recording-1", scopeId: "workspace-1" });

  const submit = {
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    content: [{ text: "keep going", type: "text" }],
    expiresAtUnixMs: 5_000,
    requestedAtUnixMs: 90,
    routing: "auto",
    type: "submit/requested",
    workspaceId: "workspace-1"
  } satisfies EngineIntent;
  recorder.observeIntent(submit);

  const command = {
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    commandId: "submit:send:submit-1",
    content: submit.content,
    correlationId: "submit-1",
    guidance: true,
    promptId: "submit-1",
    type: "queue/sendPrompt",
    workspaceId: "workspace-1"
  } satisfies EngineExternalCommand;
  recorder.observeCommand(command);
  recorder.observeIntent({
    commandId: command.commandId,
    commandType: command.type,
    correlationId: "submit-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: { turnId: "turn-1" }
  });

  await recorder.seal();

  assert.deepEqual(appended, [
    {
      agentSessionId: "session-1",
      correlationId: "submit-1",
      eventId: "recording-1:activity:1",
      kind: "intent",
      occurredAtUnixMs: 100,
      payload: {
        clientSubmitId: "submit-1",
        content: [{ text: "keep going", type: "text" }],
        expiresAtUnixMs: 5_000,
        requestedAtUnixMs: 90,
        routing: "auto"
      },
      schemaVersion: 3,
      scopeId: "workspace-1",
      sequence: 1,
      type: "submit/requested"
    },
    {
      agentSessionId: "session-1",
      causedByEventId: "recording-1:activity:1",
      correlationId: "submit-1",
      eventId: "recording-1:activity:2",
      kind: "effect",
      occurredAtUnixMs: 101,
      payload: {
        clientSubmitId: "submit-1",
        content: [{ text: "keep going", type: "text" }],
        guidance: true,
        outcome: "succeeded",
        promptId: "submit-1",
        result: { turnId: "turn-1" }
      },
      schemaVersion: 3,
      scopeId: "workspace-1",
      sequence: 2,
      type: "queue/sendPrompt"
    }
  ]);
});

test("filters runtime intents and effects that cannot drive replay", async () => {
  const batches: readonly AgentSessionActivityEvent[][] = [];
  const recorder = new AgentSessionActivityEventRecorder({
    appender: {
      async append(input) {
        (batches as AgentSessionActivityEvent[][]).push(input.events.slice());
      }
    }
  });
  recorder.start({ recordingId: "recording-1", scopeId: "workspace-1" });

  recorder.observeIntent({
    status: "connected",
    type: "engine/connectionChanged"
  });
  recorder.observeCommand({
    commandId: "probe-1",
    type: "engine/probe"
  });
  recorder.observeIntent({
    commandId: "probe-1",
    commandType: "engine/probe",
    outcome: "succeeded",
    type: "engine/commandResult"
  });
  recorder.observeCommand({
    agentSessionId: "session-1",
    clientSubmitId: "submit-without-intent",
    commandId: "send-without-intent",
    content: [{ text: "orphan", type: "text" }],
    correlationId: "submit-without-intent",
    promptId: "submit-without-intent",
    type: "queue/sendPrompt",
    workspaceId: "workspace-1"
  });
  recorder.observeIntent({
    commandId: "send-without-intent",
    commandType: "queue/sendPrompt",
    correlationId: "submit-without-intent",
    outcome: "succeeded",
    type: "engine/commandResult"
  });

  await recorder.seal();
  assert.deepEqual(batches, []);
});

test("flush keeps events appended while an earlier batch is in flight", async () => {
  const firstWrite = deferred<void>();
  const batches: AgentSessionActivityEvent[][] = [];
  const recorder = new AgentSessionActivityEventRecorder({
    appender: {
      async append(input) {
        batches.push(input.events.slice());
        if (batches.length === 1) {
          await firstWrite.promise;
        }
      }
    }
  });
  recorder.start({ recordingId: "recording-1", scopeId: "workspace-1" });
  recorder.observeIntent(queueRemoved("prompt-1"));

  const flush = recorder.flush();
  recorder.observeIntent(queueRemoved("prompt-2"));
  firstWrite.resolve();
  await flush;

  assert.deepEqual(
    batches.map((batch) => batch.map((event) => event.sequence)),
    [[1], [2]]
  );
});

test("failed seal retains the batch for retry and stops new observations", async () => {
  let attempts = 0;
  const appended: AgentSessionActivityEvent[] = [];
  const recorder = new AgentSessionActivityEventRecorder({
    appender: {
      async append(input) {
        attempts += 1;
        if (attempts === 1) throw new Error("transport unavailable");
        appended.push(...input.events);
      }
    }
  });
  recorder.start({ recordingId: "recording-1", scopeId: "workspace-1" });
  recorder.observeIntent(queueRemoved("prompt-1"));

  await assert.rejects(recorder.seal(), /transport unavailable/);
  recorder.observeIntent(queueRemoved("prompt-2"));
  await recorder.seal();

  assert.equal(attempts, 2);
  assert.deepEqual(
    appended.map((event) => event.payload.promptId),
    ["prompt-1"]
  );
});

test("buffers a clone instead of retaining mutable intent data", async () => {
  const appended: AgentSessionActivityEvent[] = [];
  const content = [{ text: "before", type: "text" as const }];
  const recorder = new AgentSessionActivityEventRecorder({
    appender: {
      async append(input) {
        appended.push(...input.events);
      }
    }
  });
  recorder.start({ recordingId: "recording-1", scopeId: "workspace-1" });
  recorder.observeIntent({
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    content,
    expiresAtUnixMs: 5_000,
    requestedAtUnixMs: 90,
    type: "submit/requested",
    workspaceId: "workspace-1"
  });
  content[0]!.text = "after";

  await recorder.seal();
  assert.deepEqual(appended[0]?.payload.content, [
    { text: "before", type: "text" }
  ]);
});

test("tuttid appender strips local sequence fields from the HTTP request", async () => {
  let received: unknown;
  const appender = createTuttidAgentSessionActivityEventAppender({
    tuttidClient: {
      async appendAgentSessionRecordingActivityEvents(...args) {
        received = args;
        return { acceptedThroughSequence: 1 };
      }
    },
    workspaceId: " workspace-1 "
  });

  await appender.append({
    events: [
      {
        agentSessionId: "session-1",
        eventId: "recording-1:activity:1",
        kind: "intent",
        occurredAtUnixMs: 100,
        payload: { promptId: "prompt-1" },
        schemaVersion: 3,
        scopeId: "workspace-1",
        sequence: 1,
        type: "queue/removed"
      }
    ],
    recordingId: "recording-1"
  });

  assert.deepEqual(received, [
    "workspace-1",
    "recording-1",
    {
      events: [
        {
          agentSessionId: "session-1",
          eventId: "recording-1:activity:1",
          kind: "intent",
          occurredAtUnixMs: 100,
          payload: { promptId: "prompt-1" },
          type: "queue/removed"
        }
      ]
    }
  ]);
});

function queueRemoved(promptId: string): EngineIntent {
  return {
    agentSessionId: "session-1",
    promptId,
    type: "queue/removed"
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
