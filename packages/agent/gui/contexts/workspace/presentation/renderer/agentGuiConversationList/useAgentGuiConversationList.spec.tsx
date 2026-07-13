import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createAgentSessionEngine } from "@tutti-os/agent-activity-core";
import { useAgentGuiConversationList } from "./useAgentGuiConversationList";

describe("useAgentGuiConversationList", () => {
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
});
