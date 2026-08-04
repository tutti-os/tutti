# Connector Market

The connector market is a shared desktop-daemon domain owned by
`packages/connector/market`. Tutti is the source repository and first host;
other hosts consume exact released Go and npm package versions.

## Ownership

The public package owns:

- connector, catalog, installation, authorization, compatibility, workspace
  binding, durable operation, revision, and error contracts
- Go state transitions, manifest validation, host ports, and the application
  service boundary
- the reusable OpenAPI fragment under
  `openapi/connector-market.v1.yaml`
- the renderer `ConnectorMarketBackend` contract and Valtio-backed domain
  service

Each host daemon owns:

- local persistence and transactions
- accepted catalog snapshots and upstream authentication
- artifact download, verification, installation, activation, and recovery
- secure credential storage and authorization callbacks
- transport DTO mapping, event publication, product compatibility policy,
  logging, and diagnostics

Each renderer host owns the generated daemon client and the adapter that maps
wire DTOs into `@tutti-os/connector-market` domain types. The public renderer
package never constructs a daemon client and never reads preload or window
globals.

The renderer domain follows the same service boundary as TSH Room Chat:

- `IConnectorMarketService` is the typed DI contract and
  `ConnectorMarketService` is the constructor-injected class implementation
- `readonly dataStore = proxy(...)` is the only writable renderer state source;
  only the owning service mutates it
- `start()` owns long-lived event subscription setup, while host startup jobs
  decide when to call it and when to perform the initial load
- asynchronous responses are fenced by request sequence, workspace generation,
  and daemon revision; `dispose()` is idempotent and terminal
- React subscribes at the rendering leaf and does not own transport, startup, or
  disposal

## Data flow

```text
upstream catalog
    -> host daemon CatalogSource
    -> accepted daemon snapshot and durable operations
    -> host aggregate OpenAPI
    -> generated host client
    -> host ConnectorMarketBackend adapter
    -> shared Valtio service
    -> host UI
```

The local daemon is authoritative. Business events carry connector key,
operation id, and revision only as invalidation hints. Renderers re-read the
daemon before applying newer state.

## OpenAPI reuse

Host aggregate documents compose the same fragment instead of copying paths or
schemas. Tutti may reference the repository path. External hosts resolve the
fragment exported by an exact installed `@tutti-os/connector-market` version.
The OpenAPI generator rejects malformed references and merge conflicts.

The aggregate document continues to own server URLs, security, and
product-only routes. The fragment owns common connector-market paths, DTOs,
enums, revisions, operations, and error codes.

## State boundaries

Installation, authorization, compatibility, and catalog freshness are
independent state machines. A connector can therefore be installed but
disconnected, supported but stale, or visible but blocked by an unsupported
implementation without overloading one ambiguous status field.

Credentials and sensitive implementation configuration are never part of the
renderer projection. Unknown implementation kinds remain visible as
`unsupported_implementation` but cannot be installed.
