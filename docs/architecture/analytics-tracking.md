# Analytics Tracking

This document describes the analytics event tracking architecture for tutti.

## Purpose

tutti uses 火山引擎 DataFinder (Tea SDK) as the analytics platform. All tracking
events — whether originating from user interactions in the renderer or from
daemon-side lifecycle operations — are reported through a single pipeline owned
by `tuttid`.

## Architecture Decision: Unified tuttid Pipeline

All events route through tuttid before reaching the Tea backend.

```
renderer (JS)                tuttid (Go)              Tea / DataFinder
─────────────────────────────────────────────────────────────────────────
user interaction  ──POST──▶  merge common params  ──▶  火山引擎 Server SDK
daemon lifecycle  ──direct▶  merge common params  ──▶  best-effort HTTP send
```

Renderer does not load or initialize any Tea SDK. It only sends raw event
payloads to tuttid via a local HTTP call. tuttid is the sole Tea client.

### Multi-window pageview ownership

The desktop main process grants predefine pageview ownership to only the first
workspace renderer window created during the current app process. It encodes
that decision in the window bootstrap query as
`reportPredefinePageview=1|0`. The owning window reports the initial
`app.pageview` and later focus pageviews; secondary OS or standalone Agent
windows do not start the predefine pageview listener.

Ownership is process-scoped and is not transferred when the first window
closes. A new desktop process creates a new owner. Browser-only and legacy
renderer routes without the bootstrap parameter keep pageview reporting
enabled for compatibility. This gate applies only to the predefine
`app.pageview` stream used for DAU/PV measurement; workspace and feature
business events continue to report from the window where the action occurs.

**Why tuttid owns reporting:**

- tuttid always starts before the renderer, so there is no Tea SDK startup
  ordering problem in the renderer
- Common params such as `device_id`, `session_id`, `os`, and `app_version` are
  owned by tuttid and do not need to be replicated or synchronized to the
  renderer
- Batch scheduling and retry behavior live in one place (the Go Tea SDK)
- Renderer has no dependency on external scripts or CSP relaxations for Tea

## Common Params

Common params are split by ownership. tuttid injects its params on every event
before forwarding to Tea. The renderer supplies only the params it uniquely
knows.

| Param              | Owner    | Notes                                               |
| ------------------ | -------- | --------------------------------------------------- |
| `device_id`        | tuttid   | Persisted UUID in state dir; stable across restarts |
| `session_id`       | tuttid   | UUID generated once at daemon startup               |
| `app_version`      | tuttid   | Resolved from generated defaults or env override    |
| `os`               | tuttid   | Resolved at startup                                 |
| `client_ts`        | renderer | Millisecond timestamp at the moment the event fired |
| `dark_mode`        | renderer | `"1"` or `"0"`                                      |
| UI-specific params | renderer | Passed through `params` object                      |

tuttid never tries to infer UI-state params. Renderer never tries to supply
identity or platform params.

## Event Naming Convention

Event names follow the product analytics spec's dot-separated domain action
pattern.

| Pattern             | Meaning                                      | Examples                      |
| ------------------- | -------------------------------------------- | ----------------------------- |
| `<domain>.<action>` | Product domain plus confirmed business event | `workspace.opened`            |
| Nested domains      | Larger feature area plus action              | `agent.session_started`       |
| Error domains       | Feature-specific error event                 | `error.workspace_unavailable` |

## API Contract

### Renderer → tuttid

```
POST /v1/track
Authorization: Bearer <per-run token>
Content-Type: application/json

{
  "events": [
    {
      "name": "workspace.opened",
      "client_ts": 1749124800000,
      "params": {
        "source": "dashboard",
        "dark_mode": "1"
      }
    }
  ]
}
```

Response: `202 Accepted`, empty body.

The endpoint is fire-and-forget. The renderer does not wait for Tea confirmation.
Delivery is handled asynchronously by tuttid and the Go SDK.

