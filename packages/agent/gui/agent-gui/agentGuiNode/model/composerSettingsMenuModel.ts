import type { AgentGUIComposerSettingsVM } from "./agentGuiNodeTypes";

// Labels for the composer settings menus. Lives here (next to the pure menu
// model) so the model + the presentational component share one source; the
// component file re-exports it for existing importers.
export type AgentComposerSettingsMenuLabels = {
  modelLabel: string;
  modelSelectionLabel: string;
  defaultModel: string;
  inheritedUnavailable: string;
  loadingSettings: string;
  reasoningLabel: string;
  reasoningDegreeLabel: string;
  reasoningOptionMinimal: string;
  reasoningOptionLow: string;
  reasoningOptionMedium: string;
  reasoningOptionHigh: string;
  reasoningOptionXHigh: string;
  speedLabel: string;
  speedSelectionLabel: string;
  speedOptionStandard: string;
  speedOptionFast: string;
  permissionLabel: string;
  planModeLabel: string;
  permissionModeReadOnly?: string;
  permissionModeAuto?: string;
  permissionModeFullAccess?: string;
  modelDescriptions: {
    frontierComplexCoding: string;
    everydayCoding: string;
    smallFastCostEfficient: string;
    codingOptimized: string;
    ultraFastCoding: string;
    professionalLongRunning: string;
  };
};

export interface ComposerMenuOption {
  value: string;
  label: string;
  description?: string;
}

export interface ComposerMenuSection {
  /** Whether this dimension is configurable and has options to show. */
  show: boolean;
  /** The currently selected value ("" when none). */
  selectedValue: string;
  /** Display label for the current value (for the section/submenu trigger). */
  selectedLabel: string;
  /** Options with display labels already resolved. */
  options: ComposerMenuOption[];
}

export interface ComposerModelMenuModel {
  /** The trigger should be disabled / the menu not openable. */
  disabled: boolean;
  trigger: {
    isFast: boolean;
    modelLabel: string;
    reasoningLabel: string;
    combinedLabel: string;
    /** Render the single combined label vs. model + reasoning separately. */
    showCombined: boolean;
  };
  model: ComposerMenuSection;
  reasoning: ComposerMenuSection;
  speed: ComposerMenuSection;
}

/**
 * Pure derivation of everything the model/reasoning/speed menu needs to render,
 * from the composer view-model + labels. Keeping this free of React/radix makes
 * the menu's behavior unit-testable and the presentational component thin, so a
 * "nothing shows / nothing applies" bug is localizable to either this model or
 * the small render that consumes it.
 */
export function buildComposerModelMenuModel(
  composerSettings: AgentGUIComposerSettingsVM,
  labels: AgentComposerSettingsMenuLabels
): ComposerModelMenuModel {
  const modelItems = modelOptionsWithSelectedValue(composerSettings);
  const reasoningItems = reasoningOptionsWithSelectedValue(composerSettings);
  const speedItems = speedOptionsWithSelectedValue(composerSettings);

  const showModel =
    composerSettings.supportsModel &&
    modelItems.length > 0 &&
    !composerSettings.modelUnavailable;
  const showReasoning =
    composerSettings.supportsReasoningEffort &&
    reasoningItems.length > 0 &&
    !composerSettings.reasoningUnavailable;
  const showSpeed =
    composerSettings.supportsSpeed &&
    speedItems.length > 0 &&
    !composerSettings.speedUnavailable;

  const selectedModelValue = selectedComposerModelValue(composerSettings) ?? "";
  const selectedReasoningValue =
    selectedComposerReasoningValue(composerSettings) ?? "";
  const selectedSpeedValue = selectedComposerSpeedValue(composerSettings) ?? "";

  const modelLabel = resolveSelectedModelLabel(composerSettings, labels);
  const reasoningLabel = resolveSelectedReasoningLabel(
    composerSettings,
    labels
  );

  const disabled =
    composerSettings.isSettingsLoading ||
    (!showModel && !showReasoning && !showSpeed);

  return {
    disabled,
    trigger: {
      isFast: selectedSpeedValue === "fast",
      modelLabel,
      reasoningLabel,
      combinedLabel:
        modelLabel === reasoningLabel
          ? modelLabel
          : `${modelLabel} ${reasoningLabel}`.trim(),
      showCombined: modelLabel === reasoningLabel || reasoningLabel.length === 0
    },
    model: {
      show: showModel,
      selectedValue: selectedModelValue,
      selectedLabel: modelLabel,
      options: modelItems.map((option) => ({
        value: option.value,
        label: formatModelDisplayLabel(option.label),
        description: resolveModelDescription(option.description, labels)
      }))
    },
    reasoning: {
      show: showReasoning,
      selectedValue: selectedReasoningValue,
      selectedLabel: reasoningLabel,
      options: reasoningItems.map((option) => ({
        value: option.value,
        label: resolveReasoningOptionLabel(option.value, labels)
      }))
    },
    speed: {
      show: showSpeed,
      selectedValue: selectedSpeedValue,
      selectedLabel: resolveSpeedOptionLabel(selectedSpeedValue, labels),
      options: speedItems.map((option) => ({
        value: option.value,
        label: resolveSpeedOptionLabel(option.value, labels),
        description: option.description
      }))
    }
  };
}

export function formatModelDisplayLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) {
    return label;
  }
  const capitalized = trimmed.replace(
    /(^|[^A-Za-z0-9])([A-Za-z])/g,
    (_match, prefix: string, letter: string) =>
      `${prefix}${letter.toUpperCase()}`
  );
  return capitalized.replace(/gpt/gi, "GPT");
}

