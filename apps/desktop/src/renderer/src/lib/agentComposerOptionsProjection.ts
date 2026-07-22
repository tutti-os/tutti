import type {
  AgentActivityComposerCapabilityOption,
  AgentActivityComposerOptions,
  AgentActivityComposerPermissionConfig,
  AgentActivityComposerSettingOption,
  AgentActivityComposerSkillOption,
  AgentActivitySessionCapabilities,
  AgentActivitySlashCommandEffect,
  AgentActivitySlashCommandPolicy
} from "@tutti-os/agent-activity-core";

export function agentActivityComposerOptionsFromTuttidResult(
  provider: string,
  value: unknown
): AgentActivityComposerOptions {
  const result = recordValue(value);
  const runtimeContext = recordValue(result.runtimeContext);
  const modelConfig = recordValue(result.modelConfig);
  const reasoningConfig = recordValue(result.reasoningConfig);
  const speedConfig = recordValue(result.speedConfig);
  const effectiveSettings = composerSettingsFromValue(result.effectiveSettings);
  const modelsFromConfig = settingOptionsFromComposerConfig(modelConfig);
  const reasoningEffortsFromConfig =
    settingOptionsFromComposerConfig(reasoningConfig);
  const speedsFromConfig = settingOptionsFromComposerConfig(speedConfig);
  const skillsFromResult = skillOptionsFromValue(result.skills);
  const capabilityCatalog = capabilityOptionsFromValue(
    result.capabilityCatalog
  );
  return {
    provider: normalizeText(result.provider) ?? provider,
    capabilities: sessionCapabilitiesFromValue(result.capabilities),
    models: modelsFromConfig,
    reasoningEfforts: reasoningEffortsFromConfig,
    reasoningOptionsByModel: reasoningOptionsByModelFromValue(
      result.reasoningOptionsByModel
    ),
    speeds: speedsFromConfig,
    modelConfigurable: modelConfig.configurable === true,
    reasoningConfigurable: reasoningConfig.configurable === true,
    speedConfigurable: speedConfig.configurable === true,
    effectiveSettings,
    permissionConfig: permissionConfigFromValue(result.permissionConfig),
    draftAgentSessionId: normalizeText(runtimeContext.draftAgentSessionId),
    modelOptionsLoading:
      recordValue(runtimeContext.appServerStartup).models === "loading",
    skills: skillsFromResult,
    commands: commandOptionsFromValue(result.commands),
    capabilityCatalog,
    behavior: composerBehaviorFromValue(result.behavior),
    slashCommandPolicy: slashCommandPolicyFromValue(result.slashCommandPolicy),
    modelPlan: composerModelPlanFromValue(runtimeContext.modelPlan),
    modelConfiguration: composerModelConfigurationFromValue(
      runtimeContext.modelConfiguration
    ),
    loadedAtUnixMs: Date.now()
  };
}

function commandOptionsFromValue(value: unknown) {
  if (!Array.isArray(value)) return [];
  const commands: Array<{
    name: string;
    description?: string;
    inputHint?: string;
  }> = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const command = recordValue(raw);
    const name = normalizeText(command.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const description = normalizeText(command.description);
    const inputHint = normalizeText(command.inputHint);
    commands.push({
      name,
      ...(description ? { description } : {}),
      ...(inputHint ? { inputHint } : {})
    });
  }
  return commands;
}

function composerModelPlanFromValue(
  value: unknown
): AgentActivityComposerOptions["modelPlan"] {
  const plan = recordValue(value);
  const id = normalizeText(plan.id);
  const name = normalizeText(plan.name);
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    protocol: normalizeText(plan.protocol)
  };
}

