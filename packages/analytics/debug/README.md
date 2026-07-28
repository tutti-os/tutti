# `@tutti-os/analytics-debug`

Host-agnostic storage and React UI for inspecting analytics events.

The package does not connect to a daemon, choose a feature flag, or own product
translations. Each host adapts its own event stream into
`AnalyticsDebugEventStore` and supplies localized labels to the React panel.
This keeps Tutti and TSH transport policy independent while sharing bounded
storage, redaction, rendering, and floating-panel behavior.

```ts
import { AnalyticsDebugEventStore } from "@tutti-os/analytics-debug";
import { AnalyticsDebugFloatingEntry } from "@tutti-os/analytics-debug/react";

const store = new AnalyticsDebugEventStore({
  redact: (event) => event
});

eventSource.subscribe((events) => store.recordEvents(events));
```

Hosts must load `@tutti-os/ui-system/styles.css` and include the published debug
bundle in Tailwind v4 source discovery. Adjust the relative path for the host
stylesheet, for example:

```css
@source "../node_modules/@tutti-os/analytics-debug/dist";
```

Events are kept in memory only. The default limit is 200 events. Hosts that may
receive sensitive parameters should supply a `redact` function before exposing
the panel.
