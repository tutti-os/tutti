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

Installation is a device fact. Authorization is an account projection. A
Connector may therefore be installed while inactive for the current account;
authorization completion or expiry schedules a normal durable runtime
reconcile without changing installed truth. Every durable lifecycle command
freezes its `accountId` in `OperationScope`, while short-lived artifact and
credential grants are passed only through execution ports and are never
serialized into SQLite.

Connector Manifest v3 keeps one signed release and adds an execution-target
matrix keyed by canonical Go platform tuples such as `darwin-arm64` and
`linux-arm64`. The catalog adapter selects the daemon's exact target and
projects it into the existing single-implementation host contract before
validation or installation. Target selection never falls back across OS or
architecture boundaries because runtime ABIs and native executable checksums
are target-specific release facts. Manifest v1 and market-neutral v2 remain
read-compatible at this boundary.

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
- `connector/runtime`: latest-only artifact download caching, no-network archive
  import, secure artifact preparation, managed runtime identity, ABI
  verification, and typed Node package installation
- a default remote-catalog domain adapter built over the authoritative market
  client
- reusable artifact mechanics: bounded download, `current + candidate` cache
  replacement, size and digest verification, no-network import, safe
  extraction, release-to-package verification, atomic promotion, and cleanup
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

Artifact preparation and runtime activation are different responsibilities.
They may also live on different machines:

```text
durable install operation
    -> ReleaseInstallationManager
    -> control-plane DownloadCache prepares one verified candidate
    -> same-machine import, or host data-plane sync to the runtime machine
    -> runtime Importer revalidates size/SHA and safely extracts
    -> optional typed CLI package installation
    -> release installation receipt (local paths or opaque runtime reference)
    -> repository commits device-installed truth
    -> cache candidate becomes current

authorization observation / runtime reconcile
    -> RuntimeBindingResolver derives active or inactive account intent
    -> connector/runtime implementation adapter
    -> generation-fenced MCP/CLI routes and observed process state
```

For a CLI declared with a typed `node_package` installation, the prepared
artifact contains connector metadata and skills, not the CLI npm package. CLI
installation remains part of the physical release install receipt, while route
reconciliation is a separate operation:

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

Managed MCP and CLI interfaces may declare an `installationProbe` containing
only bounded argv and `timeoutMs`. The host reuses the interface's verified
entrypoint and managed runtime; manifests cannot select another executable or
provide shell text. Exit code `0` means the release-scoped implementation is
present, exit code `1` means it is absent, and timeout, transport failure, or
any other exit code is indeterminate. Probe output is ignored and bounded.

Installation probes run only for a release with durable prior-installation
evidence. Catalog-only entries are never executed before the user accepts an
installation. The daemon therefore does not silently adopt an arbitrary
user-global CLI as a signed Connector release: artifact, runtime, and release
identity must already have crossed the normal install boundary.

Connector releases may declare optional `agentRouting.aliases` containing only
stable product or brand names. Connector id and display name are included by
the host automatically; authors use aliases for additional language and legacy
brand forms, not generic capability words. After activation, the implementation
host projects this bounded, validated routing data into new Agent runtimes. An
alias match makes `connector available` the first discovery step. Its connector
summaries include recursively discovered Skill names, titles, descriptions,
entry paths, and base paths. Skills are discovered from every `SKILL.md` below
the verified release's `skills/` directory; manifests do not duplicate a
central Skill list. Tutti Agent receives that content-addressed directory as a
native extra Skill root before thread start/resume, so relative references,
scripts, and assets resolve from the connector package and the Skill survives
connector process restarts. `connector skill read` remains a compatibility
fallback for providers that cannot consume native roots. Market
listings that are not installed and routes that are not active are never added
to Agent instructions.

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
origin. The daemon never addresses S3 directly. The Tutti desktop host uses an
ordinary direct GET without workspace identity. A split control-plane/runtime
host may instead issue a short-lived presigned artifact grant under the frozen
account scope and let its runtime machine download directly. The grant is not
persisted or logged. Both modes verify the immutable object version, release
digest, artifact digest, and size before installation. Operations persist the
artifact key, release identity, object version, digest, and size. Staging and
local integration may override the CDN prefix
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
identity plus an explicit account execution scope. Each stage is idempotent for at least:

