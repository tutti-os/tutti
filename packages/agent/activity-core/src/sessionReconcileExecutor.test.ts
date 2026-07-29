import assert from "node:assert/strict";
import test from "node:test";
import { createAgentActivitySnapshotProjector } from "./engine/agentActivitySnapshot.projector.ts";
import { createAgentSessionEngine } from "./engine/createAgentSessionEngine.ts";
import type {
  AgentActivitySessionDetailSnapshot,
  SessionReconcileCommand
} from "./engine/sessionReconcile.types.ts";
import { normalizeAgentActivitySession } from "./sessionNormalization.ts";
import {
  createAgentActivitySessionReconcileExecutor,
  type AgentActivityChildMessageHydration,
  type AgentActivitySessionReconcilePort
} from "./sessionReconcileExecutor.ts";
import type {
  AgentActivityDurableMessage,
  AgentActivityMessage,
  AgentActivityMessagePage,
  AgentActivitySession
} from "./types.ts";

const WORKSPACE_ID = "workspace-1";

test("state reconcile applies one mapped aggregate without reading messages", async () => {
  const detail = sessionDetail(session("root-1"));
  const harness = createHarness({
    getSessionDetail: async () => detail,
    listSessionMessages: rejectUnexpectedMessageRead
  });

  const result = await harness.execute("state", true);

  assert.equal(result.status, "applied");
  assert.equal(
    harness.engine.getSnapshot().sessionLifecycle.sessionsById["root-1"]
      ?.agentSessionId,
    "root-1"
  );
});

test("state reconcile retries one transient detail-read failure", async () => {
  const detail = sessionDetail(session("root-1"));
  let detailReads = 0;
  const harness = createHarness({
    getSessionDetail: async () => {
      detailReads += 1;
      if (detailReads === 1) {
        throw new Error("temporary detail read failure");
      }
      return detail;
    },
    listSessionMessages: rejectUnexpectedMessageRead
  });

  const result = await harness.execute("state", true);

  assert.equal(result.status, "applied");
  assert.equal(detailReads, 2);
});

test("authoritative history reconcile replaces effective messages and cleans the optimistic overlay", async () => {
  const effectiveMessage = message({
    messageId: "replacement-message",
    turnId: "replacement-turn",
    version: 2
  });
  const root = session("root-1", { messageVersion: 2 });
  const harness = createHarness({
    getSessionDetail: async () => sessionDetail(root),
    listSessionMessages: async (input) =>
      input.order === "desc"
        ? page([effectiveMessage], false, 2)
        : page([], false, 2)
  });

  const result = await harness.executor.execute({
    ...command("state_and_messages"),
    authoritativeMessages: true
  });

  assert.equal(result.status, "applied");
  assert.deepEqual(
    harness
      .project()
      .sessionMessagesById["root-1"]?.map((candidate) => candidate.messageId),
    ["replacement-message"]
  );
  assert.deepEqual(harness.reconciledAuthoritativeHistories, [
    {
      agentSessionId: "root-1",
      messageIds: ["replacement-message"],
      turnIds: []
    }
  ]);
  assert.deepEqual(harness.reconciledOverlays, []);
});

test("authoritative history reconciliation rejects a partial scope before reading", async () => {
  const harness = createHarness({
    getSessionDetail: rejectUnexpectedDetailRead,
    listSessionMessages: rejectUnexpectedMessageRead
  });

  await assert.rejects(
    harness.executor.execute({
      ...command("messages"),
      authoritativeMessages: true
    }),
    /authoritative messages require state_and_messages scope/
  );
});

