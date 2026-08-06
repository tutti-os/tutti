# Connector Market

The connector market is a shared desktop-daemon domain owned by the matched
modules under `packages/connector`. Tutti is the source repository and first
host; other hosts consume exact released Go and npm package versions from the
same package cohort.

## Authority Boundaries

Connector market uses two independent APIs:

- the remote Connector Market API publishes connector releases, manifests,
  and immutable artifact metadata
- the local daemon API exposes the accepted catalog, installation,
  authorization, compatibility, and durable operation state
  owned by one desktop host

The remote market service owns its versioned API schema and generated client.
It exposes the reusable `/v1/market/categories`, `/v1/market/items`, and
`/v1/market/items/{item_type}/{item_key}` read boundary for both connectors and
Skills. Connector catalog requests always use `itemType=connector`; Skill
consumers use `itemType=skill`. The shared connector package may provide a
default `CatalogSource` adapter over that generated client, but must not copy or
redefine the remote schema. Remote transport DTOs and local daemon DTOs remain
separate.

Published connectors use the remote market manifest v2 envelope: one
market-neutral `payload.implementation` and no `supportedMarkets` field. The
daemon rejects the legacy connector v1 envelope instead of adapting
`payload.implementations[market]`. At the boundary it projects the accepted v2
publication into the local daemon's stable connector-manifest v1 DTO; these
schema versions belong to different APIs and do not imply compatibility.

The renderer never calls the remote market. The local daemon is authoritative
for every state rendered by the desktop application.

## Ownership

The shared Connector modules own:

- connector, catalog, installation, authorization, compatibility, durable
  operation, revision, and error contracts
- `connector/host`: Go state transitions, manifest validation, host ports,
  application orchestration, and recovery rules
- `connector/daemon`: bootstrap fencing, scheduling, workers, and outbox
  delivery
- `connector/store-sqlite`: the canonical repository, transactions, leases,
  migrations, and durable outbox implementation
- `connector/runtime`: secure artifact preparation, managed runtime identity,
  ABI verification, and typed Node package installation
- a default remote-catalog domain adapter built over the authoritative market
  client
- reusable artifact preparation: bounded download, size and
  digest verification, safe extraction, release-to-package verification,
  staging layout, atomic promotion mechanics, cleanup, and reconcile rules
- `connector/market`: the reusable local daemon OpenAPI fragment under
  `openapi/connector-market.v1.yaml`
- the renderer `ConnectorMarketBackend` contract, module Root/Runtime,
  lifecycle and StartupJobs, Valtio-backed domain services, reusable renderer,
  and connector-market i18n bundle

Each host daemon owns:

- database path selection and opening/closing the shared SQLite store
- remote market base URL, authentication, HTTP transport, proxy, TLS, logging,
  and tracing configuration
- the state root supplied to the shared runtime
- process transport, artifact and executable enforcement, OS integration, product command
  publication, invocation admission, and credential binding injected into the
  shared runtime boundary
- secure credential storage and authorization callbacks
- a durable outbox and integration with the host event stream
- local transport DTO mapping, product compatibility inputs, and diagnostics

The modules keep ports for host-specific implementations even when they offer
a default adapter. A host can replace a default without forking shared
application or renderer semantics.

## Artifact And Runtime Boundary

Artifact preparation and runtime activation are different responsibilities:

```text
durable operation
    -> connector/runtime artifact resolver/downloader
    -> bounded staging download
    -> size and digest verification
    -> safe extraction and packaged-manifest verification
    -> prepared artifact
    -> connector/runtime implementation adapter
    -> generation-fenced MCP/CLI routes and observed process state
    -> repository result commit
```

For a CLI declared with a typed `node_package` installation, the prepared
artifact contains connector metadata and skills, not the CLI npm package. The
daemon inserts one additional, replay-safe stage between artifact preparation
and route reconciliation:

The local daemon connector-manifest v1 contract includes required icons, typed
package installation, explicit Node ranges, and mapping-free generic CLI. It is
an internal host projection of the remote market v2 publication rather than a
copy of the server envelope.

```text
typed node_package intent
    -> resolve connector-node-static
    -> verify the managed Node executable, ABI, and version range
    -> run fixed pnpm through that Node (never a user shell/npm)
    -> shared content-addressed store + release-scoped link tree
    -> verify package name, exact version, sha512 integrity, lock, and bin entry
    -> atomically publish the installation receipt
```

