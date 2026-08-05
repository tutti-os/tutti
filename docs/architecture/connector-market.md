# Connector Market

The connector market is a shared desktop-daemon domain owned by
`packages/connector/market`. Tutti is the source repository and first host;
other hosts consume exact released Go and npm package versions.

## Authority Boundaries

Connector market uses two independent APIs:

- the remote Connector Market API publishes connector releases, manifests,
  and immutable artifact metadata
- the local daemon API exposes the accepted catalog, installation,
  authorization, compatibility, workspace binding, and durable operation state
  owned by one desktop host

The remote market service owns its versioned API schema and generated client.
The shared connector package may provide a default `CatalogSource` adapter over
that generated client, but must not copy or redefine the remote schema. Remote
transport DTOs and local daemon DTOs remain separate.

The renderer never calls the remote market. The local daemon is authoritative
for every state rendered by the desktop application.

## Ownership

The public package owns:

- connector, catalog, installation, authorization, compatibility, workspace
  binding, durable operation, revision, and error contracts
- Go state transitions, manifest validation, host ports, application
  orchestration, and recovery rules
- a default remote-catalog domain adapter built over the authoritative market
  client
- reusable artifact acquisition and preparation: bounded download, size and
  digest verification, safe extraction, release-to-package verification,
  staging layout, atomic promotion mechanics, cleanup, and reconcile rules
- the reusable local daemon OpenAPI fragment under
  `openapi/connector-market.v1.yaml`
- the renderer `ConnectorMarketBackend` contract, module Root/Runtime,
  lifecycle and StartupJobs, Valtio-backed domain services, reusable renderer,
  and connector-market i18n bundle

Each host daemon owns:

- local persistence, transactions, operation leases, and migrations
- remote market base URL, authentication, HTTP transport, proxy, TLS, logging,
  and tracing configuration
- the state root supplied to the package artifact preparer
- runtime activation and observation, including process registration, sandbox
  policy, permissions, OS integration, and credential binding
- secure credential storage and authorization callbacks
- a durable outbox and integration with the host event stream
- local transport DTO mapping, product compatibility inputs, and diagnostics

The package keeps ports for host-specific implementations even when it offers a
default adapter. A host can replace a default without forking the shared
application semantics.

## Artifact And Runtime Boundary

Artifact preparation and runtime activation are different responsibilities:

```text
durable operation
    -> package artifact resolver/downloader
    -> bounded staging download
    -> size and digest verification
    -> safe extraction and packaged-manifest verification
    -> prepared artifact
    -> daemon implementation host
    -> generation-fenced MCP/CLI routes and observed process state
    -> repository result commit
```

Archive handling must reject absolute paths, parent traversal, and symlink or
hardlink escapes. It must enforce limits for file count, individual file size,
expanded bytes, and compression ratio. Artifact code is not executed before
verification and preparation complete.

The staging and active directories must be on the same filesystem when atomic
rename is used. Activation failure preserves the previous active version. The
daemon resolves the artifact key against its configured artifact base URL. The
production base URL is the public-assets CloudFront prefix
`https://d27a59zdy4534h.cloudfront.net/tutti/connector-market/`; CloudFront
serves immutable versioned objects from the private `tsh-public-assets` S3
origin. The daemon never addresses S3 directly. Downloading is an ordinary
direct GET without workspace identity. Operations persist the artifact key,
release identity, digest, and size; the preparer verifies the downloaded bytes
before installation. Staging and local integration may override the CDN prefix
with `TUTTI_CONNECTOR_ARTIFACT_BASE_URL`; production should leave the public
CloudFront default in place.

The package owns the implementation-host port and durable reconcile semantics;
the daemon owns the concrete process runtime. In Tutti, `managed_stdio`
connectors resolve an exact Node/Python runtime profile. MCP servers are
long-lived daemon children, while CLI commands are one-shot children. Both use
the same generation fence, process registry, artifact snapshot, sandbox, and
workspace deactivation path. TSH may reuse the public contracts while providing a
different concrete daemon adapter.

## Durable Operations And Recovery

Remote refresh, install, update, uninstall, and recoverable authorization work
use at-least-once execution. Exactly-once execution is not assumed across
SQLite, the filesystem, runtime activation, and process restarts.

An installation request carries an immutable operation identity and release
identity. Each stage is idempotent for at least:

```text
operationId + connectorKey + version + releaseDigest
```

The durable flow is:

```text
accepted -> downloading -> prepared -> activating -> completed
     |            |            |             |
     +------------+------------+-------------+-> failed
```

The repository owns operation leases and attempt metadata. Recovery observes
staging markers, active-version markers, and host runtime state before deciding
which stage to resume. Install and uninstall return verifiable results to the
application; artifact helpers do not write the business repository or publish
events directly.

Authorization operations must follow the same recovery rule or remain fully
synchronous without leaving a recoverable `running` operation. A provider uses
the operation or client request identity to resume without creating duplicate
external authorization sessions.

