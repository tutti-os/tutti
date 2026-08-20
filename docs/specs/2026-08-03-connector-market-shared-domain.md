# Connector Market Shared Domain

Status: shared core, ordinary market delivery, Tutti daemon implementation
host, and renderer service implemented; exact package-cohort release and
downstream TSH pin remain rollout gates.

## Goal

Make Tutti the source repository for one connector-market capability that runs
inside both `tuttid` and the TSH desktop daemon. Both hosts share domain,
artifact, operation, recovery, local HTTP, and renderer semantics while keeping
independent durable state and runtime-specific adapters.

## Non-Goals

- Renderers do not call the remote Connector Market API.
- Shared modules do not own product endpoints, credentials, state-root
  selection, OS integration, or runtime process policy. The canonical SQLite
  schema belongs to `packages/connector/store-sqlite`; hosts select its path.
- Tutti does not infer missing release metadata from untyped raw JSON.
- This phase does not add placeholder daemon handlers or UI backed by fixture
  success responses.

## Two API Contracts

### Remote Connector Market API

The Connector Market service owns the authoritative, versioned schema and its
generated protobuf/HTTP artifacts. Tutti pins those artifacts by provider
commit and SHA-256 in `packages/clients/market-go`, which exposes the reusable
Go client without importing the service application module. It exposes
published market items with immutable artifact keys, digests, and sizes.

Market-neutral connector `schemaVersion: "2"` declares one implementation.
Connector `schemaVersion: "3"` keeps the same release identity and listing
model while declaring an implementation matrix keyed by execution target.
Hosts retain v1/v2 read compatibility and normalize the selected v3 target into
the existing single-implementation runtime contract.

A release descriptor must bind at least:

- connector key and version
- immutable release identity and manifest digest
- artifact key, digest, size, and media type
- typed implementation kind and configuration schema version
- permissions and authorization kind
- product, platform, and minimum-host-version constraints
- publication metadata

Publishing is protected by the market service's existing request token.
Reading and downloading do not introduce a second workspace permission model.
The daemon resolves the returned artifact key against its configured artifact
base URL. Production uses the immutable Connector prefix on the public-assets
CloudFront distribution; the private `tsh-public-assets` bucket is only the CDN
origin and is never addressed by the daemon. The daemon verifies downloaded
bytes against the declared digest and size before installation.

The shared package may provide a default `CatalogSource` and artifact resolver
over the generated market client. It must not copy the remote schema into the
local daemon OpenAPI fragment.

### Local Daemon API

`packages/connector/market/openapi/connector-market.v1.yaml` is the shared
local daemon fragment. It exposes accepted catalog state, local installation,
authorization, compatibility, revisions, and durable operations to renderers.
An installed connector is daemon-global and available to every Agent and the
local Tutti CLI.

Each host composes this fragment into its aggregate OpenAPI document, generates
its own server and client, and provides transport mapping. The local daemon is
the authoritative source for renderer state.

Market placement is not part of the immutable release manifest. ZK owns each
listing's primary category, ranks, and optional featured placement; TSH exposes
the selected deployment market through category and cursor-paginated item
endpoints. Tutti forwards that model through daemon-owned category/page APIs.
The shared Valtio service maintains independent page state for every section,
and the renderer does not infer category membership from connector keys or
manifest JSON. `featured` is an overlapping collection, while authoritative
runtime refreshes enumerate every primary `category` section and deduplicate by
connector key.

## Package And Host Ownership

The shared Connector modules own:

- domain contracts, validation, state transitions, errors, and compatibility
  semantics
- application orchestration, command idempotency, operation exclusion, and
  recovery rules
- the default remote catalog domain adapter
- bounded artifact download, digest and size verification, safe extraction,
  packaged-manifest verification, staging layout, atomic promotion mechanics,
  cleanup, rollback, and reconcile rules
- the canonical SQLite repository, leases, migrations, transactions, and
  durable outbox implementation behind Host ports
- ports for implementation hosting, credentials, scheduling, transport, and
  diagnostics
- the local daemon OpenAPI fragment and Valtio renderer service

Each Host owns:

- the database path and lifecycle of the shared SQLite repository
- remote base URL, authentication, HTTP client, proxy, TLS, logging, and tracing
- state-root configuration
- implementation hosting and observation, including permission, process,
  OS, and credential integration
