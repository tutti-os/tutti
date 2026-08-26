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
  type AgentSideConversationStreamEvent,
  type AgentSideConversationTransport
} from "../../../agentSideConversationController";
import {
  appendAgentSidePromptToDraft,
  parseAgentSideInvocation,
  useAgentGUIDetailSideConversation
} from "./useAgentGUIDetailSideConversation";
import { resolveSlashCommandSelectionEffect } from "../model/agentSlashCommandProviderPolicy";
import {
  agentComposerDraftQuotes,
  projectAgentComposerDraftSubmission,
  updateAgentComposerDraft
} from "../model/agentComposerDraft";

describe("parseAgentSideInvocation", () => {
  it("extracts a text-only Side prompt", () => {
    expect(
      parseAgentSideInvocation([{ type: "text", text: "/side inspect this" }])
    ).toEqual({
      prompt: "inspect this",
      contentSupported: true
    });
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
  it("projects the exact Side interaction identity into ask-user prompts", async () => {
    let publish: (event: AgentSideConversationStreamEvent) => void = () => {};
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
      subscribe: vi.fn((listener) => {
        publish = listener;
        return () => {
          publish = () => {};
        };
      }),
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
          workspaceId: "workspace-exact-question",
          sourceAgentSessionId: "source-exact-question",
          provider: "codex",
          cwd: null,
          availableCommands: [],
          clearMainDraft: vi.fn(),
          submitPrompt: vi.fn()
        }),
      { wrapper }
    );

    await vi.waitFor(() => expect(rendered.result.current.canOpen).toBe(true));
    await act(async () => {
      await rendered.result.current.open();
    });
    const sideAgentSessionId =
      rendered.result.current.active?.sideAgentSessionId;
    expect(sideAgentSessionId).toBeTruthy();

    act(() => {
      publish({
        workspaceId: "workspace-exact-question",
        sideAgentSessionId: sideAgentSessionId!,
        sourceAgentSessionId: "source-exact-question",
        sequence: 1,
        eventType: "state_patch",
        data: {
          lifecycleStatus: "working",
          turnLifecycle: { activeTurnId: "turn-exact-question" },
          interactionTransition: {
            requestId: "request-reused",
            turnId: "turn-exact-question",
            kind: "question",
            status: "pending",
            input: {
              questions: [
                {
                  id: "scope",
                  header: "Scope",
                  question: "Which scope?",
                  options: []
                }
              ]
            },
            metadata: { actions: [] }
          }
        }
      });
    });

    expect(rendered.result.current.interactivePrompt).toMatchObject({
      agentSessionId: sideAgentSessionId,
      kind: "ask-user",
      requestId: "request-reused",
      turnId: "turn-exact-question"
    });

    rendered.unmount();
    runtime.dispose();
  });

  it("submits Side on palette selection while preserving provider command effects", async () => {
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
          workspaceId: "workspace-immediate",
          sourceAgentSessionId: "source-immediate",
          provider: "codex",
          cwd: null,
          availableCommands: [{ name: "status" }],
          slashCommandPolicy: {
            fallbackCommands: ["status"],
            commandEffects: [{ command: "status", effect: "showStatus" }]
          },
          clearMainDraft: vi.fn(),
          submitPrompt: vi.fn()
        }),
      { wrapper }
    );

    await vi.waitFor(() => expect(rendered.result.current.canOpen).toBe(true));
    const sideCommand = rendered.result.current.commands.find(
      (command) => command.name === "side"
    );
    expect(sideCommand).toBeDefined();
    expect(
      resolveSlashCommandSelectionEffect({
        provider: "codex",
        policy: rendered.result.current.slashCommandPolicy,
        command: sideCommand!,
        currentDraft: "/"
      })
    ).toEqual({ kind: "submitPrompt", prompt: "/side" });
    expect(
      resolveSlashCommandSelectionEffect({
        provider: "codex",
        policy: rendered.result.current.slashCommandPolicy,
        command: { name: "status" },
        currentDraft: "/"
      })
    ).toEqual({ kind: "showStatus" });

    rendered.unmount();
    runtime.dispose();
  });

  it("stages selected transcript text in Side without sending until submit", async () => {
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
      ({ sourceAgentSessionId }: { sourceAgentSessionId: string }) =>
        useAgentGUIDetailSideConversation({
          workspaceId: "workspace-1",
          sourceAgentSessionId,
          provider: "codex",
          cwd: null,
          availableCommands: [],
          clearMainDraft: vi.fn(),
          submitPrompt: vi.fn()
        }),
      { initialProps: { sourceAgentSessionId: "source-1" }, wrapper }
    );

    await vi.waitFor(() => expect(rendered.result.current.canOpen).toBe(true));
    await act(async () => {
      await rendered.result.current.stageSelection("Selected answer text");
    });

    expect(transport.open).toHaveBeenCalledOnce();
    expect(transport.send).not.toHaveBeenCalled();
    expect(
      agentComposerDraftQuotes(rendered.result.current.draftContent)
    ).toEqual([expect.objectContaining({ text: "Selected answer text" })]);
    expect(rendered.result.current.focused).toBe(true);
    expect(rendered.result.current.focusRequestSequence).toBe(1);

    act(() => {
      rendered.result.current.setDraftContent(
        updateAgentComposerDraft(rendered.result.current.draftContent, {
          prompt: "What does this selection say?"
        })
      );
    });

    const submission = projectAgentComposerDraftSubmission({
      draft: rendered.result.current.draftContent,
      skills: []
    });
    act(() => {
      rendered.result.current.submitSide(
        submission.content,
        submission.displayPrompt
      );
    });
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledOnce());
    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [
          {
            type: "text",
            text: "What does this selection say?"
          },
          {
            type: "text",
            text: "> Selected answer text"
          }
        ],
        displayPrompt: "What does this selection say?"
      })
    );

    rendered.rerender({ sourceAgentSessionId: "source-2" });
    expect(rendered.result.current.focused).toBe(false);
    expect(rendered.result.current.canOpen).toBe(false);

    rendered.unmount();
    runtime.dispose();
  });

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

  it("rechecks /side support when the source runtime lifecycle changes", async () => {
    const resolveCapabilities = vi
      .fn<AgentSideConversationTransport["resolveCapabilities"]>()
      .mockResolvedValueOnce({
        supported: false,
        activeSourceTurn: false,
        ephemeral: false,
        hideInheritedTurns: false,
        modelBoundaryInjected: false
      })
      .mockResolvedValueOnce({
        supported: true,
        activeSourceTurn: true,
        ephemeral: true,
        hideInheritedTurns: true,
        modelBoundaryInjected: true
      });
    const transport: AgentSideConversationTransport = {
      resolveCapabilities,
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
      ({ capabilityRevision }: { capabilityRevision: string }) =>
        useAgentGUIDetailSideConversation({
          workspaceId: "workspace-1",
          sourceAgentSessionId: "source-1",
          provider: "codex",
          cwd: null,
          capabilityRevision,
          availableCommands: [],
          clearMainDraft: vi.fn(),
          submitPrompt: vi.fn()
        }),
      { initialProps: { capabilityRevision: "not-live" }, wrapper }
    );

    await vi.waitFor(() => expect(resolveCapabilities).toHaveBeenCalledOnce());
    expect(rendered.result.current.commands).toEqual([]);

    rendered.rerender({ capabilityRevision: "turn-1:running" });
    await vi.waitFor(() =>
      expect(rendered.result.current.commands).toEqual([
        expect.objectContaining({ name: "side" })
      ])
    );
    expect(resolveCapabilities).toHaveBeenCalledTimes(2);

    rendered.unmount();
    runtime.dispose();
  });

  it("rechecks a stale negative capability result when resubscribed", async () => {
    const resolveCapabilities = vi
      .fn<AgentSideConversationTransport["resolveCapabilities"]>()
      .mockResolvedValueOnce({
        supported: false,
        activeSourceTurn: false,
        ephemeral: false,
        hideInheritedTurns: false,
        modelBoundaryInjected: false
      })
      .mockResolvedValueOnce({
        supported: true,
        activeSourceTurn: true,
        ephemeral: true,
        hideInheritedTurns: true,
        modelBoundaryInjected: true
      });
    const transport: AgentSideConversationTransport = {
      resolveCapabilities,
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
    const firstRender = renderHook(
      () =>
        useAgentGUIDetailSideConversation({
          workspaceId: "workspace-retry",
          sourceAgentSessionId: "source-retry",
          provider: "codex",
          cwd: null,
          availableCommands: [],
          clearMainDraft: vi.fn(),
          submitPrompt: vi.fn()
        }),
      { wrapper }
    );

    await vi.waitFor(() => expect(resolveCapabilities).toHaveBeenCalledOnce());
    expect(firstRender.result.current.commands).toEqual([]);
    firstRender.unmount();

    const remounted = renderHook(
      () =>
        useAgentGUIDetailSideConversation({
          workspaceId: "workspace-retry",
          sourceAgentSessionId: "source-retry",
          provider: "codex",
          cwd: null,
          availableCommands: [],
          clearMainDraft: vi.fn(),
          submitPrompt: vi.fn()
        }),
      { wrapper }
    );
    await vi.waitFor(() =>
      expect(remounted.result.current.commands).toEqual([
        expect.objectContaining({ name: "side" })
      ])
    );
    expect(resolveCapabilities).toHaveBeenCalledTimes(2);

    remounted.unmount();
    runtime.dispose();
  });

  it("rechecks when reconnect arrives during the initial capability probe", async () => {
    const connectionListeners = new Set<
      (state: "connected" | "connecting" | "disconnected" | "disposed") => void
    >();
    let finishInitialProbe: (() => void) | null = null;
    const unsupported: AgentSideCapabilities = {
      supported: false,
      activeSourceTurn: false,
      ephemeral: false,
      hideInheritedTurns: false,
      modelBoundaryInjected: false
    };
    const supported: AgentSideCapabilities = {
      supported: true,
      activeSourceTurn: true,
      ephemeral: true,
      hideInheritedTurns: true,
      modelBoundaryInjected: true
    };
    const resolveCapabilities = vi
      .fn<AgentSideConversationTransport["resolveCapabilities"]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishInitialProbe = () => resolve(unsupported);
          })
      )
      .mockResolvedValueOnce(supported);
    const transport: AgentSideConversationTransport = {
      resolveCapabilities,
      open: vi.fn(async () => ({ status: "idle" })),
      send: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      respond: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      subscribeConnectionState: vi.fn((listener) => {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      }),
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
          workspaceId: "workspace-pending-reconnect",
          sourceAgentSessionId: "source-pending-reconnect",
          provider: "codex",
          cwd: null,
          availableCommands: [],
          clearMainDraft: vi.fn(),
          submitPrompt: vi.fn()
        }),
      { wrapper }
    );

    await vi.waitFor(() => expect(resolveCapabilities).toHaveBeenCalledOnce());
    act(() => connectionListeners.forEach((listener) => listener("connected")));
    await act(async () => finishInitialProbe?.());
    await vi.waitFor(() =>
      expect(rendered.result.current.commands).toEqual([
        expect.objectContaining({ name: "side" })
      ])
    );
    expect(resolveCapabilities).toHaveBeenCalledTimes(2);

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

  it("does not expose /side while a supported same-source Side is closing", async () => {
    let finishClose: (() => void) | null = null;
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
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishClose = resolve;
          })
      ),
      subscribe: vi.fn(() => () => {}),
      subscribeConnectionState: vi.fn(() => () => {}),
      getConnectionState: vi.fn(() => "connected" as const)
    };
    const runtime = createAgentSideConversationRuntime(transport);
    const opened = await runtime.open({
      workspaceId: "workspace-closing",
      sourceAgentSessionId: "source-closing"
    });
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(
        AgentSideConversationRuntimeProvider,
        { runtime },
        children
      );
    const rendered = renderHook(
      () =>
        useAgentGUIDetailSideConversation({
          workspaceId: "workspace-closing",
          sourceAgentSessionId: "source-closing",
          provider: "codex",
          cwd: null,
          availableCommands: [],
          clearMainDraft: vi.fn(),
          submitPrompt: vi.fn()
        }),
      { wrapper }
    );

    await vi.waitFor(() => expect(rendered.result.current.canOpen).toBe(true));
    let closePromise: Promise<void> | null = null;
    act(() => {
      closePromise = runtime.close({
        workspaceId: "workspace-closing",
        sideAgentSessionId: opened.sideAgentSessionId
      });
    });
    await vi.waitFor(() =>
      expect(rendered.result.current.active?.status).toBe("closing")
    );
    expect(rendered.result.current.canOpen).toBe(false);
    expect(rendered.result.current.commands).toEqual([]);

    await act(async () => finishClose?.());
    await closePromise;
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

  it("keeps /side available for an existing same-source Side", async () => {
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
    await runtime.open({
      workspaceId: "workspace-1",
      sourceAgentSessionId: "source-1"
    });
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
          submitPrompt: vi.fn()
        }),
      { wrapper }
    );

    await act(async () => undefined);
    expect(rendered.result.current.commands).toEqual([
      expect.objectContaining({ name: "side" })
    ]);

    act(() => {
      rendered.result.current.submitMain(
        [{ type: "text", text: "/side inspect this" }],
        "/side inspect this"
      );
    });
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(clearMainDraft).toHaveBeenCalledOnce());

    rendered.unmount();
    runtime.dispose();
  });

  it("does not expose /side for a failed same-source Side", async () => {
    const transport: AgentSideConversationTransport = {
      resolveCapabilities: vi.fn(async () => ({
        supported: true,
        activeSourceTurn: true,
        ephemeral: true,
        hideInheritedTurns: true,
        modelBoundaryInjected: true
      })),
      open: vi.fn(async () => {
        throw new Error("open failed");
      }),
      send: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      respond: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      subscribeConnectionState: vi.fn(() => () => {}),
      getConnectionState: vi.fn(() => "connected" as const)
    };
    const runtime = createAgentSideConversationRuntime(transport);
    await expect(
      runtime.open({
        workspaceId: "workspace-failed",
        sourceAgentSessionId: "source-failed"
      })
    ).rejects.toThrow("open failed");
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(
        AgentSideConversationRuntimeProvider,
        { runtime },
        children
      );
    const rendered = renderHook(
      () =>
        useAgentGUIDetailSideConversation({
          workspaceId: "workspace-failed",
          sourceAgentSessionId: "source-failed",
          provider: "codex",
          cwd: null,
          availableCommands: [],
          clearMainDraft: vi.fn(),
          submitPrompt: vi.fn()
        }),
      { wrapper }
    );

    await act(async () => undefined);
    expect(rendered.result.current.active?.status).toBe("error");
    expect(rendered.result.current.canOpen).toBe(false);
    expect(rendered.result.current.commands).toEqual([]);

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
