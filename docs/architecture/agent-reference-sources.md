# Agent Reference Sources

Status: current implemented architecture

This document describes the source abstraction behind file and artifact
selection in AgentGUI and other workspace surfaces. Serialization and runtime
resolution after selection are documented in
[Agent Reference Mention Resolution](./agent-reference-mention-resolution.md).

## Ownership

- `@tutti-os/workspace-file-reference` owns host-neutral contracts, source
  aggregation, picker state, and reusable React UI.
- `apps/desktop/src/renderer/src/features/agent-reference-sources` owns concrete
  desktop sources and transport adapters.
- AgentGUI consumes injected picker capabilities. It does not fetch daemon
  references or interpret source-specific node ids.
- Daemon and workspace-app APIs own artifact listing and search; desktop maps
  those responses into the shared source contract.

The shared package must not depend on desktop preload APIs, the generated
`tuttid` client, or product-specific feature services.

## Source Model

`ReferenceSourceService` is the source boundary. Each source declares metadata,
capabilities, availability, browsing, search, preview/open behavior, and
selection normalization.

`NodeRef { sourceId, nodeId }` is the stable picker identity. `nodeId` is opaque
outside its source: picker and aggregator code may store and route it but must
not parse it. A source returns `ReferenceNode` values and resolves selected
nodes into either a concrete file reference or a `ReferenceHandle`.

Current desktop sources include:

- `workspace-file`: local workspace/home files and fixed locations such as
  recent files, Downloads, Documents, and Desktop
- `app-artifact`: workspace-app reference groups and files
- `issue-file`: issue/topic artifact groups and files
- `user-project`: project-root locations used by file-oriented workspace
  surfaces

## Data Flow

```text
desktop source registry
  -> ReferenceSourceAggregator
  -> ReferenceSourcePicker controller/state
  -> shared picker UI
  -> optional source-owned confirm preparation
  -> selected file or ReferenceHandle
  -> composer mention
  -> workspace-reference runtime resolution when required
```

List-style app and issue sources adapt their backend responses through the
shared `ReferenceListBackend` / `createReferenceListSource` protocol. Local
files wrap `WorkspaceFileReferenceAdapter` directly. Open, reveal, open-with,
and preview operations remain source-owned and are delegated back to the host.

A source may implement `prepareSelection()` when `resolveSelection()` returns a
source-owned locator that the final consumer cannot read directly. Confirmation
is then an asynchronous transaction: the picker keeps its confirm action in a
loading state, waits for every selected node to prepare, and publishes the
prepared references only after all preparations succeed. A failure publishes no
partial selection, leaves the picker open for retry, and surfaces an error. The
source owns transport, materialization, and the resulting consumer-readable
locator; the shared picker must not interpret a host path or capability handle.

The picker source heading is the source-root navigation target. When a source
does not provide explicit sidebar groups, its root folders may appear as
shortcuts below that heading, but the picker must not synthesize another
same-named root folder. This keeps root-level files reachable without producing
duplicated structures such as `Workspace / Workspace`.

OS clipboard and drop entries may enter the same ordinary file/folder mention
model without going through a picker. AgentGUI asks the synchronous host
`resolveExternalPromptEntries` port whether each browser `File` is a live
`WorkspaceFileReference` or needs snapshot preparation. Live references keep
their host path and kind, do not become prompt assets, and preserve their
position relative to prepared entries. Hosts that cannot expose a live local
reference omit that capability or classify the entry for preparation.

Reference sources own whether preview bytes are available and how those bytes
are read. The host-neutral `@tutti-os/workspace-file-preview` controller owns
the frontend preview lifecycle after a node is focused: readiness and size
checks, stale-request fencing, cancellation, decoding, canonical status, and
media object-URL cleanup. Picker controllers project that language-neutral
status into source metadata and localized presentation; they must not start a
second preview request state machine.

### Project Directory Selection

AgentGUI lets each host explicitly own project-directory selection. TSH injects
a dedicated `projectDirectorySourceAggregator` and reuses
`ReferenceSourcePicker` instead of owning a second directory dialog. Opening
“Use existing project” switches that shared picker to the `directory` purpose
and routes the resolved folder path back through the existing project-selection
callback. Tutti Desktop explicitly injects its native directory selector at the
same host boundary.

`WorkspaceUserProjectSelect` keeps project creation and existing-directory
selection distinct. “Add project” uses the user-project `create()` capability
and its compact name input. “Use existing project” alone invokes the host's
explicit project-directory selector. In TSH, directory creation inside the
shared picker is an optional action for organizing the browsed workspace; it
does not replace the project-name creation flow.

