# Project Structure

This document defines the current repository structure for `tutti`.

It explains what belongs in each top-level area and how new directories should be introduced.

## Top-Level Layout

```text
tutti/
  apps/
  config/
  services/
  packages/
  tools/
  docs/
```

## Top-Level Responsibilities

### `apps/`

`apps/` contains product entrypoints and user-facing shells.

Current area:

- `apps/cli`: bundled terminal entrypoint for the local daemon capability protocol
- `apps/desktop`: Electron desktop application

Rules:

- app directories may own presentation, runtime integration, and entrypoint-specific behavior
- app directories must not duplicate business logic already owned by `services/`
- do not materialize future app ideas as empty directories; keep them in docs until the module has a real interface and implementation

### `services/`

`services/` contains long-running product backends.

Current area:

- `services/tuttid`: local daemon and primary business core

Rules:

- service directories own business workflows, durable state, and persistence ownership
- if a feature requires domain decisions or state transitions, it should usually land in `services/tuttid`

### `config/`

`config/` contains repository-owned default sources that are consumed by generation or tooling.

Current area:

- `config/tutti.defaults.json`: single-source default names and budgets for local state, transport, and logging

Rules:

- keep `config/` focused on repository defaults, not per-user settings or secrets
- prefer generating runtime-specific code from `config/` rather than reading these files ad hoc inside packaged applications
- do not turn `config/` into a second `docs/` directory; only keep machine-consumable sources here

### `packages/`

`packages/` contains shared boundaries, not default implementation code.

Current grouping:

```text
packages/
  browser/
  clients/
  configs/
  connector/
  device-link/
  events/
  ui/
  workbench/
  workspace/
```

Rules:

- organize packages by responsibility, not by language alone
- use `clients/*` for domain-specific client access
- use `device-link` for shared ICE/QUIC peer transport, product-neutral Relay stream mechanics, and the gomobile boundary consumed by Tutti, TSH, and mobile clients
- use `events/*` for schema-first shared business event protocol contracts, validators, and generated transport metadata that multiple hosts consume
- use `browser/*` for reusable browser/workbench node mechanics that are shared by desktop hosts without carrying product-specific bridge methods
- use `configs/*` for shared engineering configuration
- use `ui/*` for shared frontend foundation packages such as visual-system boundaries, host-agnostic React hooks, and host-agnostic i18n runtime support
- use `workbench/*` for the shared workbench snapshot contract and reusable workbench interaction surface intended to be shared by the open-source desktop and TSH
- use `workspace/*` for narrow reusable workspace-domain contracts and feature surfaces intended to be shared by the open-source desktop, TSH, and TACH
- do not create vague packages such as `shared`, `common`, or `client-sdk`
- do not pre-create package directories for future domains; add the package only when a real multi-consumer seam exists
- documentation alone does not make a package seam real; the package must expose
  a narrow interface that a current consumer can use without learning its
  implementation layout

### `tools/`

`tools/` contains repository support code such as:

- build helpers
- packaging helpers
- generation entrypoints
- validation or maintenance scripts

Core product behavior should not permanently live in ad hoc scripts when it belongs in a first-class application or service.

### `docs/`

`docs/` contains persistent repository documentation.

Current sub-areas:

- `docs/architecture`: structure notes and technical design context
- `docs/conventions`: coding, layering, naming, and storage rules

Rules:

- `docs/architecture` and `docs/conventions` are the long-lived source of truth
- temporary planning notes should not become the primary source of current repository rules
- once a design has landed and stabilized, durable rules should be promoted into `docs/architecture` or `docs/conventions`

## Current Structure Decisions

### `apps/cli`

`apps/cli` is responsible for:

- terminal argument parsing
- local daemon endpoint discovery and bearer authentication
- invoking the daemon-owned CLI capability protocol
- rendering daemon command output for terminal users

It must not become a second business core. Command metadata, workspace resolution, edition/context filtering, and command execution stay in `services/tuttid`.

