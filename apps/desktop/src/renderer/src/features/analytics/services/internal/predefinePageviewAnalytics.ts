import { AppPageviewReporter } from "../../reporters/app-pageview/appPageviewReporter.ts";
import type { IReporterService } from "../reporterService.interface.ts";

export interface PredefinePageviewAnalyticsController {
  dispose(): void;
  reportAppOpen(): void;
  reportFocus(): void;
}

export interface PredefinePageviewAnalyticsRuntime {
  addFocusListener(listener: () => void): () => void;
  scheduleFocusReport?(listener: () => void): () => void;
}

export function startPredefinePageviewAnalytics(input: {
  reporterNow?: () => number;
  reporterService: Pick<IReporterService, "trackEvents">;
  runtime?: PredefinePageviewAnalyticsRuntime;
}): PredefinePageviewAnalyticsController {
  const runtime = input.runtime ?? createDocumentPredefinePageviewRuntime();
  const now = input.reporterNow ?? Date.now;
  let disposed = false;
  const pendingFocusReports = new Set<() => void>();

  const reportPageview = () => {
    if (disposed) {
      return;
    }
    void new AppPageviewReporter({
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
    let cancelFocusReport = () => {};
    const runFocusReport = () => {
      pendingFocusReports.delete(cancelFocusReport);
      reportPageview();
    };
    cancelFocusReport =
      runtime.scheduleFocusReport?.(runFocusReport) ??
      createTimeoutFocusReport(runFocusReport);
    pendingFocusReports.add(cancelFocusReport);
  };

  const unsubscribeFocus = runtime.addFocusListener(reportFocus);

  reportAppOpen();

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const cancelFocusReport of pendingFocusReports) {
        cancelFocusReport();
      }
      pendingFocusReports.clear();
      unsubscribeFocus();
    },
    reportAppOpen,
    reportFocus
  };
}

function createTimeoutFocusReport(listener: () => void): () => void {
  const timeoutId = window.setTimeout(listener, 0);
  return () => {
    window.clearTimeout(timeoutId);
  };
}

function createDocumentPredefinePageviewRuntime(): PredefinePageviewAnalyticsRuntime {
  return {
    addFocusListener(listener) {
      window.addEventListener("focus", listener);
      return () => {
        window.removeEventListener("focus", listener);
      };
    },
    scheduleFocusReport(listener) {
      return createTimeoutFocusReport(listener);
    }
  };
}
