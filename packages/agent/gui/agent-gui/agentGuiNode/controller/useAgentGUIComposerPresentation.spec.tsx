import { renderHook, waitFor } from "@testing-library/react";
import type {
  AgentActivityComposerOptions,
  AgentActivityModelPlanSummary
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentGUINodeData } from "../../../types";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import { composerSettingsSupportFromOptions } from "../model/composerSettingsSupport";
import { nodeDefaultDraftKey } from "./agentGuiController.composerHelpers";
import type { AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import { useAgentGUIComposerPresentation } from "./useAgentGUIComposerPresentation";

describe("useAgentGUIComposerPresentation", () => {
  it("switches reasoning visibility and values with the selected model profile", () => {
    const data: AgentGUINodeData = {
      provider: "opencode",
      agentTargetId: "local:opencode",
      lastActiveAgentSessionId: "session-1"
    };
    const target: AgentGUIComposerTargetData = {
      agentTargetId: "local:opencode",
      data,
      provider: "opencode",
      targetId: "local:opencode"
    };
    const options: AgentActivityComposerOptions = {
      provider: "opencode",
      capabilities: null,
      models: [
        { value: "opencode/big-pickle", label: "Big Pickle" },
        { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" }
      ],
      reasoningEfforts: [{ value: "high", label: "High" }],
      reasoningOptionsByModel: {
        "opencode/big-pickle": {
          defaultValue: null,
          options: []
        },
        "gpt-5.6-sol": {
          defaultValue: "medium",
          options: [
            { value: "minimal", label: "Minimal" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra high" }
          ]
        },
        "gpt-5.6-luna": {
          defaultValue: "medium",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" }
          ]
        }
      },
      speeds: [],
      modelConfigurable: true,
      reasoningConfigurable: false,
      skills: [],
      behavior: {
        collapseModelOptionsToLatest: false,
        modelOptionsAuthoritative: false,
        refreshModelOptionsAfterSettings: false,
        prewarmDraftSession: false,
        planModeExclusiveWithPermissionMode: false
      },
      loadedAtUnixMs: 1
    };
    const { result, rerender } = renderHook(
      ({ model }: { model: string }) => {
        const draftSettingsBySessionId = {
          "session-1": {
            model,
            reasoningEffort: "high" as const
          }
        };
        return useAgentGUIComposerPresentation({
          activeConversation: null,
          activeConversationId: "session-1",
          activeEngineSession: null,
          activeSessionState: null,
          agentActivityRuntime: {
            projectPathIsRemote: false
          } as AgentActivityRuntime,
          composerSupport: composerSettingsSupportFromOptions(options, null),
          composerOptionsLoading: false,
          composerTargetProvider: "opencode",
          data,
          defaultReasoningEffort: "high",
          draftSettingsBySessionId,
          draftSettingsBySessionIdRef: { current: draftSettingsBySessionId },
          onDataChangeRef: { current: vi.fn() },
          normalizedProviderTargets: [],
          providerComposerOptions: options,
          selectedComposerTargetData: target,
          selectedProjectPath: null,
          setDraftSettingsBySessionId: vi.fn()
        });
      },
      { initialProps: { model: "opencode/big-pickle" } }
    );

    expect(
      result.current.stableComposerSettings.availableReasoningEfforts
    ).toEqual([]);
    expect(
      result.current.stableComposerSettings.selectedReasoningEffortValue
    ).toBeNull();
    expect(
      result.current.stableComposerSettings.draftSettings.reasoningEffort
    ).toBeNull();

    rerender({ model: "gpt-5.6-sol" });

    expect(
      result.current.stableComposerSettings.availableReasoningEfforts.map(
        (option) => option.value
      )
    ).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(
      result.current.stableComposerSettings.selectedReasoningEffortValue
    ).toBe("high");

    rerender({ model: "gpt-5.6-luna" });

    expect(
      result.current.stableComposerSettings.availableReasoningEfforts.map(
        (option) => option.value
      )
    ).toEqual(["low", "medium"]);
    expect(
      result.current.stableComposerSettings.selectedReasoningEffortValue
    ).toBe("medium");

    rerender({ model: "opencode/big-pickle" });

    expect(
      result.current.stableComposerSettings.availableReasoningEfforts
    ).toEqual([]);
    expect(
      result.current.stableComposerSettings.selectedReasoningEffortValue
    ).toBeNull();
  });

  describe("aggregated model plans in the model list", () => {
    const relayPlan: AgentActivityModelPlanSummary = {
      id: "mp-relay",
      name: "中转接入点",
      protocol: "openai",
      enabled: true,
      status: "ready",
      models: [{ id: "x-ai/grok-4.5", name: "Grok 4.5" }],
      defaultModel: "x-ai/grok-4.5"
    };
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
    const codexOptions = (
      overrides: Partial<AgentActivityComposerOptions> = {}
    ): AgentActivityComposerOptions =>
      ({
        provider: "codex",
        capabilities: null,
        models: [{ value: "gpt-5.3-codex", label: "GPT-5.3 Codex" }],
        reasoningEfforts: [],
        speeds: [],
        modelConfigurable: true,
        skills: [],
        behavior: {} as AgentActivityComposerOptions["behavior"],
        loadedAtUnixMs: 1,
        ...overrides
      }) as AgentActivityComposerOptions;
    const renderPresentation = (options: AgentActivityComposerOptions | null) =>
      renderHook(() =>
        useAgentGUIComposerPresentation({
          activeConversation: null,
          activeConversationId: null,
          activeEngineSession: null,
          activeSessionState: null,
          agentActivityRuntime: {
            projectPathIsRemote: false,
            listModelPlans: vi.fn(async () => ({ plans: [relayPlan] }))
          } as unknown as AgentActivityRuntime,
          composerSupport: composerSettingsSupportFromOptions(options, null),
          composerOptionsLoading: false,
          composerTargetProvider: "codex",
          data,
          defaultReasoningEffort: "high",
          draftSettingsBySessionId: {},
          draftSettingsBySessionIdRef: { current: {} },
          onDataChangeRef: { current: vi.fn() },
          normalizedProviderTargets: [],
          providerComposerOptions: options,
          selectedComposerTargetData: target,
          selectedProjectPath: null,
          setDraftSettingsBySessionId: vi.fn(),
          workspaceId: "workspace-1"
        })
      );

    it("keeps provider-native models alongside compatible plan models", async () => {
      const { result } = renderPresentation(codexOptions());
      await waitFor(() => {
        expect(
          result.current.stableComposerSettings.availableModels.length
        ).toBeGreaterThan(1);
      });
      const values = result.current.stableComposerSettings.availableModels.map(
        (option) => option.value
      );
      expect(values).toContain("gpt-5.3-codex");
      expect(
        values.some((value) => value.startsWith("model-plan:mp-relay:"))
      ).toBe(true);
    });

    it("keeps the aggregate-only list for plan-bound targets", async () => {
      const { result } = renderPresentation(
        codexOptions({
          models: [{ value: "x-ai/grok-4.5", label: "Grok 4.5" }],
          modelPlan: { id: "mp-relay", name: "中转接入点" }
        })
      );
      // The list is non-empty before the async plan load completes (the
      // plan-bound target's native options render in the interim), so gate on
      // the aggregation landing, not on the first non-empty list.
      await waitFor(() => {
        expect(result.current.stableComposerSettings.aggregatedModelPlans).toBe(
          true
        );
      });
      const values = result.current.stableComposerSettings.availableModels.map(
        (option) => option.value
      );
      expect(values.length).toBeGreaterThan(0);
      expect(values.every((value) => value.startsWith("model-plan:"))).toBe(
        true
      );
    });

    it("stays in the loading state while options are absent even with plan entries", async () => {
      const { result } = renderPresentation(null);
      // Model support is unknown until options arrive: the menu must read as
      // loading with no selectable entries rather than presenting a
      // plan-model-only list as if it were the provider's catalog.
      await waitFor(() => {
        expect(result.current.modelPlans.length).toBeGreaterThan(0);
      });
      expect(result.current.stableComposerSettings.isSettingsLoading).toBe(
        true
      );
      expect(result.current.stableComposerSettings.availableModels).toEqual([]);
    });
  });

  describe("home default model verification (pure provider target)", () => {
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
    const settledCodexOptions = (
      overrides: Partial<AgentActivityComposerOptions> = {}
    ): AgentActivityComposerOptions =>
      ({
        provider: "codex",
        capabilities: null,
        models: [
          { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
          { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" }
        ],
        reasoningEfforts: [],
        speeds: [],
        modelConfigurable: true,
        skills: [],
        behavior: {
          collapseModelOptionsToLatest: false,
          // codex is deliberately NOT modelOptionsAuthoritative; the home
          // default policy must still refuse foreign bare models.
          modelOptionsAuthoritative: false,
          refreshModelOptionsAfterSettings: false,
          prewarmDraftSession: false,
          planModeExclusiveWithPermissionMode: false
        },
        loadedAtUnixMs: 1,
        ...overrides
      }) as AgentActivityComposerOptions;
    const renderHome = (input: {
      options: AgentActivityComposerOptions;
      drafts?: Record<string, AgentSessionComposerSettings>;
    }) => {
      const drafts = input.drafts ?? {};
      return renderHook(() =>
        useAgentGUIComposerPresentation({
          activeConversation: null,
          activeConversationId: null,
          activeEngineSession: null,
          activeSessionState: null,
          agentActivityRuntime: {
            projectPathIsRemote: false
          } as AgentActivityRuntime,
          composerSupport: composerSettingsSupportFromOptions(
            input.options,
            null
          ),
          composerOptionsLoading: false,
          composerTargetProvider: "codex",
          data,
          defaultReasoningEffort: "high",
          draftSettingsBySessionId: drafts,
          draftSettingsBySessionIdRef: { current: drafts },
          onDataChangeRef: { current: vi.fn() },
          normalizedProviderTargets: [],
          providerComposerOptions: input.options,
          selectedComposerTargetData: target,
          selectedProjectPath: null,
          setDraftSettingsBySessionId: vi.fn(),
          workspaceId: "workspace-1"
        })
      );
    };

    // Live P1: a plan session leaked its bare model into the codex node
    // defaults. The pure codex home composer displayed "x-ai/grok-4.5" and
    // submitted it, and the daemon rejected the create with 400. The home
    // default must never adopt a bare model that the settled provider-native
    // list rejects — it falls back to the provider default instead.
    it("does not adopt a bare plan model that settled provider options reject", () => {
      const { result } = renderHome({
        options: settledCodexOptions(),
        drafts: {
          [nodeDefaultDraftKey("codex", "local:codex")]: {
            model: "x-ai/grok-4.5"
          }
        }
      });
      expect(result.current.stableComposerSettings.draftSettings.model).toBe(
        null
      );
      expect(result.current.stableComposerSettings.selectedModelValue).toBe(
        null
      );
    });

    it("does not resurrect a rejected bare model from daemon effective settings", () => {
      const { result } = renderHome({
        options: settledCodexOptions({
          effectiveSettings: { model: "x-ai/grok-4.5" }
        })
      });
      expect(result.current.stableComposerSettings.draftSettings.model).toBe(
        null
      );
    });

    // Warm-catalog window: the daemon appends the requested model to the
    // settled catalog projection (provenance-marked requested entry), so the
    // list "contains" the poisoned model. It is not catalog testimony — the
    // home default must still fall back.
    it("does not adopt a bare plan model that rides the warm catalog only as a requested entry", () => {
      const { result } = renderHome({
        options: settledCodexOptions({
          models: [
            { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
            { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
            { value: "x-ai/grok-4.5", label: "x-ai/grok-4.5", requested: true }
          ],
          effectiveSettings: { model: "x-ai/grok-4.5" }
        }),
        drafts: {
          [nodeDefaultDraftKey("codex", "local:codex")]: {
            model: "x-ai/grok-4.5"
          }
        }
      });
      expect(result.current.stableComposerSettings.draftSettings.model).toBe(
        null
      );
      expect(result.current.stableComposerSettings.selectedModelValue).toBe(
        null
      );
    });

    it("keeps a home default the settled provider options verify", () => {
      const { result } = renderHome({
        options: settledCodexOptions(),
        drafts: {
          [nodeDefaultDraftKey("codex", "local:codex")]: {
            model: "gpt-5.6-sol"
          }
        }
      });
      expect(result.current.stableComposerSettings.draftSettings.model).toBe(
        "gpt-5.6-sol"
      );
    });

    it("keeps a paired plan model selection untouched", () => {
      const { result } = renderHome({
        options: settledCodexOptions(),
        drafts: {
          [nodeDefaultDraftKey("codex", "local:codex")]: {
            model: "x-ai/grok-4.5",
            modelPlanId: "mp-relay"
          }
        }
      });
      expect(result.current.stableComposerSettings.draftSettings.model).toBe(
        "x-ai/grok-4.5"
      );
      expect(
        result.current.stableComposerSettings.draftSettings.modelPlanId
      ).toBe("mp-relay");
    });
  });

  it("surfaces a failed options load as an error state instead of loading", () => {
    const data: AgentGUINodeData = {
      provider: "codex",
      agentTargetId: "workspace-agent:custom",
      lastActiveAgentSessionId: null
    };
    const target: AgentGUIComposerTargetData = {
      agentTargetId: "workspace-agent:custom",
      data,
      provider: "codex",
      targetId: "workspace-agent:custom"
    };
    const renderPresentation = (composerOptionsLoadFailed: boolean) =>
      renderHook(() =>
        useAgentGUIComposerPresentation({
          activeConversation: null,
          activeConversationId: null,
          activeEngineSession: null,
          activeSessionState: null,
          agentActivityRuntime: {
            projectPathIsRemote: false
          } as AgentActivityRuntime,
          composerSupport: composerSettingsSupportFromOptions(null, null),
          composerOptionsLoading: false,
          composerOptionsLoadFailed,
          composerTargetProvider: "codex",
          data,
          defaultReasoningEffort: "high",
          draftSettingsBySessionId: {},
          draftSettingsBySessionIdRef: { current: {} },
          onDataChangeRef: { current: vi.fn() },
          normalizedProviderTargets: [],
          providerComposerOptions: null,
          selectedComposerTargetData: target,
          selectedProjectPath: null,
          setDraftSettingsBySessionId: vi.fn()
        })
      );

    const failed = renderPresentation(true);
    expect(
      failed.result.current.stableComposerSettings.settingsLoadFailed
    ).toBe(true);
    expect(failed.result.current.stableComposerSettings.isSettingsLoading).toBe(
      false
    );

    const loading = renderPresentation(false);
    expect(
      loading.result.current.stableComposerSettings.settingsLoadFailed
    ).toBe(false);
    expect(
      loading.result.current.stableComposerSettings.isSettingsLoading
    ).toBe(true);
  });
});
