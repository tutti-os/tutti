import type { WorkspaceWindowLifecycle } from "../../../../lib/workspaceWindowLifecycle.ts";
import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface.ts";
import { desktopManagedAgentProviders } from "./desktopManagedAgentProviders.ts";

export interface DesktopAgentProviderVisibilityRefreshOptions {
  minIntervalMs?: number;
  freshnessMs?: number;
  now?: () => number;
  pollIntervalMs?: number;
  clearInterval?: (timer: unknown) => void;
  setInterval?: (callback: () => void, delayMs: number) => unknown;
}

export function bindDesktopManagedAgentProviderVisibilityRefresh(
  service: Pick<IAgentProviderStatusService, "reconcileStatuses"> &
    Partial<Pick<IAgentProviderStatusService, "getSnapshot">>,
  lifecycle: WorkspaceWindowLifecycle,
  options: DesktopAgentProviderVisibilityRefreshOptions = {}
): () => void {
  const minIntervalMs = options.minIntervalMs ?? 10_000;
  const freshnessMs = options.freshnessMs ?? 15 * 60 * 1_000;
  const pollIntervalMs = options.pollIntervalMs ?? 15 * 60 * 1_000;
  const now = options.now ?? Date.now;
  const providers = [...desktopManagedAgentProviders];
  let lastRefreshAt = Number.NEGATIVE_INFINITY;
  let disposed = false;
  let running = false;

  const refreshIfStale = (occurredAt: number): void => {
    if (
      disposed ||
      running ||
      lifecycle.getSnapshot().visibility !== "visible" ||
      !lifecycle.getSnapshot().focused ||
      occurredAt - lastRefreshAt < minIntervalMs
    ) {
      return;
    }
    const capturedAt = service.getSnapshot?.().capturedAt;
    const capturedAtMs = capturedAt ? Date.parse(capturedAt) : Number.NaN;
    if (
      Number.isFinite(capturedAtMs) &&
      occurredAt - capturedAtMs < freshnessMs
    ) {
      return;
    }
    lastRefreshAt = occurredAt;
    void reconcileProviders();
  };

  const reconcileProviders = async (): Promise<void> => {
    running = true;
    try {
      for (const provider of providers) {
        if (
          disposed ||
          lifecycle.getSnapshot().visibility !== "visible" ||
          !lifecycle.getSnapshot().focused
        ) {
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
    if (!activated) {
      return;
    }
    refreshIfStale(event.occurredAt);
  });

  const setRefreshInterval =
    options.setInterval ??
    (typeof window === "undefined"
      ? null
      : (callback: () => void, delayMs: number) =>
          window.setInterval(callback, delayMs));
  const clearRefreshInterval =
    options.clearInterval ??
    (typeof window === "undefined"
      ? null
      : (timer: unknown) => window.clearInterval(timer as number));
  const pollTimer = setRefreshInterval?.(
    () => refreshIfStale(now()),
    pollIntervalMs
  );

  return () => {
    disposed = true;
    unsubscribe();
    if (pollTimer !== undefined) {
      clearRefreshInterval?.(pollTimer);
    }
  };
}
