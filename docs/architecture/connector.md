# Connector Architecture

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

The remote market service owns its versioned API schema and generated
protobuf/HTTP artifacts. Tutti pins those artifacts by provider commit and
SHA-256 under `packages/clients/market-go`; it does not import the
`tsh-server` application module or redefine the remote schema in the local
daemon OpenAPI. Updates require a source checkout at the exact pinned commit and
digest-match every copied file. The client exposes the reusable
`/v1/market/categories`, `/v1/market/items`, and
`/v1/market/items/{item_type}/{item_key}` read boundary for both connectors and
Skills. Connector catalog requests always use `itemType=connector`; Skill
consumers use `itemType=skill`. The shared connector package may provide a
default `CatalogSource` adapter over that generated client, but must not copy or
redefine the remote schema. Remote transport DTOs and local daemon DTOs remain
separate.

The generated client adapter applies host authorization only to the initial
Market request. It preserves the host redirect policy and rejects any redirect
that leaves the configured scheme and host, including HTTPS downgrades, before
another credential-bearing request can be sent.

Published connectors use the remote market manifest v2 envelope: one
market-neutral `payload.implementation` and no `supportedMarkets` field. The
daemon rejects the legacy connector v1 envelope instead of adapting
`payload.implementations[market]`. At the boundary it projects the accepted v2
publication into the local daemon's stable connector-manifest v1 DTO; these
schema versions belong to different APIs and do not imply compatibility.

The renderer never calls the remote market. The local daemon is authoritative
for every state rendered by the desktop application.

An authoritative catalog refresh treats a missing Connector as delisted. A
not-installed Connector with no active lifecycle operation is deleted
immediately. Installed Connectors and Connectors with active operations retain
their private durable installation and cleanup evidence, but the daemon marks
them `removed_from_catalog` and omits the Connector and its operations from
public snapshots, single-Connector reads, and catalog-page projections. Public
validation runs only after that filter, so an obsolete manifest retained solely
for cleanup cannot make the visible catalog unavailable.

Category identifiers are opaque routing values. The Connector adapter sends
the exact server `categoryId` back as `sectionId` and never rewrites legacy or
new IDs. The daemon projects both `displayNameZh` and `displayNameEn` through
the local OpenAPI; the renderer selects the Chinese name for `zh*` locales and
the English name otherwise without another network request. During the bounded
compatibility window, only `featured`, `productivity`, `development`, and
`other` may use their released local i18n labels when an older daemon omits
both names. Unknown dynamic categories without a server name fail closed
instead of displaying their slug as product copy. Installation state stays on
the connector card; the renderer does not split the catalog into installed and
available categories, and catalog pages are loaded without the not-installed
filter so installed connectors remain in their server-owned sections.

Installation is a device fact. Authorization is an account projection. A
Connector may therefore be installed while inactive for the current account;
authorization completion or expiry schedules a normal durable runtime
reconcile without changing installed truth. Remote MCP HTTP 428 and JSON-RPC
`-33001`/`-33002` during an enabled reconcile are authorization-required
observations, not retryable install failures. Core persists an expired account
projection, replans `RuntimeDesired` as disabled, and lets
`awaitRuntimeDesired` converge that inactive generation so the install
operation can complete. Every durable lifecycle command
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

A CLI may instead declare `artifact_native` when its platform executable was
acquired and verified by the Connector publication pipeline and is already
inside the signed install artifact. The host does not receive an upstream URL
or add another installer. It verifies the prepared artifact inventory, copies
the declared entrypoint into the read-only execution snapshot with executable
permission only for that entry, then verifies its exact size and SHA-256 at
every launch. Windows executes the declared `.exe` directly; `.cmd` remains a
user-facing PATH projection rather than the native launch boundary.

One portable install artifact may contain binaries for multiple exact targets.
The signed v3 manifest selects one target implementation without OS or
architecture fallback; unused target files remain inert data in that release.
Per-target artifacts are a distribution-size optimization and do not change
the runtime trust or launch contract.

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
the file matching that digest. All connections and workspaces reuse one
installed connector release. A release-scoped rollback removes only its
incomplete release. An explicit Connector uninstall is connector-scoped: it
fences every matching runtime route across connection IDs, cancels matching
credential-broker sessions, closes processes and execution snapshots, removes
stable CLI shims, and removes every prepared artifact and private Node package
tree for that Connector. It preserves account authorization, user/workspace
state, and the shared Node package store and package-manager caches.

