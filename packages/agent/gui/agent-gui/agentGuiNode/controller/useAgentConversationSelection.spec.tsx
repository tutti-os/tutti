import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentGUINodeData } from "../../../types";
import { useAgentConversationSelection } from "./useAgentConversationSelection";

describe("useAgentConversationSelection", () => {
  it("reconciles detail when a selected rail session has no cached messages", () => {
    const active = { current: "recent-session" as string | null };
    const markPending = vi.fn();
    const reload = vi.fn();
    const setLoading = vi.fn();
    const { result } = renderHook(() =>
      useAgentConversationSelection({
        activation: {
          forget: vi.fn(),
          getPendingSessionId: () => null
        },
        conversations: { contains: () => true },
        detail: {
          hasRenderableMessages: () => false,
          markPending,
          reload,
          setLoading
        },
        hasConversationListQuery: () => true,
        isMounted: () => true,
        onMissingConversationListQuery: vi.fn(),
        persistence: { update: vi.fn() },
        selection: {
          clearDetailError: vi.fn(),
          getActiveSessionId: () => active.current,
          setActiveSessionId: (agentSessionId) => {
            active.current = agentSessionId;
          },
          setComposerHome: vi.fn(),
          setIntent: vi.fn()
        }
      })
    );

    act(() => result.current.selectConversation("historical-session"));

    expect(markPending).toHaveBeenCalledWith("historical-session");
    expect(setLoading).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledWith("historical-session", {
      reloadConversations: true,
      reloadDetail: true
    });
  });

  it("reuses cached detail when selecting another hydrated session", () => {
    const active = { current: "session-1" as string | null };
    const reload = vi.fn();
    const setLoading = vi.fn();
    const data: AgentGUINodeData = {
      agentTargetId: null,
      lastActiveAgentSessionId: active.current,
      provider: "codex"
    };
    const { result } = renderHook(() =>
      useAgentConversationSelection({
        activation: {
          forget: vi.fn(),
          getPendingSessionId: () => null
        },
        conversations: { contains: () => true },
        detail: {
          hasRenderableMessages: () => true,
          markPending: vi.fn(),
          reload,
          setLoading
        },
        hasConversationListQuery: () => true,
        isMounted: () => true,
        onMissingConversationListQuery: vi.fn(),
        persistence: {
          update: (updater) => {
            updater(data);
          }
        },
        selection: {
          clearDetailError: vi.fn(),
          getActiveSessionId: () => active.current,
          setActiveSessionId: (agentSessionId) => {
            active.current = agentSessionId;
          },
          setComposerHome: vi.fn(),
          setIntent: vi.fn()
        }
      })
    );

    act(() => result.current.selectConversation("session-2"));

    expect(setLoading).toHaveBeenCalledWith(false);
    expect(reload).toHaveBeenCalledWith("session-2", {
      reloadConversations: true,
      reloadDetail: false
    });
  });
});
