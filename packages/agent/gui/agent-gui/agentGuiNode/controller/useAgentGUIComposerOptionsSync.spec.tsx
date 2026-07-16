import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentGUIProvider, AgentGUINodeData } from "../../../types";
import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import type { AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import { useAgentGUIComposerOptionsSync } from "./useAgentGUIComposerOptionsSync";

describe("useAgentGUIComposerOptionsSync", () => {
  it("loads a switched target once without bypassing its cache", async () => {
    const getComposerOptions = vi.fn(async () => ({}));
    const activeConversationIdRef = { current: null };
    const dataRef = { current: targetData("codex") };
    const selectedTargetRef = { current: composerTarget("codex") };
    const selectedProjectPathRef = { current: "/workspace/project" };
    const { rerender } = renderHook(
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
});

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
