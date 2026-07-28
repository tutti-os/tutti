import assert from "node:assert/strict";
import test from "node:test";
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

test("Claude fork verifies the inclusive prefix and maps remapped UUIDs", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-1",
      providerTurnIds: ["prompt-1"],
      targetSessionId: childSessionId,
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
      options: {
        cwd: "/workspace",
        resume: "source",
        forkSession: true,
        sessionId: childSessionId,
        resumeSessionAt: "answer-1",
        title: "Source (2)"
      }
    }
  ]);
});

test("Claude fork reconciles an existing deterministic child without another mutation", async () => {
  let queryCalls = 0;
  const result = await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-1",
      providerTurnIds: ["prompt-1"],
      targetSessionId: childSessionId,
      cwd: "/workspace",
      title: "Source (2)"
    },
    {
      getSessionMessages: async (sessionId: string) =>
        sessionId === childSessionId ? child : source,
      getSessionInfo: async (sessionId: string) => ({
        sessionId,
        summary: "child",
        lastModified: 1
      }),
      query: (() => {
        queryCalls++;
        return makeQuery(async () => {});
      }) as never
    }
  );

  assert.equal(result.providerSessionId, childSessionId);
  assert.deepEqual(result.targetProviderTurnIds, ["child-prompt-1"]);
  assert.equal(queryCalls, 0);
});

test("Claude fork initializes with an empty prompt stream", async () => {
  let created = false;
  let promptResult: Promise<IteratorResult<unknown>> | undefined;
  const sdk = {
    getSessionMessages: async (sessionId: string) => {
      if (sessionId === childSessionId) {
        return created ? child : [];
      }
      return source;
    },
    getSessionInfo: async () =>
      created
        ? { sessionId: childSessionId, summary: "child", lastModified: 1 }
        : undefined,
    query: ((params: { prompt: AsyncIterable<unknown> }) => {
      const iterator = params.prompt[Symbol.asyncIterator]();
      return makeQuery(
        async () => {
          created = true;
        },
        () => {
          promptResult = iterator.next();
        }
      );
    }) as never
  };

  await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-1",
      providerTurnIds: ["prompt-1"],
      targetSessionId: childSessionId,
      cwd: "/workspace",
      title: "Source (2)"
    },
    sdk
  );

  assert.deepEqual(await promptResult, { done: true, value: undefined });
});

test("Claude fork reports unknown once the SDK mutation was invoked", async () => {
  const sdk = fakeSDK();
  sdk.query = (() =>
    makeQuery(async () => {
      throw new Error("connection lost");
    })) as never;
  await assert.rejects(
    forkClaudeSession(
      {
        sessionId: "source",
        providerTurnId: "prompt-1",
        providerTurnIds: ["prompt-1"],
        targetSessionId: childSessionId,
        cwd: "/workspace",
        title: "Source (2)"
      },
      sdk
    ),
    (error: unknown) =>
      error instanceof Error &&
      "deliveryDisposition" in error &&
      error.deliveryDisposition === "unknown"
  );
});

test("Claude fork validates the checkpoint identity before SDK mutation", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const sdk = fakeSDK(calls);
  sdk.getSessionMessages = async () => [
    message("user", "prompt-1", { role: "user", content: "one" }),
    message("assistant", "", { role: "assistant", content: "first" })
  ];
  await assert.rejects(
    forkClaudeSession(
      {
        sessionId: "source",
        providerTurnId: "prompt-1",
        providerTurnIds: ["prompt-1"],
        targetSessionId: childSessionId,
        cwd: "/workspace",
        title: ""
      },
      sdk
    ),
    (error: unknown) =>
      error instanceof Error &&
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
      targetSessionId: childSessionId,
      cwd: "/workspace",
      title: " "
    },
    fakeSDK(calls)
  );
  assert.equal(result.providerSessionId, childSessionId);
  assert.deepEqual(calls, [
    {
      options: {
        cwd: "/workspace",
        resume: "source",
        forkSession: true,
        sessionId: childSessionId,
        resumeSessionAt: "answer-1"
      }
    }
  ]);
});

