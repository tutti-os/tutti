import type {
  AgentProviderStatus,
  AgentProviderStatusListResponse,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { migratedAgentGUIProviderIdentityCatalog } from "@tutti-os/agent-gui/provider-catalog";
import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface";

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
  service: IAgentProviderStatusService,
  requiredProviders?: readonly WorkspaceAgentProvider[]
): Promise<AgentProviderStatusListResponse | null> {
  const requiredManagedProviders = (requiredProviders ?? []).filter(
    isDesktopManagedAgentProvider
  );
  if (requiredManagedProviders.length > 0) {
    return ensureRequiredDesktopManagedAgentProviderStatuses(
      service,
      requiredManagedProviders
    );
  }
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

async function ensureRequiredDesktopManagedAgentProviderStatuses(
  service: IAgentProviderStatusService,
  requiredProviders: readonly WorkspaceAgentProvider[]
): Promise<AgentProviderStatusListResponse | null> {
  const response = await service.ensureLoaded({
    providers: [...new Set(requiredProviders)]
  });
  void ensureAllDesktopManagedAgentProviderStatuses(service);
  return response;
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

export function isDesktopManagedAgentProvider(
  value: unknown
): value is WorkspaceAgentProvider {
  return desktopManagedAgentProviders.includes(
    value as (typeof desktopManagedAgentProviders)[number]
  );
}