### `apps/desktop`

`apps/desktop` is responsible for:

- renderer UI
- Electron main-process lifecycle
- preload bridge and IPC exposure
- native desktop integration
- supervising `tuttid`

It must not become a second business core.

Desktop keeps four top-level source areas:

```text
apps/desktop/src/
  main/
  preload/
  renderer/
  shared/
```

Desktop summary:

- `main/` owns Electron lifecycle, daemon/runtime composition, host access, transport, IPC, update integration, and window creation
- `preload/` owns the typed bridge surface exposed to renderer
- `renderer/src/app/windows/*` owns renderer window composition shells such as `dashboard` and `workspace`
- `renderer/src/features/*` owns reusable renderer feature modules
- `renderer/src/features/*/services/*` owns feature service public surfaces, while `services/internal/**` stays private to the owning feature
- `renderer` consumes shared visual foundations from `packages/ui/system` instead of growing its own token or primitive layer
- `shared/` stays narrow and desktop-local
- desktop-owned i18n resources stay under `shared/i18n/*`, while reusable package default i18n resources stay with the owning package and are merged by the renderer app-level i18n runtime
- `main/bootstrap.ts` stays a top-level coordinator; service assembly belongs in `desktopAppServices.ts`, `desktopDaemonRuntime.ts`, `desktopHostServices.ts`, and `desktopAppLifecycle.ts`

The authoritative desktop directory shape and ownership rules live in [docs/conventions/desktop-layering.md](../conventions/desktop-layering.md). Keep this repository-level document as a summary, not a second full desktop structure spec.

### `packages/desktop/*`

Desktop packages own product-neutral lifecycle and native-host integration
mechanics shared by more than one desktop product.

Current packages:

- `packages/desktop/update-admission`: minimum-version policy contracts,
  validation, mandatory updater ownership, Electron admission lifecycle,
  capability-minimal preload API, shared React presentation, and default i18n

Product policy transport, normal update preferences, release feeds, download
URLs, window assets, logging sinks, and business-window enumeration remain in
the consuming desktop app.

### `packages/connector/*`

Connector packages own host-neutral connector domain boundaries shared across
desktop daemons.

Current packages:

- `packages/connector/market`: TypeScript contracts, renderer state, reusable
  UI, i18n, and local OpenAPI fragment
- `packages/connector/host`: connector catalog, installation, authorization,
  compatibility, operation, and recovery application core
- `packages/connector/daemon`: reusable daemon lifecycle and workers
- `packages/connector/store-sqlite`: canonical local persistence and outbox
- `packages/connector/runtime`: latest-only artifact caching, no-network archive
  import, same-machine composition, managed-runtime installation primitives,
  Connector route/MCP registries, and the session-bound loopback MCP server

Remote endpoint authentication, credentials, state-root selection, generated
daemon clients, product command publication, and OS process integration remain
in host adapters.

### `services/tuttid`

`services/tuttid` is the primary business core.

It owns:

- business rules
- domain workflows
- local persistence
- long-running daemon behavior

### `packages/clients/*`

Client packages provide domain-specific access helpers for consumers.

They should remain focused, named by responsibility, and free of hidden business rules.

`packages/clients/connector-controlplane` is the shared Go protocol client for
account-scoped Connector authorization. It owns authorization session,
snapshot, and realtime-event decoding plus bounded HTTPS transport. A product
host supplies the API prefix, HTTP client, and per-account request authorizer;
the package never stores account cookies, chooses an environment, or sends
credentials to a runtime VM. `packages/connector/host` selects this client only
for `remote_streamable_http` releases, while `managed_stdio` authorization
stays with the injected local implementation host.

