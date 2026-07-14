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
    const syncConversationListProjection = vi.fn(async () => {});

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
        previewMode: false,
        selectConversation,
        sessionEngine,
        setIntent,
        syncConversationListProjection,
        transientConversation: null,
        workspaceId: "workspace-1"
      })
    );

    expect(setIntent).not.toHaveBeenCalled();
    expect(selectConversation).not.toHaveBeenCalled();
    expect(syncConversationListProjection).not.toHaveBeenCalled();
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
    const syncConversationListProjection = vi.fn(async () => {});

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
        previewMode: false,
        selectConversation,
        sessionEngine,
        setIntent,
        syncConversationListProjection,
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
    expect(setIntent).not.toHaveBeenCalledWith({
      tag: "resolving",
      id: "persisted-session"
    });
    expect(syncConversationListProjection).not.toHaveBeenCalled();
  });
});