function composerModelConfigurationFromValue(
  value: unknown
): AgentActivityComposerOptions["modelConfiguration"] {
  const configuration = recordValue(value);
  const agentTargetId = normalizeText(configuration.agentTargetId);
  const fingerprint = normalizeText(configuration.fingerprint);
  const source = normalizeText(configuration.source);
  if (
    !agentTargetId ||
    !fingerprint ||
    (source !== "model-plan" && source !== "provider-native")
  ) {
    return null;
  }
  return {
    agentTargetId,
    defaultModel: normalizeText(configuration.defaultModel) ?? null,
    fingerprint,
    source
  };
}
function sessionCapabilitiesFromValue(
  value: unknown
): AgentActivitySessionCapabilities | null {
  const capabilities = recordValue(value);
  if (Object.keys(capabilities).length === 0) {
    return null;
  }
  return {
    activeTurnGuidance: capabilities.activeTurnGuidance === true,
    browserUse: capabilities.browserUse === true,
    compact: capabilities.compact === true,
    computerUse: capabilities.computerUse === true,
    goalPause: capabilities.goalPause === true,
    imageInput: capabilities.imageInput === true,
    interrupt: capabilities.interrupt === true,
    modelImageInputRequired: capabilities.modelImageInputRequired === true,
    modelPlanBinding: capabilities.modelPlanBinding === true,
    modelSwitch: capabilities.modelSwitch === true,
    permissionModeChangeDeferred:
      capabilities.permissionModeChangeDeferred === true,
    permissionModeChangeDuringTurn:
      capabilities.permissionModeChangeDuringTurn === true,
    planImplementation: capabilities.planImplementation === true,
    planMode: capabilities.planMode === true,
    rateLimits: capabilities.rateLimits === true,
    resumeRunningTurn: capabilities.resumeRunningTurn === true,
    review: capabilities.review === true,
    skills: capabilities.skills === true,
    tokenUsage: capabilities.tokenUsage === true
  };
}