test("messages reconcile uses newest-page and records its server boundary", async () => {
  const requests: MessageRequest[] = [];
  const harness = createHarness({
    getSessionDetail: rejectUnexpectedDetailRead,
    listSessionMessages: async (input) => {
      requests.push({ ...input });
      return page([message({ version: 7 })], false, 7);
    }
  });
  harness.engine.dispatch({
    session: session("root-1", { messageVersion: 7 }),
    type: "session/upserted"
  });

  const result = await harness.execute("messages");

  assert.deepEqual(requests, [
    {
      agentSessionId: "root-1",
      limit: 100,
      order: "desc",
      signal: undefined,
      workspaceId: WORKSPACE_ID
    }
  ]);
  assert.equal(result.status, "applied");
  assert.deepEqual(harness.project().sessionMessageWindowsById?.["root-1"], {
    hasOlderMessages: false,
    oldestLoadedVersion: 7
  });
  assert.deepEqual(harness.reconciledOverlays, ["root-1"]);
});

test("known root repairs assistant-only history while child uses durable cursor", async () => {
  const rootRequests: MessageRequest[] = [];
  const rootHarness = createHarness({
    getSessionDetail: rejectUnexpectedDetailRead,
    listSessionMessages: async (input) => {
      rootRequests.push({ ...input });
      return page([], false, input.afterVersion ?? 0);
    }
  });
  seedKnownMessages(rootHarness, session("root-1"), [
    message({ agentSessionId: "root-1", role: "assistant", version: 7 })
  ]);
  await rootHarness.execute("messages");
  assert.equal(rootRequests[0]?.afterVersion, 0);

  const childRequests: MessageRequest[] = [];
  const childHarness = createHarness({
    getSessionDetail: rejectUnexpectedDetailRead,
    listSessionMessages: async (input) => {
      childRequests.push({ ...input });
      return page([], false, input.afterVersion ?? 0);
    }
  });
  seedKnownMessages(
    childHarness,
    session("child-1", {
      kind: "child",
      messageVersion: 6,
      parentAgentSessionId: "root-1",
      rootAgentSessionId: "root-1"
    }),
    [
      message({ agentSessionId: "child-1", sequence: 1, version: 5 }),
      transientMessage({
        agentSessionId: "child-1",
        messageId: "optimistic",
        version: 99
      })
    ]
  );
  await childHarness.execute("messages", false, "child-1");
  assert.equal(childRequests[0]?.afterVersion, 5);
});

test("known-empty child drains all ascending pages from cursor zero", async () => {
  const requests: MessageRequest[] = [];
  const harness = createHarness({
    getSessionDetail: rejectUnexpectedDetailRead,
    listSessionMessages: async (input) => {
      requests.push({ ...input });
      return input.afterVersion === 0
        ? page([message({ agentSessionId: "child-1", version: 1 })], true, 1)
        : page(
            [
              message({
                agentSessionId: "child-1",
                messageId: "message-2",
                version: 2
              })
            ],
            false,
            2
          );
    }
  });
  seedKnownMessages(
    harness,
    session("child-1", {
      kind: "child",
      messageVersion: 2,
      parentAgentSessionId: "root-1",
      rootAgentSessionId: "root-1"
    }),
    []
  );

  await harness.execute("messages", false, "child-1");

  assert.deepEqual(
    requests.map(({ afterVersion, order }) => ({ afterVersion, order })),
    [
      { afterVersion: 0, order: "asc" },
      { afterVersion: 1, order: "asc" }
    ]
  );
});

