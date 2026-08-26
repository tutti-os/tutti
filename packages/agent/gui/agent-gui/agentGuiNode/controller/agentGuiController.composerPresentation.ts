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

export interface AgentGUIActiveSessionTarget {
  agentTargetId: string | null;
  agentSessionId: string;
  provider: AgentGUIProvider;
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

/**
 * Resolve the device-local model-history owner without guessing an active
 * Session's identity. Home may use its stable target fallback, while an active
 * Session without a canonical Agent Target fails closed.
 */
export function composerModelChoiceHistoryTargetId(input: {
  activeConversationId: string | null;
  target: Pick<AgentGUIComposerTargetData, "agentTargetId" | "targetId">;
}): string | null {
  const agentTargetId = normalizeOptionalText(input.target.agentTargetId);
  if (agentTargetId) {
    return agentTargetId;
  }
  return input.activeConversationId === null
    ? normalizeOptionalText(input.target.targetId)
    : null;
}

export function composerTargetDataForConversation(input: {
  activeConversationId: string | null;
  activeSessionTarget: AgentGUIActiveSessionTarget | null;
  data: AgentGUINodeData;
  optimisticTarget: OptimisticComposerTarget | null;
  selectedTarget: AgentGUIComposerTargetData;
}): AgentGUIComposerTargetData {
  if (input.activeConversationId === null) {
    return input.selectedTarget;
  }
  if (
    input.optimisticTarget?.agentSessionId === input.activeConversationId &&
    (!input.activeSessionTarget ||
      input.activeSessionTarget.agentSessionId !== input.activeConversationId ||
      !nodeDataMatchesComposerTarget(input.data, input.optimisticTarget.target))
  ) {
    return input.optimisticTarget.target;
  }
  if (
    !input.activeSessionTarget ||
    input.activeSessionTarget.agentSessionId !== input.activeConversationId
  ) {
    return {
      agentTargetId: null,
      provider: input.data.provider,
      targetId: "__active_session_loading__",
      data: {
        ...input.data,
        agentTargetId: null
      }
    };
  }
  const activeAgentTargetId = normalizeOptionalText(
    input.activeSessionTarget.agentTargetId
  );
  const dataMatchesActiveSessionTarget =
    input.data.provider === input.activeSessionTarget.provider &&
    normalizeOptionalText(input.data.agentTargetId) === activeAgentTargetId;
  return {
    agentTargetId: activeAgentTargetId,
    provider: input.activeSessionTarget.provider,
    targetId:
      activeAgentTargetId ?? `local:${input.activeSessionTarget.provider}`,
    data: dataMatchesActiveSessionTarget
      ? input.data
      : {
          ...input.data,
          agentTargetId: activeAgentTargetId,
          provider: input.activeSessionTarget.provider
        }
  };
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

export interface ComposerNativeModelOptionsTestimony {
  models: readonly {
    value: string;
    requested?: boolean;
  }[];
  modelOptionsLoading?: boolean;
  effectiveSettings?: {
    model?: string | null;
  } | null;
}

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
  options: ComposerNativeModelOptionsTestimony | null
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
 * Home-composer default policy: a pure provider target must never adopt a
 * bare model that the settled provider-native list rejects — it falls back
 * to the provider default instead of presenting (and later submitting) a
 * model the provider cannot run. This only acts on a positive rejection:
 * while options are missing or the catalog is loading the stored default is
 * left alone so a transient load state cannot destroy a legitimate
 * remembered model.
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
    field:
      | "codexSaverMode"
      | "rtkSaverMode"
      | "planMode"
      | "browserUse"
      | "computerUse",
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
    codexSaverMode: firstBoolean("codexSaverMode", false),
    rtkSaverMode: firstBoolean("rtkSaverMode", false),
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
