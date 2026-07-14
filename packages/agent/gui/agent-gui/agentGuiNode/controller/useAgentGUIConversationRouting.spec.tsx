import { renderHook } from "@testing-library/react";
import { createAgentSessionEngine } from "@tutti-os/agent-activity-core";
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
});
