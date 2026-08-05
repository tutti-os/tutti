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
