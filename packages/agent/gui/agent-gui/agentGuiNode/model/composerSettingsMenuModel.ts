import type { AgentGUIComposerSettingsVM } from "./agentGuiNodeTypes";

// Labels for the composer settings menus. Lives here (next to the pure menu
// model) so the model + the presentational component share one source; the
// component file re-exports it for existing importers.
export type AgentComposerSettingsMenuLabels = {
  modelLabel: string;
  modelSelectionLabel: string;
  modelContextWindowSuffix: string;
  modelTooltipVersionLabel: string;
  defaultModel: string;
  loadingOptions: string;
  inheritedUnavailable: string;
  reasoningLabel: string;
  reasoningDegreeLabel: string;
  reasoningOptionDefault: string;
  reasoningOptionMinimal: string;
  reasoningOptionLow: string;
  reasoningOptionMedium: string;
  reasoningOptionHigh: string;
  reasoningOptionXHigh: string;
  reasoningOptionMax: string;
  speedLabel: string;
  speedSelectionLabel: string;
  speedOptionStandard: string;
  speedOptionStandardDescription: string;
  speedOptionFast: string;
  speedOptionFastDescription: string;
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
  summary?: string[];
  tooltip?: ComposerModelOptionTooltip;
}

export interface ComposerModelOptionTooltip {
  title: string;
  description?: string;
  contextWindow?: string;
  version?: string;
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
  // A single advertised effort gives the user no real choice, so hide the
  // menu entirely rather than showing a one-item dropdown.
  const showReasoning =
    composerSettings.supportsReasoningEffort &&
    reasoningItems.length > 1 &&
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
      options: modelItems.map((option) =>
        modelMenuOptionFromSettingOption(option, labels)
      )
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
        description:
          resolveSpeedOptionDescription(option.value, labels) ??
          option.description
      }))
    }
  };
}

function modelMenuOptionFromSettingOption(
  option: AgentGUIComposerSettingsVM["availableModels"][number],
  labels: AgentComposerSettingsMenuLabels
): ComposerMenuOption {
  const displayLabel = formatModelDisplayLabel(option.label);
  const description = resolveModelDescription(option.description, labels);
  const presentation = modelOptionPresentation({
    description,
    label: displayLabel,
    labels
  });
  return {
    value: option.value,
    label: presentation.label,
    ...(description ? { description } : {}),
    ...(presentation.summary.length > 0
      ? { summary: presentation.summary }
      : {}),
    ...(presentation.tooltip ? { tooltip: presentation.tooltip } : {})
  };
}