Catalog display metadata includes a required public HTTPS icon URL. Publishing
stores the source PNG, WebP, or SVG as an immutable versioned object and places
its CDN URL in the Market manifest. The daemon rejects missing URLs, inline
`data:` images, non-HTTPS schemes, credentials, surrounding whitespace, and
URLs longer than 2048 bytes before the release reaches a renderer or runtime.

Manifest permissions use a lowercase stable permission name with an optional
scope (`permission`, `permission:scope`, or `permission:*`). The daemon keeps
fail-closed validation for the permission name, scope grammar, duplicates, and
all other manifest fields; a scoped permission is not treated as a plain
identifier. The host may currently collapse a scoped permission to a broader
runtime capability, so accepting the syntax does not imply scope-level runtime
enforcement.

CLI manifests do not require action mappings. The host publishes one stable
`tutti-connector-<key>` executable per active CLI connector into the daemon
state `bin/` directory. The executable launches only the verified installed
entrypoint and forwards argv without invoking a shell. Installed Skills supply
the connector-specific arguments and workflow, while the Agent uses the normal
shell execution path. The selected connector remains a separate routing and
policy boundary.

Physical installation is inspected only through verified artifact and CLI
receipts. Connector-owned commands never decide whether a release is present.
The installation manager reports `present`, `absent`, `invalid`, or
`indeterminate`; only the first three may change an installation projection.
An installed CLI may separately declare a bounded `readinessProbe`. It runs
through the already resolved CLI entrypoint after installation and contributes
only interface readiness to the runtime receipt.

Connector releases may declare optional `agentRouting.aliases` containing only
stable product or brand names. Connector id and display name are included by
the host automatically; authors use aliases for additional language and legacy
brand forms, not generic capability words. After activation, the implementation
host projects this bounded, validated routing data into new Agent runtimes. An
alias match makes `connector available` the first discovery step. Its connector
summaries include recursively discovered Skill names, titles and descriptions,
plus the active native interfaces. Skills are discovered from every `SKILL.md` below
the verified release's `skills/` directory; manifests do not duplicate a
central Skill list. Tutti Agent receives that content-addressed directory as a
native extra Skill root before thread start/resume, so relative references,
scripts, and assets resolve from the connector package and the Skill survives
connector process restarts. There is no command-layer Skill read fallback;
providers consume Skills through their normal native Skill mechanism. Market
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
implementation host removes orphan staging and ready execution snapshots at
startup before restoring routes after an unclean shutdown. The daemon resolves
the artifact key against its configured artifact base URL. The
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
long-lived daemon children governed by the route generation fence and process
registry. CLI routes instead atomically publish stable shims that directly exec
the verified release entrypoint through the Agent's normal shell; the physical
installer owns receipt-based installation inspection, while the process adapter
handles CLI readiness and credential-broker operations. Both interfaces use the same verified artifact snapshot,
executable identity, generation lifecycle, and connection-scoped state path.
An installed runtime is daemon-global and is available to every Agent and the
local Tutti CLI. TSH runs the same runtime module inside its managed VM and
supplies a guest process adapter.

## Durable Operations And Recovery

Remote refresh, install, update, uninstall, disconnect, and runtime reconcile
use at-least-once execution. Exactly-once execution is not assumed across
SQLite, the filesystem, runtime activation, and process restarts. Start
authorization is not in that set: the user secret exists only in the
`BeginAuthorization` command, so an accepted or running `start_authorization`
row must not be executed from persisted state.

An installation request carries an immutable operation identity and release
identity plus an explicit account execution scope. Each stage is idempotent for at least:

```text
operationId + connectorKey + version + releaseDigest
```

The durable install flow is intentionally coarse-grained. A failed attempt is
restarted from the idempotent release installer; the business repository does
not persist internal download/sync/import sub-stages:

```text
install/update:
accepted -> installing(receipt) -> runtime_pending(candidate + Desired)
         -> Observed(exact generation) -> current promoted -> completed

uninstall:
accepted -> deactivating(Desired=disabled) -> Observed(disabled)
         -> removing -> absent -> completed
```

An authorization-required observation still completes install after the
disabled generation is Observed. Install completion does not require an
enabled Agent route.

These are short database transactions separated by idempotent external
effects, not one long transaction. Every external effect is preceded by a
durable phase/receipt. A retryable error leaves the Operation non-terminal and
the continuous recovery scanner resumes it; a deterministic install failure
clears Candidate and its convergence row before terminalizing. During update,
Current and its route remain usable until Candidate has been observed ready.

