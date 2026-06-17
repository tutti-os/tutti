// Agent GUI controller — composer settings, drafts, and permission labels.

import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
import type {
  AgentSessionComposerSettings,
  AgentSessionPermissionConfig,
  AgentSessionPermissionModeOption,
  AgentSessionReasoningEffort,
  AgentSessionSpeed
} from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData } from "../../../types";
import { translate } from "../../../i18n/index";
import type {
  AgentGUIComposerSettingOption,
  AgentGUIProviderSkillOption,
  AgentGUIQueuedPromptVM
} from "../model/agentGuiNodeTypes";
import type { ACPConfigOptionSelection } from "./agentGuiController.types";
import {
  normalizeOptionalText,
  recordValue
} from "./agentGuiController.promptHelpers";

export function normalizeConfigOptionValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function reasoningConfigOptionIdForProvider(
  provider: AgentGUINodeData["provider"]
): string {
  return provider === "codex" ? "reasoning_effort" : "effort";
}

export function composerSettingOptionsFromActivity(
  options: readonly AgentActivityComposerOptions["models"][number][]
): AgentGUIComposerSettingOption[] {
  return options.map((option) => ({ ...option }));
}

export function modelSelectionFromComposerOptions(
  options: AgentActivityComposerOptions | null,
  currentValue: string | null
): ACPConfigOptionSelection | null {
  if (!options) {
    return null;
  }
  return {
    options: composerSettingOptionsFromActivity(options.models),
    currentValue
  };
}

export function reasoningSelectionFromComposerOptions(
  options: AgentActivityComposerOptions | null,
  currentValue: AgentSessionReasoningEffort | null
): ACPConfigOptionSelection | null {
  if (!options) {
    return null;
  }
  return {
    options: composerSettingOptionsFromActivity(options.reasoningEfforts),
    currentValue
  };
}

export function speedSelectionFromComposerOptions(
  options: AgentActivityComposerOptions | null,
  currentValue: AgentSessionSpeed | null
): ACPConfigOptionSelection | null {
  if (!options) {
    return null;
  }
  return {
    options: composerSettingOptionsFromActivity(options.speeds ?? []),
    currentValue
  };
}

export function providerSkillsFromComposerOptions(
  options: AgentActivityComposerOptions | null
): AgentGUIProviderSkillOption[] {
  return options?.skills.map((skill) => ({ ...skill })) ?? [];
}

export function areProviderSkillOptionsEqual(
  left: AgentGUIProviderSkillOption,
  right: AgentGUIProviderSkillOption
): boolean {
  return (
    left.name === right.name &&
    left.trigger === right.trigger &&
    left.sourceKind === right.sourceKind &&
    left.description === right.description &&
    left.pluginName === right.pluginName
  );
}

export function areProviderSkillOptionListsEqual(
  left: readonly AgentGUIProviderSkillOption[],
  right: readonly AgentGUIProviderSkillOption[]
): boolean {
  return (
    left.length === right.length &&
    left.every((skill, index) =>
      areProviderSkillOptionsEqual(skill, right[index]!)
    )
  );
}

export function permissionConfigFromComposerOptions(
  options: AgentActivityComposerOptions | null
): AgentSessionPermissionConfig | null {
  const config = options?.permissionConfig;
  if (!config) {
    return null;
  }
  const defaultValue = normalizePermissionModeId(config.defaultValue);
  return {
    configurable: config.configurable,
    ...(defaultValue ? { defaultValue } : {}),
    modes: config.modes.map((mode) => ({
      id: mode.id,
      label: mode.label,
      description: mode.description,
      semantic: normalizePermissionModeSemantic(mode.semantic)
    }))
  };
}

export function normalizePermissionModeSemantic(
  value: string | undefined
): AgentSessionPermissionModeOption["semantic"] {
  switch (value) {
    case "ask-before-write":
    case "accept-edits":
    case "locked-down":
    case "auto":
    case "full-access":
    case "unconfigurable":
      return value;
    default:
      return (normalizeOptionalText(value) ??
        "unconfigurable") as AgentSessionPermissionModeOption["semantic"];
  }
}

export function resolveEffectiveComposerSettings(input: {
  settings: AgentSessionComposerSettings;
}): AgentSessionComposerSettings {
  return {
    model: normalizeOptionalText(input.settings.model) ?? null,
    reasoningEffort:
      (normalizeOptionalText(
        input.settings.reasoningEffort
      ) as AgentSessionReasoningEffort | null) ?? null,
    planMode: Boolean(input.settings.planMode),
    // Browser use defaults on; preserve an explicit opt-out, default unset to on.
    browserUse: input.settings.browserUse ?? true,
    permissionModeId: normalizePermissionModeId(input.settings.permissionModeId)
  };
}

export function runtimeConfigKeyForSetting(
  provider: AgentGUINodeData["provider"],
  setting: "model" | "reasoningEffort" | "permissionModeId"
): string {
  if (setting === "reasoningEffort") {
    return reasoningConfigOptionIdForProvider(provider);
  }
  if (setting === "permissionModeId") {
    return "mode";
  }
  return "model";
}

