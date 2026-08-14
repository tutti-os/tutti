import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentStatusFrame,
  AgentStatusSourceError,
  AgentStatusStreamObserver
} from "@tutti-os/agent-gui";
import {
  createDesktopAgentStatusSource,
  createDesktopWorkspaceAgentStatusSource
} from "./createDesktopAgentStatusSource.ts";

const agent = {
  agentTargetId: "local:codex",
  name: "Codex",
  iconUrl: "codex.svg",
  availability: { status: "ready" },
  provider: "codex"
} as const;

test("desktop status combines an exact canonical session with one host probe read", async () => {
  const listCalls: unknown[] = [];
  const list = async (input: unknown) => {
    listCalls.push(input);
    return {
      workspaceId: "workspace-1",
      capturedAtUnixMs: 500,
      providers: [
        {
          agentTargetId: "local:codex",
          provider: "codex",
          availability: { status: "available", detailsVisible: false },
          usage: {
            accountTier: "API Usage Billing",
            capturedAtUnixMs: 450,
            quotas: [{ quotaType: "weekly", percentRemaining: 72 }]
          }
        }
      ]
    };
  };
  const observed = createObserver();
  const source = createDesktopAgentStatusSource({
    agentActivityRuntime: runtimeWithSessions([
      {
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        agentTargetId: "local:codex",
        provider: "codex",
        usage: {
          contextWindow: { usedTokens: 120, totalTokens: 1_000 },
          quotas: []
        }
      }
    ]),
    agents: [agent] as never,
    workspaceAgentProbes: { list } as never,
    workspaceId: "workspace-1"
  });

  source.open(
    {
      scopeKey: "local:codex",
      agentSessionId: "session-1",
      reason: "slash-status"
    },
    observed.observer
  );
  await observed.completed;

  assert.deepEqual(listCalls, [
    {
      agentTargetIds: ["local:codex"],
      includeUsage: true,
      providers: ["codex"],
      refresh: true,
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(observed.frames, [
    {
      kind: "refreshed",
      value: {
        accountLabel: "API Usage Billing",
        agentSessionId: "session-1",
        contextState: "available",
        contextWindow: { usedTokens: 120, totalTokens: 1_000 },
        quotas: [{ quotaType: "weekly", percentRemaining: 72 }],
        limitsState: "available",
        limitsCapturedAtUnixMs: 450,
        limitsStale: false
      }
    }
  ]);
  assert.deepEqual(observed.errors, []);
});

test("desktop status treats an unsupported extension usage probe as unavailable", async () => {
  const extensionAgent = {
    agentTargetId: "extension:example",
    name: "Example",
    iconUrl: "example.svg",
    availability: { status: "ready" },
    provider: "acp:example"
  } as const;
  const observed = createObserver();
  const source = createDesktopAgentStatusSource({
    agentActivityRuntime: runtimeWithSessions([]),
    agents: [extensionAgent] as never,
    workspaceAgentProbes: {
      list: async () => ({
        workspaceId: "workspace-1",
        capturedAtUnixMs: 500,
        providers: [
          {
            agentTargetId: "extension:example",
            provider: "acp:example",
            availability: { status: "unknown", detailsVisible: false },
            lastError: { code: "unsupported" }
          }
        ]
      })
    } as never,
    workspaceId: "workspace-1"
  });

  source.open(
    {
      scopeKey: "extension:example",
      reason: "agent-info"
    },
    observed.observer
  );
  await observed.completed;

  assert.deepEqual(observed.frames, [
    {
      kind: "refreshed",
      value: {
        agentSessionId: null,
        contextState: "unavailable",
        contextWindow: null,
        quotas: [],
        limitsState: "unavailable",
        limitsCapturedAtUnixMs: null,
        limitsStale: false
      }
    }
  ]);
  assert.deepEqual(observed.errors, []);
});

test("desktop status labels extension API billing without quota rows", async () => {
  const extensionAgent = {
    agentTargetId: "extension:usage-fixture",
    name: "Usage Fixture",
    iconUrl: "usage-fixture.svg",
    availability: { status: "ready" },
    provider: "acp:usage-fixture"
  } as const;
  const observed = createObserver();
  const source = createDesktopAgentStatusSource({
    agentActivityRuntime: runtimeWithSessions([]),
    agents: [extensionAgent] as never,
    workspaceAgentProbes: {
      list: async () => ({
        workspaceId: "workspace-1",
        capturedAtUnixMs: 500,
        providers: [
          {
            agentTargetId: "extension:usage-fixture",
            provider: "acp:usage-fixture",
            availability: { status: "unknown", detailsVisible: false },
            usage: {
              billingMode: "api",
              capturedAtUnixMs: 450,
              quotas: []
            }
          }
        ]
      })
    } as never,
    workspaceId: "workspace-1"
  });

  source.open(
    { scopeKey: "extension:usage-fixture", reason: "agent-info" },
    observed.observer
  );
  await observed.completed;

  assert.equal(observed.frames[0]?.value.accountLabel, "API Usage Billing");
  assert.equal(observed.frames[0]?.value.limitsState, "available");
  assert.deepEqual(observed.frames[0]?.value.quotas, []);
  assert.deepEqual(observed.errors, []);
});

test("desktop status preserves structured usage probe failures", async () => {
  const observed = createObserver();
  const source = createDesktopAgentStatusSource({
    agentActivityRuntime: runtimeWithSessions([]),
    agents: [agent] as never,
    workspaceAgentProbes: {
      list: async () => ({
        workspaceId: "workspace-1",
        capturedAtUnixMs: 500,
        providers: [
          {
            agentTargetId: "local:codex",
            provider: "codex",
            availability: { status: "unavailable", detailsVisible: false },
            lastError: { code: "auth_required" }
          }
        ]
      })
    } as never,
    workspaceId: "workspace-1"
  });

  source.open(
    {
      scopeKey: "local:codex",
      reason: "agent-info"
    },
    observed.observer
  );
  await observed.completed;

  assert.equal(observed.frames[0]?.value.limitsState, "error");
  assert.equal(observed.frames[0]?.value.limitsErrorCode, "auth_required");
  assert.deepEqual(observed.errors, []);
});

test("desktop status preserves exhausted usage together with its error code", async () => {
  const observed = createObserver();
  const source = createDesktopAgentStatusSource({
    agentActivityRuntime: runtimeWithSessions([]),
    agents: [agent] as never,
    workspaceAgentProbes: {
      list: async () => ({
        workspaceId: "workspace-1",
        capturedAtUnixMs: 500,
        providers: [
          {
            agentTargetId: "local:codex",
            provider: "codex",
            availability: { status: "available", detailsVisible: false },
            lastError: { code: "quota_exhausted" },
            usage: {
              capturedAtUnixMs: 450,
              quotas: [{ quotaType: "weekly", percentRemaining: 0 }]
            }
          }
        ]
      })
    } as never,
    workspaceId: "workspace-1"
  });

  source.open(
    {
      scopeKey: "local:codex",
      reason: "agent-info"
    },
    observed.observer
  );
  await observed.completed;

  assert.equal(observed.frames[0]?.value.limitsState, "error");
  assert.equal(observed.frames[0]?.value.limitsErrorCode, "quota_exhausted");
  assert.equal(observed.frames[0]?.value.quotas[0]?.percentRemaining, 0);
  assert.deepEqual(observed.errors, []);
});

test("desktop status fails closed before probing a cross-target session", () => {
  let listCalled = false;
  const observed = createObserver();
  const source = createDesktopAgentStatusSource({
    agentActivityRuntime: runtimeWithSessions([
      {
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        agentTargetId: "local:claude-code",
        provider: "claude-code",
        usage: null
      }
    ]),
    agents: [agent] as never,
    workspaceAgentProbes: {
      list: async () => {
        listCalled = true;
        throw new Error("unexpected probe");
      }
    } as never,
    workspaceId: "workspace-1"
  });

  source.open(
    {
      scopeKey: "local:codex",
      agentSessionId: "session-1",
      reason: "agent-info"
    },
    observed.observer
  );

  assert.deepEqual(observed.errors, [{ code: "invalid_target" }]);
  assert.equal(listCalled, false);
});

test("workspace status shares exact-target refreshes while keeping per-session controller state", async () => {
  let currentTime = 1_000;
  const firstProbe = deferred<ReturnType<typeof probeSnapshot>>();
  const secondProbe = deferred<ReturnType<typeof probeSnapshot>>();
  const thirdProbe = deferred<ReturnType<typeof probeSnapshot>>();
  const listCalls: unknown[] = [];
  const responses = [
    firstProbe.promise,
    secondProbe.promise,
    thirdProbe.promise
  ];
  const source = createDesktopWorkspaceAgentStatusSource(
    {
      agentActivityRuntime: runtimeWithSessions([
        {
          workspaceId: "workspace-1",
          agentSessionId: "session-1",
          agentTargetId: "local:codex",
          provider: "codex",
          usage: {
            contextWindow: { usedTokens: 100, totalTokens: 1_000 },
            quotas: []
          }
        },
        {
          workspaceId: "workspace-1",
          agentSessionId: "session-2",
          agentTargetId: "local:codex",
          provider: "codex",
          usage: {
            contextWindow: { usedTokens: 200, totalTokens: 2_000 },
            quotas: []
          }
        }
      ]),
      agents: () => [agent] as never,
      workspaceAgentProbes: {
        list: (input: unknown) => {
          listCalls.push(input);
          const response = responses.shift();
          if (!response) throw new Error("unexpected probe");
          return response;
        }
      } as never,
      workspaceId: "workspace-1"
    },
    { now: () => currentTime }
  );
  const firstObserved = createObserver();
  const secondObserved = createObserver();
  const closeFirst = source.open(
    statusQuery("session-1"),
    firstObserved.observer
  );
  source.open(statusQuery("session-2"), secondObserved.observer);
  await Promise.resolve();
  assert.equal(listCalls.length, 1);

  closeFirst();
  firstProbe.resolve(probeSnapshot(500));
  await secondObserved.completed;
  assert.deepEqual(firstObserved.frames, []);
  assert.deepEqual(secondObserved.frames[0]?.value.contextWindow, {
    usedTokens: 200,
    totalTokens: 2_000
  });

  const debouncedObserved = createObserver();
  source.open(statusQuery("session-1"), debouncedObserved.observer);
  await debouncedObserved.completed;
  assert.deepEqual(
    debouncedObserved.frames.map((frame) => frame.kind),
    ["snapshot"]
  );
  assert.deepEqual(debouncedObserved.frames[0]?.value.contextWindow, {
    usedTokens: 100,
    totalTokens: 1_000
  });
  assert.equal(listCalls.length, 1);

  currentTime += 5_000;
  const revalidatingObserved = createObserver();
  source.open(statusQuery("session-1"), revalidatingObserved.observer);
  assert.deepEqual(
    revalidatingObserved.frames.map((frame) => frame.kind),
    ["snapshot"]
  );
  await Promise.resolve();
  assert.equal(listCalls.length, 2);

  secondProbe.resolve(probeSnapshot(600));
  await revalidatingObserved.completed;
  assert.deepEqual(
    revalidatingObserved.frames.map((frame) => frame.kind),
    ["snapshot", "refreshed"]
  );
  assert.equal(
    revalidatingObserved.frames[1]?.value.limitsCapturedAtUnixMs,
    600
  );

  currentTime += 60 * 60_000 + 1;
  const expiredObserved = createObserver();
  source.open(statusQuery("session-1"), expiredObserved.observer);
  assert.equal(expiredObserved.frames.length, 0);
  await Promise.resolve();
  assert.equal(listCalls.length, 3);

  thirdProbe.resolve(probeSnapshot(700));
  await expiredObserved.completed;
  assert.deepEqual(
    expiredObserved.frames.map((frame) => frame.kind),
    ["refreshed"]
  );
});

function createObserver(): {
  completed: Promise<void>;
  errors: AgentStatusSourceError[];
  frames: AgentStatusFrame[];
  observer: AgentStatusStreamObserver;
} {
  const errors: AgentStatusSourceError[] = [];
  const frames: AgentStatusFrame[] = [];
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    completed,
    errors,
    frames,
    observer: {
      onFrame: (frame) => frames.push(frame),
      onError: (error) => errors.push(error),
      onComplete: complete
    }
  };
}

function runtimeWithSessions(sessions: readonly unknown[]) {
  return {
    getSnapshot: () => ({ sessions })
  } as never;
}

function statusQuery(agentSessionId: string) {
  return {
    agentSessionId,
    forceRefresh: true,
    reason: "agent-info" as const,
    scopeKey: "local:codex"
  };
}

function probeSnapshot(capturedAtUnixMs: number) {
  return {
    capturedAtUnixMs,
    providers: [
      {
        agentTargetId: "local:codex",
        availability: { detailsVisible: false, status: "available" as const },
        provider: "codex",
        usage: {
          capturedAtUnixMs,
          quotas: [{ percentRemaining: 70, quotaType: "weekly" }]
        }
      }
    ],
    workspaceId: "workspace-1"
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise = (_value: T): void => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