The repository owns operation leases and attempt metadata. Recovery observes
staging markers, active-version markers, and host runtime state before deciding
which stage to resume. Install and uninstall return verifiable results to the
application; artifact helpers do not write the business repository or publish
events directly.

Every operation row also stores canonical `owner_account_id` and visibility.
User commands are `account` visible and public reads always use
`GetOperationForScope`; an ownership mismatch is indistinguishable from a
missing row. Runtime reconcile and operations whose legacy owner cannot be
proven are `system_private`: workers may still recover them, but snapshots and
operation endpoints never publish them. Legacy rows derive ownership from
`operation_json.scope.accountId`. The idempotency key is
`(owner_account_id, client_request_id)`, while the active physical lifecycle
constraint remains device-global per Connector.

`accepted` and `running` rows have no age-based expiry. The SQLite repository
protects them with one-active-operation constraints plus renewable,
token-fenced leases. Daemon startup reschedules every recoverable row whose
effect is durable. Start authorization is command-inline and is not scheduled
on accept; bootstrap fails leftover accepted or running `start_authorization`
rows so they cannot block a later user retry, and the continuous recovery
scanner must not execute them. The cleanup path is therefore intentionally
unable to select an active operation.

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
The SQLite store records immutable Current and prepared Candidate releases by
`(connector_key, release_digest)` in
`connector_market_release_installations`; the legacy one-row table remains a
compatibility projection. Uninstall completion removes all versions in the
same transaction as the business transition. Receipt-detected drift retains
Current evidence while the installation projection is failed so repair and
uninstall still target the accepted release.
Runtime recovery therefore remains valid after the corresponding completed
install operation has expired, including when the accepted catalog has advanced
to a newer release.

Runtime publication is durable convergence state, not a public Operation. The
runtime-pending transaction atomically commits Candidate evidence, a non-secret
`RuntimeDesired`, the running install Operation, and the public outbox event.
Only an exact current-boot `RuntimeObserved` allows the final transaction to
promote Candidate to Current and complete the Operation.
`RuntimeDesired.generation` is a Connector-and-account-scope clock
independent from catalog and event revisions. A continuous daemon scanner claims
`Desired != Observed` work with a renewable token-fenced lease, resolves any
one-shot credential grant only immediately before the host call, and commits
`RuntimeObserved` with a compare-and-swap on the exact desired generation. An
Observed receipt from another daemon boot is stale even when its generation
matches. Scheduling is only a latency hint; a lost wake-up cannot lose work.

Before bootstrap republishes installed routes, it asks the physical installation
manager to inspect the accepted artifact and optional CLI receipts. `absent` or
`invalid` changes the installation projection to `failed` while retaining the
installed release evidence needed for safe repair or uninstall. A later
`present` observation for that release restores `installed`; `indeterminate`
preserves the projection. Runtime reconcile then performs interface readiness
checks before any route is published.

Authorization creation is serialized per account and Connector. A repeated
`clientRequestId` resumes the same external session. Every provider presentation
has a monotonic, non-secret authorization-step revision. A client can return the
last revision as a cursor; the Host then waits for a later broker event for a
bounded interval and may replay the current step. This keeps multi-step flows
ordered without persisting authorization URLs or device codes. Accepted or running
`start_authorization` is not recovered by replaying the operation: that would
complete a native-secret control-plane session with an empty secret and fail
the live command. Completed authorization receipts recover through
`ReconcileAuthorizations`, not through the durable operation scanner. A
different request retains the compatibility conflict unless it explicitly
sends `replacementPolicy=replace_active`. Replace
is Host-owned: it interrupts an in-progress initial Begin, moves an existing
receipt through durable `canceling`, asks the provider to terminate the exact
attempt, waits until that attempt can no longer publish credentials or events,
then resolves it as `superseded` before accepting the new operation. A provider
without confirmed attempt cancellation rejects replacement rather than running
two sessions against shared credential state. Managed runtimes are inspected
during convergence; restart finishes `canceling` receipts and no longer
fabricates a permanently pending observation. Disconnect is completed only
after the disconnected projection and exact disabled Runtime Observed state are
durable.

Managed credential brokers read process output through the context-aware
transport when available. Cancellation closes the owned process connection as
the termination fallback and waits for the broker consumer to finish before the
session and route are released; an explicit cancel does not publish a transient
authorization failure while shutdown is in progress.

