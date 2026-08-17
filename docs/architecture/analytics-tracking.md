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

Shared renderer modules depend only on `@tutti-os/analytics` and receive an
`IReporterService` from the host composition root. `TuttidClient`,
`DesktopdAnalyticsClient`, event catalogs, and product-specific common
parameters stay in their respective host adapters.

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
- Common params such as `device_id`, `session_id`, `os`, `app_version`, and
  account identity are owned by tuttid and do not need to be replicated or
  synchronized to the renderer
- Batch scheduling and retry behavior live in one place (the Go Tea SDK)
- Renderer has no dependency on external scripts or CSP relaxations for Tea

## Common Params

Common params are split by ownership. tuttid injects its params on every event
before forwarding to Tea. The renderer supplies only the params it uniquely
knows.

Runtime and application metadata that DataFinder defines as preset properties
is sent in the SDK header as well as retained in the legacy custom common
params where one already exists. This keeps existing dashboards compatible
while allowing DataFinder's built-in dimensions to receive `os_name`,
`os_version`, `app_version`, `app_version_minor`, and `cpu_abi`. The reporter
sends the exact configured application version to both version fields. This
preserves prerelease suffixes such as `-rc.0` in `app_version_minor` when
DataFinder normalizes `app_version`. Event UUIDs follow the same transition:
`event_id` remains in event params and is also assigned to the SDK event's
preset ID field.

| Param               | Owner    | Notes                                               |
| ------------------- | -------- | --------------------------------------------------- |
| `device_id`         | tuttid   | Persisted UUID in state dir; stable across restarts |
| `session_id`        | tuttid   | UUID generated once at daemon startup               |
| `app_version`       | tuttid   | Resolved from generated defaults or env override    |
| `app_version_minor` | tuttid   | Exact version, including prerelease suffixes        |
| `os`                | tuttid   | Resolved at startup                                 |
| `os_name`           | tuttid   | Preset SDK header; currently the Go runtime OS key  |
| `os_version`        | tuttid   | Preset SDK header; best-effort product OS version   |
| `cpu_abi`           | tuttid   | Preset SDK header; Go runtime architecture key      |
| `event_id`          | tuttid   | Generated UUID when the event does not supply one   |
| `authority`         | tuttid   | `"client"` for Tutti Desktop events                 |
| `business_app_id`   | tuttid   | Tutti account/commerce application ID               |
| `client`            | tuttid   | `"desktop"`                                         |
| `environment`       | tuttid   | Runtime environment                                 |
| `schema_version`    | tuttid   | Current analytics contract version                  |
| `uid`               | tuttid   | Authenticated account ID; absent when anonymous     |
| `login_state`       | tuttid   | `"authenticated"` or `"anonymous"`                  |
| `identity_status`   | tuttid   | Identity readiness for the current event            |
| `membership_status` | tuttid   | Current membership state or `"unknown"`             |
| `membership_tier`   | tuttid   | Current tier key, `"free"`, or `"unknown"`          |
| `client_ts`         | renderer | Millisecond timestamp at the moment the event fired |
| `dark_mode`         | renderer | `"1"` or `"0"`                                      |
| `mode`              | renderer | Current workspace shell: `"os"` or `"agent"`        |
| UI-specific params  | renderer | Passed through `params` object                      |

tuttid never tries to infer UI-state params. Renderer never tries to supply
identity or platform params.

The account service supplies dynamic identity parameters and the matching
DataFinder `user_unique_id` as one atomic snapshot. A login or logout cannot
produce an event whose SDK identity disagrees with its own `uid` and
`login_state`. Anonymous events use the stable `device_id` as the SDK identity.
When tuttid starts with a persisted account session, it restores the UID before
the reporter begins handling product events; membership fields remain
`"unknown"` until the product summary is refreshed.

The renderer derives `mode` from the native window route. `view=agent` reports
`"agent"`; `view=workspace`, legacy routes, and unknown routes report `"os"`,
matching the renderer's actual fallback behavior. This remains renderer-owned
because multiple OS and Agent windows can coexist while sharing one tuttid
process.

### Agent send funnel ownership

AgentGUI submits through the shared `AgentSessionEngine` command port. The
successful `session/activate` and `queue/sendPrompt` command boundaries own
`agent.session_started`, `agent.message_sent`, and their `agent.node_result`
events. Keep this telemetry on the corresponding
`WorkspaceAgentActivityService` Engine effects; `AgentGUIRuntime` contains no
lifecycle writes. Non-AgentGUI prompt-session integrations keep their explicit
tracker because they call the activity service without entering the shared
engine.

## Event Naming Convention

Event names follow the product analytics spec's dot-separated domain action
pattern.

| Pattern             | Meaning                                      | Examples                      |
| ------------------- | -------------------------------------------- | ----------------------------- |
| `<domain>.<action>` | Product domain plus confirmed business event | `workspace.opened`            |
| Nested domains      | Larger feature area plus action              | `agent.session_started`       |
| Error domains       | Feature-specific error event                 | `error.workspace_unavailable` |

