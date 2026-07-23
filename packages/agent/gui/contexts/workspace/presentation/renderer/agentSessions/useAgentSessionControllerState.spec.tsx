import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import { useAgentSessionControllerState } from "./useAgentSessionControllerState";

const ACTIVE_REF = {
  agentSessionId: "session-1",
  origin: "test",
  workspaceId: "workspace-1"
};

function message(version: number): AgentActivityMessage {
  return {
    agentSessionId: "session-1",
    kind: "text",
    messageId: `message-${version}`,
    occurredAtUnixMs: version,
    payload: {},
    role: "assistant",
    turnId: "turn-1",
    version
  };
}

describe("useAgentSessionControllerState", () => {
  it("uses the exact engine boundary instead of inferring history from message versions", () => {
    const { result } = renderHook(() =>
      useAgentSessionControllerState(
        ACTIVE_REF,
        [message(2), message(4)],
        false
      )
    );

    expect(result.current.activeSessionView).toMatchObject({
      hasOlderMessages: false,
      oldestLoadedVersion: 2
    });
  });

  it("keeps a terminal older page authoritative over the bounded canonical window", () => {
    const { result } = renderHook(() =>
      useAgentSessionControllerState(ACTIVE_REF, [message(446)], true)
    );

    expect(result.current.activeSessionView?.hasOlderMessages).toBe(true);

    act(() => {
      result.current.mergeAgentSessionViewOlderMessages(
        ACTIVE_REF,
        [message(1)],
        { hasOlderMessages: false }
      );
    });

    expect(result.current.activeSessionView).toMatchObject({
      hasOlderMessages: false,
      oldestLoadedVersion: 1
    });
  });
});
