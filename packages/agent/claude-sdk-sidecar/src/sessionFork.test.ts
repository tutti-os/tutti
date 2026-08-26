import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import {
  forkSession as sdkForkSession,
  getSessionInfo as sdkGetSessionInfo,
  getSessionMessages as sdkGetSessionMessages,
  InMemorySessionStore
} from "@anthropic-ai/claude-agent-sdk";
import {
  forkClaudeSession,
  inspectClaudeForkCheckpoints,
  recoverClaudeTurnBinding,
  resolveClaudeTurnBindingByRecoveryToken
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
const childThroughSecond = [
  ...child,
  message(
    "user",
    "child-prompt-2",
    { role: "user", content: "two" },
    childSessionId
  ),
  message(
    "assistant",
    "child-answer-2",
    { role: "assistant", content: "second" },
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

test("Claude fork inspection excludes top-level tool result messages", async () => {
  const sdk = fakeSDK();
  sdk.getSessionMessages = (async () => [
    message("user", "prompt-1", { role: "user", content: "one" }),
    message("assistant", "tool-call-1", {
      role: "assistant",
      content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }]
    }),
    message("user", "tool-result-1", {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool-1", content: "result" }
      ]
    }),
    message("assistant", "answer-1", {
      role: "assistant",
      content: "first"
    }),
    message("user", "prompt-2", { role: "user", content: "two" }),
    message("assistant", "answer-2", {
      role: "assistant",
      content: "second"
    })
  ]) as typeof sdk.getSessionMessages;

  const result = await inspectClaudeForkCheckpoints(
    { sessionId: "source", cwd: "/workspace" },
    sdk
  );

  assert.deepEqual(result, { providerTurnIds: ["prompt-1", "prompt-2"] });
});

test("Claude turn recovery resolves one exact opaque UUID and checkpoint", async () => {
  const token = "opaque-submit-2";
  const sdk = fakeSDK();
  sdk.getSessionMessages = (async () => [
    message("user", "prompt-1", {
      role: "user",
      content: "one"
    }),
    message("assistant", "answer-1", {
      role: "assistant",
      content: "first"
    }),
    message("user", token, {
      role: "user",
      content: "two"
    }),
    message("assistant", "answer-2", {
      role: "assistant",
      content: "second"
    })
  ]) as typeof sdk.getSessionMessages;
  const result = await recoverClaudeTurnBinding(
    {
      sessionId: "source",
      cwd: "/workspace",
      recoveryToken: token,
      legacyTextHMACKey: "",
      legacyTextHMACDigest: ""
    },
    sdk
  );
  assert.deepEqual(result, {
    providerSessionId: "source",
    providerTurnId: token,
    providerCheckpointMessageId: "answer-2"
  });
  assert.deepEqual(
    await resolveClaudeTurnBindingByRecoveryToken(
      {
        sessionId: "source",
        cwd: "/workspace",
        recoveryToken: token
      },
      sdk
    ),
    result
  );
});

test("Claude legacy text recovery fails closed for multimodal content", async () => {
  const key = randomBytes(32);
  const digest = createHmac("sha256", key).update("legacy text").digest();
  const sdk = fakeSDK();
  sdk.getSessionMessages = (async () => [
    message("user", "prompt-legacy", {
      role: "user",
      content: [
        { type: "text", text: "legacy text" },
        { type: "image", source: { type: "base64", data: "AA==" } }
      ]
    }),
    message("assistant", "answer-legacy", {
      role: "assistant",
      content: "answer"
    })
  ]) as typeof sdk.getSessionMessages;
  await assert.rejects(
    recoverClaudeTurnBinding(
      {
        sessionId: "source",
        cwd: "/workspace",
        recoveryToken: "",
        legacyTextHMACKey: key.toString("base64url"),
        legacyTextHMACDigest: digest.toString("base64url")
      },
      sdk
    ),
    /proof is absent/
  );
});

test("Claude legacy text recovery accepts one complete exact HMAC proof", async () => {
  const key = randomBytes(32);
  const digest = createHmac("sha256", key).update("legacy text").digest();
  const sdk = fakeSDK();
  sdk.getSessionMessages = (async () => [
    message("user", "provider-legacy", {
      role: "user",
      content: "legacy text"
    }),
    message("assistant", "checkpoint-legacy", {
      role: "assistant",
      content: "answer"
    })
  ]) as typeof sdk.getSessionMessages;
  const result = await recoverClaudeTurnBinding(
    {
      sessionId: "source",
      cwd: "/workspace",
      recoveryToken: "",
      legacyTextHMACKey: key.toString("base64url"),
      legacyTextHMACDigest: digest.toString("base64url")
    },
    sdk
  );
  assert.deepEqual(result, {
    providerSessionId: "source",
    providerTurnId: "provider-legacy",
    providerCheckpointMessageId: "checkpoint-legacy"
  });
});

