import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentGUINodeData } from "../../../types";
import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
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
          setDraftSettingsBySessionId: vi.fn(),
          isComposerHome: true,
          isComposerHomeRef: { current: true },
          isCreatingConversation,
          loadDraftComposerOptionsRef: { current: () => {} },
          loadSessionState: vi.fn(),
          onDataChangeRef: { current: vi.fn() },
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

  it("reconciles a changed plan fingerprint into home composer defaults", async () => {
    let data: AgentGUINodeData = {
      provider: "codex",
      agentTargetId: "local:codex",
      lastActiveAgentSessionId: null,
      composerOverridesByAgentTargetId: {
        "local:codex": { model: "gpt-5" }
      },
      modelConfigurationsByAgentTargetId: {
        "local:codex": {
          defaultModel: "gpt-5",
          fingerprint: "plan-1:v1",
          selectedModel: "gpt-5",
          source: "model-plan"
        }
      }
    };
    const dataRef = { current: data };
    let drafts = {};
    const target = (): AgentGUIComposerTargetData => ({
      agentTargetId: "local:codex",
      data,
      provider: "codex",
      targetId: "local:codex"
    });
    const options = (fingerprint: string, defaultModel: string) =>
      ({
        behavior: {},
        modelConfiguration: {
          agentTargetId: "local:codex",
          defaultModel,
          fingerprint,
          source: "model-plan"
        }
      }) as AgentActivityComposerOptions;

    const { rerender } = renderHook(
      ({ providerComposerOptions }) =>
        useAgentGUIComposerOptionsSync({
          activeConversationId: null,
          activeConversationIdRef: { current: null },
          agentActivityRuntime: {
            getComposerOptions: vi.fn(async () => ({}))
          } as unknown as AgentActivityRuntime,
          composerOptionsProjectKeyRef: { current: null },
          composerTargetData: target(),
          conversationFilter: null,
          currentUserId: "user-1",
          data,
          dataRef,
          defaultReasoningEffort: "high",
          draftSettingsBySessionIdRef: { current: drafts },
          setDraftSettingsBySessionId: (updater) => {
            drafts = typeof updater === "function" ? updater(drafts) : updater;
          },
          isComposerHome: true,
          isComposerHomeRef: { current: true },
          isCreatingConversation: false,
          loadDraftComposerOptionsRef: { current: () => {} },
          loadSessionState: vi.fn(),
          onDataChangeRef: {
            current: (updater) => {
              data = updater(data);
              dataRef.current = data;
            }
          },
          previewMode: false,
          providerComposerOptions,
          reloadSelectedConversation: vi.fn(),
          selectedComposerTargetDataRef: { current: target() },
          selectedProjectPath: null,
          selectedProjectPathRef: { current: null },
          sessionEngine: {
            getSnapshot: () => ({})
          } as unknown as AgentSessionEngine,
          syncConversationListProjection: vi.fn(async () => {}),
          workspaceId: "workspace-1",
          workspacePath: "/workspace"
        }),
      {
        initialProps: { providerComposerOptions: options("plan-1:v1", "gpt-5") }
      }
    );

    rerender({
      providerComposerOptions: options("plan-1:v2", "gpt-5.1")
    });

    await waitFor(() => {
      expect(
        data.modelConfigurationsByAgentTargetId?.["local:codex"]?.fingerprint
      ).toBe("plan-1:v2");
      expect(
        data.composerOverridesByAgentTargetId?.["local:codex"]?.model
      ).toBe("gpt-5.1");
    });
  });
});
