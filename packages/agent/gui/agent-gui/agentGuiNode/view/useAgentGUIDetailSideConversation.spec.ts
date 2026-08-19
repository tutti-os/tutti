// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  AgentSideConversationRuntimeProvider,
  type AgentSideCapabilities
} from "../../../agentSideConversationRuntime";
import {
  createAgentSideConversationRuntime,
  type AgentSideConversationTransport
} from "../../../agentSideConversationController";
import {
  appendAgentSidePromptToDraft,
  parseAgentSideInvocation,
  useAgentGUIDetailSideConversation
} from "./useAgentGUIDetailSideConversation";

describe("parseAgentSideInvocation", () => {
  it("extracts a text-only Side prompt", () => {
    expect(
      parseAgentSideInvocation([{ type: "text", text: "/side inspect this" }])
    ).toEqual({ prompt: "inspect this", contentSupported: true });
  });

  it("rejects the whole invocation when any attachment would be lost", () => {
    expect(
      parseAgentSideInvocation([
        { type: "text", text: "/side inspect this" },
        { type: "file", path: "/tmp/context.txt" }
      ])
    ).toEqual({ prompt: "inspect this", contentSupported: false });
  });

  it("does not intercept ordinary main-conversation input", () => {
    expect(
      parseAgentSideInvocation([{ type: "text", text: "continue main" }])
    ).toBeNull();
  });
});

describe("appendAgentSidePromptToDraft", () => {
  it("moves a main /side prompt into an empty running Side draft", () => {
    expect(
      appendAgentSidePromptToDraft([{ type: "text", text: "" }], "inspect this")
    ).toEqual([{ type: "text", text: "inspect this" }]);
  });

  it("preserves an existing Side draft when another prompt is redirected", () => {
    expect(
      appendAgentSidePromptToDraft(
        [{ type: "text", text: "existing question" }],
        "additional context"
      )
    ).toEqual([
      {
        type: "text",
        text: "existing question\nadditional context"
      }
    ]);
  });
});

