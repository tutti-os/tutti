# `@tutti-os/analytics`

Shared renderer analytics infrastructure for Tutti applications.

The package owns the best-effort `ReporterService`, its DI service identifier,
the renderer-to-daemon transport contract, a typed business-event reporter
base, and a no-op implementation for optional integrations. Product
repositories still own event catalogs, event-specific parameter types, domain
enrichment, and daemon HTTP adapters.

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

Reusable domain packages may accept
`Pick<IReporterService, "trackEvents">` and emit their own domain-owned events.
The product composition root remains responsible for registering the concrete
service and transport.
