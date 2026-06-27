import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../../../agentActivityRuntime";
import type { AgentHostAgentActivityStreamEvent } from "../../../../../shared/contracts/dto";
import {
  resetAgentActivityRuntimeForTests,
  setAgentActivityRuntimeForTests
} from "../../../../../agentActivityRuntime";
import {
  getAgentSessionView,
  resetAgentSessionViewStoreForTests,
  watchAgentSession
} from "./agentSessionViewStore";

describe("agentSessionViewStore", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetAgentSessionViewStoreForTests();
    resetAgentActivityRuntimeForTests();
  });

  it("coalesces streaming message updates before notifying watchers", () => {
    vi.useFakeTimers();
    let streamListener: ((event: unknown) => void) | undefined;
    const reportDiagnostic = vi.fn();
    setAgentActivityRuntimeForTests({
      reportDiagnostic,
      retainSessionEvents: () => () => {},
      subscribeSessionEvents: (_workspaceId, listener) => {
        streamListener = listener;
        return () => {};
      }
    } as Partial<AgentActivityRuntime> as AgentActivityRuntime);
    const receivedEventBatches: AgentHostAgentActivityStreamEvent[][] = [];

    const release = watchAgentSession(
      {
        workspaceId: "workspace-1",
        agentSessionId: "agent-session-1"
      },
      {
        onEvents: (events) => receivedEventBatches.push([...events])
      }
    );

    streamListener?.(
      messageUpdateEvent({
        messageId: "message-1",
        occurredAtUnixMs: 1717200001000,
        text: "Hel"
      })
    );
    streamListener?.(
      messageUpdateEvent({
        messageId: "message-1",
        occurredAtUnixMs: 1717200001010,
        text: "Hello"
      })
    );

    expect(receivedEventBatches).toEqual([]);
    vi.advanceTimersByTime(33);

    expect(receivedEventBatches).toHaveLength(1);
    const event = receivedEventBatches[0]?.[0];
    expect(event?.eventType).toBe("message_update");
    if (event?.eventType !== "message_update") {
      throw new Error("Expected a message update event");
    }
    expect(event.data.payload?.text).toBe("Hello");
    expect(
      getAgentSessionView({
        workspaceId: "workspace-1",
        agentSessionId: "agent-session-1"
      })?.lastEventAt
    ).toBe(1717200001010);
    expect(reportDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.session_view.message_update_batch_flushed",
        details: expect.objectContaining({
          coalescedCount: 1,
          incomingCount: 2
        })
      })
    );

    release();
  });

  it("delivers each message update flush once to batch watchers", () => {
    vi.useFakeTimers();
    let streamListener: ((event: unknown) => void) | undefined;
    setAgentActivityRuntimeForTests({
      retainSessionEvents: () => () => {},
      subscribeSessionEvents: (_workspaceId, listener) => {
        streamListener = listener;
        return () => {};
      }
    } as Partial<AgentActivityRuntime> as AgentActivityRuntime);
    const receivedEventBatches: AgentHostAgentActivityStreamEvent[][] = [];

    const release = watchAgentSession(
      {
        workspaceId: "workspace-1",
        agentSessionId: "agent-session-1"
      },
      {
        onEvents: (events) => receivedEventBatches.push([...events])
      }
    );

    streamListener?.(
      messageUpdateEvent({
        messageId: "message-1",
        occurredAtUnixMs: 1717200001000,
        text: "Hello"
      })
    );
    streamListener?.(
      messageUpdateEvent({
        messageId: "message-2",
        occurredAtUnixMs: 1717200001010,
        text: "there"
      })
    );

    vi.advanceTimersByTime(33);

    expect(receivedEventBatches).toHaveLength(1);
    expect(receivedEventBatches[0]?.map((event) => event.eventType)).toEqual([
      "message_update",
      "message_update"
    ]);
    expect(
      receivedEventBatches[0]?.map((event) =>
        event.eventType === "message_update" ? event.data.messageId : null
      )
    ).toEqual(["message-1", "message-2"]);

    release();
  });

  it("flushes pending message updates before state patches", () => {
    vi.useFakeTimers();
    let streamListener: ((event: unknown) => void) | undefined;
    setAgentActivityRuntimeForTests({
      retainSessionEvents: () => () => {},
      subscribeSessionEvents: (_workspaceId, listener) => {
        streamListener = listener;
        return () => {};
      }
    } as Partial<AgentActivityRuntime> as AgentActivityRuntime);
    const receivedEventBatches: AgentHostAgentActivityStreamEvent[][] = [];

    const release = watchAgentSession(
      {
        workspaceId: "workspace-1",
        agentSessionId: "agent-session-1"
      },
      {
        onEvents: (events) => receivedEventBatches.push([...events])
      }
    );

    streamListener?.(
      messageUpdateEvent({
        messageId: "message-1",
        occurredAtUnixMs: 1717200001000,
        text: "working"
      })
    );
    streamListener?.({
      eventType: "state_patch",
      data: {
        workspaceId: "workspace-1",
        agentSessionId: "agent-session-1",
        lifecycleStatus: "running",
        occurredAtUnixMs: 1717200001020
      }
    });

    expect(
      receivedEventBatches.map((events) =>
        events.map((event) => event.eventType)
      )
    ).toEqual([["message_update"], ["state_patch"]]);

    release();
  });

  it("does not request durable control-state refreshes for inline state patches", async () => {
    let streamListener: ((event: unknown) => void) | undefined;
    setAgentActivityRuntimeForTests({
      retainSessionEvents: () => () => {},
      subscribeSessionEvents: (_workspaceId, listener) => {
        streamListener = listener;
        return () => {};
      }
    } as Partial<AgentActivityRuntime> as AgentActivityRuntime);

    const release = watchAgentSession({
      workspaceId: "workspace-1",
      agentSessionId: "agent-session-1"
    });

    const listener = streamListener;
    expect(listener).toBeDefined();
    listener?.({
      eventType: "state_patch",
      data: {
        workspaceId: "workspace-1",
        agentSessionId: "agent-session-1",
        lifecycleStatus: "running",
        occurredAtUnixMs: 1717200001000
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const view = getAgentSessionView({
      workspaceId: "workspace-1",
      agentSessionId: "agent-session-1"
    });
    expect(view?.isLive).toBe(true);
    expect(view?.lastEventAt).toBe(1717200001000);

    release();
  });
});

function messageUpdateEvent(input: {
  messageId: string;
  occurredAtUnixMs: number;
  text: string;
}): AgentHostAgentActivityStreamEvent {
  return {
    eventType: "message_update",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "agent-session-1",
      messageId: input.messageId,
      seq: input.occurredAtUnixMs,
      turnId: `turn:${input.messageId}`,
      role: "assistant",
      kind: "message",
      status: "streaming",
      payload: {
        text: input.text
      },
      occurredAtUnixMs: input.occurredAtUnixMs
    }
  };
}
