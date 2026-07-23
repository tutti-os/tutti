import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentGUITargetConnectionSource,
  AgentGUITargetConnectionStatus
} from "../../../types";
import { AGENT_GUI_TARGET_CONNECTING_NOTICE_DELAY_MS } from "./AgentGUITargetConnectionController";
import { useAgentGUITargetConnectionState } from "./useAgentGUITargetConnectionState";

class FakeTargetConnectionSource implements AgentGUITargetConnectionSource {
  private readonly listeners = new Set<() => void>();
  private readonly statuses = new Map<string, AgentGUITargetConnectionStatus>();

  getConnectionStatus(
    agentTargetId: string
  ): AgentGUITargetConnectionStatus | null {
    return this.statuses.get(agentTargetId) ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(agentTargetId: string, status: AgentGUITargetConnectionStatus): void {
    this.statuses.set(agentTargetId, status);
    for (const listener of this.listeners) listener();
  }
}

describe("useAgentGUITargetConnectionState", () => {
  afterEach(() => vi.useRealTimers());

  it("blocks a home composer immediately and delays only its connecting notice", () => {
    vi.useFakeTimers();
    const source = new FakeTargetConnectionSource();
    source.set("shared-agent:shared-1", "connecting");
    const { result } = renderHook(() =>
      useAgentGUITargetConnectionState({
        agentTargetId: "shared-agent:shared-1",
        source
      })
    );

    expect(result.current).toEqual({ blocked: true, visibleStatus: null });
    act(() => {
      vi.advanceTimersByTime(AGENT_GUI_TARGET_CONNECTING_NOTICE_DELAY_MS);
    });
    expect(result.current).toEqual({
      blocked: true,
      visibleStatus: "connecting"
    });
  });

  it("reads unavailable from the exact selected target without a Session", () => {
    const source = new FakeTargetConnectionSource();
    source.set("shared-agent:shared-1", "connected");
    source.set("shared-agent:shared-2", "unavailable");

    const { result } = renderHook(() =>
      useAgentGUITargetConnectionState({
        agentTargetId: "shared-agent:shared-2",
        source
      })
    );

    expect(result.current).toEqual({
      blocked: true,
      visibleStatus: "unavailable"
    });
  });
});