- secure credentials and authorization callbacks
- durable outbox storage and integration with the existing event fanout
- generated local daemon handlers and renderer backend/event adapters

Default package implementations remain behind ports so special hosts can
replace environment behavior without replacing shared semantics.

## Artifact Preparation And Activation

`ArtifactPreparer` and the daemon `ImplementationHost` use immutable requests
and verifiable receipts. Their durable identity carries at least:

```text
operationId
connectorKey
version
releaseIdentity
releaseDigest
artifact key/digest/size/mediaType
validated manifest
```

The execution boundary is:

```text
operation executor
    -> package ArtifactPreparer
    -> prepared artifact and receipt
    -> daemon ImplementationHost
    -> generation-fenced MCP/CLI routes and observed process result
    -> repository completion transaction and outbox
```

Package archive handling rejects absolute paths, parent traversal, symlink and
hardlink escape, and archives that exceed file-count, individual-size,
expanded-size, or compression-ratio limits. It validates redirects, content
type, timeout, declared size, digest, and the packaged manifest before any
artifact code can execute. Artifact download is an ordinary direct GET and does
not carry workspace identity.

Staging and active directories use the same filesystem when relying on atomic
rename. Updates preserve the previous active version until new activation is
observed. Install, update, uninstall, cleanup, and rollback are idempotent for
the operation and immutable release identity.

## Operation And Recovery Model

Execution is at least once because SQLite, filesystem mutation, runtime
activation, and process restart cannot form one atomic transaction.

The durable installation stages are:

```text
accepted -> downloading -> prepared -> activating -> completed
     |            |            |             |
     +------------+------------+-------------+-> failed
```

The Repository stores lease owner, lease expiry, attempt, stage, immutable
release identity, and error details. Recovery inspects durable operation state,
staging and activation markers, and the Host runtime's observed state before
resuming a stage. A running operation is never blindly replayed from the
beginning.

`clientRequestId` has a database uniqueness constraint with a documented
scope. Artifact and activation work is idempotent for:

```text
operationId + connectorKey + version + releaseDigest
```

The operation executor, not the artifact preparer, owns repository state
transitions and event creation.

## Authorization Recovery

Authorization start is a recoverable operation. The provider uses the
operation or client request identity to return or resume one external
authorization session, and the callback completes authorization in a separate
fenced transaction.

A temporary synchronous implementation is allowed only if it cannot leave a
recoverable `running` operation after the request ends.

## Event Consistency

Connector state changes and invalidation events are inserted into a durable
outbox in the same SQLite transaction. The Host publisher forwards outbox
entries through its existing event stream and records progress.

Events carry monotonic revision or sequence. Reconnect supports replay from a
known sequence; a retention gap forces a full snapshot reload. Events never
replace the authoritative local snapshot.

Before durable replay is available, a transitional Host may use best-effort
events only with full reload on daemon reconnect, window resume, and command
completion. Renderer request-sequence, service-generation, and revision fencing
stay enabled.

## Pre-Release Breaking Transition

The current connector-market changes are not released, so the connector
publish, storage, and public read contracts are updated together instead of
maintaining a legacy connector payload. The outer market service may continue
to support other item types, but connector payload validation and projection
move directly to the initial typed release contract.

The coordinated transition is:

- change the connector publish manifest and validation in the market service
- regenerate the market service and consumer clients in the same delivery
  sequence
- update the shared package mapper and manifest contract to the same
  remote `schemaVersion: "2"`
- update or republish development connector fixtures; disposable local records
  may be reset
- reject any remaining untyped connector record instead of dual-reading it

No connector v1 read path, legacy catalog adapter, synthesized field, or
production fallback is introduced. A failed or invalid remote refresh still
preserves the last-known-good accepted daemon catalog; network failure never
becomes an empty catalog.

## Renderer Integration

Each Host renderer injects backend and event adapters over its generated local
daemon client. `ConnectorMarketModule` creates a child DI container and runs
Market, UiState, and View StartupJobs through the shared lifecycle. The Market
job blocks `synchronizing` on the initial authoritative snapshot; View starts
in `materializing`; only `ready` exposes the Root to React.