A device has one active connector Node runtime. Connector manifests may state
an explicit Node version range, but cannot download Node or select a second
runtime. An incompatible range rejects installation; it never falls back to
the user's system Node, nvm, npm global prefix, or `PATH`.

Node package storage separates physical reuse from execution isolation:

```text
<state-dir>/connectors/node-packages/
  shared/
    pnpm-store/   # shared content-addressed package data
    corepack/     # shared fixed-package-manager cache
    npm-cache/    # shared registry/download cache
    pnpm-home/
  packages/<connector-key>/<release-digest>/
    package.json
    pnpm-lock.yaml
    node_modules/ # hardlinks and release-local links into shared content
    .tutti-cli-installation.json
```

The package manager is daemon-selected and version-pinned. Manifests declare a
typed package name, exact version, integrity, and optional allowlisted Node
lifecycle entrypoints; they do not provide arbitrary shell commands. Package
manager lifecycle scripts are disabled. An allowed lifecycle entrypoint is
launched directly by the same verified Node inside the connector installer
verified process transport. A `node_script` launch continues through that Node; a `native` launch
must declare the expected platform-binary SHA-256, and activation executes only
the file matching that digest. All connections and workspaces reuse one installed connector release.
Removing one connector release must not remove the shared store or caches.

Catalog display metadata includes a required, bounded PNG, WebP, or SVG data
URL. This makes the icon available before installation and removes connector-key
special cases from the renderer. The data URL is generated from the source
connector icon during publishing and is limited to 128 KiB after decoding.

Manifest permissions use a lowercase stable permission name with an optional
scope (`permission`, `permission:scope`, or `permission:*`). The daemon keeps
fail-closed validation for the permission name, scope grammar, duplicates, and
all other manifest fields; a scoped permission is not treated as a plain
identifier. The host may currently collapse a scoped permission to a broader
runtime capability, so accepting the syntax does not imply scope-level runtime
enforcement.

CLI manifests do not require action mappings. When `commands` is absent, the
host publishes one generic, verified `connector.<key>.cli.run` capability and
the installed Skill supplies the CLI arguments and workflow. The host rejects
NUL-bearing arguments and non-interactive `--yes`/`--force` overrides.
Capability IDs are opaque canonical identifiers: invocation matches the full ID
exactly and never derives a short name by splitting the ID. The selected
connector remains a separate routing and policy boundary, and invocation fails
when the canonical ID belongs to a different connector.

The initial Lark profile is representative: it pins `@larksuite/cli@1.0.83`
and its npm sha512 integrity, requires the shared Node 22 profile, runs only the
package's declared `scripts/install.js` lifecycle with `curl` and `tar`
explicitly admitted, and then launches the resulting verified `bin/lark-cli`
native binary. The connector artifact contains metadata, icon, and Skills, not
the npm package or a second Node runtime.

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

`connector/host` owns the implementation-host port and durable reconcile
semantics; `connector/runtime` owns portable artifact and managed-runtime
installation primitives, while each daemon supplies the concrete
implementation host, process, and product-command adapters. In Tutti, `managed_stdio`
connectors resolve an exact Node/Python runtime profile. MCP servers are
long-lived daemon children, while CLI commands are one-shot children. Both use
the same generation fence, process registry, artifact snapshot, executable identity, and
connection-scoped state path. An installed runtime is daemon-global and is
available to every Agent and the local Tutti CLI. TSH runs the same runtime
module inside its managed VM and supplies a guest process adapter.

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

`accepted` and `running` rows have no age-based expiry. The SQLite repository
protects them with one-active-operation constraints plus renewable,
token-fenced leases, and daemon startup reschedules every recoverable row. The
cleanup path is therefore intentionally unable to select an active operation.

Terminal operation results are retained for 24 hours after `updatedAt`, with
the cutoff inclusive. This is the supported `GET operation` result window and
the `clientRequestId` idempotency window: repeating the same command identity
inside the window returns the original operation; after the row expires the
identity is treated as a new command and normal revision validation applies.
The renderer polls non-terminal operations with a 250 ms to 2 second backoff. A
permanent missing result, or a reconnect after the result window, converges
from the authoritative connector/snapshot projection instead of relying on
operation history.

