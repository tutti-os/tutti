import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createLocalAgentGUIAgentTarget } from "../../../agentTargets";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentGUINodeData } from "../../../types";
import type { useAgentGUIActivation } from "./useAgentGUIActivation";
import { useAgentGUINewConversationActivation } from "./useAgentGUINewConversationActivation";

describe("useAgentGUINewConversationActivation", () => {
  it("starts a second request-scoped activation and keeps it selected", () => {
    const target = createLocalAgentGUIAgentTarget("codex");
    const agentTargetId = target.agentTargetId!;
    const data: AgentGUINodeData = {
      agentTargetId,
      lastActiveAgentSessionId: null,
      provider: "codex"
    };
    const activeConversationIdRef = { current: null as string | null };
    const isComposerHomeRef = { current: true };
    const activate = vi.fn(
      (input: {
        agentSessionId: string;
        initialContent?: Array<{ type: "text"; text: string }>;
        initialDisplayPrompt?: string;
        optimisticTitle?: string;
        settings?: Record<string, unknown>;
      }) => `activation:${input.agentSessionId}`
    );
    const activation = {
      activate,
      clearFailure: vi.fn(),
      markFailed: vi.fn(),
      unactivate: vi.fn(),
      stateFor: vi.fn(() => "inactive" as const),
      errorFor: vi.fn(() => null),
      codeFor: vi.fn(() => null)
    } as unknown as ReturnType<typeof useAgentGUIActivation>;
    const setActiveConversationId = vi.fn();
    const setIntent = vi.fn();
    const setIsComposerHome = vi.fn();
    const persistActiveConversation = vi.fn();
    const requestRailReveal = vi.fn();
    const { result } = renderHook(() =>
      useAgentGUINewConversationActivation({
        getCachedComposerOptions: () => null,
        selectedAgentTargetRef: { current: target },
        selectedComposerTargetDataRef: {
          current: {
            agentTargetId,
            data,
            provider: "codex",
            targetId: target.targetId
          }
        },
        agentTargetsProvidedRef: { current: true },
        selectedAgentTargetIsExplicitRef: { current: true },
        setDetailError: vi.fn(),
        isCreatingConversationRef: { current: false },
        onDataChangeRef: { current: vi.fn() },
        selectedProjectPathRef: { current: null },
        draftByScopeKeyRef: { current: {} },
        submittedDraftSnapshotsRef: { current: {} },
        draftSettingsBySessionIdRef: { current: {} },
        agentActivityRuntime: {} as AgentActivityRuntime,
        workspaceId: "workspace-1",
        activeConversationIdRef,
        isComposerHomeRef,
        conversationsRef: { current: [] },
        activeSessionState: {
          agentSessionId: "historical-session",
          agentTargetId,
          permissionModeId: "full-access",
          provider: "codex",
          resumable: true,
          settings: { model: "historical-model" },
          status: "ready",
          updatedAtUnixMs: 1,
          workspaceId: "workspace-1"
        } as never,
        sessionEngine: {
          getSnapshot: () => ({})
        } as never,
        conversationListQuery: null,
        currentUserId: "user-1",
        persistActiveConversation,
        requestRailReveal,
        setActiveConversationId,
        setIntent,
        setIsComposerHome,
        setIsLoadingMessages: vi.fn(),
        activation,
        isCurrentConversation: () => false,
        isConversationStale: () => false,
        loadSelectedConversationMessages: vi.fn(),
        loadSessionState: vi.fn(),
        syncConversationListProjection: vi.fn(),
        data,
        defaultReasoningEffort: "medium",
        refreshMessagesFromSnapshot: vi.fn()
      })
    );

    let firstResult: ReturnType<typeof result.current> = null;
    act(() => {
      firstResult = result.current(
        [{ type: "text", text: "$review-code inspect this" }],
        "/review-code inspect this",
        { requiredSettingsPatch: { computerUse: true } }
      );
    });
    const firstSessionId = activate.mock.calls[0]?.[0].agentSessionId;
    activeConversationIdRef.current = null;
    isComposerHomeRef.current = true;
    let secondResult: ReturnType<typeof result.current> = null;
    act(() => {
      secondResult = result.current([{ type: "text", text: "second" }]);
    });
    const secondSessionId = activate.mock.calls[1]?.[0].agentSessionId;

    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate.mock.calls[0]?.[0]).toMatchObject({
      initialContent: [{ type: "text", text: "$review-code inspect this" }],
      initialDisplayPrompt: "/review-code inspect this",
      optimisticTitle: "/review-code inspect this"
    });
    expect(activate.mock.calls[0]?.[0].settings).toMatchObject({
      computerUse: true
    });
    expect(activate.mock.calls[0]?.[0].settings).not.toHaveProperty("model");
    expect(activate.mock.calls[1]?.[0].optimisticTitle).toBe("second");
    expect(activate.mock.calls[1]?.[0].settings).toEqual({});
    expect(firstSessionId).toBeTruthy();
    expect(secondSessionId).toBeTruthy();
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(firstResult).toEqual({
      agentSessionId: firstSessionId,
      requestId: `activation:${firstSessionId}`
    });
    expect(secondResult).toEqual({
      agentSessionId: secondSessionId,
      requestId: `activation:${secondSessionId}`
    });
    expect(activeConversationIdRef.current).toBe(secondSessionId);
    expect(isComposerHomeRef.current).toBe(false);
    expect(setActiveConversationId).toHaveBeenLastCalledWith(secondSessionId);
    expect(setIntent).toHaveBeenLastCalledWith({
      tag: "active",
      id: secondSessionId
    });
    expect(persistActiveConversation).toHaveBeenLastCalledWith(
      secondSessionId,
      "local:codex"
    );
    expect(requestRailReveal).toHaveBeenLastCalledWith(
      secondSessionId,
      "created"
    );
  });
});
