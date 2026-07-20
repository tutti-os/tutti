import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface.ts";
import {
  AgentAvailabilitySnapshotTelemetry,
  type AgentAvailabilitySnapshotStorage
} from "./agentAvailabilitySnapshotTelemetry.ts";
import { desktopManagedAgentProviders } from "./desktopManagedAgentProviders.ts";

interface DesktopAgentAvailabilitySnapshotPageviewReportDependencies {
  now?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  storage?: AgentAvailabilitySnapshotStorage | null;
}

export function createDesktopAgentAvailabilitySnapshotPageviewReport(
  service: Pick<IAgentProviderStatusService, "getSnapshot" | "refresh">,
  dependencies: DesktopAgentAvailabilitySnapshotPageviewReportDependencies = {}
): () => Promise<void> {
  const providers = [...desktopManagedAgentProviders];
  const providerSet = new Set<WorkspaceAgentProvider>(providers);
  const telemetry = new AgentAvailabilitySnapshotTelemetry(dependencies);

  return async () => {
    await service.refresh(providers);
    const snapshot = service.getSnapshot();
    if (snapshot.error) {
      return;
    }
    telemetry.reportStatuses(
      snapshot.statuses.filter(isManagedProviderStatus(providerSet))
    );
  };
}

function isManagedProviderStatus(
  providers: ReadonlySet<WorkspaceAgentProvider>
): (status: AgentProviderStatus) => boolean {
  return (status) => providers.has(status.provider);
}