function reasoningOptionsByModelFromValue(
  value: unknown
): AgentActivityComposerOptions["reasoningOptionsByModel"] {
  const profiles = recordValue(value);
  const entries = Object.entries(profiles).flatMap(([model, rawProfile]) => {
    const profile = recordValue(rawProfile);
    const options = settingOptionsFromRawOptions(profile.options, {
      labelKeys: ["name", "label", "displayName"],
      valueKeys: ["value", "id"]
    });
    if (!model.trim()) {
      return [];
    }
    return [
      [
        model.trim(),
        {
          defaultValue: normalizeText(profile.defaultValue),
          options
        }
      ] as const
    ];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function composerBehaviorFromValue(
  value: unknown
): AgentActivityComposerOptions["behavior"] {
  const behavior = recordValue(value);
  return {
    collapseModelOptionsToLatest:
      behavior.collapseModelOptionsToLatest === true,
    modelOptionsAuthoritative: behavior.modelOptionsAuthoritative === true,
    refreshModelOptionsAfterSettings:
      behavior.refreshModelOptionsAfterSettings === true,
    prewarmDraftSession: behavior.prewarmDraftSession === true,
    planModeExclusiveWithPermissionMode:
      behavior.planModeExclusiveWithPermissionMode === true
  };
}

function composerSettingsFromValue(
  value: unknown
): AgentActivityComposerOptions["effectiveSettings"] {
  const settings = recordValue(value);
  if (Object.keys(settings).length === 0) {
    return null;
  }
  return {
    model: normalizeText(settings.model),
    reasoningEffort: normalizeText(settings.reasoningEffort),
    speed: normalizeText(settings.speed),
    planMode:
      typeof settings.planMode === "boolean" ? settings.planMode : undefined,
    permissionModeId: normalizeText(settings.permissionModeId)
  };
}

function slashCommandPolicyFromValue(
  value: unknown
): AgentActivitySlashCommandPolicy | null {
  const policy = recordValue(value);
  if (
    !Array.isArray(policy.fallbackCommands) ||
    !Array.isArray(policy.commandEffects)
  ) {
    return null;
  }
  const fallbackCommands = policy.fallbackCommands.flatMap((entry) => {
    const command = normalizeText(entry);
    return command ? [command] : [];
  });
  const commandEffects = policy.commandEffects.flatMap((entry) => {
    const descriptor = recordValue(entry);
    const command = normalizeText(descriptor.command);
    const effect = slashCommandEffectFromValue(descriptor.effect);
    return command && effect ? [{ command, effect }] : [];
  });
  return {
    fallbackCommands,
    commandEffects,
    ...(policy.commandCatalogAuthoritative === true
      ? { commandCatalogAuthoritative: true }
      : {})
  };
}

function slashCommandEffectFromValue(
  value: unknown
): AgentActivitySlashCommandEffect | null {
  switch (value) {
    case "submitImmediate":
    case "showReviewPicker":
    case "activateGoalMode":
    case "togglePlanMode":
    case "showStatus":
    case "toggleSpeed":
      return value;
    default:
      return null;
  }
}

function settingOptionsFromComposerConfig(
  config: Record<string, unknown>
): AgentActivityComposerSettingOption[] {
  const options = settingOptionsFromRawOptions(config.options, {
    labelKeys: ["label", "name", "displayName"],
    valueKeys: ["value", "id"]
  });
  const currentValue = normalizeText(
    config.currentValue ?? config.current_value ?? config.defaultValue
  );
  return appendCurrentOption(options, currentValue);
}

function settingOptionsFromRawOptions(
  value: unknown,
  keys: {
    labelKeys: readonly string[];
    valueKeys: readonly string[];
  }
): AgentActivityComposerSettingOption[] {
  const options: AgentActivityComposerSettingOption[] = [];
  const seen = new Set<string>();
  for (const item of flattenRawSettingOptions(value)) {
    const record = recordValue(item);
    const optionValue = firstTextValue(record, keys.valueKeys);
    if (!optionValue || seen.has(optionValue)) {
      continue;
    }
    seen.add(optionValue);
    const label = firstTextValue(record, keys.labelKeys) ?? optionValue;
    const description = normalizeText(record.description);
    const supportsImageInput =
      typeof record.supportsImageInput === "boolean"
        ? record.supportsImageInput
        : undefined;
    options.push({
      value: optionValue,
      label,
      ...(description ? { description } : {}),
      ...(supportsImageInput !== undefined ? { supportsImageInput } : {}),
      // Daemon provenance: the entry mirrors the requested selection (warm
      // catalog append / bootstrap echo) and is not catalog testimony.
      ...(record.requested === true ? { requested: true } : {})
    });
  }
  return options;
}

function flattenRawSettingOptions(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const flattened: unknown[] = [];
  for (const item of value as unknown[]) {
    const record = recordValue(item);
    if (Array.isArray(record.options)) {
      flattened.push(...flattenRawSettingOptions(record.options));
    } else {
      flattened.push(item);
    }
  }
  return flattened;
}

function appendCurrentOption(
  options: AgentActivityComposerSettingOption[],
  currentValue: string | null
): AgentActivityComposerSettingOption[] {
  if (
    !currentValue ||
    options.some((option) => option.value === currentValue)
  ) {
    return options;
  }
  // This append mirrors the current selection so it stays selectable; mark
  // it requested-origin — it is not evidence the provider catalog contains
  // the model.
  return [
    ...options,
    { value: currentValue, label: currentValue, requested: true }
  ];
}

function permissionConfigFromValue(
  value: unknown
): AgentActivityComposerPermissionConfig | null {
  const config = recordValue(value);
  if (Object.keys(config).length === 0) {
    return null;
  }
  const modes = Array.isArray(config.modes) ? config.modes : [];
  const parsedModes: AgentActivityComposerPermissionConfig["modes"] = [];
  for (const item of modes) {
    const mode = recordValue(item);
    const id = normalizeText(mode.id);
    if (!id) {
      continue;
    }
    const label = normalizeText(mode.label);
    const description = normalizeText(mode.description);
    const semantic = normalizeText(mode.semantic);
    parsedModes.push({
      id,
      ...(label ? { label } : {}),
      ...(description ? { description } : {}),
      ...(semantic ? { semantic } : {})
    });
  }
  const defaultValue = normalizeText(
    config.defaultValue ?? config.currentValue
  );
  return {
    configurable: Boolean(config.configurable),
    ...(defaultValue ? { defaultValue } : {}),
    modes: parsedModes
  };
}

function skillOptionsFromValue(
  value: unknown
): AgentActivityComposerSkillOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: AgentActivityComposerSkillOption[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = recordValue(item);
    const name = normalizeText(record.name);
    const trigger = normalizeText(record.trigger);
    const sourceKind = normalizeSkillSourceKind(record.sourceKind);
    if (!name || !trigger || !sourceKind || seen.has(trigger)) {
      continue;
    }
    seen.add(trigger);
    const description = normalizeText(record.description);
    const pluginName = normalizeText(record.pluginName);
    const path = normalizeText(record.path);
    const kind = normalizeSkillKind(record.kind);
    const invocation = normalizeSkillInvocation(record.invocation);
    options.push({
      name,
      trigger,
      sourceKind,
      ...(description ? { description } : {}),
      ...(pluginName ? { pluginName } : {}),
      ...(path ? { path } : {}),
      ...(kind ? { kind } : {}),
      ...(invocation ? { invocation } : {})
    });
  }
  return options;
}

function normalizeSkillInvocation(
  value: unknown
): AgentActivityComposerSkillOption["invocation"] | null {
  const normalized = normalizeText(value);
  return normalized === "promptItem" || normalized === "textTrigger"
    ? normalized
    : null;
}

function normalizeSkillSourceKind(
  value: unknown
): AgentActivityComposerSkillOption["sourceKind"] | null {
  const normalized = normalizeText(value);
  switch (normalized) {
    case "project":
    case "personal":
    case "bundled":
    case "plugin":
    case "system":
    case "tutti-injected":
    case "connector":
      return normalized;
    default:
      return null;
  }
}

function normalizeSkillKind(
  value: unknown
): AgentActivityComposerSkillOption["kind"] | null {
  const normalized = normalizeText(value);
  switch (normalized) {
    case "skill":
    case "connector":
      return normalized;
    default:
      return null;
  }
}

function capabilityOptionsFromValue(
  value: unknown
): AgentActivityComposerCapabilityOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: AgentActivityComposerCapabilityOption[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = recordValue(item);
    const id = normalizeText(record.id);
    const kind = normalizeCapabilityKind(record.kind);
    const name = normalizeText(record.name);
    const label = normalizeText(record.label) ?? name;
    const status = normalizeCapabilityStatus(record.status);
    const invocation = normalizeCapabilityInvocation(record.invocation);
    if (
      !id ||
      !kind ||
      !name ||
      !label ||
      !status ||
      !invocation ||
      seen.has(id)
    ) {
      continue;
    }
    seen.add(id);
    const description = normalizeText(record.description);
    const source = normalizeText(record.source);
    const pluginName = normalizeText(record.pluginName);
    const serverName = normalizeText(record.serverName);
    const toolName = normalizeText(record.toolName);
    const trigger = normalizeText(record.trigger);
    const path = normalizeText(record.path);
    options.push({
      id,
      kind,
      name,
      label,
      status,
      invocation,
      ...(description ? { description } : {}),
      ...(source ? { source } : {}),
      ...(pluginName ? { pluginName } : {}),
      ...(serverName ? { serverName } : {}),
      ...(toolName ? { toolName } : {}),
      ...(trigger ? { trigger } : {}),
      ...(path ? { path } : {})
    });
  }
  return options;
}

function normalizeCapabilityKind(
  value: unknown
): AgentActivityComposerCapabilityOption["kind"] | null {
  const normalized = normalizeText(value);
  switch (normalized) {
    case "skill":
    case "plugin":
    case "connector":
    case "mcpServer":
    case "mcpTool":
      return normalized;
    default:
      return null;
  }
}

function normalizeCapabilityStatus(
  value: unknown
): AgentActivityComposerCapabilityOption["status"] | null {
  const normalized = normalizeText(value);
  switch (normalized) {
    case "available":
    case "disabled":
    case "authRequired":
    case "setupRequired":
    case "unsupported":
      return normalized;
    default:
      return null;
  }
}

function normalizeCapabilityInvocation(
  value: unknown
): AgentActivityComposerCapabilityOption["invocation"] | null {
  const normalized = normalizeText(value);
  switch (normalized) {
    case "promptItem":
    case "textTrigger":
    case "none":
      return normalized;
    default:
      return null;
  }
}

function firstTextValue(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = normalizeText(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
