import { describe, expect, it, vi } from "vitest";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import {
  AgentGUIConversationRailQueryController,
  type ConversationRailQueryRuntime
} from "./AgentGUIConversationRailQueryController";

describe("AgentGUIConversationRailQueryController", () => {
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
});