test("combined reconcile closes root and child races before one apply", async () => {
  const rootV1 = session("root-1", { messageVersion: 1 });
  const childV1 = session("child-1", {
    kind: "child",
    messageVersion: 1,
    parentAgentSessionId: "root-1",
    rootAgentSessionId: "root-1"
  });
  const rootV2 = session("root-1", { messageVersion: 2 });
  const childV2 = session("child-2", {
    kind: "child",
    messageVersion: 1,
    parentAgentSessionId: "root-1",
    rootAgentSessionId: "root-1"
  });
  const details = [
    sessionDetail(rootV1, [childV1]),
    sessionDetail(rootV2, [childV1, childV2])
  ];
  const requests: MessageRequest[] = [];
  const detailProjections: string[] = [];
  const callsBySessionId = new Map<string, number>();
  const harness = createHarness(
    {
      getSessionDetail: async ({ projection }) => {
        detailProjections.push(projection);
        const detail = details.shift();
        assert.ok(detail);
        return sessionDetail(
          detail.session,
          [...detail.childSessions],
          projection
        );
      },
      listSessionMessages: async (input) => {
        requests.push({ ...input });
        const call = (callsBySessionId.get(input.agentSessionId) ?? 0) + 1;
        callsBySessionId.set(input.agentSessionId, call);
        const version = input.agentSessionId === "root-1" && call === 2 ? 2 : 1;
        return page(
          [
            message({
              agentSessionId: input.agentSessionId,
              messageId: `${input.agentSessionId}-${version}`,
              role: "user",
              version
            })
          ],
          false,
          version
        );
      }
    },
    "session_hierarchy"
  );

  const result = await harness.execute("state_and_messages");

  assert.equal(result.status, "applied");
  assert.deepEqual(detailProjections, ["message_hydration", "authoritative"]);
  assert.equal(callsBySessionId.get("root-1"), 2);
  assert.equal(callsBySessionId.get("child-1"), 1);
  assert.equal(callsBySessionId.get("child-2"), 1);
  assert.equal(requests.at(-1)?.agentSessionId, "child-2");
  assert.deepEqual(
    harness.project().sessions.map((candidate) => candidate.agentSessionId),
    ["root-1", "child-1", "child-2"]
  );
  assert.deepEqual(
    harness
      .project()
      .sessionMessagesById["root-1"]?.map((candidate) => candidate.version),
    [1, 2]
  );
});

test("requested-session policy keeps child entities without prefetching child messages", async () => {
  const child = session("child-1", {
    kind: "child",
    messageVersion: 1,
    parentAgentSessionId: "root-1",
    rootAgentSessionId: "root-1"
  });
  const requests: MessageRequest[] = [];
  const harness = createHarness(
    {
      getSessionDetail: async ({ projection }) =>
        sessionDetail(session("root-1"), [child], projection),
      listSessionMessages: async (input) => {
        requests.push({ ...input });
        return page([], false, 0);
      }
    },
    "requested_session"
  );

  await harness.execute("state_and_messages");

  assert.deepEqual(
    [...new Set(requests.map((request) => request.agentSessionId))],
    ["root-1"]
  );
  assert.ok(
    harness.engine.getSnapshot().sessionLifecycle.sessionsById["child-1"]
  );
});

test("combined reconcile removes the full descendant closure of a tombstoned child", async () => {
  const deletedIds = new Set(["child-1"]);
  const child = session("child-1", {
    kind: "child",
    parentAgentSessionId: "root-1",
    rootAgentSessionId: "root-1"
  });
  const grandchild = session("grandchild-1", {
    kind: "child",
    parentAgentSessionId: "child-1",
    rootAgentSessionId: "root-1"
  });
  const requestedSessionIds: string[] = [];
  const harness = createHarness(
    {
      getSessionDetail: async ({ projection }) =>
        sessionDetail(session("root-1"), [child, grandchild], projection),
      listSessionMessages: async (input) => {
        requestedSessionIds.push(input.agentSessionId);
        if (input.agentSessionId !== "root-1") {
          throw new Error("deleted descendants must not be read");
        }
        return page([], false, 0);
      }
    },
    "session_hierarchy",
    {
      isSessionDeleted: (agentSessionId) => deletedIds.has(agentSessionId)
    }
  );

  await harness.execute("state_and_messages");

  assert.deepEqual(requestedSessionIds, ["root-1"]);
  assert.equal(
    harness.engine.getSnapshot().sessionLifecycle.sessionsById["child-1"],
    undefined
  );
  assert.equal(
    harness.engine.getSnapshot().sessionLifecycle.sessionsById["grandchild-1"],
    undefined
  );
});