```text
operationId + connectorKey + version + releaseDigest
```

The durable install flow is intentionally coarse-grained. A failed attempt is
restarted from the idempotent release installer; the business repository does
not persist internal download/sync/import sub-stages:

```text
accepted -> installing -> installed -> completed
     |            |            |
     +------------+------------+-> failed
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

Installed release evidence is durable recovery input, not operation history.
The SQLite store records one complete release record per installed connector in
`connector_market_installed_releases`; install completion updates it and
uninstall completion removes it in the same transaction as the business
transition. Probe-detected drift retains that evidence while the installation
projection is failed so repair and uninstall still target the accepted release.
Runtime recovery therefore remains valid after the corresponding completed
install operation has expired, including when the accepted catalog has advanced
to a newer release.

Before bootstrap republishes installed routes, it compares each previously
installed release that declares a probe with the actual MCP/CLI implementation.
An explicit absent result changes the installation projection to `failed` with
`connector_installation_probe_absent`, retains the installed release evidence
needed for safe repair or uninstall, advances the revision, and publishes the
normal changed event. A later present result for that same release clears the
failure and restores `installed`. Indeterminate probes preserve SQLite truth;
the ordinary fail-closed runtime reconcile still decides whether bootstrap can
publish the route.

Authorization operations must follow the same recovery rule or remain fully
synchronous without leaving a recoverable `running` operation. A provider uses
the operation or client request identity to resume without creating duplicate
external authorization sessions.

For account-scoped runtimes, `AccountRuntimeBindingResolver` maps `none`
authorization to an always-active device connection. OAuth/API-key connectors
remain inactive until the current account projection is `connected`; only then
does the resolver request a one-shot credential-broker grant. `expired`,
`disconnected`, and missing projections reconcile inactive. Daemon or guest
restart uses `BootstrapForScope` to rebuild the same projection explicitly.

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
receipts, recoverable install/uninstall/authorization flows, latest-only
artifact download caching, a no-network archive importer, host ports, the local daemon OpenAPI
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
SHA-256 and size, retains only the current archive plus one replaceable
candidate, prepares an installed snapshot, selects the local
Node/Python runtime, installs typed Node CLI packages into a private shared-store
layout when requested, and exposes one daemon-owned MCP/CLI runtime per installed
connector connection. Installation commits before runtime publication;
authorization state and bootstrap drive separate generation-fenced reconcile.
Crash recovery adopts every host-touching operation into the current boot
epoch. Catalog refresh failure does not invalidate installed release evidence.

The public `connector available`, `connector capabilities`, `connector skills`,
`connector skill read`, and `connector invoke` commands expose installed
connectors through the local daemon CLI channel to every Agent and the local
Tutti CLI. Discovery returns connector summaries with Skill frontmatter
metadata and stable package paths first; `connector skills` remains the
connector-scoped compatibility and refresh endpoint. Native-capable providers
read `SKILL.md` and sibling resources directly from the injected connector root;
full `SKILL.md` content can still be returned by explicit compatibility read,
while canonical capability metadata remains on demand.
`connector invoke --capability` accepts only the
canonical ID returned by capability discovery. Connector invocations use a
bounded, serialized admission gate by default.

The first production compatibility boundary is deliberately narrow:
`managed_stdio` connectors are installable when their runtime contract is
supported. Authorized connectors must declare a connector-owned
credential broker and exact HTTPS authorization hosts. Durable
event replay is still follow-up hardening; renderer reconnect, resume, command
completion, and revision-fenced invalidations therefore trigger authoritative
snapshot reloads.