`POST /v1/track` is part of the canonical tuttid OpenAPI contract in
`services/tuttid/api/openapi/tuttid.v1.yaml`. Go and TypeScript transport
types are generated from that source like other daemon routes.

The request contract is enforced by tuttid:

- `events` must contain 1 to 100 items
- `name` must match `^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$` and be at most 128
  characters
- `client_ts` must be a positive millisecond timestamp

## Configuration

Tea SDK config follows the same pattern as other tutti defaults: a single
source of truth in `config/tutti.defaults.json`, code-generated into Go and
TypeScript, with env var overrides for CI and local development.

### `config/tutti.defaults.json`

The `analytics` section defines the default DataFinder configuration:

```json
{
  "analytics": {
    "appId": 20004092,
    "appKey": "3a7e11907d4f4dba62193392de606331ebaf90e8fd197babf71c9e06a9a74282",
    "channel": "sg",
    "channelDomain": "https://gator.uba.ap-southeast-1.volces.com",
    "appVersion": "0.0.0"
  }
}
```

`appId` and `appKey` are the 火山引擎 DataFinder credentials for the tutti
app. These values are embedded in the distributed binary and are not secrets
in the traditional sense — they identify the product, not a user.

### Code Generation

`tools/scripts/generate-defaults.mjs` is extended to render the `analytics`
block into `services/tuttid/types/defaults_generated.go` alongside the
existing state, transport, and logging blocks.

The generated Go struct:

```go
Analytics: generatedAnalyticsDefaults{
    AppID:         20004092,
    AppKey:        "...",
    Channel:       "sg",
    ChannelDomain: "https://gator.uba.ap-southeast-1.volces.com",
    AppVersion:    "0.0.0",
},
```

### Runtime Resolution

`types/defaults.go` exposes an `AnalyticsConfig` resolved from generated
defaults plus env var overrides:

```go
type AnalyticsConfig struct {
    Disabled      bool
    AppID         int
    AppKey        string
    Channel       string
    ChannelDomain string
    AppVersion    string
}
```

Supported env var overrides:

| Variable                         | Effect                                              |
| -------------------------------- | --------------------------------------------------- |
| `TUTTI_ENV=development`          | Use debug-only reporting; no remote events sent     |
| `TUTTI_APP_VERSION`              | Shared desktop app version propagated to tuttid     |
| `TUTTI_ANALYTICS_DISABLED=true`  | Switch to `NoopReporter`; no events sent            |
| `TUTTI_ANALYTICS_APP_ID`         | Override app ID (dev/test Tea app)                  |
| `TUTTI_ANALYTICS_APP_KEY`        | Override app key                                    |
| `TUTTI_ANALYTICS_CHANNEL_DOMAIN` | Override endpoint URL                               |
| `TUTTI_ANALYTICS_APP_VERSION`    | Compatibility override for app version common param |

`TUTTI_ENV=development` uses debug-only reporting so local development can
inspect emitted events in the analytics debug panel without making Tea SDK
network requests. `TUTTI_ANALYTICS_DISABLED` is the explicit kill switch when a
run should not publish any local or remote events.
Recognized disabled values are `1`, `true`, and `yes`; recognized false values
are `0`, `false`, and `no`. Unknown non-empty values fail closed and disable
reporting. Invalid `TUTTI_ANALYTICS_APP_ID` values resolve to `0`, which also
selects `NoopReporter`.

Managed desktop launches set `TUTTI_APP_VERSION` from Electron
`app.getVersion()` before starting tuttid, so DataFinder `app_version` follows
the packaged desktop app version. `TUTTI_ANALYTICS_APP_VERSION` remains as a
narrow compatibility override and takes precedence when set.

### Reporter Construction

`newTuttiWiring()` calls `types.ResolveAnalyticsConfig()`, then constructs a
`DebugReporter` in development, a `TeaReporter` in production when config is
present and not disabled, or a `NoopReporter` when reporting is disabled or
production config is incomplete. No other part of tuttid is aware of which
implementation is active.

## Go Implementation: `service/reporter/`

