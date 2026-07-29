import type { DesktopI18nKey } from "@shared/i18n";
import { resolveAgentGUIProviderCatalogIdentity } from "@tutti-os/agent-gui/provider-catalog";
import type {
  WorkspaceModelPlanDraftSeed,
  WorkspaceModelPlanProtocol,
  WorkspaceModelPlanTemplateKind
} from "./workspaceSettingsTypes";

/**
 * Presentation metadata retained for plans saved with an earlier access
 * category. New plans always use the single endpoint configuration below.
 */
export interface WorkspaceModelPlanTemplateGroup {
  readonly kind: WorkspaceModelPlanTemplateKind;
  readonly labelKey: DesktopI18nKey;
  readonly guidanceKey: DesktopI18nKey;
}

const modelPlansI18nPrefix = "workspace.settings.apps.modelPlans" as const;

export const workspaceModelPlanCreationSeed = {
  baseUrl: "",
  protocol: "openai",
  templateId: null,
  templateKind: "custom"
} satisfies WorkspaceModelPlanDraftSeed;

export const workspaceModelPlanTemplateGroups: readonly WorkspaceModelPlanTemplateGroup[] =
  [
    {
      kind: "official_subscription",
      labelKey: `${modelPlansI18nPrefix}.templateGroups.officialSubscription.label`,
      guidanceKey: `${modelPlansI18nPrefix}.templateGroups.officialSubscription.guidance`
    },
    {
      kind: "coding_plan",
      labelKey: `${modelPlansI18nPrefix}.templateGroups.codingPlan.label`,
      guidanceKey: `${modelPlansI18nPrefix}.templateGroups.codingPlan.guidance`
    },
    {
      kind: "domestic",
      labelKey: `${modelPlansI18nPrefix}.templateGroups.domestic.label`,
      guidanceKey: `${modelPlansI18nPrefix}.templateGroups.domestic.guidance`
    },
    {
      kind: "relay",
      labelKey: `${modelPlansI18nPrefix}.templateGroups.relay.label`,
      guidanceKey: `${modelPlansI18nPrefix}.templateGroups.relay.guidance`
    },
    {
      kind: "custom",
      labelKey: `${modelPlansI18nPrefix}.templateGroups.custom.label`,
      guidanceKey: `${modelPlansI18nPrefix}.templateGroups.custom.guidance`
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
