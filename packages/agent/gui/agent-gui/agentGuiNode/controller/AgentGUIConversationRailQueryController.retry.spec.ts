import {
  normalizeAgentActivitySession,
  type AgentActivitySession
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import type {
  AgentGuiScheduledTask,
  AgentGuiScheduler
} from "../agentGuiScheduler";
import { AgentGUIConversationRailQueryController } from "./AgentGUIConversationRailQueryController";
import { AgentGUIConversationRailTargetedPageRefresher } from "./AgentGUIConversationRailTargetedPageRefresher";
import {
  CONVERSATION_RAIL_BACKGROUND_RETRY_DELAY_MIN_MS,
  CONVERSATION_RAIL_BACKGROUND_RETRY_JITTER_MS,
  CONVERSATION_RAIL_FOREGROUND_RETRY_DELAY_MIN_MS,
  CONVERSATION_RAIL_FOREGROUND_RETRY_JITTER_MS
} from "./agentGuiConversationRailRequestRetry";

class ManualScheduler implements AgentGuiScheduler {
  private readonly tasks: Array<{
    canceled: boolean;
    delayMs: number;
    task(): void;
  }> = [];

  schedule(delayMs: number, task: () => void): AgentGuiScheduledTask {
    const scheduled = { canceled: false, delayMs, task };
    this.tasks.push(scheduled);
    return {
      cancel: () => {
        scheduled.canceled = true;
      }
    };
  }

  get pendingDelayMs(): number | null {
    return this.tasks.find((task) => !task.canceled)?.delayMs ?? null;
  }

  runNext(): void {
    const index = this.tasks.findIndex((task) => !task.canceled);
    if (index < 0) throw new Error("No scheduled retry");
    const [scheduled] = this.tasks.splice(index, 1);
    scheduled!.task();
  }
}

describe("AgentGUIConversationRailQueryController retries", () => {
  it("runs targeted refreshes when the runtime has no AbortSignal.any", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
    Object.defineProperty(AbortSignal, "any", {
      configurable: true,
      value: undefined
    });
    try {
      const onResolved = vi.fn();
      const refresher = new AgentGUIConversationRailTargetedPageRefresher({
        onResolved,
        pageSize: 5,
        runtime: {
          listSessionSectionPage: async (input) => ({
            hasMore: false,
            kind: "conversations",
            sectionKey: input.sectionKey,
            sessions: [],
            totalCount: 0
          })
        },
        scheduler: new ManualScheduler(),
        workspaceId: "test-workspace"
      });

      refresher.refresh({
        agentTargetId: "shared:one",
        pageIds: ["conversations"]
      });

      await vi.waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
      refresher.cancel();
    } finally {
      if (descriptor) Object.defineProperty(AbortSignal, "any", descriptor);
    }
  });

  it("retries a transient first-page failure before exposing an empty rail", async () => {
    const engine = createTestAgentSessionEngine();
    const scheduler = new ManualScheduler();
    const session = createSession();
    let attempts = 0;
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime: {
        listSessionSectionPage: async (input) => ({
          hasMore: false,
          kind: "conversations",
          sectionKey: input.sectionKey,
          sessions: [],
          totalCount: 0
        }),
        listSessionSections: async (input) => {
          attempts += 1;
          if (attempts === 1) throw new TypeError("fetch failed");
          return {
            sections: [conversationSection(session)],
            workspaceId: input.workspaceId
          };
        }
      },
      scheduler,
      workspaceId: "test-workspace"
    });
    controller.configure({
      conversationFilter: { kind: "all" },
      userProjects: []
    });
    const detach = controller.attach();

    await vi.waitFor(() => expect(scheduler.pendingDelayMs).not.toBeNull());
    expect(controller.getSnapshot().runtimeRailFailed).toBe(false);
    expect(controller.isInteractionLocked()).toBe(true);

    scheduler.runNext();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );
    expect(attempts).toBe(2);
    expect(controller.getSnapshot().runtimeRailFailed).toBe(false);
    expect(
      controller.getSnapshot().runtimeRailMemberships?.[0]?.sessionIds
    ).toEqual([session.agentSessionId]);
    expect(controller.isInteractionLocked()).toBe(false);

    detach();
    engine.dispose();
  });

  it("exposes a retryable empty rail while a timed-out first page retries in the background", async () => {
    const engine = createTestAgentSessionEngine();
    const scheduler = new ManualScheduler();
    const session = createSession();
    let attempts = 0;
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime: {
        listSessionSectionPage: async (input) => ({
          hasMore: false,
          kind: "conversations",
          sectionKey: input.sectionKey,
          sessions: [],
          totalCount: 0
        }),
        listSessionSections: async (input) => {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error("request timed out"), {
              name: "TimeoutError"
            });
          }
          return {
            sections: [conversationSection(session)],
            workspaceId: input.workspaceId
          };
        }
      },
      scheduler,
      workspaceId: "test-workspace"
    });
    controller.configure({
      conversationFilter: { kind: "all" },
      userProjects: []
    });
    const detach = controller.attach();

    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailFailed).toBe(true)
    );
    expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false);
    expect(controller.getSnapshot().runtimeRailMemberships).toEqual([]);
    expect(controller.isInteractionLocked()).toBe(false);

    scheduler.runNext();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailFailed).toBe(false)
    );
    expect(attempts).toBe(2);
    expect(
      controller.getSnapshot().runtimeRailMemberships?.[0]?.sessionIds
    ).toEqual([session.agentSessionId]);

    detach();
    engine.dispose();
  });

  it("retries a fast transient targeted refresh once before publishing failure", async () => {
    const engine = createTestAgentSessionEngine();
    const scheduler = new ManualScheduler();
    const session = createSession();
    let pinnedAttempts = 0;
    let sectionAttempts = 0;
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => session.agentSessionId,
      runtime: {
        listPinnedSessionsPage: vi.fn(async () => {
          pinnedAttempts += 1;
          if (pinnedAttempts === 1) {
            throw Object.assign(new Error("upstream unavailable"), {
              retryable: false,
              status: 520
            });
          }
          return {
            hasMore: false,
            sessions: [{ ...session, pinnedAtUnixMs: 10 }],
            totalCount: 1
          };
        }),
        listSessionSectionPage: vi.fn(async (input) => {
          sectionAttempts += 1;
          if (sectionAttempts === 1) {
            await new Promise<never>((_resolve, reject) => {
              input.signal?.addEventListener(
                "abort",
                () => reject(input.signal?.reason),
                { once: true }
              );
            });
          }
          return {
            hasMore: false,
            kind: "conversations" as const,
            sectionKey: input.sectionKey,
            sessions: [],
            totalCount: 0
          };
        }),
        listSessionSections: async (input) => ({
          sections: [conversationSection(session)],
          workspaceId: input.workspaceId
        })
      },
      scheduler,
      workspaceId: "test-workspace"
    });
    controller.configure({
      conversationFilter: { kind: "all" },
      userProjects: []
    });
    const detach = controller.attach();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );

    engine.dispatch({
      session: { ...session, pinnedAtUnixMs: 10, updatedAtUnixMs: 2 },
      type: "session/upserted"
    });

    await vi.waitFor(() => expect(scheduler.pendingDelayMs).not.toBeNull());
    expect(scheduler.pendingDelayMs).toBeGreaterThanOrEqual(
      CONVERSATION_RAIL_FOREGROUND_RETRY_DELAY_MIN_MS
    );
    expect(scheduler.pendingDelayMs).toBeLessThanOrEqual(
      CONVERSATION_RAIL_FOREGROUND_RETRY_DELAY_MIN_MS +
        CONVERSATION_RAIL_FOREGROUND_RETRY_JITTER_MS
    );
    expect(controller.isInteractionLocked()).toBe(true);
    expect(controller.getSnapshot().runtimeRailFailed).toBe(false);

    scheduler.runNext();
    await vi.waitFor(() => expect(pinnedAttempts).toBe(2));
    expect(sectionAttempts).toBe(2);
    expect(controller.getSnapshot().runtimeRailFailed).toBe(false);
    expect(controller.isInteractionLocked()).toBe(false);
    expect(
      controller
        .getSnapshot()
        .runtimeRailMemberships?.find((section) => section.id === "pinned")
        ?.sessionIds
    ).toEqual([session.agentSessionId]);

    detach();
    engine.dispose();
  });

  it("unlocks retained rows while retrying a timed-out targeted refresh in the background", async () => {
    const engine = createTestAgentSessionEngine();
    const scheduler = new ManualScheduler();
    const session = createSession();
    let pinnedAttempts = 0;
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => session.agentSessionId,
      runtime: {
        listPinnedSessionsPage: vi.fn(async () => {
          pinnedAttempts += 1;
          if (pinnedAttempts === 1) {
            throw Object.assign(new Error("request timed out"), {
              name: "TimeoutError"
            });
          }
          return {
            hasMore: false,
            sessions: [{ ...session, pinnedAtUnixMs: 10 }],
            totalCount: 1
          };
        }),
        listSessionSectionPage: vi.fn(async (input) => ({
          hasMore: false,
          kind: "conversations" as const,
          sectionKey: input.sectionKey,
          sessions: [],
          totalCount: 0
        })),
        listSessionSections: async (input) => ({
          sections: [conversationSection(session)],
          workspaceId: input.workspaceId
        })
      },
      scheduler,
      workspaceId: "test-workspace"
    });
    controller.configure({
      conversationFilter: { kind: "all" },
      userProjects: []
    });
    const detach = controller.attach();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );

    engine.dispatch({
      session: { ...session, pinnedAtUnixMs: 10, updatedAtUnixMs: 2 },
      type: "session/upserted"
    });

    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailFailed).toBe(true)
    );
    expect(controller.isInteractionLocked()).toBe(false);
    expect(scheduler.pendingDelayMs).toBeGreaterThanOrEqual(
      CONVERSATION_RAIL_BACKGROUND_RETRY_DELAY_MIN_MS
    );
    expect(scheduler.pendingDelayMs).toBeLessThanOrEqual(
      CONVERSATION_RAIL_BACKGROUND_RETRY_DELAY_MIN_MS +
        CONVERSATION_RAIL_BACKGROUND_RETRY_JITTER_MS
    );
    expect(
      controller.getSnapshot().runtimeRailMemberships?.[0]?.sessionIds
    ).toEqual([session.agentSessionId]);

    scheduler.runNext();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailFailed).toBe(false)
    );
    expect(pinnedAttempts).toBe(2);
    expect(controller.isInteractionLocked()).toBe(false);

    detach();
    engine.dispose();
  });

  it("cancels a scheduled retry when its surface detaches", async () => {
    const engine = createTestAgentSessionEngine();
    const scheduler = new ManualScheduler();
    let attempts = 0;
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime: {
        listSessionSectionPage: async (input) => ({
          hasMore: false,
          kind: "conversations",
          sectionKey: input.sectionKey,
          sessions: [],
          totalCount: 0
        }),
        listSessionSections: async () => {
          attempts += 1;
          throw new TypeError("fetch failed");
        }
      },
      scheduler,
      workspaceId: "test-workspace"
    });
    controller.configure({
      conversationFilter: { kind: "all" },
      userProjects: []
    });
    const detach = controller.attach();

    await vi.waitFor(() => expect(scheduler.pendingDelayMs).not.toBeNull());
    detach();

    expect(scheduler.pendingDelayMs).toBeNull();
    expect(attempts).toBe(1);
    engine.dispose();
  });
});

function createSession(): AgentActivitySession {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId: "session-1",
    agentTargetId: "shared:one",
    cwd: "/workspace",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "shared",
    railSectionKey: "conversations",
    title: "Session",
    updatedAtUnixMs: 1,
    workspaceId: "test-workspace"
  });
}

function conversationSection(session: AgentActivitySession) {
  return {
    hasMore: false,
    kind: "conversations" as const,
    sectionKey: "conversations",
    sessions: [session],
    totalCount: 1
  };
}