For account-scoped runtimes, `AccountRuntimeBindingResolver` maps `none`
authorization to an always-active device connection. OAuth/API-key connectors
remain inactive until the current account projection is `connected`; only then
does the resolver request a one-shot credential-broker grant. `expired`,
`disconnected`, and missing projections reconcile inactive. If an enabled
reconcile observes authorization-required from the remote MCP before the
projection has expired, Core writes `expired` and replans inactive instead of
leaving the install or convergence row retrying 428. Daemon or guest
restart uses `BootstrapForScope` to rebuild the same projection explicitly.

An enabled Runtime Reconcile returns one identity-fenced receipt containing
the bounded, non-secret `ConnectorSummary` for the exact route generation it
committed. The receipt is available while capability publication is disabled,
so a cross-machine host can project readiness without consulting an
Agent-facing registry. A later key-only Route lookup is forbidden because an
upgrade or concurrent connection reconcile could otherwise attach metadata
from a different release or generation.

Remote Connector authorization uses that account projection for Start,
observation, presentation, and route publication; the device Connector's
authorization field is not remote authorization truth. A completed Start
operation may retain a private authorization-session receipt while provider
work is pending. The Start response preserves the current session's `pending`
state when the durable account projection is still missing, disconnected,
expired, or failed; this ephemeral response state lets the caller continue the
same idempotent session and does not replace the projection as durable truth.
An already connected projection wins a race with a stale pending session. Each
receipt has a terminal resolution, and only unresolved
receipts for the daemon's current account are polled. Applying an authoritative
connected Snapshot atomically writes its monotonic Projection and surfaces all
matching account-and-Connector receipts. The daemon holds the account lifecycle
fence and is the single runtime scheduler for receipt recovery. Host projection
does not enqueue a second public operation. The daemon updates or joins the
scope's durable Runtime Desired, awaits the exact generation in Observed, and
only then resolves the receipts as
`account_state_converged`. A same-revision Snapshot still surfaces a receipt created
after an earlier Snapshot does not cause permanent polling. WebSocket hints and
the five-minute calibration both fetch Snapshot; runtime reconcile is
level-triggered and can safely repeat after restart or an interrupted pass.
New external Connector mutations use `expectedConnectorRevision`, so unrelated
Connectors accepted from one Snapshot can proceed independently. The required
global `expectedRevision` remains in the wire contract for old clients and is
used when the Connector fence is absent. Catalog refresh retains its global
revision fence. Internal level-triggered repair reads current durable state
inside its transaction.
Active-operation exclusion follows the same ownership boundary through exact
scheduling lanes. The empty lane is reserved for catalog refresh; each
Connector key is its own device lifecycle lane. A catalog refresh and a
Connector operation may therefore coexist, while a second refresh or a second
operation for the same Connector is rejected atomically by the durable store.
An in-flight reconcile may have resolved its binding before a newer Projection
was persisted. Its Observed compare-and-swap is rejected after Desired advances;
the scanner then applies the newer generation before receipt resolution.

Authorization execution is selected from the exact release frozen into the
durable operation. `managed_stdio` delegates to the local implementation host;
`remote_streamable_http` delegates to the account control plane through
`packages/connector/daemon/adapters/controlplane`. The latter receives account
authentication only through a host-supplied request authorizer. Neither an API
key submitted by the user nor the product account session is copied into the
runtime VM. Remote MCP execution follows the product host's authenticated
relay, while the VM receives only the non-credential runtime route identity.
Route activation may reuse a same-process `tools/list` for an unchanged
authorization identity; Agent-visible lists stay live and are never persisted
or TTL-cached.
Remote authorization replacement propagates the explicit replacement policy to
Start and uses the session-scoped control-plane Cancel endpoint when a receipt
already exists. This covers both a returned session and an interrupted initial
Begin without relying on a device-local process handle.

## Event Consistency

Business state and its invalidation event are written to a durable outbox in
the same SQLite transaction. The host publisher delivers outbox entries through
its existing event stream and records delivery progress. A full Snapshot carries
the maximum outbox `eventCursor` read in the same SQLite snapshot. Each delivered
event carries its durable outbox cursor; duplicates are ignored and a gap causes
one authoritative reload. Snapshot revision, event cursor, and per-Connector
revision are separate watermarks, so a late partial fetch cannot suppress an
unrelated Connector update or overwrite a newer entity.

