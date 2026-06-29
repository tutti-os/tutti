import type {
  AgentActivityComposerCapabilityOption,
  AgentActivityComposerOptions,
  AgentActivityComposerPermissionConfig,
  AgentActivityComposerSettingOption,
  AgentActivityComposerSkillOption
} from "@tutti-os/agent-activity-core";

export function agentActivityComposerOptionsFromTuttidResult(
  provider: string,
  value: unknown
): AgentActivityComposerOptions {
  const result = recordValue(value);
  const runtimeContext = recordValue(result.runtimeContext);
  const rawConfigOptions = Array.isArray(runtimeContext.configOptions)
    ? runtimeContext.configOptions
    : [];
  const modelConfig = recordValue(result.modelConfig);
  const reasoningConfig = recordValue(result.reasoningConfig);
  const speedConfig = recordValue(result.speedConfig);
  const modelsFromConfig = settingOptionsFromComposerConfig(modelConfig);
  // The live agent's advertised model list reflects what the running session
  // can actually use, so it takes precedence when present.
  const modelsFromLiveConfig = settingOptionsFromConfigOption(
    rawConfigOptions,
    ["model"]
  );
  const reasoningEffortsFromConfig =
    settingOptionsFromComposerConfig(reasoningConfig);
  const reasoningEffortsFromLiveConfig = settingOptionsFromConfigOption(
    rawConfigOptions,
    ["reasoning_effort", "model_reasoning_effort", "effort"]
  );
  const speedsFromConfig = settingOptionsFromComposerConfig(speedConfig);
  const speedsFromLiveConfig = settingOptionsFromConfigOption(
    rawConfigOptions,
    ["service_tier", "speed", "fast"]
  );
  const skillsFromResult = skillOptionsFromValue(result.skills);
  const skillsFromRuntimeContext = skillOptionsFromValue(runtimeContext.skills);
  const capabilitiesFromResult = capabilityOptionsFromValue(
    result.capabilityCatalog
  );
  const capabilitiesFromRuntimeContext = capabilityOptionsFromValue(
    runtimeContext.capabilityCatalog
  );
  const capabilityCatalog =
    capabilitiesFromResult.length > 0
      ? capabilitiesFromResult
      : capabilitiesFromRuntimeContext;
  return {
    provider: normalizeText(result.provider) ?? provider,
    models:
      modelsFromLiveConfig.length > 0 ? modelsFromLiveConfig : modelsFromConfig,
    reasoningEfforts:
      reasoningEffortsFromConfig.length > 0
        ? reasoningEffortsFromConfig
        : reasoningEffortsFromLiveConfig,
    speeds:
      speedsFromConfig.length > 0 ? speedsFromConfig : speedsFromLiveConfig,
    modelConfigurable:
      modelConfig.configurable === true ||
      (modelConfig.configurable === undefined &&
        modelsFromLiveConfig.length > 0),
    reasoningConfigurable:
      reasoningConfig.configurable === true ||
      (reasoningConfig.configurable === undefined &&
        reasoningEffortsFromLiveConfig.length > 0),
    speedConfigurable:
      speedConfig.configurable === true ||
      (speedConfig.configurable === undefined &&
        speedsFromLiveConfig.length > 0),
    permissionConfig: permissionConfigFromValue(result.permissionConfig),
    runtimeContext,
    skills:
      skillsFromResult.length > 0 ? skillsFromResult : skillsFromRuntimeContext,
    capabilityCatalog,
    loadedAtUnixMs: Date.now()
  };
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

function settingOptionsFromConfigOption(
  rawConfigOptions: unknown[],
  ids: readonly string[]
): AgentActivityComposerSettingOption[] {
  const idSet = new Set(ids);
  const configOption =
    rawConfigOptions.map(recordValue).find((option) => {
      const id = normalizeText(option.id);
      return id ? idSet.has(id) : false;
    }) ?? null;
  if (!configOption) {
    return [];
  }
  const options = settingOptionsFromRawOptions(configOption.options, {
    labelKeys: ["name", "label", "displayName"],
    valueKeys: ["value", "id"]
  });
  const currentValue = normalizeText(
    configOption.currentValue ?? configOption.current_value
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
    options.push({
      value: optionValue,
      label,
      ...(description ? { description } : {})
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
  return [...options, { value: currentValue, label: currentValue }];
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
    options.push({
      name,
      trigger,
      sourceKind,
      ...(description ? { description } : {}),
      ...(pluginName ? { pluginName } : {}),
      ...(path ? { path } : {}),
      ...(kind ? { kind } : {})
    });
  }
  return options;
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
