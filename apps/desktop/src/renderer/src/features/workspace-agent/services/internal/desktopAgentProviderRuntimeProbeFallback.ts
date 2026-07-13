import type {
  AgentProviderProbeResponse,
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { resolveAgentGUIProviderCatalogIdentity } from "@tutti-os/agent-gui/provider-catalog";

export function applyDesktopAgentProviderRuntimeProbeFallbacks(input: {
  probeProvider: (
    provider: WorkspaceAgentProvider
  ) => Promise<AgentProviderProbeResponse>;
  requestedProviders: readonly WorkspaceAgentProvider[] | undefined;
  statuses: readonly AgentProviderStatus[];
}): readonly AgentProviderStatus[] | Promise<readonly AgentProviderStatus[]> {
  const probeProviders = runtimeProbeFallbackProviderList(
    input.statuses,
    input.requestedProviders
  );
  if (probeProviders.length === 0) {
    return input.statuses;
  }
  return applyRuntimeProbeFallbacks({
    probeProvider: input.probeProvider,
    probeProviders,
    statuses: input.statuses
  });
}

async function applyRuntimeProbeFallbacks(input: {
  probeProvider: (
    provider: WorkspaceAgentProvider
  ) => Promise<AgentProviderProbeResponse>;
  probeProviders: readonly WorkspaceAgentProvider[];
  statuses: readonly AgentProviderStatus[];
}): Promise<readonly AgentProviderStatus[]> {
  const statusByProvider = new Map(
    input.statuses.map((status) => [status.provider, status])
  );
  for (const provider of input.probeProviders) {
    const status = statusByProvider.get(provider);
    const probe = await probeProviderRuntime(input.probeProvider, provider);
    if (!probe) {
      continue;
    }
    if (probe.status === "ready") {
      statusByProvider.set(
        provider,
        mergeReadyProbeStatus(provider, status, probe)
      );
      continue;
    }
    if (status) {
      statusByProvider.set(provider, mergeFailedProbeStatus(status, probe));
    }
  }

  const patchedStatuses = input.statuses.map(
    (status) => statusByProvider.get(status.provider) ?? status
  );
  for (const provider of input.probeProviders) {
    if (!patchedStatuses.some((status) => status.provider === provider)) {
      const status = statusByProvider.get(provider);
      if (status) {
        return [...patchedStatuses, status];
      }
    }
  }
  return patchedStatuses;
}

function runtimeProbeFallbackProviderList(
  statuses: readonly AgentProviderStatus[],
  requestedProviders: readonly WorkspaceAgentProvider[] | undefined
): WorkspaceAgentProvider[] {
  if (!requestedProviders || requestedProviders.length === 0) {
    return [];
  }

  const statusByProvider = new Map(
    statuses.map((status) => [status.provider, status])
  );
  return requestedProviders.filter((provider) => {
    const strategy =
      resolveAgentGUIProviderCatalogIdentity(provider)?.desktop
        .runtimeProbeFallback;
    if (strategy !== "direct") {
      return false;
    }
    const status = statusByProvider.get(provider);
    return !status || status.availability.status === "unknown";
  });
}

async function probeProviderRuntime(
  probeProvider: (
    provider: WorkspaceAgentProvider
  ) => Promise<AgentProviderProbeResponse>,
  provider: WorkspaceAgentProvider
): Promise<AgentProviderProbeResponse | null> {
  try {
    return await probeProvider(provider);
  } catch {
    return null;
  }
}

function mergeReadyProbeStatus(
  provider: WorkspaceAgentProvider,
  status: AgentProviderStatus | undefined,
  probe: AgentProviderProbeResponse
): AgentProviderStatus {
  return {
    provider,
    availability: {
      ...status?.availability,
      checkedAt: probe.checkedAt,
      reasonCode: undefined,
      status: "ready"
    },
    cli: {
      ...status?.cli,
      binaryPath: status?.cli.binaryPath ?? probe.binaryPath,
      installed: true
    },
    adapter: {
      ...status?.adapter,
      binaryPath: status?.adapter.binaryPath ?? probe.binaryPath,
      command:
        probe.command.length > 0
          ? probe.command
          : (status?.adapter.command ?? []),
      installed: true
    },
    auth: {
      ...status?.auth,
      status:
        status?.auth.status && status.auth.status !== "unknown"
          ? status.auth.status
          : "authenticated"
    },
    actions: status?.actions.filter((action) => action.id !== "refresh") ?? [],
    activeAction: status?.activeAction,
    network: status?.network
  };
}

function mergeFailedProbeStatus(
  status: AgentProviderStatus,
  probe: AgentProviderProbeResponse
): AgentProviderStatus {
  if (probe.status === "ready") {
    return status;
  }
  return {
    ...status,
    availability: {
      ...status.availability,
      checkedAt: probe.checkedAt,
      reasonCode: probe.reasonCode ?? status.availability.reasonCode
    }
  };
}
