import { describe, expect, it } from "vitest";
import type { AgentGUIComposerSettingsVM } from "./agentGuiNodeTypes";
import {
  buildComposerModelMenuModel,
  formatModelDisplayLabel,
  type AgentComposerSettingsMenuLabels
} from "./composerSettingsMenuModel";

const labels: AgentComposerSettingsMenuLabels = {
  modelLabel: "Model",
  modelSelectionLabel: "Model selection",
  modelContextWindowSuffix: "context window",
  modelTooltipVersionLabel: "Version",
  defaultModel: "Default model",
  loadingOptions: "Loading…",
  optionsLoadFailed: "Failed to load",
  optionsLoadFailedRetry: "Options failed to load. Click to retry.",
  inheritedUnavailable: "Unavailable",
  reasoningLabel: "Reasoning",
  reasoningDegreeLabel: "Reasoning degree",
  reasoningOptionDefault: "Default",
  reasoningOptionMinimal: "Minimal",
  reasoningOptionLow: "Low",
  reasoningOptionMedium: "Medium",
  reasoningOptionHigh: "High",
  reasoningOptionXHigh: "X-High",
  reasoningOptionMax: "Max",
  reasoningOptionUltra: "Ultra",
  speedLabel: "Speed",
  speedSelectionLabel: "Speed",
  speedOptionStandard: "Standard",
  speedOptionStandardDescription: "Standard localized",
  speedOptionFast: "Fast",
  speedOptionFastDescription: "Fast localized",
  permissionLabel: "Permissions",
  planModeLabel: "Plan",
  modelDescriptions: {
    frontierComplexCoding: "Frontier",
    everydayCoding: "Everyday",
    smallFastCostEfficient: "Small",
    codingOptimized: "Coding",
    ultraFastCoding: "Ultra",
    professionalLongRunning: "Pro"
  }
};

function vm(
  overrides: Partial<AgentGUIComposerSettingsVM> = {}
): AgentGUIComposerSettingsVM {
  return {
    sessionSettings: null,
    draftSettings: {
      model: "gpt-5.5",
      reasoningEffort: "high",
      speed: "standard",
      planMode: false,
      permissionModeId: "preset"
    },
    supportsModel: true,
    supportsReasoningEffort: true,
    supportsSpeed: true,
    speedUnavailable: false,
    availableSpeeds: [
      { value: "standard", label: "standard", description: "Standard speed" },
      { value: "fast", label: "fast", description: "1.5x speed" }
    ],
    supportsPlanMode: false,
    isSettingsLoading: false,
    modelUnavailable: false,
    reasoningUnavailable: false,
    availableModels: [
      { value: "gpt-5.5", label: "gpt-5.5" },
      { value: "gpt-5.4", label: "gpt-5.4" }
    ],
    availableReasoningEfforts: [
      { value: "default", label: "Default" },
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
      { value: "max", label: "Max" },
      { value: "ultra", label: "ultra" },
      { value: "none", label: "Off" }
    ],
    ...overrides
  };
}

