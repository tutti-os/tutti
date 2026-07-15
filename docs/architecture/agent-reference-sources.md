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
  -> selected file or ReferenceHandle
  -> composer mention
  -> workspace-reference runtime resolution when required
```

List-style app and issue sources adapt their backend responses through the
shared `ReferenceListBackend` / `createReferenceListSource` protocol. Local
files wrap `WorkspaceFileReferenceAdapter` directly. Open, reveal, open-with,
and preview operations remain source-owned and are delegated back to the host.

## Search Relevance

The daemon-backed source owns the ranked order for a non-empty local-file
query. Shared picker controllers may deduplicate that response but must not
re-sort it by node kind or label. Host-only collections such as open Dock files
may provide the empty-query browse list and presentation metadata, but must not
be prepended to ranked query results.

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

## Invariants

- Route every operation by `sourceId`; reject unknown sources.
- Never derive hierarchy by splitting an opaque `nodeId`.
- Keep node ids stable across repeated listings so selection and pagination can
  deduplicate safely.
- Preserve source relevance order for search results; browsing order and search
  order are distinct contracts.
- Append cursor pages without reordering already loaded entries.
- Hide unavailable sources before rendering their tabs or sidebar groups.
- Expose only running workspace apps in the app-artifact sidebar; installed or
  enabled apps that are not running are not valid reference sources.
- Preserve per-app list and scoped-search failures as picker content errors;
  do not present a failed request as an empty artifact set.
- Keep source-specific transport and absolute host paths outside the shared UI
  package.
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
