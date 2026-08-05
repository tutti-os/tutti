import type {
  AgentGUIAgent,
  AgentGUIProviderUpdateNotice
} from "@tutti-os/agent-gui";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import {
  desktopManagedAgentProviders,
  isDesktopManagedAgentProvider,
  resolveDesktopManagedAgentTargetId
} from "./desktopManagedAgentProviders.ts";

export interface DesktopAgentCLIUpdateItem {
  agentTargetId: string;
  currentVersion: string;
  latestVersion: string;
  provider: WorkspaceAgentProvider;
}

export function desktopAgentCLIUpdateItemKey(
  item: Pick<DesktopAgentCLIUpdateItem, "provider" | "latestVersion">
): string {
  return `${item.provider}:${item.latestVersion}`;
}

export function desktopAgentCLIUpdateItemsEqual(
  left: DesktopAgentCLIUpdateItem,
  right: DesktopAgentCLIUpdateItem
): boolean {
  return (
    left.agentTargetId === right.agentTargetId &&
    left.currentVersion === right.currentVersion &&
    left.latestVersion === right.latestVersion &&
    left.provider === right.provider
  );
}

export function projectDesktopAgentCLIUpdateNoticesForTarget(
  notices: readonly AgentGUIProviderUpdateNotice[],
  agentTargetId: string | null | undefined
): readonly AgentGUIProviderUpdateNotice[] {
  const normalizedAgentTargetId = agentTargetId?.trim() ?? "";
  if (!normalizedAgentTargetId) {
    return [];
  }
  return notices.filter(
    (notice) => notice.agentTargetId === normalizedAgentTargetId
  );
}

export function projectDesktopAgentCLIUpdateItems(
  statuses: readonly AgentProviderStatus[],
  agents: readonly AgentGUIAgent[]
): readonly DesktopAgentCLIUpdateItem[] {
  const statusByProvider = new Map(
    statuses.map((status) => [status.provider, status])
  );
  const agentByTargetId = new Map(
    agents.map((agent) => [agent.agentTargetId.trim(), agent])
  );

  return desktopManagedAgentProviders.flatMap((provider) => {
    const status = statusByProvider.get(provider);
    const currentVersion = status?.update.currentVersion?.trim() ?? "";
    const latestVersion = status?.update.latestVersion?.trim() ?? "";
    if (
      !status ||
      !isDesktopManagedAgentProvider(status.provider) ||
      status.update.updateAvailable !== true ||
      !status.actions.some((action) => action.id === "update") ||
      !currentVersion ||
      !latestVersion
    ) {
      return [];
    }

    const agentTargetId = resolveDesktopManagedAgentTargetId(provider);
    const agent = agentTargetId ? agentByTargetId.get(agentTargetId) : null;
    if (
      !agent ||
      agent.provider !== provider ||
      agent.ownership === "shared" ||
      agent.setupKind === "target_runtime"
    ) {
      return [];
    }
    return [
      {
        agentTargetId: agent.agentTargetId,
        currentVersion,
        latestVersion,
        provider
      }
    ];
  });
}

export function hasDesktopAgentCLIUpdateConverged(
  item: DesktopAgentCLIUpdateItem,
  update: AgentProviderStatus["update"] | null | undefined
): boolean {
  const currentVersion = update?.currentVersion?.trim() ?? "";
  return Boolean(
    currentVersion &&
    currentVersion !== item.currentVersion &&
    update?.updateAvailable !== true
  );
}
