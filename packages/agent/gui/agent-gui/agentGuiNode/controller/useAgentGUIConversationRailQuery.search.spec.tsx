import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";
import {
  AgentActivityRuntimeProvider,
  type AgentActivityRuntime,
  type AgentActivityRuntimeListSessionsPageInput
} from "../../../agentActivityRuntime";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import { useAgentGUIConversationRailQuery } from "./useAgentGUIConversationRailQuery";

describe("useAgentGUIConversationRailQuery search", () => {
  it("searches every backend page and stores returned entities in the workspace engine", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    const calls: AgentActivityRuntimeListSessionsPageInput[] = [];
    const firstSession = searchSession("session-1", "backend first result", 2);
    const secondSession = searchSession("session-2", "backend older result", 1);
    const runtime = {
      getSessionEngine: () => engine,
      async listSessionsPage(input: AgentActivityRuntimeListSessionsPageInput) {
        calls.push(input);
        return input.cursor
          ? {
              hasMore: false,
              sessions: [secondSession],
              workspaceId: input.workspaceId
            }
          : {
              hasMore: true,
              nextCursor: "2|session-1",
              sessions: [firstSession],
              workspaceId: input.workspaceId
            };
      }
    } as unknown as AgentActivityRuntime;
    const wrapper = ({ children }: PropsWithChildren) => (
      <AgentActivityRuntimeProvider runtime={runtime}>
        {children}
      </AgentActivityRuntimeProvider>
    );

    const { result } = renderHook(
      () =>
        useAgentGUIConversationRailQuery({
          activeConversationId: null,
          conversationFilter: {
            agentTargetId: " target-1 ",
            kind: "agentTarget"
          },
          conversationQuery: " backend ",
          previewMode: false,
          sectionAgentTargetFallbackId: null,
          userProjects: [],
          workspaceId: "workspace-1"
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(calls).toHaveLength(1);
      expect(result.current.railSearch.sessionIds).toEqual(["session-1"]);
    });

    expect(calls[0]).toMatchObject({
      agentTargetId: "target-1",
      limit: 100,
      searchQuery: "backend",
      workspaceId: "workspace-1"
    });
    expect(result.current.railSearch.hasMore).toBe(true);
    expect(
      engine.getSnapshot().sessionLifecycle.sessionsById["session-1"]?.title
    ).toBe("backend first result");

    await act(async () => {
      result.current.railSearch.loadMore();
      await Promise.resolve();
    });

    expect(calls[1]).toMatchObject({
      cursor: "2|session-1",
      searchQuery: "backend",
      workspaceId: "workspace-1"
    });
    expect(result.current.railSearch.sessionIds).toEqual([
      "session-1",
      "session-2"
    ]);
    expect(result.current.railSearch.hasMore).toBe(false);
    expect(
      engine.getSnapshot().sessionLifecycle.sessionsById["session-2"]?.title
    ).toBe("backend older result");
  });

  it("exposes retry after an initial backend search failure", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    let requestCount = 0;
    const runtime = {
      getSessionEngine: () => engine,
      async listSessionsPage(input: AgentActivityRuntimeListSessionsPageInput) {
        requestCount += 1;
        if (requestCount === 1) throw new Error("search unavailable");
        return {
          hasMore: false,
          sessions: [searchSession("session-retried", "retried result", 1)],
          workspaceId: input.workspaceId
        };
      }
    } as unknown as AgentActivityRuntime;
    const wrapper = ({ children }: PropsWithChildren) => (
      <AgentActivityRuntimeProvider runtime={runtime}>
        {children}
      </AgentActivityRuntimeProvider>
    );
    const { result } = renderHook(
      () =>
        useAgentGUIConversationRailQuery({
          activeConversationId: null,
          conversationFilter: { kind: "all" },
          conversationQuery: "backend",
          previewMode: false,
          sectionAgentTargetFallbackId: null,
          userProjects: [],
          workspaceId: "workspace-1"
        }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.railSearch.failed).toBe(true));
    act(() => result.current.railSearch.retry());
    await waitFor(() =>
      expect(result.current.railSearch.sessionIds).toEqual(["session-retried"])
    );
    expect(result.current.railSearch.failed).toBe(false);
  });
});

function searchSession(
  agentSessionId: string,
  title: string,
  updatedAtUnixMs: number
) {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId,
    agentTargetId: "target-1",
    cwd: "/workspace",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    title,
    updatedAtUnixMs,
    workspaceId: "workspace-1"
  });
}