The directory purpose is a constrained use of the same source architecture:

- the injected registry contains only directory sources that are valid project
  roots, so host-local file sections do not appear implicitly;
- sources return and search folders only, and enforce workspace boundaries
  before pagination;
- the picker uses single selection, omits file-type and provenance controls,
  and supplies directory-specific title, search, empty, and confirmation copy;
- a source that declares `directoryCreatable` implements `createDirectory()`;
  it owns path-segment validation, parent-boundary checks, persistence, and the
  canonical node returned after refreshing the parent;
- picker/controller code routes creation by `sourceId` and may update selection
  and loaded child state, but never constructs paths from opaque node ids.

Project-directory selection is an explicit host policy. AgentGUI never falls
back to the generic host `workspace.selectDirectory` capability. TSH injects
`projectDirectorySourceAggregator`, so “Use existing project” is routed through
the shared reference picker. Tutti Desktop explicitly injects its native
directory selector through `workspace.selectProjectDirectory`. A host that
injects neither capability does not expose the action. This keeps each host's
interaction owner visible at composition time instead of coupling project
selection to an unrelated generic workspace API.

Hosts that construct the AgentGUI i18n runtime must merge the workspace file
manager resources as well as the AgentGUI and project-selector resources. The
shared directory creation dialog reads its label, placeholder, cancel, and
create copy from the `workspaceFileManager` namespace.

### Composer Mention Directory Navigation

The compact AgentGUI `@` palette uses `AgentContextMentionProvider` instead of
the full reference picker, but it preserves the same ownership boundary. A file
provider that supports directory browsing exposes both `getItemDirectory()`
and `queryDirectory()`. The descriptor supplies the provider-owned canonical
directory path and, when known, its direct-child count; `queryDirectory()`
lists that directory's direct children without overloading keyword search.

AgentGUI owns only the ephemeral browse stack and turns those provider results
into enter/back navigation rows. The palette renders the supplied count and
navigation affordance, but does not infer hierarchy from a path, a trailing
separator, cached tree depth, or already loaded rows. Search results remain
ordinary insertable mentions unless the provider explicitly marks them as
navigable directories.

The compact palette browse cache is presentation-only. Every user-opened `@`
browse paints a matching cached entry synchronously when one exists and always
starts a provider query in parallel, even while the cached entry is within its
freshness TTL. The successful query replaces the visible groups and writes the
same result back to the shared cache. Freshness may suppress a speculative
startup or focus preload, but it must never suppress a user-opened query.
Closing or replacing the browse aborts its consumer and advances the controller
request fence, so an older response cannot overwrite a later open.

## Search Relevance

The daemon-backed source owns the ranked order for a non-empty local-file
query. Shared picker controllers may deduplicate that response but must not
re-sort it by node kind or label. Host-only collections such as open Dock files
may provide the empty-query browse list and presentation metadata, but must not
be prepended to ranked query results.

Picker purpose constrains result kinds before pagination: the reference picker
searches files only, while the project-directory picker searches folders only.
A file-type filter by itself remains in browse mode, filters files in the
recursively loaded source tree, and keeps only folders with matching descendant
files. The traversal is cancellable and the picker remains loading until the
filtered projection is complete. When a keyword is present, the same category
ids are passed to the source for pre-pagination filtering. Search rows render a
source-provided `contextLabel` when available and otherwise omit the subtitle;
opaque `nodeId` values are never presentation copy.

Local-file queries are field-aware:

- A query without path separators ranks exact basename, exact stem, name
  prefix/substring/fuzzy matches, and only then parent-path matches.
- A query with path separators is path intent. It ranks exact relative path,
  path prefix, ordered path-segment matches, and then path fuzzy matches.
- Logical or physical absolute paths inside the active local root are
  normalized to that root before ranking. Paths outside the root are rejected.
- A trailing separator denotes directory intent; it must not turn a same-stem
  file into a directory match.

The UI may display only the basename to conserve space. That presentation
choice does not narrow the searchable fields and must not become a second
ranking implementation.

## Source Provenance Filtering

`@tutti-os/workspace-file-reference` owns the host-neutral provenance model and
its reusable filter control. The model has independent `agent` and `member`
dimensions so collaboration products can reuse the package, but a host decides
which dimensions and options are enabled. Tutti personal edition injects only
Agent options; member and group-chat behavior are outside its product surface.

