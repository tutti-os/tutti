import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import {
  AgentGUIConversationRailQueryController,
  type ConversationRailQueryRuntime
} from "./AgentGUIConversationRailQueryController";
import { createConversationRailConversationsSelector } from "./agentGuiConversationRailQuerySnapshot";

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
      createConversationRailConversationsSelector()({
        engineState: engine.getSnapshot(),
        interactionLocked: controller.isInteractionLocked(),
        querySnapshot: controller.getSnapshot()
      })[0]?.pinnedAtUnixMs
    ).toBe(10);

    detachAgain();
    engine.dispose();
  });

  it("retries a failed publication search after detach and reattach", async () => {
    const session = normalizeAgentActivitySession({
      activeTurnId: null,
      agentSessionId: "search-session",
      agentTargetId: "local:codex",
      cwd: "/workspace",
      latestTurnInteractions: [],
      pendingInteractions: [],
      provider: "codex",
      railSectionKey: "conversations",
      title: "Search session",
      updatedAtUnixMs: 1,
      workspaceId: "test-workspace"
    });
    const engine = createTestAgentSessionEngine();
    let scheduledSearch: (() => void) | null = null;
    let sectionRequestCount = 0;
    let searchRequestCount = 0;
    const controller = new AgentGUIConversationRailQueryController({
      engine,
      getActiveConversationId: () => null,
      runtime: {
        listPinnedSessionsPage: async () => ({
          hasMore: false,
          sessions: [{ ...session, pinnedAtUnixMs: 10, updatedAtUnixMs: 2 }],
          totalCount: 1
        }),
        listSessionSectionPage: async (input) => ({
          hasMore: false,
          kind: "conversations",
          sectionKey: input.sectionKey,
          sessions: [],
          totalCount: 0
        }),
        listSessionSections: async (input) => {
          sectionRequestCount += 1;
          return {
            pinned:
              sectionRequestCount > 1
                ? {
                    hasMore: false,
                    sessions: [
                      { ...session, pinnedAtUnixMs: 10, updatedAtUnixMs: 2 }
                    ],
                    totalCount: 1
                  }
                : undefined,
            sections: [
              {
                hasMore: false,
                kind: "conversations",
                sectionKey: "conversations",
                sessions: sectionRequestCount > 1 ? [] : [session],
                totalCount: sectionRequestCount > 1 ? 0 : 1
              }
            ],
            workspaceId: input.workspaceId
          };
        },
        listSessionsPage: async (input) => {
          searchRequestCount += 1;
          if (searchRequestCount === 2) {
            return new Promise((_resolve, reject) => {
              input.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true }
              );
            });
          }
          return {
            hasMore: false,
            sessions: [],
            workspaceId: input.workspaceId
          };
        }
      },
      scheduler: {
        schedule: (_delayMs, task) => {
          scheduledSearch = task;
          return { cancel: () => undefined };
        }
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
    controller.setSearchQuery("session");
    (scheduledSearch as (() => void) | null)?.();
    await vi.waitFor(() => expect(searchRequestCount).toBe(1));
    await vi.waitFor(() =>
      expect(controller.getSnapshot().railSearch.pending).toBe(false)
    );

    engine.dispatch({
      session: {
        ...session,
        title: "Renamed search session",
        updatedAtUnixMs: 2
      },
      type: "session/upserted"
    });
    await vi.waitFor(() => expect(searchRequestCount).toBe(2));
    detach();
    expect(controller.isInteractionLocked()).toBe(true);

    const detachAgain = controller.attach();
    await vi.waitFor(() => expect(searchRequestCount).toBe(3));
    await vi.waitFor(() =>
      expect(controller.isInteractionLocked()).toBe(false)
    );

    detachAgain();
    engine.dispose();
  });
});
