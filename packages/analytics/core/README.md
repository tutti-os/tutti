# `@tutti-os/analytics`

Shared renderer analytics infrastructure for Tutti applications.

The package owns the best-effort `ReporterService`, its DI service identifier,
and the renderer-to-daemon transport contract. Product repositories still own
event catalogs, event-specific parameter types, and daemon HTTP adapters.

```ts
import {
  IReporterService,
  ReporterService,
  type AnalyticsTransport
} from "@tutti-os/analytics";

const transport: AnalyticsTransport = {
  async trackEvents(events) {
    await desktopDaemon.reportAnalyticsEvents({ events });
  }
};

const reporter = new ReporterService({ transport });
await reporter.track("workspace.opened", { source: "dashboard" });
```

Transport failures are intentionally swallowed so analytics never interrupts a
renderer product flow.