Installed release evidence is a current business fact, not operation history.
The SQLite store records one complete release record per currently installed
connector in `connector_market_installed_releases`; install completion updates
it and uninstall completion removes it in the same transaction as the business
transition. Runtime recovery therefore remains valid after the corresponding
completed install operation has expired, including when the accepted catalog
has advanced to a newer release.

Authorization operations must follow the same recovery rule or remain fully
synchronous without leaving a recoverable `running` operation. A provider uses
the operation or client request identity to resume without creating duplicate
external authorization sessions.

## Event Consistency

Business state and its invalidation event are written to a durable outbox in
the same SQLite transaction. The host publisher delivers outbox entries through
its existing event stream and records delivery progress.

Pending outbox entries never expire. Published entries are delivery receipts,
not the replay or diagnostic authority, and are retained for one hour before
becoming eligible for deletion. Publication failures and cleanup summaries are
written as structured daemon logs; the business database is not an unbounded
diagnostic archive.

Events carry a monotonic revision or sequence and remain invalidation hints.
The current host does not use published outbox rows as a replay store, so the
renderer refreshes on daemon reconnect, window resume, and command completion.
A future durable replay transport may resume from a known sequence and must
signal a retention gap so the renderer can reload a full daemon snapshot. The
daemon snapshot, not the event, is always authoritative, and revision fencing
remains required.

Lifecycle cleanup runs once when the daemon host starts and then hourly. Each
SQLite transaction deletes at most 500 eligible terminal operations and 500
eligible published events, ordered by their indexed terminal/publication time
and stable identity. A run repeats bounded transactions until neither category
fills its batch, so an existing expired backlog drains without enlarging a
transaction. The delete predicates are repeated outside the bounded subqueries
so a row must still be terminal or published when the write occurs.
The active-operation partial unique index, terminal-time cleanup index,
pending-outbox index, and published-outbox cleanup index keep admission,
delivery, and maintenance scans separate. Multiple daemon/store connections
may race cleanup safely through SQLite write serialization and idempotent
predicates.

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
- asynchronous responses are fenced by request sequence, service generation,
  and daemon revision; `dispose()` is idempotent and terminal
- installation intent is projected into the reactive Market store before the
  host request starts, so cards and dialogs become busy immediately even when a
  host keeps the mutation request open until runtime work completes; the local
  projection is cleared on both success and failure and never replaces daemon
  installation truth
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
right-hand pane. An uninstalled connector opens an installation confirmation.
An unconnected installed connector opens the authorization dialog; an
authorized connector opens the management dialog. Blocked releases open the
blocked-state dialog. Only one dialog host is mounted at a time, so
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

Tutti now composes that fragment, persists catalog/operations/leases and a
transactional outbox in SQLite, reads the typed remote catalog, exposes
generated local handlers and clients, publishes invalidation events, and
registers the shared renderer module through injected daemon-client and event
adapters, activates it as part of workspace startup, and renders its shared
panel from Settings > Agent > Connectors. Event-stream reconnect causes an
authoritative snapshot reload.

The registered Tutti Host reads the ordinary TSH market item API, downloads an
artifact directly from the configured artifact base URL, verifies its declared
SHA-256 and size, prepares a content-addressed snapshot, selects the local
Node/Python runtime, installs typed Node CLI packages into a private shared-store
layout when requested, and exposes one daemon-owned MCP/CLI runtime per installed
connector connection. Crash recovery adopts every host-touching operation into the current
boot epoch. Startup requires one successful catalog refresh before restoring
routes; later refresh failures preserve installed last-known-good capabilities
while the daemon retries.

The public `connector available`, `connector capabilities`, `connector skills`,
`connector skill read`, and `connector invoke` commands expose installed
connectors through the local daemon CLI channel to every Agent and the local
Tutti CLI. Discovery returns connector summary first, canonical capability
metadata on request, Skill frontmatter metadata next, and full `SKILL.md`
content only on explicit read. `connector invoke --capability` accepts only the
canonical ID returned by capability discovery. Connector invocations use a
bounded, serialized admission gate by default.

The first production compatibility boundary is deliberately narrow:
`managed_stdio` connectors are installable when their runtime contract is
supported. Authorized connectors must declare a connector-owned
credential broker and exact HTTPS authorization hosts. Durable
event replay is still follow-up hardening; renderer reconnect, resume, command
completion, and revision-fenced invalidations therefore trigger authoritative
snapshot reloads.
