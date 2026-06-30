import type {
  AgentProviderStatus,
  AgentProviderStatusListResponse,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { AgentHostManagedAgentsState } from "@shared/contracts/dto";
import type {
  AgentProviderStatusSnapshot,
  IAgentProviderStatusService
} from "../agentProviderStatusService.interface";

export const desktopManagedAgentProviders = [
  "claude-code",
  "codex",
  "nexight",
  "gemini",
  "hermes",
  "openclaw"
] as const satisfies readonly WorkspaceAgentProvider[];

export function ensureDesktopManagedAgentProviderStatuses(
  service: IAgentProviderStatusService
): Promise<AgentProviderStatusListResponse | null> {
  return service.ensureLoaded({
    providers: [...desktopManagedAgentProviders]
  });
}

export function projectDesktopManagedAgentsState(
  snapshot: AgentProviderStatusSnapshot
): AgentHostManagedAgentsState {
  const statusByProvider = new Map<WorkspaceAgentProvider, AgentProviderStatus>(
    snapshot.statuses.map((status) => [status.provider, status])
  );
  const readyAgentIds: string[] = [];
  const configSyncedAgentIds: string[] = [];
  const items = desktopManagedAgentProviders.map((provider) => {
    const status = statusByProvider.get(provider);
    // Ready means the provider can open AgentGUI; auth_required is excluded.
    if (status?.availability.status === "ready") {
      readyAgentIds.push(provider);
    }
    if (status?.adapter.installed) {
      configSyncedAgentIds.push(provider);
    }

    return {
      agentId: provider,
      decisionReason:
        status?.availability.reasonCode ??
        status?.availability.status ??
        "status-unavailable",
      fallbackApplied: false,
      hostConfigDetected: status?.adapter.installed ?? false,
      hostDetected: status?.cli.installed ?? false,
      hostVersion: status?.cli.version ?? undefined,
      targetVersion: status?.cli.version ?? "latest",
      toolClass: "extend-agent",
      toolId: `${provider}-cli`
    };
  });
  const revision = snapshot.capturedAt ?? "pending";

  return {
    agentProfileRevision: `agent-provider-status:${revision}`,
    configSyncedAgentIds,
    readyAgentIds,
    items,
    metadataSynced: Boolean(snapshot.capturedAt && !snapshot.error),
    toolCatalogRevision: `agent-provider-status:${revision}`,
    totalCount: items.length
  };
}

export function projectDesktopManagedAgentsStateForAgentGUI(
  snapshot: AgentProviderStatusSnapshot
): AgentHostManagedAgentsState | null {
  if (!snapshot.capturedAt) {
    return null;
  }

  return projectDesktopManagedAgentsState(snapshot);
}

export function isDesktopManagedAgentProvider(
  value: unknown
): value is WorkspaceAgentProvider {
  return desktopManagedAgentProviders.includes(
    value as (typeof desktopManagedAgentProviders)[number]
  );
}
