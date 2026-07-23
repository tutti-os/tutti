import type { DesktopI18nKey } from "@shared/i18n";
import { resolveAgentGUIProviderCatalogIdentity } from "@tutti-os/agent-gui/provider-catalog";
import type {
  WorkspaceModelPlanModel,
  WorkspaceModelPlanProtocol,
  WorkspaceModelPlanTemplateKind
} from "./workspaceSettingsTypes";

const AGNES_API_KEYS_URL = "https://platform.agnes-ai.com/settings/apiKeys";
const ANTHROPIC_API_KEYS_URL = "https://console.anthropic.com/settings/keys";
const DEEPSEEK_API_KEYS_URL = "https://platform.deepseek.com/api_keys";
const MINIMAX_API_KEYS_URL = "https://platform.minimax.io/console/access";
const MIMO_API_KEYS_URL = "https://platform.xiaomimimo.com/console/api-keys";

const deepseekModels = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-chat",
  "deepseek-reasoner"
] as const;

const minimaxModels = [
  "MiniMax-M3",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.7",
  "MiniMax-M2.5-highspeed",
  "MiniMax-M2.5",
  "MiniMax-M2.1-highspeed",
  "MiniMax-M2.1",
  "MiniMax-M2"
] as const;

/**
 * A concrete provider preset inside one access-scheme template. Custom
 * presets (no fixed base URL) leave the protocol and endpoint editable.
 */
export interface WorkspaceModelPlanTemplatePreset {
  readonly id: string;
  readonly labelKey: DesktopI18nKey;
  readonly protocol: WorkspaceModelPlanProtocol;
  readonly protocolLocked: boolean;
  readonly baseUrl: string;
  readonly apiKeyUrl: string | null;
  readonly models: readonly string[];
}

/**
 * One access-scheme template group shown in the "add plan" picker. Groups
 * are the extensible entry point: adding a scheme means appending here.
 */
export interface WorkspaceModelPlanTemplateGroup {
  readonly kind: WorkspaceModelPlanTemplateKind;
  readonly labelKey: DesktopI18nKey;
  readonly guidanceKey: DesktopI18nKey;
  readonly presets: readonly WorkspaceModelPlanTemplatePreset[];
}

const modelPlansI18nPrefix = "workspace.settings.apps.modelPlans" as const;

function presetKey(name: string): DesktopI18nKey {
  return `${modelPlansI18nPrefix}.presets.${name}` as DesktopI18nKey;
}

