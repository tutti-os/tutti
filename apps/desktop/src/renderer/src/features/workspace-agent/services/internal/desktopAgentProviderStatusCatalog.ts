import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";

export function reconcileProviderStatuses(input: {
  previousStatuses: readonly AgentProviderStatus[];
  requestedProviders: readonly WorkspaceAgentProvider[] | undefined;
  responseStatuses: readonly AgentProviderStatus[];
  transientDowngradeCounts: Map<string, number>;
}): readonly AgentProviderStatus[] {
  const previousByProvider = new Map(
    input.previousStatuses.map((status) => [status.provider, status])
  );
  const nextByProvider = new Map<string, AgentProviderStatus>();
  for (const status of input.responseStatuses) {
    const previous = previousByProvider.get(status.provider);
    nextByProvider.set(
      status.provider,
      preserveNetwork(
        previous,
        stabilizeProviderStatus(
          previous,
          status,
          input.transientDowngradeCounts
        )
      )
    );
  }
  if (!input.requestedProviders || input.requestedProviders.length === 0) {
    return input.responseStatuses.map(
      (status) => nextByProvider.get(status.provider) ?? status
    );
  }
  const merged = input.previousStatuses.map(
    (status) => nextByProvider.get(status.provider) ?? status
  );
  const existingProviders = new Set(merged.map((status) => status.provider));
  for (const status of input.responseStatuses) {
    if (!existingProviders.has(status.provider)) {
      merged.push(nextByProvider.get(status.provider) ?? status);
    }
  }
  return merged;
}

function preserveNetwork(
  previous: AgentProviderStatus | undefined,
  next: AgentProviderStatus
): AgentProviderStatus {
  if (next.network || !previous?.network) {
    return next;
  }
  return { ...next, network: previous.network };
}

function stabilizeProviderStatus(
  previous: AgentProviderStatus | undefined,
  next: AgentProviderStatus,
  transientDowngradeCounts: Map<string, number>
): AgentProviderStatus {
  if (!previous || !isTransientProviderStatusDowngrade(previous, next)) {
    transientDowngradeCounts.delete(next.provider);
    return next;
  }
  const count = transientDowngradeCounts.get(next.provider) ?? 0;
  transientDowngradeCounts.set(next.provider, count + 1);
  return count === 0 ? previous : next;
}

function isTransientProviderStatusDowngrade(
  previous: AgentProviderStatus,
  next: AgentProviderStatus
): boolean {
  if (previous.provider !== next.provider) {
    return false;
  }
  const reasonCode = next.availability.reasonCode ?? "";
  return (
    previous.availability.status === "ready" &&
    next.cli.installed &&
    next.adapter.installed &&
    next.availability.status === "auth_required" &&
    (reasonCode === "auth_required" || reasonCode === "auth_unknown")
  );
}
