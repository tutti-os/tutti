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

## Invariants

- Route every operation by `sourceId`; reject unknown sources.
- Never derive hierarchy by splitting an opaque `nodeId`.
- Keep node ids stable across repeated listings so selection and pagination can
  deduplicate safely.
- Append cursor pages without reordering already loaded entries.
- Hide unavailable sources before rendering their tabs or sidebar groups.
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
