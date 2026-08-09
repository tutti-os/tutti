import {
  normalizeAgentActivitySession,
  type AgentActivityTurn
} from "@tutti-os/agent-activity-core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AgentGUIRuntimeProvider,
  type AgentGUIRuntime
} from "../../../agentActivityRuntime";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import { useAgentGUIConversationRailQuery } from "./useAgentGUIConversationRailQuery";

describe("useAgentGUIConversationRailQuery Activity facts", () => {
  it("keeps child sessions hidden and aggregates their activity onto the root", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    engine.dispatch({
      type: "session/upserted",
      session: normalizeAgentActivitySession({
        activeTurnId: null,
        agentSessionId: "root",
        cwd: "/workspace",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        title: "Root",
        workspaceId: "workspace-1"
      })
    });
    engine.dispatch({
      type: "session/upserted",
      session: normalizeAgentActivitySession({
        activeTurnId: "child-turn",
        agentSessionId: "child",
        cwd: "/workspace",
        kind: "child",
        latestTurnInteractions: [],
        parentAgentSessionId: "root",
        parentToolCallId: "tool-1",
        parentTurnId: "root-turn",
        pendingInteractions: [],
        provider: "codex",
        rootAgentSessionId: "root",
        rootTurnId: "root-turn",
        title: "Child",
        workspaceId: "workspace-1"
      })
    });
    engine.dispatch({
      live: true,
      type: "turn/upserted",
      turn: runningChildTurn()
    });
    const runtime = {
      conversationActivityViewEnabled: true,
      getSessionEngine: () => engine
    } as unknown as AgentGUIRuntime;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AgentGUIRuntimeProvider runtime={runtime}>
        {children}
      </AgentGUIRuntimeProvider>
    );
    const rendered = renderHook(
      () =>
        useAgentGUIConversationRailQuery({
          activeConversationId: null,
          conversationFilter: { kind: "all" },
          conversationQuery: "",
          userProjects: [],
          workspaceId: "workspace-1"
        }),
      { wrapper }
    );

    await waitFor(() =>
      expect(rendered.result.current.activityRootFacts.get("root")).toEqual({
        needsUserAction: false,
        status: "working"
      })
    );
    expect(rendered.result.current.activityRootFacts.has("child")).toBe(false);
    expect(
      rendered.result.current.activityConversations.map(
        (conversation) => conversation.id
      )
    ).toEqual(["root"]);

    act(() => {
      engine.dispatch({
        type: "interaction/upserted",
        interaction: {
          agentSessionId: "child",
          createdAtUnixMs: 3,
          input: { question: "Approve child action?" },
          kind: "approval",
          requestId: "approval-1",
          status: "pending",
          turnId: "child-turn",
          updatedAtUnixMs: 3
        }
      });
    });
    await waitFor(() =>
      expect(rendered.result.current.activityRootFacts.get("root")).toEqual({
        needsUserAction: true,
        status: "waiting"
      })
    );

    rendered.unmount();
    engine.dispose();
  });

  it("returns the shared empty Activity facts when the host capability is disabled", () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    engine.dispatch({
      type: "session/upserted",
      session: normalizeAgentActivitySession({
        activeTurnId: "root-turn",
        agentSessionId: "root",
        cwd: "/workspace",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        title: "Root",
        workspaceId: "workspace-1"
      })
    });
    const runtime = {
      conversationActivityViewEnabled: false,
      getSessionEngine: () => engine
    } as unknown as AgentGUIRuntime;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AgentGUIRuntimeProvider runtime={runtime}>
        {children}
      </AgentGUIRuntimeProvider>
    );
    const rendered = renderHook(
      () =>
        useAgentGUIConversationRailQuery({
          activeConversationId: null,
          conversationFilter: { kind: "all" },
          conversationQuery: "",
          userProjects: [],
          workspaceId: "workspace-1"
        }),
      { wrapper }
    );

    expect(rendered.result.current.activityRootFacts).toEqual(new Map());

    rendered.unmount();
    engine.dispose();
  });
});

function runningChildTurn(): AgentActivityTurn {
  return {
    agentSessionId: "child",
    origin: "provider_initiated",
    phase: "running",
    startedAtUnixMs: 2,
    turnId: "child-turn",
    updatedAtUnixMs: 2
  };
}