export const workspaceModelPlanTemplateGroups: readonly WorkspaceModelPlanTemplateGroup[] =
  [
    {
      kind: "official_subscription",
      labelKey: `${modelPlansI18nPrefix}.templateGroups.officialSubscription.label`,
      guidanceKey: `${modelPlansI18nPrefix}.templateGroups.officialSubscription.guidance`,
      presets: [
        {
          id: "anthropic-official",
          labelKey: presetKey("anthropicOfficial"),
          protocol: "anthropic",
          protocolLocked: true,
          baseUrl: "",
          apiKeyUrl: null,
          models: []
        },
        {
          id: "openai-official",
          labelKey: presetKey("openaiOfficial"),
          protocol: "openai",
          protocolLocked: true,
          baseUrl: "",
          apiKeyUrl: null,
          models: []
        }
      ]
    },
    {
      kind: "coding_plan",
      labelKey: `${modelPlansI18nPrefix}.templateGroups.codingPlan.label`,
      guidanceKey: `${modelPlansI18nPrefix}.templateGroups.codingPlan.guidance`,
      presets: [
        {
          id: "coding-plan-anthropic",
          labelKey: presetKey("codingPlanAnthropic"),
          protocol: "anthropic",
          protocolLocked: false,
          baseUrl: "https://api.anthropic.com/v1",
          apiKeyUrl: ANTHROPIC_API_KEYS_URL,
          models: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"]
        },
        {
          id: "coding-plan-custom",
          labelKey: presetKey("codingPlanCustom"),
          protocol: "anthropic",
          protocolLocked: false,
          baseUrl: "",
          apiKeyUrl: null,
          models: []
        }
      ]
    },
    {
      kind: "domestic",
      labelKey: `${modelPlansI18nPrefix}.templateGroups.domestic.label`,
      guidanceKey: `${modelPlansI18nPrefix}.templateGroups.domestic.guidance`,
      presets: [
        {
          id: "deepseek-anthropic",
          labelKey: presetKey("deepseekAnthropic"),
          protocol: "anthropic",
          protocolLocked: true,
          baseUrl: "https://api.deepseek.com/anthropic",
          apiKeyUrl: DEEPSEEK_API_KEYS_URL,
          models: deepseekModels
        },
        {
          id: "deepseek-openai",
          labelKey: presetKey("deepseekOpenai"),
          protocol: "openai",
          protocolLocked: true,
          baseUrl: "https://api.deepseek.com",
          apiKeyUrl: DEEPSEEK_API_KEYS_URL,
          models: deepseekModels
        },
        {
          id: "minimax-anthropic",
          labelKey: presetKey("minimaxAnthropic"),
          protocol: "anthropic",
          protocolLocked: true,
          baseUrl: "https://api.minimaxi.com/anthropic",
          apiKeyUrl: MINIMAX_API_KEYS_URL,
          models: minimaxModels
        },
        {
          id: "minimax-openai",
          labelKey: presetKey("minimaxOpenai"),
          protocol: "openai",
          protocolLocked: true,
          baseUrl: "https://api.minimaxi.com/v1",
          apiKeyUrl: MINIMAX_API_KEYS_URL,
          models: minimaxModels
        },
        {
          id: "mimo-anthropic",
          labelKey: presetKey("mimoAnthropic"),
          protocol: "anthropic",
          protocolLocked: true,
          baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
          apiKeyUrl: MIMO_API_KEYS_URL,
          models: ["mimo-v2.5-pro"]
        },
        {
          id: "mimo-openai",
          labelKey: presetKey("mimoOpenai"),
          protocol: "openai",
          protocolLocked: true,
          baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
          apiKeyUrl: MIMO_API_KEYS_URL,
          models: ["mimo-v2.5-pro"]
        },
        {
          id: "agnes",
          labelKey: presetKey("agnes"),
          protocol: "openai",
          protocolLocked: true,
          baseUrl: "https://apihub.agnes-ai.com/v1",
          apiKeyUrl: AGNES_API_KEYS_URL,
          models: ["agnes-2.0-flash", "agnes-1.5-flash"]
        }
      ]
    },
    {
      kind: "relay",
      labelKey: `${modelPlansI18nPrefix}.templateGroups.relay.label`,
      guidanceKey: `${modelPlansI18nPrefix}.templateGroups.relay.guidance`,
      presets: [
        {
          id: "relay-custom",
          labelKey: presetKey("relayCustom"),
          protocol: "openai",
          protocolLocked: false,
          baseUrl: "",
          apiKeyUrl: null,
          models: []
        }
      ]
    },
    {
      kind: "custom",
      labelKey: `${modelPlansI18nPrefix}.templateGroups.custom.label`,
      guidanceKey: `${modelPlansI18nPrefix}.templateGroups.custom.guidance`,
      presets: [
        {
          id: "custom-openai",
          labelKey: presetKey("customOpenai"),
          protocol: "openai",
          protocolLocked: false,
          baseUrl: "",
          apiKeyUrl: null,
          models: []
        },
        {
          id: "custom-anthropic",
          labelKey: presetKey("customAnthropic"),
          protocol: "anthropic",
          protocolLocked: false,
          baseUrl: "",
          apiKeyUrl: null,
          models: []
        }
      ]
    }
  ];

export function getWorkspaceModelPlanTemplateGroup(
  kind: WorkspaceModelPlanTemplateKind
): WorkspaceModelPlanTemplateGroup | null {
  return (
    workspaceModelPlanTemplateGroups.find((group) => group.kind === kind) ??
    null
  );
}

export function workspaceModelPlanUsesNativeLogin(
  templateKind: WorkspaceModelPlanTemplateKind
): boolean {
  return templateKind === "official_subscription";
}

export function getWorkspaceModelPlanTemplatePreset(
  templateId: string | null
): WorkspaceModelPlanTemplatePreset | null {
  if (!templateId) {
    return null;
  }
  for (const group of workspaceModelPlanTemplateGroups) {
    const preset = group.presets.find(
      (candidate) => candidate.id === templateId
    );
    if (preset) {
      return preset;
    }
  }
  return null;
}

export function toWorkspaceModelPlanPresetModels(
  preset: WorkspaceModelPlanTemplatePreset
): WorkspaceModelPlanModel[] {
  return preset.models.map((id) => ({ id, name: id }));
}

/**
 * Wire protocol a given agent target provider can consume through a bound
 * model plan, read from the canonical provider catalog identity. Providers
 * without a compatible protocol cannot be bound yet.
 */
export function modelPlanProtocolForAgentProvider(
  provider: string
): WorkspaceModelPlanProtocol | null {
  return (resolveAgentGUIProviderCatalogIdentity(provider)?.modelPlanProtocol ||
    null) as WorkspaceModelPlanProtocol | null;
}