## Event Consistency

Business state and its invalidation event are written to a durable outbox in
the same SQLite transaction. The host publisher delivers outbox entries through
its existing event stream and records delivery progress.

Events carry a monotonic revision or sequence and remain invalidation hints.
Reconnect supports replay from a known sequence; a retention gap tells the
renderer to reload a full daemon snapshot. The daemon snapshot, not the event,
is always authoritative.

Until durable replay exists, a transitional host may publish best-effort events
only if the renderer also refreshes on daemon reconnect, window resume, and
command completion. Revision fencing remains required.

## Renderer Boundary

Each renderer host owns the generated local daemon client and the adapter that
maps wire DTOs into `@tutti-os/connector-market` domain types. The public
renderer package never constructs a daemon client and never reads preload or
window globals.

The renderer domain follows the same Root + Runtime + StartupJob boundary as
TSH Room Chat:

- `ConnectorMarketModule.activate()` creates a child DI container and is called
  by the workspace module startup flow before the settings UI can render
- `ConnectorMarketRuntime` owns the lifecycle sequence `created -> starting ->
synchronizing -> materializing -> ready`; failure is terminal and disposes
  the child container
- Market, UiState, and View each have one StartupJob; the Market job places an
  initial-load barrier in `synchronizing`, and View materialization starts only
  after that barrier resolves
- `ConnectorMarketRoot` exposes the three stable services to renderer context;
  React never resolves or constructs individual services
- every service exposes a `readonly dataStore = proxy(...)` as its only writable
  state source, and only its owning service mutates it
- asynchronous responses are fenced by request sequence, workspace generation,
  and daemon revision; `dispose()` is idempotent and terminal
- event refreshes are coalesced, daemon reconnect performs a full reload, and
  accepted commands are followed through the operation endpoint or events
- hosts gate connector-market transport through `canRequest`; Tutti binds it to
  account authentication, activates the module without network access while
  signed out, reloads after login, and keeps reconnect/resume paths silent
  after logout
- the shared renderer subscribes at leaf components through a stable context,
  uses `@tutti-os/ui-system`, and owns no transport, startup, disposal, or
  business-state reconciliation

Connector details are represented by one modal state machine, never by a fixed
right-hand pane. An unconnected installed connector opens the authorization
dialog; an authorized connector opens the management dialog. Blocked releases
open the blocked-state dialog. Only one dialog host is mounted at a time, so
the catalog keeps the full settings content width and never leaves an empty
right column.

## Local OpenAPI Reuse

Host aggregate documents compose the same local daemon fragment instead of
copying paths or schemas. Tutti may reference the repository path. External
hosts resolve the fragment exported by an exact installed
`@tutti-os/connector-market` version. The OpenAPI generator rejects malformed
references and merge conflicts.

The aggregate document continues to own server URLs, security, and
product-only routes. The fragment owns common connector-market paths, DTOs,
enums, revisions, operations, and error codes.

## State Boundaries

Installation, authorization, and compatibility are independent state machines.
A connector can therefore be installed but disconnected, or visible but blocked
by an unsupported implementation, without overloading one ambiguous status field.

Credentials and sensitive implementation configuration are never part of the
renderer projection. Unknown or incomplete implementation kinds remain visible
but cannot be installed.

## Current Checkpoint

The shared package now contains immutable operation targets and execution
receipts, recoverable install/uninstall/authorization flows, secure
content-addressed artifact preparation, host ports, the local daemon OpenAPI
fragment, and the complete reusable renderer module: Root, Runtime, lifecycle,
per-service StartupJobs, UiState, render-ready View, i18n, catalog, and modal
state branches.

Tutti now composes that fragment, persists catalog/operations/leases/bindings
and a transactional outbox in SQLite, reads the typed remote catalog, exposes
generated local handlers and clients, publishes invalidation events, and
registers the shared renderer module through injected daemon-client and event
adapters, activates it as part of workspace startup, and renders its shared
panel from Settings > Agent > Connectors. Event-stream reconnect causes an
authoritative snapshot reload.

The registered Tutti Host reads the ordinary TSH market item API, downloads an
artifact directly from the configured artifact base URL, verifies its declared
SHA-256 and size, prepares a content-addressed snapshot, selects the local
Node/Python runtime, and exposes daemon-owned MCP and CLI capabilities per
workspace. Crash recovery adopts every host-touching operation into the current
boot epoch. Startup requires one successful catalog refresh before restoring
routes; later refresh failures preserve installed last-known-good capabilities
while the daemon retries.

The first production compatibility boundary is deliberately narrow:
`managed_stdio`, authorization kind `none`, and platforms with the production
connector sandbox are installable. Connectors requiring credentials remain
visible but unsupported until a credential broker is implemented. Durable
event replay is still follow-up hardening; renderer reconnect, resume, command
completion, and revision-fenced invalidations therefore trigger authoritative
snapshot reloads.
