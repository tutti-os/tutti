import type { DesktopFeatureFlags } from "../preferences/index.ts";

export const LAB_ENABLED_FLAG = "lab.enabled";
export const LAB_WORKBENCH_SHORTCUTS_FLAG = "lab.workbenchShortcuts";

export interface FeatureFlagDefinition {
  key: string;
  default: boolean;
  group: "lab-master" | "lab";
  labelKey?: string;
  descriptionKey?: string;
}

export const FEATURE_FLAG_DEFINITIONS: readonly FeatureFlagDefinition[] = [
  { key: LAB_ENABLED_FLAG, default: false, group: "lab-master" },
  {
    key: LAB_WORKBENCH_SHORTCUTS_FLAG,
    default: false,
    group: "lab",
    labelKey: "workspaceSettings.lab.workbenchShortcuts.label",
    descriptionKey: "workspaceSettings.lab.workbenchShortcuts.description"
  }
];

const DEFAULT_BY_KEY = new Map(
  FEATURE_FLAG_DEFINITIONS.map((d) => [d.key, d.default])
);

export function isFeatureEnabled(
  flags: DesktopFeatureFlags,
  key: string
): boolean {
  if (Object.prototype.hasOwnProperty.call(flags, key)) {
    return flags[key] === true;
  }
  return DEFAULT_BY_KEY.get(key) ?? false;
}

export function labFeatureDefinitions(): readonly FeatureFlagDefinition[] {
  return FEATURE_FLAG_DEFINITIONS.filter((d) => d.group === "lab");
}
