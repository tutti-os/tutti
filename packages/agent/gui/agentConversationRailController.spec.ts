import { describe, expect, it, vi } from "vitest";
import { createTestAgentSessionEngine } from "./shared/testing/createTestAgentSessionEngine";
import { createAgentGUIConversationRailQueryController } from "./agentConversationRailController";

describe("createAgentGUIConversationRailQueryController", () => {
  it("owns resolved-query cache reuse for controllers on one Engine", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    const listSessionSections = vi.fn(
      async (input: { workspaceId: string }) => ({
        sections: [],
        workspaceId: input.workspaceId
      })
    );
    const runtime = {
      listSessionSectionPage: vi.fn(async (input: { sectionKey: string }) => ({
        hasMore: false,
        kind: "conversations" as const,
        sectionKey: input.sectionKey,
        sessions: [],
        totalCount: 0
      })),
      listSessionSections
    };
    const scope = {
      conversationFilter: { kind: "all" as const },
      userProjects: []
    };
    const first = createAgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime,
      workspaceId: "workspace-1"
    });
    first.configure(scope);
    const detachFirst = first.attach();

    await vi.waitFor(() =>
      expect(first.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );
    expect(listSessionSections).toHaveBeenCalledTimes(1);
    detachFirst();

    const remounted = createAgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime,
      workspaceId: "workspace-1"
    });
    remounted.configure(scope);
    const detachRemounted = remounted.attach();

    expect(remounted.getSnapshot().runtimeRailSectionsPending).toBe(false);
    expect(listSessionSections).toHaveBeenCalledTimes(1);

    detachRemounted();
    engine.dispose();
  });
});
