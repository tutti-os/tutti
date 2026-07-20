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
  let lastObservedDate = localDateKey(now());
  let hiddenSinceDate =
    documentRef.visibilityState === "hidden" ? lastObservedDate : null;

  const refreshStatuses = (input?: {
    force?: boolean;
    trigger?: "resume";
  }): void => {
    if (documentRef.visibilityState !== "visible") {
      return;
    }
    const currentTime = now();
    if (input?.force !== true && currentTime - lastRefreshAt < minIntervalMs) {
      return;
    }
    const capturedAt = service.getSnapshot?.().capturedAt;
    const capturedAtMs = capturedAt ? Date.parse(capturedAt) : Number.NaN;
    if (
      input?.force !== true &&
      Number.isFinite(capturedAtMs) &&
      currentTime - capturedAtMs < freshnessMs
    ) {
      return;
    }
    lastRefreshAt = currentTime;
    void service
      .refresh(
        providers,
        input?.trigger
          ? { availabilitySnapshotTrigger: input.trigger }
          : undefined
      )
      .catch(() => {});
  };

  const handleFocus = (): void => {
    const currentDate = localDateKey(now());
    const crossedDay = currentDate !== lastObservedDate;
    lastObservedDate = currentDate;
    refreshStatuses({ force: crossedDay });
  };
  const handleInteraction = (): void => {
    if (documentRef.visibilityState !== "visible") {
      return;
    }
    const currentDate = localDateKey(now());
    if (currentDate === lastObservedDate) {
      return;
    }
    lastObservedDate = currentDate;
    refreshStatuses({ force: true });
  };
  const handleVisibilityChange = (): void => {
    const currentDate = localDateKey(now());
    if (documentRef.visibilityState !== "visible") {
      hiddenSinceDate = currentDate;
      return;
    }
    const resumedAcrossDay =
      hiddenSinceDate !== null && hiddenSinceDate !== currentDate;
    const crossedDay = currentDate !== lastObservedDate;
    hiddenSinceDate = null;
    lastObservedDate = currentDate;
    refreshStatuses({
      force: crossedDay || resumedAcrossDay,
      trigger: resumedAcrossDay ? "resume" : undefined
    });
  };

  windowRef.addEventListener("focus", handleFocus);
  documentRef.addEventListener("keydown", handleInteraction);
  documentRef.addEventListener("pointerdown", handleInteraction);
  documentRef.addEventListener("visibilitychange", handleVisibilityChange);
  return () => {
    windowRef.removeEventListener("focus", handleFocus);
    documentRef.removeEventListener("keydown", handleInteraction);
    documentRef.removeEventListener("pointerdown", handleInteraction);
    documentRef.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}