test("message pages fail closed on a cross-session identity mismatch", async () => {
  const harness = createHarness({
    getSessionDetail: rejectUnexpectedDetailRead,
    listSessionMessages: async () =>
      page([message({ agentSessionId: "other-session" })], false, 1)
  });
  harness.engine.dispatch({
    session: session("root-1"),
    type: "session/upserted"
  });

  await assert.rejects(
    harness.execute("messages"),
    /message identity mismatch/
  );
  assert.equal(
    harness.project().sessionMessagesById["other-session"],
    undefined
  );
});

test("host unavailability rejects instead of confirming false hydration", async () => {
  let available = true;
  let resolveDetail:
    | ((detail: AgentActivitySessionDetailSnapshot) => void)
    | undefined;
  const harness = createHarness(
    {
      getSessionDetail: () =>
        new Promise((resolve) => {
          resolveDetail = resolve;
        }),
      listSessionMessages: rejectUnexpectedMessageRead
    },
    "requested_session",
    { isAvailable: () => available }
  );
  const execution = harness.execute("state");

  available = false;
  resolveDetail?.(sessionDetail(session("root-1")));

  await assert.rejects(execution, /host is unavailable/);
  assert.equal(
    harness.engine.getSnapshot().sessionLifecycle.sessionsById["root-1"],
    undefined
  );
});

test("combined result deduplicates messages replayed by root repair", async () => {
  const details = [
    sessionDetail(session("root-1", { messageVersion: 1 })),
    sessionDetail(session("root-1", { messageVersion: 2 }))
  ];
  let messageReadCount = 0;
  const harness = createHarness({
    getSessionDetail: async ({ projection }) => {
      const detail = details.shift();
      assert.ok(detail);
      return sessionDetail(
        detail.session,
        [...detail.childSessions],
        projection
      );
    },
    listSessionMessages: async () => {
      messageReadCount += 1;
      return messageReadCount === 1
        ? page([message({ version: 1 })], false, 1)
        : page(
            [
              message({ version: 1 }),
              message({ messageId: "message-2", version: 2 })
            ],
            false,
            2
          );
    }
  });

  const result = await harness.execute("state_and_messages");

  assert.equal(result.status, "applied");
  assert.deepEqual(
    result.appliedMessages.map((candidate) => candidate.messageId),
    ["message-1", "message-2"]
  );
});

test("an aborted late detail response never reaches the engine", async () => {
  let resolveDetail:
    | ((detail: AgentActivitySessionDetailSnapshot) => void)
    | undefined;
  let observedSignal: AbortSignal | undefined;
  const harness = createHarness({
    getSessionDetail: ({ signal }) => {
      observedSignal = signal;
      return new Promise((resolve) => {
        resolveDetail = resolve;
      });
    },
    listSessionMessages: rejectUnexpectedMessageRead
  });
  const controller = new AbortController();
  const execution = harness.executor.execute(command("state"), {
    signal: controller.signal
  });

  controller.abort(new Error("superseded"));
  resolveDetail?.(sessionDetail(session("root-1")));

  await assert.rejects(execution, /superseded/);
  assert.equal(observedSignal, controller.signal);
  assert.equal(
    harness.engine.getSnapshot().sessionLifecycle.sessionsById["root-1"],
    undefined
  );
});

type MessageRequest = Parameters<
  AgentActivitySessionReconcilePort["listSessionMessages"]
>[0];

