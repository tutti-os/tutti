import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
import { createLocalAgentGUIAgentTarget } from "../../../agentTargets";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentGUINodeData } from "../../../types";
import type { useAgentGUIActivation } from "./useAgentGUIActivation";
import type { UseAgentGUINewConversationActivationInput } from "./agentGuiNewConversationActivation.types";
import { nodeDefaultDraftKey } from "./agentGuiController.composerHelpers";
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
          orchestrationIntensity?: number;
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
            [tuttiModeDraftKey]: { active: true, orchestrationIntensity: 80 }
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
        orchestrationIntensity: 80,
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

  describe("model binding on create", () => {
    function makeHarness(overrides: {
      composerOptions?: AgentActivityComposerOptions | null;
      draftModelSettings?: {
        model?: string | null;
        modelPlanId?: string | null;
      };
      lastActiveModelByProvider?: UseAgentGUINewConversationActivationInput["lastActiveModelByProviderRef"]["current"];
    }) {
      const target = createLocalAgentGUIAgentTarget("codex");
      const agentTargetId = target.agentTargetId!;
      const draftSettings = overrides.draftModelSettings
        ? {
            [nodeDefaultDraftKey("codex", agentTargetId)]:
              overrides.draftModelSettings
          }
        : {};
      const data: AgentGUINodeData = {
        agentTargetId,
        lastActiveAgentSessionId: null,
        provider: "codex"
      };
      const activate = vi.fn(
        (input: { agentSessionId: string }) =>
          `activation:${input.agentSessionId}`
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
      const { result } = renderHook(() =>
        useAgentGUINewConversationActivation({
          getCachedComposerOptions: () => overrides.composerOptions ?? null,
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
          draftSettingsBySessionIdRef: { current: draftSettings },
          agentActivityRuntime: {
            getSnapshot: () => ({ sessions: [] })
          } as unknown as AgentActivityRuntime,
          workspaceId: "workspace-1",
          activeConversationIdRef: { current: null },
          isComposerHomeRef: { current: true },
          conversationsRef: { current: [] },
          activeSessionState: null,
          lastActiveModelByProviderRef: {
            current: overrides.lastActiveModelByProvider ?? {}
          },
          sessionEngine: {
            getSnapshot: () => ({ tuttiModeActivation: { draftsByKey: {} } })
          } as never,
          tuttiModeDraftKey: "agent-gui:node-1:tutti-mode:home",
          conversationListQuery: null,
          currentUserId: "user-1",
          persistActiveConversation: vi.fn(),
          setActiveConversationId: vi.fn(),
          setIntent: vi.fn(),
          setIsComposerHome: vi.fn(),
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
      const start = () => {
        act(() => {
          result.current([{ type: "text", text: "hello" }]);
        });
        return activate.mock.calls[0]?.[0] as
          | { settings?: Record<string, unknown> }
          | undefined;
      };
      return { start };
    }

    function codexOptions(models: string[]): AgentActivityComposerOptions {
      return {
        provider: "codex",
        capabilities: null,
        models: models.map((value) => ({ value, label: value })),
        reasoningEfforts: [],
        speeds: [],
        skills: [],
        behavior: {} as AgentActivityComposerOptions["behavior"],
        loadedAtUnixMs: 1
      };
    }

    it("drops a bare cross-plan model remembered for the provider when options are unavailable", () => {
      const { start } = makeHarness({
        composerOptions: null,
        lastActiveModelByProvider: {
          codex: { model: "x-ai/grok-4.5", modelPlanId: null }
        }
      });
      const call = start();
      expect(call?.settings?.model ?? null).toBe(null);
      expect(call?.settings?.modelPlanId ?? null).toBe(null);
    });

    it("inherits the remembered plan model as a {model, modelPlanId} pair", () => {
      const { start } = makeHarness({
        composerOptions: null,
        lastActiveModelByProvider: {
          codex: { model: "x-ai/grok-4.5", modelPlanId: "mp-relay" }
        }
      });
      const call = start();
      expect(call?.settings).toMatchObject({
        model: "x-ai/grok-4.5",
        modelPlanId: "mp-relay"
      });
    });

    it("drops a bare draft model that options cannot verify", () => {
      const { start } = makeHarness({
        composerOptions: null,
        draftModelSettings: { model: "x-ai/grok-4.5" }
      });
      const call = start();
      expect(call?.settings?.model ?? null).toBe(null);
    });

    it("keeps a draft plan model pair without composer options", () => {
      const { start } = makeHarness({
        composerOptions: null,
        draftModelSettings: {
          model: "x-ai/grok-4.5",
          modelPlanId: "mp-relay"
        }
      });
      const call = start();
      expect(call?.settings).toMatchObject({
        model: "x-ai/grok-4.5",
        modelPlanId: "mp-relay"
      });
    });

    it("keeps a bare model verified against loaded provider options", () => {
      const { start } = makeHarness({
        composerOptions: codexOptions(["gpt-5.3-codex"]),
        lastActiveModelByProvider: {
          codex: { model: "gpt-5.3-codex", modelPlanId: null }
        }
      });
      const call = start();
      expect(call?.settings?.model).toBe("gpt-5.3-codex");
    });

    it("drops a bare model rejected by loaded provider options", () => {
      const { start } = makeHarness({
        composerOptions: codexOptions(["gpt-5.3-codex"]),
        lastActiveModelByProvider: {
          codex: { model: "x-ai/grok-4.5", modelPlanId: null }
        }
      });
      const call = start();
      expect(call?.settings?.model ?? null).toBe(null);
    });
  });
});
