import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import {
  AgentGUIConversationRailQueryController,
  type ConversationRailQueryRuntime
} from "./AgentGUIConversationRailQueryController";

describe("AgentGUIConversationRailQueryController reattach", () => {
  it("recovers an interrupted draft from an authoritative scoped refresh", async () => {
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
    const engine = createTestAgentSessionEngine();
    const pinnedSession = {
      ...session,
      pinnedAtUnixMs: 10,
      updatedAtUnixMs: 2
    };
    const listPinnedSessionsPage = vi.fn(() => new Promise<never>(() => {}));
    const listSessionSectionPage = vi.fn(() => new Promise<never>(() => {}));
    let firstPagesRequestCount = 0;
    const runtime: ConversationRailQueryRuntime = {
      listPinnedSessionsPage,
      listSessionSectionPage,
      listSessionSections: async (input) => {
        firstPagesRequestCount += 1;
        return {
          pinned:
            firstPagesRequestCount > 1
              ? {
                  hasMore: false,
                  sessions: [pinnedSession],
                  totalCount: 1
                }
              : undefined,
          sections: [
            {
              hasMore: false,
              kind: "conversations",
              sectionKey: "conversations",
              sessions: firstPagesRequestCount > 1 ? [] : [session],
              totalCount: firstPagesRequestCount > 1 ? 0 : 1
            }
          ],
          workspaceId: input.workspaceId
        };
      }
    };
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime,
      workspaceId: "test-workspace"
    });
    controller.configure({
      conversationFilter: { kind: "all" },
      previewMode: false,
      sectionAgentTargetFallbackId: null,
      userProjects: []
    });
    const detach = controller.attach();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().runtimeRailSectionsPending).toBe(false)
    );

    engine.dispatch({ session: pinnedSession, type: "session/upserted" });
    await vi.waitFor(() =>
      expect(listPinnedSessionsPage).toHaveBeenCalledTimes(1)
    );
    expect(listSessionSectionPage).toHaveBeenCalledTimes(1);
    expect(controller.isInteractionLocked()).toBe(true);
    detach();

    const detachAgain = controller.attach();
    expect(controller.isInteractionLocked()).toBe(true);
    await vi.waitFor(() =>
      expect(controller.isInteractionLocked()).toBe(false)
    );
    expect(firstPagesRequestCount).toBe(2);
    expect(
      controller.getSnapshot().runtimeRailConversations[0]?.pinnedAtUnixMs
    ).toBe(10);

    detachAgain();
    engine.dispose();
  });
});
