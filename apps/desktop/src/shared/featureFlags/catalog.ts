import {
  defaultDesktopWorkspaceUiMode,
  type DesktopFeatureFlags,
  type DesktopWorkspaceUiMode
} from "../preferences/index.ts";

export const LAB_ENABLED_FLAG = "lab.enabled";
export const BROWSER_CHROME_COOKIE_IMPORT_FLAG = "browser.chromeCookieImport";
export const LAB_TUTTI_MODE_FLAG = "lab.tuttiMode";
export const LAB_MODEL_PLANS_FLAG = "lab.modelPlans";
export const LAB_WORKSPACE_AGENTS_FLAG = "lab.workspaceAgents";
export const LAB_AUTOMATION_RULES_FLAG = "lab.automationRules";
export const LAB_WORKBENCH_SHORTCUTS_FLAG = "lab.workbenchShortcuts";
export const WORKSPACE_STANDALONE_AGENT_MODE_FLAG =
  "workspace.standaloneAgentMode";
export const AGENT_REFERENCE_PROVENANCE_FILTER_FLAG =
  "agent.referenceProvenanceFilter";
export const AGENT_QUICK_PROMPT_LIBRARY_FLAG = "agent.quickPromptLibrary";
export const AGENT_EXTENSION_GEMINI_FLAG = "agent.extension.gemini";
export const AGENT_EXTENSION_CODEBUDDY_FLAG = "agent.extension.codebuddy";
export const AGENT_EXTENSION_COPILOT_FLAG = "agent.extension.copilot";
export const AGENT_EXTENSION_KILO_FLAG = "agent.extension.kilo";
export const AGENT_EXTENSION_QWEN_FLAG = "agent.extension.qwen";
export const AGENT_EXTENSION_GROK_FLAG = "agent.extension.grok";
export const AGENT_EXTENSION_ACTIVATION_FLAGS = [
  AGENT_EXTENSION_GEMINI_FLAG,
  AGENT_EXTENSION_CODEBUDDY_FLAG,
  AGENT_EXTENSION_COPILOT_FLAG,
  AGENT_EXTENSION_KILO_FLAG,
  AGENT_EXTENSION_QWEN_FLAG,
  AGENT_EXTENSION_GROK_FLAG
] as const;
export type AgentExtensionActivationFlag =
  (typeof AGENT_EXTENSION_ACTIVATION_FLAGS)[number];

export interface FeatureFlagDefinition {
  key: string;
  default: boolean;
  group: "developer" | "lab-master" | "lab";
  labelKey?: string;
  descriptionKey?: string;
}

export const FEATURE_FLAG_DEFINITIONS: readonly FeatureFlagDefinition[] = [
  {
    key: BROWSER_CHROME_COOKIE_IMPORT_FLAG,
    default: true,
    group: "developer"
  },
  {
    key: AGENT_EXTENSION_GEMINI_FLAG,
    default: false,
    group: "developer"
  },
  {
    key: AGENT_EXTENSION_CODEBUDDY_FLAG,
    default: false,
    group: "developer"
  },
  {
    key: AGENT_EXTENSION_COPILOT_FLAG,
    default: false,
    group: "developer"
  },
  {
    key: AGENT_EXTENSION_KILO_FLAG,
    default: false,
    group: "developer"
  },
  {
    key: AGENT_EXTENSION_QWEN_FLAG,
    default: false,
    group: "developer"
  },
  {
    key: AGENT_EXTENSION_GROK_FLAG,
    default: false,
    group: "developer"
  },
  {
    key: AGENT_REFERENCE_PROVENANCE_FILTER_FLAG,
    default: false,
    group: "developer"
  },
  {
    key: AGENT_QUICK_PROMPT_LIBRARY_FLAG,
    default: false,
    group: "developer"
  },
  { key: LAB_ENABLED_FLAG, default: false, group: "lab-master" },
  {
    key: LAB_TUTTI_MODE_FLAG,
    default: false,
    group: "lab",
    labelKey: "workspace.settings.lab.tuttiModeLabel",
    descriptionKey: "workspace.settings.lab.tuttiModeDescription"
  },
  {
    key: LAB_MODEL_PLANS_FLAG,
    default: false,
    group: "lab",
    labelKey: "workspace.settings.lab.modelPlansLabel",
    descriptionKey: "workspace.settings.lab.modelPlansDescription"
  },
  {
    key: LAB_WORKSPACE_AGENTS_FLAG,
    default: false,
    group: "lab",
    labelKey: "workspace.settings.lab.workspaceAgentsLabel",
    descriptionKey: "workspace.settings.lab.workspaceAgentsDescription"
  },
  {
    key: LAB_AUTOMATION_RULES_FLAG,
    default: false,
    group: "lab",
    labelKey: "workspace.settings.lab.automationRulesLabel",
    descriptionKey: "workspace.settings.lab.automationRulesDescription"
  },
  {
    key: LAB_WORKBENCH_SHORTCUTS_FLAG,
    default: false,
    group: "lab",
    labelKey: "workspace.settings.lab.workbenchShortcutsLabel",
    descriptionKey: "workspace.settings.lab.workbenchShortcutsDescription"
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
