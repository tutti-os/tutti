import type { DesktopI18nKey } from "@shared/i18n";
import type { DesktopFeatureFlags } from "@shared/preferences";
import type { AgentTargetPresentation } from "../../workspace-agent/services/agentsService.interface.ts";
import type { DesktopAgentProviderManageRowStatus } from "../../workspace-agent/ui/desktopAgentProviderManageDialogModel.ts";
import {
  EARLY_ACCESS_AGENT_EXTENSION_INTEGRATIONS,
  isFeatureEnabled,
  type AgentExtensionActivationFlag
} from "../../../../../shared/featureFlags/catalog.ts";

export interface WorkspaceAgentExtensionSettingsRow {
  activationFlag: AgentExtensionActivationFlag;
  agentTargetId: string;
  enabled: boolean;
  iconUrl: string;
  key: string;
  labelKey: DesktopI18nKey;
  status: DesktopAgentProviderManageRowStatus;
}

export function projectWorkspaceAgentExtensionSettingsRows(input: {
  agentTargets: readonly AgentTargetPresentation[];
  directoryLoading: boolean;
  earlyAccessEnabled: boolean;
  featureFlags: DesktopFeatureFlags;
}): WorkspaceAgentExtensionSettingsRow[] {
  if (!input.earlyAccessEnabled) {
    return [];
  }

  const targetById = new Map(
    input.agentTargets.map((target) => [target.agentTargetId, target])
  );

  return EARLY_ACCESS_AGENT_EXTENSION_INTEGRATIONS.map((integration) => {
    const enabled = isFeatureEnabled(
      input.featureFlags,
      integration.activationFlag
    );
    const target = targetById.get(integration.targetId) ?? null;
    return {
      activationFlag: integration.activationFlag,
      agentTargetId: integration.targetId,
      enabled,
      iconUrl: target?.iconUrl ?? "",
      key: integration.key,
      labelKey: integration.labelKey,
      status: resolveExtensionEnvironmentStatus({
        directoryLoading: input.directoryLoading,
        enabled,
        target
      })
    };
  });
}

function resolveExtensionEnvironmentStatus(input: {
  directoryLoading: boolean;
  enabled: boolean;
  target: AgentTargetPresentation | null;
}): DesktopAgentProviderManageRowStatus {
  if (!input.enabled) {
    return "unknown";
  }
  if (!input.target) {
    return input.directoryLoading ? "checking" : "unknown";
  }
  switch (input.target.availability.status) {
    case "ready":
      return "connected";
    case "checking":
      return "checking";
    case "not_installed":
      return "available";
    case "auth_required":
      return "auth_required";
    case "coming_soon":
    case "unavailable":
      return "unsupported";
  }
}