describe("buildComposerModelMenuModel", () => {
  it("models the trigger, sections and resolved option labels", () => {
    const menu = buildComposerModelMenuModel(vm(), labels);

    expect(menu.disabled).toBe(false);
    expect(menu.trigger).toMatchObject({
      isFast: false,
      modelLabel: "GPT-5.5",
      reasoningLabel: "High",
      combinedLabel: "GPT-5.5 High",
      showCombined: false
    });

    expect(menu.model.show).toBe(true);
    expect(menu.model.selectedValue).toBe("gpt-5.5");
    expect(menu.model.options).toEqual([
      { value: "gpt-5.5", label: "GPT-5.5", description: undefined },
      { value: "gpt-5.4", label: "GPT-5.4", description: undefined }
    ]);

    expect(menu.reasoning.show).toBe(true);
    expect(menu.reasoning.selectedLabel).toBe("High");
    expect(menu.reasoning.options).toEqual([
      { value: "default", label: "Default" },
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
      { value: "max", label: "Max" },
      { value: "ultra", label: "Ultra" },
      { value: "none", label: "Off" }
    ]);

    expect(menu.speed.show).toBe(true);
    expect(menu.speed.selectedLabel).toBe("Standard");
    expect(menu.speed.options).toEqual([
      {
        value: "standard",
        label: "Standard",
        description: "Standard localized"
      },
      { value: "fast", label: "Fast", description: "Fast localized" }
    ]);
  });

  it("localizes ultra in the final menu presentation", () => {
    const menu = buildComposerModelMenuModel(
      vm({
        draftSettings: {
          model: "gpt-5.5",
          reasoningEffort: "ultra",
          speed: "standard",
          planMode: false,
          permissionModeId: "preset"
        },
        selectedReasoningEffortValue: "ultra",
        availableReasoningEfforts: [{ value: "ultra", label: "ultra" }]
      }),
      { ...labels, reasoningOptionUltra: "极致" }
    );

    expect(menu.reasoning.selectedLabel).toBe("极致");
    expect(menu.reasoning.options).toEqual([{ value: "ultra", label: "极致" }]);
  });

  it("uses the provider-localized label for an extensible reasoning value", () => {
    const menu = buildComposerModelMenuModel(
      vm({
        draftSettings: {
          model: "gpt-5.6-sol",
          reasoningEffort: "none",
          speed: "standard",
          planMode: false,
          permissionModeId: "preset"
        },
        selectedReasoningEffortValue: "none",
        availableReasoningEfforts: [{ value: "none", label: "关闭" }]
      }),
      labels
    );

    expect(menu.reasoning.selectedLabel).toBe("关闭");
    expect(menu.reasoning.options).toEqual([{ value: "none", label: "关闭" }]);
  });

  it("localizes ultra effort in model summaries", () => {
    const menu = buildComposerModelMenuModel(
      vm({
        availableModels: [
          {
            value: "gpt-5.6-sol",
            label: "GPT-5.6-Sol",
            description: "GPT-5.6 Sol · ultra effort"
          }
        ],
        selectedModelValue: "gpt-5.6-sol"
      }),
      labels
    );

    expect(menu.model.options[0]).toMatchObject({
      summary: ["Ultra"],
      tooltip: { version: "Version: ultra effort" }
    });
  });

  it("marks the trigger as fast and localizes model descriptions", () => {
    const menu = buildComposerModelMenuModel(
      vm({
        draftSettings: {
          model: "gpt-5.5",
          reasoningEffort: "high",
          speed: "fast",
          planMode: false,
          permissionModeId: "preset"
        },
        availableModels: [
          {
            value: "gpt-5.5",
            label: "GPT-5.5",
            description:
              "Frontier model for complex coding, research, and real-world work."
          }
        ]
      }),
      labels
    );

    expect(menu.trigger.isFast).toBe(true);
    expect(menu.speed.selectedLabel).toBe("Fast");
    expect(menu.model.options[0]).toMatchObject({
      description: "Frontier",
      tooltip: {
        description: "Frontier",
        title: "GPT-5.5"
      }
    });
  });

  it("preserves Claude Code model descriptions", () => {
    const menu = buildComposerModelMenuModel(
      vm({
        draftSettings: {
          model: "default",
          reasoningEffort: "high",
          speed: "standard",
          planMode: false,
          permissionModeId: "preset"
        },
        selectedModelValue: "default",
        availableModels: [
          {
            value: "default",
            label: "Default (recommended)",
            description:
              "Opus 4.8 with 1M context · Most capable for complex work"
          },
          {
            value: "sonnet",
            label: "Sonnet",
            description: "Sonnet 4.6 · Best for everyday tasks · medium effort"
          },
          {
            value: "opus",
            label: "Opus 4.8",
            description:
              "Opus 4.8 with 1M context · Most capable for complex work"
          }
        ]
      }),
      labels
    );

    expect(menu.trigger.modelLabel).toBe("Default");
    expect(menu.model.options).toEqual([
      {
        value: "default",
        label: "Default",
        description: "Opus 4.8 with 1M context · Most capable for complex work",
        summary: ["1M"],
        tooltip: {
          contextWindow: "1M context window",
          description: "Most capable for complex work",
          title: "Opus 4.8"
        }
      },
      {
        value: "sonnet",
        label: "Sonnet",
        description: "Sonnet 4.6 · Best for everyday tasks · medium effort",
        summary: ["Medium"],
        tooltip: {
          description: "Best for everyday tasks",
          title: "Sonnet 4.6",
          version: "Version: medium effort"
        }
      },
      {
        value: "opus",
        label: "Opus",
        description: "Opus 4.8 with 1M context · Most capable for complex work",
        summary: ["1M"],
        tooltip: {
          contextWindow: "1M context window",
          description: "Most capable for complex work",
          title: "Opus 4.8"
        }
      }
    ]);
  });

  it("injects the selected value when missing from the advertised options", () => {
    const menu = buildComposerModelMenuModel(
      vm({
        selectedModelValue: "custom-model",
        draftSettings: {
          model: "custom-model",
          reasoningEffort: "high",
          speed: "standard",
          planMode: false,
          permissionModeId: "preset"
        }
      }),
      labels
    );

    expect(menu.model.selectedValue).toBe("custom-model");
    expect(menu.model.options[0]).toEqual({
      value: "custom-model",
      label: "Custom-Model",
      description: undefined
    });
  });

  it("collapses the model list to the latest version per family when enabled", () => {
    const menu = buildComposerModelMenuModel(
      vm({
        collapseModelOptionsToLatest: true,
        selectedModelValue: "claude-sonnet-5[thinking=true]",
        draftSettings: {
          model: "claude-sonnet-5[thinking=true]",
          reasoningEffort: "high",
          speed: "standard",
          planMode: false,
          permissionModeId: "preset"
        },
        availableModels: [
          { value: "default[]", label: "Auto" },
          {
            value: "claude-sonnet-4.6[thinking=true]",
            label: "claude-sonnet-4.6"
          },
          {
            value: "claude-sonnet-4.7[thinking=true]",
            label: "claude-sonnet-4.7"
          },
          { value: "claude-sonnet-5[thinking=true]", label: "claude-sonnet-5" },
          { value: "gpt-5.2[fast=false]", label: "gpt-5.2" },
          { value: "gpt-5.3-codex[fast=false]", label: "gpt-5.3-codex" }
        ]
      }),
      labels
    );

    expect(menu.model.options.map((option) => option.value)).toEqual([
      "default[]",
      "claude-sonnet-5[thinking=true]",
      "gpt-5.3-codex[fast=false]"
    ]);
  });

  it("keeps a selected older version visible after the family collapses", () => {
    const menu = buildComposerModelMenuModel(
      vm({
        collapseModelOptionsToLatest: true,
        selectedModelValue: "claude-sonnet-4.6[thinking=true]",
        draftSettings: {
          model: "claude-sonnet-4.6[thinking=true]",
          reasoningEffort: "high",
          speed: "standard",
          planMode: false,
          permissionModeId: "preset"
        },
        availableModels: [
          {
            value: "claude-sonnet-4.6[thinking=true]",
            label: "claude-sonnet-4.6"
          },
          { value: "claude-sonnet-5[thinking=true]", label: "claude-sonnet-5" }
        ]
      }),
      labels
    );

    const values = menu.model.options.map((option) => option.value);
    expect(values).toContain("claude-sonnet-5[thinking=true]");
    expect(values).toContain("claude-sonnet-4.6[thinking=true]");
    expect(menu.model.selectedValue).toBe("claude-sonnet-4.6[thinking=true]");
  });

  it("normalizes GPT casing while capitalizing each label segment", () => {
    expect(formatModelDisplayLabel("gpt-5.5")).toBe("GPT-5.5");
    expect(formatModelDisplayLabel("gpt-5.3-codex")).toBe("GPT-5.3-Codex");
    expect(formatModelDisplayLabel("Gpt-5.5-codex")).toBe("GPT-5.5-Codex");
    expect(formatModelDisplayLabel("vendor/gpt-5.5")).toBe("Vendor/GPT-5.5");
    expect(formatModelDisplayLabel("codex")).toBe("Codex");
    expect(formatModelDisplayLabel("custom-model")).toBe("Custom-Model");
  });

  it("hides dimensions that are unsupported or unavailable", () => {
    const menu = buildComposerModelMenuModel(
      vm({
        supportsSpeed: false,
        availableSpeeds: [],
        reasoningUnavailable: true
      }),
      labels
    );

    expect(menu.model.show).toBe(true);
    expect(menu.reasoning.show).toBe(false);
    expect(menu.speed.show).toBe(false);
    expect(menu.trigger.reasoningLabel).toBe("");
    expect(menu.trigger.showCombined).toBe(true);
  });

  it("does not show a stale default effort when reasoning is not configurable", () => {
    // Cursor-like: draft still carries the GUI default "high", but the
    // provider does not expose a reasoning selector.
    const menu = buildComposerModelMenuModel(
      vm({
        supportsReasoningEffort: false,
        availableReasoningEfforts: [],
        draftSettings: {
          model: "gpt-5.2[reasoning=medium,fast=false]",
          reasoningEffort: "high",
          speed: null,
          planMode: false,
          permissionModeId: "agent"
        },
        availableModels: [
          {
            value: "gpt-5.2[reasoning=medium,fast=false]",
            label: "gpt-5.2"
          }
        ],
        supportsSpeed: false,
        availableSpeeds: []
      }),
      labels
    );

    expect(menu.reasoning.show).toBe(false);
    expect(menu.trigger).toMatchObject({
      modelLabel: "GPT-5.2",
      reasoningLabel: "",
      combinedLabel: "GPT-5.2",
      showCombined: true
    });
  });

  it("shows the loading copy on the trigger while options load", () => {
    // No model resolved yet — the placeholder must read as loading, not the
    // "Default" fallback (which looks like a real choice).
    const loadingVm = (overrides: Partial<AgentGUIComposerSettingsVM>) =>
      vm({
        availableModels: [],
        draftSettings: {
          model: null,
          reasoningEffort: null,
          speed: null,
          planMode: false,
          permissionModeId: null
        },
        selectedModelValue: null,
        ...overrides
      });
    expect(
      buildComposerModelMenuModel(
        loadingVm({ isSettingsLoading: true }),
        labels
      ).trigger.modelLabel
    ).toBe("Loading…");
    expect(
      buildComposerModelMenuModel(
        loadingVm({ isModelOptionsLoading: true }),
        labels
      ).trigger.modelLabel
    ).toBe("Loading…");
  });

  it("shows the failure copy on the trigger after options failed to load", () => {
    const failedVm = vm({
      availableModels: [],
      availableReasoningEfforts: [],
      availableSpeeds: [],
      draftSettings: {
        model: null,
        reasoningEffort: null,
        speed: null,
        planMode: false,
        permissionModeId: null
      },
      isSettingsLoading: false,
      settingsLoadFailed: true
    });
    const menu = buildComposerModelMenuModel(failedVm, labels);
    expect(menu.trigger.modelLabel).toBe("Failed to load");
    expect(menu.trigger.modelLabel).not.toBe(labels.loadingOptions);
    expect(menu.disabled).toBe(true);
  });

  it("disables the menu while settings load or nothing is configurable", () => {
    expect(
      buildComposerModelMenuModel(vm({ isSettingsLoading: true }), labels)
        .disabled
    ).toBe(true);
    expect(
      buildComposerModelMenuModel(
        vm({
          supportsModel: false,
          supportsReasoningEffort: false,
          supportsSpeed: false,
          availableModels: [],
          availableReasoningEfforts: [],
          availableSpeeds: []
        }),
        labels
      ).disabled
    ).toBe(true);
  });
});

