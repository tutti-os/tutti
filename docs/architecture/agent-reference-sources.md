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
- External workspace apps request the host-owned picker through
  `tuttiExternal.references.select()` and receive only serialized selections;
  they do not construct a desktop source registry or query artifact APIs.
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

Tutti Desktop composes a restricted registry for external workspace apps:
`user-project`, `workspace-file`, and `app-artifact`. `issue-file` remains
available to owning Desktop surfaces but is deliberately excluded from this
external picker. A selected file or folder crosses the bridge as a concrete
`WorkspaceFileReference`; a selected application group crosses as a lazy
`workspace-reference` handle with app/group identity and workspace scope.
External apps append those values to the prompt through the shared rich-text
helper and must not enumerate a whole application artifact group eagerly.

The standard external-app composer plus control is also host-neutral. With an
app-owned upload callback it presents Upload and Browse actions; without one it
opens Browse directly. The control owns only this interaction shape and icons.
Apps continue to own localized labels, their upload pipeline, and prompt state.

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

The picker source heading is the source-root navigation target. Every source
implements the asynchronous `loadSidebarGroups()` protocol for shortcuts below
that heading. Sidebar navigation never falls back to
`listChildren(source-root)`, so loading navigation cannot populate or reuse
directory-content state. The picker must not synthesize another same-named root
folder; this keeps root-level files reachable without producing duplicated
structures such as `Workspace / Workspace`.

### Picker Runtime Reads

The picker uses three distinct lifetimes:

- The top-level source tabs have a UI-owned, process-memory snapshot keyed by
  aggregator and workspace. Opening paints that snapshot immediately, always
  calls `listSources()` in parallel, and reconciles the visible tabs when the
  fresh catalog arrives. The snapshot is never persisted.
- Sidebar groups are per-open state. After the source catalog is validated, the
  picker calls `loadSidebarGroups()` for every visible source. Closing clears
  the results; reopening reads them again. Sidebar pagination has its own cursor
  and never shares directory pagination state.
- Directory children are also per-open state. They are read only when the
  active root or group is entered and are cleared on close. There is no
  cross-open directory-content cache.

`ReferenceReadRequestCoordinator` may be shared by picker instances. It merges
only identical reads that are currently in flight; its key includes namespace,
workspace, request epoch, operation, and normalized request inputs. It stores
neither successful results nor errors. Consumers cancel independently, and the
underlying request is aborted when its final consumer leaves. Catalog, sidebar,
directory, search, and preview reads may use the coordinator.

Confirmation is deliberately outside that coordinator.
`prepareSelection()` runs against the source on every confirmation transaction;
a cached tab or an earlier prepared host path is never authoritative.

Host-local paths and permission-derived locations must not be persisted.
Permission or host-capability changes call
`invalidateReferenceSourcePickerRuntimeCache()` to clear the tab snapshot and
abort the aggregator's matching in-flight reads. Hosts that construct an
aggregator with `getRequestEpoch` also advance that epoch so later requests
cannot join a request started under the previous permission state.

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
- a host header mutation may ask the picker to select a newly created or
  uploaded directory through a `ReferenceLocateTarget`; the source owns
  translating that durable target into opaque node ids, while the picker owns
  loading the resolved path and updating its selection;
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

The generic hierarchy contract belongs to `@tutti-os/ui-rich-text`. A file
provider that supports directory browsing exposes both `getItemDirectory()`
and `queryDirectory()`. The descriptor supplies the provider-owned canonical
directory path and, when known, its direct-child count; `queryDirectory()`
lists that directory's direct children without overloading keyword search.
The shared `RichTextTriggerEditor` owns an optional browse stack when a consumer
enables `palette.directoryNavigation`; consumers that omit the option retain
the ordinary flat trigger behavior.

The compact AgentGUI `@` palette uses `AgentContextMentionProvider` instead of
the full reference picker and consumes the same shared provider contract, but
keeps its existing controller-owned browse lifecycle. External workspace apps
receive the optional contract through `tuttiExternal.at.queryDirectory()` and
enable it on their shared editor. The bridge transports provider results and
canonical paths; it does not infer hierarchy or own an app-side browse stack.
For workspace apps, the empty path addresses the host file-provider root and
subsequent directory paths must remain inside that root. AgentGUI continues to
use its separately composed host provider when it needs explicitly supported
external absolute paths.

AgentGUI owns only the ephemeral browse stack and turns those provider results
into enter/back navigation rows. The palette renders the supplied count and
navigation affordance, but does not infer hierarchy from a path, a trailing
separator, cached tree depth, or already loaded rows. Search results remain
ordinary insertable mentions unless the provider explicitly marks them as
navigable directories.

Across both AgentGUI and shared-editor consumers, selection and hierarchy are
separate actions: selecting a folder row inserts its folder path, while the
dedicated row affordance or ArrowRight enters it. ArrowLeft and the header back
action return to the parent. Non-empty input always uses the existing ranked
keyword query and clears the ephemeral browse stack; clearing back to the bare
trigger resumes browse from the provider root. Closing the query, pressing
Escape, or changing the configured directory provider also clears that stack.

