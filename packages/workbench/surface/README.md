# @tutti-os/workbench-surface

Shared React workbench surface primitives for rendering neutral workbench nodes.

Consumers can import the workbench surface stylesheet once from the application
shell. It pulls in the shared UI-system defaults first, then layers the
workbench structural styles on top:

```ts
import "@tutti-os/workbench-surface/styles.css";
```

Hosts that already import `@tutti-os/ui-system/styles.css` elsewhere may keep
doing so, then import `@tutti-os/workbench-surface/styles.css` for the
structural layer.

The package owns workbench surface behavior, frame-level rendering contracts,
and shell snapshot persistence mechanics. Applications still own product state,
node bodies, business persistence, and persistence adapters, while window-chrome
i18n now flows through the shared app-level i18n runtime instead of injected
label objects.

## Host State And Lifecycle Boundaries

`WorkbenchHost` owns shell mechanics:

- projected node reconciliation
- launch request dispatch
- opening, restoring, and focusing windows
- dock rendering and default window actions
- snapshot persistence for shell state

The consuming host owns product behavior:

- business instance creation and reuse policy
- external node and workspace business state
- business-state commits and reducers
- close policy for host-owned instances
- external store subscriptions

When a node body or header needs host-owned business state, pass an
`externalStateSource`. The source is read into render context as
`externalNodeState` and `externalWorkspaceState`. If the source exposes
`subscribe(...)`, the host re-renders when that subscription notifies.

Node body and header contexts expose `isDragging` and `isResizing`. The Workbench
shell continues applying live frame geometry during direct manipulation, while
an expensive body adapter may use these flags to suppress frame-only renders
until the interaction settles. The adapter must still observe both interaction
transitions so the final committed frame reaches responsive body layout.

Headers keep live frame renders by default. A definition may provide
`getHeaderFrameRenderKey(context)` when several intermediate frames produce the
same visible header layout. During drag or resize, equal primitive keys skip
`renderHeader`; changes to node data, external state, focus, or interaction
state still render. Call `context.windowActions.getFrame()` inside actions that
need execution-time geometry instead of closing over a frame omitted from the
key.

Host-owned business instances are represented with `projectedNodes`. A
projected node tells the workbench that a shell should currently exist for a
host-owned instance; the workbench reconciles that presence with snapshot
layout and live shell state.

Dock entries are configured at the host level through `dockEntries`, separate
from node definitions. Dock entry identity drives slot ordering, grouping,
anchor lookup, popup aggregation, badge state, and launch payload dispatch.
Entries may also provide host-owned popup metadata through
`resolvePopupItem(...)` and `capturePopupItemPreview(...)`, plus custom badge
content when the default count or status shapes are not enough.

Component-based dock previews should render their host-owned body through
`WorkbenchDockComponentPreviewFrame`. The frame owns source-to-viewport
scaling, clipping, centering, and the non-interactive preview boundary. Preview
children are decorative and never participate in pointer hit testing; the Dock
button remains the only interaction owner even if frozen preview markup is
replaced between pointer events. Popup preview providers receive the canonical
target size through `item.previewViewport`; use that value instead of duplicating
Dock card dimensions in a consuming host.

Presentation-only changes to merged Dock entries belong in
`dockEntryPresentationOverrides`. `WorkbenchHost` applies these overrides by
entry id after contributions and explicit entries are merged, preserving Dock
order without changing contribution nodes or rebuilding the host session. Use
this seam for host-owned visibility and retention presentation; keep product
preference persistence in the consuming host.

Dock, shortcut, and command opens flow through `launchNode(...)` and the
optional `onLaunchRequest(...)` callback. The host may create a business
instance asynchronously, then return the shell identity, title, default frame,
required `framePolicy` (`"cascade"` to offset from the active node or
`"absolute"` to keep host coordinates), stable `dockEntryId`, and optional
one-shot activation payload. Activations and launch payloads are transient
render signals and are not persisted.

