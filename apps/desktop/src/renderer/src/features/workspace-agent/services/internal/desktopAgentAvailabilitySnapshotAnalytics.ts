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
  readStatuses(): readonly AgentProviderStatus[] | null;
  subscribeStatuses(listener: () => void): () => void;
}): DesktopAgentAvailabilitySnapshotAnalyticsController {
  const telemetry = new AgentAvailabilitySnapshotTelemetry(input.dependencies);
  let disposed = false;
  const pendingActivations: WorkspaceWindowLifecycleEvent[] = [];

  const reportPendingActivations = (): void => {
    if (disposed || pendingActivations.length === 0) {
      return;
    }
    const statuses = input.readStatuses();
    if (!statuses) {
      return;
    }
    for (const activation of pendingActivations.splice(0)) {
      telemetry.reportStatuses(statuses, activation.occurredAt);
    }
  };

  const unsubscribeStatuses = input.subscribeStatuses(reportPendingActivations);
  const unsubscribeLifecycle = input.lifecycle.subscribe((event) => {
    if (event.kind !== "opened" && event.kind !== "focused") {
      return;
    }
    pendingActivations.push(event);
    reportPendingActivations();
  });

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      pendingActivations.length = 0;
      unsubscribeStatuses();
      unsubscribeLifecycle();
    }
  };
}
