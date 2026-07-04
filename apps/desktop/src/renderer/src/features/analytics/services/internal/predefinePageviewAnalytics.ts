import { AppPageviewReporter } from "../../reporters/app-pageview/appPageviewReporter.ts";
import type { IReporterService } from "../reporterService.interface.ts";

export interface PredefinePageviewAnalyticsController {
  dispose(): void;
  reportAppOpen(): void;
  reportFocus(): void;
}

export interface PredefinePageviewAnalyticsRuntime {
  addFocusListener(listener: () => void): () => void;
}

export function startPredefinePageviewAnalytics(input: {
  reporterNow?: () => number;
  reporterService: Pick<IReporterService, "trackEvents">;
  runtime?: PredefinePageviewAnalyticsRuntime;
}): PredefinePageviewAnalyticsController {
  const runtime = input.runtime ?? createDocumentPredefinePageviewRuntime();
  const now = input.reporterNow ?? Date.now;
  let disposed = false;

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
