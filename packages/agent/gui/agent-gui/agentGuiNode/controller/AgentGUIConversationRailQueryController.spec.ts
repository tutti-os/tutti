import { describe, expect, it, vi } from "vitest";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import {
  AgentGUIConversationRailQueryController,
  CONVERSATION_SEARCH_DEBOUNCE_MS,
  type ConversationRailQueryRuntime
} from "./AgentGUIConversationRailQueryController";

describe("AgentGUIConversationRailQueryController", () => {
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
        previewMode: false,
        sectionAgentTargetFallbackId: null,
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

  it("owns the latest rail interaction lock instead of mirroring it in view refs", async () => {
    const engine = createTestAgentSessionEngine();
    let resolveSections!: () => void;
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime: {
        listSessionSections: (input) =>
          new Promise((resolve) => {
            resolveSections = () =>
              resolve({ sections: [], workspaceId: input.workspaceId });
          }),
        listSessionSectionPage: async (input) => ({
          hasMore: false,
          kind: "conversations",
          sectionKey: input.sectionKey,
          sessions: [],
          totalCount: 0
        }),
        listSessionsPage: async (input) => ({
          hasMore: false,
          sessions: [],
          workspaceId: input.workspaceId
        })
      },
      workspaceId: "test-workspace"
    });
    controller.configure({
      conversationFilter: { kind: "all" },
      previewMode: false,
      sectionAgentTargetFallbackId: null,
      userProjects: []
    });

    const detach = controller.attach();
    expect(controller.isInteractionLocked()).toBe(true);

    controller.setSearchQuery("active search");
    expect(controller.isInteractionLocked()).toBe(false);

    resolveSections();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );
    detach();
    engine.dispose();
  });

  it("reattaches cleanly and follows preview-mode scope changes", async () => {
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
      previewMode: false,
      sectionAgentTargetFallbackId: null,
      userProjects: []
    };

    controller.configure(regularScope);
    const detachFirst = controller.attach();
    await vi.waitFor(() =>
      expect(listSessionSections).toHaveBeenCalledTimes(1)
    );
    detachFirst();

    const detachSecond = controller.attach();
    await vi.waitFor(() =>
      expect(listSessionSections).toHaveBeenCalledTimes(2)
    );

    controller.configure({ ...regularScope, previewMode: true });
    expect(controller.getSnapshot().runtimeSectionsEnabled).toBe(false);
    expect(listSessionSections).toHaveBeenCalledTimes(2);

    controller.configure(regularScope);
    await vi.waitFor(() =>
      expect(listSessionSections).toHaveBeenCalledTimes(3)
    );
    expect(controller.getSnapshot().runtimeSectionsEnabled).toBe(true);

    detachSecond();
    engine.dispose();
  });

  it("retains resolved section pages when a same-scope refresh fails", async () => {
    const engine = createTestAgentSessionEngine();
    let requestCount = 0;
    const listSessionSections = vi.fn<
      NonNullable<ConversationRailQueryRuntime["listSessionSections"]>
    >(async (input) => {
      requestCount += 1;
      if (requestCount > 1) throw new Error("transient failure");
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
      previewMode: false,
      sectionAgentTargetFallbackId: null,
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

    detachSecond();
    engine.dispose();
  });

  it("logs only slow successful first-page rail queries", async () => {
    const engine = createTestAgentSessionEngine();
    const reportDiagnostic = vi.fn();
    const diagnosticTimes = [0, 300, 325];
    const controller = new AgentGUIConversationRailQueryController({
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
      previewMode: false,
      sectionAgentTargetFallbackId: null,
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
        requestId: 2,
        requestMs: 300,
        sectionCount: 2,
        sessionCount: 0,
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
      previewMode: false,
      sectionAgentTargetFallbackId: null,
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
      requestId: 4,
      requestMs: 20,
      sectionCount: 0,
      sessionCount: 0,
      status: "error",
      workspaceId: "test-workspace"
    });

    detachSecond();
    engine.dispose();
  });
});
