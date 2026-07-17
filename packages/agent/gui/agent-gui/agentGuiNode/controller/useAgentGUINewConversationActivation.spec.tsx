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
    expect(activate.mock.calls[1]?.[0]).toMatchObject({
      settings: { model: "gpt-plan", modelPlanId: "plan-2" }
    });
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

    function codexOptions(
      models: string[],
      overrides: Partial<AgentActivityComposerOptions> = {}
    ): AgentActivityComposerOptions {
      return {
        provider: "codex",
        capabilities: null,
        models: models.map((value) => ({ value, label: value })),
        reasoningEfforts: [],
        speeds: [],
        skills: [],
        behavior: {} as AgentActivityComposerOptions["behavior"],
        loadedAtUnixMs: 1,
        ...overrides
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

    // Live P1 repro (plan session leaked "x-ai/grok-4.5" bare into the codex
    // provider bucket, daemon restarted): while live model discovery has not
    // filled the catalog, the daemon serves a selected-model-only bootstrap
    // list that merely echoes the requested settings. A match against that
    // echo is not evidence — the daemon later rejects the create with 400
    // invalid model. The bare plan model must be dropped before create.
    it("drops a bare plan model that only the daemon selected-model echo could verify", () => {
      const { start } = makeHarness({
        composerOptions: codexOptions(["x-ai/grok-4.5"], {
          effectiveSettings: { model: "x-ai/grok-4.5" }
        }),
        lastActiveModelByProvider: {
          codex: { model: "x-ai/grok-4.5", modelPlanId: null }
        }
      });
      const call = start();
      expect(call?.settings?.model ?? null).toBe(null);
      expect(call?.settings?.modelPlanId ?? null).toBe(null);
    });

    it("drops a bare model when loaded provider options advertise no models", () => {
      const { start } = makeHarness({
        composerOptions: codexOptions([]),
        lastActiveModelByProvider: {
          codex: { model: "x-ai/grok-4.5", modelPlanId: null }
        }
      });
      const call = start();
      expect(call?.settings?.model ?? null).toBe(null);
    });

    it("drops a bare model while the model catalog is still loading", () => {
      const { start } = makeHarness({
        composerOptions: codexOptions(["x-ai/grok-4.5", "gpt-5.3-codex"], {
          modelOptionsLoading: true
        }),
        lastActiveModelByProvider: {
          codex: { model: "x-ai/grok-4.5", modelPlanId: null }
        }
      });
      const call = start();
      expect(call?.settings?.model ?? null).toBe(null);
    });

    // Warm-catalog window (the live P1 steady state): the daemon appends the
    // requested model to the settled catalog projection when the catalog does
    // not contain it (composer_model_options.go append + desktop
    // appendCurrentOption), so the multi-entry list "contains" the poisoned
    // model while create validation runs against the raw catalog and rejects
    // it with 400. Requested-origin entries are provenance-marked and must
    // not count as catalog testimony.
    it("drops a bare plan model that rides the warm catalog only as a requested entry", () => {
      const options = codexOptions(["gpt-5.3-codex", "gpt-5.6-sol"], {
        effectiveSettings: { model: "x-ai/grok-4.5" }
      });
      options.models.push({
        value: "x-ai/grok-4.5",
        label: "x-ai/grok-4.5",
        requested: true
      });
      const { start } = makeHarness({
        composerOptions: options,
        lastActiveModelByProvider: {
          codex: { model: "x-ai/grok-4.5", modelPlanId: null }
        }
      });
      const call = start();
      expect(call?.settings?.model ?? null).toBe(null);
      expect(call?.settings?.modelPlanId ?? null).toBe(null);
    });

    it("keeps a bare model the warm catalog genuinely contains alongside a requested duplicate marker", () => {
      const options = codexOptions(["gpt-5.3-codex", "gpt-5.6-sol"], {
        effectiveSettings: { model: "gpt-5.6-sol" }
      });
      const { start } = makeHarness({
        composerOptions: options,
        lastActiveModelByProvider: {
          codex: { model: "gpt-5.6-sol", modelPlanId: null }
        }
      });
      const call = start();
      expect(call?.settings?.model).toBe("gpt-5.6-sol");
    });
  });
});
