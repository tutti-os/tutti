# @tutti-os/workspace-file-preview contract

Status: agreed package boundary (direction). Open questions are listed under
[Open questions](#open-questions) when any remain.

This document is the authoritative ownership contract for
`packages/workspace/file-preview`. Prefer it over chat history when planning
or reviewing changes. The package `README.md` remains a short usage overview
and must stay consistent with this contract.

## Purpose

This package owns **host-neutral workspace file preview**:

1. Recognize high-frequency file kinds for preview routing.
2. Run a shared preview loading lifecycle after a focused entry is chosen.
3. Render with built-in preview capabilities, optional host renderer hooks, and
   a fallback path.

It does **not** own:

- open / reveal / open-with / browser-activation flows
- full-content reading/editing experiences (complete PDF workbench, rich
  markdown authoring, spreadsheet editing, dirty/save flows, and similar)

## Preview vs open vs full content

| Concern                                              | Owner                           |
| ---------------------------------------------------- | ------------------------------- |
| Side-pane / picker / compact or detail **preview**   | This package (+ host hooks)     |
| Open / reveal / open-with / system or browser launch | Host activation flows           |
| Full-content viewer / editor / save / dirty guard    | Host or another product surface |
| How bytes or URLs are fetched from disk/VM/daemon    | Host transport ports            |
| Localized copy, icons, product chrome                | Host                            |

**Decided route:** this package does **not** own the open scenario.

Kind / classification helpers from this package are a **shared vocabulary**.
Hosts may reuse them when deciding activation policy (for example whether an
entry is previewable in-app), but that reuse does not transfer open ownership
into this package. After a user double-click / Open starts a host activation
flow, open actions remain host-owned.

HTML **source** may appear in preview as text. Opening or executing HTML as a
document belongs to a separate browser/activation flow, not to ordinary preview
rendering.

Tutti activation paths may call preview helpers such as
`resolveWorkspaceFilePreviewTarget` and present an in-app preview surface for
builtin-presentable kinds (`image` / `video` / text-degradable). That is host
policy reusing preview capabilities, not package ownership of Open.

## Ownership layers

### 1. Classification

The package must recognize preview kinds for high-frequency workspace files.
Classification produces a flat `previewKind` (no `textSubtype` dimension).

**Classification inputs (decided):** stay aligned with the current Tutti/package
model:

- entry kind (file vs directory)
- path / file-name **extension** (plus a small special-filename set such as
  `Dockerfile` / `README`)

Do **not** take MIME type or MIME-source reliability (`magic` /
`content-heuristic` / `extension` / `unknown`) into the shared classification
contract for now. Hosts that historically used richer signals (for example TSH)
should simplify toward this package model rather than pushing that complexity
into the shared boundary prematurely. If stronger classification is needed
later, this package owns the expansion.

**`visualKind` vs `previewKind` (decided):** keep both tracks.

- `visualKind`: coarser signal for icons / glyphs
- `previewKind`: preview routing (built-in renderer, host hook, or unsupported
  preview state)

They must not be collapsed together unless a later contract revision explicitly
merges them. Icon policy must not dictate preview routing, and preview routing
must not dictate icon taxonomy.

### 2. Loading lifecycle

`createWorkspaceFilePreviewController` (or its successor) owns readiness checks,
cancellation, stale-request fencing, decoding where applicable, canonical
language-neutral preview state, and media object-URL cleanup when object URLs
are used.

Hosts inject read/projection capabilities. Product controllers keep selection,
editing, persistence, transport wiring, and localized error presentation.

**Loading contract (decided for now):** keep the current package protocol.

- Host always supplies the focused `entry` (identity + metadata) via `setEntry`.
- Host injects `read({ entry, signal, target })` that returns preview **bytes**.
- The package decides whether to call `read` from readiness (directory /
  unsupported / over-budget readonly vs ready).
- Bytes are **not** a streaming/range “first N bytes” contract today. Within the
  preview size budget the host reads the file contents used for preview (for
  Tutti: whole file when under budget); over budget, preview does not read and
  becomes readonly/fallback instead.
- Image/video preview materializes browser object URLs from those bytes; text
  preview decodes to a string.

Do **not** expand the shared loading ports to content URL / range / streaming in
this phase. How TSH adapts onto this bytes protocol (or whether a later contract
revision adds richer ports) is deferred; simplify or bridge on the host side
until then.

### 3. Rendering resolve chain

For a classified `previewKind`, resolve renderers in this order:

1. **Host renderer hook** for that kind, if registered.
2. Else if the kind is **text-degradable** (`markdown`, `json`, `csv`, `html`,
   `code`, and plain `text`) → **built-in text** preview.
3. Else → **fallback**: package reports an unsupported/fallback preview state
   only.

**Fallback ownership (decided):** the package only emits preview state (for
example `unsupported` / readonly messaging inputs). It does **not** own open /
reveal / open-with / browser-activation actions, and it does not require an
`openExternally` (or equivalent) port.

If a host chooses to open a file in the system default app after an unsupported
preview, that is host product behavior outside this package. Mentioning “open”
in host docs is only to clarify that such actions stay out of preview scope.

This chain is what keeps Tutti stable when it does not inject rich hooks, while
allowing TSH (or others) to deepen preview via hooks.

### 4. Built-in preview surface

Built-in preview UI in this package is intentionally thin and currently limited
to:

- `image`
- `video`
- `text` (including the text-degradation path for `markdown` / `json` / `csv` /
  `html` / `code` when no host hook is registered)

`audio`, `pdf`, `markdown` (rich), Office kinds (`docx` / `xlsx` / `pptx`), and
other rich viewers are **hook-only** unless a later contract revision promotes a
kind into the built-in set.

Layout variants such as `compact` / `detail` / `canvas` remain shell concerns.
Built-in rendering stays lightweight; rich viewers arrive through host hooks.

### 5. Host renderer registry

Hosts register preview renderers **by `previewKind`**.

`variant` (`compact` | `detail` | `canvas`) is passed into the renderer as
context/props. Optional `(kind, variant)` overrides may exist later as a
specificity layer (`(kind, variant)` > `kind` > built-in/fallback), but the
default contract is kind-keyed registration.

## Target high-frequency `previewKind` set

Pursue high-frequency coverage, not exhaustive format support.

Agreed candidates for first-class kinds:

- `directory`
- `image`
- `video`
- `audio`
- `text`
- `code`
- `markdown`
- `json`
- `csv`
- `html`
- `pdf`
- `docx`
- `xlsx`
- `pptx`
- `unsupported` (terminal fallback kind/state)

Office kinds (`docx` / `xlsx` / `pptx`) are valid first-class preview kinds even
when only host hooks implement them.

Kinds intentionally left out of the first-class set stay `unsupported` (for
example archives, fonts, CAD, PSD), while icons may still use coarse
`visualKind` values.

## Host responsibilities

Hosts own:

- Transport: local/VM/daemon reads, content URLs, range/streaming, auth.
- Renderer hooks for rich preview kinds they support.
- Any open / reveal / open-with / browser-activation flows (not preview).
- Product chrome: toolbars, share/download/copy, workbench framing.
- Full-content experiences outside this package.
- User-visible copy and icon rendering injected into shared shells.

Hosts must not reimplement a second preview kind taxonomy for the same product
job when they already consume this package; extend this contract instead.

## Non-goals

- Opening, revealing, or launching files/apps (system open, open-with, browser
  activation, reveal in folder, and similar). Those are host activation flows.
- Full-content editing, save, dirty guards, close confirmation.
- Becoming a general document platform (only high-frequency preview kinds).
- Embedding host transport or product globals (`__tutti`, `__tsh`, preload).
- Requiring every host to implement every rich renderer.

## API cleanup decisions

These are decided hygiene items for the package-normalization pass (alongside
kinds / hooks work). Update consumers in the same effort when the public shape
changes.

### Naming (done)

- `WorkspaceFilePreviewTarget` / `resolveWorkspaceFilePreviewTarget`
- Target field is `previewKind` (flat taxonomy)

### Entry / directory / read / state shapes (done)

- `WorkspaceFilePreviewEntry` keeps a single `name` field (no `displayName`).
- Canonical directory kind is `directory`; adapt `folder` at host edges.
- `read` returns only `{ bytes, contentType?, kind? }` (no bare byte buffers).
- `toSurfaceState(controllerState, copy)` projects controller → surface state.

### Open-with advisories (done)

Removed from this package. Tutti hosts them in
`@tutti-os/workspace-file-manager/services`:

- `isWorkspaceFileBrowserOpenable`
- `shouldFilterVideoPlayersForOpenWith`
- `workspaceFileVideoHandlerCollisionExtensions`

### Keep as-is

- Generic `TEntry` + `toPreviewEntry` (lets File Manager / Reference picker /
  Workbench reuse one controller).
- Built-in surface staying thin (`image` / `text` / `video`) with host-injected
  copy/icons.
- Byte-budget constants and readiness gates.

## Current shipped shape vs this contract

The package implementation is aligned with the sections above for the Tutti
normalization pass:

- Flat `previewKind` taxonomy (including text-family and hook-only kinds).
- Built-in React surface covers image / text / video shells; text-degradable
  kinds fall back to built-in text when no host hook is registered.
- Host renderer registry is kind-keyed (`renderers` on the surface; optional
  `hasHostRenderer` on the controller for readiness / bytes planning).
- Open-with / browser-openable advisories live outside this package (Tutti:
  `@tutti-os/workspace-file-manager/services`).

Hosts that previously kept a parallel richer classifier (for example TSH)
should adapt onto this contract rather than inventing a second taxonomy.

## Open questions

None right now. New questions should be added here when they appear, then moved
into the main sections once decided.

## Change policy

- Contract changes that alter lifecycle, kind taxonomy, resolve-chain order, or
  host hook obligations require updating this file in the same change.
- Prefer extending kinds/hooks over inventing parallel preview stacks in hosts.
- When an open question is decided, move the decision into the main sections and
  remove it from [Open questions](#open-questions).
