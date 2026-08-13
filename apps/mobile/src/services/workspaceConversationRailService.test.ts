import {
  AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
  createAgentSessionEngine,
  selectEngineSession,
  type AgentSessionEffectPort,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import { agentActivitySessionFromTuttidSession } from "@tutti-os/agent-activity-tuttid-adapter";
import type {
  TuttidClient,
  WorkspaceAgentSession,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import type { ClockPort } from "./servicePorts";
import { WorkspaceConversationRailService } from "./workspaceConversationRailService";

const workspace: WorkspaceSummary = {
  id: "workspace-1",
  lastOpenedAt: null,
  name: "Workspace"
};

describe("WorkspaceConversationRailService", () => {
  test("coalesces an engine reconcile with the initial section read", async () => {
    let listCalls = 0;
    const client = {
      listWorkspaceAgentSessionSections: async () => {
        listCalls += 1;
        await Promise.resolve();
        return {
          pinned: { hasMore: false, sessions: [], totalCount: 0 },
          sections: [],
          workspaceId: workspace.id
        };
      }
    } as unknown as TuttidClient;
    const service = createRailService(client, new ManualClock());

    await Promise.all([service.start(), service.reconcile()]);

    expect(listCalls).toBe(1);
    service.dispose();
  });

  test("forwards Activity search to the flat session page endpoint", async () => {
    const searchQueries: Array<Record<string, unknown>> = [];
    const client = {
      listWorkspaceAgentSessions: async (
        _workspaceId: string,
        query: Record<string, unknown>
      ) => {
        searchQueries.push(query);
        return {
          hasMore: false,
          sessions: [createSession("search-result", 2)],
          workspaceId: workspace.id
        };
      },
      listWorkspaceAgentSessionSections: async () => ({
        pinned: { hasMore: false, sessions: [], totalCount: 0 },
        sections: [],
        workspaceId: workspace.id
      })
    } as unknown as TuttidClient;
    const clock = new ManualClock();
    const service = createRailService(client, clock);

    await service.start();
    service.setSearchQuery("needle");
    clock.run(300);
    await Promise.resolve();
    await Promise.resolve();

    expect(searchQueries).toEqual([{ limit: 100, searchQuery: "needle" }]);
    expect(service.getSnapshot().search).toMatchObject({
      pending: false,
      query: "needle",
      resolvedQuery: "needle",
      sessionIds: ["search-result"]
    });
    service.dispose();
  });

  test("keeps server section identity and loads the next exact page", async () => {
    const sectionQueries: Array<Record<string, unknown>> = [];
    const receivedSessionIds: string[] = [];
    const client = {
      listWorkspaceAgentPinnedSessionPage: async () => ({
        page: { hasMore: false, sessions: [], totalCount: 0 },
        workspaceId: workspace.id
      }),
      listWorkspaceAgentSessionSectionPage: async (
        _workspaceId: string,
        query: Record<string, unknown>
      ) => {
        sectionQueries.push(query);
        return {
          section: {
            hasMore: false,
            kind: "project" as const,
            sectionKey: "project:/repo",
            sessions: [createSession("session-2", 2)],
            totalCount: 2
          },
          workspaceId: workspace.id
        };
      },
      listWorkspaceAgentSessionSections: async () => ({
        pinned: { hasMore: false, sessions: [], totalCount: 0 },
        sections: [
          {
            hasMore: true,
            kind: "project" as const,
            nextCursor: "cursor-1",
            sectionKey: "project:/repo",
            sessions: [createSession("session-1", 1)],
            totalCount: 2,
            userProject: {
              createdAtUnixMs: 1,
              id: "project-1",
              label: "Repo",
              lastUsedAtUnixMs: 1,
              path: "/repo",
              pinnedAtUnixMs: 0,
              sectionKey: "project:/repo",
              updatedAtUnixMs: 1
            }
          }
        ],
        workspaceId: workspace.id
      })
    } as unknown as TuttidClient;
    const service = createRailService(client, new ManualClock(), (sessionId) =>
      receivedSessionIds.push(sessionId)
    );

    await service.start();
    await service.loadMore("section:project:/repo");

    expect(sectionQueries).toEqual([
      {
        cursor: "cursor-1",
        limit: 30,
        sectionKey: "project:/repo"
      }
    ]);
    expect(service.getSnapshot().sections[0]).toMatchObject({
      hasMore: false,
      id: "section:project:/repo",
      sessionIds: ["session-1", "session-2"],
      totalCount: 2
    });
    expect(receivedSessionIds).toEqual(["session-1", "session-2"]);
    expect(service.getSnapshot()).not.toHaveProperty("sessions");

    service.dispose();
  });

  test("caps refresh reads and preserves pages already loaded past the cap", async () => {
    const listQueries: Array<{ limitPerSection?: number }> = [];
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      createSession(`session-${index + 1}`, 200 - index)
    );
    const nextPage = Array.from({ length: 30 }, (_, index) =>
      createSession(`session-${index + 101}`, 100 - index)
    );
    const client = {
      listWorkspaceAgentSessionSectionPage: async () => ({
        section: {
          hasMore: true,
          kind: "conversations" as const,
          nextCursor: "cursor-2",
          sectionKey: "conversations",
          sessions: nextPage,
          totalCount: 140
        },
        workspaceId: workspace.id
      }),
      listWorkspaceAgentSessionSections: async (
        _workspaceId: string,
        query: { limitPerSection?: number }
      ) => {
        listQueries.push(query);
        return {
          pinned: { hasMore: false, sessions: [], totalCount: 0 },
          sections: [
            {
              hasMore: true,
              kind: "conversations" as const,
              nextCursor: "cursor-1",
              sectionKey: "conversations",
              sessions: firstPage,
              totalCount: 140
            }
          ],
          workspaceId: workspace.id
        };
      }
    } as unknown as TuttidClient;
    const service = createRailService(client, new ManualClock());

    await service.start();
    await service.loadMore("section:conversations");
    await service.refresh();

    expect(listQueries).toEqual([
      { limitPerSection: 30 },
      { limitPerSection: 100 }
    ]);
    expect(service.getSnapshot().sections[0]?.sessionIds).toHaveLength(130);
    expect(service.getSnapshot().sections[0]).toMatchObject({
      hasMore: true,
      nextCursor: "cursor-2",
      totalCount: 140
    });

    service.dispose();
  });

  test("does not drop an authoritative refresh while pagination is loading", async () => {
    let sectionReads = 0;
    let paginationAborted = false;
    const client = {
      listWorkspaceAgentSessionSectionPage: async (
        _workspaceId: string,
        _query: Record<string, unknown>,
        options?: { signal?: AbortSignal }
      ) =>
        new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              paginationAborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true }
          );
        }),
      listWorkspaceAgentSessionSections: async () => {
        sectionReads += 1;
        return {
          pinned: { hasMore: false, sessions: [], totalCount: 0 },
          sections: [
            {
              hasMore: true,
              kind: "conversations" as const,
              nextCursor: "cursor-1",
              sectionKey: "conversations",
              sessions: [createSession("session-1", sectionReads)],
              totalCount: 2
            }
          ],
          workspaceId: workspace.id
        };
      }
    } as unknown as TuttidClient;
    const service = createRailService(client, new ManualClock());

    await service.start();
    const loadMore = service.loadMore("section:conversations");
    await Promise.resolve();
    expect(service.getSnapshot().loadingMoreSectionId).toBe(
      "section:conversations"
    );

    await service.refresh();
    await loadMore;

    expect(paginationAborted).toBe(true);
    expect(sectionReads).toBe(2);
    expect(service.getSnapshot().loadingMoreSectionId).toBeNull();
    service.dispose();
  });

  test("does not ingest a first-page response after pause", async () => {
    let resolveSections!: () => void;
    let requestSignal: AbortSignal | undefined;
    let engine!: AgentSessionEngine;
    const client = {
      listWorkspaceAgentSessionSections: async (
        _workspaceId: string,
        _query: Record<string, unknown>,
        options?: { signal?: AbortSignal }
      ) => {
        requestSignal = options?.signal;
        await new Promise<void>((resolve) => {
          resolveSections = resolve;
        });
        return {
          pinned: { hasMore: false, sessions: [], totalCount: 0 },
          sections: [
            {
              hasMore: false,
              kind: "conversations" as const,
              sectionKey: "conversations",
              sessions: [createSession("session-after-pause", 1)],
              totalCount: 1
            }
          ],
          workspaceId: workspace.id
        };
      }
    } as unknown as TuttidClient;
    const service = createRailService(
      client,
      new ManualClock(),
      undefined,
      (createdEngine) => {
        engine = createdEngine;
      }
    );

    const start = service.start();
    service.pause();
    expect(requestSignal?.aborted).toBe(true);
    resolveSections();
    await start;

    expect(
      selectEngineSession(engine.getSnapshot(), "session-after-pause")
    ).toBeNull();
    service.dispose();
    engine.dispose();
  });

  test("uses polling only while the live event lane is disconnected", async () => {
    const clock = new RecordingClock();
    const client = {
      listWorkspaceAgentSessionSections: async () => ({
        pinned: { hasMore: false, sessions: [], totalCount: 0 },
        sections: [],
        workspaceId: workspace.id
      })
    } as unknown as TuttidClient;
    const service = createRailService(client, clock);

    await service.start();
    expect(clock.activeDelays()).toEqual([2_000]);

    service.setLiveConnected(true);
    expect(clock.activeDelays()).toEqual([]);

    service.setLiveConnected(false);
    expect(clock.activeDelays()).toEqual([2_000]);
    service.dispose();
  });

  test("keeps canonical session entities out of rail state", async () => {
    const session = createSession("session-1", 1);
    const receivedSessionIds: string[] = [];
    const client = {
      listWorkspaceAgentSessionSections: async () => ({
        pinned: { hasMore: false, sessions: [], totalCount: 0 },
        sections: [
          {
            hasMore: false,
            kind: "conversations" as const,
            sectionKey: "conversations",
            sessions: [session],
            totalCount: 1
          }
        ],
        workspaceId: workspace.id
      })
    } as unknown as TuttidClient;
    const service = createRailService(client, new ManualClock(), (sessionId) =>
      receivedSessionIds.push(sessionId)
    );

    await service.start();

    expect(receivedSessionIds).toEqual([session.id]);
    expect(service.getSnapshot()).toEqual({
      errorCode: null,
      loadingMoreSectionId: null,
      search: {
        failed: false,
        hasMore: false,
        loadingMore: false,
        pending: false,
        query: "",
        resolvedQuery: "",
        sessionIds: []
      },
      sections: [
        expect.objectContaining({
          sessionIds: ["session-1"],
          totalCount: 1
        })
      ],
      status: "ready"
    });
    service.dispose();
  });
});