`packages/clients/device-authority-go` is the shared Go client boundary for the
Device Authority owner lifecycle across Tutti and TSH. The initial package is a
staged cross-repository extraction from TSH: publish the stable module first,
then refactor TSH to the released version without changing behavior, then wire
the same client into Tutti. This ordering is required because cross-repository
consumers must not use workspace replacements or pseudo-versions. The package
owns the control-plane wire contract, canonical Ed25519 enrollment and
owner-token signing, bounded HTTP response semantics, and credential-binding
validation. Product adapters still own base-URL and API-prefix selection,
account/session/device headers, durable identity storage, Relay demand and lease
scheduling, logging, and retry policy. The client must not infer
local-versus-remote deployment policy or import Relay transport lifecycle code.

### `packages/device-link`

DeviceLink is the shared Go peer-transport boundary for Tutti Desktop, TSH
Desktop, and mobile clients. It owns ICE candidate negotiation, QUIC over the
selected packet path, mutual ephemeral certificate pinning, categorical path
classification, the gomobile build surface, and product-neutral authenticated
link lifecycle mechanics: generation-fenced admission, establishment
serialization, pooled stream ownership, connection racing, and annealed path
probing. It also owns generic Relay byte-stream dialing and the reusable
reference-counted WebSocket/yamux owner-tunnel mechanics, including liveness,
readiness ordering, reconnect backoff, stream dispatch, and close ordering.

Its `candidateexchange` subpackage also owns the Trickle ICE application
mechanics shared by Go and gomobile consumers: immediate credential snapshots,
candidate change coalescing, acknowledgement-bound exact-snapshot publication
retry, gathering completion, and push-hint plus authoritative-poll remote
refresh. Consumers provide rendezvous callbacks or execute facade actions and
retain product retry classification; account authorization, attempt state,
request signing, room/pairing semantics, and wire DTOs stay in their product
adapter. The callback-free Go `ActionPump` owns both candidate workers and
allows at most one unresolved action per worker, so a slow rendezvous read does
not block local publication. The gomobile facade exports scalar/JSON start,
next-action, resolve-action, notify, and stop/cancel operations. Mobile uses two
identical action drainers to execute signed authoritative reads/writes without
reimplementing ICE retry timing, wake cursors, polling, or worker cancellation
in TypeScript, Kotlin, or Objective-C.

It exposes authenticated bidirectional streams and generic Relay byte streams,
and must remain independent of Agent, Session, Workspace, account, pairing,
rendezvous, Relay authorization, and Relay product policy. Peer and owner keys
stay opaque; host services and apps inject path dialers, credentials, leases,
fallback timing, and application stream protocols. The `tuttid` Mobile Remote
owner is the first adapter for the shared link manager; its pairing and Agent
framing remain service-owned. TSH remains the product authority for its Relay
registration and lease lifecycle even when it consumes the shared owner-tunnel
mechanics. Raw addresses, candidates, credentials, and payloads must not enter
ordinary logs or metrics.

### `packages/events/*`

Event packages define shared business event protocol boundaries.

Current package:

- `packages/events/protocol`: repository-owned JSON Schema and event-definition source files for the business event stream, plus generated TypeScript protocol contracts and daemon transport registry output

Rules:

- keep schema-first source files in the package and keep those files as the only shared source of truth for business event topics
- keep generated TypeScript exports narrow and protocol-oriented
- keep WebSocket lifecycle management, daemon orchestration, and renderer feature behavior outside `events/*`

### `packages/browser/*`

Browser packages define reusable Browser Node mechanics for hosts that need to
embed web content in the shared Workbench.

Current packages:

- `packages/browser/workbench-node`: `@tutti-os/browser-node`, the shared
  Workbench Browser Node package. It owns generic HTTP/HTTPS navigation,
  session partition resolution, runtime state, bridge shape, Electron webview
  guest management, and package-local i18n defaults. Host adapters own product
  globals, backend-token access, preview proxy behavior, and business bridge
  methods.

Rules:

- keep Browser Node mechanics in this package and host/product-specific methods
  in the consuming app or integration
- require hosts to provide bridge namespaces; the package must not assume
  `__tutti`, `__tsh`, or any other product global
- keep preview proxy interfaces inert until a host intentionally implements
  route resolution
