import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentGUINodeData } from "../../../types";
import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import type { AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import { useAgentGUIComposerOptionsSync } from "./useAgentGUIComposerOptionsSync";

describe("useAgentGUIComposerOptionsSync", () => {
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
          composerOptionsProjectKeyRef: { current: null },
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
          provider: "codex",
          workspaceId: "workspace-1"
        })
      );
    });
  });
});
