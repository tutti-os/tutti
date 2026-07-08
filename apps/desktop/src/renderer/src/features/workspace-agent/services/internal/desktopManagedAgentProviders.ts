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
  "cursor",
  "tutti-agent",
  "opencode",
  "hermes",
  "openclaw"
] as const satisfies readonly WorkspaceAgentProvider[];

const desktopManagedAgentStartupProviderPriority = [
  "codex",
  "claude-code",
  "cursor",
  "tutti-agent",
  "opencode",
  "hermes",
  "openclaw"
] as const satisfies readonly WorkspaceAgentProvider[];

export function ensureDesktopManagedAgentProviderStatuses(
  service: IAgentProviderStatusService
): Promise<AgentProviderStatusListResponse | null> {
  const snapshot = service.getSnapshot();
  const readyProvider = firstReadyDesktopManagedAgentProvider(
    snapshot.statuses
  );
  if (readyProvider) {
    void ensureAllDesktopManagedAgentProviderStatuses(service);
    return Promise.resolve({
      capturedAt: snapshot.capturedAt ?? "",
      defaultProvider: snapshot.defaultProvider ?? readyProvider,
      providers: [...snapshot.statuses]
    });
  }

  return ensureFirstReadyDesktopManagedAgentProviderStatus(service);
}

async function ensureFirstReadyDesktopManagedAgentProviderStatus(
  service: IAgentProviderStatusService
): Promise<AgentProviderStatusListResponse | null> {
  let lastResponse: AgentProviderStatusListResponse | null = null;
  for (const provider of desktopManagedAgentStartupProviderPriority) {
    lastResponse = await service.ensureLoaded({ providers: [provider] });
    if (
      firstReadyDesktopManagedAgentProvider(
        service.getSnapshot().statuses,
        provider
      )
    ) {
      void ensureAllDesktopManagedAgentProviderStatuses(service);
      return lastResponse;
    }
  }
  return ensureAllDesktopManagedAgentProviderStatuses(service);
}

export function ensureAllDesktopManagedAgentProviderStatuses(
  service: IAgentProviderStatusService
): Promise<AgentProviderStatusListResponse | null> {
  return service.ensureLoaded({
    providers: [...desktopManagedAgentProviders]
  });
}

function firstReadyDesktopManagedAgentProvider(
  statuses: readonly AgentProviderStatus[],
  provider?: WorkspaceAgentProvider
): WorkspaceAgentProvider | null {
  const statusByProvider = new Map(
    statuses.map((status) => [status.provider, status])
  );
  const providers = provider ? [provider] : desktopManagedAgentProviders;
  return (
    providers.find(
      (candidate) =>
        statusByProvider.get(candidate)?.availability.status === "ready"
    ) ?? null
  );
}

export function projectDesktopManagedAgentsStateForAgentGUI(
  snapshot: AgentProviderStatusSnapshot
): AgentHostManagedAgentsState | null {
  if (!snapshot.capturedAt) {
    return null;
  }

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
  const revision = snapshot.capturedAt;

  return {
    agentProfileRevision: `agent-provider-status:${revision}`,
    configSyncedAgentIds,
    readyAgentIds,
    items,
    metadataSynced: !snapshot.error,
    toolCatalogRevision: `agent-provider-status:${revision}`,
    totalCount: items.length
  };
}

export function hasRequiredDesktopManagedAgentProviderStatuses(
  snapshot: AgentProviderStatusSnapshot,
  requiredProviders: readonly WorkspaceAgentProvider[] | undefined
): boolean {
  if (!requiredProviders || requiredProviders.length === 0) {
    return true;
  }
  if (!snapshot.capturedAt) {
    return false;
  }

  const knownProviders = new Set(
    snapshot.statuses.map((status) => status.provider)
  );
  return requiredProviders.every((provider) => knownProviders.has(provider));
}

export function isDesktopManagedAgentProvider(
  value: unknown
): value is WorkspaceAgentProvider {
  return desktopManagedAgentProviders.includes(
    value as (typeof desktopManagedAgentProviders)[number]
  );
}