Directory navigation owns a request lifecycle that is independent from
keyword-search and root-browse provider queries. Entering another directory,
going back, changing the query scope, closing the palette, or disposing the
controller aborts the active directory request and advances its own response
fence. A directory response applies only while its request id, workspace,
active file filter, empty query, and browse-stack head still match.

Directory reads do not inherit the short provider-search timeout or its
partial-result fallback. They remain loading until the provider completes or
the directory lifecycle explicitly cancels them. A successful authoritative
empty result is the only state presented as an empty directory; provider
failure remains an error. A file provider without `queryDirectory()` exposes no
hierarchy controls and retains the ordinary flat keyword-search behavior for
compatibility with older hosts.

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

The Desktop AgentGUI file provider adds one host-context tier without creating
a second relevance model: when the composer working directory resolves to a
registered current project, matching candidates are placed before candidates
from elsewhere, while the daemon's order is preserved within both tiers. The
provider also supplies each row's parent path relative to the search root and
its owning registered-project label. AgentGUI renders that combined context
after the basename; it does not parse absolute paths, discover projects, or
infer current-workspace ownership.

Picker purpose constrains result kinds before pagination: the reference picker
searches files only, while the project-directory picker searches folders only.
A file-type filter by itself normally remains in browse mode, filters files in
the recursively loaded source tree, and keeps only folders with matching
descendant files. A source may instead declare `filtersUseSearch` when it can
enforce the categories before pagination. The traversal and search request are
cancellable. When a keyword is present, the same category ids are passed to the
source for pre-pagination filtering. Search rows render a source-provided
`contextLabel` when available and otherwise omit the subtitle; opaque `nodeId`
values are never presentation copy.

A source opts into search continuation independently from browse pagination.
`capabilities.paginated` only describes `listChildren()` cursors; existing
sources continue using the growing-limit search protocol by default. A source
must declare `capabilities.searchPagination: "cursor"` before the controller
passes an opaque `nextCursor` to fixed-size search requests. A
`SearchResult.searchPagination` value may override that default for one query,
which lets a source keep ordinary cursor search while routing a provenance
query through a legacy backend.

For cursor search, the controller uses cursor presence—not a returned-count
heuristic or a growing total limit—to decide whether more data exists. It keeps
an incremental identity set and inspects only the incoming page before
appending unique nodes to an immutable, bounded-block index in source order.
Appending copies only the bounded tail block, and previously observed picker
snapshots remain unchanged. The view performs random access through that index
and renders only an overscanned virtual window. Historical entries remain
reachable by scrolling without retaining one DOM row, icon subscription, or
focus/selection render dependency per result. Repeated
or cyclic `nextCursor` values stop continuation with a stable visible error.
This removes any controller-owned total result ceiling.
Legacy search retains the growing-limit behavior and compatibility ceiling.

If a host reports cursor expiry with `ReferenceSearchCursorExpiredError`, the
controller clears the stale pages and automatically restarts the unchanged
search from page one. Other invalid or mismatched cursor errors remain visible
failures because retrying them would hide a source or request-contract bug.
An explicit retry of a visible search error also starts at page one after
discarding stale continuation state.

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
the filter option list itself is flat. The compact AgentGUI palette keeps an
independent filter selection for each mention tab. A tab that has not been
filtered starts at All, while returning to a previously filtered tab restores
only that tab's selection.

AgentGUI exposes that host boundary as the optional complete
`referenceProvenanceFilterCatalog` capability. Omitting it keeps the public
surface disabled by default. Tutti's legacy boolean capability remains an
Agent-only adapter over the current Agent directory and does not synthesize
Member options; collaboration hosts explicitly inject both their enabled
dimensions and catalogs.

Session mention providers preserve the canonical initiator user id in the
mention scope. The compact AgentGUI palette groups Session results by that
initiator through the injected Member catalog; Agent results continue to group
by the Agent target owner's `parentMemberId`. The matched Member catalog option
also supplies the Session row's initiator label and avatar so an external
mention provider does not need to duplicate member presentation in its mention
payload. A collaboration host also owns the Session row's Agent display label,
including an owner-qualified label for another member's shared Agent, and must
project the same label used by its Agent filter option. The host also projects
the Agent's provider identity separately as `agentProviderId`; AgentGUI resolves
the provider icon from that identity and never infers it from an
owner-qualified display label. AgentGUI also resolves that label's structured
owner and Agent segments from the matching provenance catalog entries. Session
rows truncate the initiator and Agent owner independently with a minimum visible
segment, keep the Agent label fully visible, and reserve visible space for the
Session title.

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
- Keep picker snapshots and source-service inputs as plain structured-cloneable
  data; never pass state-library proxies across host boundaries.
- Append cursor pages without reordering already loaded entries.
- Drive deep-search continuation from the virtual window's logical end rather
  than assuming an appended page will produce another native scroll event.
- Keep source tabs as runtime-only stale-while-revalidate metadata; every picker
  open must still refresh the source catalog.
- Read sidebar groups through `loadSidebarGroups()` on every open; never derive
  or cache them through directory children.
- Keep directory children within one picker-open lifecycle and merge only
  identical requests that are simultaneously in flight.
- Run `prepareSelection()` on every confirmation and never reuse a prepared
  host path from cache.
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
