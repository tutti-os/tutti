// Agent GUI controller — pure composer target and settings presentation policy.

import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
import type {
  AgentSessionComposerSettings,
  AgentSessionReasoningEffort,
  AgentSessionSpeed
} from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData, AgentGUIProvider } from "../../../types";
import type { ACPConfigOptionSelection } from "./agentGuiController.types";
import { reasoningSelectionForModelFromComposerOptions } from "./agentGuiController.composerHelpers";
import { normalizeOptionalText } from "./agentGuiController.promptHelpers";

export interface AgentGUIComposerTargetData {
  agentTargetId: string | null;
  data: AgentGUINodeData;
  provider: AgentGUIProvider;
  targetId: string;
}

export interface OptimisticComposerTarget {
  agentSessionId: string;
  target: AgentGUIComposerTargetData;
}

export function isConversationCreateActive(input: {
  activeConversationId: string | null;
  pendingConversationId: string | null;
}): boolean {
  return (
    input.pendingConversationId !== null &&
    (input.activeConversationId === null ||
      input.activeConversationId === input.pendingConversationId)
  );
}

export function composerTargetDataFromNodeData(
  data: AgentGUINodeData
): AgentGUIComposerTargetData {
  const agentTargetId = normalizeOptionalText(data.agentTargetId);
  return {
    agentTargetId,
    provider: data.provider,
    targetId: agentTargetId ?? `local:${data.provider}`,
    data
  };
}

export function composerTargetDataForConversation(input: {
  activeConversationId: string | null;
  data: AgentGUINodeData;
  optimisticTarget: OptimisticComposerTarget | null;
  selectedTarget: AgentGUIComposerTargetData;
}): AgentGUIComposerTargetData {
  if (input.activeConversationId === null) {
    return input.selectedTarget;
  }
  if (
    input.optimisticTarget?.agentSessionId === input.activeConversationId &&
    !nodeDataMatchesComposerTarget(input.data, input.optimisticTarget.target)
  ) {
    return input.optimisticTarget.target;
  }
  return composerTargetDataFromNodeData(input.data);
}

export function reconcileOptimisticComposerTarget(input: {
  activeConversationId: string | null;
  data: AgentGUINodeData;
  optimisticTarget: OptimisticComposerTarget | null;
}): OptimisticComposerTarget | null {
  const optimisticTarget = input.optimisticTarget;
  if (
    !optimisticTarget ||
    input.activeConversationId !== optimisticTarget.agentSessionId ||
    nodeDataMatchesComposerTarget(input.data, optimisticTarget.target)
  ) {
    return null;
  }
  return optimisticTarget;
}

export function nodeDataMatchesComposerTarget(
  data: AgentGUINodeData,
  target: AgentGUIComposerTargetData
): boolean {
  return (
    data.provider === target.provider &&
    normalizeOptionalText(data.agentTargetId) === target.agentTargetId
  );
}

export function isForegroundModelOptionsLoading(input: {
  modelOptionsLoading: boolean | undefined;
  selection: ACPConfigOptionSelection | null;
  supportsModel: boolean;
}): boolean {
  return (
    input.supportsModel &&
    input.modelOptionsLoading === true &&
    (input.selection === null || input.selection.options.length === 0)
  );
}

export function effectiveComposerSettingsFromOptions(
  options: AgentActivityComposerOptions | null
): AgentSessionComposerSettings | null {
  const settings = options?.effectiveSettings;
  if (!settings) {
    return null;
  }
  return {
    model: normalizeOptionalText(settings.model),
    reasoningEffort: normalizeOptionalText(
      settings.reasoningEffort
    ) as AgentSessionReasoningEffort | null,
    speed: normalizeOptionalText(settings.speed) as AgentSessionSpeed | null,
    planMode: settings.planMode ?? undefined,
    permissionModeId: normalizeOptionalText(settings.permissionModeId)
  };
}

function composerOptionValues(
  options: readonly { value: string }[]
): ReadonlySet<string> {
  return new Set(options.map((option) => option.value));
}