Account authorization overlays are read in the same SQLite Snapshot as market
state. A public projection change atomically advances the Connector revision and
appends its invalidation event; account state can no longer change invisibly
between market Snapshot reads. Composer capability projection and prompt
admission use the current account-scoped Snapshot as well, so their connected
state cannot diverge from Connector Market management surfaces.

Operation-bearing events carry an internal account audience and are delivered
only while that owner is the host's active account. Every state change also
produces a machine-level Connector invalidation without an operation id, so a
different account still observes device installation truth without learning
another account's command identity. Legacy or private events are fail-closed by
stripping operation and owner identifiers before publication.

Concurrent catalog requests use a process-local monotonically increasing fetch
fence: an older page or refresh response that returns after a newer response is
dropped before its write transaction. This is a daemon compatibility mechanism
and requires no remote catalog protocol change.

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
maps wire DTOs into `@tutti-os/connector-renderer/application` domain types.
The public Renderer package never constructs a daemon client and never reads
preload or window globals. Connector-specific React belongs only to
`@tutti-os/connector-renderer/ui`; AgentGUI supplies neutral projection models
and retains Agent draft/prompt semantics.

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
- the first user authorization action stays in flight until it completes or
  the user Cancels; a second Authorize click joins that Promise and must not
  create another `clientRequestId` or send `replace_active`. After Cancel, the
  next Authorize is a new action: it creates a new `clientRequestId` and sends
  `replacementPolicy=replace_active`. Continuation polling within one action
  reuses the same identity. A canceled renderer Promise cannot retain the
  Connector mutation token
- event refreshes are coalesced, daemon reconnect performs a full reload, and
  accepted commands are followed through the operation endpoint or events
- the settings catalog toolbar Refresh control indicates an explicit
  `refreshCatalog()` command only. The daemon also runs a scheduled catalog
  refresh after bootstrap and about once a minute; that background sync may set
  `catalogState=refreshing` while keeping the last-known-good catalog visible,
  and must not spin or disable the toolbar control
- catalog cards show a status field only after installation. Idle uninstalled
  cards keep the Install action and omit Not installed, so Authorization
  required remains the distinctive installed-but-disconnected mark. First-time
  install and update still show their in-progress status because that is live
  work, not an idle catalog tier
- hosts gate connector-market transport through `canRequest`; Tutti binds it to
  account authentication, activates the module without network access while
  signed out, reloads after login, and keeps reconnect/resume paths silent
  after logout
- install intent that arrives while Tutti is signed out invokes the host-owned
  account login flow through `requestInstallAdmission`; the service rechecks
  admission and returns `not_admitted` without calling the backend or showing
  installation success when login is still pending
- Tutti enables renderer-owned automatic updates for installed, compatible
  Connectors. After an authoritative snapshot, catalog page, or connector event
  publishes a different active release digest, Market starts the existing
  install/update command in the background. It never opens login from a
  background update and attempts one release digest only once per renderer
  lifetime, leaving explicit update available after failure
- the shared renderer subscribes at leaf components through a stable context,
  uses `@tutti-os/ui-system`, and owns no transport, startup, disposal, or
  business-state reconciliation

Compact composer surfaces reuse `ConnectorComposerMenu` from the shared UI
entrypoint. The menu consumes only a host-neutral projection of connector key,
name, icon, setup state, and the scoped runtime state projected by Connector
Market. An installed Connector is shown as started only when the current boot
has observed its latest desired generation as enabled and ready; `starting`,
`stopped`, and `failed` remain off. Older hosts that omit this optional runtime
projection retain the legacy authorization-based presentation. AgentGUI maps
its provider-neutral capability options into that projection and retains only
placement plus its Tutti Mode fallback. Selecting one item emits a semantic
connector-open intent. Composer “install” waits on the durable install
operation; authorization-required remote MCP must complete that operation
with an inactive route so the trigger can move from install to authorize
instead of spinning. The host
executes `openConnectorMarketDialog(root, connectorKey)`, which waits for the
authoritative market view, rejects invalid or unknown keys, and then advances
the package-owned dialog state machine. Before applying the bounded quick-list
limit, the shared menu ranks already installed and authorized connectors
(`connected` and installed-but-stopped `disabled`) ahead of connectors that
still require authorization or setup. The secondary key is the installation
event timestamp (`installedAtUnixMs`, newest first). Connectors without a
timestamp keep their relative host catalog order after timestamped entries in
the same group. Its compact trigger previews the authorized and running
(`connected`) group without requiring those connectors to be selected in the
current draft; draft selection continues to control only structured prompt
content. Selecting “more” remains host navigation because settings/workbench
location is product-owned.

