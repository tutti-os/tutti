import type { WorkspaceWindowLifecycle } from "../../../../lib/workspaceWindowLifecycle.ts";
import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface.ts";
import { desktopManagedAgentProviders } from "./desktopManagedAgentProviders.ts";

export interface DesktopAgentProviderVisibilityRefreshOptions {
  minIntervalMs?: number;
  freshnessMs?: number;
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
    running = true;
    try {
      for (const provider of providers) {
        if (disposed || lifecycle.getSnapshot().visibility !== "visible") {
          return;
        }
        await service.reconcileStatuses([provider]).catch(() => null);
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
    if (event.occurredAt - lastRefreshAt < minIntervalMs) {
      return;
    }
    const capturedAt = service.getSnapshot?.().capturedAt;
    const capturedAtMs = capturedAt ? Date.parse(capturedAt) : Number.NaN;
    if (
      Number.isFinite(capturedAtMs) &&
      event.occurredAt - capturedAtMs < freshnessMs
    ) {
      return;
    }
    lastRefreshAt = event.occurredAt;
    void reconcileProviders();
  });

  return () => {
    disposed = true;
    unsubscribe();
  };
}