function createRailService(
  client: TuttidClient,
  clock: ClockPort,
  onMappedSession?: (agentSessionId: string) => void,
  onEngine?: (engine: AgentSessionEngine) => void
): WorkspaceConversationRailService {
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => clock.now() },
    commandPort: {
      effects: unexpectedSessionEffects(),
      execute: () => Promise.reject(new Error("unexpected engine command")),
      kind: "typed"
    },
    identity: {
      origin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
      workspaceId: workspace.id
    },
    scheduler: {
      schedule: (delayMs, task) => clock.schedule(delayMs, task)
    }
  });
  onEngine?.(engine);
  return new WorkspaceConversationRailService(workspace, client, clock, {
    engine,
    getActiveConversationId: () => null,
    mapSession: (session) => {
      onMappedSession?.(session.id);
      return agentActivitySessionFromTuttidSession(workspace.id, session, {
        currentUserId: "account-user-1"
      });
    }
  });
}

function unexpectedSessionEffects(): AgentSessionEffectPort {
  const reject = () => Promise.reject(new Error("unexpected session effect"));
  return {
    activateSession: reject,
    cancelTurn: reject,
    controlGoal: reject,
    deleteSessions: reject,
    renameSession: reject,
    respondToInteraction: reject,
    sendInput: reject,
    setSessionPinned: reject,
    updateSessionSettings: reject
  };
}

