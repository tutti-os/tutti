import { describe, expect, it, vi } from "vitest";
import {
  createAgentSideConversationRuntime,
  type AgentSideConversationStreamEvent,
  type AgentSideConversationTransport
} from "./agentSideConversationController";
import { projectAgentSideConversationVM } from "./agentSideConversationViewProjection";

function projectedMessages(
  runtime: ReturnType<typeof createAgentSideConversationRuntime>,
  workspaceId = "workspace-1"
) {
  return (
    projectAgentSideConversationVM(
      runtime.getSnapshot(workspaceId).active!.projection
    )?.rows.flatMap((row) =>
      row.kind === "message"
        ? row.messages.map((message) => ({
            id: message.id,
            role: row.speaker,
            text: message.body
          }))
        : []
    ) ?? []
  );
}

function transportHarness() {
  let connectionState:
    | "connected"
    | "connecting"
    | "disconnected"
    | "disposed" = "connected";
  let listener: ((event: AgentSideConversationStreamEvent) => void) | null =
    null;
  let connectionListener:
    | ((
        state: "connected" | "connecting" | "disconnected" | "disposed"
      ) => void)
    | null = null;
  const transport: AgentSideConversationTransport = {
    resolveCapabilities: vi.fn(async () => ({
      supported: true,
      activeSourceTurn: true,
      ephemeral: true,
      hideInheritedTurns: true,
      modelBoundaryInjected: true
    })),
    open: vi.fn(async () => ({ status: "idle" })),
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    subscribe: vi.fn((next) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
    subscribeConnectionState: vi.fn((next) => {
      connectionListener = next;
      return () => {
        connectionListener = null;
      };
    }),
    getConnectionState: vi.fn(() => connectionState)
  };
  return {
    transport,
    publish(event: AgentSideConversationStreamEvent) {
      listener?.(event);
    },
    publishConnection(
      state: "connected" | "connecting" | "disconnected" | "disposed"
    ) {
      connectionState = state;
      connectionListener?.(state);
    }
  };
}

describe("AgentSideConversationController", () => {
  it("returns a stable empty snapshot before a Side opens", () => {
    const harness = transportHarness();
    const runtime = createAgentSideConversationRuntime(harness.transport);

    expect(runtime.getSnapshot("workspace-1")).toBe(
      runtime.getSnapshot("workspace-1")
    );
  });

  it("keeps open/send state in the transient store", async () => {
    const harness = transportHarness();
    const runtime = createAgentSideConversationRuntime(harness.transport);
    const opened = await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });

    await runtime.send({
      workspaceId: "workspace-1",
      sideAgentSessionId: opened.sideAgentSessionId,
      content: [{ type: "text", text: "question" }]
    });

    const snapshot = runtime.getSnapshot("workspace-1");
    expect(snapshot.active?.sourceAgentSessionId).toBe("source-1");
    expect(snapshot.active?.activeTurnId).toBeTruthy();
    expect(projectedMessages(runtime)).toMatchObject([
      { role: "user", text: "question" }
    ]);
    expect(harness.transport.send).toHaveBeenCalledOnce();
  });

  it("orders Side events independently and drops duplicates", async () => {
    const harness = transportHarness();
    const runtime = createAgentSideConversationRuntime(harness.transport);
    const unsubscribe = runtime.subscribe("workspace-1", () => {});
    const opened = await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });
    const event = (
      sequence: number,
      text: string
    ): AgentSideConversationStreamEvent => ({
      workspaceId: "workspace-1",
      sideAgentSessionId: opened.sideAgentSessionId,
      sourceAgentSessionId: "source-1",
      sequence,
      eventType: "message_delta",
      data: {
        messageId: "assistant-1",
        role: "assistant",
        turnId: "turn-1",
        content: { operation: "append_text", value: text }
      }
    });

    harness.publish(event(1, "Hel"));
    harness.publish(event(1, "duplicate"));
    harness.publish(event(2, "lo"));

    expect(projectedMessages(runtime)).toMatchObject([
      { id: "assistant-1", text: "Hello" }
    ]);
    expect(runtime.getSnapshot("workspace-1").active?.sequence).toBe(2);
    harness.publish({
      ...event(3, "corrected"),
      eventType: "message_delta",
      data: {
        messageId: "assistant-1",
        role: "assistant",
        turnId: "turn-1",
        content: { operation: "set", value: "corrected" }
      }
    });
    expect(projectedMessages(runtime)).toMatchObject([
      { id: "assistant-1", text: "corrected" }
    ]);
    unsubscribe();
  });

  it("preserves events that arrive while open is in flight", async () => {
    const harness = transportHarness();
    const runtime = createAgentSideConversationRuntime(harness.transport);
    runtime.subscribe("workspace-1", () => {});
    vi.mocked(harness.transport.open).mockImplementationOnce(async (input) => {
      harness.publish({
        workspaceId: input.workspaceId,
        sideAgentSessionId: input.sideAgentSessionId,
        sourceAgentSessionId: input.sourceAgentSessionId,
        sequence: 1,
        eventType: "message_delta",
        data: {
          messageId: "assistant-1",
          role: "assistant",
          turnId: "turn-1",
          content: { operation: "set", value: "live" }
        }
      });
      return { status: "idle" };
    });

    const opened = await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });

    expect(opened.sequence).toBe(1);
    expect(
      projectAgentSideConversationVM(opened.projection)?.rows.flatMap((row) =>
        row.kind === "message"
          ? row.messages.map((message) => ({
              id: message.id,
              text: message.body
            }))
          : []
      )
    ).toMatchObject([{ id: "assistant-1", text: "live" }]);
  });

  it("cleans a remote Side that commits after an in-flight disconnect", async () => {
    const harness = transportHarness();
    const runtime = createAgentSideConversationRuntime(harness.transport);
    let resolveOpen!: () => void;
    vi.mocked(harness.transport.open).mockImplementationOnce(
      () =>
        new Promise<{ status: string }>((resolve) => {
          resolveOpen = () => resolve({ status: "idle" });
        })
    );

    const opening = runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });
    await vi.waitFor(() => {
      expect(harness.transport.open).toHaveBeenCalledOnce();
    });
    harness.publishConnection("disconnected");
    resolveOpen();

    await expect(opening).rejects.toThrow(
      "Side conversation identity changed while opening."
    );
    expect(runtime.getSnapshot("workspace-1").active).toBeNull();
    expect(harness.transport.close).toHaveBeenCalledTimes(2);
  });

  it("reconciles a provider user update with the optimistic Side prompt", async () => {
    const harness = transportHarness();
    const runtime = createAgentSideConversationRuntime(harness.transport);
    runtime.subscribe("workspace-1", () => {});
    const opened = await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });
    await runtime.send({
      workspaceId: "workspace-1",
      sideAgentSessionId: opened.sideAgentSessionId,
      content: [{ type: "text", text: "question" }]
    });
    const turnId = runtime.getSnapshot("workspace-1").active?.activeTurnId;
    expect(turnId).toBeTruthy();
    if (!turnId) throw new Error("missing optimistic Side turn id");

    harness.publish({
      workspaceId: "workspace-1",
      sideAgentSessionId: opened.sideAgentSessionId,
      sourceAgentSessionId: "source-1",
      sequence: 1,
      eventType: "message_update",
      data: {
        messageId: "provider-user-1",
        role: "user",
        turnId,
        kind: "text",
        status: "completed",
        seq: 1,
        payload: { text: "question", content: "question" },
        occurredAtUnixMs: Date.now()
      }
    });

    expect(projectedMessages(runtime)).toMatchObject([
      { id: "provider-user-1", role: "user", text: "question" }
    ]);
  });

  it.each([
    {
      name: "sequence gap",
      sequence: 2,
      sourceAgentSessionId: "source-1"
    },
    {
      name: "source identity mismatch",
      sequence: 1,
      sourceAgentSessionId: "source-other"
    }
  ])("expires and closes on $name", async (eventInput) => {
    const harness = transportHarness();
    const runtime = createAgentSideConversationRuntime(harness.transport);
    runtime.subscribe("workspace-1", () => {});
    const opened = await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });

    harness.publish({
      workspaceId: "workspace-1",
      sideAgentSessionId: opened.sideAgentSessionId,
      sourceAgentSessionId: eventInput.sourceAgentSessionId,
      sequence: eventInput.sequence,
      eventType: "message_delta",
      data: {
        messageId: "assistant-invalid",
        role: "assistant",
        turnId: "turn-invalid",
        content: { operation: "set", value: "must not render" }
      }
    });

    expect(runtime.getSnapshot("workspace-1").active).toBeNull();
    expect(harness.transport.close).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sideAgentSessionId: opened.sideAgentSessionId
    });
    await Promise.resolve();
    const reopened = await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });
    expect(reopened.sideAgentSessionId).not.toBe(opened.sideAgentSessionId);
  });

  it("expires active Side state when the event connection disconnects", async () => {
    const harness = transportHarness();
    const runtime = createAgentSideConversationRuntime(harness.transport);
    runtime.subscribe("workspace-1", () => {});
    const opened = await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });

    harness.publishConnection("disconnected");

    expect(runtime.getSnapshot("workspace-1").active).toBeNull();
    harness.publish({
      workspaceId: "workspace-1",
      sideAgentSessionId: opened.sideAgentSessionId,
      sourceAgentSessionId: "source-1",
      sequence: 1,
      eventType: "state_patch",
      data: {
        lifecycleStatus: "working",
        currentPhase: "running",
        turnLifecycle: { activeTurnId: "late-turn" }
      }
    });
    expect(runtime.getSnapshot("workspace-1").active).toBeNull();
    expect(harness.transport.close).toHaveBeenCalledOnce();
    harness.publishConnection("connected");
    await Promise.resolve();
    const reopened = await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });
    expect(reopened.sideAgentSessionId).not.toBe(opened.sideAgentSessionId);
  });

  it("rejects open when the event stream is already disconnected", async () => {
    const harness = transportHarness();
    harness.publishConnection("disconnected");
    const runtime = createAgentSideConversationRuntime(harness.transport);

    await expect(
      runtime.open({
        workspaceId: "workspace-1",
        sourceAgentSessionId: "source-1"
      })
    ).rejects.toThrow("event_stream_unavailable");
    expect(harness.transport.open).not.toHaveBeenCalled();
  });

  it("re-samples connection state when disconnect happens before subscribe", async () => {
    const harness = transportHarness();
    const runtime = createAgentSideConversationRuntime(harness.transport);
    harness.publishConnection("disconnected");

    await expect(
      runtime.open({
        workspaceId: "workspace-1",
        sourceAgentSessionId: "source-1"
      })
    ).rejects.toThrow("event_stream_unavailable");
    expect(harness.transport.open).not.toHaveBeenCalled();
  });

  it("projects interaction and lifecycle patches without durable state", async () => {
    const harness = transportHarness();
    const runtime = createAgentSideConversationRuntime(harness.transport);
    runtime.subscribe("workspace-1", () => {});
    const opened = await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });

    harness.publish({
      workspaceId: "workspace-1",
      sideAgentSessionId: opened.sideAgentSessionId,
      sourceAgentSessionId: "source-1",
      sequence: 1,
      eventType: "state_patch",
      data: {
        lifecycleStatus: "working",
        currentPhase: "running",
        turnLifecycle: { activeTurnId: "turn-1" },
        interactionTransition: {
          requestId: "request-1",
          turnId: "turn-1",
          kind: "approval",
          status: "pending",
          toolName: "shell",
          input: { command: "git status" },
          metadata: {
            actions: [{ id: "allow", label: "Allow", semantic: "approve" }]
          }
        }
      }
    });

    expect(runtime.getSnapshot("workspace-1").active).toMatchObject({
      status: "running",
      activeTurnId: "turn-1",
      pendingInteraction: {
        requestId: "request-1",
        turnId: "turn-1",
        kind: "approval",
        actions: [{ id: "allow", label: "Allow", semantic: "approve" }]
      }
    });

    harness.publish({
      workspaceId: "workspace-1",
      sideAgentSessionId: opened.sideAgentSessionId,
      sourceAgentSessionId: "source-1",
      sequence: 2,
      eventType: "state_patch",
      data: {
        lifecycleStatus: "completed",
        turnLifecycle: { activeTurnId: null }
      }
    });
    expect(runtime.getSnapshot("workspace-1").active).toBeNull();
  });

  it("keeps a failed interactive request pending and projects an error", async () => {
    const harness = transportHarness();
    const runtime = createAgentSideConversationRuntime(harness.transport);
    runtime.subscribe("workspace-1", () => {});
    const opened = await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });
    harness.publish({
      workspaceId: "workspace-1",
      sideAgentSessionId: opened.sideAgentSessionId,
      sourceAgentSessionId: "source-1",
      sequence: 1,
      eventType: "state_patch",
      data: {
        lifecycleStatus: "working",
        turnLifecycle: { activeTurnId: "turn-1" },
        interactionTransition: {
          requestId: "request-1",
          turnId: "turn-1",
          kind: "approval",
          status: "pending",
          input: {},
          metadata: { actions: [] }
        }
      }
    });
    vi.mocked(harness.transport.respond).mockRejectedValueOnce(
      new Error("network unavailable")
    );

    await expect(
      runtime.respond({
        workspaceId: "workspace-1",
        sideAgentSessionId: opened.sideAgentSessionId,
        turnId: "turn-1",
        requestId: "request-1",
        optionId: "allow"
      })
    ).rejects.toThrow("network unavailable");
    expect(runtime.getSnapshot("workspace-1").active).toMatchObject({
      error: "side_interaction_failed",
      pendingInteraction: { requestId: "request-1" }
    });
  });

  it("rejects attachments before optimistic send", async () => {
    const harness = transportHarness();
    const runtime = createAgentSideConversationRuntime(harness.transport);
    const opened = await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });

    await expect(
      runtime.send({
        workspaceId: "workspace-1",
        sideAgentSessionId: opened.sideAgentSessionId,
        content: [{ type: "file", url: "file:///tmp/image.png" }]
      })
    ).rejects.toThrow("content_unsupported");
    expect(harness.transport.send).not.toHaveBeenCalled();
    expect(projectedMessages(runtime)).toEqual([]);
  });

  it("keeps a closing state visible until remote close settles", async () => {
    const harness = transportHarness();
    const runtime = createAgentSideConversationRuntime(harness.transport);
    const opened = await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });
    let resolveClose!: () => void;
    vi.mocked(harness.transport.close).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        })
    );

    const closePromise = runtime.close({
      workspaceId: "workspace-1",
      sideAgentSessionId: opened.sideAgentSessionId
    });

    expect(runtime.getSnapshot("workspace-1").active).toMatchObject({
      sideAgentSessionId: opened.sideAgentSessionId,
      status: "closing",
      error: null
    });
    expect(harness.transport.close).toHaveBeenCalledOnce();
    resolveClose();
    await closePromise;
    expect(runtime.getSnapshot("workspace-1").active).toBeNull();
  });

  it("retains failed close ownership and retries before the next open", async () => {
    const harness = transportHarness();
    const runtime = createAgentSideConversationRuntime(harness.transport);
    const opened = await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });
    vi.mocked(harness.transport.close)
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockResolvedValueOnce();

    await expect(
      runtime.close({
        workspaceId: "workspace-1",
        sideAgentSessionId: opened.sideAgentSessionId
      })
    ).rejects.toThrow("daemon unavailable");
    expect(runtime.getSnapshot("workspace-1").active).toMatchObject({
      sideAgentSessionId: opened.sideAgentSessionId,
      status: "error",
      error: "side_close_failed"
    });

    await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });
    expect(harness.transport.close).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      sideAgentSessionId: opened.sideAgentSessionId
    });
  });

  it("rejects reopen when the stream disconnects during tombstone cleanup", async () => {
    const harness = transportHarness();
    const runtime = createAgentSideConversationRuntime(harness.transport);
    const opened = await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });
    let resolveRetry!: () => void;
    vi.mocked(harness.transport.close)
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveRetry = resolve;
          })
      );

    await expect(
      runtime.close({
        workspaceId: "workspace-1",
        sideAgentSessionId: opened.sideAgentSessionId
      })
    ).rejects.toThrow("daemon unavailable");
    const reopen = runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });
    await vi.waitFor(() => {
      expect(harness.transport.close).toHaveBeenCalledTimes(2);
    });
    harness.publishConnection("disconnected");
    resolveRetry();

    await expect(reopen).rejects.toThrow("event_stream_unavailable");
    expect(harness.transport.open).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot("workspace-1").active).toBeNull();
  });
});