describe("buildComposerModelMenuModel plan, search and history", () => {
  function planVm(
    overrides: Partial<AgentGUIComposerSettingsVM> = {}
  ): AgentGUIComposerSettingsVM {
    return vm({
      modelPlan: { id: "plan-1", name: "Volc Coding Plan", protocol: "openai" },
      availableModels: [
        { value: "gpt-5.5", label: "gpt-5.5", description: "Volc Coding Plan" },
        { value: "gpt-5.4", label: "gpt-5.4", description: "Volc Coding Plan" }
      ],
      ...overrides
    });
  }

  function manyModels(count: number): AgentGUIComposerSettingsVM {
    return vm({
      availableModels: Array.from({ length: count }, (_, index) => ({
        value: `model-${index + 1}`,
        label: `model-${index + 1}`
      })),
      draftSettings: {
        model: "model-1",
        reasoningEffort: "high",
        speed: "standard",
        planMode: false,
        permissionModeId: "preset"
      }
    });
  }

  it("surfaces the bound plan and inline plan-name descriptions", () => {
    const menu = buildComposerModelMenuModel(planVm(), labels);
    expect(menu.model.plan).toEqual({ id: "plan-1", name: "Volc Coding Plan" });
    expect(menu.model.optionDescriptionInline).toBe(true);
    expect(menu.model.options[0]?.description).toBe("Volc Coding Plan");

    const withoutPlan = buildComposerModelMenuModel(vm(), labels);
    expect(withoutPlan.model.plan).toBeNull();
    expect(withoutPlan.model.optionDescriptionInline).toBe(false);
  });

  it("enables search above the threshold and searches model metadata", () => {
    const small = buildComposerModelMenuModel(vm(), labels);
    expect(small.model.searchEnabled).toBe(false);
    // Below the threshold the query is ignored entirely.
    expect(
      buildComposerModelMenuModel(vm(), labels, { searchQuery: "5.4" }).model
        .options
    ).toHaveLength(2);

    const large = buildComposerModelMenuModel(manyModels(10), labels);
    expect(large.model.searchEnabled).toBe(true);
    expect(large.model.options).toHaveLength(10);

    const filtered = buildComposerModelMenuModel(manyModels(10), labels, {
      searchQuery: "MODEL-1"
    });
    expect(filtered.model.searchQuery).toBe("MODEL-1");
    expect(filtered.model.options.map((option) => option.value)).toEqual([
      "model-1",
      "model-10"
    ]);
    expect(
      buildComposerModelMenuModel(manyModels(10), labels, {
        searchQuery: "no-match"
      }).model.options
    ).toHaveLength(0);

    const metadataMatch = buildComposerModelMenuModel(
      vm({
        aggregatedModelPlans: true,
        availableModels: [
          {
            value: "model-plan:plan-a:gpt-a",
            label: "GPT A",
            sourceName: "Plan A",
            tier: "flagship",
            capabilities: ["vision"],
            effect: "new_session"
          },
          ...manyModels(9).availableModels
        ]
      }),
      labels,
      { searchQuery: "vision" }
    );
    expect(metadataMatch.model.options.map((option) => option.value)).toEqual([
      "model-plan:plan-a:gpt-a"
    ]);
  });

  it("filters aggregated models by their Model Plan source", () => {
    const settings = vm({
      aggregatedModelPlans: true,
      availableModels: [
        {
          value: "model-plan:plan-a:gpt-a",
          label: "GPT A",
          sourceName: "Plan A"
        },
        {
          value: "model-plan:plan-b:gpt-b",
          label: "GPT B",
          sourceName: "Plan B"
        }
      ]
    });
    const unfiltered = buildComposerModelMenuModel(settings, labels);
    expect(unfiltered.model.searchEnabled).toBe(true);
    expect(unfiltered.model.sourceFilters).toEqual(["Plan A", "Plan B"]);

    const filtered = buildComposerModelMenuModel(settings, labels, {
      sourceFilter: "Plan B"
    });
    expect(filtered.model.sourceFilter).toBe("Plan B");
    expect(filtered.model.options.map((option) => option.value)).toEqual([
      "model-plan:plan-b:gpt-b"
    ]);
  });

  it("splits favorites and recents into pinned groups without duplicates", () => {
    const menu = buildComposerModelMenuModel(manyModels(10), labels, {
      favoriteModelIds: ["model-3", "model-9", "model-unknown"],
      recentModelIds: ["model-9", "model-2", "model-5"]
    });
    expect(menu.model.favoriteOptions.map((option) => option.value)).toEqual([
      "model-3",
      "model-9"
    ]);
    // model-9 is favorited, so recents keep only the rest, in recency order.
    expect(menu.model.recentOptions.map((option) => option.value)).toEqual([
      "model-2",
      "model-5"
    ]);
    expect(menu.model.favoriteValues).toEqual(["model-3", "model-9"]);
    const remaining = menu.model.options.map((option) => option.value);
    expect(remaining).not.toContain("model-3");
    expect(remaining).not.toContain("model-9");
    expect(remaining).not.toContain("model-2");
    expect(remaining).not.toContain("model-5");
    expect(remaining).toHaveLength(6);
  });

  it("applies the search filter to the pinned groups too", () => {
    const menu = buildComposerModelMenuModel(manyModels(10), labels, {
      favoriteModelIds: ["model-3"],
      recentModelIds: ["model-2"],
      searchQuery: "model-2"
    });
    expect(menu.model.favoriteOptions).toHaveLength(0);
    expect(menu.model.recentOptions.map((option) => option.value)).toEqual([
      "model-2"
    ]);
    expect(menu.model.options).toHaveLength(0);
  });

  it("shows the switch-effect hint only for active modelSwitch sessions", () => {
    expect(
      buildComposerModelMenuModel(
        vm({ modelSwitchTakesEffectNextTurn: true }),
        labels
      ).switchEffectHint
    ).toBe(true);
    expect(buildComposerModelMenuModel(vm(), labels).switchEffectHint).toBe(
      false
    );
    // The hint is a model-menu affordance: no model section, no hint.
    expect(
      buildComposerModelMenuModel(
        vm({
          modelSwitchTakesEffectNextTurn: true,
          supportsModel: false,
          availableModels: []
        }),
        labels
      ).switchEffectHint
    ).toBe(false);
  });
});
