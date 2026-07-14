import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { useAgentConversationMessagePaging } from "./useAgentConversationMessagePaging";

describe("useAgentConversationMessagePaging", () => {
  it("loads uncached detail through one combined reconcile", () => {
    const reconcileDetail = vi.fn();
    const { result } = renderHook(() =>
      useAgentConversationMessagePaging({
        diagnostics: { error: vi.fn(), page: vi.fn() },
        getActiveSessionId: () => "historical-session",
        getCanonicalMessages: () => [],
        isMounted: () => true,
        projection: {
          maxVersion: () => null,
          minVersion: () => null,
          windowHasTurnMissingUserPrompt: () => false
        },
        reload: {
          getActivationStatus: () => null,
          reconcileDetail,
          syncConversationList: vi.fn()
        },
        runtime: {} as AgentActivityRuntime,
        sessionViewRef: (agentSessionId) => ({
          agentSessionId,
          origin: "test",
          workspaceId: "workspace-1"
        }),
        view: {
          get: () => null,
          mergeOlder: vi.fn(),
          setOlderMessagesLoading: vi.fn()
        },
        workspaceId: "workspace-1"
      })
    );

    act(() => {
      void result.current.loadInitialMessages(" historical-session ");
    });

    expect(reconcileDetail).toHaveBeenCalledTimes(1);
    expect(reconcileDetail).toHaveBeenCalledWith("historical-session");
  });
});
