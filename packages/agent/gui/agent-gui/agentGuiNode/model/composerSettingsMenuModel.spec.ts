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
      { value: "ultra", label: "ultra" }
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
      { value: "ultra", label: "Ultra" }
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

  it("preserves Claude ACP model descriptions", () => {
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
