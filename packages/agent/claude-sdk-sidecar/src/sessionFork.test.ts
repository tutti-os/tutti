import assert from "node:assert/strict";
import test from "node:test";
import {
  forkSession as sdkForkSession,
  getSessionInfo as sdkGetSessionInfo,
  getSessionMessages as sdkGetSessionMessages,
  InMemorySessionStore
} from "@anthropic-ai/claude-agent-sdk";
import {
  forkClaudeSession,
  inspectClaudeForkCheckpoints
} from "./sessionFork.ts";

const childSessionId = "11111111-1111-4111-8111-111111111111";
const grandchildSessionId = "22222222-2222-4222-8222-222222222222";
const source = [
  message("user", "prompt-1", { role: "user", content: "one" }),
  message("assistant", "answer-1", { role: "assistant", content: "first" }),
  message("user", "prompt-2", { role: "user", content: "two" }),
  message("assistant", "answer-2", { role: "assistant", content: "second" })
];
const child = [
  message(
    "user",
    "child-prompt-1",
    { role: "user", content: "one" },
    childSessionId
  ),
  message(
    "assistant",
    "child-answer-1",
    { role: "assistant", content: "first" },
    childSessionId
  )
];

test("Claude fork inspection exposes only root user message UUIDs", async () => {
  const result = await inspectClaudeForkCheckpoints(
    { sessionId: "source", cwd: "/workspace" },
    fakeSDK()
  );
  assert.deepEqual(result, { providerTurnIds: ["prompt-1", "prompt-2"] });
});

test("Claude fork uses the official mutation and maps remapped UUIDs", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-1",
      providerTurnIds: ["prompt-1"],
      cwd: "/workspace",
      title: "Source (2)"
    },
    fakeSDK(calls)
  );

  assert.equal(result.providerSessionId, childSessionId);
  assert.deepEqual(result.targetProviderTurnIds, ["child-prompt-1"]);
  assert.equal(result.stateBindingMode, "provider_owned");
  assert.match(String(result.stateBindingReceipt), /^claude-sdk-fork-v1:/);
  assert.deepEqual(calls, [
    {
      sessionId: "source",
      options: {
        dir: "/workspace",
        upToMessageId: "answer-1",
        title: "Source (2)"
      }
    }
  ]);
});

test("official Claude fork preserves a trailing system checkpoint", async () => {
  const store = new InMemorySessionStore();
  const projectKey = "-workspace";
  const sourceSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const sourcePrompt1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const sourceAnswer1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const sourceSystem = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const sourcePrompt2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const sourceAnswer2 = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  await store.append({ projectKey, sessionId: sourceSessionId }, [
    transcriptEntry("user", sourcePrompt1, null, sourceSessionId, {
      role: "user",
      content: "one"
    }),
    transcriptEntry(
      "assistant",
      sourceAnswer1,
      sourcePrompt1,
      sourceSessionId,
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }]
      }
    ),
    {
      type: "system",
      subtype: "stop_hook_summary",
      uuid: sourceSystem,
      parentUuid: sourceAnswer1,
      sessionId: sourceSessionId,
      timestamp: "2026-01-01T00:00:02.000Z"
    },
    transcriptEntry("user", sourcePrompt2, sourceSystem, sourceSessionId, {
      role: "user",
      content: "two"
    }),
    transcriptEntry(
      "assistant",
      sourceAnswer2,
      sourcePrompt2,
      sourceSessionId,
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }]
      }
    )
  ]);
  const sdk = inMemorySDK(store);

  const result = await forkClaudeSession(
    {
      sessionId: sourceSessionId,
      providerTurnId: sourcePrompt1,
      providerTurnIds: [sourcePrompt1],
      cwd: "/workspace",
      title: "Child"
    },
    sdk
  );

  const providerSessionId = String(result.providerSessionId);
  assert.notEqual(providerSessionId, sourceSessionId);
  assert.match(
    providerSessionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
  );
  assert.ok(Array.isArray(result.targetProviderTurnIds));
  assert.equal(result.targetProviderTurnIds.length, 1);
  assert.match(
    String(result.targetProviderTurnIds[0]),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
  );
  assert.notEqual(result.targetProviderTurnIds[0], sourcePrompt1);
  assert.ok(
    store
      .getEntries({ projectKey, sessionId: providerSessionId })
      .some(
        (entry) =>
          entry.type === "system" && entry.subtype === "stop_hook_summary"
      )
  );
});

test("Claude fork accepts a child readable only through its transcript", async () => {
  const sdk = fakeSDK();
  sdk.getSessionInfo = (async () => undefined) as never;
  const result = await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-1",
      providerTurnIds: ["prompt-1"],
      cwd: "/workspace",
      title: "Child"
    },
    sdk
  );
  assert.equal(result.providerSessionId, childSessionId);
});

