import {
  AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
  normalizeAgentActivitySession,
  selectEngineSession,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import { createWorkspaceQueryCache } from "../../../shared/query/workspaceQueryCache";
import {
  AgentGUIConversationRailQueryController,
  CONVERSATION_SEARCH_DEBOUNCE_MS,
  type ConversationRailQueryScope,
  type ConversationRailQueryRuntime
} from "./AgentGUIConversationRailQueryController";
import { resolveConversationRailQueryScope } from "./agentGuiConversationRailQueryTypes";
import { createConversationRailConversationsSelector } from "./agentGuiConversationRailQuerySnapshot";
import type { CachedConversationRailQuery } from "./agentGuiConversationRailQueryCache";

describe("AgentGUIConversationRailQueryController", () => {
  it("does not ingest a first-page response after detach", async () => {
    const engine = createTestAgentSessionEngine();
    const session = createTestSession("detached-session", "conversations");
    let resolveSections!: () => void;
    let requestSignal: AbortSignal | undefined;
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
        listSessionSections: (input) => {
          requestSignal = input.signal;
          return new Promise<void>((resolve) => {
            resolveSections = resolve;
          }).then(() => ({
            sections: [
              {
                hasMore: false,
                kind: "conversations" as const,
                sectionKey: "conversations",
                sessions: [session],
                totalCount: 1
              }
            ],
            workspaceId: input.workspaceId
          }));
        }
      },
      workspaceId: "test-workspace"
    });
    controller.configure({
      conversationFilter: { kind: "all" },
      userProjects: []
    });

    const detach = controller.attach();
    detach();
    expect(requestSignal?.aborted).toBe(true);
    resolveSections();
    await Promise.resolve();
    await Promise.resolve();

    expect(
      selectEngineSession(engine.getSnapshot(), session.agentSessionId)
    ).toBeNull();
    engine.dispose();
  });

  it("does not write a stale scope response with another scope's query state", async () => {
    const engine = createTestAgentSessionEngine();
    const cache = createWorkspaceQueryCache<CachedConversationRailQuery>();
    const pending: Array<{
      agentTargetId: string;
      resolve(): void;
      signal?: AbortSignal;
    }> = [];
    const listSessionSections = vi.fn<
      NonNullable<ConversationRailQueryRuntime["listSessionSections"]>
    >((input) =>
      new Promise<void>((resolve) => {
        pending.push({
          agentTargetId: input.agentTargetId ?? "",
          resolve,
          signal: input.signal
        });
      }).then(() => ({
        sections: [
          {
            hasMore: false,
            kind: "conversations" as const,
            sectionKey: "conversations",
            sessions: [
              createTestSession(
                `session-${input.agentTargetId}`,
                "conversations"
              )
            ],
            totalCount: 1
          }
        ],
        workspaceId: input.workspaceId
      }))
    );
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      sessionSectionsQueryCache: cache,
      runtime: {
        listSessionSectionPage: async (input) => ({
          hasMore: false,
          kind: "conversations",
          sectionKey: input.sectionKey,
          sessions: [],
          totalCount: 0
        }),
        listSessionSections
      },
      workspaceId: "test-workspace"
    });
    const scopeA: ConversationRailQueryScope = {
      conversationFilter: { agentTargetId: "agent-a", kind: "agentTarget" },
      userProjects: []
    };
    const scopeB: ConversationRailQueryScope = {
      conversationFilter: { agentTargetId: "agent-b", kind: "agentTarget" },
      userProjects: []
    };
    const scopeAKey = resolveConversationRailQueryScope(
      "test-workspace",
      scopeA
    ).scopeKey;

    controller.configure(scopeA);
    const detach = controller.attach();
    controller.configure(scopeB);

    expect(pending).toHaveLength(2);
    expect(pending[0]?.signal?.aborted).toBe(true);
    pending[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.read(scopeAKey)).toBeNull();

    pending[1]?.resolve();
    await vi.waitFor(() =>
      expect(
        controller.getSnapshot().runtimeRailMemberships?.[0]?.sessionIds
      ).toEqual(["session-agent-b"])
    );

    controller.configure(scopeA);
    expect(listSessionSections).toHaveBeenCalledTimes(3);
    pending[2]?.resolve();
    await vi.waitFor(() =>
      expect(
        controller.getSnapshot().runtimeRailMemberships?.[0]?.sessionIds
      ).toEqual(["session-agent-a"])
    );

    detach();
    engine.dispose();
  });

  it("does not treat workspace hydration as a rail membership mutation", async () => {
    let resolveWorkspaceReconcile!: () => void;
    const engine = createTestAgentSessionEngine("test-workspace", {
      execute: async (command) => {
        if (command.type !== "engine/reconcileWorkspace") return { ok: true };
        await new Promise<void>((resolve) => {
          resolveWorkspaceReconcile = resolve;
        });
        return { ok: true };
      }
    });
    const session = normalizeAgentActivitySession({
      activeTurnId: null,
      agentSessionId: "historical-session",
      agentTargetId: "local:codex",
      cwd: "/workspace",
      latestTurnInteractions: [],
      pendingInteractions: [],
      provider: "codex",
      railSectionKey: "conversations",
      title: "Historical session",
      updatedAtUnixMs: 1,
      workspaceId: "test-workspace"
    });
    let resolveFirstPages!: () => void;
    const listSessionSections = vi.fn<
      NonNullable<ConversationRailQueryRuntime["listSessionSections"]>
    >((input) =>
      new Promise<void>((resolve) => {
        resolveFirstPages = resolve;
      }).then(() => ({
        sections: [
          {
            hasMore: false,
            kind: "conversations" as const,
            sectionKey: "conversations",
            sessions: [session],
            totalCount: 1
          }
        ],
        workspaceId: input.workspaceId
      }))
    );
    const listSessionSectionPage = vi.fn(async (input) => ({
      hasMore: false,
      kind: "conversations" as const,
      sectionKey: input.sectionKey,
      sessions: [session],
      totalCount: 1
    }));
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime: { listSessionSections, listSessionSectionPage },
      workspaceId: "test-workspace"
    });
    controller.configure({
      conversationFilter: { kind: "all" },
      userProjects: []
    });

    const detach = controller.attach();
    expect(engine.getSnapshot().engineRuntime.workspaceReconcile.status).toBe(
      "loading"
    );
    engine.dispatch({ sessions: [session], type: "session/snapshotReceived" });

    expect(listSessionSectionPage).not.toHaveBeenCalled();

    resolveWorkspaceReconcile();
    await vi.waitFor(() =>
      expect(engine.getSnapshot().engineRuntime.workspaceReconcile.status).toBe(
        "ready"
      )
    );
    resolveFirstPages();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );
    expect(controller.getSnapshot().runtimeRailMemberships).toEqual([
      expect.objectContaining({
        id: "conversations",
        sessionIds: ["historical-session"]
      })
    ]);
    expect(listSessionSectionPage).not.toHaveBeenCalled();

    detach();
    engine.dispose();
  });

  it("refreshes a selected fork creation into its authoritative rail page", async () => {
    const source = normalizeAgentActivitySession({
      ...createTestSession("source-session", "conversations"),
      lifecycleCapabilities: { fork: true, forkThroughTurn: true }
    });
    const child = normalizeAgentActivitySession({
      ...source,
      agentSessionId: "fork-child",
      forkedFrom: {
        forkedAtUnixMs: 2,
        operationId: "fork-operation",
        sourceAgentSessionId: source.agentSessionId,
        sourceTurnId: "source-turn",
        targetTurnId: "fork-target-turn"
      },
      title: "Fork child",
      updatedAtUnixMs: 2
    });
    let resolveForkCommand: (value: unknown) => void = () => {};
    const engine = createTestAgentSessionEngine("test-workspace", {
      execute: async (command) => {
        if (command.type === "session/forkThroughTurn") {
          return new Promise((resolve) => {
            resolveForkCommand = resolve;
          });
        }
        return { ok: true };
      }
    });
    let activeConversationId: string | null = null;
    const listSessionSectionPage = vi.fn(async (input) => ({
      hasMore: false,
      kind: "conversations" as const,
      sectionKey: input.sectionKey,
      sessions: [child, source],
      totalCount: 2
    }));
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => activeConversationId,
      runtime: {
        listSessionSectionPage,
        listSessionSections: async (input) => ({
          sections: [
            {
              hasMore: false,
              kind: "conversations",
              sectionKey: "conversations",
              sessions: [source],
              totalCount: 1
            }
          ],
          workspaceId: input.workspaceId
        })
      },
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
      live: true,
      turn: {
        agentSessionId: source.agentSessionId,
        completedCommand: null,
        error: null,
        fileChanges: null,
        origin: "user_prompt",
        outcome: "completed",
        phase: "settled",
        providerForkBindingAvailable: true,
        settledAtUnixMs: 2,
        startedAtUnixMs: 1,
        turnId: "source-turn",
        updatedAtUnixMs: 2
      },
      type: "turn/upserted"
    });
    engine.dispatch({
      requestId: "fork-request",
      sourceAgentSessionId: source.agentSessionId,
      targetAgentSessionId: child.agentSessionId,
      turnId: "source-turn",
      type: "session/forkThroughTurnRequested",
      workspaceId: "test-workspace"
    });
    activeConversationId = child.agentSessionId;
    engine.dispatch({ session: child, type: "session/upserted" });

    await vi.waitFor(() =>
      expect(listSessionSectionPage).toHaveBeenCalledWith(
        expect.objectContaining({ sectionKey: "conversations" })
      )
    );
    await vi.waitFor(() =>
      expect(
        controller.getSnapshot().runtimeRailMemberships?.[0]?.sessionIds
      ).toEqual([child.agentSessionId, source.agentSessionId])
    );

    resolveForkCommand({});
    await Promise.resolve();
    detach();
    engine.dispose();
  });

  it("does not start a targeted page refresh while the rail scope is pending", async () => {
    const engine = createTestAgentSessionEngine();
    const session = normalizeAgentActivitySession({
      activeTurnId: null,
      agentSessionId: "session-during-first-pages",
      agentTargetId: "local:codex",
      cwd: "/workspace",
      latestTurnInteractions: [],
      pendingInteractions: [],
      provider: "codex",
      railSectionKey: "conversations",
      title: "Session during first pages",
      updatedAtUnixMs: 1,
      workspaceId: "test-workspace"
    });
    let resolveFirstPages!: () => void;
    const listSessionSections = vi.fn<
      NonNullable<ConversationRailQueryRuntime["listSessionSections"]>
    >((input) =>
      new Promise<void>((resolve) => {
        resolveFirstPages = resolve;
      }).then(() => ({
        sections: [
          {
            hasMore: false,
            kind: "conversations" as const,
            sectionKey: "conversations",
            sessions: [session],
            totalCount: 1
          }
        ],
        workspaceId: input.workspaceId
      }))
    );
    const listSessionSectionPage = vi.fn(async (input) => ({
      hasMore: false,
      kind: "conversations" as const,
      sectionKey: input.sectionKey,
      sessions: [session],
      totalCount: 1
    }));
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime: { listSessionSections, listSessionSectionPage },
      workspaceId: "test-workspace"
    });
    const scope: ConversationRailQueryScope = {
      conversationFilter: { kind: "all" },
      userProjects: []
    };
    const scopeKey = resolveConversationRailQueryScope(
      "test-workspace",
      scope
    ).scopeKey;
    controller.configure(scope);

    const detach = controller.attach();
    await vi.waitFor(() =>
      expect(engine.getSnapshot().engineRuntime.workspaceReconcile.status).toBe(
        "ready"
      )
    );
    engine.dispatch({ session, type: "session/upserted" });
    expect(listSessionSectionPage).not.toHaveBeenCalled();

    expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(true);
    expect(controller.getSnapshot().runtimeRailResolvedScopeKey).not.toBe(
      scopeKey
    );
    expect(controller.getSnapshot().runtimeRailMemberships).toBeNull();
    expect(controller.isInteractionLocked()).toBe(true);

    resolveFirstPages();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );
    expect(controller.getSnapshot().runtimeRailResolvedScopeKey).toBe(scopeKey);
    expect(controller.getSnapshot().runtimeRailMemberships).toEqual([
      expect.objectContaining({
        id: "conversations",
        sessionIds: [session.agentSessionId]
      })
    ]);
    expect(controller.isInteractionLocked()).toBe(false);

    detach();
    engine.dispose();
  });

  it("debounces conversation searches and immediately clears an active query", async () => {
    vi.useFakeTimers();
    try {
      const engine = createTestAgentSessionEngine();
      const listSessionsPage = vi.fn<
        NonNullable<ConversationRailQueryRuntime["listSessionsPage"]>
      >(async (input) => ({
        hasMore: false,
        sessions: [],
        workspaceId: input.workspaceId
      }));
      const controller = new AgentGUIConversationRailQueryController({
        engine,
        getActiveConversationId: () => null,
        runtime: { listSessionsPage },
        workspaceId: "test-workspace"
      });
      controller.configure({
        conversationFilter: { kind: "all" },
        userProjects: []
      });

      const detach = controller.attach();
      controller.setSearchQuery("first");
      expect(controller.getSnapshot().railSearch.pending).toBe(true);
      expect(listSessionsPage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(CONVERSATION_SEARCH_DEBOUNCE_MS - 1);
      expect(listSessionsPage).not.toHaveBeenCalled();

      controller.setSearchQuery("second");
      await vi.advanceTimersByTimeAsync(CONVERSATION_SEARCH_DEBOUNCE_MS);
      expect(listSessionsPage).toHaveBeenCalledTimes(1);
      expect(listSessionsPage).toHaveBeenCalledWith(
        expect.objectContaining({ searchQuery: "second" })
      );
      expect(controller.getSnapshot().railSearch.pending).toBe(false);

      controller.setSearchQuery("transient");
      controller.setSearchQuery("second");
      expect(controller.getSnapshot().railSearch.pending).toBe(true);
      expect(listSessionsPage).toHaveBeenCalledTimes(1);

      controller.setSearchQuery("");
      expect(controller.getSnapshot().railSearch.pending).toBe(false);

      detach();
      engine.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes pin and delete snapshots only after affected pages resolve", async () => {
    const engine = createTestAgentSessionEngine();
    const session = normalizeAgentActivitySession({
      activeTurnId: null,
      agentSessionId: "session-1",
      agentTargetId: "local:codex",
      cwd: "/workspace",
      latestTurnInteractions: [],
      pendingInteractions: [],
      provider: "codex",
      railSectionKey: "conversations",
      title: "Session",
      updatedAtUnixMs: 1,
      workspaceId: "test-workspace"
    });
    const sectionResolvers: Array<() => void> = [];
    let pinnedRequestCount = 0;
    const listPinnedSessionsPage = vi.fn(async () => {
      pinnedRequestCount += 1;
      return {
        hasMore: false,
        sessions:
          pinnedRequestCount === 1
            ? [{ ...session, pinnedAtUnixMs: 100, updatedAtUnixMs: 2 }]
            : [],
        totalCount: pinnedRequestCount === 1 ? 1 : 0
      };
    });
    const listSessionSectionPage = vi.fn(async (input) => ({
      hasMore: false,
      kind: "conversations" as const,
      sectionKey: input.sectionKey,
      sessions: [],
      totalCount: 0
    }));
    const listSessionSections = vi.fn(
      (input) =>
        new Promise<
          Awaited<
            ReturnType<
              NonNullable<ConversationRailQueryRuntime["listSessionSections"]>
            >
          >
        >((resolve) => {
          sectionResolvers.push(() =>
            resolve({
              sections: [
                {
                  hasMore: false,
                  kind: "conversations",
                  sectionKey: "conversations",
                  sessions: [session],
                  totalCount: 1
                }
              ],
              workspaceId: input.workspaceId
            })
          );
        })
    );
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime: {
        listPinnedSessionsPage,
        listSessionSections,
        listSessionSectionPage,
        listSessionsPage: async (input) => ({
          hasMore: false,
          sessions: [],
          workspaceId: input.workspaceId
        })
      },
      workspaceId: "test-workspace"
    });
    const initialScope: ConversationRailQueryScope = {
      conversationFilter: { kind: "all" },
      userProjects: []
    };
    const initialScopeKey = resolveConversationRailQueryScope(
      "test-workspace",
      initialScope
    ).scopeKey;
    controller.configure(initialScope);

    const detach = controller.attach();
    expect(controller.isInteractionLocked()).toBe(true);
    expect(controller.getSnapshot().runtimeRailResolvedScopeKey).not.toBe(
      initialScopeKey
    );

    sectionResolvers.shift()?.();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );
    expect(controller.isInteractionLocked()).toBe(false);
    expect(controller.getSnapshot().runtimeRailResolvedScopeKey).toBe(
      initialScopeKey
    );
    const presentation = createRailConversationPresentation(controller, engine);
    let visiblePinnedAt = presentation.getSnapshot()[0]?.pinnedAtUnixMs ?? null;
    let visiblePinChanges = 0;
    const unsubscribe = presentation.subscribe((conversations) => {
      const nextPinnedAt = conversations[0]?.pinnedAtUnixMs ?? null;
      if (nextPinnedAt !== visiblePinnedAt) {
        visiblePinnedAt = nextPinnedAt;
        visiblePinChanges += 1;
      }
    });

    engine.dispatch({
      type: "session/upserted",
      session: {
        ...session,
        pinnedAtUnixMs: 100,
        updatedAtUnixMs: 2
      }
    });
    expect(controller.isInteractionLocked()).toBe(true);
    expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false);
    expect(controller.getSnapshot().runtimeRailMemberships).toHaveLength(1);
    expect(presentation.getSnapshot()[0]?.pinnedAtUnixMs).toBeNull();
    await vi.waitFor(() =>
      expect(listPinnedSessionsPage).toHaveBeenCalledTimes(1)
    );
    expect(listSessionSectionPage).toHaveBeenCalledTimes(1);
    expect(listSessionSections).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(controller.isInteractionLocked()).toBe(false)
    );
    expect(presentation.getSnapshot()[0]?.pinnedAtUnixMs).toBe(100);
    expect(
      controller
        .getSnapshot()
        .runtimeRailMemberships?.some((section) => section.id === "pinned")
    ).toBe(true);
    expect(visiblePinChanges).toBe(1);

    let visibleConversationCount = presentation.getSnapshot().length;
    let visibleDeleteChanges = 0;
    const unsubscribeDelete = presentation.subscribe((conversations) => {
      const nextCount = conversations.length;
      if (nextCount !== visibleConversationCount) {
        visibleConversationCount = nextCount;
        visibleDeleteChanges += 1;
      }
    });
    engine.dispatch({
      type: "session/removed",
      agentSessionId: session.agentSessionId
    });
    expect(controller.isInteractionLocked()).toBe(true);
    expect(presentation.getSnapshot()).toHaveLength(1);
    expect(
      controller
        .getSnapshot()
        .runtimeRailMemberships?.some((section) => section.id === "pinned")
    ).toBe(true);
    await vi.waitFor(() =>
      expect(
        controller
          .getSnapshot()
          .runtimeRailMemberships?.some((section) => section.id === "pinned")
      ).toBe(false)
    );
    expect(presentation.getSnapshot()).toHaveLength(0);
    expect(controller.isInteractionLocked()).toBe(false);
    expect(visibleDeleteChanges).toBe(1);

    const nextScope: ConversationRailQueryScope = {
      conversationFilter: {
        agentTargetId: "local:claude-code",
        kind: "agentTarget"
      },
      userProjects: []
    };
    controller.configure(nextScope);
    expect(controller.isInteractionLocked()).toBe(true);
    expect(controller.getSnapshot().runtimeRailResolvedScopeKey).not.toBe(
      resolveConversationRailQueryScope("test-workspace", nextScope).scopeKey
    );

    unsubscribeDelete();
    unsubscribe();
    presentation.dispose();
    detach();
    engine.dispose();
  });

  it("reuses fresh first pages across reattach and equivalent scope changes", async () => {
    const engine = createTestAgentSessionEngine();
    const listSessionSections = vi.fn<
      NonNullable<ConversationRailQueryRuntime["listSessionSections"]>
    >(async (input) => ({
      workspaceId: input.workspaceId,
      sections: []
    }));
    const runtime: ConversationRailQueryRuntime = {
      listSessionSections,
      listSessionSectionPage: async (input) => ({
        kind: "conversations",
        sectionKey: input.sectionKey,
        sessions: [],
        hasMore: false,
        totalCount: 0
      })
    };
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime,
      workspaceId: "test-workspace"
    });
    const regularScope = {
      conversationFilter: { kind: "all" } as const,
      userProjects: []
    };

    controller.configure(regularScope);
    const detachFirst = controller.attach();
    await vi.waitFor(() =>
      expect(listSessionSections).toHaveBeenCalledTimes(1)
    );
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );
    detachFirst();

    const detachSecond = controller.attach();
    expect(listSessionSections).toHaveBeenCalledTimes(1);

    controller.configure({ ...regularScope });
    expect(controller.getSnapshot().runtimeSectionsEnabled).toBe(true);
    expect(listSessionSections).toHaveBeenCalledTimes(1);

    detachSecond();
    engine.dispose();
  });

  it("does not reload section pages when user projects only reorder", async () => {
    const engine = createTestAgentSessionEngine();
    const listSessionSections = vi.fn<
      NonNullable<ConversationRailQueryRuntime["listSessionSections"]>
    >(async (input) => ({
      sections: [],
      workspaceId: input.workspaceId
    }));
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime: {
        listSessionSections,
        listSessionSectionPage: async (input) => ({
          hasMore: false,
          kind: "conversations",
          sectionKey: input.sectionKey,
          sessions: [],
          totalCount: 0
        })
      },
      workspaceId: "test-workspace"
    });
    const alpha = {
      id: "alpha",
      label: "Alpha",
      path: "/alpha",
      pinnedAtUnixMs: 0,
      sectionKey: "project:/alpha"
    };
    const beta = {
      id: "beta",
      label: "Beta",
      path: "/beta",
      pinnedAtUnixMs: 0,
      sectionKey: "project:/beta"
    };
    const scope = {
      conversationFilter: { kind: "all" } as const,
      userProjects: [alpha, beta]
    };

    controller.configure(scope);
    const detach = controller.attach();
    await vi.waitFor(() =>
      expect(listSessionSections).toHaveBeenCalledTimes(1)
    );
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );

    controller.configure({ ...scope, userProjects: [beta, alpha] });

    expect(listSessionSections).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false);
    expect(controller.isInteractionLocked()).toBe(false);

    controller.configure({
      ...scope,
      userProjects: [
        beta,
        alpha,
        {
          id: "gamma",
          label: "Gamma",
          path: "/gamma",
          pinnedAtUnixMs: 0,
          sectionKey: "project:/gamma"
        }
      ]
    });
    await vi.waitFor(() =>
      expect(listSessionSections).toHaveBeenCalledTimes(2)
    );

    detach();
    engine.dispose();
  });

  it("keeps existing rows interactive when a targeted membership refresh is rejected", async () => {
    const engine = createTestAgentSessionEngine();
    const session = normalizeAgentActivitySession({
      activeTurnId: null,
      agentSessionId: "session-1",
      agentTargetId: "local:codex",
      cwd: "/workspace",
      latestTurnInteractions: [],
      pendingInteractions: [],
      provider: "codex",
      railSectionKey: "conversations",
      title: "Session",
      updatedAtUnixMs: 1,
      workspaceId: "test-workspace"
    });
    const listPinnedSessionsPage = vi.fn(async () => {
      throw Object.assign(new Error("pinned page rejected"), {
        statusCode: 403
      });
    });
    const listSessionSectionPage = vi.fn(async () => {
      throw Object.assign(new Error("section page rejected"), {
        statusCode: 403
      });
    });
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime: {
        listPinnedSessionsPage,
        listSessionSectionPage,
        listSessionSections: async (input) => ({
          sections: [
            {
              hasMore: false,
              kind: "conversations",
              sectionKey: "conversations",
              sessions: [session],
              totalCount: 1
            }
          ],
          workspaceId: input.workspaceId
        })
      },
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
    const presentation = createRailConversationPresentation(controller, engine);

    engine.dispatch({
      session: { ...session, pinnedAtUnixMs: 10, updatedAtUnixMs: 2 },
      type: "session/upserted"
    });
    await vi.waitFor(() =>
      expect(listPinnedSessionsPage).toHaveBeenCalledTimes(1)
    );
    expect(listSessionSectionPage).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailFailed).toBe(true)
    );
    expect(controller.isInteractionLocked()).toBe(false);
    expect(presentation.getSnapshot()[0]?.pinnedAtUnixMs).toBe(10);
    expect(
      controller.getSnapshot().runtimeRailMemberships?.[0]?.sessionIds
    ).toEqual(["session-1"]);
    expect(listPinnedSessionsPage).toHaveBeenCalledTimes(1);
    expect(listSessionSectionPage).toHaveBeenCalledTimes(1);

    presentation.dispose();
    detach();
    engine.dispose();
  });

  it("clears a canceled section loading state before targeted refresh settles", async () => {
    const engine = createTestAgentSessionEngine();
    const sessionA = createTestSession("session-a", "project:a");
    const sessionB = createTestSession("session-b", "project:b");
    let paginationAborted = false;
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime: {
        listPinnedSessionsPage: async () => ({
          hasMore: false,
          sessions: [{ ...sessionA, pinnedAtUnixMs: 10, updatedAtUnixMs: 2 }],
          totalCount: 1
        }),
        listSessionSectionPage: (input) => {
          if (input.cursor) {
            return new Promise((_resolve, reject) => {
              input.signal?.addEventListener(
                "abort",
                () => {
                  paginationAborted = true;
                  reject(new DOMException("Aborted", "AbortError"));
                },
                { once: true }
              );
            });
          }
          return Promise.resolve({
            hasMore: false,
            kind: "project" as const,
            sectionKey: input.sectionKey,
            sessions: [],
            totalCount: 0
          });
        },
        listSessionSections: async (input) => ({
          sections: [
            {
              hasMore: false,
              kind: "project",
              sectionKey: "project:a",
              sessions: [sessionA],
              totalCount: 1
            },
            {
              hasMore: true,
              kind: "project",
              nextCursor: "b-cursor",
              sectionKey: "project:b",
              sessions: [sessionB],
              totalCount: 2
            }
          ],
          workspaceId: input.workspaceId
        })
      },
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

    controller.loadMoreSectionConversations({ id: "project:b" });
    expect(
      controller.getSnapshot().sectionPageStates.get("project:b")?.isLoading
    ).toBe(true);

    engine.dispatch({
      session: { ...sessionA, pinnedAtUnixMs: 10, updatedAtUnixMs: 2 },
      type: "session/upserted"
    });
    await vi.waitFor(() => expect(paginationAborted).toBe(true));
    await vi.waitFor(() =>
      expect(controller.isInteractionLocked()).toBe(false)
    );
    expect(
      controller.getSnapshot().sectionPageStates.get("project:b")?.isLoading
    ).toBe(false);

    detach();
    engine.dispose();
  });

  it("retains resolved section pages when a same-scope refresh fails and recovers", async () => {
    const engine = createTestAgentSessionEngine();
    let requestCount = 0;
    const listSessionSections = vi.fn<
      NonNullable<ConversationRailQueryRuntime["listSessionSections"]>
    >(async (input) => {
      requestCount += 1;
      if (requestCount === 2) {
        throw Object.assign(new Error("request rejected"), {
          statusCode: 403
        });
      }
      return {
        workspaceId: input.workspaceId,
        sections: [
          {
            kind: "conversations",
            sectionKey: "conversations",
            sessions: [],
            hasMore: true,
            nextCursor: "cursor-1",
            totalCount: 8
          }
        ]
      };
    });
    const controller = new AgentGUIConversationRailQueryController({
      cacheFreshMs: -1,
      engine,
      getActiveConversationId: () => null,
      runtime: {
        listSessionSections,
        listSessionSectionPage: async (input) => ({
          kind: "conversations",
          sectionKey: input.sectionKey,
          sessions: [],
          hasMore: false,
          totalCount: 0
        })
      },
      workspaceId: "test-workspace"
    });
    controller.configure({
      conversationFilter: { kind: "all" },
      userProjects: []
    });

    const detachFirst = controller.attach();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailMemberships).toHaveLength(1)
    );
    detachFirst();

    const detachSecond = controller.attach();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );
    expect(controller.getSnapshot().runtimeRailMemberships).toEqual([
      expect.objectContaining({ id: "conversations" })
    ]);
    expect(
      controller.getSnapshot().sectionPageStates.get("conversations")
    ).toEqual({
      hasMore: true,
      isLoading: false,
      nextCursor: "cursor-1",
      totalCount: 8
    });
    expect(controller.getSnapshot().runtimeRailFailed).toBe(true);

    await controller.refresh();

    expect(listSessionSections).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot().runtimeRailFailed).toBe(false);
    expect(controller.getSnapshot().runtimeRailMemberships).toEqual([
      expect.objectContaining({ id: "conversations" })
    ]);

    detachSecond();
    engine.dispose();
  });

  it("retries a failed section page load when More is requested again", async () => {
    const engine = createTestAgentSessionEngine();
    const firstSession = createTestSession("session-1", "conversations");
    const secondSession = createTestSession("session-2", "conversations");
    let pageRequestCount = 0;
    const listSessionSectionPage = vi.fn<
      NonNullable<ConversationRailQueryRuntime["listSessionSectionPage"]>
    >(async (input) => {
      pageRequestCount += 1;
      if (pageRequestCount === 1) throw new Error("transient page failure");
      return {
        hasMore: false,
        kind: "conversations",
        sectionKey: input.sectionKey,
        sessions: [secondSession],
        totalCount: 2
      };
    });
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime: {
        listSessionSectionPage,
        listSessionSections: async (input) => ({
          sections: [
            {
              hasMore: true,
              kind: "conversations",
              nextCursor: "cursor-2",
              sectionKey: "conversations",
              sessions: [firstSession],
              totalCount: 2
            }
          ],
          workspaceId: input.workspaceId
        })
      },
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

    controller.loadMoreSectionConversations({ id: "conversations" });
    await vi.waitFor(() =>
      expect(listSessionSectionPage).toHaveBeenCalledTimes(1)
    );
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailFailed).toBe(true)
    );
    expect(
      controller.getSnapshot().sectionPageStates.get("conversations")
    ).toEqual({
      hasMore: true,
      isLoading: false,
      nextCursor: "cursor-2",
      totalCount: 2
    });

    controller.loadMoreSectionConversations({ id: "conversations" });
    await vi.waitFor(() =>
      expect(listSessionSectionPage).toHaveBeenCalledTimes(2)
    );
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailFailed).toBe(false)
    );
    expect(
      controller.getSnapshot().sectionPageStates.get("conversations")
    ).toEqual({
      hasMore: false,
      isLoading: false,
      nextCursor: null,
      totalCount: 2
    });
    expect(
      selectEngineSession(engine.getSnapshot(), secondSession.agentSessionId)
    ).not.toBeNull();

    detach();
    engine.dispose();
  });

  it("isolates subscriber failures from successful rail queries", async () => {
    const engine = createTestAgentSessionEngine();
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime: {
        listSessionSections: async (input) => ({
          sections: [
            {
              hasMore: false,
              kind: "conversations",
              sectionKey: "conversations",
              sessions: [],
              totalCount: 0
            }
          ],
          workspaceId: input.workspaceId
        }),
        listSessionSectionPage: async (input) => ({
          hasMore: false,
          kind: "conversations",
          sectionKey: input.sectionKey,
          sessions: [],
          totalCount: 0
        })
      },
      workspaceId: "test-workspace"
    });
    controller.configure({
      conversationFilter: { kind: "all" },
      userProjects: []
    });
    const unsubscribeThrowingListener = controller.subscribe(() => {
      throw new Error("host projection failed");
    });
    const healthyListener = vi.fn();
    const unsubscribeHealthyListener = controller.subscribe(healthyListener);

    const detach = controller.attach();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );

    expect(healthyListener).toHaveBeenCalled();
    expect(controller.getSnapshot().runtimeRailFailed).toBe(false);
    expect(controller.getSnapshot().runtimeRailMemberships).toEqual([
      expect.objectContaining({ id: "conversations" })
    ]);

    unsubscribeHealthyListener();
    unsubscribeThrowingListener();
    detach();
    engine.dispose();
  });

  it("logs only slow successful first-page rail queries", async () => {
    const engine = createTestAgentSessionEngine();
    const reportDiagnostic = vi.fn();
    const diagnosticTimes = [0, 300, 325];
    const controller = new AgentGUIConversationRailQueryController({
      cacheFreshMs: -1,
      diagnosticNow: () => diagnosticTimes.shift() ?? 325,
      diagnosticSlowThresholdMs: 250,
      engine,
      getActiveConversationId: () => null,
      runtime: {
        listSessionSections: async (input) => ({
          pinned: {
            hasMore: false,
            sessions: [],
            totalCount: 0
          },
          sections: [
            {
              hasMore: false,
              kind: "conversations",
              sectionKey: "conversations",
              sessions: [],
              totalCount: 0
            }
          ],
          workspaceId: input.workspaceId
        }),
        listSessionSectionPage: async (input) => ({
          hasMore: false,
          kind: "conversations",
          sectionKey: input.sectionKey,
          sessions: [],
          totalCount: 0
        }),
        reportDiagnostic
      },
      workspaceId: "test-workspace"
    });
    controller.configure({
      conversationFilter: {
        kind: "agentTarget",
        agentTargetId: "local:codex"
      },
      userProjects: []
    });

    const detach = controller.attach();
    await vi.waitFor(() => expect(reportDiagnostic).toHaveBeenCalledTimes(1));
    expect(reportDiagnostic).toHaveBeenCalledWith({
      details: {
        agentTargetId: "local:codex",
        controllerApplyMs: 25,
        durationMs: 325,
        event: "agent_gui.conversation_rail.first_pages_slow",
        nodeId: null,
        requestId: 2,
        requestMs: 300,
        refreshReason: "attach",
        returnedSessionCount: 0,
        returnedSessionIds: [],
        runtimeOrigin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
        sectionCount: 2,
        status: "ready",
        workspaceId: "test-workspace"
      },
      event: "agent_gui.conversation_rail.first_pages_slow",
      level: "info",
      source: "agent-gui",
      workspaceId: "test-workspace"
    });

    detach();
    engine.dispose();
  });

  it("suppresses fast success diagnostics but records real failures", async () => {
    const engine = createTestAgentSessionEngine();
    const diagnosticLogger = vi.fn();
    let requestCount = 0;
    const diagnosticTimes = [0, 100, 110, 110, 130];
    const controller = new AgentGUIConversationRailQueryController({
      cacheFreshMs: -1,
      diagnosticLogger,
      diagnosticNow: () => diagnosticTimes.shift() ?? 130,
      diagnosticSlowThresholdMs: 250,
      engine,
      getActiveConversationId: () => null,
      runtime: {
        listSessionSections: async (input) => {
          requestCount += 1;
          if (requestCount > 1) throw new TypeError("backend unavailable");
          return { sections: [], workspaceId: input.workspaceId };
        },
        listSessionSectionPage: async (input) => ({
          hasMore: false,
          kind: "conversations",
          sectionKey: input.sectionKey,
          sessions: [],
          totalCount: 0
        })
      },
      workspaceId: "test-workspace"
    });
    const scope = {
      conversationFilter: { kind: "all" } as const,
      userProjects: []
    };
    controller.configure(scope);

    const detachFirst = controller.attach();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );
    expect(diagnosticLogger).not.toHaveBeenCalled();
    detachFirst();

    const detachSecond = controller.attach();
    await vi.waitFor(() => expect(diagnosticLogger).toHaveBeenCalledTimes(1));
    expect(diagnosticLogger).toHaveBeenCalledWith({
      agentTargetId: null,
      controllerApplyMs: 0,
      durationMs: 20,
      errorKind: "TypeError",
      event: "agent_gui.conversation_rail.first_pages_failed",
      nodeId: null,
      requestId: 4,
      requestMs: 20,
      refreshReason: "attach",
      returnedSessionCount: 0,
      returnedSessionIds: [],
      runtimeOrigin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
      sectionCount: 0,
      status: "error",
      workspaceId: "test-workspace"
    });

    detachSecond();
    engine.dispose();
  });

  it("isolates in-flight controller requests and restores the resolved cache after remount", async () => {
    const engine = createTestAgentSessionEngine();
    const cache = createWorkspaceQueryCache<CachedConversationRailQuery>();
    const sectionResolvers: Array<() => void> = [];
    const listSessionSections = vi.fn<
      NonNullable<ConversationRailQueryRuntime["listSessionSections"]>
    >((input) =>
      new Promise<void>((resolve) => {
        sectionResolvers.push(resolve);
      }).then(() => ({
        sections: [
          {
            hasMore: false,
            kind: "conversations" as const,
            sectionKey: "conversations",
            sessions: [],
            totalCount: 0
          }
        ],
        workspaceId: input.workspaceId
      }))
    );
    const runtime: ConversationRailQueryRuntime = {
      listSessionSections,
      listSessionSectionPage: async (input) => ({
        hasMore: false,
        kind: "conversations",
        sectionKey: input.sectionKey,
        sessions: [],
        totalCount: 0
      })
    };
    const scope = {
      conversationFilter: {
        agentTargetId: "local:codex",
        kind: "agentTarget"
      } as const,
      userProjects: []
    };
    const first = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime,
      sessionSectionsQueryCache: cache,
      workspaceId: "test-workspace"
    });
    const second = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime,
      sessionSectionsQueryCache: cache,
      workspaceId: "test-workspace"
    });
    first.configure(scope);
    second.configure(scope);
    const detachFirst = first.attach();
    const detachSecond = second.attach();

    expect(listSessionSections).toHaveBeenCalledTimes(2);
    for (const resolve of sectionResolvers) resolve();
    await vi.waitFor(() =>
      expect(first.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );
    await vi.waitFor(() =>
      expect(second.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );
    detachFirst();
    detachSecond();

    const remounted = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime,
      sessionSectionsQueryCache: cache,
      workspaceId: "test-workspace"
    });
    remounted.configure(scope);
    const detachRemounted = remounted.attach();
    expect(remounted.getSnapshot().runtimeRailMemberships).toHaveLength(1);
    expect(remounted.getSnapshot().runtimeRailSectionsPending).toBe(false);
    expect(listSessionSections).toHaveBeenCalledTimes(2);

    detachRemounted();
    engine.dispose();
  });

  it("restores a fresh target scope without refetching on A to B to A", async () => {
    const engine = createTestAgentSessionEngine();
    const diagnosticLogger = vi.fn();
    const listSessionSections = vi.fn<
      NonNullable<ConversationRailQueryRuntime["listSessionSections"]>
    >(async (input) => ({
      sections: [
        {
          hasMore: false,
          kind: "conversations",
          sectionKey: "conversations",
          sessions: [],
          totalCount: 0
        }
      ],
      workspaceId: input.workspaceId
    }));
    const controller = new AgentGUIConversationRailQueryController({
      diagnosticLogger,
      engine,
      getActiveConversationId: () => null,
      runtime: {
        listSessionSections,
        listSessionSectionPage: async (input) => ({
          hasMore: false,
          kind: "conversations",
          sectionKey: input.sectionKey,
          sessions: [],
          totalCount: 0
        })
      },
      workspaceId: "test-workspace"
    });
    const scope = (agentTargetId: string) => ({
      conversationFilter: { agentTargetId, kind: "agentTarget" as const },
      userProjects: []
    });
    controller.configure(scope("local:codex"));
    const detach = controller.attach();
    await vi.waitFor(() =>
      expect(listSessionSections).toHaveBeenCalledTimes(1)
    );
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );

    controller.configure(scope("local:claude-code"));
    await vi.waitFor(() =>
      expect(listSessionSections).toHaveBeenCalledTimes(2)
    );
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );
    expect(diagnosticLogger).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cacheStatus: "miss",
        event: "agent_gui.provider_switch.completed",
        fromAgentTargetId: "local:codex",
        status: "ready",
        toAgentTargetId: "local:claude-code"
      })
    );

    controller.configure(scope("local:codex"));
    expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false);
    expect(listSessionSections).toHaveBeenCalledTimes(2);
    expect(diagnosticLogger).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cacheStatus: "fresh",
        event: "agent_gui.provider_switch.completed",
        fromAgentTargetId: "local:claude-code",
        requestMs: 0,
        status: "ready",
        toAgentTargetId: "local:codex"
      })
    );

    detach();
    engine.dispose();
  });

  it("logs retained sessions when switching from a target filter to all", async () => {
    const engine = createTestAgentSessionEngine();
    const diagnosticLogger = vi.fn();
    const previousSession = normalizeAgentActivitySession({
      activeTurnId: null,
      agentSessionId: "session-previous",
      agentTargetId: "shared:one",
      cwd: "/workspace",
      latestTurnInteractions: [],
      pendingInteractions: [],
      provider: "codex",
      railSectionKey: "conversations",
      title: "Previous conversation",
      updatedAtUnixMs: 1,
      workspaceId: "test-workspace"
    });
    const allSession = normalizeAgentActivitySession({
      ...previousSession,
      agentSessionId: "session-from-all",
      title: "Conversation returned by all"
    });
    let resolveAllSections!: () => void;
    let requestCount = 0;
    const listSessionSections = vi.fn<
      NonNullable<ConversationRailQueryRuntime["listSessionSections"]>
    >((input) => {
      requestCount += 1;
      if (requestCount === 1) {
        return Promise.resolve({
          sections: [
            {
              hasMore: false,
              kind: "conversations" as const,
              sectionKey: "conversations",
              sessions: [previousSession],
              totalCount: 1
            }
          ],
          workspaceId: input.workspaceId
        });
      }
      return new Promise<void>((resolve) => {
        resolveAllSections = resolve;
      }).then(() => ({
        sections: [
          {
            hasMore: false,
            kind: "conversations" as const,
            sectionKey: "conversations",
            sessions: [previousSession, allSession],
            totalCount: 2
          }
        ],
        workspaceId: input.workspaceId
      }));
    });
    const controller = new AgentGUIConversationRailQueryController({
      diagnosticLogger,
      engine,
      getActiveConversationId: () => "session-previous",
      nodeId: "shared-node-1",
      runtime: {
        listSessionSections,
        listSessionSectionPage: async (input) => ({
          hasMore: false,
          kind: "conversations",
          sectionKey: input.sectionKey,
          sessions: [],
          totalCount: 0
        })
      },
      workspaceId: "test-workspace"
    });
    controller.configure({
      conversationFilter: {
        agentTargetId: "shared:one",
        kind: "agentTarget"
      },
      userProjects: []
    });
    const detach = controller.attach();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );
    diagnosticLogger.mockClear();

    controller.configure({
      conversationFilter: { kind: "all" },
      userProjects: []
    });

    expect(listSessionSections).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentTargetId: undefined })
    );

    expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(true);
    expect(controller.getSnapshot().runtimeRailMemberships).toEqual([
      expect.objectContaining({ sessionIds: ["session-previous"] })
    ]);
    expect(diagnosticLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        activeConversationId: "session-previous",
        event: "agent_gui.conversation_rail.scope_change.started",
        fromAgentTargetId: "shared:one",
        fromFilterKind: "agentTarget",
        nodeId: "shared-node-1",
        preservedSectionCount: 1,
        preservedSessionIds: ["session-previous"],
        retainedPreviousSections: true,
        runtimeOrigin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
        status: "pending",
        toAgentTargetId: null,
        toFilterKind: "all"
      })
    );

    resolveAllSections();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );
    expect(diagnosticLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheStatus: "miss",
        event: "agent_gui.conversation_rail.scope_change.completed",
        nodeId: "shared-node-1",
        returnedSessionCount: 2,
        returnedSessionIds: ["session-previous", "session-from-all"],
        status: "ready"
      })
    );
    expect(diagnosticLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent_gui.provider_switch.completed",
        fromAgentTargetId: "shared:one",
        toAgentTargetId: null
      })
    );

    detach();
    engine.dispose();
  });
});

function createTestSession(agentSessionId: string, railSectionKey: string) {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId,
    agentTargetId: "local:codex",
    cwd: "/workspace",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    railSectionKey,
    title: agentSessionId,
    updatedAtUnixMs: 1,
    workspaceId: "test-workspace"
  });
}

function createRailConversationPresentation(
  controller: AgentGUIConversationRailQueryController,
  engine: AgentSessionEngine
) {
  const select = createConversationRailConversationsSelector();
  let current = select({
    engineState: engine.getSnapshot(),
    interactionLocked: controller.isInteractionLocked(),
    querySnapshot: controller.getSnapshot()
  });
  const listeners = new Set<(value: typeof current) => void>();
  const update = () => {
    const next = select(
      {
        engineState: engine.getSnapshot(),
        interactionLocked: controller.isInteractionLocked(),
        querySnapshot: controller.getSnapshot()
      },
      current
    );
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener(current);
  };
  const unsubscribeEngine = engine.subscribe(update);
  const unsubscribeController = controller.subscribe(update);
  return {
    dispose() {
      unsubscribeController();
      unsubscribeEngine();
      listeners.clear();
    },
    getSnapshot: () => current,
    subscribe(listener: (value: typeof current) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
