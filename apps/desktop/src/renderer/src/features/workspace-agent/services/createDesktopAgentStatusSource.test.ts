import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentStatusFrame,
  AgentStatusSourceError,
  AgentStatusStreamObserver
} from "@tutti-os/agent-gui";
import { createDesktopAgentStatusSource } from "./createDesktopAgentStatusSource.ts";

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
          provider: "codex",
          availability: { status: "available", detailsVisible: false },
          usage: {
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