test("Claude fork uses the official mutation and maps remapped UUIDs", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-1",
      providerCheckpointMessageId: "",
      cwd: "/workspace",
      title: "Source (2)"
    },
    fakeSDK(calls)
  );

  assert.equal(result.providerSessionId, childSessionId);
  assert.deepEqual(result.targetProviderTurnBindings, [
    {
      providerTurnId: "child-prompt-1",
      checkpointMessageId: "child-answer-1"
    }
  ]);
  assert.equal(result.stateBindingMode, "provider_owned");
  assert.match(String(result.stateBindingReceipt), /^claude-sdk-fork-v3:/);
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

test("Claude fork uses a persisted checkpoint without reading the source transcript", async () => {
  let sourceReads = 0;
  const sdk = fakeSDK();
  const getSessionMessages = sdk.getSessionMessages;
  sdk.getSessionMessages = async (sessionId: string) => {
    if (sessionId === "source") {
      sourceReads += 1;
    }
    return getSessionMessages(sessionId);
  };

  const result = await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-1",
      providerCheckpointMessageId: "answer-1",
      cwd: "/workspace",
      title: "Child"
    },
    sdk
  );

  assert.equal(sourceReads, 0);
  assert.deepEqual(result.targetProviderTurnBindings, [
    {
      providerTurnId: "child-prompt-1",
      checkpointMessageId: "child-answer-1"
    }
  ]);
});

test("Claude fork returns every child provider turn and checkpoint binding", async () => {
  const result = await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-2",
      providerCheckpointMessageId: "answer-2",
      cwd: "/workspace",
      title: "Child"
    },
    fakeSDK([], childThroughSecond)
  );

  assert.deepEqual(result.targetProviderTurnBindings, [
    {
      providerTurnId: "child-prompt-1",
      checkpointMessageId: "child-answer-1"
    },
    {
      providerTurnId: "child-prompt-2",
      checkpointMessageId: "child-answer-2"
    }
  ]);
});

test("Claude fork keeps tool results inside their canonical turn binding", async () => {
  const childWithToolResult = [
    message(
      "user",
      "child-prompt-1",
      { role: "user", content: "one" },
      childSessionId
    ),
    message(
      "assistant",
      "child-tool-call-1",
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }]
      },
      childSessionId
    ),
    message(
      "user",
      "child-tool-result-1",
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "result" }
        ]
      },
      childSessionId
    ),
    message(
      "assistant",
      "child-answer-1",
      { role: "assistant", content: "first" },
      childSessionId
    ),
    message(
      "user",
      "child-prompt-2",
      { role: "user", content: "two" },
      childSessionId
    ),
    message(
      "assistant",
      "child-answer-2",
      { role: "assistant", content: "second" },
      childSessionId
    )
  ];

  const result = await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-2",
      providerCheckpointMessageId: "answer-2",
      cwd: "/workspace",
      title: "Child"
    },
    fakeSDK([], childWithToolResult)
  );

  assert.deepEqual(result.targetProviderTurnBindings, [
    {
      providerTurnId: "child-prompt-1",
      checkpointMessageId: "child-answer-1"
    },
    {
      providerTurnId: "child-prompt-2",
      checkpointMessageId: "child-answer-2"
    }
  ]);
});

test("Claude fork recovers an ephemeral persisted checkpoint before creating a child", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const sdk = fakeSDK(calls);
  const forkSession = sdk.forkSession as unknown as (
    sessionId: string,
    options?: Record<string, unknown>
  ) => Promise<{ sessionId: string }>;
  sdk.forkSession = (async (
    sessionId: string,
    options?: Record<string, unknown>
  ) => {
    if (options?.upToMessageId === "ephemeral-idle") {
      calls.push({ sessionId, options });
      throw new Error("Message ephemeral-idle not found in session source");
    }
    return forkSession(sessionId, options);
  }) as never;

  const result = await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-1",
      providerCheckpointMessageId: "ephemeral-idle",
      cwd: "/workspace",
      title: "Child"
    },
    sdk
  );

  assert.equal(result.providerSessionId, childSessionId);
  assert.deepEqual(calls, [
    {
      sessionId: "source",
      options: {
        dir: "/workspace",
        upToMessageId: "ephemeral-idle",
        title: "Child"
      }
    },
    {
      sessionId: "source",
      options: {
        dir: "/workspace",
        upToMessageId: "answer-1",
        title: "Child"
      }
    }
  ]);
});

