import {
  dispatchSessionMutation,
  normalizeAgentActivitySession,
  selectSessionMutation,
  type EngineCommandPort
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import {
  AgentGUIConversationRailQueryController,
  type ConversationRailQueryRuntime
} from "./AgentGUIConversationRailQueryController";

describe("AgentGUIConversationRailQueryController reattach", () => {
  it("resynchronizes a mutation that completes while detached", async () => {
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
    let resolvePin: (value: unknown) => void = () => {};
    const commandPort: EngineCommandPort = {
      execute(command) {
        if (command.type === "sessions/delete") {
          return Promise.resolve({
            removedMessages: 0,
            removedSessionIds: [...command.agentSessionIds],
            removedSessions: command.agentSessionIds.length
          });
        }
        if (command.type !== "session/setPinned") {
          return Promise.resolve({ ok: true });
        }
        return new Promise((resolve) => {
          resolvePin = resolve;
        });
      }
    };
    const engine = createTestAgentSessionEngine("test-workspace", commandPort);
    const pinnedSession = {
      ...session,
      pinnedAtUnixMs: 10,
      updatedAtUnixMs: 2
    };
    const listPinnedSessionsPage = vi.fn(async () => ({
      hasMore: false,
      sessions: [pinnedSession],
      totalCount: 1
    }));
    const listSessionSectionPage = vi.fn(async (input) => ({
      hasMore: false,
      kind: "conversations" as const,
      sectionKey: input.sectionKey,
      sessions: [],
      totalCount: 0
    }));
    const runtime: ConversationRailQueryRuntime = {
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

    engine.dispatch({
      agentSessionId: "session-1",
      mutationId: "pin-1",
      pinned: true,
      type: "session/pinRequested",
      workspaceId: "test-workspace"
    });
    expect(controller.isInteractionLocked()).toBe(true);
    detach();
    resolvePin({ session: pinnedSession });
    await vi.waitFor(() =>
      expect(selectSessionMutation(engine.getSnapshot(), "pin-1")?.status).toBe(
        "succeeded"
      )
    );
    for (let index = 0; index < 129; index += 1) {
      await dispatchSessionMutation(engine, {
        agentSessionIds: [`detached-session-${index}`],
        mutationId: `detached-delete-${index}`,
        type: "sessions/deleteRequested",
        workspaceId: "test-workspace"
      });
    }
    expect(selectSessionMutation(engine.getSnapshot(), "pin-1")).toBeNull();

    const detachAgain = controller.attach();
    await vi.waitFor(() =>
      expect(controller.isInteractionLocked()).toBe(false)
    );
    expect(listPinnedSessionsPage).toHaveBeenCalledTimes(1);
    expect(listSessionSectionPage).toHaveBeenCalledTimes(1);
    expect(
      controller.getSnapshot().runtimeRailConversations[0]?.pinnedAtUnixMs
    ).toBe(10);

    detachAgain();
    engine.dispose();
  });
});
