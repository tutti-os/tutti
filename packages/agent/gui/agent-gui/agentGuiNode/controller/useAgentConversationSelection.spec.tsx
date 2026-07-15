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
          isPending: () => false
        },
        conversations: { contains: () => true },
        detail: {
          isHydrated: () => false,
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
    const markPending = vi.fn();
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
          isPending: () => false
        },
        conversations: { contains: () => true },
        detail: {
          isHydrated: () => true,
          markPending,
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
    expect(markPending).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledWith("session-2", {
      reloadConversations: true,
      reloadDetail: false
    });
  });

  it("selects an optimistic pending session without reloading durable detail", () => {
    const active = { current: "session-b" as string | null };
    const reload = vi.fn();
    const setLoading = vi.fn();
    const setIntent = vi.fn();
    const { result } = renderHook(() =>
      useAgentConversationSelection({
        activation: {
          forget: vi.fn(),
          isPending: (agentSessionId) => agentSessionId === "session-a"
        },
        conversations: { contains: () => true },
        detail: {
          isHydrated: () => false,
          markPending: vi.fn(),
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
          setIntent
        }
      })
    );

    act(() => result.current.selectConversation("session-a"));

    expect(active.current).toBe("session-a");
    expect(setIntent).toHaveBeenCalledWith({
      tag: "active",
      id: "session-a"
    });
    expect(setLoading).toHaveBeenCalledWith(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
