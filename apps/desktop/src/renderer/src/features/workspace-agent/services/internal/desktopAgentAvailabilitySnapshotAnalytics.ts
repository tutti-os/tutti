import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import type {
  WorkspaceWindowLifecycle,
  WorkspaceWindowLifecycleEvent
} from "../../../../lib/workspaceWindowLifecycle.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import {
  AgentAvailabilitySnapshotTelemetry,
  type AgentAvailabilitySnapshotStorage
} from "./agentAvailabilitySnapshotTelemetry.ts";

interface DesktopAgentAvailabilitySnapshotAnalyticsDependencies {
  reporterService?: Pick<IReporterService, "trackEvents">;
  storage?: AgentAvailabilitySnapshotStorage | null;
}

export interface DesktopAgentAvailabilitySnapshotAnalyticsController {
  dispose(): void;
}

export function startDesktopAgentAvailabilitySnapshotAnalytics(input: {
  dependencies?: DesktopAgentAvailabilitySnapshotAnalyticsDependencies;
  lifecycle: WorkspaceWindowLifecycle;
  refreshStatuses(): Promise<readonly AgentProviderStatus[] | null>;
}): DesktopAgentAvailabilitySnapshotAnalyticsController {
  const telemetry = new AgentAvailabilitySnapshotTelemetry(input.dependencies);
  let disposed = false;
  let pendingActivation: WorkspaceWindowLifecycleEvent | null = null;
  let running = false;

  const drain = async (): Promise<void> => {
    running = true;
    while (!disposed && pendingActivation) {
      const activation = pendingActivation;
      pendingActivation = null;
      try {
        const statuses = await input.refreshStatuses();
        if (!disposed && statuses) {
          telemetry.reportStatuses(statuses, activation.occurredAt);
        }
      } catch {
        // Status refresh and analytics are best effort on window activation.
      }
    }
    running = false;
  };

  const unsubscribeLifecycle = input.lifecycle.subscribe((event) => {
    if (event.kind !== "opened" && event.kind !== "focused") {
      return;
    }
    pendingActivation = event;
    if (!running) {
      void drain();
    }
  });

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      pendingActivation = null;
      unsubscribeLifecycle();
    }
  };
}
