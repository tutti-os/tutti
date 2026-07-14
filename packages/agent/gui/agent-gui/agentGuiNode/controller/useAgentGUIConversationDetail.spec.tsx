import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import { useAgentGUIConversationDetail } from "./useAgentGUIConversationDetail";

describe("useAgentGUIConversationDetail", () => {
  it("restores provider commands from composer options before an engine event is available", () => {
    const { result } = renderHook(() =>
      useAgentGUIConversationDetail({
        activeCancelStatus: null,
        activeConversation: null,
        activeConversationId: "session-1",
        activeConversationLiveState: "inactive",
        activeEngineError: null,
        activeMessages: [],
        activePendingInteractions: [],
        activeQueuedPromptInFlight: null,
        activeQueuedPrompts: [],
        activeQueueStatus: "active",
        activeSessionReconcileError: null,
        activeSessionView: null,
        activeTimelineItems: [],
        activeTurn: null,
        agentActivityRuntime: {} as AgentActivityRuntime,
        avoidGroupingEdits: false,
        codeFor: () => null,
        detailError: null,
        draftByScopeKey: {},
        errorFor: () => null,
        providerComposerOptions: {
          commands: [{ name: "memory", description: "Manage memory" }],
          skills: []
        } as never,
        selectedComposerTargetData: {
          agentTargetId: "extension:gemini",
          data: {
            conversationRailWidthPx: null,
            lastActiveAgentSessionId: "session-1",
            provider: "acp:gemini"
          },
          provider: "acp:gemini",
          targetId: "extension:gemini"
        },
        selectedProjectPath: "/workspace",
        sessionEngine: createTestAgentSessionEngine("workspace-1"),
        workspaceId: "workspace-1",
        workspacePath: "/workspace"
      })
    );

    expect(result.current.availableCommands).toEqual([
      { name: "memory", description: "Manage memory" }
    ]);
  });

  it("surfaces session reconcile errors through the detail error channel", () => {
    const { result } = renderHook(() =>
      useAgentGUIConversationDetail({
        activeCancelStatus: null,
        activeConversation: null,
        activeConversationId: "session-1",
        activeConversationLiveState: "inactive",
        activeEngineError: null,
        activeMessages: [],
        activePendingInteractions: [],
        activeQueuedPromptInFlight: null,
        activeQueuedPrompts: [],
        activeQueueStatus: "active",
        activeSessionReconcileError: "detail reconcile failed",
        activeSessionView: null,
        activeTimelineItems: [],
        activeTurn: null,
        agentActivityRuntime: {} as AgentActivityRuntime,
        avoidGroupingEdits: false,
        codeFor: () => null,
        detailError: null,
        draftByScopeKey: {},
        errorFor: () => null,
        providerComposerOptions: null,
        selectedComposerTargetData: {
          agentTargetId: null,
          data: {
            conversationRailWidthPx: null,
            lastActiveAgentSessionId: "session-1",
            provider: "codex"
          },
          provider: "codex",
          targetId: "local:codex"
        },
        selectedProjectPath: "/workspace",
        sessionEngine: createTestAgentSessionEngine("workspace-1"),
        workspaceId: "workspace-1",
        workspacePath: "/workspace"
      })
    );

    expect(result.current.effectiveDetailError).toBe("detail reconcile failed");
  });
});
