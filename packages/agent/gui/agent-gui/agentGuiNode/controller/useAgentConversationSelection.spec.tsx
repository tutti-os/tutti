import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentGUINodeData } from "../../../types";
import { useAgentConversationSelection } from "./useAgentConversationSelection";

describe("useAgentConversationSelection", () => {
  it("reconciles detail when a selected rail session has no cached messages", () => {
    const active = { current: "recent-session" as string | null };
    const markPending = vi.fn();
    const ensureHydrated = vi.fn();
    const setLoading = vi.fn();
    const requestReveal = vi.fn();
    const hasConversationListQuery = vi.fn(() => true);
    const { result } = renderHook(() =>
      useAgentConversationSelection({
        activation: {
          canReload: () => true,
          forget: vi.fn(),
          isPending: () => false
        },
        conversations: {
          agentTargetIdFor: () => "local:codex",
          contains: () => true
        },
        detail: {
          ensureHydrated,
          isHydrated: () => false,
          markPending,
          setLoading
        },
        hasConversationListQuery,
        isMounted: () => true,
        onMissingConversationListQuery: vi.fn(),
        persistence: { update: vi.fn() },
        rail: {
          clearRevealRequest: vi.fn(),
          requestReveal
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

    act(() =>
      result.current.selectConversation("historical-session", {
        reveal: "external-open"
      })
    );

    expect(markPending).toHaveBeenCalledWith("historical-session");
    expect(setLoading).not.toHaveBeenCalled();
    expect(hasConversationListQuery).toHaveBeenCalledOnce();
    expect(ensureHydrated).toHaveBeenCalledWith("historical-session");
    expect(requestReveal).toHaveBeenCalledWith(
      "historical-session",
      "external-open"
    );
  });

  it("reuses cached detail when selecting another hydrated session", () => {
    const active = { current: "session-1" as string | null };
    const markPending = vi.fn();
    const ensureHydrated = vi.fn();
    const setLoading = vi.fn();
    const data: AgentGUINodeData = {
      agentTargetId: null,
      lastActiveAgentSessionId: active.current,
      provider: "codex"
    };
    const { result } = renderHook(() =>
      useAgentConversationSelection({
        activation: {
          canReload: () => true,
          forget: vi.fn(),
          isPending: () => false
        },
        conversations: {
          agentTargetIdFor: () => "local:codex",
          contains: () => true
        },
        detail: {
          ensureHydrated,
          isHydrated: () => true,
          markPending,
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
        rail: {
          clearRevealRequest: vi.fn(),
          requestReveal: vi.fn()
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
    expect(ensureHydrated).not.toHaveBeenCalled();
  });

  it("selects an optimistic pending session without reloading durable detail", () => {
    const active = { current: "session-b" as string | null };
    const ensureHydrated = vi.fn();
    const setLoading = vi.fn();
    const setIntent = vi.fn();
    const { result } = renderHook(() =>
      useAgentConversationSelection({
        activation: {
          canReload: () => true,
          forget: vi.fn(),
          isPending: (agentSessionId) => agentSessionId === "session-a"
        },
        conversations: {
          agentTargetIdFor: () => "local:codex",
          contains: () => true
        },
        detail: {
          ensureHydrated,
          isHydrated: () => false,
          markPending: vi.fn(),
          setLoading
        },
        hasConversationListQuery: () => true,
        isMounted: () => true,
        onMissingConversationListQuery: vi.fn(),
        persistence: { update: vi.fn() },
        rail: {
          clearRevealRequest: vi.fn(),
          requestReveal: vi.fn()
        },
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
    expect(ensureHydrated).not.toHaveBeenCalled();
  });

  it("does not reload Rail or detail for an activation that cannot reload", () => {
    const active = { current: "session-b" as string | null };
    const hasConversationListQuery = vi.fn(() => true);
    const ensureHydrated = vi.fn();
    const { result } = renderHook(() =>
      useAgentConversationSelection({
        activation: {
          canReload: () => false,
          forget: vi.fn(),
          isPending: () => false
        },
        conversations: {
          agentTargetIdFor: () => "local:codex",
          contains: () => true
        },
        detail: {
          ensureHydrated,
          isHydrated: () => false,
          markPending: vi.fn(),
          setLoading: vi.fn()
        },
        hasConversationListQuery,
        isMounted: () => true,
        onMissingConversationListQuery: vi.fn(),
        persistence: { update: vi.fn() },
        rail: {
          clearRevealRequest: vi.fn(),
          requestReveal: vi.fn()
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

    act(() => result.current.selectConversation("session-a"));

    expect(hasConversationListQuery).not.toHaveBeenCalled();
    expect(ensureHydrated).not.toHaveBeenCalled();
  });
});
