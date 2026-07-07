import type { BrowserNodeEvent } from "@tutti-os/browser-node";
import { BrowserClosedReporter } from "../../../analytics/reporters/browser-closed/browserClosedReporter.ts";
import { BrowserOpenedReporter } from "../../../analytics/reporters/browser-opened/browserOpenedReporter.ts";
import {
  createAnalyticsOpenedSourceParams,
  type AnalyticsOpenSource
} from "../../../analytics/reporters/openedSource.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import type { TrackedWorkbenchNodeLease } from "./workspaceNodeLifecycleAnalytics.ts";

export interface WorkspaceBrowserAnalyticsTracker {
  createNodeLease(
    context: WorkspaceBrowserAnalyticsNodeLeaseContext
  ): TrackedWorkbenchNodeLease | null;
  observeEvent(event: BrowserNodeEvent): void;
}

export interface WorkspaceBrowserAnalyticsNodeLeaseContext {
  node: {
    data?: {
      launchSource?: string | null;
    };
    id: string;
  };
}

export function createWorkspaceBrowserAnalyticsTracker(input: {
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
}): WorkspaceBrowserAnalyticsTracker {
  const reporterService = input.reporterService;
  if (!reporterService) {
    return {
      createNodeLease: () => null,
      observeEvent: () => undefined
    };
  }

  const openedAtByNodeId = new Map<string, number>();
  const leasedNodeIds = new Set<string>();
  const pendingRuntimeOpenTimers = new Map<
    string,
    ReturnType<typeof globalThis.setTimeout>
  >();
  const now = () => input.reporterNow?.() ?? Date.now();
  const reporterDependencies = {
    now: input.reporterNow,
    reporterService
  };

  const reportOpenedIfNeeded = (
    nodeId: string,
    source: AnalyticsOpenSource
  ) => {
    if (openedAtByNodeId.has(nodeId)) {
      return;
    }
    openedAtByNodeId.set(nodeId, now());
    void new BrowserOpenedReporter(
      createAnalyticsOpenedSourceParams(source),
      reporterDependencies
    ).report();
  };

  const cancelPendingRuntimeOpen = (nodeId: string) => {
    const timer = pendingRuntimeOpenTimers.get(nodeId);
    if (!timer) {
      return;
    }
    globalThis.clearTimeout(timer);
    pendingRuntimeOpenTimers.delete(nodeId);
  };

  const reportClosed = (nodeId: string) => {
    const openedAt = openedAtByNodeId.get(nodeId);
    if (openedAt === undefined) {
      return;
    }
    openedAtByNodeId.delete(nodeId);
    void new BrowserClosedReporter(
      {
        durationMs: Math.max(0, now() - openedAt)
      },
      reporterDependencies
    ).report();
  };

  return {
    createNodeLease(context) {
      const nodeId = context.node.id;
      leasedNodeIds.add(nodeId);
      cancelPendingRuntimeOpen(nodeId);
      reportOpenedIfNeeded(
        nodeId,
        resolveBrowserOpenedSource(context.node.data?.launchSource)
      );
      return {
        release() {
          cancelPendingRuntimeOpen(nodeId);
          leasedNodeIds.delete(nodeId);
          reportClosed(nodeId);
        }
      };
    },
    observeEvent(event) {
      if (event.type === "closed") {
        if (leasedNodeIds.has(event.nodeId)) {
          return;
        }
        reportClosed(event.nodeId);
        return;
      }
      if (event.type === "state" && event.lifecycle === "active") {
        if (
          openedAtByNodeId.has(event.nodeId) ||
          pendingRuntimeOpenTimers.has(event.nodeId)
        ) {
          return;
        }
        pendingRuntimeOpenTimers.set(
          event.nodeId,
          globalThis.setTimeout(() => {
            pendingRuntimeOpenTimers.delete(event.nodeId);
            if (leasedNodeIds.has(event.nodeId)) {
              return;
            }
            reportOpenedIfNeeded(event.nodeId, "restore");
          }, 0)
        );
        return;
      }

      return;
    }
  };
}

function resolveBrowserOpenedSource(
  launchSource: string | null | undefined
): AnalyticsOpenSource {
  switch (launchSource) {
    case "agent_command":
    case "browser":
    case "command":
    case "dock":
    case "file_manager":
    case "keyboard":
    case "launchpad":
    case "terminal":
    case "workspace_app":
      return launchSource;
    default:
      return "restore";
  }
}