test("legacy checkpoint lookup keeps task notifications inside the selected turn", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const sdk = fakeSDK(calls);
  const getSessionMessages = sdk.getSessionMessages;
  sdk.getSessionMessages = async (sessionId: string) => {
    if (sessionId !== "source") {
      return getSessionMessages(sessionId);
    }
    return [
      source[0]!,
      source[1]!,
      message("user", "task-notification-1", {
        role: "user",
        content:
          "<task-notification><tool-use-id>tool-1</tool-use-id><status>completed</status></task-notification>"
      }),
      source[2]!,
      source[3]!
    ];
  };

  await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-1",
      providerCheckpointMessageId: "",
      cwd: "/workspace",
      title: "Child"
    },
    sdk
  );

  assert.deepEqual(calls, [
    {
      sessionId: "source",
      options: {
        dir: "/workspace",
        upToMessageId: "task-notification-1",
        title: "Child"
      }
    }
  ]);
});

test("official Claude fork preserves a trailing system checkpoint", async () => {
  const store = new InMemorySessionStore();
  const cwd = "/workspace";
  const sourceSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const sourcePrompt1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const sourceAnswer1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const sourceSystem = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const sourcePrompt2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const sourceAnswer2 = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  let projectKey = "";
  const load = store.load.bind(store);
  store.load = async (key) => {
    projectKey = key.projectKey;
    return load(key);
  };
  await sdkGetSessionMessages(sourceSessionId, {
    dir: cwd,
    sessionStore: store
  });
  assert.notEqual(projectKey, "");
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
      providerCheckpointMessageId: "",
      cwd,
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
  assert.ok(Array.isArray(result.targetProviderTurnBindings));
  assert.equal(result.targetProviderTurnBindings.length, 1);
  const targetBinding = result.targetProviderTurnBindings[0] as {
    providerTurnId: string;
  };
  assert.match(
    String(targetBinding.providerTurnId),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
  );
  assert.notEqual(targetBinding.providerTurnId, sourcePrompt1);
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
      providerCheckpointMessageId: "",
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
        providerCheckpointMessageId: "",
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

test("Claude legacy fork requires an exact checkpoint at the selected turn boundary", async () => {
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
        providerCheckpointMessageId: "",
        cwd: "/workspace",
        title: ""
      },
      sdk
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("source_lookup") &&
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
      providerCheckpointMessageId: "",
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

test("Claude fork accepts provider-owned child content without prefix comparison", async () => {
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

  const result = await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-1",
      providerCheckpointMessageId: "",
      cwd: "/workspace",
      title: "Child"
    },
    sdk
  );
  assert.equal(result.providerSessionId, childSessionId);
  assert.deepEqual(result.targetProviderTurnBindings, [
    {
      providerTurnId: "child-prompt-1",
      checkpointMessageId: "child-answer-1"
    }
  ]);
});

test("Claude fork ignores malformed history before the selected child turn", async () => {
  const sdk = fakeSDK(
    [],
    [
      message(
        "user",
        "",
        { role: "user", content: "unbound legacy prompt" },
        childSessionId
      ),
      message(
        "assistant",
        "duplicate-history-id",
        { role: "assistant", content: "legacy answer" },
        childSessionId
      ),
      message(
        "system",
        "duplicate-history-id",
        { subtype: "legacy" },
        childSessionId
      ),
      ...child
    ]
  );

  const result = await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-1",
      providerCheckpointMessageId: "answer-1",
      cwd: "/workspace",
      title: "Child"
    },
    sdk
  );

  assert.deepEqual(result.targetProviderTurnBindings, [
    {
      providerTurnId: "child-prompt-1",
      checkpointMessageId: "child-answer-1"
    }
  ]);
});

test("Claude fork does not bind a task notification as the child provider turn", async () => {
  const taskNotification = message(
    "user",
    "child-task-notification",
    {
      role: "user",
      content:
        "<task-notification><tool-use-id>tool-1</tool-use-id><status>completed</status></task-notification>"
    },
    childSessionId
  );
  const sdk = fakeSDK([], [...child, taskNotification]);

  const result = await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-1",
      providerCheckpointMessageId: "answer-1",
      cwd: "/workspace",
      title: "Child"
    },
    sdk
  );

  assert.deepEqual(result.targetProviderTurnBindings, [
    {
      providerTurnId: "child-prompt-1",
      checkpointMessageId: "child-task-notification"
    }
  ]);
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
      providerCheckpointMessageId: "",
      cwd: "/workspace",
      title: "Grandchild"
    },
    sdk
  );

  assert.equal(result.providerSessionId, grandchildSessionId);
  assert.deepEqual(result.targetProviderTurnBindings, [
    {
      providerTurnId: "grandchild-prompt-1",
      checkpointMessageId: "grandchild-answer-1"
    }
  ]);
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
    parent_tool_use_id: null,
    parent_agent_id: null
  };
}