function modelOptionPresentation(input: {
  description: string | undefined;
  label: string;
  labels: Pick<
    AgentComposerSettingsMenuLabels,
    | "modelContextWindowSuffix"
    | "modelTooltipVersionLabel"
    | "reasoningOptionDefault"
    | "reasoningOptionMinimal"
    | "reasoningOptionLow"
    | "reasoningOptionMedium"
    | "reasoningOptionHigh"
    | "reasoningOptionXHigh"
    | "reasoningOptionMax"
    | "speedOptionFast"
  >;
}): {
  label: string;
  summary: string[];
  tooltip?: ComposerModelOptionTooltip;
} {
  const description = input.description?.trim() || "";
  const parsed = parseModelDescription(description);
  const label = shortModelDisplayLabel(input.label);
  const summary = uniqueNonEmpty([
    parsed.contextWindow?.summary,
    parsed.effort
      ? reasoningSummaryLabel(parsed.effort.summaryValue, input.labels)
      : null,
    parsed.speed === "fast" ? input.labels.speedOptionFast : null
  ]);
  const tooltipDescription =
    parsed.body || (description && !parsed.title ? description : "");
  const tooltip =
    description || summary.length > 0
      ? {
          title: parsed.title ?? label,
          ...(tooltipDescription ? { description: tooltipDescription } : {}),
          ...(parsed.contextWindow
            ? {
                contextWindow: `${parsed.contextWindow.summary} ${input.labels.modelContextWindowSuffix}`
              }
            : {}),
          ...(parsed.effort
            ? {
                version: `${input.labels.modelTooltipVersionLabel}: ${parsed.effort.version}`
              }
            : {})
        }
      : undefined;
  return { label, summary, ...(tooltip ? { tooltip } : {}) };
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function reasoningSummaryLabel(
  effort: string,
  labels: Pick<
    AgentComposerSettingsMenuLabels,
    | "reasoningOptionDefault"
    | "reasoningOptionMinimal"
    | "reasoningOptionLow"
    | "reasoningOptionMedium"
    | "reasoningOptionHigh"
    | "reasoningOptionXHigh"
    | "reasoningOptionMax"
  >
): string {
  return resolveReasoningOptionLabel(effort, labels);
}

function parseModelDescription(description: string): {
  body: string;
  contextWindow?: { summary: string };
  effort?: { summaryValue: string; version: string };
  speed?: "fast";
  title?: string;
} {
  const parts = description
    .split(/[·•\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const firstPart = parts[0] ?? description.trim();
  const contextWindow = contextWindowSummaryFromText(description);
  const effort = effortFromText(description);
  const speed = speedFromText(description);
  const title = titleFromDescriptionPrefix(firstPart, contextWindow?.raw);
  const bodyParts = (title ? parts.slice(1) : parts).filter(
    (part) => !effortFromText(part)
  );
  return {
    body: bodyParts.join(" · "),
    ...(contextWindow
      ? { contextWindow: { summary: contextWindow.summary } }
      : {}),
    ...(effort ? { effort } : {}),
    ...(speed ? { speed } : {}),
    ...(title ? { title } : {})
  };
}

function contextWindowSummaryFromText(
  text: string
): { raw: string; summary: string } | null {
  const match = text.match(
    /\b(\d+(?:\.\d+)?\s*[kKmM])\s+(?:token\s+)?context(?:\s+window)?\b/
  );
  if (!match?.[1]) {
    return null;
  }
  return {
    raw: match[0],
    summary: match[1].replace(/\s+/g, "").toUpperCase()
  };
}

function titleFromDescriptionPrefix(
  firstPart: string,
  contextText: string | undefined
): string | undefined {
  if (contextText) {
    const contextIndex = firstPart
      .toLowerCase()
      .indexOf(contextText.toLowerCase());
    if (contextIndex > 0) {
      const title = firstPart
        .slice(0, contextIndex)
        .replace(/\bwith\s*$/i, "")
        .trim();
      return title ? formatModelDisplayLabel(title) : undefined;
    }
  }
  if (/^[A-Za-z][A-Za-z0-9 ._-]*\d(?:[A-Za-z0-9 ._-]*)?$/.test(firstPart)) {
    return formatModelDisplayLabel(firstPart);
  }
  return undefined;
}

function effortFromText(
  text: string
): { summaryValue: string; version: string } | undefined {
  const effortMatch = text
    .toLowerCase()
    .match(/\b(minimal|low|medium|high|x[-\s]?high)\s+effort\b/);
  if (!effortMatch?.[1]) {
    return undefined;
  }
  return {
    summaryValue: effortMatch[1].replace(/\s+/g, "").replace("-", ""),
    version: effortMatch[0]
  };
}

function speedFromText(text: string): "fast" | undefined {
  return /\bfast\b/i.test(text) ? "fast" : undefined;
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

function shortModelDisplayLabel(label: string): string {
  const formatted = formatModelDisplayLabel(label.replace(/\([^)]*\)/g, ""));
  const family = formatted.trim().split(/\s+/)[0];
  switch (family?.toLowerCase()) {
    case "default":
    case "opus":
    case "sonnet":
    case "haiku":
      return family;
    default:
      return formatted.trim() || label;
  }
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
    "defaultModel" | "inheritedUnavailable" | "loadingOptions"
  >
): string {
  const selectedValue = selectedComposerModelValue(composerSettings);
  const selected = modelOptionsWithSelectedValue(composerSettings).find(
    (option) => option.value === selectedValue
  );
  if (selected) {
    return shortModelDisplayLabel(selected.label);
  }
  // While composer options load, show a clear loading placeholder rather than
  // falling through to the "Default" label (which reads like a real choice).
  if (
    composerSettings.isSettingsLoading ||
    composerSettings.isModelOptionsLoading === true
  ) {
    return labels.loadingOptions;
  }
  if (composerSettings.modelUnavailable) {
    return labels.inheritedUnavailable;
  }
  const firstAvailableModel = composerSettings.availableModels[0]?.label;
  if (firstAvailableModel) {
    return shortModelDisplayLabel(firstAvailableModel);
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
    | "reasoningOptionDefault"
    | "reasoningOptionMinimal"
    | "reasoningOptionLow"
    | "reasoningOptionMedium"
    | "reasoningOptionHigh"
    | "reasoningOptionXHigh"
    | "reasoningOptionMax"
  >
): string {
  switch (value) {
    case "default":
      return labels.reasoningOptionDefault;
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
    case "max":
      return labels.reasoningOptionMax;
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

function resolveSpeedOptionDescription(
  value: string,
  labels: Pick<
    AgentComposerSettingsMenuLabels,
    "speedOptionStandardDescription" | "speedOptionFastDescription"
  >
): string | undefined {
  switch (value) {
    case "standard":
      return labels.speedOptionStandardDescription;
    case "fast":
      return labels.speedOptionFastDescription;
    default:
      return undefined;
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