test("Claude fork reports the provider stage and cause after mutation starts", async () => {
  const sdk = fakeSDK();
  sdk.forkSession = (async () => {
    throw new Error("connection lost");
  }) as never;

  await assert.rejects(
    forkClaudeSession(
      {
        sessionId: "source",
        providerTurnId: "prompt-1",
        providerTurnIds: ["prompt-1"],
        cwd: "/workspace",
        title: "Source (2)"
      },
      sdk
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("provider_fork") &&
      error.message.includes("connection lost") &&
      "stage" in error &&
      error.stage === "provider_fork" &&
      "deliveryDisposition" in error &&
      error.deliveryDisposition === "unknown"
  );
});

test("Claude fork validates checkpoint identity before SDK mutation", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const sdk = fakeSDK(calls);
  sdk.getSessionMessages = (async () => [
    message("user", "prompt-1", { role: "user", content: "one" }),
    message("assistant", "", { role: "assistant", content: "first" })
  ]) as never;

  await assert.rejects(
    forkClaudeSession(
      {
        sessionId: "source",
        providerTurnId: "prompt-1",
        providerTurnIds: ["prompt-1"],
        cwd: "/workspace",
        title: ""
      },
      sdk
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("source_validation") &&
      "deliveryDisposition" in error &&
      error.deliveryDisposition === "not_started"
  );
  assert.deepEqual(calls, []);
});

test("Claude fork supports an untitled canonical session", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-1",
      providerTurnIds: ["prompt-1"],
      cwd: "/workspace",
      title: " "
    },
    fakeSDK(calls)
  );

  assert.equal(result.providerSessionId, childSessionId);
  assert.deepEqual(calls, [
    {
      sessionId: "source",
      options: {
        dir: "/workspace",
        upToMessageId: "answer-1"
      }
    }
  ]);
});

test("Claude fork reports child verification mismatch as unknown", async () => {
  const sdk = fakeSDK(
    [],
    [
      message(
        "user",
        "child-prompt-1",
        { role: "user", content: "changed" },
        childSessionId
      ),
      child[1]!
    ]
  );

  await assert.rejects(
    forkClaudeSession(
      {
        sessionId: "source",
        providerTurnId: "prompt-1",
        providerTurnIds: ["prompt-1"],
        cwd: "/workspace",
        title: "Child"
      },
      sdk
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("child_verification") &&
      "deliveryDisposition" in error &&
      error.deliveryDisposition === "unknown"
  );
});

test("Claude fork can branch again from a provider-owned child", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const grandchild = [
    message(
      "user",
      "grandchild-prompt-1",
      { role: "user", content: "one" },
      grandchildSessionId
    ),
    message(
      "assistant",
      "grandchild-answer-1",
      { role: "assistant", content: "first" },
      grandchildSessionId
    )
  ];
  let created = false;
  const sdk = {
    getSessionMessages: async (sessionId: string) => {
      if (sessionId === childSessionId) {
        return child;
      }
      if (sessionId === grandchildSessionId) {
        return created ? grandchild : [];
      }
      return [];
    },
    getSessionInfo: async (sessionId: string) =>
      sessionId === grandchildSessionId && created
        ? {
            sessionId,
            summary: "grandchild",
            lastModified: 1
          }
        : undefined,
    forkSession: (async (
      sessionId: string,
      options?: Record<string, unknown>
    ) => {
      calls.push({ sessionId, options });
      created = true;
      return { sessionId: grandchildSessionId };
    }) as never
  };

  const result = await forkClaudeSession(
    {
      sessionId: childSessionId,
      providerTurnId: "child-prompt-1",
      providerTurnIds: ["child-prompt-1"],
      cwd: "/workspace",
      title: "Grandchild"
    },
    sdk
  );

  assert.equal(result.providerSessionId, grandchildSessionId);
  assert.deepEqual(result.targetProviderTurnIds, ["grandchild-prompt-1"]);
  assert.deepEqual(calls, [
    {
      sessionId: childSessionId,
      options: {
        dir: "/workspace",
        upToMessageId: "child-answer-1",
        title: "Grandchild"
      }
    }
  ]);
});

function fakeSDK(
  calls: Array<Record<string, unknown>> = [],
  forkedMessages = child
) {
  let created = false;
  return {
    getSessionMessages: async (sessionId: string) => {
      if (sessionId === childSessionId) {
        return created ? forkedMessages : [];
      }
      return source;
    },
    getSessionInfo: async (sessionId: string) =>
      sessionId === childSessionId && created
        ? {
            sessionId,
            summary: "child",
            lastModified: 1
          }
        : undefined,
    forkSession: (async (
      sessionId: string,
      options?: Record<string, unknown>
    ) => {
      calls.push({ sessionId, options });
      created = true;
      return { sessionId: childSessionId };
    }) as never
  };
}

function inMemorySDK(store: InMemorySessionStore) {
  return {
    forkSession: ((sessionId, options) =>
      sdkForkSession(sessionId, {
        ...options,
        sessionStore: store
      })) as typeof sdkForkSession,
    getSessionInfo: ((sessionId, options) =>
      sdkGetSessionInfo(sessionId, {
        ...options,
        sessionStore: store
      })) as typeof sdkGetSessionInfo,
    getSessionMessages: ((sessionId, options) =>
      sdkGetSessionMessages(sessionId, {
        ...options,
        sessionStore: store
      })) as typeof sdkGetSessionMessages
  };
}

function transcriptEntry(
  type: "user" | "assistant",
  uuid: string,
  parentUuid: string | null,
  sessionId: string,
  content: unknown
) {
  return {
    type,
    uuid,
    parentUuid,
    sessionId,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: content
  };
}

function message(
  type: "user" | "assistant" | "system",
  uuid: string,
  content: unknown,
  sessionId = "source"
) {
  return {
    type,
    uuid,
    session_id: sessionId,
    message: content,
    parent_tool_use_id: null
  };
}