The shared services own global Valtio state, command flow, revision fencing,
coalesced invalidation reloads, and the render-ready projection. A Host window
may activate the module from its workspace startup
flow for lifecycle purposes, but the connector scope and daemon runtime remain
global. React receives only the Root through stable context and does not create
clients, connect WebSockets, start loads, dispose services, or merge daemon
business state.

The shared renderer provides the settings catalog and one modal state machine:
unconnected connectors render authorization content, connected connectors
render management content, and blocked connectors render a blocked-state
dialog. There is no persistent details column.

Daemon reconnect performs a full reload. An accepted command is followed
through events or the operation endpoint until terminal state.

## Revised Delivery Sequence

1. Harden the shared operation, artifact, authorization, and event contracts;
   add conformance scenarios for crash windows and idempotent replay.
2. Replace the current unreleased connector publish/read shape with the
   authoritative `schemaVersion: "2"` release schema and regenerate its
   clients.
3. Add the package default catalog adapter, artifact preparation engine, and
   reconcile rules.
4. Implement `tuttid` SQLite persistence, leases, implementation hosting,
   credentials, durable outbox, scheduler, and startup recovery.
5. Compose the local fragment, implement handlers, and regenerate Go and
   TypeScript clients.
6. Register and activate the shared renderer module with Tutti's
   generated-client and event adapters.
7. Add the shared connector-market UI to Tutti Settings > Agent > Connectors.
8. Publish one exact package release cohort.
9. Install the exact Go and npm versions in TSH and implement only its Host
   adapters.
10. Remove disposable pre-release fixtures and temporary transition paths after
    all repositories consume the initial contract.

## Host Integration Gate

Do not add the local fragment to a production daemon aggregate until all of the
following exist:

- an authoritative catalog source using the initial typed release contract
- real persistence and atomic revision transactions
- operation identity, lease, recovery, and terminal-state handling
- safe artifact preparation and a real implementation host for every installable
  implementation
- authorization recovery for every advertised authorization kind
- event delivery with either durable replay or the documented transitional
  refreshes
- handler, persistence, recovery, and renderer-adapter tests

## Current Implementation Checkpoint

The shared package includes:

- public package and release registration
- domain types, state transitions, manifest validation, ports, and an
  application core with revision fencing, request idempotency, immutable
  targets, execution receipts, per-connector exclusion, operation execution,
  authorization recovery, leases, and restart recovery
- secure artifact download/preparation with archive safety limits, packaged
  manifest verification, content addressing, and atomic promotion
- the shared local daemon OpenAPI fragment
- package-resolved fragment support for cross-repository hosts
- the Root/Runtime/lifecycle/StartupJob renderer module with Market, UiState,
  and View Valtio services, stale-response fencing, refresh singleflight,
  mutation locks, invalidation reload, and reconnect
  reconciliation
- the reusable `@tutti-os/ui-system` catalog, toolbar, authorization,
  management, and blocked-state dialogs plus scoped i18n resources

The Tutti Host includes:

- a typed remote catalog adapter for the TSH Connector Market endpoint
- SQLite persistence for metadata, accepted releases, operations, leases, and the
  transactional changed-event outbox
- operation scheduling and startup recovery
- aggregate OpenAPI composition, generated Go handlers and TypeScript client
- a generated-client/event-stream Renderer adapter activated with the Host
  window lifecycle while exposing one global connector domain
- the shared connector-market panel mounted in Settings > Agent > Connectors

Tutti now advertises the production `managed_stdio` implementation when its
platform/runtime constraints match. It reads the TSH market item API, downloads
the artifact directly from configured storage, verifies and prepares an
immutable artifact snapshot, and hosts MCP as a daemon-owned long-lived child
or CLI as a bounded one-shot Node/Python child. Routes and every child process
are global, identified by connector plus connection ID, and fenced by boot
epoch. Every Agent and the local Tutti CLI can discover and invoke installed
routes through the daemon CLI channel. Startup waits for a catalog refresh,
while later market outages preserve the installed last-known-good runtime
projection.

Authorization remains intentionally limited to `none`; connectors that require
credentials remain visible as unsupported until the daemon credential broker
lands. Durable event replay remains outside this checkpoint. The renderer
module and Tutti adapter are wired and use authoritative reloads on reconnect,
resume, and command completion; the UI presents daemon-authoritative
unsupported and blocked states instead of synthesizing installability.
