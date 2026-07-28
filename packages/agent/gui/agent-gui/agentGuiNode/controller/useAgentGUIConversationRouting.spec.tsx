import { renderHook } from "@testing-library/react";
import {
  createAgentSessionEngine,
  selectEngineSessionReconcile
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import { useAgentGUIConversationRouting } from "./useAgentGUIConversationRouting";

describe("useAgentGUIConversationRouting", () => {
  it("keeps an explicitly selected active session outside bounded rail state", () => {
    const sessionEngine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: { execute: async () => undefined },
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    const selectConversation = vi.fn();
    const setIntent = vi.fn();

    renderHook(() =>
      useAgentGUIConversationRouting({
        activeConversationIdRef: { current: "historical-session" },
        conversationListQuery: {},
        conversations: [],
        conversationsRef: { current: [] },
        handledOpenSessionSequenceRef: { current: null },
        hasLoadedConversations: true,
        intent: { tag: "active", id: "historical-session" },
        openSessionRequest: null,
        pendingOpenSessionRequestRef: { current: null },
        selectConversation,
        sessionEngine,
        setIntent,
        transientConversation: null,
        workspaceId: "workspace-1"
      })
    );

    expect(setIntent).not.toHaveBeenCalled();
    expect(selectConversation).not.toHaveBeenCalled();
  });

  it("reconciles a persisted selection outside the bounded list after restart", () => {
    const sessionEngine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: { execute: async () => undefined },
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    const selectConversation = vi.fn();
    const setIntent = vi.fn();

    renderHook(() =>
      useAgentGUIConversationRouting({
        activeConversationIdRef: { current: "persisted-session" },
        conversationListQuery: {},
        conversations: [],
        conversationsRef: { current: [] },
        handledOpenSessionSequenceRef: { current: null },
        hasLoadedConversations: true,
        intent: { tag: "requested", id: "persisted-session" },
        openSessionRequest: null,
        pendingOpenSessionRequestRef: { current: null },
        selectConversation,
        sessionEngine,
        setIntent,
        transientConversation: null,
        workspaceId: "workspace-1"
      })
    );

    expect(selectConversation).toHaveBeenCalledWith("persisted-session", {
      reloadConversations: false
    });
    expect(
      selectEngineSessionReconcile(
        sessionEngine.getSnapshot(),
        "persisted-session"
      )
    ).not.toBeNull();
    expect(setIntent).not.toHaveBeenCalled();
  });

  it.each(["active", "requested"] as const)(
    "does not restore a failed new activation from a stale %s intent",
    (intentTag) => {
      const sessionEngine = createAgentSessionEngine({
        clock: { nowUnixMs: () => 1 },
        commandPort: { execute: () => new Promise(() => {}) },
        identity: { origin: "test", workspaceId: "workspace-1" },
        scheduler: { schedule: () => ({ cancel() {} }) }
      });
      sessionEngine.dispatch({
        agentSessionId: "failed-session",
        agentTargetId: "target-1",
        clientSubmitId: "submit-1",
        content: [{ type: "text", text: "hello" }],
        cwd: "/workspace",
        expiresAtUnixMs: 45_001,
        mode: "new",
        requestedAtUnixMs: 1,
        requestId: "activation-1",
        type: "activation/requested",
        workspaceId: "workspace-1"
      });
      sessionEngine.dispatch({
        commandId: "activate:activation-1",
        commandType: "session/activate",
        correlationId: "activation-1",
        errorMessage: "Cursor failed to start.",
        outcome: "failed",
        type: "engine/commandResult"
      });
      const selectConversation = vi.fn();
      const setIntent = vi.fn();

      renderHook(() =>
        useAgentGUIConversationRouting({
          // Mirrors the earlier failure-settlement effect, which clears the
          // active ref before routing runs with the previous render's intent.
          activeConversationIdRef: { current: null },
          conversationListQuery: {},
          conversations: [],
          conversationsRef: { current: [] },
          handledOpenSessionSequenceRef: { current: null },
          hasLoadedConversations: true,
          intent: { tag: intentTag, id: "failed-session" },
          openSessionRequest: null,
          pendingOpenSessionRequestRef: { current: null },
          selectConversation,
          sessionEngine,
          setIntent,
          transientConversation: null,
          workspaceId: "workspace-1"
        })
      );

      expect(setIntent).toHaveBeenCalledOnce();
      expect(setIntent).toHaveBeenCalledWith({ tag: "home" });
      expect(selectConversation).not.toHaveBeenCalled();
      expect(
        selectEngineSessionReconcile(
          sessionEngine.getSnapshot(),
          "failed-session"
        )
      ).toBeNull();
    }
  );
});