- keep daemon contracts out of Browser Node v1; the desktop host persists layout
  through the existing Workbench snapshot

### `packages/configs/*`

Config packages exist to keep engineering defaults centralized and reusable.

They should stay small and boring.

### `packages/ui/*`

UI packages define shared frontend foundations.

Current packages:

- `packages/ui/system`: shared tokens, icons, styles, and primitives for renderer consumers; also the repository-owned host package for shared shadcn CLI and Radix primitive acquisition
- `packages/ui/i18n-runtime`: host-agnostic i18n runtime helpers for shared frontend packages and app-level runtime composition
- `packages/ui/react-hooks`: host-agnostic React hook helpers for shared frontend packages, including external-store snapshot and selector patterns

Rules:

- keep scope limited to frontend foundation concerns such as visual-system primitives, token-backed styles, host-agnostic i18n runtime composition, and host-agnostic React subscription helpers
- allow `ui/*` to own host-agnostic React hook foundations when the hook pattern is shared across packages and stays free of product workflows
- prefer routing shared `useSyncExternalStore` wiring through `packages/ui/react-hooks` instead of rebuilding new subscription wrappers in feature packages
- do not move business components, product workflows, or domain orchestration into `ui/*`
- prefer consuming `ui/*` from app renderers and reusable frontend packages rather than recreating the same foundations locally
- prefer narrow, stable package entrypoints over exporting internal file layout as public API

### `packages/workbench/*`

Workbench packages define the shared workbench boundary for the open-source
desktop and TSH.

Current packages:

- `packages/workbench/snapshot`: canonical TypeScript workbench snapshot types,
  migrations, normalization, validation, and JSON Schema. The daemon OpenAPI
  `WorkbenchSnapshot*` component schemas are synchronized from this package.
- `packages/workbench/service`: shared Go Workbench snapshot service, validation,
  canonicalization, and persistence seam for daemon hosts.
- `packages/workbench/electron`: Electron main-process Dock preview capture and
  bounded filesystem cache mechanics. Desktop hosts still own IPC
  authorization, BrowserWindow ownership, cache paths, and logging.
- `packages/workbench/surface`: reusable workbench controller, reducer,
  placement, stacking, `WorkbenchHost`, React surface primitives, shell snapshot
  wiring, intent resolution, external-state render plumbing, and host/session
  lifecycle mechanics for projected presence, launch requests, transient
  activation, explicit close policy, and shell snapshot sanitation.

Rules:

- keep snapshot compatibility behavior in `snapshot`, not in app renderers
- keep shared Go Workbench validation, canonicalization, and storage seams in
  `service`, not in host daemons
- keep shared Electron Dock preview capture and bounded cache mechanics in
  `electron`; keep host window authorization and product diagnostics in the
  consuming desktop app
- keep reusable workbench interaction mechanics in `surface`, not in
  product-specific feature UI
- when `surface` exposes derived external-store snapshots through
  `getSnapshot()`, unchanged source snapshots must preserve reference identity;
  prefer the package-local derived-snapshot helper instead of rebuilding fresh
  objects or arrays on every read
- keep product-specific node bodies, routing, and persistence adapters in the
  owning app or service
- allow `surface` to own narrow default copy for generic workbench interaction
  mechanics such as window chrome labels; keep product-specific workbench copy
  in the owning app
- do not widen `workbench/*` into a generic desktop shell package
- keep package root exports intentionally small; root exports are the public
  interface, not an index of every internal module
- do not export test fixtures, demo data, stack internals, reducer internals, or
  low-level hooks from a package root unless an existing consumer needs that as a
  stable interface
- keep adapter-specific durable state behind generic contract fields such as
  `Record<string, unknown>` unless the adapter detail is itself part of the
  shared snapshot contract

Host reuse model:

1. Keep generic workbench interaction mechanics, structural styles, and narrow
   default copy in `packages/workbench/*`.
2. Keep host-specific node bodies, routing, persistence adapters, and
   product-owned workbench copy in the consuming app or service.
