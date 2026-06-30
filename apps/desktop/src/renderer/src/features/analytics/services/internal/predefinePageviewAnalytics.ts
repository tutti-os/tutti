import { PredefinePageviewReporter } from "../../reporters/predefine-pageview/predefinePageviewReporter.ts";
import type { IReporterService } from "../reporterService.interface.ts";

const focusedDayStorageKey = "tutti.analytics.predefine_pageview.focused_day";

export interface PredefinePageviewAnalyticsController {
  dispose(): void;
  reportAppOpen(): void;
  reportFocus(): void;
}

export interface PredefinePageviewAnalyticsRuntime {
  addFocusListener(listener: () => void): () => void;
}

export interface PredefinePageviewAnalyticsStorage {
  getFocusedDay(): string | null;
  setFocusedDay(dayKey: string): void;
}

export function startPredefinePageviewAnalytics(input: {
  reporterNow?: () => number;
  reporterService: Pick<IReporterService, "trackEvents">;
  runtime?: PredefinePageviewAnalyticsRuntime;
  storage?: PredefinePageviewAnalyticsStorage;
}): PredefinePageviewAnalyticsController {
  const runtime = input.runtime ?? createDocumentPredefinePageviewRuntime();
  const storage = input.storage ?? createLocalStoragePredefinePageviewStorage();
  const now = input.reporterNow ?? Date.now;
  let disposed = false;

  const reportPageview = () => {
    if (disposed) {
      return;
    }
    void new PredefinePageviewReporter({
      now,
      reporterService: input.reporterService
    }).report();
  };

  const reportAppOpen = () => {
    reportPageview();
  };

  const reportFocus = () => {
    if (disposed) {
      return;
    }
    const dayKey = toLocalDayKey(now());
    if (storage.getFocusedDay() === dayKey) {
      return;
    }
    storage.setFocusedDay(dayKey);
    reportPageview();
  };

  const unsubscribeFocus = runtime.addFocusListener(reportFocus);

  reportAppOpen();

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeFocus();
    },
    reportAppOpen,
    reportFocus
  };
}

function toLocalDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function createDocumentPredefinePageviewRuntime(): PredefinePageviewAnalyticsRuntime {
  return {
    addFocusListener(listener) {
      window.addEventListener("focus", listener);
      return () => {
        window.removeEventListener("focus", listener);
      };
    }
  };
}

function createLocalStoragePredefinePageviewStorage(): PredefinePageviewAnalyticsStorage {
  return {
    getFocusedDay() {
      try {
        return globalThis.localStorage.getItem(focusedDayStorageKey);
      } catch {
        return null;
      }
    },
    setFocusedDay(dayKey) {
      try {
        globalThis.localStorage.setItem(focusedDayStorageKey, dayKey);
      } catch {
        // Storage is only a dedupe aid; analytics remains best-effort.
      }
    }
  };
}