Runtime external business state is not written to the Workbench snapshot. Hosts
that need durable node-specific state should expose it through
`getSnapshotNodeState(...)`; Workbench stores that value as `snapshotNodeState`.
Node bodies that need live-only coordination can write `runtimeNodeState` through
`setNodeRuntimeState(...)`; refresh-safe state uses `setSnapshotNodeState(...)`.
The snapshot also stores shell state such as nodes, frames, stack order, and
host node metadata. Snapshots are sanitized before save so transient render data
such as activation payloads, runtime status, or live subscriptions do not become
layout truth.

Hosts that need to address shells from outside a render context can use
`createWorkbenchHostProjectedNodeId(...)` for projected presence and
`createWorkbenchHostLaunchedNodeId(...)` for launch-created shells. These
helpers only derive stable shell ids; layout restore and stack reconciliation
remain owned by `WorkbenchHost`.

## Contributions

Hosts may keep using the explicit `WorkbenchHost` props directly. For larger
hosts, `WorkbenchHost` also accepts optional `contributions` that can provide
node definitions, dock entries, external state, launch handlers, and node-close
handlers. Contributions may also provide `prepareHostClose(...)` when a module
needs to finish or cancel host-wide close before the consuming app closes its
workbench shell.

Contributions are additive. Explicit top-level props remain supported and keep
override authority for compatibility:

- explicit `nodes` override contribution nodes with the same `typeId`
- explicit `dockEntries` override contribution dock entries with the same `id`
- explicit `externalStateSource` fully replaces contribution external-state
  sources
- explicit launch and node-close handlers run before contribution handlers

Top-level shell inputs such as `snapshotRepository`, `workspaceId`,
`missionControl`, layout constraints, wallpaper, and chrome renderers remain
owned by the consuming host rather than contributions. The consuming host also
decides when to invoke host-close preparation; `workbench-surface` only owns the
contribution contract and deterministic composition helper.

For hosts that already use contributions, new workbench modules should prefer
adding a contribution instead of adding more feature-specific node, dock,
external-state, or launch wiring to a centralized host assembly service.

## Layout Semantics

`packages/workbench/surface` owns frame geometry for floating, snapped, and
fullscreen nodes.

Layout rules:

- floating nodes respect the full configured safe area
- top-snapped nodes use the normal safe layout and preserve bottom safe area
- fullscreen nodes respect top, left, and right safe area, but ignore bottom
  safe area so immersive content can reach the bottom edge of the workbench
  surface
- persisted snapshots record the surface and layout constraints that produced
  their frames; initial restore maps node frames, fullscreen restore frames,
  space frames, and reusable closed-window frames into the current safe layout
- legacy snapshots without a layout basis remain readable; fullscreen geometry
  is recomputed and hidden restore frames are clamped before they become
  floating windows

The package ships a baseline host layout default so new integrations do not
start with windows tucked under shared chrome. Today that default uses:

- `minWidth: 280`
- `minHeight: 160`
- `safeArea.top: 52`
- `safeArea.bottom: 88`

Hosts should override `layoutConstraints` when their shell chrome differs. They
should not duplicate fullscreen bottom-safe-area correction outside this
package.

## Host Reuse Pattern

When another host wants to reuse this package:

1. Keep workbench controller state, shared window mechanics, and default
   workbench host plus chrome i18n resources in this package.
2. Keep host-owned node bodies, business state, reducers, commits, persistence,
   routing, and product-specific workbench wording in the consuming host.
3. Create one host-level i18n runtime that merges:
   - host-owned workbench i18n resources
   - `workbenchHostI18nResources`
   - `workbenchWindowChromeI18nResources`
   - any other shared package i18n resources used by the same shell
4. Let the host surface and window chrome scope that runtime into the
   workbench namespaces with `createWorkbenchHostI18nRuntime(...)` and
   `createWorkbenchWindowChromeI18nRuntime(...)`.
5. Use `externalStateSource` for read-only render context injection and
   `projectedNodes` for host-owned presence such as terminal sessions, agent
   sessions, or browser records.
6. Provide explicit `dockEntries` for host chrome navigation instead of relying
   on node type order or node-definition dock metadata.
7. Use `onLaunchRequest` for dock, shortcut, and command opens that require
   host-owned instance creation before a shell appears.
8. Use `onNodeCloseRequest` when a close button needs host policy instead of a
   direct shell removal.

This keeps generic workbench mechanics reusable while leaving product behavior
and host integration in the owning app or service.