export function resolveModelDescription(
  description: string | undefined,
  labels: Pick<AgentComposerSettingsMenuLabels, "modelDescriptions">
): string | undefined {
  switch (description) {
    case "Frontier model for complex coding, research, and real-world work.":
      return labels.modelDescriptions.frontierComplexCoding;
    case "Strong model for everyday coding.":
      return labels.modelDescriptions.everydayCoding;
    case "Small, fast, and cost-efficient model for simpler coding tasks.":
      return labels.modelDescriptions.smallFastCostEfficient;
    case "Coding-optimized model.":
      return labels.modelDescriptions.codingOptimized;
    case "Ultra-fast coding model.":
      return labels.modelDescriptions.ultraFastCoding;
    case "Optimized for professional work and long-running agents.":
      return labels.modelDescriptions.professionalLongRunning;
    default:
      return description;
  }
}

function resolveSelectedModelLabel(
  composerSettings: AgentGUIComposerSettingsVM,
  labels: Pick<
    AgentComposerSettingsMenuLabels,
    "defaultModel" | "inheritedUnavailable" | "loadingSettings"
  >
): string {
  const selectedValue = selectedComposerModelValue(composerSettings);
  const selected = modelOptionsWithSelectedValue(composerSettings).find(
    (option) => option.value === selectedValue
  );
  if (selected) {
    return formatModelDisplayLabel(selected.label);
  }
  if (composerSettings.modelUnavailable) {
    return labels.inheritedUnavailable;
  }
  if (composerSettings.isSettingsLoading) {
    return labels.loadingSettings;
  }
  const firstAvailableModel = composerSettings.availableModels[0]?.label;
  if (firstAvailableModel) {
    return formatModelDisplayLabel(firstAvailableModel);
  }
  return labels.defaultModel;
}

function resolveSelectedReasoningLabel(
  composerSettings: AgentGUIComposerSettingsVM,
  labels: AgentComposerSettingsMenuLabels
): string {
  const selectedValue = selectedComposerReasoningValue(composerSettings);
  const selected = reasoningOptionsWithSelectedValue(composerSettings).find(
    (option) => option.value === selectedValue
  );
  if (selected) {
    const resolved = resolveReasoningOptionLabel(selected.value, labels);
    return resolved === selected.value && selected.label
      ? selected.label
      : resolved;
  }
  if (composerSettings.reasoningUnavailable) {
    return labels.inheritedUnavailable;
  }
  if (composerSettings.isSettingsLoading) {
    return "";
  }
  if (composerSettings.availableReasoningEfforts.length === 0) {
    return "";
  }
  return labels.reasoningLabel;
}

export function resolveReasoningOptionLabel(
  value: string,
  labels: Pick<
    AgentComposerSettingsMenuLabels,
    | "reasoningOptionMinimal"
    | "reasoningOptionLow"
    | "reasoningOptionMedium"
    | "reasoningOptionHigh"
    | "reasoningOptionXHigh"
  >
): string {
  switch (value) {
    case "minimal":
      return labels.reasoningOptionMinimal;
    case "low":
      return labels.reasoningOptionLow;
    case "medium":
      return labels.reasoningOptionMedium;
    case "high":
      return labels.reasoningOptionHigh;
    case "xhigh":
      return labels.reasoningOptionXHigh;
    default:
      return value;
  }
}

export function resolveSpeedOptionLabel(
  value: string,
  labels: Pick<
    AgentComposerSettingsMenuLabels,
    "speedOptionStandard" | "speedOptionFast"
  >
): string {
  switch (value) {
    case "standard":
      return labels.speedOptionStandard;
    case "fast":
      return labels.speedOptionFast;
    default:
      return value;
  }
}

function selectedComposerModelValue(
  composerSettings: AgentGUIComposerSettingsVM
): string | null {
  return (
    composerSettings.selectedModelValue ??
    composerSettings.draftSettings.model ??
    null
  );
}

function selectedComposerReasoningValue(
  composerSettings: AgentGUIComposerSettingsVM
): string | null {
  return (
    composerSettings.selectedReasoningEffortValue ??
    composerSettings.draftSettings.reasoningEffort ??
    null
  );
}

function selectedComposerSpeedValue(
  composerSettings: AgentGUIComposerSettingsVM
): string | null {
  return (
    composerSettings.selectedSpeedValue ??
    composerSettings.draftSettings.speed ??
    null
  );
}

function modelOptionsWithSelectedValue(
  composerSettings: AgentGUIComposerSettingsVM
): AgentGUIComposerSettingsVM["availableModels"] {
  return optionsWithSelectedValue(
    composerSettings.availableModels,
    selectedComposerModelValue(composerSettings)
  );
}

function reasoningOptionsWithSelectedValue(
  composerSettings: AgentGUIComposerSettingsVM
): AgentGUIComposerSettingsVM["availableReasoningEfforts"] {
  return optionsWithSelectedValue(
    composerSettings.availableReasoningEfforts,
    selectedComposerReasoningValue(composerSettings)
  );
}

function speedOptionsWithSelectedValue(
  composerSettings: AgentGUIComposerSettingsVM
): AgentGUIComposerSettingsVM["availableSpeeds"] {
  return optionsWithSelectedValue(
    composerSettings.availableSpeeds,
    selectedComposerSpeedValue(composerSettings)
  );
}

// Ensures the currently-selected value is always present as an option, even if
// the provider's advertised list does not include it (stale/custom values).
function optionsWithSelectedValue<T extends { value: string; label: string }>(
  options: readonly T[],
  selectedValue: string | null
): T[] {
  if (!selectedValue || options.some((o) => o.value === selectedValue)) {
    return [...options];
  }
  return [{ value: selectedValue, label: selectedValue } as T, ...options];
}