test("Claude fork includes trailing system messages in its exact checkpoint", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const sourceWithSystem = [
    message("user", "prompt-1", { role: "user", content: "one" }),
    message("assistant", "answer-1", {
      role: "assistant",
      content: "first"
    }),
    message("system", "compact-1", {
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto" }
    })
  ];
  const childWithSystem = [
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
    ),
    message(
      "system",
      "child-compact-1",
      {
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto" }
      },
      childSessionId
    )
  ];
  const transcriptReads: Array<Record<string, unknown>> = [];
  let created = false;
  const sdk = {
    getSessionMessages: async (
      sessionId: string,
      options?: Record<string, unknown>
    ) => {
      transcriptReads.push({ sessionId, options });
      if (sessionId === childSessionId) {
        return created ? childWithSystem : [];
      }
      return sourceWithSystem;
    },
    getSessionInfo: async () =>
      created
        ? {
            sessionId: childSessionId,
            summary: "child",
            lastModified: 1
          }
        : undefined,
    query: ((params: { options?: Record<string, unknown> }) => {
      calls.push({ options: selectedForkOptions(params.options) });
      return makeQuery(async () => {
        created = true;
      });
    }) as never
  };

  const result = await forkClaudeSession(
    {
      sessionId: "source",
      providerTurnId: "prompt-1",
      providerTurnIds: ["prompt-1"],
      targetSessionId: childSessionId,
      cwd: "/workspace",
      title: "Source (2)"
    },
    sdk
  );

  assert.deepEqual(result.targetProviderTurnIds, ["child-prompt-1"]);
  assert.deepEqual(calls, [
    {
      options: {
        cwd: "/workspace",
        resume: "source",
        forkSession: true,
        sessionId: childSessionId,
        resumeSessionAt: "compact-1",
        title: "Source (2)"
      }
    }
  ]);
  assert.equal(transcriptReads.length, 4);
  for (const read of transcriptReads) {
    assert.deepEqual(read.options, {
      dir: "/workspace",
      includeSystemMessages: true
    });
  }
});

test("Claude fork reports unknown when child omits a trailing system message", async () => {
  const sourceWithSystem = [
    message("user", "prompt-1", { role: "user", content: "one" }),
    message("assistant", "answer-1", {
      role: "assistant",
      content: "first"
    }),
    message("system", "compact-1", {
      subtype: "compact_boundary"
    })
  ];
  let created = false;
  const sdk = {
    getSessionMessages: async (sessionId: string) => {
      if (sessionId === childSessionId) {
        return created ? child : [];
      }
      return sourceWithSystem;
    },
    getSessionInfo: async () =>
      created
        ? {
            sessionId: childSessionId,
            summary: "child",
            lastModified: 1
          }
        : undefined,
    query: (() =>
      makeQuery(async () => {
        created = true;
      })) as never
  };

  await assert.rejects(
    forkClaudeSession(
      {
        sessionId: "source",
        providerTurnId: "prompt-1",
        providerTurnIds: ["prompt-1"],
        targetSessionId: childSessionId,
        cwd: "/workspace",
        title: "Source (2)"
      },
      sdk
    ),
    (error: unknown) =>
      error instanceof Error &&
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
      return source;
    },
    getSessionInfo: async (sessionId: string) =>
      sessionId === grandchildSessionId && created
        ? {
            sessionId,
            summary: "grandchild",
            lastModified: 1
          }
        : undefined,
    query: ((params: { options?: Record<string, unknown> }) => {
      calls.push({ options: selectedForkOptions(params.options) });
      return makeQuery(async () => {
        created = true;
      });
    }) as never
  };

  const result = await forkClaudeSession(
    {
      sessionId: childSessionId,
      providerTurnId: "child-prompt-1",
      providerTurnIds: ["child-prompt-1"],
      targetSessionId: grandchildSessionId,
      cwd: "/workspace",
      title: "Grandchild"
    },
    sdk
  );

  assert.equal(result.providerSessionId, grandchildSessionId);
  assert.deepEqual(result.targetProviderTurnIds, ["grandchild-prompt-1"]);
  assert.deepEqual(calls, [
    {
      options: {
        cwd: "/workspace",
        resume: childSessionId,
        forkSession: true,
        sessionId: grandchildSessionId,
        resumeSessionAt: "child-answer-1",
        title: "Grandchild"
      }
    }
  ]);
});

function fakeSDK(calls: Array<Record<string, unknown>> = []) {
  let created = false;
  return {
    getSessionMessages: async (sessionId: string) => {
      if (sessionId === childSessionId) {
        return created ? child : [];
      }
      return source;
    },
    getSessionInfo: async () =>
      created
        ? {
            sessionId: childSessionId,
            summary: "child",
            lastModified: 1
          }
        : undefined,
    query: ((params: { options?: Record<string, unknown> }) => {
      calls.push({ options: selectedForkOptions(params.options) });
      return makeQuery(async () => {
        created = true;
      });
    }) as never
  };
}

function makeQuery(
  onInitialize: () => Promise<void>,
  onClose: () => void = () => {}
) {
  const iterator = (async function* () {})();
  return Object.assign(iterator, {
    initializationResult: async () => {
      await onInitialize();
      return {};
    },
    close: onClose
  });
}

function selectedForkOptions(
  options: Record<string, unknown> | undefined
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    "cwd",
    "resume",
    "forkSession",
    "sessionId",
    "resumeSessionAt",
    "title"
  ]) {
    if (options && key in options) {
      result[key] = options[key];
    }
  }
  return result;
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