### Account login

Tutti Desktop reports the unified `account.login` event:

| Stage   | Action     | Result                         | Meaning                             |
| ------- | ---------- | ------------------------------ | ----------------------------------- |
| `login` | `start`    | `started`                      | Desktop login attempt accepted      |
| `login` | `complete` | `success`                      | Login completed with a resolved UID |
| `login` | `complete` | `failed / cancelled / expired` | Terminal unsuccessful result        |

Every attempt carries a stable `flow_id`. Login success rate is distinct
successful terminal `flow_id` divided by distinct started `flow_id`. Daily
logged-in users are distinct `uid` values on successful terminal events, with
dashboard day boundaries evaluated in `Asia/Shanghai`.

### Workspace UI mode changes

The desktop reports `settings.workspace_ui_mode_changed` after the selected
workspace UI mode has been persisted. The event carries `previous_mode`,
`next_mode`, and an `action` that describes the standalone Agent mode:
`"enabled"` when changing from OS to Agent and `"disabled"` when changing from
Agent to OS. Selecting the already persisted mode or failing to persist the
preference does not emit an event.

The renderer records the durable preference change and passes the transition
metadata in the same IPC request that replaces the current workspace window.
The durable main process starts the analytics transport after the replacement
window is ready and before destroying the previous renderer. This lets the new
window's debug subscriber observe the event while ensuring old-window teardown
cannot discard the handoff. The transport remains best-effort and is not
awaited by the mode-switch product flow: a delayed or rejected analytics
request must never delay replacement or turn a successful preference write
into a save failure. If replacement fails before a new window is ready, main
still reports the already-persisted change before returning the failure because
the saved preference will apply when a workspace window is next opened. This
event measures explicit mode changes through `previous_mode` and `next_mode`.
It does not set the renderer-owned common `mode` field: after an earlier
replacement failure, the durable preference and the actual native owner-window
route can temporarily differ, and the main process must not guess that route.

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
- `name` must match `^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$` and be at most 128
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

## Shared Go Implementation

```
packages/analytics/reporter-go/
  reporter.go         # Public Reporter, Event, and product-neutral config
  tea_reporter.go     # datarangers-sdk-go implementation
  debug_reporter.go   # Local debug events without remote reporting
  noop_reporter.go    # No-op for tests, disabled, or incomplete config
  tea_sdk_adapter.go  # Vendor SDK boundary and bounded SDK settings

services/tuttid/service/reporter/
  reporter.go         # Tutti config adapter and compatibility aliases
  events/             # Tutti-owned typed daemon business events
```

`github.com/tutti-os/tutti/packages/analytics/reporter-go` is a public Go
module. It is the reusable lower SDK for Tutti products such as TSH. Product
repositories own their event catalog, HTTP contract, configuration, and
business emission points; they must not copy the DataFinder adapter.

## Shared Debug Panel

`@tutti-os/analytics-debug` owns the bounded in-memory event store, redaction
hook, and reusable React floating panel. It does not own daemon connections,
availability flags, persisted preferences, or product translations.

Tutti adapts the `analytics.debug.reported` event stream into the shared store
after daemon common parameters have been applied. Other hosts provide their own
event-source adapter and localized labels. Debug payloads are never persisted;
hosts should supply a redactor when their event parameters may contain
sensitive values.

Tutti connects this stream only when the debug feature is available in a
development build. It intentionally retains a bounded history from application
startup so developers can inspect events emitted before opening the panel. The
history is process-memory only, is discarded on exit, and contains the same
final payload already sent to the configured analytics transport.

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
common params on every `Track` call before handing events to the SDK. Hosts may
supply an existing durable `DeviceID`, static common parameters, and one
`DynamicContextProvider`. That provider returns dynamic common parameters and
the matching DataFinder user identity in one snapshot. The shared reporter
always owns and protects `device_id`, `session_id`, `app_version`, and `os`.
The SDK uses HTTP mode with SDK batch mode disabled, a bounded async queue wait,
and controlled SDK log paths under the product state directory.

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

### `@tutti-os/analytics`

`packages/analytics/core` publishes the business-facing `IReporterService`,
`ReporterService`, and renderer-to-daemon `AnalyticsTransport` contract:

```ts
interface IReporterService {
  track(name: string, params?: Record<string, unknown>): Promise<void>;
  trackEvents(events: ReporterEventInput[]): Promise<void>;
}
```

The desktop renderer registers the shared service in the workspace window DI
container. Its local adapter implements `AnalyticsTransport` with
`TuttidClient.trackEvents()`. Renderer business code depends on
`IReporterService`, not on the low-level tuttid client method.

Reusable business packages own the events whose trigger semantics are inside
the package. They receive `Pick<IReporterService, "trackEvents">` from the host
composition root and report their exact event contracts directly. For example,
`@tutti-os/workspace-issue-manager` owns issue/task actions and converts its
camel-case domain params to the analytics wire shape before reporting. A host
must not redispatch those events through a product-local reporter switch.
Host-only events such as pageviews and shell lifecycle events remain in the
host.