Connector access-policy editors reuse `ConnectorAccessSelectionPanel` from the
same shared UI entrypoint. The controlled panel accepts only loading/error/ready
state, neutral Connector items, selected keys, caller-localized labels, and
semantic callbacks. It owns the Connector-specific loading, empty, error,
selection, disabled, and busy presentation. The host retains authorization and
sharing policy, selected-key normalization, persistence, navigation, and
catalog projection; the panel imports no AgentGUI draft/store, Desktop global,
or daemon client.

Every renderer window mounts exactly one `ConnectorMarketDialogHost` alongside
its other window-level panel hosts. Composer entries and catalog cards never
mount their own dialog host. This keeps dialog identity and mutual exclusion in
one shared Root while allowing several AgentGUI surfaces in the same window to
open it.

Connector details are represented by one modal state machine, never by a fixed
right-hand pane. An uninstalled connector opens an installation confirmation.
An unconnected installed connector opens the authorization dialog. The token
form keeps typed secrets after submit so a failed or in-flight attempt does
not force the user to re-enter them. Completing authorization in that dialog
keeps the modal open and advances it to the management dialog, where
disconnect and try remain available. An already authorized connector opens
the management dialog directly. Blocked releases
open the blocked-state dialog. Only one dialog host is mounted at a time, so
the catalog keeps the full settings content width and never leaves an empty
right column.

Closing an authorization dialog while a request is in flight does not start a
new session and does not dismiss the modal; the user must finish the provider
flow or use Cancel. Browser OAuth keeps the in-flight footer on authorizing
and does not surface Continue for a synthesized `external_link` view; the
Start command already opened that URL. Cancel calls the Host cancellation
command, then the next Authorize is a new replace-active attempt. A leftover
pending session without an in-flight renderer request also shows Authorize,
not a second Start disguised as Continue.

## Local OpenAPI Reuse

Host aggregate documents compose the same local daemon fragment instead of
copying paths or schemas. Tutti may reference the repository path. External
hosts resolve the fragment exported by an exact installed
`@tutti-os/connector-contracts/openapi/connector-market.v1.yaml` resource. The
OpenAPI generator rejects malformed references and merge conflicts.

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

The only public connector discovery command is `connector available`. It
returns active connector metadata, discoverable Skill summaries, and the
native interface needed to use each connector; it does not expose package
paths, ports, bearer tokens, or upstream credentials.

All active connector-owned MCP implementations are registered into the local
loopback Streamable HTTP MCP server named `connector`. Agent-facing bindings
are issued by `packages/connector/runtime/agentgateway`, whose listener and
bearer authority can outlive replacement of the bundle-owned backend.
`packages/connector/runtime/mcpserver` remains the replaceable MCP protocol
backend; product daemons own both lifecycles.
Before creating a Connector binding, the Agent runtime resolves the exact
provider adapter. Standard ACP adapters enable Connector only when the
`initialize` response explicitly declares
`agentCapabilities.mcpCapabilities.http == true`; a missing or false field,
capability-probe failure, or Connector binding/preparation failure falls back
to the ordinary Connector-free session. Unknown future adapters are also
Connector-free until they explicitly implement this capability contract.
The fallback omits the session binding, MCP configuration, routing hints,
Connector policy, Skill roots, and Connector CLI path together.

Tool names are
namespaced as `<connector-key>_<upstream-tool-name>`. Each Agent session receives
a short-lived bearer binding through its provider-native MCP configuration;
custom user MCP servers remain in their existing configuration and are not
merged into this registry. Install, reconnect, disconnect, upgrade, and
uninstall reconcile the registry dynamically and emit MCP
`notifications/tools/list_changed` to subscribed clients.

CLI connectors are used through their stable `tutti-connector-<key>` executable
and the Agent's normal shell execution path. Connector Skills are injected as
native Skill roots. The command broker does not expose `connector capabilities`,
`connector skills`, `connector skill read`, or `connector invoke`, and the first
phase intentionally does not expose connector enable/disable commands.

The first production compatibility boundary is deliberately narrow:
`managed_stdio` connectors are installable when their runtime contract is
supported. Authorized connectors must declare a connector-owned
credential broker and exact HTTPS authorization hosts. Durable
event replay is still follow-up hardening; renderer reconnect, resume, command
completion, and revision-fenced invalidations therefore trigger authoritative
snapshot reloads.
