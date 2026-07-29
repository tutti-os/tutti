import { act, renderHook } from "@testing-library/react";
import type {
  AgentActivityMessage,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import type { PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";
import {
  AgentActivityRuntimeProvider,
  useAgentActivitySessionMessages,
  type AgentActivityRuntime
} from "./agentActivityRuntime";

describe("useAgentActivitySessionMessages", () => {
  it("delivers projected streaming text without rendering an unrelated Session", () => {
    const messagesA = [message("session-a", "partial")];
    const messagesB = [message("session-b", "settled")];
    const store = createRuntimeStore(
      snapshot({ "session-a": messagesA, "session-b": messagesB })
    );
    const wrapper = ({ children }: PropsWithChildren) => (
      <AgentActivityRuntimeProvider runtime={store.runtime}>
        {children}
      </AgentActivityRuntimeProvider>
    );
    let rendersA = 0;
    let rendersB = 0;
    const renderedA = renderHook(
      () => {
        rendersA += 1;
        return useAgentActivitySessionMessages("workspace-1", ["session-a"]);
      },
      { wrapper }
    );
    renderHook(
      () => {
        rendersB += 1;
        return useAgentActivitySessionMessages("workspace-1", ["session-b"]);
      },
      { wrapper }
    );
    const initialRendersA = rendersA;
    const initialRendersB = rendersB;

    act(() => {
      store.publish(
        snapshot({
          "session-a": [message("session-a", "partial text")],
          "session-b": messagesB
        })
      );
    });

    expect(renderedA.result.current["session-a"]?.[0]?.payload.text).toBe(
      "partial text"
    );
    expect(rendersA).toBeGreaterThan(initialRendersA);
    expect(rendersB).toBe(initialRendersB);
  });

  it("subscribes to projected messages for child Sessions in the family", () => {
    const rootMessages = [message("root", "root text")];
    const store = createRuntimeStore(
      snapshot({
        root: rootMessages,
        child: [message("child", "child partial")]
      })
    );
    const wrapper = ({ children }: PropsWithChildren) => (
      <AgentActivityRuntimeProvider runtime={store.runtime}>
        {children}
      </AgentActivityRuntimeProvider>
    );
    const rendered = renderHook(
      () => useAgentActivitySessionMessages("workspace-1", ["root", "child"]),
      { wrapper }
    );

    act(() => {
      store.publish(
        snapshot({
          root: rootMessages,
          child: [message("child", "child partial text")]
        })
      );
    });

    expect(rendered.result.current.child?.[0]?.payload.text).toBe(
      "child partial text"
    );
  });
});

function createRuntimeStore(initial: AgentActivitySnapshot) {
  let current = initial;
  const listeners = new Set<() => void>();
  const runtime = {
    getSnapshot: () => current,
    origin: "test",
    subscribe(_workspaceId: string, listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  } as unknown as AgentActivityRuntime;
  return {
    publish(next: AgentActivitySnapshot) {
      current = next;
      for (const listener of listeners) listener();
    },
    runtime
  };
}

function snapshot(
  sessionMessagesById: Record<string, readonly AgentActivityMessage[]>
): AgentActivitySnapshot {
  return { sessionMessagesById } as AgentActivitySnapshot;
}

function message(agentSessionId: string, text: string): AgentActivityMessage {
  return {
    agentSessionId,
    kind: "text",
    messageId: `message-${agentSessionId}`,
    occurredAtUnixMs: 1,
    payload: { text },
    role: "assistant",
    sequence: 1,
    status: "streaming",
    turnId: "turn-1",
    version: 1,
    workspaceId: "workspace-1"
  };
}
