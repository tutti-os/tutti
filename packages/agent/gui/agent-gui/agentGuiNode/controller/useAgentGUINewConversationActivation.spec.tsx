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
        initialTuttiModeActivation?: {
          source: "slash_command";
          status: "active";
        };
        optimisticTitle?: string;
        settings?: Record<string, unknown>;
        tuttiModeDraftKey?: string;
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
    const agentActivityRuntime = {} as AgentActivityRuntime;
    const isCurrentConversation = () => false;
    const isConversationStale = () => false;
    const loadSelectedConversationMessages = vi.fn();
    const loadSessionState = vi.fn();
    const syncConversationListProjection = vi.fn();
    const refreshMessagesFromSnapshot = vi.fn();
    const tuttiModeDraftKey = "agent-gui:node-1:tutti-mode:home";
    const inactiveTuttiModeDraftKey = "agent-gui:node-2:tutti-mode:home";
    const activeTuttiModeEngine = {
      getSnapshot: () => ({
        tuttiModeActivation: {
          draftsByKey: {
            [tuttiModeDraftKey]: { active: true }
          }
        }
      })
    } as never;
    const inactiveTuttiModeEngine = {
      getSnapshot: () => ({
        tuttiModeActivation: { draftsByKey: {} }
      })
    } as never;
    const { result, rerender } = renderHook(
      ({
        sessionEngine,
        tuttiModeDraftKey: currentTuttiModeDraftKey
      }: {
        sessionEngine: never;
        tuttiModeDraftKey: string;
      }) =>
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
          agentActivityRuntime,
          workspaceId: "workspace-1",
          activeConversationIdRef,
          isComposerHomeRef,
          conversationsRef: { current: [] },
          activeSessionState: null,
          lastActiveModelByProviderRef: { current: {} },
          sessionEngine,
          tuttiModeDraftKey: currentTuttiModeDraftKey,
          conversationListQuery: null,
          currentUserId: "user-1",
          persistActiveConversation,
          setActiveConversationId,
          setIntent,
          setIsComposerHome,
          setIsLoadingMessages: vi.fn(),
          activation,
          isCurrentConversation,
          isConversationStale,
          loadSelectedConversationMessages,
          loadSessionState,
          syncConversationListProjection,
          data,
          defaultReasoningEffort: "medium",
          refreshMessagesFromSnapshot
        }),
      {
        initialProps: {
          sessionEngine: activeTuttiModeEngine,
          tuttiModeDraftKey
        }
      }
    );

    let firstResult: ReturnType<typeof result.current> = null;
    act(() => {
      firstResult = result.current(
        [{ type: "text", text: "first" }],
        "/computer first",
        { requiredSettingsPatch: { computerUse: true } }
      );
    });
    const firstSessionId = activate.mock.calls[0]?.[0].agentSessionId;
    activeConversationIdRef.current = null;
    isComposerHomeRef.current = true;
    rerender({
      sessionEngine: inactiveTuttiModeEngine,
      tuttiModeDraftKey: inactiveTuttiModeDraftKey
    });
    let secondResult: ReturnType<typeof result.current> = null;
    act(() => {
      secondResult = result.current(
        [{ type: "text", text: "second" }],
        "second",
        undefined,
        { model: "gpt-plan", modelPlanId: "plan-2" },
        "agent-session:source"
      );
    });
    const secondSessionId = activate.mock.calls[1]?.[0].agentSessionId;

    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate.mock.calls[0]?.[0].optimisticTitle).toBe("/computer first");
    expect(activate.mock.calls[0]?.[0].settings).toMatchObject({
      computerUse: true
    });
    expect(activate.mock.calls[0]?.[0]).toMatchObject({
      initialTuttiModeActivation: {
        source: "slash_command",
        status: "active"
      },
      tuttiModeDraftKey
    });
    expect(activate.mock.calls[1]?.[0].optimisticTitle).toBe("second");
    expect(firstSessionId).toBeTruthy();
    expect(secondSessionId).toBeTruthy();
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(activate.mock.calls[1]?.[0]).toMatchObject({
      settings: { model: "gpt-plan", modelPlanId: "plan-2" }
    });
    expect(
      activate.mock.calls[1]?.[0].initialTuttiModeActivation
    ).toBeUndefined();
    expect(activate.mock.calls[1]?.[0].tuttiModeDraftKey).toBeUndefined();
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
    expect(persistActiveConversation).toHaveBeenLastCalledWith(secondSessionId);
  });
});
