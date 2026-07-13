import type {
  AgentProviderStatus,
  AgentProviderStatusListResponse,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { AgentHostManagedAgentsState } from "@shared/contracts/dto";
import { migratedAgentGUIProviderIdentityCatalog } from "@tutti-os/agent-gui/provider-catalog";
import type {
  AgentProviderStatusSnapshot,
  IAgentProviderStatusService
} from "../agentProviderStatusService.interface";

const desktopManagedAgentCatalog =
  migratedAgentGUIProviderIdentityCatalog.filter(
    (entry) => entry.desktop.managed
  );

export const desktopManagedAgentProviders: readonly WorkspaceAgentProvider[] = [
  ...desktopManagedAgentCatalog
]
  .sort((left, right) => left.desktop.managedOrder - right.desktop.managedOrder)
  .map((entry) => entry.providerId as WorkspaceAgentProvider);

const desktopManagedAgentStartupProviderPriority = [
  ...desktopManagedAgentCatalog
]
  .sort(
    (left, right) =>
      left.desktop.statusProbePriority - right.desktop.statusProbePriority
  )
  .map((entry) => entry.providerId as WorkspaceAgentProvider);

export const desktopManagedAgentDefaultProvider: WorkspaceAgentProvider =
  (desktopManagedAgentCatalog
    .filter((entry) => entry.desktop.defaultProviderEligible)
    .sort(
      (left, right) =>
        left.desktop.defaultProviderPriority -
        right.desktop.defaultProviderPriority
    )[0]?.providerId as WorkspaceAgentProvider | undefined) ??
  desktopManagedAgentProviders[0]!;

export const desktopInstallBootstrapProviders: readonly WorkspaceAgentProvider[] =
  desktopManagedAgentCatalog
    .filter((entry) => entry.desktop.installBootstrap)
    .map((entry) => entry.providerId as WorkspaceAgentProvider);

export const desktopAccountRefreshProviders: readonly WorkspaceAgentProvider[] =
  desktopManagedAgentCatalog
    .filter((entry) => entry.desktop.refreshOnAccountChange)
    .map((entry) => entry.providerId as WorkspaceAgentProvider);

export function desktopManagedAgentVisibilityGate(
  provider: WorkspaceAgentProvider
): string {
  return (
    desktopManagedAgentCatalog.find((entry) => entry.providerId === provider)
      ?.desktop.visibilityGate ?? ""
  );
}

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
