import type { DesktopFeatureFlags } from "../preferences/index.ts";

export const LAB_ENABLED_FLAG = "lab.enabled";
export const LAB_FUSION_MODE_FLAG = "lab.fusionMode";
export const LAB_FUSION_DOCK_AUTO_HIDE_FLAG = "lab.fusionDockAutoHide";
export const LAB_FUSION_DOCK_SHORTCUT_ONLY_FLAG = "lab.fusionDockShortcutOnly";
export const LAB_WORKBENCH_SHORTCUTS_FLAG = "lab.workbenchShortcuts";

export const fusionDockVisibilities = [
  "always",
  "autoHide",
  "shortcutOnly"
] as const;

export type FusionDockVisibility = (typeof fusionDockVisibilities)[number];

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
    key: LAB_FUSION_MODE_FLAG,
    default: false,
    group: "lab",
    labelKey: "workspaceSettings.lab.fusionMode.label",
    descriptionKey: "workspaceSettings.lab.fusionMode.description"
  },
  {
    key: LAB_FUSION_DOCK_AUTO_HIDE_FLAG,
    default: false,
    group: "lab"
  },
  {
    key: LAB_FUSION_DOCK_SHORTCUT_ONLY_FLAG,
    default: false,
    group: "lab"
  },
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

export function isFusionModeEnabled(flags: DesktopFeatureFlags): boolean {
  return isFeatureEnabled(flags, LAB_FUSION_MODE_FLAG);
}

export function isFusionDockVisibility(
  value: unknown
): value is FusionDockVisibility {
  return fusionDockVisibilities.some((visibility) => visibility === value);
}

export function resolveFusionDockVisibility(
  flags: DesktopFeatureFlags
): FusionDockVisibility {
  if (isFeatureEnabled(flags, LAB_FUSION_DOCK_SHORTCUT_ONLY_FLAG)) {
    return "shortcutOnly";
  }
  if (isFeatureEnabled(flags, LAB_FUSION_DOCK_AUTO_HIDE_FLAG)) {
    return "autoHide";
  }
  return "always";
}

export function withFusionDockVisibility(
  flags: DesktopFeatureFlags,
  visibility: FusionDockVisibility
): DesktopFeatureFlags {
  return {
    ...flags,
    [LAB_FUSION_DOCK_AUTO_HIDE_FLAG]: visibility === "autoHide",
    [LAB_FUSION_DOCK_SHORTCUT_ONLY_FLAG]: visibility === "shortcutOnly"
  };
}