3. Let the consuming host create one app-level i18n runtime that merges:
   - host-owned i18n resources
   - reusable package default i18n resources
4. Scope that runtime into package namespaces such as workbench window chrome
   instead of reconstructing per-package message objects by hand.

### `packages/workspace/*`

Workspace packages define reusable workspace-domain contracts that are intended
to support a real multi-consumer boundary or a documented external contract as
additional hosts adopt them.

Current packages:

- `packages/workspace/files`: Go domain kernel for logical workspace file
  semantics, path normalization, search scoring, and host-owned file adapters.
- `packages/workspace/file-manager`: TypeScript state, actions, adapter
  contract, and optional React UI for a workspace file manager. Ownership
  boundaries live in that package’s `CONTRACT.md`.
- `packages/workspace/terminal`: shared terminal node contract and frontend
  surface for workbench hosts.
- `packages/workspace/issue-manager`: reusable issue-manager contracts, OpenAPI
  fragment, i18n defaults, React surface, and workbench registration helpers
  for workspace-scoped issue, task, and run workflows.

Release rule:

- npm package release participation is defined in the npm release conventions,
  not by repeating package rosters in architecture docs
- shared non-npm modules follow their owning language and module conventions
  unless a separate release contract is introduced

Rules:

- keep host-specific adapters in the owning host, such as `services/tuttid` or
  an app renderer feature
- a reusable frontend workspace package may still own shared session state,
  interaction flow, and optional React UI when those behaviors form the shared
  workspace-domain surface rather than a product-specific host integration
- a reusable frontend workspace package may also own narrow default copy for its
  shared UI surface; hosts should override through their app-level i18n runtime
  rather than duplicating package strings locally
- keep shared state and UI on logical workspace paths such as `/workspace`, not
  host absolute paths or VM mount paths
- do not move tuttid storage lookup, desktop preload calls, TSH room mapping, or
  TACH-specific integration into `packages/workspace/*`

Host reuse model:

1. Reuse the shared package for session orchestration, view-model derivation,
   interaction flow, and optional UI when those behaviors are truly host-neutral.
2. Implement host-specific transport and capability adapters in the consuming
   host, for example preload calls, daemon clients, room bridges, or local file
   selection surfaces.
3. Keep shared workspace UI copy defaults in the owning package and merge them
   through the host's app-level i18n runtime instead of copying those strings
   into the host.
4. Keep product-specific wording, shell integration, and user-facing host
   behaviors in the consuming host.

## Adding New Directories

### Add a new top-level directory only when

- the new area has a distinct deployment or ownership boundary
- it cannot be described as part of an existing `apps/`, `services/`, `packages/`, `tools/`, or `docs/` area

### Add a new app directory when

- there is a new user-facing entrypoint with its own runtime shell

Examples:

- a desktop app
- a CLI app

Keep future app ideas in docs until they become real modules. Do not reserve them as empty directories.

### Add a new service directory when

- there is a new backend process with its own lifecycle and state ownership

### Add a new package when

- there is a real multi-consumer boundary
- the extracted API can be named narrowly by responsibility
- the shared code is not just convenience reuse
- the public entrypoint can stay much smaller than the implementation tree

Keep code local by default:

- desktop-only TypeScript stays in `apps/desktop`
- daemon-only Go stays in `services/tuttid`

Keep future packages in docs, not in placeholder directories:

- a README-only package is usually a shallow module
- a package name should appear in the tree only when contributors can follow it to a real interface and implementation

## Structure Review Questions

When reviewing a new directory or package, ask:

1. Which existing top-level area already owns this responsibility?
2. Is this a real boundary or just an attempt to spread code out?
3. Would keeping this code local be simpler and clearer?
4. Is the new name based on responsibility instead of a vague shared label?
5. Does the new structure reduce confusion, or just increase file count?
6. Can a caller use the module through a small interface, or does the package
   root expose the implementation layout?