describe("useAgentGUIDetailSideConversation lifecycle", () => {
  it("does not focus the main composer when no Side conversation is active", () => {
    const rendered = renderHook(() =>
      useAgentGUIDetailSideConversation({
        enabled: false,
        workspaceId: "workspace-1",
        sourceAgentSessionId: "source-1",
        provider: "codex",
        cwd: null,
        availableCommands: [],
        clearMainDraft: vi.fn(),
        submitPrompt: vi.fn()
      })
    );

    expect(rendered.result.current.focused).toBe(false);
  });

  it("leaves /side as ordinary main input when the developer flag is off", () => {
    const submitPrompt = vi.fn();
    const rendered = renderHook(() =>
      useAgentGUIDetailSideConversation({
        enabled: false,
        workspaceId: "workspace-1",
        sourceAgentSessionId: "source-1",
        provider: "codex",
        cwd: null,
        availableCommands: [{ name: "side" }, { name: "status" }],
        clearMainDraft: vi.fn(),
        submitPrompt
      })
    );

    act(() => {
      rendered.result.current.submitMain(
        [{ type: "text", text: "/side keep this in main" }],
        "/side keep this in main"
      );
    });

    expect(rendered.result.current.commands).toEqual([{ name: "status" }]);
    expect(submitPrompt).toHaveBeenCalledOnce();
  });

  it("hides /side while capability resolution is pending", () => {
    const transport: AgentSideConversationTransport = {
      resolveCapabilities: vi.fn(
        () => new Promise<AgentSideCapabilities>(() => {})
      ),
      open: vi.fn(async () => ({ status: "idle" })),
      send: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      respond: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      subscribeConnectionState: vi.fn(() => () => {}),
      getConnectionState: vi.fn(() => "connected" as const)
    };
    const runtime = createAgentSideConversationRuntime(transport);
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(
        AgentSideConversationRuntimeProvider,
        { runtime },
        children
      );

    const rendered = renderHook(
      () =>
        useAgentGUIDetailSideConversation({
          workspaceId: "workspace-1",
          sourceAgentSessionId: "source-1",
          provider: "codex",
          cwd: null,
          availableCommands: [],
          clearMainDraft: vi.fn(),
          submitPrompt: vi.fn()
        }),
      { wrapper }
    );

    expect(rendered.result.current.commands).toEqual([]);

    rendered.unmount();
    runtime.dispose();
  });

  it("hides a provider-advertised /side when Side is unsupported", async () => {
    const transport: AgentSideConversationTransport = {
      resolveCapabilities: vi.fn(async () => ({
        supported: false,
        activeSourceTurn: false,
        ephemeral: false,
        hideInheritedTurns: false,
        modelBoundaryInjected: false
      })),
      open: vi.fn(async () => ({ status: "idle" })),
      send: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      respond: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      subscribeConnectionState: vi.fn(() => () => {}),
      getConnectionState: vi.fn(() => "connected" as const)
    };
    const runtime = createAgentSideConversationRuntime(transport);
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(
        AgentSideConversationRuntimeProvider,
        { runtime },
        children
      );

    const rendered = renderHook(
      () =>
        useAgentGUIDetailSideConversation({
          workspaceId: "workspace-1",
          sourceAgentSessionId: "source-1",
          provider: "claude-code",
          cwd: null,
          availableCommands: [{ name: "side" }, { name: "status" }],
          clearMainDraft: vi.fn(),
          submitPrompt: vi.fn()
        }),
      { wrapper }
    );

    await act(async () => undefined);

    expect(rendered.result.current.commands).toEqual([{ name: "status" }]);

    rendered.unmount();
    runtime.dispose();
  });

  it("never sends an unavailable /side invocation to the main conversation", async () => {
    const submitPrompt = vi.fn();
    const clearMainDraft = vi.fn();
    const transport: AgentSideConversationTransport = {
      resolveCapabilities: vi.fn(async () => ({
        supported: false,
        activeSourceTurn: false,
        ephemeral: false,
        hideInheritedTurns: false,
        modelBoundaryInjected: false
      })),
      open: vi.fn(async () => ({ status: "idle" })),
      send: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      respond: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      subscribeConnectionState: vi.fn(() => () => {}),
      getConnectionState: vi.fn(() => "connected" as const)
    };
    const runtime = createAgentSideConversationRuntime(transport);
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(
        AgentSideConversationRuntimeProvider,
        { runtime },
        children
      );
    const rendered = renderHook(
      () =>
        useAgentGUIDetailSideConversation({
          workspaceId: "workspace-1",
          sourceAgentSessionId: "source-1",
          provider: "codex",
          cwd: null,
          availableCommands: [],
          clearMainDraft,
          submitPrompt
        }),
      { wrapper }
    );

    await act(async () => undefined);
    act(() => {
      rendered.result.current.submitMain(
        [{ type: "text", text: "/side keep this isolated" }],
        "/side keep this isolated"
      );
    });

    expect(submitPrompt).not.toHaveBeenCalled();
    expect(transport.open).not.toHaveBeenCalled();
    expect(clearMainDraft).not.toHaveBeenCalled();
    expect(rendered.result.current.entryError).toBe("operation_failed");

    rendered.unmount();
    runtime.dispose();
  });

  it("shows the opening Side immediately without repeating capability discovery", async () => {
    let finishOpen: (() => void) | null = null;
    const resolveCapabilities = vi.fn(async () => ({
      supported: true,
      activeSourceTurn: true,
      ephemeral: true,
      hideInheritedTurns: true,
      modelBoundaryInjected: true
    }));
    const transport: AgentSideConversationTransport = {
      resolveCapabilities,
      open: vi.fn(
        () =>
          new Promise<{ status: string }>((resolve) => {
            finishOpen = () => resolve({ status: "idle" });
          })
      ),
      send: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      respond: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      subscribeConnectionState: vi.fn(() => () => {}),
      getConnectionState: vi.fn(() => "connected" as const)
    };
    const runtime = createAgentSideConversationRuntime(transport);
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(
        AgentSideConversationRuntimeProvider,
        { runtime },
        children
      );
    const rendered = renderHook(
      () =>
        useAgentGUIDetailSideConversation({
          workspaceId: "workspace-1",
          sourceAgentSessionId: "source-1",
          provider: "codex",
          cwd: null,
          availableCommands: [],
          clearMainDraft: vi.fn(),
          submitPrompt: vi.fn()
        }),
      { wrapper }
    );

    await vi.waitFor(() => expect(rendered.result.current.canOpen).toBe(true));
    act(() => {
      rendered.result.current.submitMain(
        [{ type: "text", text: "/side" }],
        "/side"
      );
    });

    await vi.waitFor(() =>
      expect(rendered.result.current.active?.status).toBe("opening")
    );
    expect(resolveCapabilities).toHaveBeenCalledOnce();
    expect(transport.open).toHaveBeenCalledOnce();

    await act(async () => finishOpen?.());
    await vi.waitFor(() =>
      expect(rendered.result.current.active?.status).toBe("idle")
    );
    rendered.unmount();
    runtime.dispose();
  });

  it("keeps a Side alive while the selected source Session changes", async () => {
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
      subscribe: vi.fn(() => () => {}),
      subscribeConnectionState: vi.fn((listener) => {
        connectionListener = listener;
        return () => {
          if (connectionListener === listener) connectionListener = null;
        };
      }),
      getConnectionState: vi.fn(() => "connected" as const)
    };
    const runtime = createAgentSideConversationRuntime(transport);
    const opened = await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });
    const clearMainDraft = vi.fn();
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(
        AgentSideConversationRuntimeProvider,
        { runtime },
        children
      );

    const rendered = renderHook(
      ({ sourceAgentSessionId }: { sourceAgentSessionId: string }) =>
        useAgentGUIDetailSideConversation({
          workspaceId: "workspace-1",
          sourceAgentSessionId,
          provider: "codex",
          cwd: null,
          availableCommands: [],
          clearMainDraft,
          submitPrompt: vi.fn()
        }),
      {
        initialProps: { sourceAgentSessionId: "source-1" },
        wrapper
      }
    );

    await act(async () => undefined);
    await act(async () => {
      rendered.result.current.submitMain(
        [{ type: "text", text: "/side inspect this" }],
        "inspect this"
      );
    });
    await vi.waitFor(() => expect(clearMainDraft).toHaveBeenCalledOnce());
    rendered.rerender({ sourceAgentSessionId: "source-2" });
    await act(async () => undefined);

    expect(transport.close).not.toHaveBeenCalled();
    expect(runtime.getSnapshot("workspace-1").active).toMatchObject({
      sideAgentSessionId: opened.sideAgentSessionId,
      sourceAgentSessionId: "source-1"
    });

    rendered.unmount();
    runtime.dispose();
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledOnce());
    expect(connectionListener).toBeNull();
  });
});