export function sanitizeComposerSettingsForOptions(
  settings: AgentSessionComposerSettings,
  options: AgentActivityComposerOptions | null
): AgentSessionComposerSettings {
  if (!options) {
    return settings;
  }
  const modelValues = composerOptionValues(options.models);
  const reasoningValues = composerOptionValues(options.reasoningEfforts);
  const speedValues = composerOptionValues(options.speeds ?? []);
  const permissionValues = new Set(
    options.permissionConfig?.modes.map((mode) => mode.id) ?? []
  );
  const model = normalizeOptionalText(settings.model);
  const reasoningEffort = normalizeOptionalText(settings.reasoningEffort);
  const speed = normalizeOptionalText(settings.speed);
  const permissionModeId = normalizeOptionalText(settings.permissionModeId);
  const modelReasoningSelection = reasoningSelectionForModelFromComposerOptions(
    options,
    reasoningEffort as AgentSessionReasoningEffort | null,
    model
  );
  return {
    ...settings,
    model:
      options.behavior?.modelOptionsAuthoritative === true &&
      model &&
      modelValues.size > 0 &&
      !modelValues.has(model)
        ? null
        : model,
    reasoningEffort:
      modelReasoningSelection !== null
        ? modelReasoningSelection.currentValue
        : options.reasoningConfigurable !== true
          ? null
          : reasoningEffort &&
              reasoningValues.size > 0 &&
              !reasoningValues.has(reasoningEffort)
            ? null
            : (reasoningEffort as AgentSessionReasoningEffort | null),
    speed:
      speed && speedValues.size > 0 && !speedValues.has(speed)
        ? null
        : (speed as AgentSessionSpeed | null),
    permissionModeId:
      permissionModeId &&
      permissionValues.size > 0 &&
      !permissionValues.has(permissionModeId)
        ? null
        : permissionModeId
  };
}

export function sanitizeComposerSettingsForTarget(input: {
  settings: AgentSessionComposerSettings;
  target: AgentGUIComposerTargetData;
  options: AgentActivityComposerOptions | null;
}): AgentSessionComposerSettings {
  if (!input.target.agentTargetId) {
    return input.settings;
  }
  return sanitizeComposerSettingsForOptions(input.settings, input.options);
}

export type ComposerNativeModelVerdict =
  | "verified"
  | "rejected"
  | "unverifiable";

/**
 * Verdict of a bare model id against the provider-native options list. Only
 * settled catalog entries are testimony:
 * - options missing or the model catalog still loading have no opinion
 *   ("unverifiable");
 * - requested-origin entries (daemon warm-catalog append of the requested
 *   model, selected-model bootstrap echo, GUI current-value append) mirror
 *   the request rather than the catalog and are excluded — a list with no
 *   catalog entries left proves nothing;
 * - as a fallback for options produced before provenance marking, a
 *   single-entry list mirroring the effective selection is recognized as the
 *   daemon's selected-model bootstrap echo (composerSelectedModelOptions)
 *   and proves nothing either;
 * - otherwise the catalog either contains the model ("verified") or
 *   positively rejects it ("rejected").
 */
export function verifyComposerModelAgainstNativeOptions(
  model: string,
  options: AgentActivityComposerOptions | null
): ComposerNativeModelVerdict {
  if (options === null || options.modelOptionsLoading === true) {
    return "unverifiable";
  }
  const catalogEntries = options.models.filter(
    (option) => option.requested !== true
  );
  if (catalogEntries.length === 0) {
    return "unverifiable";
  }
  const isSelectedModelEcho =
    catalogEntries.length === 1 &&
    catalogEntries[0]!.value === model &&
    normalizeOptionalText(options.effectiveSettings?.model) === model;
  if (isSelectedModelEcho) {
    return "unverifiable";
  }
  return catalogEntries.some((option) => option.value === model)
    ? "verified"
    : "rejected";
}

/**
 * Last gate before a session create leaves the GUI. A model may only travel
 * either as a {model, modelPlanId} pair (the daemon resolves the requested
 * plan and validates membership and protocol) or as a bare id positively
 * verified against the provider-native options list. Anything unverifiable —
 * options missing/failed, catalog still loading, an empty list, or the
 * daemon's selected-model bootstrap echo — is dropped together with rejected
 * ids so the daemon falls back to its default instead of rejecting the
 * create (fail-safe: better no model than a wrong one). A plan model leaked
 * bare into a provider bucket previously rode the echo/empty-list windows
 * into a daemon 400.
 */
