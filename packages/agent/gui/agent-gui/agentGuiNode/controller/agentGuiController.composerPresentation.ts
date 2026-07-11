// Agent GUI controller — pure composer target and settings presentation policy.

import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
import type {
  AgentSessionComposerSettings,
  AgentSessionReasoningEffort,
  AgentSessionSpeed
} from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData, AgentGUIProvider } from "../../../types";
import { agentGUIProviderTargetRefsEqual } from "../../../providerTargets";
import type { ACPConfigOptionSelection } from "./agentGuiController.types";
import {
  normalizeOptionalText,
  recordValue
} from "./agentGuiController.promptHelpers";

export interface AgentGUIComposerTargetData {
  agentTargetId: string | null;
  data: AgentGUINodeData;
  provider: AgentGUIProvider;
  providerTargetId: string | null;
  providerTargetRef: AgentGUINodeData["providerTargetRef"];
  targetId: string;
}

export interface OptimisticComposerTarget {
  agentSessionId: string;
  target: AgentGUIComposerTargetData;
}

export function composerTargetDataFromNodeData(
  data: AgentGUINodeData
): AgentGUIComposerTargetData {
  const agentTargetId = normalizeOptionalText(data.agentTargetId);
  const providerTargetId = data.providerTargetId ?? null;
  return {
    agentTargetId,
    provider: data.provider,
    providerTargetId,
    providerTargetRef: data.providerTargetRef ?? null,
    targetId: agentTargetId ?? providerTargetId ?? `local:${data.provider}`,
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
    normalizeOptionalText(data.agentTargetId) === target.agentTargetId &&
    normalizeOptionalText(data.providerTargetId) ===
      normalizeOptionalText(target.providerTargetId) &&
    agentGUIProviderTargetRefsEqual(
      data.providerTargetRef,
      target.providerTargetRef
    )
  );
}

export function isForegroundModelOptionsLoading(input: {
  runtimeContext: Record<string, unknown> | null | undefined;
  selection: ACPConfigOptionSelection | null;
  supportsModel: boolean;
}): boolean {
  return (
    input.supportsModel &&
    recordValue(input.runtimeContext?.appServerStartup)?.models === "loading" &&
    (input.selection === null || input.selection.options.length === 0)
  );
}

export function configOptionCurrentValue(
  runtimeContext: Record<string, unknown> | null | undefined,
  ids: readonly string[]
): string | null {
  const rawConfigOptions = Array.isArray(runtimeContext?.configOptions)
    ? runtimeContext.configOptions
    : [];
  const idSet = new Set(ids);
  for (const rawOption of rawConfigOptions) {
    const option = recordValue(rawOption);
    const id = normalizeOptionalText(option?.id as string | null | undefined);
    if (!id || !idSet.has(id)) {
      continue;
    }
    return normalizeOptionalText(
      (option?.currentValue ?? option?.current_value) as
        | string
        | null
        | undefined
    );
  }
  return null;
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
      reasoningEffort &&
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
