import { act, renderHook, waitFor } from "@testing-library/react";
import {
  createAgentSessionEngine,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentGUIProvider, AgentGUINodeData } from "../../../types";
import { setAgentHostApiForTests } from "../../../agentActivityHost";
import type { AgentHostRuntimeApi } from "../../../host/agentHostApi";
import type { AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import type { AgentGUIComposerDefaultsAuthorityReconciler } from "./agentGuiComposerDefaultsReconciliation";
import { useAgentGUIComposerOptionsSync } from "./useAgentGUIComposerOptionsSync";

describe("useAgentGUIComposerOptionsSync", () => {
  it("loads a switched target once without bypassing its cache", async () => {
    const getComposerOptions = vi.fn(async () => ({}));
    const activeConversationIdRef = { current: null };
    const dataRef = { current: targetData("codex") };
    const selectedTargetRef = { current: composerTarget("codex") };
    const selectedProjectPathRef = { current: "/workspace/project" };
    const { result, rerender } = renderHook(
      ({ provider }) => {
        const target = composerTarget(provider);
        dataRef.current = target.data;
        selectedTargetRef.current = target;
        return useAgentGUIComposerOptionsSync({
          activeConversationId: null,
          activeConversationIdRef,
          agentActivityRuntime: {
            getComposerOptions
          } as unknown as AgentActivityRuntime,
          composerTargetData: target,
          conversationFilter: null,
          currentUserId: "user-1",
          data: target.data,
          dataRef,
          defaultReasoningEffort: "high",
          draftSettingsBySessionIdRef: { current: {} },
          isComposerHome: true,
          isComposerHomeRef: { current: true },
          isCreatingConversation: false,
          loadDraftComposerOptionsRef: { current: () => {} },
          loadSessionState: vi.fn(),
          onComposerDefaultsAuthorityReloadedRef:
            createComposerDefaultsAuthorityReconcilerRef(),
          previewMode: false,
          providerComposerOptions: null,
          reloadSelectedConversation: vi.fn(),
          selectedComposerTargetDataRef: selectedTargetRef,
          selectedProjectPath: "/workspace/project",
          selectedProjectPathRef,
          sessionEngine: {
            getSnapshot: () => ({})
          } as unknown as AgentSessionEngine,
          syncConversationListProjection: vi.fn(async () => {}),
          workspaceId: "workspace-1",
          workspacePath: "/workspace"
        });
      },
      { initialProps: { provider: "codex" as AgentGUIProvider } }
    );

    await waitFor(() => expect(getComposerOptions).toHaveBeenCalledTimes(1));
    getComposerOptions.mockClear();

    rerender({ provider: "claude-code" });

    await waitFor(() => expect(getComposerOptions).toHaveBeenCalledTimes(1));
    expect(getComposerOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentTargetId: "local:claude-code",
        force: undefined,
        provider: "claude-code"
      })
    );

    getComposerOptions.mockClear();
    await result.current.reloadComposerOptionsForTarget({
      settings: { planMode: false },
      target: selectedTargetRef.current
    });
    expect(getComposerOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentTargetId: "local:claude-code",
        force: true,
        settings: { planMode: false }
      })
    );
  });

  it("loads composer options after conversation creation settles", async () => {
    const getComposerOptions = vi.fn(async () => ({}));
    const data: AgentGUINodeData = {
      provider: "codex",
      agentTargetId: "local:codex",
      lastActiveAgentSessionId: null
    };
    const target: AgentGUIComposerTargetData = {
      agentTargetId: "local:codex",
      data,
      provider: "codex",
      targetId: "local:codex"
    };
    const activeConversationIdRef = { current: null };
    const dataRef = { current: data };
    const selectedTargetRef = { current: target };
    const selectedProjectPathRef = { current: "/workspace/project" };

    const { rerender } = renderHook(
      ({ isCreatingConversation }) =>
        useAgentGUIComposerOptionsSync({
          activeConversationId: null,
          activeConversationIdRef,
          agentActivityRuntime: {
            getComposerOptions
          } as unknown as AgentActivityRuntime,
          composerTargetData: target,
          conversationFilter: null,
          currentUserId: "user-1",
          data,
          dataRef,
          defaultReasoningEffort: "high",
          draftSettingsBySessionIdRef: { current: {} },
          isComposerHome: true,
          isComposerHomeRef: { current: true },
          isCreatingConversation,
          loadDraftComposerOptionsRef: { current: () => {} },
          loadSessionState: vi.fn(),
          onComposerDefaultsAuthorityReloadedRef:
            createComposerDefaultsAuthorityReconcilerRef(),
          previewMode: false,
          providerComposerOptions: null,
          reloadSelectedConversation: vi.fn(),
          selectedComposerTargetDataRef: selectedTargetRef,
          selectedProjectPath: "/workspace/project",
          selectedProjectPathRef,
          sessionEngine: {
            getSnapshot: () => ({})
          } as unknown as AgentSessionEngine,
          syncConversationListProjection: vi.fn(async () => {}),
          workspaceId: "workspace-1",
          workspacePath: "/workspace"
        }),
      { initialProps: { isCreatingConversation: true } }
    );

    expect(getComposerOptions).not.toHaveBeenCalled();

    rerender({ isCreatingConversation: false });

    await waitFor(() => {
      expect(getComposerOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          agentTargetId: "local:codex",
          cwd: "/workspace/project",
          force: true,
          provider: "codex",
          workspaceId: "workspace-1"
        })
      );
    });
  });

  it("rereads target authority on invalidation without sending local persistent intent", async () => {
    const getComposerOptions = vi.fn(async () => ({}));
    let emitHostEvent: ((event: unknown) => void) | null = null;
    setAgentHostApiForTests({
      onHostEvent: (listener: (event: unknown) => void) => {
        emitHostEvent = listener;
        return () => {
          emitHostEvent = null;
        };
      }
    } as unknown as AgentHostRuntimeApi);
    const data = targetData("opencode");
    const target = composerTarget("opencode");
    const draftSettingsBySessionIdRef = {
      current: {
        "__agent_gui_node_defaults__:target:local:opencode": {
          model: "opencode/new-model",
          permissionModeId: "full-access",
          planMode: false,
          reasoningEffort: "high" as const,
          speed: "fast" as const
        }
      }
    };
    const authorityReconcilerRef =
      createComposerDefaultsAuthorityReconcilerRef();
    const rendered = renderHook(() =>
      useAgentGUIComposerOptionsSync({
        activeConversationId: null,
        activeConversationIdRef: { current: null },
        agentActivityRuntime: {
          getComposerOptions
        } as unknown as AgentActivityRuntime,
        composerTargetData: target,
        conversationFilter: null,
        currentUserId: "user-1",
        data,
        dataRef: { current: data },
        defaultReasoningEffort: null,
        draftSettingsBySessionIdRef,
        isComposerHome: true,
        isComposerHomeRef: { current: true },
        isCreatingConversation: false,
        loadDraftComposerOptionsRef: { current: () => {} },
        loadSessionState: vi.fn(),
        onComposerDefaultsAuthorityReloadedRef: authorityReconcilerRef,
        previewMode: false,
        providerComposerOptions: null,
        reloadSelectedConversation: vi.fn(),
        selectedComposerTargetDataRef: { current: target },
        selectedProjectPath: "/workspace/project",
        selectedProjectPathRef: { current: "/workspace/project" },
        sessionEngine: {
          getSnapshot: () => ({})
        } as unknown as AgentSessionEngine,
        syncConversationListProjection: vi.fn(async () => {}),
        workspaceId: "workspace-1",
        workspacePath: "/workspace"
      })
    );

    try {
      await waitFor(() => expect(getComposerOptions).toHaveBeenCalled());
      getComposerOptions.mockClear();
      const permissionReceipt = {
        draftKey: "__agent_gui_node_defaults__:target:local:opencode",
        fields: {
          permissionModeId: {
            generation: 1,
            value: "full-access"
          }
        }
      };
      authorityReconcilerRef.current.prepareRead = vi.fn(
        (_target, settings) => {
          const authoritySettings = { ...settings };
          delete authoritySettings.permissionModeId;
          return {
            force: true,
            receipt: permissionReceipt,
            settings: authoritySettings
          };
        }
      );
      vi.mocked(authorityReconcilerRef.current.reloaded).mockClear();
      act(() => {
        emitHostEvent?.({
          agentTargetId: "local:opencode",
          scope: "global",
          type: "agent-composer-defaults-invalidated"
        });
      });
      await waitFor(() =>
        expect(getComposerOptions).toHaveBeenCalledWith(
          expect.objectContaining({
            agentTargetId: "local:opencode",
            force: true,
            settings: { planMode: false }
          })
        )
      );
      expect(draftSettingsBySessionIdRef.current).toMatchObject({
        "__agent_gui_node_defaults__:target:local:opencode": {
          permissionModeId: "full-access"
        }
      });
      expect(authorityReconcilerRef.current.prepareRead).toHaveBeenCalledWith(
        target,
        expect.objectContaining({
          model: "opencode/new-model",
          permissionModeId: "full-access",
          reasoningEffort: "high",
          speed: "fast"
        })
      );
      expect(authorityReconcilerRef.current.reloaded).toHaveBeenCalledWith(
        permissionReceipt
      );
    } finally {
      rendered.unmount();
      setAgentHostApiForTests(null);
    }
  });

  it("forces a later home authority read to reconcile acknowledged defaults", async () => {
    const getComposerOptions = vi.fn(async () => ({}));
    const data = targetData("opencode");
    const target = composerTarget("opencode");
    const authorityReconcilerRef =
      createComposerDefaultsAuthorityReconcilerRef();
    authorityReconcilerRef.current.prepareRead = vi.fn((_target, settings) => ({
      force: true,
      receipt: {
        draftKey: "__agent_gui_node_defaults__:target:local:opencode",
        fields: {
          permissionModeId: {
            generation: 1,
            value: "full-access"
          }
        }
      },
      settings: { planMode: settings.planMode }
    }));

    renderHook(() =>
      useAgentGUIComposerOptionsSync({
        activeConversationId: null,
        activeConversationIdRef: { current: null },
        agentActivityRuntime: {
          getComposerOptions
        } as unknown as AgentActivityRuntime,
        composerTargetData: target,
        conversationFilter: null,
        currentUserId: "user-1",
        data,
        dataRef: { current: data },
        defaultReasoningEffort: null,
        draftSettingsBySessionIdRef: {
          current: {
            "__agent_gui_node_defaults__:target:local:opencode": {
              permissionModeId: "full-access",
              planMode: false
            }
          }
        },
        isComposerHome: true,
        isComposerHomeRef: { current: true },
        isCreatingConversation: false,
        loadDraftComposerOptionsRef: { current: () => {} },
        loadSessionState: vi.fn(),
        onComposerDefaultsAuthorityReloadedRef: authorityReconcilerRef,
        previewMode: false,
        providerComposerOptions: null,
        reloadSelectedConversation: vi.fn(),
        selectedComposerTargetDataRef: { current: target },
        selectedProjectPath: "/workspace/project",
        selectedProjectPathRef: { current: "/workspace/project" },
        sessionEngine: {
          getSnapshot: () => ({})
        } as unknown as AgentSessionEngine,
        syncConversationListProjection: vi.fn(async () => {}),
        workspaceId: "workspace-1",
        workspacePath: "/workspace"
      })
    );

    await waitFor(() =>
      expect(getComposerOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          agentTargetId: "local:opencode",
          force: true,
          settings: { planMode: false }
        })
      )
    );
    expect(authorityReconcilerRef.current.reloaded).toHaveBeenCalledWith(
      expect.objectContaining({
        draftKey: "__agent_gui_node_defaults__:target:local:opencode"
      })
    );
  });

  it("does not reconcile target defaults while loading an active session", async () => {
    const getComposerOptions = vi.fn(async () => ({}));
    const data = targetData("opencode");
    const target = composerTarget("opencode");
    const authorityReconcilerRef =
      createComposerDefaultsAuthorityReconcilerRef();
    const sessionEngine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: { execute: vi.fn() },
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });

    renderHook(() =>
      useAgentGUIComposerOptionsSync({
        activeConversationId: "session-1",
        activeConversationIdRef: { current: "session-1" },
        agentActivityRuntime: {
          getComposerOptions
        } as unknown as AgentActivityRuntime,
        composerTargetData: target,
        conversationFilter: null,
        currentUserId: "user-1",
        data,
        dataRef: { current: data },
        defaultReasoningEffort: null,
        draftSettingsBySessionIdRef: { current: {} },
        isComposerHome: false,
        isComposerHomeRef: { current: false },
        isCreatingConversation: false,
        loadDraftComposerOptionsRef: { current: () => {} },
        loadSessionState: vi.fn(),
        onComposerDefaultsAuthorityReloadedRef: authorityReconcilerRef,
        previewMode: false,
        providerComposerOptions: null,
        reloadSelectedConversation: vi.fn(),
        selectedComposerTargetDataRef: { current: target },
        selectedProjectPath: "/workspace/project",
        selectedProjectPathRef: { current: "/workspace/project" },
        sessionEngine,
        syncConversationListProjection: vi.fn(async () => {}),
        workspaceId: "workspace-1",
        workspacePath: "/workspace"
      })
    );

    await waitFor(() => expect(getComposerOptions).toHaveBeenCalled());
    expect(authorityReconcilerRef.current.prepareRead).not.toHaveBeenCalled();
    expect(authorityReconcilerRef.current.reloaded).not.toHaveBeenCalled();
  });
});

function createComposerDefaultsAuthorityReconcilerRef(): {
  current: AgentGUIComposerDefaultsAuthorityReconciler;
} {
  return {
    current: {
      prepareRead: vi.fn((_target, settings) => ({
        force: false,
        receipt: null,
        settings
      })),
      reloaded: vi.fn()
    }
  };
}

function targetData(provider: AgentGUIProvider): AgentGUINodeData {
  return {
    agentTargetId: `local:${provider}`,
    lastActiveAgentSessionId: null,
    provider
  };
}

function composerTarget(
  provider: AgentGUIProvider
): AgentGUIComposerTargetData {
  return {
    agentTargetId: `local:${provider}`,
    data: targetData(provider),
    provider,
    targetId: `local:${provider}`
  };
}
