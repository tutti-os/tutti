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
});
