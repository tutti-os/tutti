import type { WorkspaceWindowLifecycle } from "../../../../lib/workspaceWindowLifecycle.ts";
import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface.ts";
import { desktopManagedAgentProviders } from "./desktopManagedAgentProviders.ts";

export interface DesktopAgentProviderVisibilityRefreshOptions {
  minIntervalMs?: number;
  freshnessMs?: number;
  /**
   * Returns true when update discovery already refreshed provider statuses for
   * this activation, so the ordinary reconciliation can be skipped.
   */
  refreshForActivation?: () => Promise<boolean>;
}

export function bindDesktopManagedAgentProviderVisibilityRefresh(
  service: Pick<IAgentProviderStatusService, "reconcileStatuses"> &
    Partial<Pick<IAgentProviderStatusService, "getSnapshot">>,
  lifecycle: WorkspaceWindowLifecycle,
  options: DesktopAgentProviderVisibilityRefreshOptions = {}
): () => void {
  const minIntervalMs = options.minIntervalMs ?? 10_000;
  const freshnessMs = options.freshnessMs ?? 30 * 60 * 1_000;
  const providers = [...desktopManagedAgentProviders];
  let lastRefreshAt = Number.NEGATIVE_INFINITY;
  let disposed = false;
  let running = false;

  const reconcileProviders = async (): Promise<void> => {
    for (const provider of providers) {
      if (disposed || lifecycle.getSnapshot().visibility !== "visible") {
        return;
      }
      await service.reconcileStatuses([provider]).catch(() => null);
    }
  };

  const refreshActivatedWindow = async (
    ordinaryReconciliationRequired: boolean
  ): Promise<void> => {
    running = true;
    try {
      const updateDiscoveryHandled =
        (await options.refreshForActivation?.().catch(() => false)) ?? false;
      if (!updateDiscoveryHandled && ordinaryReconciliationRequired) {
        await reconcileProviders();
      }
    } finally {
      running = false;
    }
  };

  const unsubscribe = lifecycle.subscribe((event) => {
    const activated =
      event.kind === "focused" ||
      (event.kind === "visibility_changed" && event.visibility === "visible");
    if (
      !activated ||
      running ||
      lifecycle.getSnapshot().visibility !== "visible"
    ) {
      return;
    }
    const capturedAt = service.getSnapshot?.().capturedAt;
    const capturedAtMs = capturedAt ? Date.parse(capturedAt) : Number.NaN;
    const snapshotIsFresh =
      Number.isFinite(capturedAtMs) &&
      event.occurredAt - capturedAtMs < freshnessMs;
    const ordinaryReconciliationRequired =
      !snapshotIsFresh && event.occurredAt - lastRefreshAt >= minIntervalMs;
    if (!ordinaryReconciliationRequired && !options.refreshForActivation) {
      return;
    }
    if (ordinaryReconciliationRequired) {
      lastRefreshAt = event.occurredAt;
    }
    void refreshActivatedWindow(ordinaryReconciliationRequired);
  });

  return () => {
    disposed = true;
    unsubscribe();
  };
}
