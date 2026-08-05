# @tutti-os/connector-market

`@tutti-os/connector-market` is the host-neutral connector-market boundary
shared by Tutti and other approved desktop daemon hosts such as TSH.

The package deliberately owns three matching contracts:

- `daemon`: Go domain types, state transitions, manifest validation, ports, and
  the application service boundary
- `openapi/connector-market.v1.yaml`: the HTTP fragment composed by each host
  daemon's aggregate OpenAPI document
- `services`: a module-scoped Root, Runtime, lifecycle, StartupJobs, Valtio
  domain services, and host adapter contracts
- `renderer`: the reusable catalog, authorization dialog, and connected-state
  management dialog built only from `@tutti-os/ui-system`
- `i18n`: the connector-market resource bundle and scoped runtime factory

The package does not construct an HTTP client, read Electron globals, choose a
catalog endpoint, persist credentials, select install directories, or own a
host database. Those responsibilities remain in the consuming daemon and
renderer adapters.

## Renderer usage

```ts
import {
  ConnectorMarketModule,
  IConnectorMarketModule
} from "@tutti-os/connector-market/services";

const connectorMarketModule = new ConnectorMarketModule({
  market: {
    backend: hostConnectorMarketBackend,
    canRequest: () => hostAccountState.authenticated,
    events: hostConnectorMarketEvents
  },
  scope: { workspaceId }
});

serviceRegistry.registerInstance(
  IConnectorMarketModule,
  connectorMarketModule,
  "owned"
);

const workspaceServices = new InstantiationService(
  serviceRegistry.makeCollection()
);
await connectorMarketModule.activate(workspaceServices);
```

The backend adapter wraps the host's generated daemon client and maps transport
DTOs into package domain types. Daemon events are invalidation hints; the
service re-reads the authoritative daemon snapshot before publishing new state.
Hosts whose market requires authentication must provide `canRequest`. A false
result keeps startup, reconnect, resume, and command paths transport-silent
while still allowing the module lifecycle to reach `ready`; after the host
observes an authenticated transition it calls `root.market.reload()`.
Starting an event subscription and every observed `connected` state trigger an
authoritative reconciliation, including the first connection. Snapshot reads
are coalesced per workspace generation and a connection/event arriving during
an in-flight read schedules a serialized follow-up. Mutation responses are
revision-fenced so an older response cannot overwrite a newer daemon snapshot;
host generated-client adapters must preserve connector-market error code,
retryability, and structured details when rejecting a command.
Catalog placement is server-owned mutable metadata. The renderer first reads
the daemon's category list, then reads each section with an opaque cursor and
keeps independent Valtio loading and next-page state per section. `featured`
is an overlapping collection; primary category membership is never inferred
from the immutable connector release manifest. A browsed page is cached by the
daemon so a newly observed connector is immediately installable, while the
scheduled authoritative refresh still traverses every primary category for
runtime reconciliation.
Activation creates a child service container and executes the complete startup
flow before the host renders the module:

```text
created -> starting -> synchronizing -> materializing -> ready
             |              |                 |
             |              |                 +-- ViewServiceStartupJob
             |              +-- MarketServiceStartupJob initial-load barrier
             +-- MarketServiceStartupJob + UiStateServiceStartupJob
```

`ConnectorMarketRoot` is the only surface passed to React. The renderer reads
the render-ready View store at leaf components and sends intent to UiState or
Market services. React never constructs services, starts transports, loads
data, or owns disposal. Disposing the module disposes the child container and
all services in dependency-safe order.

## OpenAPI composition

Inside this repository, the aggregate document may use a repository path:

```yaml
x-tutti-openapi-fragments:
  - packages/connector/market/openapi/connector-market.v1.yaml
```

External hosts install an exact released package version and resolve the
exported fragment through package exports:

```yaml
x-tutti-openapi-fragments:
  - package: "@tutti-os/connector-market"
    path: "openapi/connector-market.v1.yaml"
```

Do not copy the fragment into another repository or reference a Tutti worktree.

## Go host boundary

The Go module path is:

```text
github.com/tutti-os/tutti/packages/connector/market
```

Host daemons implement repository, catalog transport, runtime activation,
authorization, scheduling, and event ports. The public package owns shared
state semantics and secure artifact preparation; host adapters own storage and
product integration.

`Repository.Transaction` must be atomic and advance the daemon-wide market
revision monotonically. `ArtifactPreparer`, `ImplementationHost`,
`AuthorizationProvider`, and `OperationScheduler` receive immutable operation
and release identity and must tolerate replay because daemon recovery can
re-execute accepted or running work after a crash.

`Application.ExecuteOperation` also provides process-local single-flight
semantics: concurrent dispatches for the same operation ID share one execution
and its final result, while different operation IDs remain independently
schedulable. This in-memory ownership is intentionally limited to one
`Application` instance; after a process restart, durable accepted/running
operations are replayed through `Recover`, so adapters must still tolerate
uncertain external side effects from a crash.

`artifact.Preparer` provides bounded download, digest verification, safe
extraction, packaged-manifest verification, and atomic content-addressed
promotion. Hosts retain remote endpoint/authentication configuration, runtime
activation, persistence, credentials, and state-root selection.
