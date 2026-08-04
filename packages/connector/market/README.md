# @tutti-os/connector-market

`@tutti-os/connector-market` is the host-neutral connector-market boundary
shared by Tutti and other approved desktop daemon hosts such as TSH.

The package deliberately owns three matching contracts:

- `daemon`: Go domain types, state transitions, manifest validation, ports, and
  the application service boundary
- `openapi/connector-market.v1.yaml`: the HTTP fragment composed by each host
  daemon's aggregate OpenAPI document
- `services`: a Valtio-backed renderer domain service driven by an injected
  `ConnectorMarketBackend`

The package does not construct an HTTP client, read Electron globals, choose a
catalog endpoint, persist credentials, select install directories, or own a
host database. Those responsibilities remain in the consuming daemon and
renderer adapters.

## Renderer usage

```ts
import { ConnectorMarketService } from "@tutti-os/connector-market/services";

const connectorMarket = new ConnectorMarketService({
  backend: hostConnectorMarketBackend,
  events: hostConnectorMarketEvents,
  workspaceId
});

connectorMarket.start();
await connectorMarket.ensureLoaded();
```

The backend adapter wraps the host's generated daemon client and maps transport
DTOs into package domain types. Daemon events are invalidation hints; the
service re-reads the authoritative daemon snapshot before publishing new state.
The service follows the shared renderer-domain convention: it is a constructor-
injected class, exposes its only writable state source as `readonly dataStore`,
owns asynchronous commands directly, and has explicit idempotent `start()` and
`dispose()` lifecycle methods. React consumers subscribe to `dataStore`; they do
not start transports or data loads.

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

Host daemons implement repository, catalog, artifact installation,
authorization, scheduling, and event ports. The public package owns shared
state semantics; host adapters own storage and product integration.

`Repository.Transaction` must be atomic and advance the daemon-wide market
revision monotonically. `ArtifactInstaller`, `AuthorizationProvider`, and
`OperationScheduler` must be idempotent for the operation or client request id
they receive because daemon recovery can replay accepted or running work after
a crash.

`Application.ExecuteOperation` also provides process-local single-flight
semantics: concurrent dispatches for the same operation ID share one execution
and its final result, while different operation IDs remain independently
schedulable. This in-memory ownership is intentionally limited to one
`Application` instance; after a process restart, durable accepted/running
operations are replayed through `Recover`, so adapters must still tolerate
uncertain external side effects from a crash.