function createHarness(
  port: AgentActivitySessionReconcilePort,
  childMessageHydration: AgentActivityChildMessageHydration = "requested_session",
  options: {
    isAvailable?(): boolean;
    isSessionDeleted?(agentSessionId: string): boolean;
  } = {}
) {
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 1 },
    commandPort: {
      execute: () => Promise.reject(new Error("unexpected engine command"))
    },
    identity: { origin: "test", workspaceId: WORKSPACE_ID },
    scheduler: {
      schedule: () => ({ cancel() {} })
    }
  });
  const reconciledOverlays: string[] = [];
  const reconciledAuthoritativeHistories: Array<{
    agentSessionId: string;
    messageIds: string[];
    turnIds: string[];
  }> = [];
  const executor = createAgentActivitySessionReconcileExecutor({
    childMessageHydration,
    engine,
    ...(options.isAvailable ? { isAvailable: options.isAvailable } : {}),
    isSessionDeleted: options.isSessionDeleted ?? (() => false),
    port,
    reconcileAuthoritativeHistory: (agentSessionId, messages, turns) => {
      reconciledAuthoritativeHistories.push({
        agentSessionId,
        messageIds: messages.map((message) => message.messageId),
        turnIds: turns.map((turn) => turn.turnId)
      });
    },
    reconcileOptimisticMessages: (agentSessionId) => {
      reconciledOverlays.push(agentSessionId);
    },
    workspaceId: WORKSPACE_ID
  });
  const projector = createAgentActivitySnapshotProjector(WORKSPACE_ID);
  return {
    engine,
    execute(
      scope: SessionReconcileCommand["scope"],
      live = false,
      agentSessionId = "root-1"
    ) {
      return executor.execute(command(scope, live, agentSessionId));
    },
    executor,
    project: () => projector(engine.getSnapshot()),
    reconciledAuthoritativeHistories,
    reconciledOverlays
  };
}

function seedKnownMessages(
  harness: ReturnType<typeof createHarness>,
  seededSession: AgentActivitySession,
  messages: readonly AgentActivityMessage[]
): void {
  harness.engine.dispatch({ session: seededSession, type: "session/upserted" });
  harness.engine.dispatch({
    messages,
    sessionMessageWindows: [
      {
        agentSessionId: seededSession.agentSessionId,
        hasOlderMessages: false,
        oldestLoadedVersion: null
      }
    ],
    type: "message/snapshotReceived",
    workspaceId: WORKSPACE_ID
  });
}

function command(
  scope: SessionReconcileCommand["scope"],
  live = false,
  agentSessionId = "root-1"
): SessionReconcileCommand {
  return {
    agentSessionId,
    commandId: `command-${scope}`,
    live,
    scope,
    type: "session/reconcile",
    workspaceId: WORKSPACE_ID
  };
}

function session(
  agentSessionId: string,
  overrides: Partial<AgentActivitySession> = {}
): AgentActivitySession {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId,
    cwd: "/tmp",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    title: agentSessionId,
    workspaceId: WORKSPACE_ID,
    ...overrides
  });
}

function sessionDetail(
  root: AgentActivitySession,
  childSessions: AgentActivitySession[] = [],
  projection: AgentActivitySessionDetailSnapshot["projection"] = "authoritative"
): AgentActivitySessionDetailSnapshot {
  return {
    childSessions,
    lifecycleCapabilitiesProjected: projection === "authoritative",
    projection,
    session: root,
    turns: []
  };
}

function message(
  overrides: Partial<AgentActivityDurableMessage> = {}
): AgentActivityDurableMessage {
  return {
    agentSessionId: "root-1",
    kind: "text",
    messageId: "message-1",
    occurredAtUnixMs: 1,
    payload: {},
    role: "assistant",
    sequence: overrides.version ?? 1,
    turnId: "turn-1",
    version: 1,
    workspaceId: WORKSPACE_ID,
    ...overrides
  };
}

function transientMessage(
  overrides: Partial<AgentActivityMessage> = {}
): AgentActivityMessage {
  return {
    agentSessionId: "root-1",
    kind: "text",
    messageId: "transient",
    occurredAtUnixMs: 1,
    payload: {},
    role: "assistant",
    turnId: "turn-1",
    version: 0,
    workspaceId: WORKSPACE_ID,
    ...overrides
  } as AgentActivityMessage;
}

function page(
  messages: AgentActivityDurableMessage[],
  hasMore: boolean,
  latestVersion: number
): AgentActivityMessagePage {
  return { hasMore, latestVersion, messages };
}

async function rejectUnexpectedDetailRead(): Promise<never> {
  throw new Error("unexpected detail read");
}

async function rejectUnexpectedMessageRead(): Promise<never> {
  throw new Error("unexpected message read");
}