```
services/tuttid/service/reporter/
  reporter.go        # Reporter interface and Event type
  tea_reporter.go    # datarangers-sdk-go implementation
  debug_reporter.go  # local analytics debug events without remote reporting
  noop_reporter.go   # no-op for tests and disabled reporting
  device_id.go       # load-or-create device_id from state dir
```

### Reporter interface

```go
type Event struct {
    Name     string
    ClientTS int64          // 0 means use current time
    Params   map[string]any
}

type Reporter interface {
    Track(ctx context.Context, events ...Event)
    Close() error
}
```

`TeaReporter` wraps `github.com/volcengine/datarangers-sdk-go`. It injects
common params on every `Track` call before handing events to the SDK. The SDK
uses HTTP mode with SDK batch mode disabled, a bounded async queue wait, and
controlled SDK log paths under the tutti state directory.

`NoopReporter` is used in unit tests and when Tea credentials are absent (e.g.
local development without credentials configured).

### Device ID

`device_id` is a UUID generated once and written to `<state-dir>/device_id`. On
subsequent startups the file is read and the same ID is reused. This gives a
stable anonymous device identity across daemon restarts without requiring user
authentication.

### Wiring

`Reporter` is constructed in `newTuttiWiring()` and injected into `DaemonAPI`.
`wiring.Close()` calls `reporter.Close()` during graceful shutdown. The current
DataFinder Go SDK exposes no public HTTP-mode hard-flush API, so `TeaReporter`
keeps the lifecycle hook but treats close as best-effort for HTTP reporting.

## TypeScript Implementation

### `apps/desktop/src/renderer/src/features/analytics`

The desktop renderer exposes `IReporterService` as the business-facing
analytics entrypoint:

```ts
interface IReporterService {
  track(name: string, params?: Record<string, unknown>): Promise<void>;
  trackEvents(events: ReporterEventInput[]): Promise<void>;
}
```

The service is registered in the workspace window DI container and depends on
`TuttidClient.trackEvents()` for transport. Renderer business code should
depend on `IReporterService`, not on the low-level tuttid client method.

`ReporterService` owns renderer-side reporting behavior:

- `track()` wraps one business event
- `trackEvents()` accepts a batch of renderer event inputs
- `clientTS` defaults to `Date.now()` and is converted to the OpenAPI
  `client_ts` field
- event `params` are copied before transport handoff
- transport failures are swallowed because renderer analytics is best-effort
  and must not affect product flows

### `packages/clients/tuttid-ts`

`packages/clients/tuttid-ts` exposes a hand-written `trackEvents` convenience
method on `TuttidClient`:

```ts
trackEvents(events: TrackEvent[]): Promise<void>
```

The method calls the generated OpenAPI SDK and reuses generated request types.

## Rules

- Renderer must not initialize or reference any Tea SDK directly
- Renderer business code should report through `IReporterService` rather than
  calling `TuttidClient.trackEvents()` directly
- `POST /v1/track` acknowledges local acceptance only; callers may await the
  local `202`, but must not wait for Tea/DataFinder delivery confirmation
- `client_ts` must be set by the caller to the moment the event occurred, not
  the moment the HTTP call is made
- `daemon_` prefixed events are reported directly via `Reporter.Track()`; they
  do not go through the HTTP endpoint
- Common params (`device_id`, `session_id`, `os`, `app_version`) must not be
  sent by the renderer; tuttid always overwrites them
- `TeaReporter.Close()` must be called during graceful shutdown; with the
  current DataFinder Go SDK HTTP mode this is a best-effort lifecycle hook, not
  a hard flush guarantee
- Use `NoopReporter` in tests; never make real Tea calls from test code
- Set `TUTTI_ANALYTICS_DISABLED=true` in local development and CI to avoid
  polluting production analytics data
- Do not read Tea credentials from anywhere other than `ResolveAnalyticsConfig()`
- After modifying `config/tutti.defaults.json`, always re-run
  `generate-defaults.mjs` and commit the generated files together