export function shouldUpdateRuntimeConfigOption(
  provider: AgentGUINodeData["provider"],
  id: string | null,
  setting: "model" | "reasoningEffort" | "permissionModeId"
): boolean {
  if (setting === "model") {
    return id === "model";
  }
  if (setting === "permissionModeId") {
    return id === "mode";
  }
  return (
    id === reasoningConfigOptionIdForProvider(provider) ||
    id === "model_reasoning_effort" ||
    id === "reasoning_effort" ||
    id === "effort"
  );
}

export function mergeRuntimeContextComposerSettings(
  provider: AgentGUINodeData["provider"],
  runtimeContext: Record<string, unknown> | undefined,
  settings: AgentSessionComposerSettings
): Record<string, unknown> | undefined {
  if (!runtimeContext) {
    return runtimeContext;
  }
  const nextRuntimeContext: Record<string, unknown> = { ...runtimeContext };
  const runtimeConfigPatch: Record<string, unknown> = {};
  const optionPatches: Array<{
    setting: "model" | "reasoningEffort" | "permissionModeId";
    value: string | null;
  }> = [];

  if (settings.model !== undefined) {
    const value = normalizeOptionalText(settings.model);
    runtimeConfigPatch[runtimeConfigKeyForSetting(provider, "model")] = value;
    optionPatches.push({ setting: "model", value });
  }
  if (settings.reasoningEffort !== undefined) {
    const value = normalizeOptionalText(settings.reasoningEffort);
    runtimeConfigPatch[
      runtimeConfigKeyForSetting(provider, "reasoningEffort")
    ] = value;
    optionPatches.push({ setting: "reasoningEffort", value });
  }
  if (settings.permissionModeId !== undefined) {
    const value = normalizeOptionalText(settings.permissionModeId);
    runtimeConfigPatch[
      runtimeConfigKeyForSetting(provider, "permissionModeId")
    ] = value;
    optionPatches.push({ setting: "permissionModeId", value });
  }

  if (Object.keys(runtimeConfigPatch).length > 0) {
    const currentConfig = recordValue(nextRuntimeContext.config);
    nextRuntimeContext.config = {
      ...(currentConfig ?? {}),
      ...runtimeConfigPatch
    };
  }
  if (
    optionPatches.length > 0 &&
    Array.isArray(nextRuntimeContext.configOptions)
  ) {
    nextRuntimeContext.configOptions = nextRuntimeContext.configOptions.map(
      (option) => {
        const optionRecord = recordValue(option);
        if (!optionRecord) {
          return option;
        }
        const id = normalizeConfigOptionValue(optionRecord.id);
        const patch = optionPatches.find((item) =>
          shouldUpdateRuntimeConfigOption(provider, id, item.setting)
        );
        return patch ? { ...optionRecord, currentValue: patch.value } : option;
      }
    );
  }
  return nextRuntimeContext;
}

export function normalizePermissionModeId(
  value: string | null | undefined
): string | null {
  return normalizeOptionalText(value);
}

export function cloneComposerSettings(
  settings: AgentSessionComposerSettings | null
): AgentSessionComposerSettings | null {
  if (!settings) {
    return null;
  }
  return { ...settings };
}

export function sameComposerSettings(
  left: AgentSessionComposerSettings | null,
  right: AgentSessionComposerSettings | null
): boolean {
  return (
    (left?.model ?? null) === (right?.model ?? null) &&
    (left?.reasoningEffort ?? null) === (right?.reasoningEffort ?? null) &&
    Boolean(left?.planMode) === Boolean(right?.planMode) &&
    (left?.browserUse ?? true) === (right?.browserUse ?? true) &&
    (left?.permissionModeId ?? null) === (right?.permissionModeId ?? null)
  );
}

export function buildNodeDefaultComposerSettings(
  data: AgentGUINodeData,
  options?: {
    defaultReasoningEffort?: AgentSessionReasoningEffort | null;
  }
): AgentSessionComposerSettings {
  // Generic cleanup only — provider-level clamping is owned by the daemon
  // (normalizeComposerSettingsForProvider and the session create path).
  const composerOverrides = nodeComposerOverridesForProvider(data) ?? {};
  return {
    model: normalizeOptionalText(composerOverrides.model),
    reasoningEffort:
      (normalizeOptionalText(
        composerOverrides.reasoningEffort
      ) as AgentSessionReasoningEffort | null) ??
      options?.defaultReasoningEffort ??
      null,
    planMode: Boolean(composerOverrides.planMode),
    browserUse: composerOverrides.browserUse ?? true,
    permissionModeId: normalizePermissionModeId(
      composerOverrides.permissionModeId
    )
  };
}

export function nodeComposerOverridesForProvider(
  data: AgentGUINodeData
): AgentSessionComposerSettings | null {
  return (
    data.composerOverridesByProvider?.[data.provider] ??
    data.composerOverrides ??
    null
  );
}