function createSession(
  id: string,
  updatedAtUnixMs: number
): WorkspaceAgentSession {
  return {
    activeTurn: null,
    activeTurnId: null,
    agentTargetId: null,
    capabilities: null,
    createdAtUnixMs: 1,
    cwd: "/repo",
    endedAtUnixMs: null,
    forkedFrom: null,
    goal: null,
    goalSyncState: null,
    id,
    imported: false,
    kind: "root",
    latestTurn: null,
    latestTurnInteractions: [],
    lifecycleCapabilities: { fork: false, forkThroughTurn: false },
    messageVersion: 0,
    parentAgentSessionId: null,
    parentToolCallId: null,
    parentTurnId: null,
    pendingInteractions: [],
    permissionConfig: { configurable: false, modes: [] },
    pinnedAtUnixMs: null,
    provider: "codex",
    providerSessionId: null,
    railSectionKey: "project:/repo",
    resumable: true,
    rootAgentSessionId: null,
    rootTurnId: null,
    settings: {},
    title: id,
    tuttiModeActivation: null,
    updatedAtUnixMs,
    usage: null,
    visible: true
  };
}

class ManualClock implements ClockPort {
  private readonly tasks: Array<{
    canceled: boolean;
    delayMs: number;
    task: () => void;
  }> = [];

  now(): number {
    return 1_000;
  }

  schedule(delayMs: number, task: () => void): { cancel(): void } {
    const scheduled = { canceled: false, delayMs, task };
    this.tasks.push(scheduled);
    return {
      cancel: () => {
        scheduled.canceled = true;
      }
    };
  }

  run(delayMs: number): void {
    const scheduled = this.tasks.find(
      (candidate) => !candidate.canceled && candidate.delayMs === delayMs
    );
    if (!scheduled) throw new Error(`no task scheduled for ${delayMs}ms`);
    scheduled.canceled = true;
    scheduled.task();
  }
}

class RecordingClock implements ClockPort {
  private readonly tasks: Array<{ canceled: boolean; delayMs: number }> = [];

  now(): number {
    return 1_000;
  }

  schedule(delayMs: number): { cancel(): void } {
    const task = { canceled: false, delayMs };
    this.tasks.push(task);
    return {
      cancel: () => {
        task.canceled = true;
      }
    };
  }

  activeDelays(): number[] {
    return this.tasks
      .filter((task) => !task.canceled)
      .map((task) => task.delayMs);
  }
}
