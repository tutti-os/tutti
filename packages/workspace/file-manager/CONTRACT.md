# @tutti-os/workspace-file-manager contract

Status: agreed package boundary (direction). Open questions are listed under
[Open questions](#open-questions) when any remain.

This document is the authoritative ownership contract for
`packages/workspace/file-manager`. Prefer it over chat history when planning
or reviewing changes. The package `README.md` remains a short usage overview
and must stay consistent with this contract.

Sibling preview ownership lives in
[`@tutti-os/workspace-file-preview` CONTRACT.md](../file-preview/CONTRACT.md).
When preview vs open/activation ownership is in doubt, that document wins for
preview concerns; this document wins for file-manager session and host concerns.

## Purpose

This package owns a **host-neutral workspace file manager surface**:

1. Session state and interaction orchestration for one workspace-scoped
   file-manager instance (navigation, selection, locations, search projection,
   mutation busy/dialogs).
2. The `WorkspaceFileManagerHost` contract that hosts implement for listing,
   mutation, activation, open-with, reveal, and preview bytes.
3. File-manager-specific activation-target shaping, view-model derivation, and
   capability projection from optional host methods.
4. Optional React UI that binds to the shared session and delegates context-menu
   actions to the host through `resolveContextMenu`.

It does **not** own:

- Daemon / VM / preload transport, absolute host paths, or product globals
- Import / export / upload / download pipelines, transfer-center tasks, or
  progress UI
- Share / exposure / product collaboration flows
- Full-content editors, dirty/save, or workbench framing outside this surface
- A second preview kind taxonomy (that belongs to
  `@tutti-os/workspace-file-preview`)

## File manager vs preview vs host product

| Concern                                                        | Owner                                    |
| -------------------------------------------------------------- | ---------------------------------------- |
| Browse / navigate / select / search projection / locations     | This package (+ host listing/search)     |
| Side-pane preview loading + built-in preview shells            | `@tutti-os/workspace-file-preview`       |
| File-manager preview projection into session `previewState`    | This package                             |
| Open / reveal / open-with / browser / system activation        | This package orchestrates; host executes |
| Import / export / upload / download / drag-to-import UX        | Host                                     |
| Multi-step upload UX, transfer progress, gitignore pickers     | Host                                     |
| Share / link / exposure / room collaboration                   | Host                                     |
| Context-menu action lists for blank / directory / file targets | Host via `resolveContextMenu`            |
| Logical workspace paths in shared state                        | This package                             |
| Absolute / VM / OS paths and path projection                   | Host adapter                             |
| User-visible copy overrides and product chrome                 | Host                                     |

**Decided route:** this package is a reusable frontend workspace-domain
surface, not only a transport-agnostic data kernel. Shared session
orchestration and React-facing interaction state may live here when they are
part of the reusable file-manager experience across hosts.

## Ownership layers

### 1. Paths and identity

Shared state uses **logical workspace paths** (for example
`/workspace/src/index.ts`). The package does not depend on tuttid, TSH, TACH,
VM roots, or host absolute paths.

**Workspace identity (decided):** session input and host methods use
`workspaceID`. Hosts that natively key workspaces differently (for example TSH
`roomId`) map at the adapter edge. Do not rename the public field for a single
host.

**Entry shape (decided for now):** keep the current
`WorkspaceFileEntry` fields (`kind`, `name`, `path`, `hasChildren`, sizes,
timestamps). Do **not** add MIME / MIME-source fields to the shared entry
contract for classification or preview routing; preview classification stays on
the preview package’s extension-based model. Hosts may keep richer metadata
locally without pushing it into this package.

### 2. Host contract and capabilities

Hosts integrate primarily by implementing `WorkspaceFileManagerHost` and
calling `createWorkspaceFileManagerService().createSession(...)`.

**Host shape (decided):** keep one flat `WorkspaceFileManagerHost` interface.
Do not split into TSH-style listing/mutation/share ports inside this package
unless a later contract revision explicitly does so. Optional methods remain
optional; the package derives `WorkspaceFileManagerCapabilities` from method
presence (for example `search` → `canSearch`, `moveEntry` → `canMove`).

**Minimum host obligation (decided):**

- Required: `listDirectory`
- Everything else is optional and gated by capabilities / UI flags

Practical capability notes (not additional required methods):

- Side-pane preview bytes need `readPreviewFile`
- Double-click / Open need `activateFile` and/or the relevant `openFile*` /
  `revealEntry` methods the host wants to expose
- Search UI needs `search`
- Recent location content needs `listRecentEntries` when the host supplies a
  recent location

Import, export, upload, and download stay **outside** this package. Hosts that
need those flows implement them in host adapters and expose them through host
context-menu DI rather than package-owned import/export host methods.

Hosts must not reimplement a second file-manager session stack for the same
product job when they already consume this package; extend this contract or
keep truly product-specific flows outside the shared session.

### 3. Session orchestration

`WorkspaceFileManagerSession` owns, for one workspace-scoped instance:

- Directory listing and navigation stacks
- Selection, context menu anchor state, create/delete/rename dialogs
- Location selection (`selectedLocationId`) and host-supplied
  `locationSections`
- Search query/results projection when `canSearch`
- Mutation busy state and shared error projection helpers
- Preview projection into `previewState` via the preview package controller
- Activation orchestration that calls host `activateFile` / open / reveal APIs
- Persisted navigation/location snapshot via
  `WorkspaceFileManagerPersistedState`

**Locations (decided):** the package owns the location model
(`directory` / `external` / `recent` and location sections). Hosts inject
`locationSections` (and optional `defaultLocationId`). A host may supply a
minimal single-root section set; Tutti-shaped project/home/recent sections are
host policy, not a required package shape.

**External locations (decided):** browsing content for `external` locations is
host-owned UI injected through React props such as
`renderExternalLocationContent`. This package does not depend on
`@tutti-os/workspace-file-reference` for that content. Reference pickers may
reuse this package’s entry types, icons, and arrange helpers without inverting
ownership.

### 4. Preview integration

Preview **classification and loading lifecycle** are owned by
`@tutti-os/workspace-file-preview`. This package:

- Shapes file-manager activation targets for host open policy
- Wires `host.readPreviewFile` into the shared preview controller
- Projects controller state into session `previewState` and optional UI

Open / reveal / open-with / browser activation remain file-manager + host
concerns, consistent with the preview contract. Open-with advisories such as
`isWorkspaceFileBrowserOpenable` and
`shouldFilterVideoPlayersForOpenWith` live in this package’s `/services`
export, not in preview.

### 5. Context menu DI

**Context menu contract (decided):** the package owns only the menu anchor and
interaction shell (`contextMenu`, `currentDirectoryPath`, busy/loading flags).
Menu items are host-owned.

When the user opens a blank-area, directory, or file context menu, the React
surface calls the required `resolveContextMenu(request)` prop. The request
includes:

- `target`: `"blank"`, `"directory"`, or `"file"` (via
  `resolveWorkspaceFileManagerContextMenuTarget`)
- Current directory path, selected location, search/external/recent flags, and
  busy state

The host returns the menu item tree (`WorkspaceFileManagerContextMenuItem[]`).
Import, export, upload, create, delete, open-with, and other product actions
belong in that host resolver (or in host wrappers outside the shared menu),
not in package-owned menu visibility flags or package host import/export
methods.

### 6. Activation

When the user opens a file, the session orchestrates activation and calls host
hooks. Typical Tutti policy (host-owned, not package law): try in-app preview
presentation, then fall back to system open / unsupported dialogs.

`activateFile` results may be `handled`, `fallback`, or `unsupported`, with
optional host-provided fallback actions. The package owns dialog/shell
presentation of those results; the host owns what the actions do.

Default opener hints may be supplied through session input
`resolveFileDefaultOpener` (`appBrowser` / `defaultBrowser` / `fileViewer` /
`system`) without moving transport into the package.

### 7. Persistence

**Persisted state (decided):** the package owns
`WorkspaceFileManagerPersistedState` and its `schemaVersion`. Current fields:

- `currentDirectoryPath`
- `navigationBackStack` / `navigationForwardStack`
- `selectedLocationId`
- `schemaVersion`

Hosts that historically persisted other fields (selected file focus tokens,
cached listings, product-specific focus request IDs) must map at the adapter
or workbench edge. Do not widen the shared schema for one host’s focus
protocol without a contract revision.

Device-local UI chrome widths (locations sidebar / details pane) may persist
in the optional React surface; that is presentation chrome, not workbench
node external state.

### 8. Optional React UI and `/services`

Public entrypoints:

- `@tutti-os/workspace-file-manager` — UI + common types/helpers
- `@tutti-os/workspace-file-manager/services` — service/session/host contracts
  without requiring the React tree
- `@tutti-os/workspace-file-manager/i18n` — default resources / namespace helpers

**Consumption modes (decided):**

- `/services` alone is a valid integration (host brings its own UI)
- Consuming the package React UI implies accepting its peer dependencies
  (including `valtio`) and session-store binding

UI injection points that remain host-owned presentation hooks include, among
others: `resolveContextMenu`, `renderExternalLocationContent`,
`resolveEntryIconUrl`, `showPreviewPanel`, `showLocationSidebar`,
`showInternalOpenWithActions`, open-with icon overrides, and analytics
callbacks. These do **not** become a general product-action plugin system in
this phase.

**Published UI assets (decided):** folder/archive fallback glyphs ship as
inlined `data:` URLs in the published `dist` (tsup `loader: { ".png": "dataurl" }`).
Do not rely on `new URL(..., import.meta.url)` against loose files next to
`dist` — Electron hosts with strict `img-src` (no `file:`) will show broken
images. Hosts that alias this package to source for local development still
get Vite-rewritten asset URLs; published consumers must keep working without
that alias.

### 9. i18n

The package owns default file-manager copy under its i18n namespace. Hosts merge
`workspaceFileManagerI18nResources` into an app-level runtime and scope with
`createWorkspaceFileManagerI18nRuntime(...)`. Product-specific wording overrides
belong in the host runtime, not as forks of package message files.

`resolveRevealInFolderLabel(copy, platform)` remains available for host menu
builders that need platform-specific reveal labels.

## Host responsibilities

Hosts own:

- Transport: daemon/VM/local reads and writes, uploads/downloads, auth
- Mapping host identity (`roomId`, and similar) onto `workspaceID`
- Mapping absolute/VM paths onto logical workspace paths (and the reverse at
  the OS edge)
- Implementing required `listDirectory` plus whichever optional Host methods
  they want capabilities for
- Import / export / upload / download pipelines, including any transfer-center
  integration
- Context-menu action trees through `resolveContextMenu`
- Share / exposure / collaboration product flows
- In-app preview canvas / workbench presentation policy beyond the shared
  side-pane projection
- Product chrome outside this surface (toolbars, dock, room shell)
- App-level i18n overrides and host-only analytics

## Non-goals

- Embedding tuttid, TSH desktopd, preload bridges, or product globals
- Owning share-link / exposure / agent-session binding UI or state
- Owning multi-phase transfer-center protocols or progress UI
- Owning package-level import/export host methods or drag-to-import overlays
- Becoming a general document editor platform
- Requiring every host to implement Tutti’s full capability set
- Inventing a parallel preview taxonomy or open-with advisory stack in hosts
  that already consume the workspace file packages
- Promising a host menu/action contribution API for arbitrary product commands
  in this phase (hosts wrap or add product entry points outside the shared
  menu when needed)

## Relationship to other workspace packages

| Package                               | Relationship                                                              |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `@tutti-os/workspace-file-preview`    | Classification + preview loading; consumed by this package                |
| `@tutti-os/workspace-file-reference`  | May reuse types/icons/UI helpers; external location body is host-injected |
| Host adapters (Tutti desktop, TSH, …) | Implement `WorkspaceFileManagerHost` and product-only flows               |

## Keep as-is

- Flat `WorkspaceFileManagerHost` + capabilities-from-optional-methods
- Logical paths and `workspaceID` naming
- Session-owned shared interaction state with optional React UI
- Preview package as the only preview taxonomy owner
- Open-with advisories on `/services`
- Location model with host-supplied sections
- Persisted navigation/location schema versioning in this package
- Host-owned context menus through `resolveContextMenu`

## Current shipped shape vs this contract

The Tutti desktop adapter and package implementation are aligned with the
sections above:

- Desktop feature code implements `WorkspaceFileManagerHost` and keeps tuttid /
  preload / analytics / reference external panes outside the package
- Tutti desktop does not ship file-manager import/export/upload at all (no
  package host methods and no desktop `resolveContextMenu` actions for them).
  Other hosts that need those product flows must own them entirely outside
  this package
- Desktop wires `resolveContextMenu` for blank / directory / file targets
  (open / open-with / create / rename / copy / reveal / delete)
- Side-pane preview uses `@tutti-os/workspace-file-preview`; activation policy
  for canvas vs system open stays in the desktop adapter
- Other hosts (for example TSH) should adapt onto this contract rather than
  growing a second shared file-manager session for the same job

## Open questions

None right now. New questions should be added here when they appear, then moved
into the main sections once decided.

## Change policy

- Contract changes that alter host obligations, session ownership, persistence
  schema meaning, activation/preview boundaries, or context-menu DI expectations
  require updating this file in the same change.
- Prefer extending optional host methods or UI injection props over inventing
  parallel file-manager stacks in hosts.
- When an open question is decided, move the decision into the main sections and
  remove it from [Open questions](#open-questions).
