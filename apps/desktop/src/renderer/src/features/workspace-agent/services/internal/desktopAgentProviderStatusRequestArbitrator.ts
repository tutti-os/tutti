import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { reconcileProviderUpdateDiscoveries } from "./desktopAgentProviderStatusCatalog.ts";

interface AgentProviderStatusRequestIdentity {
  providers?: readonly WorkspaceAgentProvider[];
  includeUpdates?: boolean;
}

/**
 * Keeps ordinary status freshness and remote update-discovery freshness on
 * separate planes. A newer local readiness refresh must not make an older,
 * still-current update response stale.
 */
export class DesktopAgentProviderStatusRequestArbitrator {
  private latestWildcardRequestId = 0;
  private latestWildcardUpdateRequestId = 0;
  private readonly latestRequestIdByProvider = new Map<
    WorkspaceAgentProvider,
    number
  >();
  private readonly latestUpdateRequestIdByProvider = new Map<
    WorkspaceAgentProvider,
    number
  >();
  private readonly updateStatusByProvider = new Map<
    WorkspaceAgentProvider,
    AgentProviderStatus
  >();

  markLatest(input: AgentProviderStatusRequestIdentity, requestId: number) {
    const providers = input.providers;
    if (!providers || providers.length === 0) {
      this.latestWildcardRequestId = requestId;
      if (input.includeUpdates) {
        this.latestWildcardUpdateRequestId = requestId;
      }
      return;
    }
    for (const provider of providers) {
      this.latestRequestIdByProvider.set(provider, requestId);
      if (input.includeUpdates) {
        this.latestUpdateRequestIdByProvider.set(provider, requestId);
      }
    }
  }

  selectCurrentStatuses(
    statuses: readonly AgentProviderStatus[],
    requestId: number
  ): readonly AgentProviderStatus[] {
    return statuses.filter((status) =>
      this.isLatestStatusRequest(status.provider, requestId)
    );
  }

  captureCurrentUpdateStatuses(
    input: AgentProviderStatusRequestIdentity,
    statuses: readonly AgentProviderStatus[],
    requestId: number
  ): readonly AgentProviderStatus[] {
    if (!input.includeUpdates) {
      return [];
    }
    const currentStatuses = statuses.filter((status) =>
      this.isLatestUpdateStatusRequest(status.provider, requestId)
    );
    for (const status of currentStatuses) {
      this.updateStatusByProvider.set(status.provider, status);
    }
    return currentStatuses;
  }

  projectUpdateDiscoveries(input: {
    providers: ReadonlySet<WorkspaceAgentProvider>;
    statuses: readonly AgentProviderStatus[];
  }): ReturnType<typeof reconcileProviderUpdateDiscoveries> {
    return reconcileProviderUpdateDiscoveries({
      statuses: input.statuses,
      updateStatuses: [...input.providers].flatMap((provider) => {
        const status = this.updateStatusByProvider.get(provider);
        return status ? [status] : [];
      })
    });
  }

  isCurrentRequest(
    providers: readonly WorkspaceAgentProvider[] | undefined,
    requestId: number
  ): boolean {
    if (!providers || providers.length === 0) {
      return requestId >= this.latestWildcardRequestId;
    }
    return providers.some((provider) =>
      this.isLatestStatusRequest(provider, requestId)
    );
  }

  private isLatestUpdateStatusRequest(
    provider: WorkspaceAgentProvider,
    requestId: number
  ): boolean {
    return (
      requestId >= this.latestWildcardUpdateRequestId &&
      requestId >= (this.latestUpdateRequestIdByProvider.get(provider) ?? 0)
    );
  }

  private isLatestStatusRequest(
    provider: WorkspaceAgentProvider,
    requestId: number
  ): boolean {
    return (
      requestId >= this.latestWildcardRequestId &&
      requestId >= (this.latestRequestIdByProvider.get(provider) ?? 0)
    );
  }
}
