import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface.ts";
import { desktopManagedAgentProviders } from "./desktopManagedAgentProviders.ts";

export interface DesktopAgentProviderVisibilityRefreshOptions {
  document?: Pick<
    Document,
    "addEventListener" | "removeEventListener" | "visibilityState"
  >;
  minIntervalMs?: number;
  freshnessMs?: number;
  now?: () => number;
  window?: Pick<Window, "addEventListener" | "removeEventListener">;
}

export function bindDesktopManagedAgentProviderVisibilityRefresh(
  service: Pick<IAgentProviderStatusService, "refresh"> &
    Partial<Pick<IAgentProviderStatusService, "getSnapshot">>,
  options: DesktopAgentProviderVisibilityRefreshOptions = {}
): () => void {
  const windowRef =
    options.window ?? (typeof window !== "undefined" ? window : null);
  const documentRef =
    options.document ?? (typeof document !== "undefined" ? document : null);
  if (!windowRef || !documentRef) {
    return () => {};
  }

  const minIntervalMs = options.minIntervalMs ?? 10_000;
  const freshnessMs = options.freshnessMs ?? 30 * 60 * 1_000;
  const now = options.now ?? Date.now;
  const providers = [...desktopManagedAgentProviders];
  let lastRefreshAt = Number.NEGATIVE_INFINITY;

  const refreshStatuses = (): void => {
    if (documentRef.visibilityState !== "visible") {
      return;
    }
    const currentTime = now();
    if (currentTime - lastRefreshAt < minIntervalMs) {
      return;
    }
    const capturedAt = service.getSnapshot?.().capturedAt;
    const capturedAtMs = capturedAt ? Date.parse(capturedAt) : Number.NaN;
    if (
      Number.isFinite(capturedAtMs) &&
      currentTime - capturedAtMs < freshnessMs
    ) {
      return;
    }
    lastRefreshAt = currentTime;
    void service.refresh(providers).catch(() => {});
  };

  windowRef.addEventListener("focus", refreshStatuses);
  documentRef.addEventListener("visibilitychange", refreshStatuses);
  return () => {
    windowRef.removeEventListener("focus", refreshStatuses);
    documentRef.removeEventListener("visibilitychange", refreshStatuses);
  };
}