`ReporterService` owns renderer-side reporting behavior:

- `track()` wraps one business event
- `trackEvents()` accepts a batch of renderer event inputs
- `clientTS` defaults to `Date.now()`
- a product adapter converts the shared transport event to its daemon OpenAPI
  representation (`client_ts` for tuttid)
- event `params` are copied before transport handoff
- transport failures are swallowed because renderer analytics is best-effort
  and must not affect product flows

Agent error codes and error normalization are Agent-domain policy rather than
analytics-core policy. Renderer mappings live with `workspace-agent`; daemon
codes live in `services/tuttid/biz/agentanalytics`. Typed analytics events
consume those domain values without owning or redefining the mapping.

### `packages/clients/tuttid-ts`

`packages/clients/tuttid-ts` exposes a hand-written `trackEvents` convenience
method on `TuttidClient`:

```ts
trackEvents(events: TrackEvent[]): Promise<void>
```

The method calls the generated OpenAPI SDK and reuses generated request types.

## Rules

- Renderer must not initialize or reference any Tea SDK directly
- Renderer business code must reuse `@tutti-os/analytics` and report through
  `IReporterService` rather than calling daemon clients directly
- Shared modules own their internal event names, exact params, and trigger
  timing; hosts only inject `IReporterService`
- Agent error classification must stay in the Agent domain
- `POST /v1/track` acknowledges local acceptance only; callers may await the
  local `202`, but must not wait for Tea/DataFinder delivery confirmation
- `client_ts` must be set by the caller to the moment the event occurred, not
  the moment the HTTP call is made
- `daemon_` prefixed events are reported directly via `Reporter.Track()`; they
  do not go through the HTTP endpoint
- Daemon-owned common params (`device_id`, `session_id`, `os`, `app_version`,
  identity fields, authority, app, client, environment, and schema version)
  must not be sent by the renderer; tuttid always overwrites them
- `TeaReporter.Close()` must be called during graceful shutdown; with the
  current DataFinder Go SDK HTTP mode this is a best-effort lifecycle hook, not
  a hard flush guarantee
- Use `NoopReporter` in tests; never make real Tea calls from test code
- Set `TUTTI_ANALYTICS_DISABLED=true` in local development and CI to avoid
  polluting production analytics data
- Do not read Tea credentials from anywhere other than `ResolveAnalyticsConfig()`
- After modifying `config/tutti.defaults.json`, always re-run
  `generate-defaults.mjs` and commit the generated files together

## Agent Host terminal failure telemetry

Agent Host may emit aggregated terminal failures through
`TerminalFailureObserver`. Sources:

- failed `session_create` / `message_send` lifecycle commands
- guidance target binding failures (`flow=guidance`,
  `failure_stage=guidance_target`) before claim creation or when the runtime
  rejects an exact turn target before provider admission
- goal-control prepare / refresh command failures, and durable
  `GoalOperationFailed` / terminal incidents
- durable runtime-operation failures for `interactive_response`,
  `plan_decision`, `turn_cancel`, and `edit_retry`
- settled failed / interrupted root turns (including child/subagent sessions
  via `IsChildSession`)
- failed / errored `tool_call` messages in session-message commits

Out of scope for dedicated Host terminal-failure flows:

- queue as a separate event family (queued submits still fail as
  `message_send` / turn settlements; `isQueued` remains a diagnostic trait)
- session fork (TSH does not expose fork)
- file-change card open failures (desktop UI / TSH Analytics only)
- shared-agent product events (owned by the shared-agent analytics track)

Adapters should map those observations into product analytics events. Do not
promote every `LifecycleStep` into a product analytics event; lifecycle steps
remain diagnostic. Terminal failures carry the original error message and
failure stage for investigation without user-supplied logs.

### Who extracts failures from a committed delta

`Host.notifyCommitted` owns delta terminal failures. It calls
`ObserveTerminalFailuresFromDelta` before `NotifyCommitted`, so every commit
Host publishes is already accounted for by the time observers run. A
`CommitObserver` — `ActivityProjection.ObserveCommitted` included — must never
re-observe the delta it receives; doing so double-counts every durable runtime,
goal, turn, and tool-call failure whenever the same observer is wired to both.

A report path that commits and fans out without going through Host calls
`ObserveTerminalFailuresFromDelta` exactly once next to its own
`NotifyCommitted`. In tuttid that path is
`ActivityProjection.observeCommittedOutsideHost`, the single entrypoint for the
direct activity-state, session-message, and stale-turn reports;
`ActivityProjection.SetTerminalFailureObserver` exists to feed it. Canonical
bookkeeping commits (`CanonicalDelta`) carry no failure-bearing sections, so
they need no extraction.

Because the observed `RuntimeOperations`, `EffectiveHistory`, and `GoalStore`
wrappers are the only source of durable runtime and goal commit deltas, `New`
installs them when either `CommitObserver` or `TerminalFailureObserver` is
configured. An adapter that wants failure analytics alone still gets them.