The full `ReferenceSourcePicker` does not accept, render, or apply a provenance
filter. AgentGUI may use the provenance control in its compact mention/search
surface, whose query controller owns that filter state. Project-directory
selection likewise has no provenance entry. This prevents picker navigation
and ordinary filesystem search from being silently constrained by a hidden
host value.

The controller owns only ephemeral selection state. The host injects the
catalog, and concrete providers or `ReferenceSourceService.search()` own the
actual filtering. An active filter is part of the query and cache identity and
must be applied before pagination. Picker result grouping remains source-owned;
the filter option list itself is flat.

AgentGUI exposes that host boundary as the optional complete
`referenceProvenanceFilterCatalog` capability. Omitting it keeps the public
surface disabled by default. Tutti's legacy boolean capability remains an
Agent-only adapter over the current Agent directory and does not synthesize
Member options; collaboration hosts explicitly inject both their enabled
dimensions and catalogs.

Catalog option identity is host-owned and normalized at the shared-package
boundary. Agent options require a durable `agentTargetId`; product-local target
ids are not provenance fallbacks. Filter cache keys use a collision-free
semantic serialization of normalized dimensions, not delimiter-joined ids.
Repeated injection of an equivalent filter is a no-op. A real filter change
invalidates and aborts the active query before scheduling its replacement, so a
late response cannot repopulate the picker with the previous constraint.
An explicitly supplied Agent dimension that normalizes to no ids fails closed;
the generated-file HTTP contract caps a request at 100 target ids and both the
daemon API and agent service enforce that boundary.

A `ReferenceSourceService` must declare the dimensions it can enforce through
`capabilities.provenanceDimensions`. The aggregator fails closed for an active
dimension that a source does not declare, rather than returning unfiltered
results under a filtered UI. Sources should add a dimension only when their
backend or source-owned query can enforce it before applying `limit` or cursor
pagination.

The AgentGUI desktop registry equips its `user-project` and `workspace-file`
sources with an Agent-generated-file query adapter. With an active Agent
constraint those sources pass the selected target ids to tuttid. Tutti first
combines the bounded recent Turn window for the persisted rail section, then
applies the selected session target, file-search ranking, and page limit. This
ordering lets a newer delete from another Agent suppress an older file before
the Agent filter is applied. The generated-file contract
requires an exact rail `sectionKey`: project sources resolve it from the
matching persisted `WorkspaceUserProject.sectionKey`; they must not derive it
from a path or reinterpret a picker `withinNodeId` as an Agent session working
directory. Missing section identity fails closed. Without a constraint the
sources retain the ordinary filesystem browse/search path. Other desktop
registries do not acquire this capability implicitly. Generated-file cursors
page only within the bounded recent result and may drift when its ten-second
cache expires; they do not claim exhaustive history.

## Invariants

- Route every operation by `sourceId`; reject unknown sources.
- Route project-directory selection only through the host's explicitly injected
  selector; never infer it from the generic workspace API.
- Never derive hierarchy by splitting an opaque `nodeId`.
- Never implement directory creation by joining or decoding `nodeId` in shared
  picker code; the owning source validates and creates the directory.
- Never derive composer-folder child counts from the currently loaded mention
  rows; directory providers own that count and the corresponding child query.
- Keep node ids stable across repeated listings so selection and pagination can
  deduplicate safely.
- Preserve source relevance order for search results; browsing order and search
  order are distinct contracts.
- Treat provenance constraints as source query inputs, never as a post-page UI
  filter.
- Capture the provenance constraint with speculative preload and provider-query
  inputs; do not read mutable controller state after an async boundary.
- Append cursor pages without reordering already loaded entries.
- Hide unavailable sources before rendering their tabs or sidebar groups.
- Expose only running workspace apps in the app-artifact sidebar; installed or
  enabled apps that are not running are not valid reference sources.
- Preserve per-app list and scoped-search failures as picker content errors;
  do not present a failed request as an empty artifact set.
- Keep source-specific transport and absolute host paths outside the shared UI
  package.
- Never submit a source-owned staging locator as a consumer-readable reference;
  sources that require materialization must complete it during confirmation.
- Use `ReferenceHandle` for app/issue groups that should resolve lazily at agent
  execution time; do not expand an entire artifact bundle into prompt text.

## Validation

- Package contracts, aggregation, controller, and picker changes:
  `pnpm --filter @tutti-os/workspace-file-reference test`
- Desktop source changes: run the focused desktop source tests and desktop
  typecheck.
- Mention serialization or lazy resolution changes: also validate
  [Agent Reference Mention Resolution](./agent-reference-mention-resolution.md)
  and the `reference` skill/CLI path.
