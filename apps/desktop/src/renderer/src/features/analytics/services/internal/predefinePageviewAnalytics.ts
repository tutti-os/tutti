import type {
  WorkspaceWindowLifecycle,
  WorkspaceWindowLifecycleEvent
} from "../../../../lib/workspaceWindowLifecycle.ts";
import { AppPageviewReporter } from "../../reporters/app-pageview/appPageviewReporter.ts";
import type { IReporterService } from "../reporterService.interface.ts";

export interface PredefinePageviewAnalyticsController {
  dispose(): void;
}

export function startPredefinePageviewAnalytics(input: {
  lifecycle: WorkspaceWindowLifecycle;
  reporterService: Pick<IReporterService, "trackEvents">;
  scheduleFocusReport?: (listener: () => void) => () => void;
}): PredefinePageviewAnalyticsController {
  let disposed = false;
  const pendingFocusReports = new Set<() => void>();

  const reportPageview = (occurredAt: number) => {
    if (disposed) {
      return;
    }
    void new AppPageviewReporter({
      now: () => occurredAt,
      reporterService: input.reporterService
    }).report();
  };

  const handleLifecycleEvent = (event: WorkspaceWindowLifecycleEvent) => {
    if (event.kind === "opened") {
      reportPageview(event.occurredAt);
      return;
    }
    if (event.kind !== "focused" || disposed) {
      return;
    }

    let cancelFocusReport = () => {};
    const runFocusReport = () => {
      pendingFocusReports.delete(cancelFocusReport);
      reportPageview(event.occurredAt);
    };
    cancelFocusReport = (input.scheduleFocusReport ?? scheduleTimeout)(
      runFocusReport
    );
    pendingFocusReports.add(cancelFocusReport);
  };

  const unsubscribeLifecycle = input.lifecycle.subscribe(handleLifecycleEvent);

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
      unsubscribeLifecycle();
    }
  };
}

function scheduleTimeout(listener: () => void): () => void {
  const timeoutId = window.setTimeout(listener, 0);
  return () => {
    window.clearTimeout(timeoutId);
  };
}
