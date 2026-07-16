import type { AgentGUIComposerSettingsVM } from "./agentGuiNodeTypes";
import {
  collapseModelOptionsToLatest,
  groupModelOptionsByVendor
} from "./modelFamilies";
import {
  formatModelDisplayLabel,
  parseModelDescription,
  resolveModelDescription,
  shortModelDisplayLabel
} from "./composerModelDescriptionPresentation";

export {
  formatModelDisplayLabel,
  resolveModelDescription
} from "./composerModelDescriptionPresentation";

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
  /** Trigger copy when the composer-options load settled in an error. */
  optionsLoadFailed: string;
  /** Hover hint for the error trigger: explains that clicking retries. */
  optionsLoadFailedRetry: string;
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
  reasoningOptionUltra: string;
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
  model?: string;
  modelPlanId?: string;
  sourceName?: string;
  tier?: string;
  capabilities?: string[];
  effect?: "next_call" | "new_session";
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

export interface ComposerMenuOptionGroup {
  /** Vendor heading; null for the leading ungrouped entries (Auto etc.). */
  label: string | null;
  options: ComposerMenuOption[];
}

/** UI-local menu state fed into the pure model (search + history chrome). */
export interface ComposerModelMenuLocalState {
  /** Raw filter text typed into the menu's search input. */
  searchQuery?: string;
  /** Favorite model ids for the composer target (localStorage chrome). */
  favoriteModelIds?: readonly string[];
  /** Most-recent-first model ids picked for the target (localStorage chrome). */
  recentModelIds?: readonly string[];
  /** Exact Model Plan source selected by the aggregate-list filter. */
  sourceFilter?: string;
}

