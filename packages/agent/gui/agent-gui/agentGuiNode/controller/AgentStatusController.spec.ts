import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentStatusController,
  selectAgentStatusControllerSnapshot,
  type AgentStatusSource,
  type AgentStatusStreamObserver
} from "./AgentStatusController";

describe("createAgentStatusController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  it("publishes loading immediately and accepts the bounded snapshot/refresh sequence", () => {
    let observer: AgentStatusStreamObserver | null = null;
    const source: AgentStatusSource = {
      open: (_query, nextObserver) => {
        observer = nextObserver;
        return vi.fn();
      }
    };
    const controller = createAgentStatusController({ source });

    controller.open({
      scopeKey: "local:codex",
      agentSessionId: "session-1",
      reason: "slash-status"
    });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "loading",
      isRefreshing: true,
      value: null
    });

    observer!.onFrame({
      kind: "snapshot",
      value: {
        agentSessionId: "session-1",
        contextState: "available",
        contextWindow: { usedTokens: 120, totalTokens: 1_000 },
        limitsState: "available",
        limitsCapturedAtUnixMs: 999_000,
        limitsStale: true,
        quotas: []
      }
    });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      isRefreshing: true,
      value: { limitsStale: true }
    });

    observer!.onFrame({
      kind: "refreshed",
      value: {
        agentSessionId: "session-1",
        contextState: "available",
        contextWindow: { usedTokens: 130, totalTokens: 1_000 },
        limitsState: "available",
        limitsCapturedAtUnixMs: 1_000_000,
        limitsStale: false,
        quotas: [{ quotaType: "session", percentRemaining: 80 }]
      }
    });
    observer!.onComplete();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      isRefreshing: false,
      errorCode: null,
      value: {
        limitsStale: false,
        quotas: [{ quotaType: "session", percentRemaining: 80 }]
      }
    });
  });

  it("cancels the visible request at 30 seconds and fences late owner results", () => {
    let observer: AgentStatusStreamObserver | null = null;
    const unsubscribe = vi.fn();
    const controller = createAgentStatusController({
      source: {
        open: (_query, nextObserver) => {
          observer = nextObserver;
          return unsubscribe;
        }
      }
    });
    controller.open({ scopeKey: "shared:1", reason: "slash-status" });

    vi.advanceTimersByTime(30_000);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      isRefreshing: false,
      errorCode: "timeout"
    });
    expect(unsubscribe).toHaveBeenCalledOnce();

    observer!.onFrame({
      kind: "refreshed",
      value: {
        agentSessionId: null,
        contextState: "unavailable",
        contextWindow: null,
        limitsState: "available",
        limitsCapturedAtUnixMs: 1_030_000,
        quotas: []
      }
    });
    observer!.onComplete();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      isRefreshing: false,
      errorCode: "timeout",
      value: null
    });
  });

  it("fences closed and replaced requests from late writes", () => {
    const observers: AgentStatusStreamObserver[] = [];
    const unsubscribes: ReturnType<typeof vi.fn>[] = [];
    const controller = createAgentStatusController({
      source: {
        open: (_query, observer) => {
          observers.push(observer);
          const unsubscribe = vi.fn();
          unsubscribes.push(unsubscribe);
          return unsubscribe;
        }
      }
    });
    controller.open({ scopeKey: "local:a", reason: "slash-status" });
    controller.open({ scopeKey: "local:b", reason: "slash-status" });
    expect(unsubscribes[0]).toHaveBeenCalledOnce();

    observers[0]!.onFrame({
      kind: "snapshot",
      value: {
        contextState: "unavailable",
        limitsState: "available",
        quotas: [{ quotaType: "weekly", percentRemaining: 1 }]
      }
    });
    expect(controller.getSnapshot().query?.scopeKey).toBe("local:b");
    expect(controller.getSnapshot().value).toBeNull();

    controller.close();
    observers[1]!.onFrame({
      kind: "snapshot",
      value: {
        contextState: "unavailable",
        limitsState: "available",
        quotas: [{ quotaType: "weekly", percentRemaining: 2 }]
      }
    });
    expect(controller.getSnapshot().value).toBeNull();
  });

  it("fences terminal streams and cleans up synchronous completion", () => {
    let observer: AgentStatusStreamObserver | null = null;
    const unsubscribe = vi.fn();
    const controller = createAgentStatusController({
      source: {
        open: (_query, nextObserver) => {
          observer = nextObserver;
          nextObserver.onComplete();
          return unsubscribe;
        }
      }
    });

    controller.open({ scopeKey: "local:codex", reason: "slash-status" });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      isRefreshing: false,
      errorCode: "unavailable",
      value: null
    });

    observer!.onFrame({
      kind: "refreshed",
      value: {
        contextState: "unavailable",
        limitsState: "available",
        quotas: [{ quotaType: "weekly", percentRemaining: 99 }]
      }
    });
    expect(controller.getSnapshot().value).toBeNull();
  });

  it("selects status only for the exact target and caller-visible session", () => {
    const snapshot = {
      query: {
        scopeKey: "shared-agent:one",
        agentSessionId: "binding-1",
        reason: "slash-status" as const
      },
      value: {
        contextState: "available" as const,
        limitsState: "available" as const,
        quotas: []
      },
      phase: "ready" as const,
      isRefreshing: false,
      errorCode: null
    };

    expect(
      selectAgentStatusControllerSnapshot(snapshot, {
        scopeKey: "shared-agent:one",
        agentSessionId: "binding-1"
      })
    ).toBe(snapshot);
    expect(
      selectAgentStatusControllerSnapshot(snapshot, {
        scopeKey: "shared-agent:two",
        agentSessionId: "binding-1"
      }).phase
    ).toBe("idle");
    expect(
      selectAgentStatusControllerSnapshot(snapshot, {
        scopeKey: "shared-agent:one",
        agentSessionId: "binding-2"
      }).value
    ).toBeNull();
    expect(
      selectAgentStatusControllerSnapshot(snapshot, {
        scopeKey: "shared-agent:one",
        agentSessionId: "binding-1",
        reasons: ["agent-config"]
      }).phase
    ).toBe("idle");
  });

  it("retains snapshots for one hour and debounces forced refresh for five seconds", () => {
    let call = 0;
    const open = vi.fn<AgentStatusSource["open"]>((_query, observer) => {
      call++;
      if (call === 1) {
        observer.onFrame({
          kind: "snapshot",
          value: {
            contextState: "unavailable",
            limitsState: "available",
            limitsCapturedAtUnixMs: Date.now(),
            quotas: []
          }
        });
        observer.onComplete();
      }
      return vi.fn();
    });
    const controller = createAgentStatusController({ source: { open } });
    const query = {
      scopeKey: "local:codex",
      reason: "agent-config" as const,
      forceRefresh: true
    };

    controller.open(query);
    controller.open(query);
    expect(open).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(5_000);
    controller.open(query);
    expect(open).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().value).not.toBeNull();

    controller.close();
    vi.advanceTimersByTime(60 * 60_000 + 1);
    controller.open({ ...query, forceRefresh: false });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "loading",
      value: null
    });
  });

  it("retains the last value but reports a zero-frame refresh as unavailable", () => {
    const observers: AgentStatusStreamObserver[] = [];
    const controller = createAgentStatusController({
      source: {
        open: (_query, observer) => {
          observers.push(observer);
          return vi.fn();
        }
      }
    });
    const query = { scopeKey: "local:codex", reason: "agent-config" as const };

    controller.open(query);
    observers[0]!.onFrame({
      kind: "refreshed",
      value: {
        contextState: "unavailable",
        limitsState: "available",
        quotas: []
      }
    });
    observers[0]!.onComplete();
    controller.open(query);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      isRefreshing: true,
      errorCode: null,
      value: { limitsState: "available" }
    });

    observers[1]!.onComplete();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      isRefreshing: false,
      errorCode: "unavailable",
      value: { limitsState: "available" }
    });
  });

  it("rejects frames for another session and invalid frame sequences", () => {
    const observers: AgentStatusStreamObserver[] = [];
    const controller = createAgentStatusController({
      source: {
        open: (_query, observer) => {
          observers.push(observer);
          return vi.fn();
        }
      }
    });
    controller.open({
      scopeKey: "shared-agent:one",
      agentSessionId: "binding-1",
      reason: "slash-status"
    });
    observers[0]!.onFrame({
      kind: "refreshed",
      value: {
        agentSessionId: "binding-other",
        contextState: "available",
        limitsState: "available",
        quotas: []
      }
    });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      errorCode: "unavailable",
      value: null
    });

    controller.open({ scopeKey: "local:codex", reason: "agent-config" });
    observers[1]!.onFrame({
      kind: "refreshed",
      value: {
        contextState: "unavailable",
        limitsState: "available",
        quotas: []
      }
    });
    observers[1]!.onFrame({
      kind: "refreshed",
      value: {
        contextState: "unavailable",
        limitsState: "available",
        quotas: []
      }
    });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      errorCode: "unavailable",
      value: { limitsState: "available" }
    });
  });
});
