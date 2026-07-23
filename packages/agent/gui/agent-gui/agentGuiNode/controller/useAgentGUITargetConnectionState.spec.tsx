import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentGUITargetConnectionSource,
  AgentGUITargetConnectionState
} from "../../../types";
import { AGENT_GUI_TARGET_CONNECTING_NOTICE_DELAY_MS } from "./AgentGUITargetConnectionController";
import { useAgentGUITargetConnectionState } from "./useAgentGUITargetConnectionState";

class FakeTargetConnectionSource implements AgentGUITargetConnectionSource {
  private readonly listeners = new Set<() => void>();
  private readonly states = new Map<string, AgentGUITargetConnectionState>();

  getConnectionState(
    agentTargetId: string
  ): AgentGUITargetConnectionState | null {
    return this.states.get(agentTargetId) ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(agentTargetId: string, state: AgentGUITargetConnectionState): void {
    this.states.set(agentTargetId, state);
    for (const listener of this.listeners) listener();
  }
}

describe("useAgentGUITargetConnectionState", () => {
  afterEach(() => vi.useRealTimers());

  it("blocks a home composer immediately and delays only its connecting notice", () => {
    vi.useFakeTimers();
    const source = new FakeTargetConnectionSource();
    source.set("shared-agent:shared-1", {
      status: "connecting",
      retryAttempt: 0
    });
    const { result } = renderHook(() =>
      useAgentGUITargetConnectionState({
        agentTargetId: "shared-agent:shared-1",
        source
      })
    );

    expect(result.current).toEqual({ blocked: true, visibleState: null });
    act(() => {
      vi.advanceTimersByTime(AGENT_GUI_TARGET_CONNECTING_NOTICE_DELAY_MS);
    });
    expect(result.current).toEqual({
      blocked: true,
      visibleState: { status: "connecting", retryAttempt: 0 }
    });
  });

  it("reads unavailable from the exact selected target without a Session", () => {
    const source = new FakeTargetConnectionSource();
    source.set("shared-agent:shared-1", {
      status: "connected",
      retryAttempt: 0
    });
    source.set("shared-agent:shared-2", {
      status: "unavailable",
      retryAttempt: 0
    });

    const { result } = renderHook(() =>
      useAgentGUITargetConnectionState({
        agentTargetId: "shared-agent:shared-2",
        source
      })
    );

    expect(result.current).toEqual({
      blocked: true,
      visibleState: { status: "unavailable", retryAttempt: 0 }
    });
  });
});
