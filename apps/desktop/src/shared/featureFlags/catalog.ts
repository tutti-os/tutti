import {
  defaultDesktopWorkspaceUiMode,
  type DesktopFeatureFlags,
  type DesktopWorkspaceUiMode
} from "../preferences/index.ts";

export const LAB_ENABLED_FLAG = "lab.enabled";
export const LAB_WORKBENCH_SHORTCUTS_FLAG = "lab.workbenchShortcuts";
export const WORKSPACE_STANDALONE_AGENT_MODE_FLAG =
  "workspace.standaloneAgentMode";
export const AGENT_REFERENCE_PROVENANCE_FILTER_FLAG =
  "agent.referenceProvenanceFilter";

export interface FeatureFlagDefinition {
  key: string;
  default: boolean;
  group: "developer" | "lab-master" | "lab";
  labelKey?: string;
  descriptionKey?: string;
}

export const FEATURE_FLAG_DEFINITIONS: readonly FeatureFlagDefinition[] = [
  {
    key: AGENT_REFERENCE_PROVENANCE_FILTER_FLAG,
    default: false,
    group: "developer"
  },
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

export function resolveDesktopWorkspaceUiMode(
  flags: DesktopFeatureFlags
): DesktopWorkspaceUiMode {
  if (
    Object.prototype.hasOwnProperty.call(
      flags,
      WORKSPACE_STANDALONE_AGENT_MODE_FLAG
    )
  ) {
    return flags[WORKSPACE_STANDALONE_AGENT_MODE_FLAG] === false
      ? "os"
      : "agent";
  }
  return defaultDesktopWorkspaceUiMode;
}

export function withDesktopWorkspaceUiMode(
  flags: DesktopFeatureFlags,
  mode: DesktopWorkspaceUiMode
): DesktopFeatureFlags {
  return {
    ...flags,
    [WORKSPACE_STANDALONE_AGENT_MODE_FLAG]: mode === "agent"
  };
}
