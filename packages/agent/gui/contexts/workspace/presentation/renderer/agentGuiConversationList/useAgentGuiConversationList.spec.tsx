import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createAgentSessionEngine } from "@tutti-os/agent-activity-core";
import { createLocalAgentGUIAgentTarget } from "../../../../../agentTargets";
import { useAgentGuiConversationList } from "./useAgentGuiConversationList";

describe("useAgentGuiConversationList", () => {
  it("keeps the optimistic activation title until canonical title arrives", () => {
    const engine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: { execute: async () => ({}) },
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    const query = {
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex" as const,
      sessionOrigin: "test"
    };
    const { result } = renderHook(() =>
      useAgentGuiConversationList(engine, query)
    );

    act(() => {
      engine.dispatch({
        type: "activation/requested",
        agentSessionId: "session-1",
        agentTargetId: "local:codex",
        clientSubmitId: "submit-1",
        content: [{ type: "text", text: "test1" }],
        cwd: "/workspace",
        expiresAtUnixMs: 100,
        mode: "new",
        requestedAtUnixMs: 1,
        requestId: "activation-1",
        optimisticTitle: "test1",
        workspaceId: "workspace-1"
      });
    });

    expect(result.current?.conversations).toEqual([
      expect.objectContaining({
        id: "session-1",
        provider: "codex",
        title: "test1",
        titleFallback: null
      })
    ]);

    act(() => {
      engine.dispatch({
        type: "session/snapshotReceived",
        sessions: [
          {
            activeTurnId: null,
            agentSessionId: "session-1",
            createdAtUnixMs: 2,
            cwd: "/workspace",
            latestTurnInteractions: [],
            pendingInteractions: [],
            provider: "codex",
            title: "test1",
            updatedAtUnixMs: 2,
            workspaceId: "workspace-1"
          }
        ]
      });
    });

    expect(result.current?.conversations).toEqual([
      expect.objectContaining({
        id: "session-1",
        status: "working",
        title: "test1",
        titleFallback: null
      })
    ]);
  });

  it("projects canonical sessions and pending activation records without a list store", () => {
    const engine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: { execute: async () => ({}) },
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    const query = {
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex" as const,
      sessionOrigin: "test"
    };
    const { result } = renderHook(() =>
      useAgentGuiConversationList(engine, query)
    );

    act(() => {
      engine.dispatch({
        type: "activation/requested",
        agentSessionId: "session-1",
        agentTargetId: "local:codex",
        clientSubmitId: "submit-1",
        cwd: "/workspace",
        expiresAtUnixMs: 100,
        mode: "new",
        requestedAtUnixMs: 1,
        requestId: "activation-1",
        title: "Pending task",
        workspaceId: "workspace-1"
      });
    });
    expect(result.current?.conversations).toEqual([
      expect.objectContaining({
        id: "session-1",
        status: "working",
        title: "Pending task"
      })
    ]);

    act(() => {
      engine.dispatch({
        type: "session/snapshotReceived",
        sessions: [
          {
            ...{
              activeTurnId: null,
              latestTurnInteractions: [],
              pendingInteractions: []
            },
            agentSessionId: "session-1",
            createdAtUnixMs: 2,
            cwd: "/workspace",
            provider: "codex",
            title: "Durable task",
            updatedAtUnixMs: 2,
            workspaceId: "workspace-1"
          }
        ]
      });
    });
    expect(result.current?.conversations).toEqual([
      expect.objectContaining({ id: "session-1", title: "Durable task" })
    ]);
  });

  it("keeps concurrent pending activations ordered and replaces only the canonicalized row", () => {
    const engine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: { execute: async () => ({}) },
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    const query = {
      conversationFilter: { kind: "all" as const },
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex" as const,
      sessionOrigin: "test"
    };
    const targets = [
      createLocalAgentGUIAgentTarget("codex"),
      createLocalAgentGUIAgentTarget("claude-code")
    ];
    const { result } = renderHook(() =>
      useAgentGuiConversationList(engine, query, targets)
    );

    act(() => {
      engine.dispatch({
        type: "activation/requested",
        agentSessionId: "session-1",
        agentTargetId: "local:codex",
        clientSubmitId: "submit-1",
        cwd: "/workspace",
        expiresAtUnixMs: 100,
        mode: "new",
        requestedAtUnixMs: 10,
        requestId: "activation-1",
        title: "First",
        workspaceId: "workspace-1"
      });
      engine.dispatch({
        type: "activation/requested",
        agentSessionId: "session-2",
        agentTargetId: "local:claude-code",
        clientSubmitId: "submit-2",
        cwd: "/workspace",
        expiresAtUnixMs: 100,
        mode: "new",
        requestedAtUnixMs: 20,
        requestId: "activation-2",
        title: "Second",
        workspaceId: "workspace-1"
      });
    });

    expect(
      result.current?.conversations.map((conversation) => ({
        id: conversation.id,
        provider: conversation.provider,
        source: conversation.projectionSource
      }))
    ).toEqual([
      {
        id: "session-2",
        provider: "claude-code",
        source: "pending_activation"
      },
      {
        id: "session-1",
        provider: "codex",
        source: "pending_activation"
      }
    ]);

    act(() => {
      engine.dispatch({
        type: "session/snapshotReceived",
        sessions: [
          {
            activeTurnId: null,
            agentSessionId: "session-1",
            createdAtUnixMs: 30,
            cwd: "/workspace",
            latestTurnInteractions: [],
            pendingInteractions: [],
            provider: "codex",
            title: "First durable",
            updatedAtUnixMs: 30,
            workspaceId: "workspace-1"
          }
        ]
      });
    });

    expect(
      result.current?.conversations.map((conversation) => ({
        id: conversation.id,
        source: conversation.projectionSource,
        title: conversation.title
      }))
    ).toEqual([
      { id: "session-1", source: undefined, title: "First durable" },
      {
        id: "session-2",
        source: "pending_activation",
        title: "Second"
      }
    ]);
  });

  it("orders canonical sessions by latest turn start instead of update timestamps", () => {
    const engine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: { execute: async () => ({}) },
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    const query = {
      conversationFilter: { kind: "all" as const },
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex" as const,
      sessionOrigin: "test"
    };
    const { result } = renderHook(() =>
      useAgentGuiConversationList(engine, query)
    );

    act(() => {
      engine.dispatch({
        type: "session/snapshotReceived",
        sessions: [
          {
            activeTurnId: null,
            agentSessionId: "older-start-newer-update",
            createdAtUnixMs: 1_000,
            cwd: "/workspace",
            latestTurn: {
              agentSessionId: "older-start-newer-update",
              phase: "running",
              startedAtUnixMs: 2_000,
              turnId: "turn-older",
              updatedAtUnixMs: 9_000
            },
            latestTurnInteractions: [],
            pendingInteractions: [],
            provider: "codex",
            title: "Older turn",
            updatedAtUnixMs: 9_000,
            workspaceId: "workspace-1"
          },
          {
            activeTurnId: null,
            agentSessionId: "newer-start-older-update",
            createdAtUnixMs: 500,
            cwd: "/workspace",
            latestTurn: {
              agentSessionId: "newer-start-older-update",
              phase: "running",
              startedAtUnixMs: 3_000,
              turnId: "turn-newer",
              updatedAtUnixMs: 4_000
            },
            latestTurnInteractions: [],
            pendingInteractions: [],
            provider: "codex",
            title: "Newer turn",
            updatedAtUnixMs: 4_000,
            workspaceId: "workspace-1"
          }
        ]
      });
    });

    expect(
      result.current?.conversations.map((conversation) => ({
        id: conversation.id,
        sortTimeUnixMs: conversation.sortTimeUnixMs
      }))
    ).toEqual([
      { id: "newer-start-older-update", sortTimeUnixMs: 3_000 },
      { id: "older-start-newer-update", sortTimeUnixMs: 2_000 }
    ]);
  });
});
