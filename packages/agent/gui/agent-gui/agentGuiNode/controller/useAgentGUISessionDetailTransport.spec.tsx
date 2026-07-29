import { renderHook } from "@testing-library/react";
import type {
  AgentActivityMessage,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import type { PropsWithChildren, RefObject } from "react";
import { describe, expect, it } from "vitest";
import {
  AgentActivityRuntimeProvider,
  type AgentActivityRuntime
} from "../../../agentActivityRuntime";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import type { AgentGUINodeData } from "../../../types";
import { useAgentGUISessionDetailTransport } from "./useAgentGUISessionDetailTransport";

describe("useAgentGUISessionDetailTransport", () => {
  it("renders optimistic text without treating its version as history coverage", () => {
    const optimisticMessage = message();
    const runtime = createRuntime({
      sessionMessagesById: { "session-1": [optimisticMessage] }
    } as unknown as AgentActivitySnapshot);
    const wrapper = ({ children }: PropsWithChildren) => (
      <AgentActivityRuntimeProvider runtime={runtime}>
        {children}
      </AgentActivityRuntimeProvider>
    );
    const rendered = renderHook(
      () =>
        useAgentGUISessionDetailTransport({
          activeConversationId: "session-1",
          activeConversationIdRef: ref("session-1"),
          agentActivityRuntime: runtime,
          agentActivityRuntimeOrigin: "test",
          dataRef: ref({ provider: "codex" } as AgentGUINodeData),
          isMountedRef: ref(true),
          sessionEngine: createTestAgentSessionEngine("workspace-1"),
          sessionFamily: {
            childSessions: [],
            messagesBySessionId: {},
            pendingInteractions: [],
            rootSession: null
          },
          workspaceId: "workspace-1"
        }),
      { wrapper }
    );

    expect(rendered.result.current.activeSessionView).toBeNull();
    expect(rendered.result.current.resolveSessionMessages("session-1")).toEqual(
      [optimisticMessage]
    );
  });
});

function createRuntime(snapshot: AgentActivitySnapshot): AgentActivityRuntime {
  return {
    getSnapshot: () => snapshot,
    origin: "test",
    subscribe: () => () => {}
  } as unknown as AgentActivityRuntime;
}

function message(): AgentActivityMessage {
  return {
    agentSessionId: "session-1",
    kind: "text",
    messageId: "message-1",
    occurredAtUnixMs: 1,
    payload: { text: "streaming" },
    role: "assistant",
    status: "streaming",
    turnId: "turn-1",
    version: 0,
    workspaceId: "workspace-1"
  };
}

function ref<T>(current: T): RefObject<T> {
  return { current };
}