/** Render the model filter input once the list exceeds this option count. */
export const COMPOSER_MODEL_SEARCH_THRESHOLD = 8;

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
  model: ComposerMenuSection & {
    /**
     * Vendor-grouped view of `options` (Claude / GPT / ...); empty
     * when the provider does not collapse its model list, in which case the
     * menu renders the flat `options`.
     */
    groups: ComposerMenuOptionGroup[];
    /** Bound model access plan for the menu header badge; null when none. */
    plan: { id: string; name: string } | null;
    /**
     * Plan-bound targets carry the source plan name in each option's
     * `description`; render it as inline secondary text instead of the
     * model-tooltip treatment.
     */
    optionDescriptionInline: boolean;
    /** The list is long enough to render the filter input. */
    searchEnabled: boolean;
    /** Distinct Model Plan sources available for explicit filtering. */
    sourceFilters: string[];
    /** Applied source filter ("" means all sources). */
    sourceFilter: string;
    /** Normalized applied filter ("" when none). */
    searchQuery: string;
    /** Favorites group shown above recents; deduped out of `options`. */
    favoriteOptions: ComposerMenuOption[];
    /** Recently used group (most recent first); deduped out of `options`. */
    recentOptions: ComposerMenuOption[];
    /** Every favorited value present in the list, for star toggle states. */
    favoriteValues: string[];
  };
  reasoning: ComposerMenuSection;
  speed: ComposerMenuSection;
  /**
   * Active session with mid-session model switch support: the menu footer
   * shows the "applies from the next request" hint.
   */
  switchEffectHint: boolean;
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
  labels: AgentComposerSettingsMenuLabels,
  localState: ComposerModelMenuLocalState = {}
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
  // Only surface an effort label when the reasoning control is actually shown.
  // Providers such as Cursor keep a stale/default draft effort ("high") even
  // though reasoning is not configurable; showing it next to the model name
  // reads like a real selection the user cannot change.
  const reasoningLabel = showReasoning
    ? resolveSelectedReasoningLabel(composerSettings, labels)
    : "";

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
    model: (() => {
      const allOptions = modelItems.map((option) =>
        modelMenuOptionFromSettingOption(option, labels)
      );
      const searchEnabled =
        composerSettings.aggregatedModelPlans === true ||
        allOptions.length > COMPOSER_MODEL_SEARCH_THRESHOLD;
      const searchQuery = searchEnabled
        ? (localState.searchQuery ?? "").trim()
        : "";
      const sourceFilters = Array.from(
        new Set(
          allOptions
            .map((option) => option.sourceName?.trim() ?? "")
            .filter(Boolean)
        )
      );
      const requestedSourceFilter = localState.sourceFilter?.trim() ?? "";
      const sourceFilter = sourceFilters.includes(requestedSourceFilter)
        ? requestedSourceFilter
        : "";
      const visibleOptions = filterComposerModelMenuOptions(
        allOptions,
        searchQuery,
        sourceFilter
      );
      const favoriteValueSet = new Set(
        (localState.favoriteModelIds ?? [])
          .map((value) => value.trim())
          .filter(Boolean)
      );
      const favoriteValues = allOptions
        .map((option) => option.value)
        .filter((value) => favoriteValueSet.has(value));
      const favoriteOptions = visibleOptions.filter((option) =>
        favoriteValueSet.has(option.value)
      );
      const visibleOptionsByValue = new Map(
        visibleOptions.map((option) => [option.value, option])
      );
      const recentOptions = (localState.recentModelIds ?? [])
        .map((value) => visibleOptionsByValue.get(value.trim()))
        .filter(
          (option): option is ComposerMenuOption =>
            option !== undefined && !favoriteValueSet.has(option.value)
        );
      const pinnedValues = new Set([
        ...favoriteOptions.map((option) => option.value),
        ...recentOptions.map((option) => option.value)
      ]);
      const options = visibleOptions.filter(
        (option) => !pinnedValues.has(option.value)
      );
      return {
        show: showModel,
        selectedValue: selectedModelValue,
        selectedLabel: modelLabel,
        options,
        groups:
          showModel && composerSettings.collapseModelOptionsToLatest
            ? groupModelOptionsByVendor(options).filter(
                (group) => group.options.length > 0
              )
            : [],
        plan: composerSettings.modelPlan
          ? {
              id: composerSettings.modelPlan.id,
              name: composerSettings.modelPlan.name
            }
          : null,
        optionDescriptionInline:
          Boolean(composerSettings.modelPlan) ||
          composerSettings.aggregatedModelPlans === true,
        searchEnabled,
        sourceFilters,
        sourceFilter,
        searchQuery,
        favoriteOptions,
        recentOptions,
        favoriteValues
      };
    })(),
    reasoning: {
      show: showReasoning,
      selectedValue: selectedReasoningValue,
      selectedLabel: reasoningLabel,
      options: reasoningItems.map((option) => ({
        value: option.value,
        label: resolveReasoningOptionLabel(option.value, labels, option.label)
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
    },
    switchEffectHint:
      showModel && composerSettings.modelSwitchTakesEffectNextTurn === true
  };
}

/** Case-insensitive search plus an exact Model Plan source filter. */
export function filterComposerModelMenuOptions(
  options: readonly ComposerMenuOption[],
  searchQuery: string,
  sourceFilter = ""
): ComposerMenuOption[] {
  const query = searchQuery.trim().toLowerCase();
  const source = sourceFilter.trim();
  return options.filter((option) => {
    if (source && option.sourceName?.trim() !== source) {
      return false;
    }
    if (!query) {
      return true;
    }
    return [
      option.label,
      option.value,
      option.description,
      option.sourceName,
      option.tier,
      option.effect,
      ...(option.capabilities ?? [])
    ].some((value) => value?.toLowerCase().includes(query));
  });
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
    ...(option.model ? { model: option.model } : {}),
    ...(option.modelPlanId ? { modelPlanId: option.modelPlanId } : {}),
    ...(option.sourceName ? { sourceName: option.sourceName } : {}),
    ...(option.tier ? { tier: option.tier } : {}),
    ...(option.capabilities ? { capabilities: option.capabilities } : {}),
    ...(option.effect ? { effect: option.effect } : {}),
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
    | "reasoningOptionUltra"
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
    | "reasoningOptionUltra"
  >
): string {
  return resolveReasoningOptionLabel(effort, labels);
}

function resolveSelectedModelLabel(
  composerSettings: AgentGUIComposerSettingsVM,
  labels: Pick<
    AgentComposerSettingsMenuLabels,
    | "defaultModel"
    | "inheritedUnavailable"
    | "loadingOptions"
    | "optionsLoadFailed"
  >
): string {
  const selectedValue = selectedComposerModelValue(composerSettings);
  const selected = modelOptionsWithSelectedValue(composerSettings).find(
    (option) => option.value === selectedValue
  );
  if (selected) {
    return shortModelDisplayLabel(selected.label);
  }
  // A terminal load failure must read as an error, never as loading.
  if (composerSettings.settingsLoadFailed === true) {
    return labels.optionsLoadFailed;
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
    return resolveReasoningOptionLabel(selected.value, labels, selected.label);
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
    | "reasoningOptionUltra"
  >,
  providerLabel?: string
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
    case "ultra":
      return labels.reasoningOptionUltra;
    default:
      return providerLabel?.trim() || value;
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
  // Collapse to the latest version per family first, then re-guarantee the
  // selected value: a previously chosen older version stays visible (and
  // selectable) even though its family collapsed to a newer release.
  const models = composerSettings.collapseModelOptionsToLatest
    ? collapseModelOptionsToLatest(composerSettings.availableModels)
    : composerSettings.availableModels;
  return optionsWithSelectedValue(
    models,
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