export function composerSupportForProvider(
  provider: AgentGUINodeData["provider"]
): {
  model: boolean;
  permission: boolean;
  reasoning: boolean;
  plan: boolean;
} {
  if (
    provider === "claude-code" ||
    provider === "codex" ||
    provider === "gemini"
  ) {
    return {
      model: true,
      permission: provider === "claude-code" || provider === "codex",
      reasoning: true,
      plan: false
    };
  }
  return {
    model: false,
    permission: provider === "nexight",
    reasoning: false,
    plan: false
  };
}

export function permissionModeOptions(
  provider: AgentGUINodeData["provider"],
  permissionConfig: AgentSessionPermissionConfig | null | undefined
): AgentGUIComposerSettingOption[] {
  if (!permissionConfig?.configurable) {
    return [];
  }
  return permissionConfig.modes.map((mode) => ({
    value: mode.id,
    label: permissionModeLabel(provider, mode),
    description: permissionModeDescription(provider, mode)
  }));
}

export function nodeDataFromComposerSettings(
  current: AgentGUINodeData,
  settings: AgentSessionComposerSettings
): AgentGUINodeData {
  // Generic cleanup only — provider-level clamping is owned by the daemon.
  const composerOverrides = {
    model: normalizeOptionalText(settings.model),
    reasoningEffort: normalizeOptionalText(settings.reasoningEffort),
    planMode: Boolean(settings.planMode),
    // Raw passthrough (no Boolean coercion): undefined means "default on", so
    // only an explicit false persists as an opt-out.
    browserUse: settings.browserUse,
    permissionModeId: normalizePermissionModeId(settings.permissionModeId)
  };
  return {
    ...current,
    composerOverrides,
    composerOverridesByProvider: {
      ...(current.composerOverridesByProvider ?? {}),
      [current.provider]: composerOverrides
    }
  };
}

export function permissionModeLabel(
  provider: AgentGUINodeData["provider"],
  option: AgentSessionPermissionModeOption
): string {
  const providerKey = `agentHost.agentGui.permissionModes.${provider}.${option.id}.label`;
  const providerLabel = translate(providerKey);
  if (providerLabel !== providerKey) {
    return providerLabel;
  }
  const semanticKey = `agentHost.agentGui.permissionSemantics.${option.semantic}.label`;
  const semanticLabel = translate(semanticKey);
  if (semanticLabel !== semanticKey) {
    return semanticLabel;
  }
  const contractLabel = normalizeOptionalText(option.label);
  if (contractLabel) {
    return contractLabel;
  }
  return option.id;
}

export function permissionModeDescription(
  provider: AgentGUINodeData["provider"],
  option: AgentSessionPermissionModeOption
): string | undefined {
  const providerKey = `agentHost.agentGui.permissionModes.${provider}.${option.id}.description`;
  const providerLabel = translate(providerKey);
  if (providerLabel !== providerKey) {
    return providerLabel;
  }
  const semanticKey = `agentHost.agentGui.permissionSemantics.${option.semantic}.description`;
  const semanticLabel = translate(semanticKey);
  if (semanticLabel !== semanticKey) {
    return semanticLabel;
  }
  const contractDescription = normalizeOptionalText(option.description);
  if (contractDescription) {
    return contractDescription;
  }
  return undefined;
}

export function removeQueuedPromptById(
  queue: readonly AgentGUIQueuedPromptVM[],
  queuedPromptId: string
): AgentGUIQueuedPromptVM[] {
  return queue.filter((queuedPrompt) => queuedPrompt.id !== queuedPromptId);
}

export const NODE_DEFAULT_DRAFT_KEY = "__agent_gui_node_defaults__";

export function nodeDefaultDraftKey(
  agentProvider: AgentGUINodeData["provider"]
): string {
  return `${NODE_DEFAULT_DRAFT_KEY}:${agentProvider}`;
}

export function nodeDefaultDraftPromptKey(
  agentProvider: AgentGUINodeData["provider"]
): string {
  return nodeDefaultDraftKey(agentProvider);
}

export function normalizeProjectDraftPath(
  value: string | null | undefined
): string | null {
  const normalized = value?.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized ? normalized : null;
}

export function readNodeDefaultDraftPrompt(input: {
  data: AgentGUINodeData;
  drafts: Record<string, string>;
}): string {
  return (
    input.drafts[nodeDefaultDraftPromptKey(input.data.provider)] ??
    input.drafts[NODE_DEFAULT_DRAFT_KEY] ??
    ""
  );
}

export function readNodeDefaultDraftSettings(input: {
  data: AgentGUINodeData;
  defaultReasoningEffort?: AgentSessionReasoningEffort | null;
  drafts: Record<string, AgentSessionComposerSettings>;
}): AgentSessionComposerSettings {
  return (
    input.drafts[nodeDefaultDraftKey(input.data.provider)] ??
    input.drafts[NODE_DEFAULT_DRAFT_KEY] ??
    buildNodeDefaultComposerSettings(input.data, {
      defaultReasoningEffort: input.defaultReasoningEffort
    })
  );
}
