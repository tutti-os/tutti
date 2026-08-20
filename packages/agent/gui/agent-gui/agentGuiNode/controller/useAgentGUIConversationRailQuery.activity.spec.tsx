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
  it("keeps child lifecycle out of root status while preserving descendant attention", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    engine.dispatch({
      type: "session/upserted",
      session: normalizeAgentActivitySession({
        activeTurnId: null,
        agentSessionId: "root",
        createdAtUnixMs: 1,
        cwd: "/workspace",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        title: "Root",
        updatedAtUnixMs: 1,
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
        status: "ready"
      })
    );
    expect(rendered.result.current.activityRootFacts.has("child")).toBe(false);
    expect(
      rendered.result.current.activityConversations.map(
        (conversation) => conversation.id
      )
    ).toEqual(["root"]);
    expect(rendered.result.current.activityConversations[0]).toMatchObject({
      id: "root",
      needsUserAction: false,
      status: "ready"
    });
    await waitFor(() =>
      expect(
        rendered.result.current.activityController.getSnapshot().available
      ).toBe(true)
    );
    act(() => {
      rendered.result.current.activityController.toggle();
    });
    expect(
      rendered.result.current.activityController.getSnapshot().activation
        ?.priority
    ).toEqual([]);

    const rootFactsBeforeChildLifecycleUpdate =
      rendered.result.current.activityRootFacts;
    const conversationsBeforeChildLifecycleUpdate =
      rendered.result.current.activityConversations;
    act(() => {
      engine.dispatch({
        live: true,
        type: "turn/upserted",
        turn: runningChildTurn(3)
      });
    });
    expect(rendered.result.current.activityRootFacts).toBe(
      rootFactsBeforeChildLifecycleUpdate
    );
    expect(rendered.result.current.activityConversations).toBe(
      conversationsBeforeChildLifecycleUpdate
    );

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
        status: "ready"
      })
    );
    expect(rendered.result.current.activityConversations[0]).toMatchObject({
      id: "root",
      needsUserAction: true,
      status: "ready"
    });
    await waitFor(() =>
      expect(
        rendered.result.current.activityController.getSnapshot().activation
          ?.priority
      ).toMatchObject([
        {
          id: "root",
          priorityReason: "waiting"
        }
      ])
    );

    act(() => {
      engine.dispatch({
        type: "session/upserted",
        session: normalizeAgentActivitySession({
          activeTurnId: "root-turn",
          agentSessionId: "root",
          createdAtUnixMs: 1,
          cwd: "/workspace",
          latestTurnInteractions: [],
          pendingInteractions: [],
          provider: "codex",
          title: "Root",
          updatedAtUnixMs: 4,
          workspaceId: "workspace-1"
        })
      });
      engine.dispatch({
        live: true,
        type: "turn/upserted",
        turn: {
          agentSessionId: "root",
          origin: "user_prompt",
          phase: "running",
          startedAtUnixMs: 4,
          turnId: "root-turn",
          updatedAtUnixMs: 4
        }
      });
    });
    await waitFor(() =>
      expect(rendered.result.current.activityRootFacts.get("root")).toEqual({
        needsUserAction: true,
        status: "working"
      })
    );

    rendered.unmount();
    engine.dispose();
  });

  it("projects Activity project identity from railSectionKey instead of cwd", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
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
          userProjects: [
            {
              id: "project-1",
              label: "Workspace",
              path: "/workspace",
              pinnedAtUnixMs: 0,
              sectionKey: "project:/workspace"
            }
          ],
          workspaceId: "workspace-1"
        }),
      { wrapper }
    );

    act(() => {
      engine.dispatch({
        type: "session/upserted",
        session: normalizeAgentActivitySession({
          activeTurnId: null,
          agentSessionId: "worktree-session",
          cwd: "/Users/local/.tutti/agent/worktrees/worktree-session",
          latestTurnInteractions: [],
          pendingInteractions: [],
          provider: "codex",
          railSectionKey: "project:/workspace",
          title: "Worktree session",
          workspaceId: "workspace-1"
        })
      });
    });

    await waitFor(() =>
      expect(rendered.result.current.activityConversations[0]).toEqual(
        expect.objectContaining({
          id: "worktree-session",
          project: expect.objectContaining({
            id: "project-1",
            sectionKey: "project:/workspace"
          })
        })
      )
    );

    act(() => {
      engine.dispatch({
        type: "session/upserted",
        session: normalizeAgentActivitySession({
          activeTurnId: null,
          agentSessionId: "worktree-session",
          cwd: "/workspace",
          latestTurnInteractions: [],
          pendingInteractions: [],
          provider: "codex",
          railSectionKey: "conversations",
          title: "Worktree session",
          workspaceId: "workspace-1"
        })
      });
    });

    await waitFor(() =>
      expect(
        rendered.result.current.activityConversations[0]?.project
      ).toBeNull()
    );

    rendered.unmount();
    engine.dispose();
  });

  it("keeps plan-implementation waiting on non-active conversations", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    engine.dispatch({
      type: "session/snapshotReceived",
      sessions: [
        normalizeAgentActivitySession({
          activeTurnId: null,
          agentSessionId: "plan-session",
          capabilities: {
            imageInput: false,
            modelImageInputRequired: false,
            modelPlanBinding: false,
            modelSwitch: false,
            skills: false,
            compact: false,
            tokenUsage: false,
            rateLimits: false,
            planMode: true,
            interrupt: false,
            activeTurnGuidance: false,
            browserUse: false,
            computerUse: false,
            goalPause: false,
            planImplementation: true,
            permissionModeChangeDuringTurn: false,
            permissionModeChangeDeferred: false,
            review: false,
            resumeRunningTurn: false
          },
          cwd: "/workspace",
          latestTurn: {
            turnId: "turn-plan",
            agentSessionId: "plan-session",
            origin: "user_prompt",
            phase: "settled",
            outcome: "completed",
            startedAtUnixMs: 10,
            settledAtUnixMs: 20,
            updatedAtUnixMs: 20
          },
          latestTurnInteractions: [],
          pendingInteractions: [],
          provider: "codex",
          title: "Plan session",
          workspaceId: "workspace-1"
        }),
        normalizeAgentActivitySession({
          activeTurnId: null,
          agentSessionId: "other-session",
          cwd: "/workspace",
          latestTurnInteractions: [],
          pendingInteractions: [],
          provider: "codex",
          title: "Other session",
          workspaceId: "workspace-1"
        })
      ]
    });
    engine.dispatch({
      type: "message/snapshotReceived",
      messages: [
        {
          agentSessionId: "plan-session",
          kind: "message",
          messageId: "plan-message",
          occurredAtUnixMs: 20,
          payload: { messageKind: "plan" },
          role: "agent",
          turnId: "turn-plan",
          version: 1,
          workspaceId: "workspace-1"
        }
      ]
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
          activeConversationId: "other-session",
          conversationFilter: { kind: "all" },
          conversationQuery: "",
          userProjects: [],
          workspaceId: "workspace-1"
        }),
      { wrapper }
    );

    await waitFor(() =>
      expect(
        rendered.result.current.activityRootFacts.get("plan-session")
      ).toEqual({
        needsUserAction: true,
        status: "completed"
      })
    );
    expect(
      rendered.result.current.activityConversations.find(
        (conversation) => conversation.id === "plan-session"
      )
    ).toMatchObject({
      id: "plan-session",
      needsUserAction: true,
      status: "completed"
    });
    expect(
      rendered.result.current.activityRootFacts.get("other-session")
    ).toEqual({
      needsUserAction: false,
      status: "ready"
    });

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

function runningChildTurn(updatedAtUnixMs = 2): AgentActivityTurn {
  return {
    agentSessionId: "child",
    origin: "provider_initiated",
    phase: "running",
    startedAtUnixMs: 2,
    turnId: "child-turn",
    updatedAtUnixMs
  };
}
