import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  AgentGUIInteractionReadiness,
  AgentGUIInteractionReadinessIdentity,
  AgentGUIInteractionReadinessSource
} from "../../../types";
import { useAgentGUIInteractionReadiness } from "./useAgentGUIInteractionReadiness";

class FakeInteractionReadinessSource implements AgentGUIInteractionReadinessSource {
  private readonly listeners = new Set<() => void>();
  private state: AgentGUIInteractionReadiness | null = null;

  getInteractionReadiness(
    _identity: AgentGUIInteractionReadinessIdentity
  ): AgentGUIInteractionReadiness | null {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(state: AgentGUIInteractionReadiness): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

describe("useAgentGUIInteractionReadiness", () => {
  it("fails closed until the supplied Host source publishes the exact record", () => {
    const source = new FakeInteractionReadinessSource();
    const identity = {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      turnId: "turn-1",
      requestId: "request-1"
    };
    const rendered = renderHook(() =>
      useAgentGUIInteractionReadiness({ identity, source })
    );

    expect(rendered.result.current).toEqual({
      status: "blocked",
      reason: "synchronizing"
    });

    act(() => source.set({ status: "ready" }));

    expect(rendered.result.current).toEqual({ status: "ready" });
  });

  it("does not add a gate when the Host omits the capability", () => {
    const rendered = renderHook(() =>
      useAgentGUIInteractionReadiness({
        identity: {
          workspaceId: "workspace-1",
          agentSessionId: "session-1",
          turnId: "turn-1",
          requestId: "request-1"
        },
        source: null
      })
    );

    expect(rendered.result.current).toBeNull();
  });

  it("fails closed when a presented interaction has no resolvable identity", () => {
    const source = new FakeInteractionReadinessSource();
    const rendered = renderHook(() =>
      useAgentGUIInteractionReadiness({
        identity: null,
        required: true,
        source
      })
    );

    expect(rendered.result.current).toEqual({
      status: "blocked",
      reason: "synchronizing"
    });
  });
});