export function enforceComposerModelBindingForCreate(
  settings: AgentSessionComposerSettings,
  options: AgentActivityComposerOptions | null
): AgentSessionComposerSettings {
  const model = normalizeOptionalText(settings.model);
  const modelPlanId = normalizeOptionalText(settings.modelPlanId);
  if (!model || modelPlanId) {
    return settings;
  }
  return verifyComposerModelAgainstNativeOptions(model, options) === "verified"
    ? settings
    : { ...settings, model: null, modelPlanId: null };
}

/**
 * Home-composer default policy: a pure provider target must never adopt a
 * bare model that the settled provider-native list rejects — it falls back
 * to the provider default instead of presenting (and later submitting) a
 * model the provider cannot run. Unlike the create gate this only acts on a
 * positive rejection: while options are missing or the catalog is loading
 * the stored default is left alone so a transient load state cannot destroy
 * a legitimate remembered model (the create gate still refuses to send
 * anything unverifiable).
 */
export function enforceComposerModelBindingForHomeDefaults(
  settings: AgentSessionComposerSettings,
  options: AgentActivityComposerOptions | null
): AgentSessionComposerSettings {
  const model = normalizeOptionalText(settings.model);
  const modelPlanId = normalizeOptionalText(settings.modelPlanId);
  if (!model || modelPlanId) {
    return settings;
  }
  return verifyComposerModelAgainstNativeOptions(model, options) === "rejected"
    ? { ...settings, model: null, modelPlanId: null }
    : settings;
}

export function resolvePresentedComposerSettings(input: {
  homeSettings: AgentSessionComposerSettings;
  optimisticSettings: AgentSessionComposerSettings | null;
  preloadedSettings: AgentSessionComposerSettings | null;
  sessionSettings: AgentSessionComposerSettings | null;
}): AgentSessionComposerSettings {
  const layers = [
    input.sessionSettings,
    input.optimisticSettings,
    input.preloadedSettings,
    input.homeSettings
  ];
  const firstText = (
    field: "model" | "reasoningEffort" | "speed" | "permissionModeId"
  ): string | null => {
    for (const layer of layers) {
      const value = normalizeOptionalText(layer?.[field]);
      if (value) {
        return value;
      }
    }
    return null;
  };
  const firstBoolean = (
    field: "planMode" | "browserUse" | "computerUse",
    fallback: boolean
  ): boolean => {
    for (const layer of layers) {
      const value = layer?.[field];
      if (typeof value === "boolean") {
        return value;
      }
    }
    return fallback;
  };
  return {
    model: firstText("model"),
    reasoningEffort: firstText(
      "reasoningEffort"
    ) as AgentSessionReasoningEffort | null,
    speed: firstText("speed") as AgentSessionSpeed | null,
    planMode: firstBoolean("planMode", false),
    browserUse: firstBoolean("browserUse", true),
    computerUse: firstBoolean("computerUse", true),
    permissionModeId: firstText("permissionModeId")
  };
}

export function resolveComposerSettingsPresentation(input: {
  active: boolean;
  homeSettings: AgentSessionComposerSettings;
  optimisticSettings?: AgentSessionComposerSettings | null;
  options: AgentActivityComposerOptions | null;
  permissionModeId?: string | null;
  sessionSettings?: AgentSessionComposerSettings | null;
}): AgentSessionComposerSettings {
  const sessionSettings =
    input.active &&
    (input.sessionSettings != null || Boolean(input.permissionModeId))
      ? {
          ...(input.sessionSettings ?? {}),
          permissionModeId:
            normalizeOptionalText(input.permissionModeId) ??
            normalizeOptionalText(input.sessionSettings?.permissionModeId)
        }
      : null;
  return resolvePresentedComposerSettings({
    sessionSettings,
    optimisticSettings: input.active
      ? (input.optimisticSettings ?? null)
      : input.homeSettings,
    preloadedSettings: effectiveComposerSettingsFromOptions(input.options),
    homeSettings: input.homeSettings
  });
}
