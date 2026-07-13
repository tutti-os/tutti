import type { PermissionMode, Settings } from "@anthropic-ai/claude-agent-sdk";
import { recordValue } from "./normalizer.ts";
import { booleanValue, stringValue } from "./runtimeValues.ts";

export type PendingFlagSettings = {
  [K in keyof Settings]?: Settings[K] | null;
};

export type SidecarSessionSettings = {
  model: string;
  permissionModeId: string;
  planMode: boolean;
  effort: string;
  speed: string;
};

export type SidecarConfigOption = {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options: Array<{
    value: string;
    name: string;
    description?: string;
  }>;
};

export function sidecarSessionSettings(
  payload: Record<string, unknown>
): SidecarSessionSettings {
  const settings = recordValue(payload.settings) ?? {};
  return {
    model: stringValue(settings.model),
    permissionModeId:
      stringValue(payload.permissionModeId) ||
      stringValue(settings.permissionModeId) ||
      "default",
    planMode: booleanValue(settings.planMode),
    effort:
      stringValue(payload.effort) ||
      stringValue(settings.effort) ||
      stringValue(settings.reasoningEffort),
    speed: stringValue(settings.speed)
  };
}

export function effectivePermissionMode(
  settings: SidecarSessionSettings
): PermissionMode | undefined {
  if (settings.planMode) {
    return "plan";
  }
  const permissionMode = permissionModeValue(settings.permissionModeId);
  if (permissionMode === "bypassPermissions" && !canBypassPermissions()) {
    return "default";
  }
  return permissionMode;
}

export function permissionModeValue(value: string): PermissionMode | undefined {
  switch (value) {
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
    case "dontAsk":
    case "auto":
      return value;
    default:
      return undefined;
  }
}

export function modelOptionValue(value: string): string | undefined {
  const model = stringValue(value);
  return model && model !== "default" ? model : undefined;
}

export function sidecarModelOptionsFromInitializationResult(
  value: Record<string, unknown>
): SidecarConfigOption["options"] {
  const rawModels = Array.isArray(value.models) ? value.models : [];
  const options: SidecarConfigOption["options"] = [];
  const seen = new Set<string>();
  for (const item of rawModels) {
    const model = recordValue(item);
    if (!model) {
      continue;
    }
    const modelValue =
      stringValue(model.value) ||
      stringValue(model.id) ||
      stringValue(model.modelId) ||
      stringValue(model.model_id);
    if (!modelValue || seen.has(modelValue)) {
      continue;
    }
    seen.add(modelValue);
    const name =
      stringValue(model.displayName) ||
      stringValue(model.display_name) ||
      stringValue(model.name) ||
      modelValue;
    const description = stringValue(model.description);
    options.push({
      value: modelValue,
      name,
      ...(description ? { description } : {})
    });
  }
  return options;
}

export function defaultSidecarModelOptionValue(
  options: SidecarConfigOption["options"]
): string {
  return (
    options.find((option) => option.value === "default")?.value ??
    options[0]?.value ??
    "default"
  );
}

export function effortLevelValue(
  value: string
): Settings["effortLevel"] | null {
  switch (value) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return null;
  }
}

export function flagSettingsFromSessionSettings(
  settings: SidecarSessionSettings
): PendingFlagSettings {
  const result: PendingFlagSettings = {};
  if (settings.effort) {
    result.effortLevel = effortLevelValue(settings.effort);
  }
  if (settings.speed === "fast") {
    result.fastMode = true;
  } else if (settings.speed === "standard") {
    result.fastMode = false;
  }
  return result;
}

export function querySettingsFromSessionSettings(
  settings: SidecarSessionSettings
): Partial<Settings> {
  const result: Partial<Settings> = {};
  if (settings.speed === "fast") {
    result.fastMode = true;
  } else if (settings.speed === "standard") {
    result.fastMode = false;
  }
  return result;
}

export function approvalOptions(): Array<Record<string, unknown>> {
  return [
    {
      kind: "allow_always",
      name: "Allow for session",
      optionId: "allow_always"
    },
    { kind: "allow_once", name: "Allow", optionId: "allow" },
    { kind: "reject_once", name: "Reject", optionId: "reject" }
  ];
}

export function exitPlanOptions(): Array<Record<string, unknown>> {
  const options = [
    {
      kind: "allow_always",
      name: 'Yes, and use "auto" mode',
      optionId: "auto"
    },
    {
      kind: "allow_always",
      name: "Yes, and auto-accept edits",
      optionId: "acceptEdits"
    },
    {
      kind: "allow_once",
      name: "Yes, and manually approve edits",
      optionId: "default"
    },
    { kind: "reject_once", name: "No, keep planning", optionId: "plan" }
  ];
  if (canBypassPermissions()) {
    options.unshift({
      kind: "allow_always",
      name: "Yes, and bypass permissions",
      optionId: "bypassPermissions"
    });
  }
  return options;
}

export function isAllowOption(optionId: string): boolean {
  return [
    "allow",
    "allow_always",
    "accept",
    "acceptEdits",
    "default",
    "auto",
    "bypassPermissions"
  ].includes(optionId);
}

export function isExitPlanAllowOption(optionId: string): boolean {
  if (optionId === "bypassPermissions") {
    return canBypassPermissions();
  }
  return ["default", "acceptEdits", "auto"].includes(optionId);
}

export function canBypassPermissions(): boolean {
  const isRoot = (process.geteuid?.() ?? process.getuid?.()) === 0;
  return !isRoot || !!process.env.IS_SANDBOX;
}
